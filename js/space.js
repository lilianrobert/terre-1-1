// The solar system around the active body: Sun, planets, Moon, Saturn's rings, the real night sky
// (5 000 catalogue stars and the Milky Way), orbit lines and on-screen labels.
// Everything is placed in the active body's fixed frame, relative to the camera (floating origin).
import * as THREE from 'three';
import { BODIES, positions, bodyFrame, apply, AU, PLANETS, planetHelio } from './ephem.js';

const C = 299792458;
// equatorial J2000 -> galactic (row-major)
const GAL = [-0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.4448296300, 0.7469822445, -0.8676661490, -0.1980763734, 0.4559837762];

const planetVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vN;
varying vec3 vRel;
void main() {
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRel = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const planetFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tMap;
uniform vec3 uSunDir;
uniform vec3 uAtmo;
uniform float uEmissive;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vRel;
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vObj);
  vec2 uv = vec2((atan(-d.z, d.x) / PI + 1.0) * 0.5, 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI);
  vec3 alb = pow(texture2D(tMap, uv).rgb, vec3(2.2));
  if (uEmissive > 0.5) {
    vec3 V = normalize(-vRel);
    float limb = pow(max(dot(normalize(vN), V), 0.0), 0.45);           // limb darkening
    gl_FragColor = vec4(alb * 40.0 * (0.35 + 0.65 * limb), 1.0);
    return;
  }
  vec3 N = normalize(vN);
  vec3 V = normalize(-vRel);
  float ndl = dot(N, uSunDir);
  vec3 col = alb * max(ndl, 0.0) * 2.6 + alb * 0.003;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uAtmo * rim * smoothstep(-0.25, 0.35, ndl) * 0.9;
  gl_FragColor = vec4(col, 1.0);
}`;

const ringFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tMap;
uniform vec3 uSunDir;
uniform vec2 uRad;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vRel;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vObj.xz);
  float u = (r - uRad.x) / (uRad.y - uRad.x);
  if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture2D(tMap, vec2(u, 0.5));
  float lit = 0.35 + 0.65 * abs(dot(normalize(vN), uSunDir));
  vec3 col = vec3(0.86, 0.78, 0.64) * t.r * lit * 2.2;
  gl_FragColor = vec4(col * t.a, t.a * 0.95);
}`;

