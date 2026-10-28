// Builds one quadtree chunk from real map tiles (elevation, satellite, water/building mask),
// falling back to the procedural planet where tiles are missing (poles, offline).
import { R, NSEG, N, FACE_M, cubeToSphere, edgeIndex, terrain, groundColor, fbm, setRadius } from './terrain-core.js';
import { BODY_RADIUS, bodySample, bodyColor } from './bodies.js';
import { cratersNear, craterAt, strata } from './craters.js';
import { snoise } from './terrain-core.js';

// ---- missile craters: carve the vertex grid, then paint scorch and exposed rock layers into the texture
const co = {}, sc = new Float64Array(3);
function carve(body, face, x0, y0, size, gx, gy, gz, hh) {
  const c = new Float64Array(3);
  cubeToSphere(face, x0 + size / 2, y0 + size / 2, c);
  const near = cratersNear(body, c[0], c[1], c[2], size * Math.PI / 4 * 0.9, R);
  if (!near.length) return null;
  for (let k = 0; k < hh.length; k++) hh[k] += craterAt(near, gx[k], gy[k], gz[k], R, co);
  return near;
}
function paint(near, body, x, y, z, tex, k) {
  craterAt(near, x, y, z, R, co);
  if (co.scorch <= 0.001 && co.dh > -0.5) return;
  let r = tex[k] / 255, g = tex[k + 1] / 255, b = tex[k + 2] / 255;
  const s = co.scorch * 0.85;                                   // burnt ground and ash around the blast
  r += (0.07 - r) * s; g += (0.06 - g) * s; b += (0.05 - b) * s;
  if (co.dh < -0.5) {
    const depth = -co.dh;
    const n = snoise(x * R / 70, y * R / 70, z * R / 70);
    const glow = strata(body, depth, n, sc);
    const w = smooth(0.5, 6, depth);
    r += (sc[0] - r) * w; g += (sc[1] - g) * w; b += (sc[2] - b) * w;
    // alpha: 255 water, 2 dry crater floor (no sea drawn over it). Molten rock is told apart by its colour.
    tex[k + 3] = tex[k + 3] === 255 && co.dh > -40 ? 255 : 2;
    if (glow > 0.02) { r += (0.85 - r) * glow; g += (0.18 - g) * glow; b += (0.02 - b) * glow; }
  }
  tex[k] = r * 255; tex[k + 1] = g * 255; tex[k + 2] = b * 255;
}
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
import { ZMAX, MPP0, project, tileSet, demAt, rgbAt, baseClass } from './tiles.js';

export const TEX = 128;          // chunk texture size (satellite RGB + water mask in alpha)
export const FEAT_LEVEL = 14;    // chunks of ~600 m carry trees and buildings
const DEG = 180 / Math.PI;
const MAX_LAT = 85;

function zoomFor(metres, lat, zmax) {
  const z = Math.ceil(Math.log2(MPP0 * Math.cos(lat / DEG) / Math.max(metres, 0.05)));
  return Math.max(0, Math.min(zmax, z));
}

function unwrap(lon, valid) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < lon.length; k++) if (valid[k]) { if (lon[k] < lo) lo = lon[k]; if (lon[k] > hi) hi = lon[k]; }
  if (hi - lo > 180) for (let k = 0; k < lon.length; k++) if (lon[k] < 0) lon[k] += 360;
}

// load the tiles for these points, lowering the zoom if the area spans too many tiles
async function load(src, lat, lon, valid, z0) {
  const px = new Float64Array(lat.length), py = new Float64Array(lat.length);
  for (let z = z0; z >= 0; z--) {
    project(lat, lon, z, valid, px, py);
    const ts = await tileSet(src, z, px, py, valid);
    if (ts) return { ts, px, py };
  }
  return null;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d); s = Math.imul(s ^ (s >>> 12), 0x297a2d39); s ^= s >>> 15; return (s >>> 0) / 4294967296; };
}

export { load, unwrap, rng };

export async function buildChunk(face, x0, y0, size, level, isCancelled, body = 'earth') {
  setRadius(BODY_RADIUS[body]);
  if (body !== 'earth') return buildBodyChunk(face, x0, y0, size, body);
  const r = await buildEarthChunk(face, x0, y0, size, level, isCancelled);
  return r;
}

