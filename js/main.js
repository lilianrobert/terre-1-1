import * as THREE from 'three';
import { R, NSEG, N, FACES, cubeToSphere, edgeIndex, latLonToDir, terrain, setData, snoise, setRadius } from './terrain-core.js';
import { BODY_RADIUS } from './bodies.js';
import { jdOf, bodyFrame, apply, applyT, positions, BODIES, AU } from './ephem.js';
import { createSpace } from './space.js';
import { createWeapons, raycastGround } from './boom3d.js';
import { createSfx } from './sfx.js';
import * as SH from './shaders.js';
import { initUI } from './ui.js';
import { createCity } from './city3d.js';
import { LANDMARKS } from './landmarks.js';

// ------------------------------------------------------------------ settings
const MAX_LEVEL = 19;       // ~19 m chunks, ~0.6 m between vertices
const FEAT_LEVEL = 14;      // must match chunk.js
const WAVE_L = 2048;        // period (m) of the chunk-local coordinates used by shaders
const TEX = 128;
let LOD_K = 2.2;            // split when camera distance < LOD_K * chunk size
export const PLACES = [
  { key: 'Digit1', name: 'Dune du Pilat', lat: 44.575, lon: -1.226, alt: 420, head: 20 },
  { key: 'Digit2', name: 'Mont Blanc', lat: 45.80, lon: 6.75, alt: 3200, head: 110 },
  { key: 'Digit3', name: 'Everest', lat: 27.93, lon: 86.82, alt: 3500, head: 40 },
  { key: 'Digit4', name: 'Tour Eiffel', lat: 48.85826, lon: 2.29450, look: 520 },
  { key: 'Digit5', name: 'Grand Canyon', lat: 36.06, lon: -112.15, alt: 900, head: 0 },
  { key: 'Digit6', name: "Estuaire de la Gironde", lat: 45.30, lon: -0.95, alt: 2500, head: 330 },
  { key: 'Digit7', name: 'Fjords de Norvège', lat: 61.12, lon: 6.9, alt: 1500, head: 270 },
  { key: 'Digit8', name: 'New York', lat: 40.70, lon: -74.02, alt: 600, head: 20 },
  { key: 'Digit9', name: 'Bora-Bora', lat: -16.52, lon: -151.70, alt: 900, head: 60 },
];
export const SPACE = [
  { name: 'Lune · Base Apollo 11', body: 'moon', lat: 0.674, lon: 23.473, alt: 300, head: 100, pitch: -0.12, hour: 7.6 },
  { name: 'Lune · Cratère Tycho', body: 'moon', lat: -43.3, lon: -11.2, look: 60000, hour: 8.5 },
  { name: 'Lune · Lever de Terre', body: 'moon', lat: 0, lon: 84, alt: 1200, head: 270, pitch: 0.06 },
  { name: 'Mars · Olympus Mons', body: 'mars', lat: 18.65, lon: -133.8, look: 260000, hour: 9 },
  { name: 'Mars · Valles Marineris', body: 'mars', lat: -9.5, lon: -72, alt: 7000, head: 95, pitch: -0.2, hour: 9.5 },
  { name: 'Mars · Cratère Gale (Curiosity)', body: 'mars', lat: -5.4, lon: 137.8, alt: 2500, head: 200, pitch: -0.1 },
  { name: "La Terre vue de l'espace", space: 'earth' },
  { name: 'Système solaire', space: 'system' },
  { name: 'Jupiter', space: 'jupiter' },
  { name: 'Saturne et ses anneaux', space: 'saturn' },
  { name: 'Le Soleil', space: 'sun' },
];
// atmosphere of each body with terrain: scattering coefficients, scale heights, sky tint
const ATMO = {
  earth: { RA: 100e3, BR: [5.8e-6, 13.5e-6, 33.1e-6], BM: 11e-6, HR: 8000, HM: 1200, atm: 1, tint: [1, 1, 1], sunI: 14, sound: 343, air: 9000 },
  mars: { RA: 90e3, BR: [6.5e-6, 4.2e-6, 1.9e-6], BM: 4e-6, HR: 11100, HM: 11100, atm: 1, tint: [1.0, 0.7, 0.48], sunI: 9, sound: 240, air: 11100 },
  moon: { RA: 0, BR: [0, 0, 0], BM: 0, HR: 1, HM: 1, atm: 0, tint: [0, 0, 0], sunI: 0, sound: 1e9, air: 0 },
};
const DAYLEN = { earth: 1, mars: 1.0275, moon: 29.53 };   // solar day, Earth days
let active = 'earth';
let simJD = jdOf(new Date());
const cfg = { clouds: true, trees: true, buildings: true, sound: true, quality: 'high' };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('earth-cfg') || '{}')); } catch (e) { /* storage unavailable */ }
const saveCfg = () => { try { localStorage.setItem('earth-cfg', JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
renderer.setSize(innerWidth, innerHeight);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 1e13);
const scene = new THREE.Scene();

let rt = null;
const tmpV2 = new THREE.Vector2();
function makeRT() {
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  s.x = Math.max(1, s.x); s.y = Math.max(1, s.y);
  const dt = new THREE.DepthTexture(s.x, s.y, THREE.FloatType);
  return new THREE.WebGLRenderTarget(s.x, s.y, { type: THREE.HalfFloatType, depthTexture: dt, depthBuffer: true });
}
function applyQuality() {
  renderer.setPixelRatio(cfg.quality === 'eco' ? 1 : Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  LOD_K = cfg.quality === 'eco' ? 1.7 : 2.2;
}
applyQuality();
rt = makeRT();

// shared uniforms (same {value} objects are referenced by every chunk material)
const U = {
  uSun: { value: new THREE.Vector3(1, 0, 0) },
  uTime: { value: 0 },
  uWaveAmp: { value: 1 },
  uWaveMax: { value: 1 },
  uWaves: { value: Array.from({ length: SH.NWAVES }, () => new THREE.Vector4()) },
  uWaveW: { value: Array.from({ length: SH.NWAVES }, () => new THREE.Vector2()) },
  uWindDir: { value: new THREE.Vector3(1, 0, 0) },
  uWindStr: { value: 0.5 },
  tShadow: { value: null },
  uShadowMat: { value: new THREE.Matrix4() },
  uShadowOn: { value: 0 },
  uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
  uTsu: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uTsuA: { value: [0, 0, 0, 0] }, uTsuV: { value: 700 },
  uPR: { value: 6371000 }, uRA: { value: 6471000 }, uBR: { value: new THREE.Vector3() }, uBM: { value: 0 },
  uHR: { value: 8000 }, uHM: { value: 1200 }, uAtm: { value: 1 }, uSkyTint: { value: new THREE.Vector3(1, 1, 1) }, uSunI: { value: 14 },
};
const atmoU = () => ({ uPR: U.uPR, uRA: U.uRA, uBR: U.uBR, uBM: U.uBM, uHR: U.uHR, uHM: U.uHM, uAtm: U.uAtm, uSkyTint: U.uSkyTint, uSunI: U.uSunI });
function applyAtmo(b) {
  const a = ATMO[b];
  U.uPR.value = BODY_RADIUS[b]; U.uRA.value = BODY_RADIUS[b] + a.RA;
  U.uBR.value.set(...a.BR); U.uBM.value = a.BM; U.uHR.value = a.HR; U.uHM.value = a.HM;
  U.uAtm.value = a.atm; U.uSkyTint.value.set(...a.tint); U.uSunI.value = a.sunI;
}
applyAtmo('earth');

const postMat = new THREE.ShaderMaterial({
  vertexShader: SH.postVS, fragmentShader: SH.postFS, depthTest: false, depthWrite: false,
  uniforms: {
    tColor: { value: null }, tDepth: { value: null },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() }, uCamR: { value: R }, uCamAlt: { value: 0 },
    uFar: { value: camera.far }, uTime: U.uTime, uSun: U.uSun,
    uCloudOff: { value: new THREE.Vector3() }, uCloudCover: { value: 0.34 }, uExposure: { value: 1 },
    uAspect: { value: 1 }, uSpeedFx: { value: 0 }, uShockT: { value: 9 }, uShockAmp: { value: 0 }, uVapor: { value: 0 }, uFlash: { value: 0 },
    ...atmoU(),
  },
});
const postScene = new THREE.Scene();
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
postQuad.frustumCulled = false;
postScene.add(postQuad);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ------------------------------------------------------------------ shared geometry
const INDEX = (() => {
  const idx = [];
  for (let j = 0; j < NSEG; j++) for (let i = 0; i < NSEG; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  for (let e = 0; e < 4; e++) for (let k = 0; k < NSEG; k++) {
    const g0 = edgeIndex(e, k), g1 = edgeIndex(e, k + 1), s0 = N * N + e * N + k, s1 = s0 + 1;
    idx.push(g0, g1, s1, g0, s1, s0, g0, s1, g1, g0, s0, s1); // both windings
  }
  return new Uint16Array(idx);
})();

// ------------------------------------------------------------------ workers
const workers = [];
const MAX_INFLIGHT = 4;
let nextId = 1;
const byId = new Map();
const queue = new Set();
let frame = 0;
let chunksBuilt = 0;
const stats = { pending: 0 };

async function loadPixels(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

async function initWorkers(data, color) {
  const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const ready = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const rec = { w, busy: 0 };
    ready.push(new Promise((res) => {
      w.onmessage = (e) => {
        if (e.data.type === 'ready') { res(); return; }
        rec.busy--;
        if (e.data.type === 'city') city.onResult(e.data);
        else onChunk(e.data);
      };
    }));
    w.postMessage({ type: 'init', data: data.data, dw: data.width, dh: data.height, color: color.data, cw: color.width, ch: color.height });
    workers.push(rec);
  }
  await Promise.all(ready);
}

// ------------------------------------------------------------------ quadtree
const ST_NONE = 0, ST_QUEUED = 1, ST_BUSY = 2, ST_READY = 3;
const tmpD = new Float64Array(3);

class Node {
  constructor(face, level, x0, y0, size) {
    this.id = nextId++;
    this.face = face; this.level = level; this.x0 = x0; this.y0 = y0; this.size = size;
    cubeToSphere(face, x0 + size / 2, y0 + size / 2, tmpD);
    this.dir = new THREE.Vector3(tmpD[0], tmpD[1], tmpD[2]);
    this.c0 = this.dir.clone().multiplyScalar(R);   // mesh origin (doubles)
    this.center = this.c0.clone();                  // LOD reference point
    this.sizeM = size * Math.PI * R / 4;
    this.state = ST_NONE; this.reqFrame = -1; this.dist = 0; this.retryAt = 0;
    this.children = null; this.mesh = null; this.ocean = null;
    this.hv = null; this.tex = null; this.worker = null; this.dead = false;
    this.gen = 0; this.needGen = 0; this.sentGen = 0; this.rebuilding = false;
    byId.set(this.id, this);
  }
}

let roots = [0, 1, 2, 3, 4, 5].map((f) => new Node(f, 0, -1, -1, 2));

function request(n) {
  n.reqFrame = frame;
  if (n.state === ST_NONE && frame >= n.retryAt) { n.state = ST_QUEUED; queue.add(n); }
}

function split(n) {
  const h = n.size / 2;
  n.children = [
    new Node(n.face, n.level + 1, n.x0, n.y0, h), new Node(n.face, n.level + 1, n.x0 + h, n.y0, h),
    new Node(n.face, n.level + 1, n.x0, n.y0 + h, h), new Node(n.face, n.level + 1, n.x0 + h, n.y0 + h, h),
  ];
}

function dispose(n) {
  if (n.children) for (const c of n.children) dispose(c);
  n.children = null;
  n.dead = true;
  if (n.state === ST_BUSY && n.worker) n.worker.w.postMessage({ type: 'cancel', id: n.id });
  queue.delete(n);
  byId.delete(n.id);
  for (const m of [n.mesh, n.ocean]) {
    if (!m) continue;
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  if (n.tex) n.tex.dispose();
  n.mesh = n.ocean = n.tex = null;
}

const camPos = new THREE.Vector3();   // player position, planet-centred, metres (doubles)
const camUp = new THREE.Vector3();
let camR = R;

function beyondHorizon(n) {
  const alphaCam = camR > R ? Math.acos(R / camR) : 0;
  const theta = Math.acos(Math.max(-1, Math.min(1, n.dir.dot(camUp))));
  return theta > alphaCam + 0.055 + n.sizeM * 0.8 / R;
}

function select(n, out) {
  n.dist = camPos.distanceTo(n.center);
  if (n.state !== ST_READY) { if (n.state !== ST_BUSY) request(n); return false; }
  if (n.gen < n.needGen && !n.rebuilding) rebuild(n);   // a crater was dug here: rebuild, keep showing the old mesh meanwhile
  const hidden = beyondHorizon(n);
  if (n.level < MAX_LEVEL && !hidden && n.dist < n.sizeM * LOD_K) {
    if (!n.children) split(n);
    const mark = out.length;
    let ok = true;
    for (const c of n.children) if (!select(c, out)) ok = false;
    if (ok) return true;
    out.length = mark;
  } else if (n.children && (hidden || n.dist > n.sizeM * LOD_K * 1.3)) {
    for (const c of n.children) dispose(c);
    n.children = null;
  }
  out.push(n);
  return true;
}

function dispatch() {
  for (const n of queue) if (n.reqFrame !== frame) { queue.delete(n); n.state = ST_NONE; }
  stats.pending = queue.size + workers.reduce((s, w) => s + w.busy, 0);
  if (!queue.size) return;
  // coarse first (like a map: the blurry tile comes before the sharp one), then nearest
  const list = [...queue].sort((a, b) => a.level - b.level || a.dist - b.dist);
  for (const n of list) {
    let w = null;
    for (const r of workers) if (r.busy < MAX_INFLIGHT && (!w || r.busy < w.busy)) w = r;
    if (!w) break;
    queue.delete(n);
    n.state = ST_BUSY;
    n.worker = w;
    w.busy++;
    n.sentGen = craterGen;
    w.w.postMessage({ id: n.id, face: n.face, x0: n.x0, y0: n.y0, size: n.size, level: n.level, body: active });
  }
}
function rebuild(n) {
  let w = null;
  for (const r of workers) if (r.busy < MAX_INFLIGHT && (!w || r.busy < w.busy)) w = r;
  if (!w) return;
  n.rebuilding = true;
  n.worker = w;
  n.sentGen = craterGen;
  w.busy++;
  w.w.postMessage({ id: n.id, face: n.face, x0: n.x0, y0: n.y0, size: n.size, level: n.level, body: active });
}

// hand a city job to the least busy worker; only when terrain is not waiting for one
function postCity(msg) {
  if (queue.size > 6) return null;
  let w = null;
  for (const r of workers) if (r.busy < MAX_INFLIGHT - 1 && (!w || r.busy < w.busy)) w = r;
  if (!w) return null;
  w.busy++;
  w.w.postMessage(msg);
  return w;
}

function modPos(v) { return ((v % WAVE_L) + WAVE_L) % WAVE_L; }

function chunkTexture(data) {
  const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, maxAniso);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function onChunk(r) {
  const n = byId.get(r.id);
  if (!n || n.dead || (r.body && r.body !== active)) return;
  if (r.cancelled || r.error) {
    if (r.error) console.warn('chunk', r.error);
    if (n.rebuilding) { n.rebuilding = false; return; }
    n.state = ST_NONE;
    n.retryAt = frame + (r.error ? 120 : 0);
    return;
  }
  if (n.rebuilding) {   // replace the pre-crater mesh
    for (const m of [n.mesh, n.ocean]) if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    if (n.tex) n.tex.dispose();
    n.mesh = n.ocean = null;
    n.rebuilding = false;
  }
  n.gen = n.sentGen;
  chunksBuilt++;
  n.center.copy(n.dir).multiplyScalar(R + Math.max(0, (r.minH + r.maxH) / 2));
  n.hv = r.hv;
  n.minH = r.minH; n.maxH = r.maxH;
  const off = new THREE.Vector3(modPos(r.cx), modPos(r.cy), modPos(r.cz));
  const center = new THREE.Vector3(r.cx, r.cy, r.cz);
  n.tex = chunkTexture(r.tex);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(r.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(r.uv, 2));
  g.setAttribute('ah', new THREE.BufferAttribute(r.hv, 1));
  g.setIndex(new THREE.BufferAttribute(INDEX.slice(), 1));
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    vertexShader: SH.terrainVS, fragmentShader: SH.terrainFS,
    uniforms: {
      uSun: U.uSun, uTime: U.uTime, uWindDir: U.uWindDir, uWindStr: U.uWindStr,
      tTex: { value: n.tex }, uCenter: { value: center }, uOff: { value: off },
      tShadow: U.tShadow, uShadowMat: U.uShadowMat, uShadowOn: U.uShadowOn, uShadowTexel: U.uShadowTexel, ...atmoU(),
    },
  });
  n.mesh = new THREE.Mesh(g, mat);
  n.mesh.visible = false;
  scene.add(n.mesh);

  if (r.opos) {
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(r.opos, 3));
    og.setAttribute('uv', g.getAttribute('uv'));
    og.setAttribute('ah', g.getAttribute('ah'));
    og.setIndex(new THREE.BufferAttribute(INDEX.slice(), 1));
    og.computeBoundingSphere();
    og.boundingSphere.radius += 10;
    const omat = new THREE.ShaderMaterial({
      vertexShader: SH.oceanVS, fragmentShader: SH.oceanFS, transparent: true, depthWrite: true,
      uniforms: {
        uSun: U.uSun, uTime: U.uTime, uWaveAmp: U.uWaveAmp, uWaveMax: U.uWaveMax, uWaves: U.uWaves, uWaveW: U.uWaveW,
        uWindDir: U.uWindDir, uWindStr: U.uWindStr, tTex: { value: n.tex }, uCenter: { value: center }, uOff: { value: off }, ...atmoU(),
        uTsu: U.uTsu, uTsuA: U.uTsuA, uTsuV: U.uTsuV,
      },
    });
    n.ocean = new THREE.Mesh(og, omat);
    n.ocean.visible = false;
    n.ocean.renderOrder = 1;
    scene.add(n.ocean);
  }

  n.state = ST_READY;
}

let shown = [];
function updateLOD() {
  frame++;
  const list = [];
  for (const r of roots) select(r, list);
  for (const n of shown) { if (n.mesh) n.mesh.visible = false; if (n.ocean) n.ocean.visible = false; }
  for (const n of list) {
    const x = n.c0.x - camPos.x, y = n.c0.y - camPos.y, z = n.c0.z - camPos.z;
    n.mesh.visible = true; n.mesh.position.set(x, y, z);
    if (n.ocean) { n.ocean.visible = true; n.ocean.position.set(x, y, z); }
  }
  shown = list;
  dispatch();
}

// ------------------------------------------------------------------ ground height from the loaded chunks
const tO = {};
const sph = new Float64Array(3), f0 = [0, 0], fa = [0, 0], fb = [0, 0];
function faceCoords(dir) {
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  const face = ax >= ay && ax >= az ? (dir.x > 0 ? 0 : 1) : ay >= az ? (dir.y > 0 ? 2 : 3) : (dir.z > 0 ? 4 : 5);
  const F = FACES[face];
  const dot = (v, x, y, z) => v[0] * x + v[1] * y + v[2] * z;
  const dn = dot(F.n, dir.x, dir.y, dir.z);
  const ta = dot(F.r, dir.x, dir.y, dir.z) / dn, tb = dot(F.u, dir.x, dir.y, dir.z) / dn;
  // invert the spherified cube mapping with Newton's method (a plain fixed point diverges near face edges)
  const g = (a, b, out) => {
    cubeToSphere(face, a, b, sph);
    const sn = dot(F.n, sph[0], sph[1], sph[2]);
    out[0] = dot(F.r, sph[0], sph[1], sph[2]) / sn - ta;
    out[1] = dot(F.u, sph[0], sph[1], sph[2]) / sn - tb;
  };
  let a = ta, b = tb;
  const e = 1e-7;
  for (let it = 0; it < 8; it++) {
    g(a, b, f0); g(a + e, b, fa); g(a, b + e, fb);
    const j11 = (fa[0] - f0[0]) / e, j21 = (fa[1] - f0[1]) / e, j12 = (fb[0] - f0[0]) / e, j22 = (fb[1] - f0[1]) / e;
    const det = j11 * j22 - j12 * j21;
    a -= (f0[0] * j22 - f0[1] * j12) / det;
    b -= (f0[1] * j11 - f0[0] * j21) / det;
    if (Math.abs(f0[0]) + Math.abs(f0[1]) < 1e-13) break;
  }
  return { face, a, b };
}
// ---- tsunamis (same formula as the ocean shader)
const tsunamis = [];   // { dir, t0, A, slot, heard }
function startTsunami(dir, A) {
  let slot = U.uTsuA.value.findIndex((a) => a <= 0);
  if (slot < 0) { const old = tsunamis.shift(); slot = old.slot; }
  U.uTsu.value[slot].set(dir.x, dir.y, dir.z, simT);
  U.uTsuA.value[slot] = A;
  tsunamis.push({ dir: dir.clone(), t0: simT, A, slot, heard: false });
}
function tsunamiAt(dir, depth) {
  let h = 0;
  for (const w of tsunamis) {
    const rf = (simT - w.t0) * U.uTsuV.value;
    if (rf <= 0) continue;
    const s = Math.atan2(new THREE.Vector3().crossVectors(dir, w.dir).length(), dir.dot(w.dir)) * R;
    const shoal = Math.min(3.5, Math.max(1, Math.pow(3000 / Math.max(depth, 6), 0.25)));
    const wd = (1200 + rf * 0.015) / (shoal * shoal), x = (s - rf) / wd;
    if (Math.abs(x) > 6) continue;
    const a = w.A * shoal / Math.sqrt(1 + rf / 15000);
    h += a * (Math.exp(-x * x) - 0.5 * Math.exp(-(x + 1.8) * (x + 1.8)));
  }
  return h;
}
function updateTsunamis() {
  for (let i = tsunamis.length - 1; i >= 0; i--) {
    const w = tsunamis[i];
    const rf = (simT - w.t0) * U.uTsuV.value;
    if (rf > 3.5e6) { U.uTsuA.value[w.slot] = 0; tsunamis.splice(i, 1); continue; }
    // the wall of water passing right by you
    const s = camUp.angleTo(w.dir) * R;
    if (!w.heard && Math.abs(s - rf) < 3000 && camR - R - surfH < 2500) {
      w.heard = true;
      if (audio && audio.sfx) audio.sfx.blast(0.7, 0.1);
      shake = Math.max(shake, 0.7);
      ui.toast('Tsunami !');
    }
  }
}

// what you stand on: the sea surface over the oceans, but the real floor inside missile craters
function inCrater(dir) {
  for (const c of craters) if (c.body === active && Math.acos(Math.min(1, dir.x * c.x + dir.y * c.y + dir.z * c.z)) * R < c.r * 1.05) return true;
  return false;
}
function surfaceAt(dir, g = groundAt(dir)) {
  const base = g >= 0 || inCrater(dir) ? g : 0;
  if (!tsunamis.length || inCrater(dir)) return base;
  const wl = tsunamiAt(dir, Math.max(-g, 0));
  return g < wl || g < 0 ? Math.max(g, wl) : base;   // the wave lifts the sea and floods low land
}
function groundAt(dir) {
  const { face, a, b } = faceCoords(dir);
  let n = roots[face], best = null;
  while (n) {
    if (n.state === ST_READY && n.hv) best = n;
    if (!n.children) break;
    const h = n.size / 2;
    n = n.children[(a >= n.x0 + h ? 1 : 0) + (b >= n.y0 + h ? 2 : 0)];
  }
  if (!best) return active === 'earth' ? terrain(dir.x, dir.y, dir.z, 30, tO) : 0;
  const gi = Math.max(0, Math.min(NSEG - 1e-6, (a - best.x0) / best.size * NSEG));
  const gj = Math.max(0, Math.min(NSEG - 1e-6, (b - best.y0) / best.size * NSEG));
  const i0 = Math.floor(gi), j0 = Math.floor(gj), fi = gi - i0, fj = gj - j0, k = j0 * N + i0, hv = best.hv;
  return (hv[k] * (1 - fi) + hv[k + 1] * fi) * (1 - fj) + (hv[k + N] * (1 - fi) + hv[k + N + 1] * fi) * fj;
}

// ------------------------------------------------------------------ wind
function localFrame(up, east, north) {
  east.set(up.z, 0, -up.x);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  north.crossVectors(up, east).normalize();
}
const wE = new THREE.Vector3(), wN = new THREE.Vector3();
function windAt(up, t, out) {
  localFrame(up, wE, wN);
  const lat = Math.asin(up.y);
  const zonal = -7 * Math.cos(3 * lat);  // trade winds / westerlies / polar easterlies
  const ang = snoise(up.x * 3 + t * 0.002, up.y * 3, up.z * 3) * 1.4;
  const gust = 1 + 0.35 * snoise(t * 0.08, 1.3, up.x * 50) + 0.15 * snoise(t * 0.5, 7.1, 0);
  const sp = (Math.abs(zonal) + 3 + 3 * snoise(up.x * 5, up.y * 5 + 2, up.z * 5)) * gust;
  const base = Math.atan2(0.15, Math.sign(zonal) || 1) + ang;
  out.copy(wE).multiplyScalar(Math.cos(base) * sp).addScaledVector(wN, Math.sin(base) * sp);
  return out;
}

// waves are 3D plane waves on a 2048 m lattice so chunk-local coordinates stay exact
const waveAnchor = new THREE.Vector3();
function buildWaves(up) {
  waveAnchor.copy(up);
  const wind = windAt(up, 0, new THREE.Vector3());
  const ws = Math.max(4, wind.length());
  const wd = wind.clone().normalize();
  const side = new THREE.Vector3().crossVectors(up, wd);
  const lp = Math.max(10, 0.55 * ws * ws);
  let seed = 7 + Math.floor(Math.abs(up.x * 1e4));
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let maxA = 0;
  for (let i = 0; i < SH.NWAVES; i++) {
    const lam = lp * Math.pow(0.7, i) * (0.8 + rnd() * 0.4);
    const ang = (rnd() - 0.5) * (1.4 + i * 0.14);
    const d = wd.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    const k = (2 * Math.PI) / lam;
    const q = WAVE_L / (2 * Math.PI);
    const kx = Math.round(d.x * k * q) / q, ky = Math.round(d.y * k * q) / q, kz = Math.round(d.z * k * q) / q;
    const kl = Math.hypot(kx, ky, kz) || 1;
    const amp = (0.085 * Math.pow(0.88, i) * (0.7 + 0.6 * rnd()) * Math.min(1.6, ws / 9)) / kl;
    if (i < SH.NWAVES_VERT) maxA += amp;
    U.uWaves.value[i].set(kx, ky, kz, amp);
    U.uWaveW.value[i].set(Math.sqrt(9.81 * kl), rnd() * 6.283);
  }
  U.uWaveMax.value = maxA;
}

// ------------------------------------------------------------------ player
const player = {
  mode: 'fly', vel: new THREE.Vector3(), heading: new THREE.Vector3(), pitch: -0.12,
  speedMul: 1, grounded: false, vv: 0,
};
const keys = new Set();
let shake = 0, grace = 0;

function setView(lat, lon, alt, headDeg = 0, pitch = -0.15) {
  const d = latLonToDir(lat, lon);
  const dir = new THREE.Vector3(d[0], d[1], d[2]);
  const g = surfaceAt(dir);
  camPos.copy(dir).multiplyScalar(R + g + alt);
  const e = new THREE.Vector3(), nn = new THREE.Vector3();
  localFrame(dir, e, nn);
  const h = headDeg * Math.PI / 180;
  player.heading.copy(nn).multiplyScalar(Math.cos(h)).addScaledVector(e, Math.sin(h));
  player.pitch = pitch;
  player.vel.set(0, 0, 0);
  player.vv = 0;
  buildWaves(dir);
}
function goTo(p) { if (p.look) lookAtPlace(p.lat, p.lon, p.look); else setView(p.lat, p.lon, p.alt, p.head || 0); ui.toast(p.name); }

// ---- the active body owns the terrain engine; everything else is drawn by space.js
const bodyTexSent = new Set();
async function ensureBodyData(b) {
  if (b === 'earth' || bodyTexSent.has(b)) return;
  const img = await loadPixels(`data/${b}.jpg`);
  for (const w of workers) w.w.postMessage({ type: 'bodyData', id: b, data: img.data, w: img.width, h: img.height });
  bodyTexSent.add(b);
}
let switching = false;

// ---- missile craters, kept across sessions
let craterGen = 0;
let craters = [];
try { craters = JSON.parse(localStorage.getItem('earth-craters') || '[]'); } catch (e) { craters = []; }
const saveCraters = () => { try { localStorage.setItem('earth-craters', JSON.stringify(craters)); } catch (e) { /* ignore */ } };
const sendCraters = () => { for (const w of workers) w.w.postMessage({ type: 'craters', list: craters }); };
function invalidate(dir, radius) {
  craterGen++;
  const walk = (n) => {
    if (n.dir.angleTo(dir) * R > n.sizeM * 0.8 + radius) return;
    n.needGen = craterGen;
    if (n.children) n.children.forEach(walk);
  };
  roots.forEach(walk);
}
// a hit inside an existing crater deepens and widens it instead of making a new one
function onImpact(P, kind = 'missile') {
  const dir = P.clone().normalize();
  const big = kind === 'asteroid';
  const water = active === 'earth' && groundAt(dir) < -10 && !inCrater(dir);
  if (water) startTsunami(dir, big ? 70 : 7);
  let c = null;
  for (const q of craters) if (q.body === active && dir.angleTo(new THREE.Vector3(q.x, q.y, q.z)) * R < q.r * 0.9) { c = q; break; }
  if (c) {
    c.n = (c.n || 1) + 1;
    c.r = big ? Math.max(c.r * 1.2 + 200, 2600) : c.r * 1.06 + 25;
    c.d += big ? 600 + c.d * 0.1 : 140 + c.d * 0.035;
    const cd = new THREE.Vector3(c.x, c.y, c.z).lerp(dir, 0.12).normalize();
    c.x = cd.x; c.y = cd.y; c.z = cd.z;
  } else {
    c = big ? { body: active, x: dir.x, y: dir.y, z: dir.z, r: 2600, d: 650, n: 1 } : { body: active, x: dir.x, y: dir.y, z: dir.z, r: 380, d: 110, n: 1 };
    craters.push(c);
  }
  saveCraters();
  sendCraters();
  invalidate(new THREE.Vector3(c.x, c.y, c.z), c.r * 6);
  if (active === 'earth') city.applyCraters(craters, P, c.r * 6);
  ui.toast((water ? (big ? 'Impact en mer · tsunami géant' : 'Impact en mer · tsunami') : big ? 'Impact d’astéroïde' : 'Impact') + (c.n > 1 ? ` · cratère ${Math.round(c.r * 2)} m, ${Math.round(c.d)} m de profondeur` : ''));
  return { scale: big ? 3.4 : Math.min(2.6, 1 + (c.n - 1) * 0.06), water };
}
function clearCraters() {
  if (!craters.length) return;
  for (const c of craters) if (c.body === active) invalidate(new THREE.Vector3(c.x, c.y, c.z), c.r * 6);
  craters = [];
  saveCraters();
  sendCraters();
  city.applyCraters(craters, null, 0);
  ui.toast('La Terre est réparée');
}
let fireCool = 0;
let weapon = 'missile';
function setWeapon(w) { weapon = w; ui.setWeapon(w); ui.toast(w === 'asteroid' ? 'Arme : astéroïde' : 'Arme : missile'); }
function fireMissile() {
  if (fireCool > 0) return;
  const target = raycastGround(camPos, fwd, surfaceAt);
  if (weapon === 'asteroid') {
    if (!target) { ui.toast('Vise la surface pour guider l’astéroïde'); return; }
    fireCool = 1.2;
    weapons.asteroid(target, camPos);
    return;
  }
  fireCool = 0.18;
  weapons.fire(camPos.clone().addScaledVector(fwd, 4), fwd, player.vel, target);
}
// continuous = keep the camera where it is in space (flying across), otherwise just change world
async function switchBody(b, continuous) {
  if (b === active || switching) return;
  switching = true;
  try {
    ui.status && ui.toast(`Vers : ${BODIES[b].name}…`);
    await ensureBodyData(b);
    const P = positions(simJD), Ra = bodyFrame(active, simJD), Rb = bodyFrame(b, simJD);
    if (continuous) {
      const ci = applyT(Ra, [camPos.x, camPos.y, camPos.z]);
      const rel = [ci[0] + P[active][0] - P[b][0], ci[1] + P[active][1] - P[b][1], ci[2] + P[active][2] - P[b][2]];
      const c = apply(Rb, rel), v = apply(Rb, applyT(Ra, [player.vel.x, player.vel.y, player.vel.z]));
      const h = apply(Rb, applyT(Ra, [player.heading.x, player.heading.y, player.heading.z]));
      camPos.set(...c); player.vel.set(...v); player.heading.set(...h);
    }
    for (const r of roots) dispose(r);
    active = b;
    setRadius(BODY_RADIUS[b]);
    applyAtmo(b);
    roots = [0, 1, 2, 3, 4, 5].map((f) => new Node(f, 0, -1, -1, 2));
    camR = camPos.length();
    updateSun();
    grace = 4;
    ui.toast(BODIES[b].name);
  } finally { switching = false; }
}

// pick the terrain body whose surface we are closest to, relative to its size
function checkBodySwitch() {
  if (switching) return;
  const ra = camR / R;
  let best = null, br = Infinity;
  for (const b of ['earth', 'moon', 'mars']) {
    if (b === active) continue;
    const o = space.bodies[b];
    const r = o.cam.length() / o.r;
    if (r < br) { br = r; best = b; }
  }
  if (best && br < 0.6 * ra && br < 60) switchBody(best, true);
}

async function goToBody(p) {
  await switchBody(p.body, false);
  for (let i = 0; i < 2; i++) { if (p.look) lookAtPlace(p.lat, p.lon, p.look); else setView(p.lat, p.lon, p.alt, p.head || 0, p.pitch ?? -0.15); }
  camR = camPos.length(); camUp.copy(camPos).divideScalar(camR);
  if (p.hour !== undefined) setHour(p.hour);
  ui.toast(p.name);
}
// place the camera at an inertial position looking at another, from the nearest terrain body's frame
async function goToSpace(p) {
  const P = positions(simJD);
  const north = [0, -Math.sin(23.44 * Math.PI / 180), Math.cos(23.44 * Math.PI / 180)];   // ecliptic north
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const add = (a, b, k = 1) => a.map((x, i) => x + b[i] * k);
  let pos, look;
  const toSun = (b) => norm(P[b].map((x, i) => P.sun[i] - x));
  if (p.space === 'system') { pos = add(add(P.sun, north, 9 * AU), norm(P.earth), 3 * AU); look = P.sun; }
  else if (p.space === 'sun') { pos = add(P.sun, norm(P.earth), 3.5e9); look = P.sun; }
  else if (p.space === 'earth') { pos = add(add(P.earth, toSun('earth'), 2.6e7), north, 6e6); look = P.earth; }
  else { const b = BODIES[p.space]; pos = add(add(P[p.space], norm(add(toSun(p.space), north, 0.25)), b.r * 7), north, b.r * 2.2); look = P[p.space]; }
  await switchBody('earth', false);
  const Ra = bodyFrame(active, simJD);
  const c = apply(Ra, pos.map((x, i) => x - P.earth[i]));
  camPos.set(...c);
  camR = camPos.length(); camUp.copy(camPos).divideScalar(camR);
  const d = new THREE.Vector3(...apply(Ra, look.map((x, i) => x - pos[i]))).normalize();
  player.heading.copy(d).addScaledVector(camUp, -d.dot(camUp)).normalize();
  player.pitch = Math.asin(Math.max(-1, Math.min(1, d.dot(camUp))));
  player.vel.set(0, 0, 0);
  grace = 4;
  ui.toast(p.name);
}
// frame a place: stand back to the south and look at it
function lookAtPlace(lat, lon, range) {
  const d = latLonToDir(lat, lon);
  const t = new THREE.Vector3(d[0], d[1], d[2]);
  const e = new THREE.Vector3(), nn = new THREE.Vector3();
  localFrame(t, e, nn);
  const back = range * 1.3, height = range * 0.55;
  const c = t.clone().addScaledVector(nn, -back / R).normalize();
  setView(Math.asin(c.y) * 180 / Math.PI, Math.atan2(-c.z, c.x) * 180 / Math.PI, height, 0, -Math.atan2(height, back));
}
function toOrbit() {
  const dir = camPos.clone().normalize();
  camPos.copy(dir).multiplyScalar(R * 2.9);
  player.pitch = -1.5;
  player.vel.set(0, 0, 0);
  ui.toast(`Orbite · ${Math.round(R * 1.9 / 1000).toLocaleString('fr-FR')} km`);
}
// sun direction in the active body's frame, from the ephemerides at simJD
function updateSun() {
  const P = positions(simJD), Ra = bodyFrame(active, simJD);
  const s = apply(Ra, [P.sun[0] - P[active][0], P.sun[1] - P[active][1], P.sun[2] - P[active][2]]);
  U.uSun.value.set(s[0], s[1], s[2]).normalize();
}
const camLonDeg = () => Math.atan2(-camUp.z, camUp.x) * 180 / Math.PI;
function getHour() {
  const s = U.uSun.value, lonS = Math.atan2(-s.z, s.x) * 180 / Math.PI;
  return (((12 + (camLonDeg() - lonS) / 15) % 24) + 24) % 24;
}
// local solar time on the body we stand on; moving it moves the real clock (and the planets with it)
function setHour(h) {
  for (let it = 0; it < 3; it++) {
    let d = h - getHour();
    d = ((d + 12) % 24 + 24) % 24 - 12;
    simJD += d / 24 * DAYLEN[active];
    updateSun();
  }
}

function setMode(m) {
  player.mode = m;
  player.vv = 0;
  ui.toast(m === 'fly' ? 'Vol' : 'Course');
}
function changeSpeed(f) {
  player.speedMul = Math.max(0.02, Math.min(50, player.speedMul * f));
}

// ------------------------------------------------------------------ input
const lockPointer = () => { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* embedded previews refuse pointer lock */ } };
canvas.addEventListener('click', () => { lockPointer(); startAudio(); ui.dismissBoot(); });
document.addEventListener('pointerlockchange', () => ui.setLocked(document.pointerLockElement === canvas));
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas && !(e.buttons & 1 && e.target === canvas)) return;   // drag to look without pointer lock
  const s = 0.0022 * (camera.fov / 70);
  player.heading.applyAxisAngle(camUp, -e.movementX * s);
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * s));
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => { if (e.button === 2) fireMissile(); });
canvas.addEventListener('wheel', (e) => { changeSpeed(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: true });
const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyF') setMode(player.mode === 'fly' ? 'run' : 'fly');
  const p = PLACES.find((q) => q.key === e.code);
  if (p) { if (active === 'earth') goTo(p); else goToBody({ ...p, body: 'earth' }); }
  if (e.code === 'Digit0') toOrbit();
  if (e.code === 'KeyH' || e.code === 'Tab') ui.toggleSheet();
  if (e.code === 'KeyP') ui.togglePhoto();
  if (e.code === 'KeyX') fireMissile();
  if (e.code === 'KeyV') setWeapon(weapon === 'missile' ? 'asteroid' : 'missile');
  if (e.code === 'KeyM') { cfg.sound = !cfg.sound; saveCfg(); if (cfg.sound) startAudio(); ui.syncCfg(); ui.toast(cfg.sound ? 'Son activé' : 'Son coupé'); }
  if (e.code === 'Slash' || e.code === 'KeyK') { document.exitPointerLock?.(); ui.focusSearch(); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const k = (c) => (keys.has(c) ? 1 : 0);

// ------------------------------------------------------------------ movement
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), tv = new THREE.Vector3();
let surfH = 0, groundH = 0, lastMach = 0, boomCooldown = 0;
const MACH_TIERS = [1, 3, 10];
const airDensity = () => (ATMO[active].air ? Math.exp(-Math.max(0, camR - R) / ATMO[active].air) * (active === 'mars' ? 0.6 : 1) : 0);

function updatePlayer(dt) {
  camR = camPos.length();
  camUp.copy(camPos).divideScalar(camR);
  player.heading.addScaledVector(camUp, -player.heading.dot(camUp)).normalize();
  right.crossVectors(player.heading, camUp).normalize();
  fwd.copy(player.heading).multiplyScalar(Math.cos(player.pitch)).addScaledVector(camUp, Math.sin(player.pitch));

  groundH = groundAt(camUp);
  const surface = surfaceAt(camUp, groundH);   // on top of the water, but down into craters
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const fb = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
  const lr = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');

  if (player.mode === 'fly') {
    const ud = k('Space') + k('KeyE') - k('KeyC') - k('KeyQ');
    tv.set(0, 0, 0).addScaledVector(fwd, fb).addScaledVector(right, lr).addScaledVector(camUp, ud);
    const near = space.nearest(active);
    const base = Math.min(3e11, Math.max(25, Math.min(camR - R - surface, near.dist) * 0.6));
    const speed = base * player.speedMul * (boost ? 8 : 1);
    if (tv.lengthSq() > 0) tv.normalize().multiplyScalar(speed);
    player.vel.lerp(tv, 1 - Math.exp(-dt * 2.5));
    camPos.addScaledVector(player.vel, dt);
  } else {
    const runSpeed = (boost ? 340 : 28) * player.speedMul;
    tv.set(0, 0, 0).addScaledVector(player.heading, fb).addScaledVector(right, lr);
    if (tv.lengthSq() > 0) tv.normalize().multiplyScalar(runSpeed);
    const hv = player.vel.clone().addScaledVector(camUp, -player.vel.dot(camUp));
    hv.lerp(tv, 1 - Math.exp(-dt * (player.grounded ? 6 : 1.2)));
    if (player.grounded && keys.has('Space')) { player.vv = boost ? 140 : 22; player.grounded = false; }
    player.vv -= 22 * dt;
    player.vel.copy(hv).addScaledVector(camUp, player.vv);
    camPos.addScaledVector(player.vel, dt);
  }

  // collision with ground / sea surface
  camR = camPos.length();
  camUp.copy(camPos).divideScalar(camR);
  groundH = groundAt(camUp);
  const surf = surfaceAt(camUp, groundH);
  surfH = surf;
  const eye = player.mode === 'run' ? 1.8 : 1.5;
  const minR = R + surf + eye;
  if (player.mode === 'run') {
    if (camR <= minR + (player.grounded ? 0.6 : 0)) {
      if (!player.grounded && player.vv < -35) { shake = Math.min(1, -player.vv / 120); thud(); }
      camPos.multiplyScalar(minR / camR);
      player.grounded = true;
      player.vv = 0;
    } else player.grounded = false;
  } else if (camR < minR) {
    camPos.multiplyScalar(minR / camR);
    const vn = player.vel.dot(camUp);
    if (vn < 0) player.vel.addScaledVector(camUp, -vn);
  }
  // other planets are solid too
  const nb = space.nearest(active);
  if (nb.body && nb.dist < 30 && !nb.body.terrain) {
    const out = nb.body.cam.clone().negate().normalize();
    camPos.addScaledVector(out, 30 - nb.dist);
    const vn = player.vel.dot(out);
    if (vn < 0) player.vel.addScaledVector(out, -vn);
  }
  camR = camPos.length();
  camUp.copy(camPos).divideScalar(camR);

  // sonic booms only where they make sense: dense air, close to the ground, and you pushing for it.
  // High-altitude cruising, space travel and arrivals after a jump stay quiet.
  const spd = player.vel.length();
  const A = ATMO[active];
  const mach = spd / A.sound;
  const pushing = fb !== 0 || lr !== 0 || boost;
  grace -= dt; boomCooldown -= dt;
  if (airDensity() > 0.35 && camR - R - surf < 6000 && pushing && grace <= 0 && boomCooldown <= 0) {
    let hit = -1;
    MACH_TIERS.forEach((m, i) => { if (lastMach < m && mach >= m) hit = i; });
    if (hit >= 0) { boom(hit, MACH_TIERS[hit]); boomCooldown = 6; }
  }
  lastMach = mach;

  // camera: stays at the origin (floating origin), only rotates
  player.heading.addScaledVector(camUp, -player.heading.dot(camUp)).normalize();
  fwd.copy(player.heading).multiplyScalar(Math.cos(player.pitch)).addScaledVector(camUp, Math.sin(player.pitch));
  camera.position.set(0, 0, 0);
  camera.up.copy(camUp);
  camera.lookAt(fwd);
  shake *= Math.exp(-dt * 3.5);
  const hs = shake + Math.min(0.15, Math.max(0, spd - 300) / 4000) * (camR - R < 3000 ? airDensity() : 0);
  if (hs > 0.002) { camera.rotateX((Math.random() - 0.5) * hs * 0.03); camera.rotateY((Math.random() - 0.5) * hs * 0.03); }
  const fov = 70 + Math.min(18, Math.log10(1 + spd / 50) * 8);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();

  if (active === 'earth' && waveAnchor.distanceTo(camUp) * R > 500e3 && camR - R > 3000) buildWaves(camUp);
}

// ------------------------------------------------------------------ wind streaks
const NSTREAK = 450, BOX = 70;
const sPos = new Float32Array(NSTREAK * 3);
for (let i = 0; i < sPos.length; i++) sPos[i] = (Math.random() * 2 - 1) * BOX;
const sGeo = new THREE.BufferGeometry();
const sVerts = new Float32Array(NSTREAK * 6);
const sA = new Float32Array(NSTREAK * 2);
sGeo.setAttribute('position', new THREE.BufferAttribute(sVerts, 3));
sGeo.setAttribute('aA', new THREE.BufferAttribute(sA, 1));
const sMat = new THREE.ShaderMaterial({
  vertexShader: SH.streakVS, fragmentShader: SH.streakFS, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  uniforms: { uOpacity: { value: 0.3 }, uTint: { value: new THREE.Color(1.6, 1.7, 1.9) } },
});
const streaks = new THREE.LineSegments(sGeo, sMat);
streaks.frustumCulled = false;
streaks.renderOrder = 2;
scene.add(streaks);
const wind = new THREE.Vector3(), rel = new THREE.Vector3();

function updateStreaks(dt) {
  rel.copy(wind).sub(player.vel);
  const rl = rel.length();
  const alt = camR - R - surfH;
  const vis = (1 - Math.min(1, alt / 6000)) * Math.min(1, 0.25 + rl / 60) * Math.min(1, airDensity() * 2);
  streaks.visible = vis > 0.01;
  if (!streaks.visible) return;
  sMat.uniforms.uOpacity.value = 0.35 * vis;
  const len = Math.min(35, rl * 0.06 + 0.5);
  const rn = rl > 1e-3 ? rel.clone().divideScalar(rl) : camUp;
  const stepX = rel.x * dt, stepY = rel.y * dt, stepZ = rel.z * dt;
  const B2 = BOX * 2;
  for (let i = 0; i < NSTREAK; i++) {
    let x = sPos[i * 3] + stepX, y = sPos[i * 3 + 1] + stepY, z = sPos[i * 3 + 2] + stepZ;
    x = ((x + BOX) % B2 + B2) % B2 - BOX; y = ((y + BOX) % B2 + B2) % B2 - BOX; z = ((z + BOX) % B2 + B2) % B2 - BOX;
    sPos[i * 3] = x; sPos[i * 3 + 1] = y; sPos[i * 3 + 2] = z;
    const fade = Math.max(0, 1 - Math.hypot(x, y, z) / BOX);
    sVerts[i * 6] = x; sVerts[i * 6 + 1] = y; sVerts[i * 6 + 2] = z;
    sVerts[i * 6 + 3] = x - rn.x * len; sVerts[i * 6 + 4] = y - rn.y * len; sVerts[i * 6 + 5] = z - rn.z * len;
    sA[i * 2] = fade; sA[i * 2 + 1] = 0;
  }
  sGeo.attributes.position.needsUpdate = true;
  sGeo.attributes.aA.needsUpdate = true;
}

// ------------------------------------------------------------------ audio
let audio = null;
function startAudio() {
  if (audio) return;
  try {
    const ac = new AudioContext();
    const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = 0.97 * last + 0.03 * (Math.random() * 2 - 1); d[i] = last * 4; }
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const filt = ac.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 0.7; filt.frequency.value = 400;
    const gain = ac.createGain(); gain.gain.value = 0;
    const master = ac.createGain(); master.gain.value = cfg.sound ? 1 : 0;
    src.connect(filt).connect(gain).connect(master).connect(ac.destination);
    src.start();
    const rsrc = ac.createBufferSource(); rsrc.buffer = buf; rsrc.loop = true; rsrc.playbackRate.value = 0.5;
    const rfilt = ac.createBiquadFilter(); rfilt.type = 'lowpass'; rfilt.frequency.value = 90;
    const rgain = ac.createGain(); rgain.gain.value = 0;
    rsrc.connect(rfilt).connect(rgain).connect(master);
    rsrc.start();
    audio = { ac, filt, gain, master, buf, rgain, rfilt, sfx: createSfx(ac, master) };
  } catch (e) { audio = { failed: true }; }
}
function burst(freq, dur, vol) {
  if (!audio || audio.failed) return;
  const { ac, master, buf } = audio;
  const s = ac.createBufferSource(); s.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = ac.createGain();
  const t = ac.currentTime;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random()); s.stop(t + dur);
}
function boom(tier, mach) {
  const amp = Math.min(1, 0.55 + tier * 0.12);
  shake = Math.min(1.4, 0.7 + tier * 0.15);
  shockT = 0; shockAmp = amp;
  // an N-wave arrives as two bangs a tenth of a second apart, deeper and longer the faster you go
  const f = Math.max(90, 260 - tier * 25), dur = 1.3 + tier * 0.25, vol = Math.min(4.5, 1.8 + tier * 0.45);
  burst(f, dur, vol);
  setTimeout(() => burst(f * 0.85, dur * 0.9, vol * 0.8), 110);
  burst(2400, 0.12, vol * 0.25);
  ui.flash(`BANG · Mach ${mach}`);
}
let shockT = 9, shockAmp = 0;
function thud() { burst(120, 0.5, 1.2); }
function updateAudio() {
  if (!audio || audio.failed) return;
  const air = airDensity();
  const rl = rel.length();
  const v = Math.min(1, rl / 250) * air;
  const t = audio.ac.currentTime;
  audio.master.gain.setTargetAtTime(cfg.sound ? 1 : 0, t, 0.1);
  audio.gain.gain.setTargetAtTime(0.02 * air + v * 0.5, t, 0.15);
  audio.filt.frequency.setTargetAtTime(250 + Math.min(2500, rl * 4), t, 0.2);
  const spd = player.vel.length();
  audio.rgain.gain.setTargetAtTime(Math.min(1, spd / 1200) * air * 0.9, t, 0.2);
  audio.rfilt.frequency.setTargetAtTime(60 + Math.min(240, spd / 8), t, 0.3);
}