const skyVS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.999999;   // pinned to the far plane
}`;
const skyFS = /* glsl */`
#include <common>
uniform sampler2D tMap;
uniform mat3 uToGal;
uniform float uBright;
varying vec3 vDir;
void main() {
  vec3 g = uToGal * normalize(vDir);
  float l = atan(g.y, g.x), b = asin(clamp(g.z, -1.0, 1.0));
  vec3 c = pow(texture2D(tMap, vec2(0.5 - l / (2.0 * PI), 0.5 + b / PI)).rgb, vec3(2.2));
  gl_FragColor = vec4(c * uBright, 0.0);
}`;

const starVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aMag;
attribute vec3 aCol;
uniform float uPx;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  float b = pow(10.0, -0.4 * aMag);
  gl_PointSize = clamp(1.2 + 2.6 * pow(b, 0.3), 1.0, 6.5) * uPx;
  vC = aCol * clamp(b * 2.2, 0.035, 2.2);
}`;
const starFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uBright;
varying vec3 vC;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(vC * exp(-r * r * 3.5) * uBright, 1.0);
}`;

const glowFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv2;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv2 - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 3.0) * 1.6 + exp(-r * 30.0) * 4.0;
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * a, 1.0);
}`;
const glowVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv2;
void main() {
  vUv2 = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const bvColor = (bv) => {
  const stops = [[-0.3, [0.62, 0.72, 1.0]], [0.3, [1, 1, 1]], [0.8, [1, 0.9, 0.72]], [1.4, [1, 0.72, 0.48]], [2.0, [1, 0.56, 0.36]]];
  if (bv <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (bv <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (bv - a) / (b - a);
    return ca.map((v, k) => v + (cb[k] - v) * t);
  }
  return stops[stops.length - 1][1];
};

export function createSpace({ scene, renderer }) {
  const loader = new THREE.TextureLoader();
  const tex = (f) => { const t = loader.load(`data/${f}`); t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; return t; };
  const sphereGeo = new THREE.SphereGeometry(1, 128, 64);
  const bodies = {};

  for (const [id, b] of Object.entries(BODIES)) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: planetVS, fragmentShader: planetFS,
      uniforms: { tMap: { value: tex(b.tex) }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uAtmo: { value: new THREE.Vector3(...(b.atmo || [0, 0, 0])) }, uEmissive: { value: b.emissive ? 1 : 0 } },
    });
    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
    scene.add(mesh);
    const o = { id, ...b, mesh, rel: new THREE.Vector3(), cam: new THREE.Vector3(), basis: new THREE.Matrix4() };
    if (b.rings) {
      const rt = loader.load('data/saturn_ring.png');
      rt.colorSpace = THREE.NoColorSpace;
      const rg = new THREE.RingGeometry(b.rings[0], b.rings[1], 256, 1).rotateX(-Math.PI / 2);
      rg.scale(1 / b.r, 1 / b.r, 1 / b.r);
      const rm = new THREE.ShaderMaterial({
        vertexShader: planetVS, fragmentShader: ringFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { tMap: { value: rt }, uSunDir: { value: mat.uniforms.uSunDir.value }, uRad: { value: new THREE.Vector2(b.rings[0] / b.r, b.rings[1] / b.r) } },
      });
      o.ring = new THREE.Mesh(rg, rm);
      o.ring.matrixAutoUpdate = false; o.ring.frustumCulled = false; o.ring.visible = false;
      scene.add(o.ring);
    }
    bodies[id] = o;
  }
  // sun glow billboard
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    vertexShader: glowVS, fragmentShader: glowFS, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  glow.frustumCulled = false; glow.renderOrder = 4;
  scene.add(glow);

  // the Milky Way, painted on the far plane
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
    vertexShader: skyVS, fragmentShader: skyFS, side: THREE.BackSide, depthWrite: false, depthTest: false, blending: THREE.NoBlending,
    uniforms: { tMap: { value: tex('milkyway.jpg') }, uToGal: { value: new THREE.Matrix3() }, uBright: { value: 0.55 } },
  }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  scene.add(sky);

  // catalogue stars (RA/Dec, magnitude, B-V colour), at "infinity" in the inertial frame
  const starMat = new THREE.ShaderMaterial({
    vertexShader: starVS, fragmentShader: starFS, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: { uPx: { value: renderer.getPixelRatio() }, uBright: { value: 1 } },
  });
  const stars = new THREE.Points(new THREE.BufferGeometry(), starMat);
  stars.matrixAutoUpdate = false; stars.frustumCulled = false; stars.renderOrder = -9;
  scene.add(stars);
  fetch('data/stars.json').then((r) => r.json()).then((a) => {
    const n = a.length / 4, pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ra = a[i * 4] * Math.PI / 180, dec = a[i * 4 + 1] * Math.PI / 180;
      const D = 1e12;
      pos[i * 3] = Math.cos(dec) * Math.cos(ra) * D; pos[i * 3 + 1] = Math.cos(dec) * Math.sin(ra) * D; pos[i * 3 + 2] = Math.sin(dec) * D;
      mag[i] = a[i * 4 + 2];
      const c = bvColor(a[i * 4 + 3]); col.set(c, i * 3);
    }
    stars.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars.geometry.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    stars.geometry.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  }).catch(() => {});

  // orbit rings, heliocentric, drawn only out in space
  const orbits = PLANETS.map((name) => {
    const pts = new Float32Array(361 * 3);
    for (let k = 0; k <= 360; k++) { const p = planetHelio(name, 2451545, k / 360 * Math.PI * 2); pts.set([p[0], p[1], p[2]], k * 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: name === 'earth' ? 0x4a78b0 : 0x55606e, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }));
    line.matrixAutoUpdate = false; line.frustumCulled = false; line.visible = false;
    scene.add(line);
    return line;
  });

  // labels
  const layer = document.getElementById('labels');
  for (const b of Object.values(bodies)) {
    const el = document.createElement('div');
    el.className = 'blabel';
    el.innerHTML = `<i></i><b>${b.name}</b><span></span>`;
    layer.appendChild(el);
    b.label = el;
  }

  const M4 = new THREE.Matrix4(), v = new THREE.Vector3(), proj = new THREE.Vector3();
  let P = null, Ra = null, lastJd = -1;
  const toActive = (p, active) => apply(Ra, [p[0] - P[active][0], p[1] - P[active][1], p[2] - P[active][2]]);
  const basisOf = (m) => M4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);

  // Ra * Rb^T: body-fixed b -> active frame
  function relRot(b, jd) {
    const Rb = bodyFrame(b, jd);
    const out = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = Ra[i * 3] * Rb[j * 3] + Ra[i * 3 + 1] * Rb[j * 3 + 1] + Ra[i * 3 + 2] * Rb[j * 3 + 2];
    return out;
  }

  function update(jd, active, camPos, camera, camR, showLabels) {
    if (jd !== lastJd || !P) { P = positions(jd); lastJd = jd; }
    Ra = bodyFrame(active, jd);
    const sunRel = toActive(P.sun, active);
    for (const b of Object.values(bodies)) {
      const r = toActive(P[b.id], active);
      b.rel.set(r[0], r[1], r[2]);
      b.cam.set(r[0] - camPos.x, r[1] - camPos.y, r[2] - camPos.z);
      const show = b.id !== active;
      b.mesh.visible = show;
      b.mesh.material.uniforms.uSunDir.value.set(sunRel[0] - r[0], sunRel[1] - r[1], sunRel[2] - r[2]).normalize();
      if (show || b.ring) {
        const rr = relRot(b.id, jd);
        b.basis.copy(basisOf(rr));                     // body-fixed -> active frame
        b.mesh.matrix.copy(b.basis).scale(v.set(b.r, b.r, b.r)).setPosition(b.cam);
        b.mesh.matrixWorld.copy(b.mesh.matrix);
        if (b.ring) { b.ring.visible = show; b.ring.matrix.copy(b.mesh.matrix); b.ring.matrixWorld.copy(b.ring.matrix); }
      }
    }
    // glow around the Sun, facing the camera
    const sun = bodies.sun;
    glow.position.copy(sun.cam);
    glow.lookAt(0, 0, 0);
    glow.scale.setScalar(sun.r * 9);
    glow.visible = sun.cam.length() > sun.r * 1.5;

    // inertial -> active rotation for the sky
    basisOf(Ra);
    stars.matrix.copy(M4); stars.matrixWorld.copy(M4);
    const toGal = new THREE.Matrix3();
    const g = new Array(9);   // GAL * Ra^T
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g[i * 3 + j] = GAL[i * 3] * Ra[j * 3] + GAL[i * 3 + 1] * Ra[j * 3 + 1] + GAL[i * 3 + 2] * Ra[j * 3 + 2];
    toGal.set(...g);
    sky.material.uniforms.uToGal.value.copy(toGal);

    // orbits, when we are well out of the planet's neighbourhood
    const far = camR > 3e8;
    const sunCam = sun.cam;
    PLANETS.forEach((name, i) => {
      const l = orbits[i];
      l.visible = far;
      if (!far) return;
      l.matrix.copy(M4).setPosition(sunCam);
      l.matrixWorld.copy(l.matrix);
    });

    // labels
    const W = innerWidth, H = innerHeight;
    for (const b of Object.values(bodies)) {
      const d = b.cam.length();
      const ang = b.r / d;
      // the body we belong to gets a label too once we are far from it
      let vis = showLabels && (b.id !== active || camR > b.r * 40) && ang < 0.05;
      if (vis) {
        proj.copy(b.cam).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        vis = proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05 && b.cam.dot(v.set(0, 0, -1).applyQuaternion(camera.quaternion)) > 0;
      }
      b.label.style.display = vis ? '' : 'none';
      if (!vis) continue;
      b.label.style.transform = `translate(${((proj.x + 1) / 2 * W).toFixed(1)}px, ${((1 - proj.y) / 2 * H).toFixed(1)}px)`;
      const dist = d - b.r;
      b.label.querySelector('span').textContent = dist > 0.05 * AU ? `${(dist / AU).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} UA` : `${Math.round(dist / 1000).toLocaleString('fr-FR')} km`;
    }
    return { sunRel };
  }

  // distance from the camera to the nearest surface among the non-active bodies (for speed and collisions)
  function nearest(active) {
    let best = null, bd = Infinity;
    if (!P) return { body: null, dist: Infinity };
    for (const b of Object.values(bodies)) {
      if (b.id === active) continue;
      const d = b.cam.length() - b.r;
      if (d < bd) { bd = d; best = b; }
    }
    return { body: best, dist: bd };
  }

  // inertial helpers for teleports
  const inertial = () => P;
  return { update, nearest, bodies, inertial, frame: () => Ra, C };
}
