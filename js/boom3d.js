// Missiles and the explosions they cause: flash, fireball, mushroom cloud, ground shockwave.
// The cloud is ~600 camera-facing puffs animated entirely on the GPU from one time uniform.
// Positions are planet-centred doubles; meshes are placed relative to the camera each frame.
import * as THREE from 'three';
import { R } from './terrain-core.js';

const puffVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;          // x: kind (0 cap, 1 stem, 2 base surge, 3 fireball), yzw: random
uniform vec3 uC;               // explosion centre, camera-relative
uniform vec3 uUp;
uniform float uT;
uniform float uS;              // size scale (grows with repeated hits)
uniform float uAtm;            // 0 on airless bodies: no mushroom, just a dust dome
varying vec2 vUv;
varying float vHeat;
varying float vA;
varying float vSeed;
varying float vLit;
void main() {
  vec3 up = uUp;
  vec3 e = normalize(cross(abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), up));
  vec3 n = cross(up, e);
  float kind = aSeed.x, s1 = aSeed.y, s2 = aSeed.z, s3 = aSeed.w;
  float T = uT;
  float phi = s1 * 6.2831853;
  vec3 hor = e * cos(phi) + n * sin(phi);
  float H = uS * (200.0 + 9500.0 * (1.0 - exp(-T / 10.0)) * uAtm);     // cap height
  float Rc = uS * (250.0 + 1900.0 * (1.0 - exp(-T / 8.0)));            // cap radius
  vec3 off; float size; float heat; float a = 1.0;
  if (kind < 0.5) {                                   // cap: a rolling torus
    float th = s2 * 6.2831853 + T * 0.22;
    float minor = Rc * (0.32 + 0.14 * s3);
    off = up * (H + minor * sin(th) * 0.75) + hor * (Rc * 0.72 + minor * cos(th));
    size = uS * (650.0 + 900.0 * s3) * (0.35 + 0.65 * (1.0 - exp(-T / 4.0)));
    heat = exp(-T / 4.5) * (0.55 + 0.45 * sin(th)) + exp(-T / 25.0) * 0.08;
    a = uAtm;
  } else if (kind < 1.5) {                            // stem
    float y = s2 * H * 0.95;
    float w = uS * (160.0 + 140.0 * s3) * (1.0 + 0.8 * smoothstep(H * 0.75, H, y));
    off = up * y + hor * w * sqrt(s3) * 1.2;
    size = uS * (360.0 + 320.0 * s3);
    heat = exp(-T / 3.5) * (1.0 - s2 * 0.6) + exp(-T / 20.0) * 0.05 * (1.0 - s2);
    a = uAtm * smoothstep(0.0, 2.0, T);
  } else if (kind < 2.5) {                            // base surge, or the dust dome without air
    float rr = uS * (300.0 + 3400.0 * (1.0 - exp(-T / 5.0))) * (0.65 + 0.35 * s2);
    off = up * (50.0 + 160.0 * s3 + (1.0 - uAtm) * rr * 0.35 * s3) + hor * rr;
    size = uS * (480.0 + 520.0 * s3);
    heat = exp(-T / 2.0) * 0.6;
  } else {                                            // fireball
    float rr = uS * 650.0 * (1.0 - exp(-T / 0.5)) * pow(s2, 0.5);
    float c = s3 * 2.0 - 1.0, sn = sqrt(1.0 - c * c);
    off = (hor * sn + up * (c * 0.85 + 0.55)) * rr + up * H * 0.25 * smoothstep(1.5, 12.0, T);
    size = uS * (420.0 + 380.0 * s2);
    heat = exp(-T / 1.4) * 2.4 + exp(-T / 7.0) * 0.4;
    a = 1.0 - smoothstep(6.0, 16.0, T);
  }
  vec3 cw = uC + off;
  vec3 vd = normalize(cw);
  vec3 rx = cross(vd, up);
  rx = length(rx) < 1e-4 ? e : normalize(rx);
  vec3 ry = cross(rx, vd);
  float rot = s1 * 6.28 + T * (s2 - 0.5) * 0.2;
  vec2 q = vec2(cos(rot) * position.x - sin(rot) * position.y, sin(rot) * position.x + cos(rot) * position.y);
  vec3 p = cw + (rx * q.x + ry * q.y) * size;
  vUv = uv;
  vHeat = heat;
  vSeed = s1 * 97.0 + s2 * 13.0;
  vLit = clamp(dot(normalize(off + up * 1.0), up) * 0.5 + 0.5, 0.0, 1.0);
  vA = a * smoothstep(0.0, 0.25, T) * (1.0 - smoothstep(70.0, 140.0, T));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;
const puffFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun;
uniform vec3 uUp;
uniform float uDay;
uniform float uWater;
varying vec2 vUv;
varying float vHeat;
varying float vA;
varying float vSeed;
varying float vLit;
float h12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = vUv * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float n = vn(vUv * 5.0 + vSeed) * 0.6 + vn(vUv * 11.0 - vSeed) * 0.4;
  float a = (1.0 - smoothstep(0.25, 1.0, r2 + (n - 0.5) * 0.7)) * vA * 0.6;   // edges in ascending order (portable GLSL)
  if (a < 0.004) discard;
  // soft puff: lit from above by the sun, darker underneath, glowing while hot
  float shade = 0.45 + 0.55 * clamp(1.0 - q.y * 0.6, 0.0, 1.0) * vLit;
  vec3 smoke = mix(vec3(0.36, 0.32, 0.29), vec3(0.78, 0.82, 0.86), uWater) * (0.25 + 1.6 * uDay * shade) * (0.75 + 0.5 * n);
  float h = clamp(vHeat, 0.0, 3.0);
  vec3 fire = mix(vec3(0.9, 0.18, 0.03), vec3(1.0, 0.86, 0.55), clamp(h - 0.8, 0.0, 1.0)) * h * 5.0 * (0.6 + 0.6 * n);
  gl_FragColor = vec4(smoke + fire, a);
}`;
const ringVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const ringFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uA;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float t = vUv.y;   // 0 inner edge .. 1 outer edge of the ring
  float a = smoothstep(0.0, 0.7, t) * (1.0 - smoothstep(0.85, 1.0, t)) * uA;
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.88) * a * 1.5, a);
}`;
const coreVS = ringVS;
const coreFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCol;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv * 2.0 - 1.0);
  float a = exp(-r * r * 5.0) + exp(-r * 14.0);
  gl_FragColor = vec4(uCol * a, 1.0);
}`;

const PUFFS = { cap: 260, stem: 130, surge: 150, fire: 90 };
// additive light that leaves the alpha channel alone, so the composite still knows this pixel is sky
const addMat = (o) => Object.assign(new THREE.ShaderMaterial(o), {
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
});

export function createWeapons(ctx) {
  const { scene, U } = ctx;
  const missiles = [], blasts = [];
  // one shared puff geometry: a unit quad instanced for every particle
  const quad = new THREE.PlaneGeometry(1, 1);
  const seeds = [];
  const kinds = [['cap', 0], ['stem', 1], ['surge', 2], ['fire', 3]];
  for (const [name, k] of kinds) for (let i = 0; i < PUFFS[name]; i++) seeds.push(k, Math.random(), Math.random(), Math.random());
  // draw the fireball last so it glows through the smoke
  const puffGeo = new THREE.InstancedBufferGeometry();
  puffGeo.index = quad.index;
  puffGeo.setAttribute('position', quad.attributes.position);
  puffGeo.setAttribute('uv', quad.attributes.uv);
  puffGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 4));
  puffGeo.instanceCount = seeds.length / 4;

  const coreGeo = new THREE.PlaneGeometry(1, 1);
  const ringGeo = new THREE.RingGeometry(0.82, 1, 128, 1);
  { // ring uv.y = radial position 0..1
    const p = ringGeo.attributes.position, uv = ringGeo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setY(i, (Math.hypot(p.getX(i), p.getY(i)) - 0.82) / 0.18);
  }

  function fire(origin, dir, vel, target) {
    // origin/target: planet-centred metres; flight time ~2-4 s whatever the distance (it is a game)
    const dist = target ? target.distanceTo(origin) : 2e5;
    const speed = Math.max(1500, dist / Math.min(4, 1.2 + Math.log10(1 + dist / 1000) * 0.6)) + vel.length();
    const core = new THREE.Mesh(coreGeo, addMat({ vertexShader: coreVS, fragmentShader: coreFS, uniforms: { uCol: { value: new THREE.Vector3(6, 3.2, 1.2) } } }));
    core.frustumCulled = false; core.renderOrder = 5;
    const trailN = 90;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trailN * 3), 3));
    const trail = new THREE.Line(trailGeo, Object.assign(new THREE.LineBasicMaterial({ color: 0xffb070 }), {
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    trail.frustumCulled = false;
    scene.add(core, trail);
    missiles.push({ pos: origin.clone(), dir: dir.clone(), speed, travelled: 0, range: target ? dist : 4e6, target, core, trail, hist: [], life: 0, snd: ctx.rocket ? ctx.rocket() : null });
    ctx.sound('launch', 0);
  }

  function explode(P, scale, water = false) {
    const up = P.clone().normalize();
    const mat = new THREE.ShaderMaterial({
      vertexShader: puffVS, fragmentShader: puffFS, transparent: true, depthWrite: false,
      uniforms: { uC: { value: new THREE.Vector3() }, uUp: { value: up }, uT: { value: 0 }, uS: { value: scale }, uAtm: { value: ctx.atm() }, uSun: U.uSun, uDay: { value: 1 }, uWater: { value: water ? 1 : 0 } },
    });
    const puffs = new THREE.Mesh(puffGeo, mat);
    puffs.frustumCulled = false; puffs.renderOrder = 6;
    const ring = new THREE.Mesh(ringGeo, Object.assign(new THREE.ShaderMaterial({
      vertexShader: ringVS, fragmentShader: ringFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uA: { value: 1 } },
    }), { blending: THREE.AdditiveBlending }));
    ring.frustumCulled = false;
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    const flash = new THREE.Mesh(coreGeo, addMat({ vertexShader: coreVS, fragmentShader: coreFS, uniforms: { uCol: { value: new THREE.Vector3(60, 55, 45) } } }));
    flash.frustumCulled = false; flash.renderOrder = 7;
    scene.add(puffs, ring, flash);
    blasts.push({ P: P.clone(), up, t: 0, scale, puffs, ring, flash, heard: false });
  }

  const v = new THREE.Vector3(), w = new THREE.Vector3();
  // ---------------------------------------------------------------- asteroid
  // A ~1 km rock coming in from 450 km at a slant: it lights up as it hits the air, drags a
  // burning trail and ends in a far bigger blast than a missile.
  const rockGeo = (() => {
    const g = new THREE.IcosahedronGeometry(1, 4);
    const p = g.attributes.position, v3 = new THREE.Vector3(), squash = new THREE.Vector3(1.25, 0.85, 1);
    for (let i = 0; i < p.count; i++) {
      v3.fromBufferAttribute(p, i);
      const n = Math.sin(v3.x * 4.1 + 1.3) * Math.sin(v3.y * 3.7 + 0.4) * Math.sin(v3.z * 4.9 + 2.1) * 0.22 + Math.sin(v3.x * 11 + v3.y * 9) * 0.05;
      v3.multiplyScalar(1 + n).multiply(squash);
      p.setXYZ(i, v3.x, v3.y, v3.z);
    }
    g.computeVertexNormals();
    return g;
  })();
  const rockVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vO;
void main() { vN = normalize(mat3(modelMatrix) * normal); vO = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
  const rockFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun;
uniform vec3 uFwd;
uniform float uHeat;
varying vec3 vN;
varying vec3 vO;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  float pits = 0.75 + 0.25 * sin(vO.x * 23.0) * sin(vO.y * 19.0) * sin(vO.z * 21.0);
  vec3 alb = vec3(0.09, 0.085, 0.08) * pits;
  vec3 col = alb * (max(dot(N, uSun), 0.0) * 2.6 + 0.03);
  float front = pow(max(dot(N, uFwd), 0.0), 2.0);                      // ram pressure heats the leading face
  col += vec3(1.0, 0.45, 0.12) * front * uHeat * 6.0;
  gl_FragColor = vec4(col, 1.0);
}`;
  const trailVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAge;