// ------------------------------------------------------------------ solar system
const space = createSpace({ scene, renderer });

// ------------------------------------------------------------------ missiles
const weapons = createWeapons({
  scene, U, groundAt, surfaceAt, onImpact,
  atm: () => ATMO[active].atm,
  soundSpeed: () => ATMO[active].sound,
  sound: (kind, vol) => {
    const fx = audio && audio.sfx;
    if (!fx) return;
    if (kind === 'launch') fx.launch();
    else fx.blast(Math.min(1, vol * 1.4), vol * vol);
  },
  rocket: () => (audio && audio.sfx ? audio.sfx.rocket() : null),
  roar: () => (audio && audio.sfx ? audio.sfx.roar() : null),
});

// ------------------------------------------------------------------ 3D city, landmarks, shadows
const city = createCity({
  scene, U, cfg, R, groundAt, post: postCity, time: () => simT, craters: () => craters,
});

// ------------------------------------------------------------------ UI bridge
const ui = initUI({
  places: PLACES,
  space: SPACE,
  onSpace: (p) => (p.space ? goToSpace(p) : goToBody(p)),
  landmarks: LANDMARKS,
  onLandmark: async (l) => { if (active !== 'earth') await switchBody('earth', false); const m = city.marks.find((q) => q.id === l.id); lookAtPlace(l.lat, l.lon, Math.max(240, (m ? m.height : 100) * 2.3)); ui.toast(l.name); },
  cfg,
  onPlace: (p) => (active === 'earth' ? goTo(p) : goToBody({ ...p, body: 'earth' })),
  onOrbit: toOrbit,
  onMode: setMode,
  onSpeed: changeSpeed,
  onHour: setHour,
  onSearchPick: async (r) => { if (active !== 'earth') await switchBody('earth', false); lookAtPlace(r.lat, r.lon, r.alt); ui.toast(r.name); },
  onCfg: (key, value) => {
    cfg[key] = value;
    saveCfg();
    if (key === 'quality') applyQuality();
    if (key === 'sound' && value) startAudio();
  },
  onStart: () => { lockPointer(); startAudio(); },
  onFire: () => fireMissile(),
  onWeapon: () => setWeapon(weapon === 'missile' ? 'asteroid' : 'missile'),
  onClearCraters: () => clearCraters(),
});

