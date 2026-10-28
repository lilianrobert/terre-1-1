// Buildings and trees for one zoom-14 map tile (~1.6-2.4 km), from OpenStreetMap vector tiles (OpenFreeMap).
//   buildings: real footprints (with courtyards) extruded to their OSM height
//   trees:     scattered inside OSM forests, woods, parks and, sparsely, residential gardens
// Runs in the workers; returns typed arrays ready for GPU buffers.
import earcut from 'https://cdn.jsdelivr.net/npm/earcut@3.0.1/+esm';
import { decodeMVT } from './vt.js';
import { snoise } from './terrain-core.js';

const R = 6371000;   // city tiles only exist on Earth; never follow the workers' current body radius
import { fetchTile } from './tiles.js';

const DEG = 180 / Math.PI;
export const CITY_Z = 14;
export const BLOCKS = 4;            // tree instances are grouped in BLOCKS x BLOCKS cells for LOD
const G = 256;                      // raster used to place trees
const MAX_TREES = 110000;

let tpl = null;
function tileUrl(z, x, y) {
  if (!tpl) tpl = fetch('https://tiles.openfreemap.org/planet').then((r) => r.json()).then((j) => j.tiles[0]).catch(() => { tpl = null; return null; });
  return tpl.then((t) => (t ? t.replace('{z}', z).replace('{x}', x).replace('{y}', y) : null));
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d); s = Math.imul(s ^ (s >>> 12), 0x297a2d39); s ^= s >>> 15; return (s >>> 0) / 4294967296; };
}
const hexRGB = (h) => {
  if (typeof h !== 'string' || h[0] !== '#' || h.length < 7) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};

