// Shared terrain generator: used by the workers (mesh building) and the main
// thread (ground collision). Pure JS doubles, no three.js dependency.

// Radius of the body being generated (Earth, Moon, Mars). Live bindings: importers see setRadius() changes.
export let R = 6371000;              // metres (scale 1:1)
export const NSEG = 32;              // quads per chunk side
export const N = NSEG + 1;           // vertices per chunk side
export let FACE_M = Math.PI * R / 4; // metres per cube-face unit (face spans [-1,1])
export function setRadius(r) { R = r; FACE_M = Math.PI * r / 4; }

// ---------------------------------------------------------------- cube sphere
export const FACES = [
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
];

export function cubeToSphere(face, a, b, out) {
  const F = FACES[face];
  const x = F.n[0] + a * F.r[0] + b * F.u[0];
  const y = F.n[1] + a * F.r[1] + b * F.u[1];
  const z = F.n[2] + a * F.r[2] + b * F.u[2];
  const x2 = x * x, y2 = y * y, z2 = z * z;
  let sx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + y2 * z2 / 3));
  let sy = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + z2 * x2 / 3));
  let sz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + x2 * y2 / 3));
  const l = Math.hypot(sx, sy, sz);
  out[0] = sx / l; out[1] = sy / l; out[2] = sz / l;
  return out;
}

// grid index of vertex k along chunk edge e (0 bottom, 1 top, 2 left, 3 right)
export function edgeIndex(e, k) {
  if (e === 0) return k;
  if (e === 1) return (N - 1) * N + k;
  if (e === 2) return k * N;
  return k * N + N - 1;
}

export function latLonToDir(latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}

// ---------------------------------------------------------------- simplex noise
const grad3 = new Float64Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1,
  1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);
const perm = new Uint8Array(512);
const pm12 = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
}
const F3 = 1 / 3, G3 = 1 / 6;

export function snoise(x, y, z) {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  let n = 0, tt, g;
  tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (tt > 0) { g = pm12[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x0 + grad3[g + 1] * y0 + grad3[g + 2] * z0); }
  tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x1 + grad3[g + 1] * y1 + grad3[g + 2] * z1); }
  tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (tt > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x2 + grad3[g + 1] * y2 + grad3[g + 2] * z2); }
  tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (grad3[g] * x3 + grad3[g + 1] * y3 + grad3[g + 2] * z3); }
  return 32 * n;
}

// Number of octaves worth evaluating: stop once the wavelength drops below minWL.
// `freq` is per planet radius, so octave 0 wavelength ~ R / freq metres.
function octs(freq, minWL, maxOct) {
  const n = Math.log2(R / freq / minWL) + 1;
  return n > maxOct ? maxOct : n;
}

export function fbm(x, y, z, freq, minWL, maxOct, gain) {
  const n = octs(freq, minWL, maxOct);
  if (n <= 0) return 0;
  let norm = 0, a = 1;
  for (let o = 0; o < maxOct; o++) { norm += a; a *= gain; }
  let sum = 0, amp = 1, f = freq;
  for (let o = 0; o < n; o++) {
    const w = n - o >= 1 ? 1 : n - o;
    sum += amp * w * snoise(x * f + o * 19.1, y * f - o * 7.3, z * f + o * 11.7);
    amp *= gain; f *= 2;
  }
  return sum / norm;
}

export function ridged(x, y, z, freq, minWL, maxOct) {
  const n = octs(freq, minWL, maxOct);
  if (n <= 0) return 0;
  let sum = 0, amp = 0.5, f = freq, w = 1;
  for (let o = 0; o < n; o++) {
    const k = n - o >= 1 ? 1 : n - o;
    let v = 1 - Math.abs(snoise(x * f + o * 5.3, y * f + o * 9.1, z * f - o * 3.7));
    v *= v; v *= w;
    w = v * 2; if (w > 1) w = 1;
    sum += v * amp * k;
    amp *= 0.5; f *= 2;
  }
  return sum;
}

const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- Earth data
// data: RGBA bytes, R = land mask, G = sqrt(elevation), B = ruggedness
// color: RGBA bytes, Blue Marble style surface colour
let D = null, DW = 0, DH = 0, C = null, CW = 0, CH = 0;
export function setData(d, dw, dh, c, cw, ch) { D = d; DW = dw; DH = dh; C = c; CW = cw; CH = ch; }

