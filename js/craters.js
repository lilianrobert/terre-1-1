// Impact craters dug by missiles. Shared by the workers (they carve the terrain and paint the exposed
// rock layers) and the main thread (it merges repeated hits into one growing crater).
// A crater: { body, x, y, z (unit direction of its centre), r (rim radius, m), d (depth, m) }

import { snoise } from './terrain-core.js';

let list = [];
export function setCraters(l) { list = l || []; }
export function getCraters() { return list; }

const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// craters that can touch a chunk (centre direction cx,cy,cz, angular radius ang)
export function cratersNear(body, cx, cy, cz, ang, R) {
  const out = [];
  for (const c of list) {
    if (c.body !== body) continue;
    const reach = ang + c.r * 6 / R;
    if (cx * c.x + cy * c.y + cz * c.z > Math.cos(Math.min(Math.PI, reach))) out.push(c);
  }
  return out;
}

// height change and scorch at a direction. o.dh < 0 inside the bowl; o.scorch 0..1 around the blast
export function craterAt(near, x, y, z, R, o) {
  let dh = 0, scorch = 0;
  for (const c of near) {
    const dot = x * c.x + y * c.y + z * c.z;
    if (dot < Math.cos(Math.min(Math.PI, c.r * 6 / R))) continue;
    const t = Math.acos(Math.min(1, dot)) * R / c.r;
    if (t < 1) {
      let b = c.d * (1 - t * t) * (1 - 0.2 * t * t);                         // bowl, steeper near the rim
      // slumped terraces on the walls and rubble everywhere, scaled with the crater
      const k = R / (c.r * 0.12);
      const n = snoise(x * k, y * k, z * k) * 0.6 + snoise(x * k * 3.1, y * k * 3.1, z * k * 3.1) * 0.3;
      const steps = 4 + Math.min(10, c.n || 1);
      const q = b / c.d * steps;
      const terr = (Math.floor(q) + Math.pow(q - Math.floor(q), 4)) / steps * c.d;
      b = b + (terr - b) * smooth(0.25, 0.55, t) * (1 - smooth(0.9, 1.0, t)) * 0.8;
      dh -= b * (1 + 0.08 * n) + c.d * 0.015 * n;
    }
    dh += c.d * 0.1 * Math.exp(-((t - 1) * (t - 1)) / 0.03);                 // raised rim
    if (t > 1) dh += c.d * 0.025 * Math.exp(-(t - 1) * 1.2);                 // ejecta blanket
    scorch = Math.max(scorch, 1 - smooth(1.1, 5.5, t));
  }
  o.dh = dh; o.scorch = scorch;
  return dh;
}

// Colour (sRGB 0..1) of the rock exposed at depth d below the original surface, and how much it glows.
// The column is compressed so a few dozen concentrated hits reach the molten mantle.
const SED = [[0.71, 0.63, 0.49], [0.55, 0.47, 0.37], [0.80, 0.76, 0.68], [0.47, 0.37, 0.29], [0.63, 0.52, 0.40]];
export function strata(body, d, n, out) {
  const D = d + n * 8;
  let c, glow = 0;
  if (body === 'moon') {
    c = D < 8 ? [0.42, 0.41, 0.40] : D < 900 ? [0.33, 0.32, 0.31] : D < 6000 ? [0.24, 0.24, 0.25] : [0.85, 0.18, 0.02];
    glow = smooth(6000, 9000, D);
  } else if (body === 'mars') {
    if (D < 10) c = [0.62, 0.36, 0.22];
    else if (D < 700) { const b = (Math.floor((D - 10) / 30 + n * 0.4) % 3 + 3) % 3; c = [[0.70, 0.42, 0.27], [0.54, 0.32, 0.22], [0.78, 0.55, 0.38]][b]; }
    else if (D < 6000) c = [0.30, 0.25, 0.24];
    else c = [0.85, 0.18, 0.02];
    glow = smooth(6000, 9000, D);
  } else {
    if (D < 3) c = [0.18, 0.13, 0.09];                                       // humus
    else if (D < 22) c = [0.45, 0.32, 0.19];                                 // clay subsoil
    else if (D < 650) { const b = (Math.floor((D - 22) / 24 + n * 0.35) % 5 + 5) % 5; c = SED[b]; }   // sedimentary beds
    else if (D < 4000) c = [0.56, 0.49, 0.47];                               // granite crust
    else if (D < 8000) c = [0.19, 0.19, 0.21];                               // basalt
    else c = [0.85, 0.18, 0.02];                                             // mantle (shaders make this exact red glow)
    glow = smooth(7000, 10500, D);
  }
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  return glow;
}
