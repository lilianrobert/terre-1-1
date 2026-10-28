// Main-thread side of the 3D city: OSM building/tree tiles around the camera, the Paris landmarks,
// and the sun shadow map they cast onto the terrain and onto each other.
import * as THREE from 'three';
import * as SH from './shaders.js';
import { treeGeometries } from './trees.js';
import { LANDMARKS } from './landmarks.js';

const Z = 14, NT = 2 ** Z, BLOCKS = 4;
const DEG = 180 / Math.PI;
const SHADOW_RES = 2048;
const CASTER = 1;   // render layer of shadow casters

export function createCity(ctx) {
  const { scene, U, cfg } = ctx;
  const tiles = new Map();
  let nextId = 1;
  const byId = new Map();
  const geos = treeGeometries();
  const stats = { tiles: 0, buildings: 0, trees: 0, pending: 0 };

  // ---------------------------------------------------------------- shadows
  const dummy = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  dummy.needsUpdate = true;
  const shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, { depthBuffer: true });
  shadowRT.depthTexture = new THREE.DepthTexture(SHADOW_RES, SHADOW_RES, THREE.FloatType);
  shadowRT.depthTexture.minFilter = shadowRT.depthTexture.magFilter = THREE.NearestFilter;
  const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 7000);
  shadowCam.layers.set(CASTER);
  U.tShadow.value = dummy;
  U.uShadowTexel.value.set(1 / SHADOW_RES, 1 / SHADOW_RES);

  // shadow map + atmosphere of the current body: every city material reads both
  const shadowUniforms = () => ({
    tShadow: U.tShadow, uShadowMat: U.uShadowMat, uShadowOn: U.uShadowOn, uShadowTexel: U.uShadowTexel,
    uPR: U.uPR, uBR: U.uBR, uBM: U.uBM, uHR: U.uHR, uHM: U.uHM, uAtm: U.uAtm, uSkyTint: U.uSkyTint,
  });

  // ---------------------------------------------------------------- landmarks
  const marks = LANDMARKS.map((L) => {
    const { geo, height } = L.build();
    const up = dirOf(L.lat, L.lon);
    const east = new THREE.Vector3(up.z, 0, -up.x).normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const h = L.heading / DEG;
    const ax = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    const az = new THREE.Vector3().crossVectors(ax, up);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SH.markVS, fragmentShader: SH.markFS, vertexColors: true, side: THREE.DoubleSide,
      uniforms: { uSun: U.uSun, uTime: U.uTime, uUp: { value: up.clone() }, uSparkle: { value: 0 }, ...shadowUniforms() },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.layers.enable(CASTER);
    mesh.visible = false;
    scene.add(mesh);
    const basis = new THREE.Matrix4().makeBasis(ax, up, az);
    return { ...L, height, mesh, up, basis, ground: null, groundT: 0, origin: new THREE.Vector3() };
  });
  // two searchlights sweeping from the top of the Eiffel Tower
  const eiffel = marks.find((m) => m.id === 'eiffel');
  const beamGeo = new THREE.CylinderGeometry(1, 0.01, 1, 16, 1, true).translate(0, 0.5, 0);
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: SH.beamVS, fragmentShader: SH.beamFS, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, side: THREE.DoubleSide, uniforms: { uNight: { value: 0 } },
  });
  const beams = [0, 1].map(() => {
    const m = new THREE.Mesh(beamGeo, beamMat);
    m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; m.renderOrder = 3;
    scene.add(m);
    return m;
  });
  const tmpM = new THREE.Matrix4(), tmpR = new THREE.Matrix4(), tmpS = new THREE.Matrix4();

  function updateMarks(dt, camPos, night, hour, enabled = true) {
    let anyNear = false;
    if (!enabled) { for (const m of marks) m.mesh.visible = false; beams.forEach((b) => { b.visible = false; }); return false; }
    for (const m of marks) {
      m.groundT -= dt;
      if (m.ground === null || m.groundT <= 0) { m.ground = ctx.groundAt(m.up); m.groundT = 1; }
      m.origin.copy(m.up).multiplyScalar(ctx.R + m.ground);
      const d = m.origin.distanceTo(camPos);
      m.mesh.visible = d < 80e3 && !m.destroyed;
      if (!m.mesh.visible) continue;
      anyNear = anyNear || d < 3000;
      m.mesh.matrix.copy(m.basis).setPosition(m.origin.x - camPos.x, m.origin.y - camPos.y, m.origin.z - camPos.z);
      m.mesh.matrixWorld.copy(m.mesh.matrix);
      m.mesh.material.uniforms.uSparkle.value = m.lit && (hour % 1) < 0.085 ? 1 : 0;   // the first five minutes of every hour
    }
    // searchlights
    const on = eiffel.mesh.visible && night > 0.05;   // no searchlights over a crater
    beamMat.uniforms.uNight.value = night;
    beams.forEach((b, i) => {
      b.visible = on;
      if (!on) return;
      const ang = ctx.time() * 0.35 + i * Math.PI;
      tmpM.copy(eiffel.mesh.matrix).multiply(tmpR.makeTranslation(0, 322, 0));
      tmpM.multiply(tmpR.makeRotationY(ang)).multiply(tmpR.makeRotationZ(-Math.PI / 2 + 0.04)).multiply(tmpS.makeScale(70, 3000, 70));
      b.matrix.copy(tmpM); b.matrixWorld.copy(tmpM);
    });
    return anyNear;
  }

  // ---------------------------------------------------------------- OSM tiles
  const exclusions = LANDMARKS.map((l) => ({ lat: l.lat, lon: l.lon, r: l.r }));
  const month = new Date().getMonth();
  const autumn = month === 9 ? 0.55 : month === 10 ? 0.75 : month === 8 ? 0.15 : 0;

  function makeTile(x, y) {
    const t = { id: nextId++, x, y, state: 0, meshes: [], blocks: [], center: new THREE.Vector3(), dist: 0, tileM: 0 };
    byId.set(t.id, t);
    tiles.set(`${x}/${y}`, t);
    return t;
  }
  function disposeTile(t) {
    if (t.state === 1 && t.worker) t.worker.w.postMessage({ type: 'cancel', id: t.id });
    for (const m of t.meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    tiles.delete(`${t.x}/${t.y}`);
    byId.delete(t.id);
    t.dead = true;
  }

  function onResult(r) {
    const t = byId.get(r.id);
    if (!t || t.dead) return;
    if (r.cancelled || r.error) { if (r.error) console.warn('city', r.error); t.state = r.error ? 3 : 0; return; }
    t.state = 2;
    if (r.empty) return;
    t.center.set(r.cx, r.cy, r.cz);
    t.tileM = r.tileM;
    const centerV = new THREE.Vector3(r.cx, r.cy, r.cz);
    if (r.bld) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.bld.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(r.bld.nrm, 3, true));
      g.setAttribute('acol', new THREE.BufferAttribute(r.bld.col, 3, true));
      g.setAttribute('afac', new THREE.BufferAttribute(r.bld.fac, 4));
      g.setIndex(new THREE.BufferAttribute(r.bld.idx, 1));
      g.computeBoundingSphere();
      const mat = new THREE.ShaderMaterial({
        vertexShader: SH.cityVS, fragmentShader: SH.cityFS, side: THREE.DoubleSide,
        uniforms: { uSun: U.uSun, uCenter: { value: centerV }, ...shadowUniforms() },
      });
      const m = new THREE.Mesh(g, mat);
      m.layers.enable(CASTER);
      m.userData.kind = 'bld';
      scene.add(m);
      t.meshes.push(m);
      stats.buildings += r.bld.count;
    }
    for (const b of r.blocks) {
      const blk = { c: new THREE.Vector3(r.cx + b.c[0], r.cy + b.c[1], r.cz + b.c[2]), hi: [], lo: [] };
      for (const [arr, hiG, loG] of [[b.broad, geos.broadHi, geos.broadLo], [b.con, geos.conHi, geos.conLo]]) {
        if (!arr) continue;
        const ib = new THREE.InstancedInterleavedBuffer(arr, 8);
        for (const [base, list] of [[hiG, blk.hi], [loG, blk.lo]]) {
          const g = new THREE.InstancedBufferGeometry();
          g.setIndex(base.index.clone());
          for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k].clone());
          g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(ib, 4, 0));
          g.setAttribute('iCol', new THREE.InterleavedBufferAttribute(ib, 4, 4));
          g.instanceCount = arr.length / 8;
          g.boundingSphere = new THREE.Sphere(new THREE.Vector3(b.c[0], b.c[1], b.c[2]), r.tileM / BLOCKS * 0.75 + 40);
          const mat = new THREE.ShaderMaterial({
            vertexShader: SH.treeVS, fragmentShader: SH.treeFS,
            uniforms: { uSun: U.uSun, uTime: U.uTime, uWindDir: U.uWindDir, uWindStr: U.uWindStr, uCenter: { value: centerV }, ...shadowUniforms() },
          });
          const m = new THREE.Mesh(g, mat);
          m.layers.enable(CASTER);
          m.visible = false;
          scene.add(m);
          t.meshes.push(m);
          list.push(m);
        }
      }
      t.blocks.push(blk);
    }
    stats.trees += r.trees || 0;
  }

  // camera position -> fractional tile coordinates
  function tileCoords(lat, lon) {
    const sl = Math.sin(lat / DEG);
    return [(lon / 360 + 0.5) * NT, (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * NT];
  }

  function update(dt, camPos, camUp, altGround) {
    const lat = Math.asin(camUp.y) * DEG, lon = Math.atan2(-camUp.z, camUp.x) * DEG;
    const tileM = 40075016.686 * Math.cos(lat / DEG) / NT;
    const eco = cfg.quality === 'eco';
    const loadR = eco ? 1500 : 2600;
    const active = altGround < 3500 && Math.abs(lat) < 84 && (cfg.buildings || cfg.trees);
    const [fx, fy] = tileCoords(lat, lon);

    // which tiles we want, nearest first
    const want = [];
    if (active) {
      const rr = Math.ceil(loadR / tileM) + 1;
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const x = ((Math.floor(fx) + dx) % NT + NT) % NT, y = Math.floor(fy) + dy;
        if (y < 0 || y >= NT) continue;
        const d = Math.hypot(Math.floor(fx) + dx + 0.5 - fx, y + 0.5 - fy) * tileM;
        if (d < loadR + tileM * 0.71) want.push({ x, y, d });
      }
      want.sort((a, b) => a.d - b.d);
    }
    for (const w of want) {
      let t = tiles.get(`${w.x}/${w.y}`);
      if (!t) t = makeTile(w.x, w.y);
      t.dist = w.d;
      if (t.state === 0) {
        const worker = ctx.post({ type: 'city', id: t.id, z: Z, x: w.x, y: w.y, opts: { exclusions, autumn, craters: ctx.craters ? ctx.craters() : [] } });
        if (worker) { t.state = 1; t.worker = worker; }
      }
    }
    // drop far tiles
    const keep = new Set(want.map((w) => `${w.x}/${w.y}`));
    for (const [k, t] of tiles) {
      if (keep.has(k)) continue;
      const d = Math.hypot(t.x + 0.5 - fx, t.y + 0.5 - fy) * tileM;
      if (!active ? altGround > 6000 : d > loadR + tileM * 2.2) disposeTile(t);
      else t.dist = d;
    }

    // place meshes (floating origin) and pick tree LODs
    const hiR = eco ? 260 : 380, loR = eco ? 1000 : 1700;
    let pending = 0, shown = 0;
    for (const t of tiles.values()) {
      if (t.state === 1 || t.state === 0) pending++;
      if (t.state !== 2) continue;
      const px = t.center.x - camPos.x, py = t.center.y - camPos.y, pz = t.center.z - camPos.z;
      for (const m of t.meshes) {
        m.position.set(px, py, pz);
        if (m.userData.kind === 'bld') m.visible = cfg.buildings && t.dist < loadR + tileM;
      }
      for (const b of t.blocks) {
        const d = b.c.distanceTo(camPos);
        const hi = cfg.trees && d < hiR, lo = cfg.trees && !hi && d < loR;
        for (const m of b.hi) m.visible = hi;
        for (const m of b.lo) m.visible = lo;
      }
      shown++;
    }
    stats.tiles = shown;
    stats.pending = pending;
  }

  // ---------------------------------------------------------------- shadow pass
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), T = new THREE.Vector3(), A = new THREE.Vector3();
  function shadowPass(renderer, camPos, camUp, fwd, altGround, nearMarks) {
    const sun = U.uSun.value;
    const mu = sun.dot(camUp);
    const on = (stats.tiles > 0 || nearMarks) && altGround < 2500 && mu > 0.03;
    U.uShadowOn.value = 0;
    U.tShadow.value = dummy;
    if (!on) return;
    const S = Math.min(1300, Math.max(500, altGround * 1.5 + 500));
    // centre the covered square on the ground ahead of the camera
    T.copy(fwd).addScaledVector(camUp, -fwd.dot(camUp));
    if (T.lengthSq() < 1e-6) T.set(0, 0, 0); else T.normalize().multiplyScalar(S * 0.45);
    T.addScaledVector(camUp, -altGround);
    lx.crossVectors(camUp, sun);
    if (lx.lengthSq() < 1e-8) lx.set(1, 0, 0);
    lx.normalize();
    ly.crossVectors(sun, lx).normalize();
    // snap to whole texels in world space so shadows do not crawl as we move
    const texel = (2 * S) / SHADOW_RES;
    A.copy(camPos).add(T);
    const a = A.dot(lx), b = A.dot(ly);
    T.addScaledVector(lx, -(a - Math.floor(a / texel) * texel)).addScaledVector(ly, -(b - Math.floor(b / texel) * texel));
    shadowCam.left = -S; shadowCam.right = S; shadowCam.top = S; shadowCam.bottom = -S;
    shadowCam.near = 1; shadowCam.far = 7000;
    shadowCam.position.copy(T).addScaledVector(sun, 3500);
    shadowCam.up.copy(ly);
    shadowCam.lookAt(T);
    shadowCam.updateProjectionMatrix();
    shadowCam.updateMatrixWorld();
    renderer.setRenderTarget(shadowRT);
    renderer.clear();
    renderer.render(scene, shadowCam);
    U.uShadowMat.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
    U.tShadow.value = shadowRT.depthTexture;
    U.uShadowOn.value = 1;
  }

  // after an impact: reload the map tiles in the blast zone (they come back flattened) and knock landmarks down
  function applyCraters(list, P, radius) {
    for (const m of marks) {
      const up = m.up;
      m.destroyed = list.some((c) => c.body === 'earth' && Math.acos(Math.min(1, up.x * c.x + up.y * c.y + up.z * c.z)) * ctx.R < c.r * 4);
    }
    for (const t of [...tiles.values()]) {
      if (t.state !== 2 && t.state !== 1) continue;
      if (P && t.center.lengthSq() > 0 && t.center.distanceTo(P) > radius + t.tileM) continue;
      disposeTile(t);
    }
  }

  return { update, updateMarks, shadowPass, onResult, stats, marks, applyCraters };
}

function dirOf(lat, lon) {
  const la = lat / DEG, lo = lon / DEG;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}