function bspline(t, w) { // cubic B-spline weights
  const it = 1 - t, t2 = t * t, t3 = t2 * t;
  w[0] = it * it * it / 6;
  w[1] = (3 * t3 - 6 * t2 + 4) / 6;
  w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  w[3] = t3 / 6;
}
const wx = new Float64Array(4), wy = new Float64Array(4);
function sampleData(lon, lat, out) {
  const u = (lon / Math.PI + 1) * 0.5 * DW - 0.5;
  let v = (0.5 - lat / Math.PI) * DH - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  bspline(u - x0, wx); bspline(v - y0, wy);
  let a = 0, b = 0, c = 0;
  for (let j = 0; j < 4; j++) {
    let yy = y0 - 1 + j; yy = yy < 0 ? 0 : yy >= DH ? DH - 1 : yy;
    for (let i = 0; i < 4; i++) {
      const xx = (((x0 - 1 + i) % DW) + DW) % DW;
      const k = (yy * DW + xx) * 4, w = wx[i] * wy[j];
      a += D[k] * w; b += D[k + 1] * w; c += D[k + 2] * w;
    }
  }
  out[0] = a / 255; out[1] = b / 255; out[2] = c / 255;
}
export function sampleColor(lon, lat, out) {
  const u = (lon / Math.PI + 1) * 0.5 * CW - 0.5;
  let v = (0.5 - lat / Math.PI) * CH - 0.5;
  v = v < 0 ? 0 : v > CH - 1.001 ? CH - 1.001 : v;
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const xa = ((x0 % CW) + CW) % CW, xb = (xa + 1) % CW, yb = Math.min(y0 + 1, CH - 1);
  for (let c = 0; c < 3; c++) {
    const p00 = C[(y0 * CW + xa) * 4 + c], p10 = C[(y0 * CW + xb) * 4 + c];
    const p01 = C[(yb * CW + xa) * 4 + c], p11 = C[(yb * CW + xb) * 4 + c];
    out[c] = ((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy) / 255;
  }
}

// ---------------------------------------------------------------- terrain
// (x,y,z) unit direction. minWL: smallest wavelength worth computing (metres).
// Fills o.h (metres above sea level) and a few biome helpers.
const tmp = new Float64Array(3);
export function terrain(x, y, z, minWL, o) {
  const lat = Math.asin(y > 1 ? 1 : y < -1 ? -1 : y);
  const lon = Math.atan2(-z, x);
  // domain warp hides the 39 km/pixel grid of the source data
  const wxn = fbm(x, y, z, 120, minWL, 3, 0.5);
  const wyn = fbm(y + 3.1, z - 1.3, x, 120, minWL, 3, 0.5);
  sampleData(lon + wxn * 0.003 / Math.max(0.15, Math.cos(lat)), lat + wyn * 0.003, tmp);
  const land = tmp[0], E = tmp[1] * tmp[1], rug = tmp[2];

  const cn = fbm(x, y, z, 25, minWL, 7, 0.55);
  const s = land - 0.5 + 0.3 * cn;               // signed "continent" field
  const landF = smooth(0, 0.3, s);
  const mm = smooth(0.12, 0.6, rug + 0.3 * fbm(x + 7.7, y, z, 10, minWL, 3, 0.5)); // mountain mask
  let h;
  if (s >= 0) {
    const hReal = 6000 * Math.pow(E, 1.8);
    const r = ridged(x, y, z, 70, minWL, 13);
    const hills = fbm(x + 1.7, y, z - 2.1, 220, minWL, 14, 0.5);
    // valleys cut into the plateau, sharp ridged peaks above it
    const peaks = Math.pow(r, 1.6) * 5200 * mm;
    h = s * 150 + (hReal * (0.55 + 0.25 * (1 - mm)) + peaks + hills * (60 + 500 * rug)) * landF;
  } else {
    const d = -s;
    h = -(smooth(0, 0.1, d) * 140 + smooth(0.08, 0.45, d) * 4300) + cn * 300 * smooth(0.1, 0.4, d);
  }
  const det = fbm(x - 2.3, y + 1.1, z, 2500, minWL, 12, 0.52);
  h += det * (2.5 + 35 * rug + 80 * mm * landF);

  // inland lakes (lowlands only)
  if (s > 0.05) {
    const ln = fbm(x + 5, y - 3, z + 1, 350, minWL, 4, 0.5);
    const lm = smooth(0.3, 0.38, ln) * (1 - smooth(0.15, 0.35, rug)) * (1 - smooth(100, 450, h)) * smooth(0.05, 0.15, s);
    if (lm > 0) h = h * (1 - lm) + (-12 - 60 * (ln - 0.3)) * lm;
  }

  o.h = h; o.lat = lat; o.lon = lon; o.rug = rug; o.mm = mm; o.landF = landF; o.det = det;
  return h;
}

// ground colour (linear RGB) without rock/snow: those are done per pixel in the shader
const col = new Float64Array(3);
export function groundColor(x, y, z, o, minWL, out) {
  sampleColor(o.lon, o.lat, col);
  let r = Math.pow(col[0], 2.2) * 1.3, g = Math.pow(col[1], 2.2) * 1.3, b = Math.pow(col[2], 2.2) * 1.3;
  const lum = 0.3 * r + 0.55 * g + 0.15 * b;   // the source imagery is a bit washed out
  r = lum + (r - lum) * 1.6; g = lum + (g - lum) * 1.6; b = Math.max(0.005, lum + (b - lum) * 1.3);
  r = Math.max(0.005, r); g = Math.max(0.005, g);
  // where the source texture is ocean but we generated land, use a lowland default
  const tl = smooth(0.15, 0.6, o.landF);
  r = r * tl + 0.075 * (1 - tl); g = g * tl + 0.085 * (1 - tl); b = b * tl + 0.04 * (1 - tl);
  const v = fbm(x + 9.1, y, z, 1200, minWL, 7, 0.55);
  const k = 0.8 + 0.6 * v;
  r *= k; g *= k * (1 + 0.15 * v); b *= k;
  const h = o.h;
  // beaches
  const beach = 1 - smooth(1.5, 5, h + 3 * v - 40 * o.rug * 0);
  if (beach > 0) { r += (0.42 - r) * beach; g += (0.36 - g) * beach; b += (0.22 - b) * beach; }
  if (h < 0) { // sea bed
    const d = smooth(0, 80, -h);
    r = 0.36 * (1 - d) + 0.04 * d; g = 0.32 * (1 - d) + 0.06 * d; b = 0.2 * (1 - d) + 0.05 * d;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

// ---------------------------------------------------------------- chunk mesh
export function buildChunk(face, x0, y0, size) {
  const step = size / NSEG;
  const spacing = step * FACE_M;
  const minWL = spacing * 2;
  const M = N + 2;
  const px = new Float64Array(M * M), py = new Float64Array(M * M), pz = new Float64Array(M * M);
  const dx = new Float64Array(N * N), dy = new Float64Array(N * N), dz = new Float64Array(N * N);
  const nv = N * N + 4 * N;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  const colr = new Uint8Array(nv * 3), hv = new Float32Array(nv);
  const d = new Float64Array(3), gc = new Float64Array(3), o = {};

  cubeToSphere(face, x0 + size / 2, y0 + size / 2, d);
  const cx = d[0] * R, cy = d[1] * R, cz = d[2] * R;
  let minH = 1e9, maxH = -1e9;

  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      cubeToSphere(face, x0 + (i - 1) * step, y0 + (j - 1) * step, d);
      terrain(d[0], d[1], d[2], minWL, o);
      const r = R + o.h, k = j * M + i;
      px[k] = d[0] * r; py[k] = d[1] * r; pz[k] = d[2] * r;
      if (i >= 1 && i <= N && j >= 1 && j <= N) {
        const g = (j - 1) * N + (i - 1);
        dx[g] = d[0]; dy[g] = d[1]; dz[g] = d[2];
        hv[g] = o.h;
        if (o.h < minH) minH = o.h;
        if (o.h > maxH) maxH = o.h;
        groundColor(d[0], d[1], d[2], o, minWL, gc);
        colr[g * 3] = Math.min(255, Math.sqrt(gc[0]) * 255);
        colr[g * 3 + 1] = Math.min(255, Math.sqrt(gc[1]) * 255);
        colr[g * 3 + 2] = Math.min(255, Math.sqrt(gc[2]) * 255);
      }
    }
  }
  for (let j = 1; j <= N; j++) {
    for (let i = 1; i <= N; i++) {
      const k = j * M + i, g = (j - 1) * N + (i - 1);
      const ax = px[k + 1] - px[k - 1], ay = py[k + 1] - py[k - 1], az = pz[k + 1] - pz[k - 1];
      const bx = px[k + M] - px[k - M], by = py[k + M] - py[k - M], bz = pz[k + M] - pz[k - M];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[g * 3] = nx / l; nrm[g * 3 + 1] = ny / l; nrm[g * 3 + 2] = nz / l;
      pos[g * 3] = px[k] - cx; pos[g * 3 + 1] = py[k] - cy; pos[g * 3 + 2] = pz[k] - cz;
    }
  }
  // skirts hide cracks between LOD levels
  const sk = spacing * 3 + 2;
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < N; k++) {
      const g = edgeIndex(e, k), s = N * N + e * N + k;
      pos[s * 3] = pos[g * 3] - dx[g] * sk;
      pos[s * 3 + 1] = pos[g * 3 + 1] - dy[g] * sk;
      pos[s * 3 + 2] = pos[g * 3 + 2] - dz[g] * sk;
      nrm[s * 3] = nrm[g * 3]; nrm[s * 3 + 1] = nrm[g * 3 + 1]; nrm[s * 3 + 2] = nrm[g * 3 + 2];
      colr[s * 3] = colr[g * 3]; colr[s * 3 + 1] = colr[g * 3 + 1]; colr[s * 3 + 2] = colr[g * 3 + 2];
      hv[s] = hv[g];
    }
  }
  // ocean surface (sea level sphere) where the chunk dips below sea level
  let opos = null;
  if (minH < 15) {
    opos = new Float32Array(nv * 3);
    for (let g = 0; g < N * N; g++) {
      opos[g * 3] = dx[g] * R - cx; opos[g * 3 + 1] = dy[g] * R - cy; opos[g * 3 + 2] = dz[g] * R - cz;
    }
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < N; k++) {
        const g = edgeIndex(e, k), s = N * N + e * N + k;
        opos[s * 3] = dx[g] * (R - sk) - cx; opos[s * 3 + 1] = dy[g] * (R - sk) - cy; opos[s * 3 + 2] = dz[g] * (R - sk) - cz;
      }
    }
  }
  return { pos, nrm, col: colr, hv, opos, cx, cy, cz, minH, maxH };
}
