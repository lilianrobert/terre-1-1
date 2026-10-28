// Web-Mercator map tiles, fetched and decoded inside the workers.
//   dem  : AWS Terrain Tiles (Terrarium encoding), elevation + bathymetry
//   img  : Esri World Imagery, satellite colour
//   base : Esri Light Gray Base, used as a mask for water and building footprints

const URLS = {
  dem: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  img: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  base: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
};
export const ZMAX = { dem: 15, img: 18, base: 16 };
export const MPP0 = 156543.03392;   // metres per pixel at zoom 0 on the equator
export let online = true;

const cache = new Map();           // decoded tiles, LRU by insertion order
const LIMIT = 110;
let failures = 0;

export function fetchTile(src, z, x, y) {
  const key = `${src}${z}/${x}/${y}`;
  let e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); return e; }
  e = fetch(URLS[src](z, x, y))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }) : null))
    .then((bmp) => {
      if (!bmp) return null;
      const c = new OffscreenCanvas(256, 256);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, 256, 256);
      bmp.close();
      failures = 0;
      return g.getImageData(0, 0, 256, 256).data;
    })
    .catch(() => { if (++failures > 30) online = false; cache.delete(key); return null; });
  cache.set(key, e);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
  return e;
}

// Pixel coordinates (at zoom z) of lat/lon arrays in degrees. Longitudes must already be unwrapped.
export function project(lat, lon, z, valid, px, py) {
  const s = 256 * 2 ** z;
  for (let k = 0; k < lat.length; k++) {
    if (!valid[k]) continue;
    const sl = Math.sin(lat[k] * Math.PI / 180);
    px[k] = (lon[k] / 360 + 0.5) * s;
    py[k] = (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * s;
  }
}

// Fetch every tile touched by the points. Returns null when the area needs too many tiles.
export async function tileSet(src, z, px, py, valid) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < px.length; k++) {
    if (!valid[k]) continue;
    if (px[k] < x0) x0 = px[k]; if (px[k] > x1) x1 = px[k];
    if (py[k] < y0) y0 = py[k]; if (py[k] > y1) y1 = py[k];
  }
  if (x0 === Infinity) return { z, tx0: 0, ty0: 0, w: 0, h: 0, tiles: [] };
  const n = 2 ** z;
  const tx0 = Math.floor((x0 - 1) / 256), tx1 = Math.floor((x1 + 1) / 256);
  const ty0 = Math.max(0, Math.floor((y0 - 1) / 256)), ty1 = Math.min(n - 1, Math.floor((y1 + 1) / 256));
  const w = tx1 - tx0 + 1, h = ty1 - ty0 + 1;
  if (w * h > 25) return null;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(fetchTile(src, z, ((tx % n) + n) % n, ty));
  return { z, tx0, ty0, w, h, tiles: await Promise.all(jobs) };
}

let D = null;
function at(ts, X, Y) {
  const tx = (X >> 8) - ts.tx0, ty = (Y >> 8) - ts.ty0;
  if (tx < 0 || ty < 0 || tx >= ts.w || ty >= ts.h) return -1;
  D = ts.tiles[ty * ts.w + tx];
  if (!D) return -1;
  return (((Y & 255) << 8) | (X & 255)) << 2;
}

const terr = (o) => D[o] * 256 + D[o + 1] + D[o + 2] / 256 - 32768;

export function demAt(ts, px, py) {
  const X = Math.floor(px - 0.5), Y = Math.floor(py - 0.5), fx = px - 0.5 - X, fy = py - 0.5 - Y;
  let o = at(ts, X, Y); if (o < 0) return NaN; const a = terr(o);
  o = at(ts, X + 1, Y); if (o < 0) return NaN; const b = terr(o);
  o = at(ts, X, Y + 1); if (o < 0) return NaN; const c = terr(o);
  o = at(ts, X + 1, Y + 1); if (o < 0) return NaN; const d = terr(o);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// bilinear RGB (0..255) into out; false when a tile is missing
export function rgbAt(ts, px, py, out) {
  const X = Math.floor(px - 0.5), Y = Math.floor(py - 0.5), fx = px - 0.5 - X, fy = py - 0.5 - Y;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  let r = 0, g = 0, b = 0, o;
  o = at(ts, X, Y); if (o < 0) return false; r += D[o] * w00; g += D[o + 1] * w00; b += D[o + 2] * w00;
  o = at(ts, X + 1, Y); if (o < 0) return false; r += D[o] * w10; g += D[o + 1] * w10; b += D[o + 2] * w10;
  o = at(ts, X, Y + 1); if (o < 0) return false; r += D[o] * w01; g += D[o + 1] * w01; b += D[o + 2] * w01;
  o = at(ts, X + 1, Y + 1); if (o < 0) return false; r += D[o] * w11; g += D[o + 1] * w11; b += D[o + 2] * w11;
  out[0] = r; out[1] = g; out[2] = b;
  return true;
}

// nearest pixel of the gray base map: 0 unknown, 1 land, 2 water, 3 building
export function baseClass(ts, px, py) {
  const o = at(ts, Math.floor(px), Math.floor(py));
  if (o < 0) return 0;
  const r = D[o], g = D[o + 1], b = D[o + 2];
  if (Math.abs(r - 208) < 6 && Math.abs(g - 207) < 6 && b - g >= 3 && b - g <= 8) return 2;
  if (r >= 216 && r <= 230 && b - r >= 1 && b - r <= 5 && g >= r) return 3;
  return 1;
}