uniform float uPx;
uniform float uSize;
varying float vAge;
void main() {
  vAge = aAge;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  gl_PointSize = clamp(uSize * (1.0 + aAge * 2.5) / max(-mv.z, 1.0) * uPx, 2.0, 900.0);
}`;
  const trailFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat;
varying float vAge;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0 || vAge > 1.0) discard;
  float a = (1.0 - r * r) * (1.0 - vAge);
  vec3 hot = mix(vec3(1.0, 0.85, 0.5), vec3(0.9, 0.3, 0.05), smoothstep(0.0, 0.25, vAge));
  vec3 col = mix(hot * 3.0 * uHeat, vec3(0.35, 0.32, 0.3), smoothstep(0.15, 0.6, vAge));
  gl_FragColor = vec4(col * a, a * 0.8);
}`;
  const rocks = [];
  const TRAIL = 160;
  function asteroid(target, camPos) {
    const up = target.clone().normalize();
    // come in from the side opposite the camera so the whole entry is in view
    const side = camPos.clone().sub(target);
    side.addScaledVector(up, -side.dot(up));
    if (side.lengthSq() < 1) side.set(up.z, 0, -up.x);
    side.normalize().negate();
    const inDir = up.clone().addScaledVector(side, 0.9).normalize();
    const start = target.clone().addScaledVector(inDir, 450e3);
    const radius = 650;
    const rock = new THREE.Mesh(rockGeo, new THREE.ShaderMaterial({
      vertexShader: rockVS, fragmentShader: rockFS,
      uniforms: { uSun: U.uSun, uFwd: { value: inDir.clone().negate() }, uHeat: { value: 0 } },
    }));
    rock.frustumCulled = false;
    rock.scale.setScalar(radius);
    rock.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    const glow = new THREE.Mesh(coreGeo, addMat({ vertexShader: coreVS, fragmentShader: coreFS, uniforms: { uCol: { value: new THREE.Vector3() } } }));
    glow.frustumCulled = false; glow.renderOrder = 5;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    tg.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(TRAIL).fill(2), 1));
    const trail = new THREE.Points(tg, new THREE.ShaderMaterial({
      vertexShader: trailVS, fragmentShader: trailFS, transparent: true, depthWrite: false,
      uniforms: { uPx: { value: innerHeight * 0.9 }, uSize: { value: radius * 2.4 }, uHeat: { value: 0 } },
    }));
    trail.frustumCulled = false; trail.renderOrder = 4;
    scene.add(rock, glow, trail);
    rocks.push({ pos: start, vel: inDir.clone().multiplyScalar(-450e3 / 9), target, rock, glow, trail, radius, hist: [], t: 0, snd: ctx.roar ? ctx.roar() : null });
    ctx.sound('launch', 0);
  }

  let shakeOut = 0;
  function updateRocks(dt, camPos) {
    for (let i = rocks.length - 1; i >= 0; i--) {
      const k = rocks[i];
      k.t += dt;
      k.pos.addScaledVector(k.vel, dt);
      const r = k.pos.length();
      const alt = r - R - ctx.surfaceAt(v.copy(k.pos).divideScalar(r));
      const heat = ctx.atm() * Math.min(1, Math.exp(-Math.max(0, r - R) / 25000) * 3);
      k.hist.push({ p: k.pos.clone(), t: k.t });
      if (k.hist.length > TRAIL) k.hist.shift();
      if (alt < k.radius * 0.3 || k.t > 30) {
        if (k.snd) k.snd.stop();
        scene.remove(k.rock, k.glow, k.trail);
        k.rock.material.dispose(); k.glow.material.dispose(); k.trail.geometry.dispose(); k.trail.material.dispose();
        rocks.splice(i, 1);
        const dirH = k.pos.clone().normalize();
        const P = dirH.multiplyScalar(R + ctx.surfaceAt(dirH));
        const res = ctx.onImpact(P, 'asteroid');
        explode(P, res.scale, res.water);
        continue;
      }
      const d = k.pos.distanceTo(camPos);
      if (k.snd) k.snd.set(Math.min(1.2, 1.4 * heat * 40000 / (d + 20000)), heat);
      k.rock.position.copy(k.pos).sub(camPos);
      k.rock.rotation.x += dt * 0.3;
      k.rock.material.uniforms.uHeat.value = heat;
      k.glow.position.copy(k.rock.position);
      k.glow.lookAt(0, 0, 0);
      k.glow.scale.setScalar(k.radius * (3 + 9 * heat));
      k.glow.material.uniforms.uCol.value.set(6, 3, 1.1).multiplyScalar(heat * 2);
      k.trail.material.uniforms.uHeat.value = heat;
      const pa = k.trail.geometry.attributes.position, aa = k.trail.geometry.attributes.aAge;
      for (let j = 0; j < TRAIL; j++) {
        const h = k.hist[k.hist.length - 1 - j];
        if (!h) { aa.setX(j, 2); continue; }
        pa.setXYZ(j, h.p.x - camPos.x, h.p.y - camPos.y, h.p.z - camPos.z);
        aa.setX(j, (k.t - h.t) / 2.6 + (heat < 0.02 ? 2 : 0));
      }
      pa.needsUpdate = true; aa.needsUpdate = true;
      shakeOut = Math.max(shakeOut, heat * Math.min(0.6, 30000 / (d + 10000)));
    }
  }

  function update(dt, camPos) {
    shakeOut = 0;
    updateRocks(dt, camPos);
    // ---- missiles
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i];
      const step = Math.min(m.speed * dt, m.range - m.travelled);
      m.pos.addScaledVector(m.dir, step);
      m.travelled += step;
      m.life += dt;
      m.hist.push(m.pos.clone());
      if (m.hist.length > 90) m.hist.shift();
      let hit = m.travelled >= m.range - 1e-3;
      // re-check the ground under the missile: terrain may have loaded since we aimed
      if (!hit) {
        const r = m.pos.length();
        const g = ctx.surfaceAt(v.copy(m.pos).divideScalar(r));
        if (r - R - g < 0) hit = true;
      }
      if (hit || m.life > 30) {
        if (m.snd) m.snd.stop();
        scene.remove(m.core, m.trail);
        m.core.material.dispose(); m.trail.geometry.dispose(); m.trail.material.dispose();
        missiles.splice(i, 1);
        if (hit) {
          const dirH = m.pos.clone().normalize();
          const g = ctx.surfaceAt(dirH);
          const P = dirH.multiplyScalar(R + g);
          const r = ctx.onImpact(P, 'missile');
          explode(P, r.scale, r.water);
        }
        continue;
      }
      // place the glowing head and its trail around the camera
      const d = m.pos.distanceTo(camPos);
      if (m.snd) m.snd.set(0.9 / (1 + d / 500) * ctx.atm(), 1 / (1 + d / 2500));
      m.core.position.copy(m.pos).sub(camPos);
      m.core.lookAt(0, 0, 0);
      m.core.scale.setScalar(Math.max(6, d * 0.006));
      const a = m.trail.geometry.attributes.position;
      for (let k = 0; k < 90; k++) {
        const h = m.hist[Math.max(0, m.hist.length - 1 - k)];
        a.setXYZ(k, h.x - camPos.x, h.y - camPos.y, h.z - camPos.z);
      }
      a.needsUpdate = true;
    }

    // ---- explosions
    let flash = 0, shake = shakeOut;
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      b.t += dt;
      const t = b.t;
      w.copy(b.P).sub(camPos);
      const dist = w.length();
      const u = b.puffs.material.uniforms;
      u.uC.value.copy(w);
      u.uT.value = t;
      u.uDay.value = Math.max(0.15, Math.min(1, b.up.dot(U.uSun.value) * 4 + 0.4));
      b.ring.position.copy(w).addScaledVector(b.up, 30);
      const rr = b.scale * (200 + 6000 * (1 - Math.exp(-t / 3)));
      b.ring.scale.setScalar(rr);
      b.ring.material.uniforms.uA.value = Math.max(0, 1 - t / 5) * ctx.atm();
      b.flash.position.copy(w).addScaledVector(b.up, b.scale * 300);
      b.flash.lookAt(0, 0, 0);
      b.flash.scale.setScalar(b.scale * 5000 * Math.min(1, t * 8));
      b.flash.material.uniforms.uCol.value.setScalar(60 * Math.exp(-t * 2.2));
      flash += Math.exp(-t * 3) * 1.6 * Math.min(2, b.scale) / (1 + dist / (25000 * b.scale));
      // the shock wave reaches you at the speed of sound
      const delay = dist / ctx.soundSpeed();
      if (!b.heard && t >= delay && ctx.atm() > 0 && dist < 250e3) {
        b.heard = true;
        ctx.sound('boom', Math.min(1, 6000 * b.scale / (dist + 2000)));
        shake = Math.max(shake, Math.min(1.8, 9000 * b.scale / (dist + 3000)));
      }
      if (t > 140) {
        scene.remove(b.puffs, b.ring, b.flash);
        b.puffs.material.dispose(); b.ring.material.dispose(); b.flash.material.dispose();
        blasts.splice(i, 1);
      }
    }
    return { flash, shake, active: missiles.length + blasts.length + rocks.length };
  }

  return { fire, update, explode, asteroid };
}

// march along a ray until it meets the ground or the sea; planet-centred metres
export function raycastGround(origin, dir, surfaceAt, maxDist = 2e7) {
  const p = new THREE.Vector3(), up = new THREE.Vector3();
  // jump straight to the top of the atmosphere / highest mountains if we start above them
  let t = 0;
  const b = origin.dot(dir), c = origin.lengthSq() - (R + 9000) * (R + 9000);
  if (c > 0) {
    const disc = b * b - c;
    if (disc < 0 || -b - Math.sqrt(disc) < 0) return null;
    t = -b - Math.sqrt(disc);
  }
  for (let i = 0; i < 600 && t < maxDist; i++) {
    p.copy(origin).addScaledVector(dir, t);
    const r = p.length();
    const h = r - R - surfaceAt(up.copy(p).divideScalar(r));
    if (h < 2) return p.clone();
    t += Math.max(2, h * 0.7);
  }
  return null;
}