// Moon and Mars: everything is generated locally, no network
function buildBodyChunk(face, x0, y0, size, body) {
  const step = size / NSEG, spacing = step * FACE_M, minWL = spacing * 2;
  const M = N + 2, MM = M * M;
  const d = new Float64Array(3), o = {};
  const gx = new Float64Array(MM), gy = new Float64Array(MM), gz = new Float64Array(MM), hh = new Float64Array(MM);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const k = j * M + i;
    cubeToSphere(face, x0 + (i - 1) * step, y0 + (j - 1) * step, d);
    gx[k] = d[0]; gy[k] = d[1]; gz[k] = d[2];
    hh[k] = bodySample(body, d[0], d[1], d[2], minWL, o);
  }
  const near = carve(body, face, x0, y0, size, gx, gy, gz, hh);
  const geo = meshFromGrid(face, x0, y0, size, gx, gy, gz, hh, spacing, false);
  // texture: mosaic colour, brightened on fresh crater rims, with fine grain below the mosaic resolution
  const T = TEX, tex = new Uint8Array(T * T * 4), c = new Float64Array(3);
  const texelM = size * FACE_M / (T - 1);
  for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
    cubeToSphere(face, x0 + size * i / (T - 1), y0 + size * j / (T - 1), d);
    bodySample(body, d[0], d[1], d[2], texelM * 2, o);
    bodyColor(body, o.lon, o.lat, c);
    const grain = 1 + 0.18 * fbm(d[0] + 5, d[1], d[2], R / 20000, texelM * 2, 10, 0.55);
    const k = (j * T + i) * 4, b = (1 + Math.min(0.6, o.alb || 0)) * grain;
    tex[k] = Math.min(255, c[0] * 255 * b); tex[k + 1] = Math.min(255, c[1] * 255 * b); tex[k + 2] = Math.min(255, c[2] * 255 * b); tex[k + 3] = 0;
    if (near) paint(near, body, d[0], d[1], d[2], tex, k);
  }
  return { ...geo, opos: null, tex, bld: null, trees: null, demZ: -1 };
}

async function buildEarthChunk(face, x0, y0, size, level, isCancelled) {
  const step = size / NSEG;
  const spacing = step * FACE_M;
  const minWL = spacing * 2;
  const M = N + 2, MM = M * M;
  const d = new Float64Array(3), o = {};

  // ---------------------------------------------------------------- vertex grid (with border for normals)
  const gx = new Float64Array(MM), gy = new Float64Array(MM), gz = new Float64Array(MM);
  const lat = new Float64Array(MM), lon = new Float64Array(MM), valid = new Uint8Array(MM);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const k = j * M + i;
    cubeToSphere(face, x0 + (i - 1) * step, y0 + (j - 1) * step, d);
    gx[k] = d[0]; gy[k] = d[1]; gz[k] = d[2];
    lat[k] = Math.asin(Math.max(-1, Math.min(1, d[1]))) * DEG;
    lon[k] = Math.atan2(-d[2], d[0]) * DEG;
    valid[k] = Math.abs(lat[k]) < MAX_LAT ? 1 : 0;
  }
  unwrap(lon, valid);
  const latC = lat[(M >> 1) * M + (M >> 1)];

  const dem = await load('dem', lat, lon, valid, zoomFor(spacing, latC, ZMAX.dem));
  setRadius(BODY_RADIUS.earth);
  if (isCancelled()) return null;
  const pix = dem ? MPP0 * Math.cos(latC / DEG) / 2 ** dem.ts.z : 0;
  const hh = new Float64Array(MM);
  for (let k = 0; k < MM; k++) {
    let h = valid[k] && dem ? demAt(dem.ts, dem.px[k], dem.py[k]) : NaN;
    if (Number.isNaN(h)) h = terrain(gx[k], gy[k], gz[k], minWL, o);
    else if (pix > spacing * 0.5) h += fbm(gx[k], gy[k], gz[k], R / (pix * 2), minWL, 8, 0.5) * pix * 0.1 * Math.min(1, Math.abs(h) / 6); // sub-pixel detail, none at the shoreline
    hh[k] = h;
  }
  const near = carve('earth', face, x0, y0, size, gx, gy, gz, hh);

  const { pos, nrm, uv, hv, opos, cx, cy, cz, minH, maxH } = meshFromGrid(face, x0, y0, size, gx, gy, gz, hh, spacing, true);

  // ---------------------------------------------------------------- texture: satellite colour + water mask
  const T = TEX, TT = T * T;
  const tlat = new Float64Array(TT), tlon = new Float64Array(TT), tval = new Uint8Array(TT);
  const tdx = new Float64Array(TT), tdy = new Float64Array(TT), tdz = new Float64Array(TT);
  for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
    const k = j * T + i;
    cubeToSphere(face, x0 + size * i / (T - 1), y0 + size * j / (T - 1), d);
    tdx[k] = d[0]; tdy[k] = d[1]; tdz[k] = d[2];
    tlat[k] = Math.asin(Math.max(-1, Math.min(1, d[1]))) * DEG;
    tlon[k] = Math.atan2(-d[2], d[0]) * DEG;
    tval[k] = Math.abs(tlat[k]) < MAX_LAT ? 1 : 0;
  }
  unwrap(tlon, tval);
  const texelM = size * FACE_M / (T - 1);
  const zi = zoomFor(texelM, latC, ZMAX.img);
  const [img, base] = await Promise.all([
    load('img', tlat, tlon, tval, zi),
    load('base', tlat, tlon, tval, Math.min(zi, ZMAX.base)),
  ]);
  setRadius(BODY_RADIUS.earth);
  if (isCancelled()) return null;

  const tex = new Uint8Array(TT * 4);
  const rgb = new Float64Array(3);
  for (let k = 0; k < TT; k++) {
    let ok = tval[k] && img && rgbAt(img.ts, img.px[k], img.py[k], rgb);
    if (!ok) {   // procedural fallback colour
      terrain(tdx[k], tdy[k], tdz[k], texelM * 2, o);
      groundColor(tdx[k], tdy[k], tdz[k], o, texelM * 2, rgb);
      for (let q = 0; q < 3; q++) rgb[q] = 255 * Math.pow(Math.min(1, rgb[q]), 1 / 2.2);   // linear -> sRGB
    }
    tex[k * 4] = rgb[0]; tex[k * 4 + 1] = rgb[1]; tex[k * 4 + 2] = rgb[2];
    const cls = tval[k] && base ? baseClass(base.ts, base.px[k], base.py[k]) : 0;
    tex[k * 4 + 3] = cls === 2 ? 255 : 0;
    if (near) paint(near, 'earth', tdx[k], tdy[k], tdz[k], tex, k * 4);
  }

  // trees and buildings now come from OpenStreetMap vector tiles (city.js)
  const bld = null, trees = null;

  return { pos, nrm, uv, hv, opos, tex, cx, cy, cz, minH, maxH, bld, trees, demZ: dem ? dem.ts.z : -1 };
}

