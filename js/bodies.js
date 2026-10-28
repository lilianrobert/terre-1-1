// Surface generators for the Moon and Mars (run in the workers).
// Colour comes from global mosaics; relief is built from the real large features plus crater fields.
import { R, fbm, snoise } from './terrain-core.js';

export const BODY_RADIUS = { earth: 6371000, moon: 1737400, mars: 3389500 };

const DEG = Math.PI / 180;
const tex = {};
export function setBodyTex(id, data, w, h) { tex[id] = { data, w, h }; }

const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// bilinear sRGB sample (0..1) of a body mosaic at lon/lat in radians
export function bodyColor(id, lon, lat, out) {
  const t = tex[id];
  if (!t) { out[0] = out[1] = out[2] = 0.5; return out; }
  const { data: C, w, h } = t;
  const u = (lon / Math.PI + 1) * 0.5 * w - 0.5;
  let v = (0.5 - lat / Math.PI) * h - 0.5;
  v = v < 0 ? 0 : v > h - 1.001 ? h - 1.001 : v;
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w, yb = Math.min(y0 + 1, h - 1);
  for (let c = 0; c < 3; c++) {
    const p00 = C[(y0 * w + xa) * 4 + c], p10 = C[(y0 * w + xb) * 4 + c];
    const p01 = C[(yb * w + xa) * 4 + c], p11 = C[(yb * w + xb) * 4 + c];
    out[c] = ((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy) / 255;
  }
  return out;
}

// ---------------------------------------------------------------- craters
function hash(i, j, k, s) {
  let h = Math.imul(i | 0, 0x8da6b343) ^ Math.imul(j | 0, 0xd8163841) ^ Math.imul(k | 0, 0xcb1ab31f) ^ Math.imul(s + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const rnd = (h, n) => (((Math.imul(h ^ (n * 0x9e3779b9), 0x85ebca6b) >>> 0) ^ (h >>> 13)) % 100003) / 100003;

// Sum of bowl craters over octaves of 3D cells laid on the sphere. Fills o.alb with a brightness
// boost for fresh crater rims and rays. depthK ~ depth/radius for simple craters.
function craterField(x, y, z, minWL, cell0, octaves, dens, depthK, o) {
  let h = 0, alb = 0, cell = cell0;
  for (let k = 0; k < octaves; k++, cell *= 0.5) {
    if (cell < minWL * 3) break;
    const s = R / cell;
    const px = x * s, py = y * s, pz = z * s;
    const fx = Math.floor(px), fy = Math.floor(py), fz = Math.floor(pz);
    const ox = px - fx < 0.5 ? -1 : 0, oy = py - fy < 0.5 ? -1 : 0, oz = pz - fz < 0.5 ? -1 : 0;
    const dk = Math.min(0.75, dens + k * 0.035);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const cx = fx + ox + a, cy = fy + oy + b, cz = fz + oz + c;
      const hh = hash(cx, cy, cz, k);
      if (rnd(hh, 1) > dk) continue;
      const rc = 0.1 + 0.32 * Math.pow(rnd(hh, 2), 2);                       // radius, cell units
      const qx = cx + 0.3 + 0.4 * rnd(hh, 3), qy = cy + 0.3 + 0.4 * rnd(hh, 4), qz = cz + 0.3 + 0.4 * rnd(hh, 5);
      const d = Math.hypot(px - qx, py - qy, pz - qz);
      const t = d / rc;
      if (t > 2.4) continue;
      const rm = rc * cell;                                                   // radius in metres
      const age = rnd(hh, 6);                                                 // 0 fresh .. 1 eroded
      const big = smooth(6000, 40000, rm);
      const depth = rm * depthK * (1 - 0.55 * big) * (1 - 0.6 * age);
      let v;
      if (t < 1) v = Math.max(depth * (t * t - 1), -depth * (1 - 0.35 * big));   // bowl, flat floor when big
      else v = depth * 0.1 * Math.exp(-(t - 1) * 3);                          // ejecta blanket
      v += depth * 0.32 * Math.exp(-((t - 1) * (t - 1)) / 0.03);              // raised rim
      if (big > 0) v += depth * 0.45 * big * Math.exp(-(t * t) / 0.02);       // central peak
      h += v;
      if (age < 0.2 && rm < 3000) alb += (0.2 - age) * Math.exp(-((t - 1.1) * (t - 1.1)) / 0.3) * 0.5;   // only small fresh craters stay bright
    }
  }
  o.alb = alb;
  return h;
}

// ---------------------------------------------------------------- the Moon
const cMoon = new Float64Array(3);
export function moonSample(x, y, z, minWL, o) {
  const lat = Math.asin(y > 1 ? 1 : y < -1 ? -1 : y), lon = Math.atan2(-z, x);
  bodyColor('moon', lon, lat, cMoon);
  const lum = 0.3 * cMoon[0] + 0.59 * cMoon[1] + 0.11 * cMoon[2];
  const mare = smooth(0.42, 0.27, lum);                                       // dark plains are lava-filled lowlands
  let h = -2200 * mare + (1 - mare) * 1400 * fbm(x, y, z, 5, minWL, 5, 0.5);
  h += craterField(x, y, z, minWL, 180000, 15, 0.28, 0.42, o) * (1 - 0.55 * mare);
  h += fbm(x + 3.1, y, z, R / 3000, minWL, 12, 0.5) * 60 * (1 - 0.5 * mare);   // rolling regolith
  o.h = h; o.lat = lat; o.lon = lon;
  return h;
}

// ---------------------------------------------------------------- Mars
const dirOf = (latD, lonD) => [Math.cos(latD * DEG) * Math.cos(lonD * DEG), Math.sin(latD * DEG), -Math.cos(latD * DEG) * Math.sin(lonD * DEG)];
// shield volcanoes: lat, lon (east positive), height (m), radius (m)
const VOLCANOES = [
  [18.65, -133.8, 21500, 310e3], [-8.26, -120.1, 14500, 210e3], [1.48, -112.96, 12500, 190e3],
  [11.92, -104.08, 14500, 200e3], [24.8, 146.9, 10500, 210e3], [40.5, -109.6, 3500, 650e3],
].map(([la, lo, H, r]) => ({ d: dirOf(la, lo), H, r }));
const BASINS = [   // impact basins: lat, lon, depth, radius
  [-42.4, 70.5, 7600, 1150e3], [-49.7, -43.4, 4500, 450e3], [12.9, 87.0, 3200, 600e3],
].map(([la, lo, D, r]) => ({ d: dirOf(la, lo), D, r }));
const VALLES = [[-7, -103], [-6.5, -93], [-7.5, -84], [-10, -74], [-12.5, -64], [-14, -55], [-12.5, -46], [-9, -38]];
const THARSIS = dirOf(2, -105);

const angDist = (x, y, z, d) => Math.acos(Math.max(-1, Math.min(1, x * d[0] + y * d[1] + z * d[2]))) * R;

export function marsSample(x, y, z, minWL, o) {
  const lat = Math.asin(y > 1 ? 1 : y < -1 ? -1 : y), lon = Math.atan2(-z, x);
  const latD = lat / DEG, lonD = lon / DEG;
  // hemispheric dichotomy: the northern plains sit ~4 km lower
  let h = -3800 * smooth(-8, 32, latD + 14 * snoise(x * 2, y * 2, z * 2)) + 1200;
  h += 7000 * Math.exp(-Math.pow(angDist(x, y, z, THARSIS) / 2600e3, 2));
  for (const v of VOLCANOES) {
    const d = angDist(x, y, z, v.d);
    if (d > v.r * 1.15) continue;
    const t = d / v.r;
    let s = v.H * Math.pow(Math.max(0, 1 - t), 1.5);
    s += v.H * 0.08 * smooth(1.08, 0.96, t) * (t > 0.85 ? 1 : 0);          // basal scarp
    s -= v.H * 0.14 * smooth(0.13, 0.09, t);                                 // summit caldera
    h += s;
  }
  for (const b of BASINS) {
    const t = angDist(x, y, z, b.d) / b.r;
    if (t > 1.6) continue;
    h -= b.D * Math.max(0, 1 - t * t);
    h += b.D * 0.2 * Math.exp(-((t - 1) * (t - 1)) / 0.02);
  }
  // Valles Marineris: distance to the canyon's centre line, in lat/lon degrees scaled to metres
  let best = 1e9, along = 0;
  for (let i = 0; i + 1 < VALLES.length; i++) {
    const [a0, b0] = VALLES[i], [a1, b1] = VALLES[i + 1];
    const ex = (b1 - b0) * Math.cos(latD * DEG), ey = a1 - a0;
    const qx = (lonD - b0) * Math.cos(latD * DEG), qy = latD - a0;
    const t = Math.max(0, Math.min(1, (qx * ex + qy * ey) / (ex * ex + ey * ey)));
    const dd = Math.hypot(qx - ex * t, qy - ey * t);
    if (dd < best) { best = dd; along = (i + t) / (VALLES.length - 1); }
  }
  const dm = best * DEG * R;
  const half = 45e3 + 70e3 * Math.sin(along * Math.PI);
  if (dm < half * 1.6) {
    const wob = 1 + 0.25 * snoise(x * 300, y * 300, z * 300);
    const depth = 7500 * Math.sin(Math.min(1, along * 1.3) * Math.PI * 0.5 + 0.2) * smooth(1.0, 0.0, along - 0.9);
    h -= depth * smooth(1.0 * wob, 0.65 * wob, dm / half);
  }
  h += craterField(x, y, z, minWL, 220000, 15, 0.16, 0.28, o) * 0.9;
  h += fbm(x + 1.7, y, z, 40, minWL, 14, 0.52) * 900;
  o.h = h; o.lat = lat; o.lon = lon;
  return h;
}

export function bodySample(id, x, y, z, minWL, o) {
  return id === 'moon' ? moonSample(x, y, z, minWL, o) : marsSample(x, y, z, minWL, o);
}