export async function buildCity(z, x, y, opts, isCancelled) {
  const [url, dem] = await Promise.all([tileUrl(z, x, y), fetchTile('dem', z, x, y)]);
  if (!url) return { empty: true };
  let buf;
  try {
    const r = await fetch(url);
    if (!r.ok) return { empty: true };
    buf = await r.arrayBuffer();
  } catch (e) { return { empty: true }; }
  if (isCancelled()) return null;
  const vt = decodeMVT(buf, ['building', 'landcover', 'park', 'landuse', 'water']);
  const E = (vt.building || vt.landcover || vt.water || { extent: 4096 }).extent;
  const n = 2 ** z;

  // ---- geography helpers (tile units -> lat/lon -> planet-centred metres)
  const lonOf = (px) => ((x + px / E) / n) * 360 - 180;
  const latOf = (py) => Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / E)) / n))) * DEG;
  const lat0 = latOf(E / 2), lon0 = lonOf(E / 2);
  const cl = Math.cos(lat0 / DEG);
  const C = dirOf(lat0, lon0);
  const cx = C[0] * R, cy = C[1] * R, cz = C[2] * R;
  const east = [C[2] === 0 && C[0] === 0 ? 1 : C[2], 0, -C[0]];
  const el = Math.hypot(east[0], east[2]); east[0] /= el; east[2] /= el;
  const north = [C[1] * east[2] - C[2] * east[1], C[2] * east[0] - C[0] * east[2], C[0] * east[1] - C[1] * east[0]];
  const tileM = 40075016.686 * cl / n;
  const s = tileM / E;                       // metres per tile unit
  const demH = (px, py) => {
    if (!dem) return 0;
    const fx = Math.min(255.999, Math.max(0, px / E * 256 - 0.5)), fy = Math.min(255.999, Math.max(0, py / E * 256 - 0.5));
    const X = Math.min(254, Math.floor(fx)), Y = Math.min(254, Math.floor(fy)), ax = fx - X, ay = fy - Y;
    const t = (i, j) => { const o = ((Y + j) * 256 + X + i) * 4; return dem[o] * 256 + dem[o + 1] + dem[o + 2] / 256 - 32768; };
    return (t(0, 0) * (1 - ax) + t(1, 0) * ax) * (1 - ay) + (t(0, 1) * (1 - ax) + t(1, 1) * ax) * ay;
  };
  const tmp = [0, 0, 0];
  const place = (px, py, h, out, o) => {
    const d = dirOf(latOf(py), lonOf(px), tmp), r = R + h;
    out[o] = d[0] * r - cx; out[o + 1] = d[1] * r - cy; out[o + 2] = d[2] * r - cz;
  };
  const rnd = rng(x * 73856093 ^ y * 19349663);
  const paris = Math.hypot((lat0 - 48.857) * 111, (lon0 - 2.35) * 111 * cl) < 9;
  const south = lat0 < 45.5 && lat0 > 30;

  // ---------------------------------------------------------------- buildings
  const P = [], Nn = [], Col = [], F = [], I = [];
  const excl = opts.exclusions || [];
  // blast zones of missile impacts: nothing standing inside
  const blasts = (opts.craters || []).filter((c) => c.body === 'earth' && c.x * C[0] + c.y * C[1] + c.z * C[2] > Math.cos((tileM + c.r * 6) / R));
  const flattened = (latD, lonD, k) => {
    if (!blasts.length) return false;
    const d = dirOf(latD, lonD, tmp2);
    for (const c of blasts) if (Math.acos(Math.min(1, d[0] * c.x + d[1] * c.y + d[2] * c.z)) * R < c.r * k) return true;
    return false;
  };
  const tmp2 = [0, 0, 0];
  let nb = 0;
  // styles: 0 plain, 1 roof, 2 Haussmann (zinc mansard, iron balconies), 3 house (shutters), 4 glass tower
  const pushV = (px, py, h, nx, ny, nz, c, fu, fv, flag, topH = 0) => {
    const o = P.length;
    P.length += 3;
    place(px, py, h, P, o);
    Nn.push(nx * 127, ny * 127, nz * 127);
    Col.push(c[0], c[1], c[2]);
    F.push(fu, fv, flag, topH);
    return o / 3;
  };
  const wp = [0, 0, 0], wq = [0, 0, 0], wr = [0, 0, 0];
  // hipped roof over a roughly rectangular footprint: every eave edge rises to a ridge along the long axis
  const hipRoof = (ring, top, rh, col) => {
    const m = ring.length / 2;
    let best = 0, dxL = 1, dyL = 0;
    for (let k = 0; k < m; k++) {
      const j = (k + 1) % m;
      const ex = ring[j * 2] - ring[k * 2], ey = ring[j * 2 + 1] - ring[k * 2 + 1], l = Math.hypot(ex, ey);
      if (l > best) { best = l; dxL = ex / l; dyL = ey / l; }
    }
    let cx0 = 0, cy0 = 0;
    for (let k = 0; k < m; k++) { cx0 += ring[k * 2]; cy0 += ring[k * 2 + 1]; }
    cx0 /= m; cy0 /= m;
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    const U = [], V = [];
    for (let k = 0; k < m; k++) {
      const qx = ring[k * 2] - cx0, qy = ring[k * 2 + 1] - cy0;
      const u = qx * dxL + qy * dyL, w = -qx * dyL + qy * dxL;
      U.push(u); V.push(w);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    }
    const half = (w1 - w0) / 2, wm = (w0 + w1) / 2;
    const ra = u0 + half, rb = Math.max(ra, u1 - half);
    const ridge = (k) => {
      const u = Math.min(rb, Math.max(ra, U[k]));
      return [cx0 + dxL * u - dyL * wm, cy0 + dyL * u + dxL * wm];
    };
    for (let k = 0; k < m; k++) {
      const j = (k + 1) % m;
      const rk = ridge(k), rj = ridge(j);
      place(ring[k * 2], ring[k * 2 + 1], top, wp, 0); place(ring[j * 2], ring[j * 2 + 1], top, wq, 0); place(rj[0], rj[1], top + rh, wr, 0);
      let nx = (wq[1] - wp[1]) * (wr[2] - wp[2]) - (wq[2] - wp[2]) * (wr[1] - wp[1]);
      let ny = (wq[2] - wp[2]) * (wr[0] - wp[0]) - (wq[0] - wp[0]) * (wr[2] - wp[2]);
      let nz = (wq[0] - wp[0]) * (wr[1] - wp[1]) - (wq[1] - wp[1]) * (wr[0] - wp[0]);
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) { place(rk[0], rk[1], top + rh, wr, 0); nx = (wq[1] - wp[1]) * (wr[2] - wp[2]) - (wq[2] - wp[2]) * (wr[1] - wp[1]); ny = (wq[2] - wp[2]) * (wr[0] - wp[0]) - (wq[0] - wp[0]) * (wr[2] - wp[2]); nz = (wq[0] - wp[0]) * (wr[1] - wp[1]) - (wq[1] - wp[1]) * (wr[0] - wp[0]); nl = Math.hypot(nx, ny, nz) || 1; }
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * C[0] + ny * C[1] + nz * C[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const a = pushV(ring[k * 2], ring[k * 2 + 1], top, nx, ny, nz, col, ring[k * 2] * s, 0, 1);
      pushV(ring[j * 2], ring[j * 2 + 1], top, nx, ny, nz, col, ring[j * 2] * s, 0, 1);
      pushV(rj[0], rj[1], top + rh, nx, ny, nz, col, rj[0] * s, rh, 1);
      pushV(rk[0], rk[1], top + rh, nx, ny, nz, col, rk[0] * s, rh, 1);
      I.push(a, a + 1, a + 2, a, a + 2, a + 3);
    }
  };
  for (const f of (vt.building ? vt.building.features : [])) {
    if (f.type !== 3 || f.props.hide_3d) continue;
    for (const poly of f.rings) {
      const outer = poly[0];
      // keep each building in exactly one tile: the one holding its centroid
      let ax = 0, ay = 0, area = 0;
      for (let k = 0; k < outer.length; k += 2) {
        const j = (k + 2) % outer.length;
        const cr = outer[k] * outer[j + 1] - outer[j] * outer[k + 1];
        area += cr; ax += (outer[k] + outer[j]) * cr; ay += (outer[k + 1] + outer[j + 1]) * cr;
      }
      if (Math.abs(area) < 1e-6) continue;
      ax /= 3 * area; ay /= 3 * area;
      if (ax < 0 || ay < 0 || ax >= E || ay >= E) continue;
      const areaM = Math.abs(area) / 2 * s * s;
      if (areaM < 12) continue;
      const blat = latOf(ay), blon = lonOf(ax);
      let skip = false;
      for (const e of excl) if (Math.hypot((blat - e.lat) * 111320, (blon - e.lon) * 111320 * cl) < e.r) { skip = true; break; }
      if (skip || flattened(blat, blon, 4)) continue;

      const hTag = +f.props.render_height || 0, minH = +f.props.render_min_height || 0;
      let H = hTag > 0 ? hTag : (areaM < 120 ? 5.5 : areaM < 600 ? 8 : 10);
      if (paris && hTag <= 5) H = areaM < 80 ? 9 : 18;     // Paris: untagged buildings are mostly 5-7 storeys
      let g = Infinity;
      for (let k = 0; k < outer.length; k += 2) g = Math.min(g, demH(outer[k], outer[k + 1]));
      const base = minH > 0 ? g + minH : g - 3;
      const top = g + Math.max(H, minH + 2.5);
      const v0 = base - g, v1 = top - g;

      // colours
      const hv = rnd();
      let wall = hexRGB(f.props.colour);
      if (paris) wall = [214 - hv * 18, 202 - hv * 16, 178 - hv * 14];
      else if (H > 45) wall = [150 + hv * 20, 160 + hv * 15, 172 + hv * 10];
      else if (!wall || hv < 0.6) {
        const pal = south ? [[226, 210, 182], [214, 186, 150], [232, 222, 204], [200, 160, 120]] : [[222, 214, 198], [205, 190, 170], [232, 226, 214], [168, 104, 84], [190, 178, 164]];
        wall = pal[Math.floor(hv * pal.length) % pal.length];
      }
      let roof;
      if (areaM > 900 || H > 30) roof = [138 + hv * 20, 138 + hv * 20, 134 + hv * 18];
      else if (paris) roof = [112 + hv * 22, 120 + hv * 20, 130 + hv * 18];
      else if (south) roof = [176 - hv * 20, 92 - hv * 12, 66 - hv * 10];
      else roof = [82 + hv * 30, 82 + hv * 26, 92 + hv * 22];

      const style = paris && H >= 11 ? 2 : (H > 45 || (areaM > 4000 && H > 25)) && !paris ? 4 : H < 10 && areaM < 260 ? 3 : 0;
      if (style === 4) wall = [118 + hv * 30, 138 + hv * 26, 150 + hv * 20];
      // a pitched roof suits simple, compact footprints outside dense city blocks
      let rh = 0;
      const simple = poly.length === 1 && outer.length <= 20 && areaM > 30 && areaM < 900 && H < 22 && !(paris && H > 11);
      if (simple) {
        let mx = -Infinity, mn = Infinity;
        const m = outer.length / 2;
        let ex = 1, ey = 0, best = 0;
        for (let k = 0; k < m; k++) {
          const j = (k + 1) % m;
          const dx = outer[j * 2] - outer[k * 2], dy = outer[j * 2 + 1] - outer[k * 2 + 1], l = Math.hypot(dx, dy);
          if (l > best) { best = l; ex = dx / l; ey = dy / l; }
        }
        for (let k = 0; k < m; k++) { const w = -outer[k * 2] * ey + outer[k * 2 + 1] * ex; mx = Math.max(mx, w); mn = Math.min(mn, w); }
        const width = (mx - mn) * s;
        const fill = areaM / Math.max(1, width * best * s);
        if (width > 3 && fill > 0.72) rh = Math.min(7, width * 0.42 * (south ? 0.7 : 1));
      }

      // walls: outward normal is always to the left of the edge in east/north coordinates
      for (const ring of poly) {
        let u = 0;
        const m = ring.length;
        for (let k = 0; k < m; k += 2) {
          const j = (k + 2) % m;
          const dx = ring[j] - ring[k], dy = ring[j + 1] - ring[k + 1];
          const len = Math.hypot(dx, dy) * s;
          if (len < 0.05) continue;
          let nE = dy, nN = dx;
          const nl = Math.hypot(nE, nN); nE /= nl; nN /= nl;
          const nx = east[0] * nE + north[0] * nN, ny = east[1] * nE + north[1] * nN, nz = east[2] * nE + north[2] * nN;
          const a = pushV(ring[k], ring[k + 1], base, nx, ny, nz, wall, u, v0, style, v1);
          pushV(ring[j], ring[j + 1], base, nx, ny, nz, wall, u + len, v0, style, v1);
          pushV(ring[j], ring[j + 1], top, nx, ny, nz, wall, u + len, v1, style, v1);
          pushV(ring[k], ring[k + 1], top, nx, ny, nz, wall, u, v1, style, v1);
          I.push(a, a + 1, a + 2, a, a + 2, a + 3);
          u += len;
        }
      }
      if (rh > 0) { hipRoof(outer.length >= 4 && outer[0] === outer[outer.length - 2] && outer[1] === outer[outer.length - 1] ? outer.slice(0, -2) : outer, top, rh, roof); nb++; continue; }
      // flat roof, holes included
      const flat = [], holes = [];
      for (let r = 0; r < poly.length; r++) {
        if (r) holes.push(flat.length / 2);
        const ring = poly[r];
        for (let k = 0; k < ring.length; k++) flat.push(ring[k]);
      }
      const tris = earcut(flat, holes);
      const start = P.length / 3;
      for (let k = 0; k < flat.length; k += 2) pushV(flat[k], flat[k + 1], top, C[0], C[1], C[2], roof, flat[k] * s, flat[k + 1] * s, 1);
      for (const t of tris) I.push(start + t);
      nb++;
    }
    if (P.length > 9e6) break;
  }
  if (isCancelled()) return null;
  const bld = nb ? {
    pos: new Float32Array(P), nrm: new Int8Array(Nn), col: new Uint8Array(Col),
    fac: new Float32Array(F), idx: new Uint32Array(I), count: nb,
  } : null;

  // ---------------------------------------------------------------- tree raster
  const grid = new Uint8Array(G * G);
  const cs = E / G;
  const fill = (poly, val, onlyEmpty) => {
    // scanline fill, even-odd over all rings so courtyards and clearings stay empty
    let y0 = Infinity, y1 = -Infinity;
    for (const r of poly) for (let k = 1; k < r.length; k += 2) { if (r[k] < y0) y0 = r[k]; if (r[k] > y1) y1 = r[k]; }
    const j0 = Math.max(0, Math.floor(y0 / cs)), j1 = Math.min(G - 1, Math.ceil(y1 / cs));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const yc = (j + 0.5) * cs;
      xs.length = 0;
      for (const r of poly) {
        for (let k = 0, m = r.length; k < m; k += 2) {
          const q = (k + 2) % m;
          const ya = r[k + 1], yb = r[q + 1];
          if ((ya <= yc) !== (yb <= yc)) xs.push(r[k] + (yc - ya) / (yb - ya) * (r[q] - r[k]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] / cs - 0.5)), i1 = Math.min(G - 1, Math.floor(xs[k + 1] / cs - 0.5));
        for (let i = i0; i <= i1; i++) { const c = j * G + i; if (!onlyEmpty || !grid[c]) grid[c] = val; }
      }
    }
  };
  for (const f of (vt.landuse ? vt.landuse.features : [])) if (f.type === 3 && f.props.class === 'residential') for (const p of f.rings) fill(p, 3);
  for (const f of (vt.park ? vt.park.features : [])) if (f.type === 3 && f.props.class === 'park') for (const p of f.rings) fill(p, 2);
  for (const f of (vt.landcover ? vt.landcover.features : [])) {
    if (f.type !== 3) continue;
    if (f.props.class === 'wood') for (const p of f.rings) fill(p, 1);
    else if (f.props.class === 'grass' || f.props.class === 'sand' || f.props.class === 'rock' || f.props.class === 'ice') for (const p of f.rings) fill(p, 0);
  }
  for (const f of (vt.water ? vt.water.features : [])) if (f.type === 3) for (const p of f.rings) fill(p, 8);
  for (const f of (vt.building ? vt.building.features : [])) if (f.type === 3) for (const p of f.rings) fill(p, 9);
  // keep trees a few metres off walls
  const near = new Uint8Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    if (grid[j * G + i] !== 9) continue;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < G && jj < G) near[jj * G + ii] = 1;
    }
  }

  // ---------------------------------------------------------------- tree scatter
  const autumn = opts.autumn || 0;
  const coniferBase = Math.max(0, Math.min(0.85, (Math.abs(lat0) - 42) / 16));
  const blocks = [];
  for (let b = 0; b < BLOCKS * BLOCKS; b++) blocks.push({ broad: [], con: [] });
  const cellM = cs * s;
  let nt = 0;
  for (let j = 0; j < G && nt < MAX_TREES; j++) for (let i = 0; i < G; i++) {
    const c = j * G + i, kind = grid[c];
    if (kind === 0 || kind >= 8 || near[c]) continue;
    const want = kind === 1 ? (cellM < 7 ? 1 : 2) : kind === 2 ? (rnd() < 0.55 ? 1 : 0) : (rnd() < 0.09 ? 1 : 0);
    for (let t = 0; t < want; t++) {
      const px = (i + rnd()) * cs, py = (j + rnd()) * cs;
      const tl = latOf(py), tn = lonOf(px);
      if (flattened(tl, tn, 5)) continue;
      const region = snoise(tl * 0.9, tn * 0.9, 3.7) * 0.55;               // pine regions, broadleaf regions
      const pCon = Math.max(0, Math.min(0.95, coniferBase + region)) * (kind === 1 ? 1 : 0.35);
      const conifer = rnd() < pCon;
      const h = conifer ? 13 + rnd() * 15 : (kind === 2 ? 10 : 8) + rnd() * 12;
      const o = [0, 0, 0];
      place(px, py, demH(px, py) - 0.6, o, 0);
      let r, g, bl;
      const v = rnd();
      if (conifer) { r = 0.13 + v * 0.05; g = 0.21 + v * 0.06; bl = 0.12 + v * 0.04; }
      else if (autumn > 0 && rnd() < autumn * (0.35 + 0.4 * (region + 0.5))) {
        const a = rnd();                                                  // autumn: yellow, orange, russet
        r = 0.45 + a * 0.2; g = 0.28 + (1 - a) * 0.18; bl = 0.08;
      } else { r = 0.2 + v * 0.08; g = 0.31 + v * 0.1; bl = 0.12 + v * 0.05; }
      const bi = Math.min(BLOCKS - 1, Math.floor(i / G * BLOCKS)) + Math.min(BLOCKS - 1, Math.floor(j / G * BLOCKS)) * BLOCKS;
      (conifer ? blocks[bi].con : blocks[bi].broad).push(o[0], o[1], o[2], h, rnd() * 6.283, r, g, bl);
      nt++;
    }
  }
  const outBlocks = blocks.map((bk, bi) => {
    const bx = (bi % BLOCKS + 0.5) / BLOCKS * E, by = (Math.floor(bi / BLOCKS) + 0.5) / BLOCKS * E;
    const o = [0, 0, 0];
    place(bx, by, demH(bx, by), o, 0);
    return { c: o, broad: bk.broad.length ? new Float32Array(bk.broad) : null, con: bk.con.length ? new Float32Array(bk.con) : null };
  });

  return { cx, cy, cz, bld, blocks: outBlocks, trees: nt, tileM };
}

function dirOf(latDeg, lonDeg, out = [0, 0, 0]) {
  const la = latDeg / DEG, lo = lonDeg / DEG;
  out[0] = Math.cos(la) * Math.cos(lo); out[1] = Math.sin(la); out[2] = -Math.cos(la) * Math.sin(lo);
  return out;
}