function readout() {
  const lat = Math.asin(camUp.y) * 180 / Math.PI, lon = camLonDeg();
  const e = new THREE.Vector3(), nn = new THREE.Vector3();
  localFrame(camUp, e, nn);
  const heading = (Math.atan2(player.heading.dot(e), player.heading.dot(nn)) * 180 / Math.PI + 360) % 360;
  return {
    alt: camR - R - surfH, altSea: camR - R, speed: player.vel.length(), heading, lat, lon,
    mode: player.mode, speedMul: player.speedMul, hour: getHour(), wind: wind.length(),
    chunks: shown.length, pending: stats.pending + city.stats.pending, sound: cfg.sound, cityTiles: city.stats.tiles,
    body: BODIES[active].name, sunDist: space.bodies.sun.cam.length(), speedOfSound: ATMO[active].sound, air: airDensity(), date: new Date((simJD - 2440587.5) * 86400000),
  };
}

// ------------------------------------------------------------------ main loop
const clock = new THREE.Clock();
let simT = 0;
const cloudOff = postMat.uniforms.uCloudOff.value;

function loop() {
  requestAnimationFrame(loop);
  frame1();
}
// one simulation + render step; fixedDt lets devtools fast-forward (earth.advance)
function frame1(fixedDt) {
  const dt = fixedDt ?? Math.min(0.1, clock.getDelta()) * (window.__timeScale || 1);
  simT += dt;
  U.uTime.value = simT;

  if (keys.has('KeyT')) { simJD += dt * 0.033 * DAYLEN[active]; updateSun(); }
  if (keys.has('KeyG')) { simJD -= dt * 0.033 * DAYLEN[active]; updateSun(); }

  updatePlayer(dt);
  fireCool -= dt;
  updateTsunamis();
  const wx = weapons.update(dt, camPos);
  postMat.uniforms.uFlash.value = wx.flash;
  shake = Math.max(shake, wx.shake);
  space.update(simJD, active, camPos, camera, camR, camR - R > Math.max(150e3, R * 0.05));
  checkBodySwitch();
  updateLOD();
  windAt(camUp, simT, wind);
  updateStreaks(dt);
  updateAudio();

  const ws = wind.length();
  U.uWaveAmp.value = 0.6 + 0.5 * Math.min(1.5, ws / 10);
  U.uWindStr.value = Math.min(1.5, ws / 10);
  if (ws > 0.01) U.uWindDir.value.copy(wind).divideScalar(ws);
  cloudOff.addScaledVector(wind, dt * 0.001 * 6);

  const pu = postMat.uniforms;
  pu.uCloudCover.value = cfg.clouds && active === 'earth' ? 0.34 : 0.0;
  pu.uInvProj.value.copy(camera.projectionMatrixInverse);
  pu.uCamWorld.value.copy(camera.matrixWorld);
  pu.uCamPos.value.copy(camPos);
  pu.uCamR.value = camR;
  pu.uCamAlt.value = camR - R;
  const muCam = camUp.dot(U.uSun.value);
  // night-vision boost only on the ground of a body; in space the Sun lights everything we look at
  const nightBoost = 2.5 * (1 - THREE.MathUtils.smoothstep(muCam, -0.25, 0.1)) * (1 - THREE.MathUtils.smoothstep(camR / R, 1.5, 4));
  pu.uExposure.value = 0.7 + nightBoost;

  const altG = camR - R - surfH;
  city.update(dt, camPos, camUp, active === 'earth' ? altG : 1e9);
  const night = 1 - THREE.MathUtils.smoothstep(muCam, -0.12, 0.04);
  const nearMarks = city.updateMarks(dt, camPos, night, getHour(), active === 'earth');
  city.shadowPass(renderer, camPos, camUp, fwd, altG, nearMarks);

  // speed effects: radial blur, vapour cone at the sound barrier, expanding shock ring after a bang
  const spd = player.vel.length(), air = airDensity();
  const machNow = spd / ATMO[active].sound;
  pu.uAspect.value = innerWidth / innerHeight;
  pu.uSpeedFx.value = Math.min(1, Math.max(0, (spd - 120) / 1800)) * (0.3 + 0.7 * air);
  pu.uVapor.value = (Math.exp(-Math.pow((machNow - 1) / 0.09, 2)) + 0.25 * Math.min(1, Math.max(0, machNow - 1))) * air * (camR - R - surfH < 6000 ? 1 : 0);
  shockT += dt;
  pu.uShockT.value = shockT;
  pu.uShockAmp.value = shockAmp;

  const bs = renderer.getDrawingBufferSize(tmpV2);
  if (bs.x !== rt.width || bs.y !== rt.height) { rt.dispose(); rt = makeRT(); }
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  pu.tColor.value = rt.texture;
  pu.tDepth.value = rt.depthTexture;
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);

  ui.update(dt, readout());
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// handy from the devtools console
// devtools: drop a bomb straight on a place, e.g. earth.nuke(48.858, 2.294) or earth.nuke(lat, lon, 'asteroid')
function nuke(lat, lon, kind = 'missile') {
  const d = latLonToDir(lat, lon), dir = new THREE.Vector3(d[0], d[1], d[2]);
  const P = dir.multiplyScalar(R + surfaceAt(dir));
  if (kind === 'asteroid') { weapons.asteroid(P, camPos); return; }
  const r = onImpact(P, kind);
  weapons.explode(P, r.scale, r.water);
}
window.earth = { advance: (sec, step = 0.25) => { for (let t = 0; t < sec; t += step) frame1(step); }, tsunamis: () => tsunamis, simT: () => simT, nuke, fireMissile, clearCraters, craters: () => craters, goTo, setView, toOrbit, player, camPos, keys, PLACES, SPACE, setHour, updateSun, groundAt, lookAtPlace, switchBody, goToBody, goToSpace, active: () => active };

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    ui.status('Chargement des données terrestres…');
    const [data, color] = await Promise.all([loadPixels('data/earthdata.png'), loadPixels('data/earthcolor.jpg')]);
    setData(data.data, data.width, data.height, color.data, color.width, color.height);
    ui.status('Connexion aux cartes…');
    await initWorkers(data, color);
    sendCraters();
    city.applyCraters(craters, null, 0);
    const start = PLACES[0];
    updateSun();
    setView(start.lat, start.lon, start.alt, start.head);
    updatePlayer(0);
    setHour(16.5);
    ui.status('Chargement du relief…');
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        updatePlayer(0);
        updateLOD();
        ui.progress(Math.min(1, chunksBuilt / 140));
        if ((stats.pending === 0 && chunksBuilt > 60) || performance.now() - t0 > 12000) res();
        else setTimeout(tick, 40);
      };
      tick();
    });
    setView(start.lat, start.lon, start.alt, start.head);   // ground is known now
    ui.ready();
    loop();
  } catch (e) {
    console.error(e);
    ui.status('Erreur : ' + e.message);
  }
}
boot();