// positions relative to the chunk centre, normals from the bordered grid, skirts, optional sea-level surface
function meshFromGrid(face, x0, y0, size, gx, gy, gz, hh, spacing, withOcean) {
  const M = N + 2;
  const d = new Float64Array(3);
  const nv = N * N + 4 * N;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), hv = new Float32Array(nv);
  cubeToSphere(face, x0 + size / 2, y0 + size / 2, d);
  const cx = d[0] * R, cy = d[1] * R, cz = d[2] * R;
  let minH = 1e9, maxH = -1e9;
  const P = (k, out) => { const r = R + hh[k]; out[0] = gx[k] * r; out[1] = gy[k] * r; out[2] = gz[k] * r; };
  const a = new Float64Array(3), b = new Float64Array(3), c = new Float64Array(3), e = new Float64Array(3);
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
    const k = j * M + i, g = (j - 1) * N + (i - 1);
    P(k + 1, a); P(k - 1, b); P(k + M, c); P(k - M, e);
    const ax = a[0] - b[0], ay = a[1] - b[1], az = a[2] - b[2];
    const bx = c[0] - e[0], by = c[1] - e[1], bz = c[2] - e[2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.hypot(nx, ny, nz) || 1;
    nrm[g * 3] = nx / l; nrm[g * 3 + 1] = ny / l; nrm[g * 3 + 2] = nz / l;
    P(k, a);
    pos[g * 3] = a[0] - cx; pos[g * 3 + 1] = a[1] - cy; pos[g * 3 + 2] = a[2] - cz;
    uv[g * 2] = ((i - 1) / NSEG * (TEX - 1) + 0.5) / TEX;
    uv[g * 2 + 1] = ((j - 1) / NSEG * (TEX - 1) + 0.5) / TEX;
    hv[g] = hh[k];
    if (hh[k] < minH) minH = hh[k];
    if (hh[k] > maxH) maxH = hh[k];
  }
  const sk = spacing * 3 + 2;
  const gd = (g, comp) => { const j = Math.floor(g / N) + 1, i = (g % N) + 1; const k = j * M + i; return comp === 0 ? gx[k] : comp === 1 ? gy[k] : gz[k]; };
  for (let ed = 0; ed < 4; ed++) for (let k = 0; k < N; k++) {
    const g = edgeIndex(ed, k), s = N * N + ed * N + k;
    for (let q = 0; q < 3; q++) { pos[s * 3 + q] = pos[g * 3 + q] - gd(g, q) * sk; nrm[s * 3 + q] = nrm[g * 3 + q]; }
    uv[s * 2] = uv[g * 2]; uv[s * 2 + 1] = uv[g * 2 + 1];
    hv[s] = hv[g];
  }
  let opos = null;
  if (withOcean && minH < 40) {   // a sea surface over low coasts too, so tsunamis can flood them
    opos = new Float32Array(nv * 3);
    for (let g = 0; g < N * N; g++) for (let q = 0; q < 3; q++) opos[g * 3 + q] = gd(g, q) * R - (q === 0 ? cx : q === 1 ? cy : cz);
    for (let ed = 0; ed < 4; ed++) for (let k = 0; k < N; k++) {
      const g = edgeIndex(ed, k), s = N * N + ed * N + k;
      for (let q = 0; q < 3; q++) opos[s * 3 + q] = gd(g, q) * (R - sk) - (q === 0 ? cx : q === 1 ? cy : cz);
    }
  }

  return { pos, nrm, uv, hv, opos, cx, cy, cz, minH, maxH };
}
