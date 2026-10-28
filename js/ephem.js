// Low-precision ephemerides: good to a fraction of a degree for 1800-2050, plenty for a flight sim.
// Frames: inertial = equatorial J2000 (x towards the vernal equinox, z north), metres.
// Each body also has a body-fixed frame in the engine's convention: x = lon 0, y = north pole, z = lon -90°.
const DEG = Math.PI / 180;
export const AU = 1.495978707e11;
const OBL = 23.43928 * DEG;

export const jdOf = (date) => date.getTime() / 86400000 + 2440587.5;

// JPL "Approximate positions of the planets", elements at J2000 and per-century rates:
// a (AU), e, I, L, long. perihelion, long. ascending node (degrees)
const EL = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus: [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  mars: [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn: [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589],
  neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
};

function eclToEq(x, y, z) {
  return [x, y * Math.cos(OBL) - z * Math.sin(OBL), y * Math.sin(OBL) + z * Math.cos(OBL)];
}

// heliocentric position (inertial, metres); M0 lets callers sample a whole orbit
export function planetHelio(name, jd, M0 = null) {
  const T = (jd - 2451545) / 36525;
  const e0 = EL[name];
  const a = e0[0] + e0[1] * T, e = e0[2] + e0[3] * T, I = (e0[4] + e0[5] * T) * DEG;
  const L = e0[6] + e0[7] * T, wbar = e0[8] + e0[9] * T, node = (e0[10] + e0[11] * T) * DEG;
  const w = wbar * DEG - node;
  let M = M0 === null ? ((L - wbar) % 360) * DEG : M0;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(node), sO = Math.sin(node), cI = Math.cos(I), sI = Math.sin(I);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = (sw * sI) * xp + (cw * sI) * yp;
  const q = eclToEq(x, y, z);
  return [q[0] * AU, q[1] * AU, q[2] * AU];
}

// geocentric Moon (Meeus, main terms), metres
export function moonGeo(jd) {
  const d = jd - 2451545;
  const Lp = (218.316 + 13.176396 * d) * DEG, M = (134.963 + 13.064993 * d) * DEG, F = (93.272 + 13.229350 * d) * DEG;
  const D = (297.850 + 12.190749 * d) * DEG, Ms = (357.529 + 0.98560028 * d) * DEG;
  const lam = Lp + (6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms)) * DEG;
  const bet = (5.128 * Math.sin(F)) * DEG;
  const dist = (385001 - 20905 * Math.cos(M) - 3699 * Math.cos(2 * D - M) - 2956 * Math.cos(2 * D)) * 1000;
  const q = eclToEq(Math.cos(bet) * Math.cos(lam) * dist, Math.cos(bet) * Math.sin(lam) * dist, Math.sin(bet) * dist);
  return q;
}

// IAU rotation models: pole RA/Dec and prime meridian angle W (degrees), d = days from J2000
const ROT = {
  sun: (d) => [286.13, 63.87, 84.176 + 14.1844 * d],
  mercury: (d) => [281.0103, 61.4155, 329.5988 + 6.1385108 * d],
  venus: (d) => [272.76, 67.16, 160.20 - 1.4813688 * d],
  earth: (d) => [0, 90, 190.147 + 360.9856235 * d],
  moon: (d) => [269.9949, 66.5392, 38.3213 + 13.17635815 * d],
  mars: (d) => [317.681, 52.887, 176.630 + 350.89198226 * d],
  jupiter: (d) => [268.057, 64.495, 284.95 + 870.536 * d],
  saturn: (d) => [40.589, 83.537, 38.90 + 810.7939024 * d],
  uranus: (d) => [257.311, -15.175, 203.81 - 501.1600928 * d],
  neptune: (d) => [299.36, 43.46, 249.978 + 541.1397757 * d],
};

// 3x3 (row-major) rotation taking inertial vectors into the body-fixed engine frame
export function bodyFrame(name, jd) {
  const [a0, d0, W] = ROT[name](jd - 2451545);
  const a = a0 * DEG, dd = d0 * DEG, w = (W % 360) * DEG;
  // pole, then the node of the body equator on the ICRF equator, then the prime meridian
  const pole = [Math.cos(dd) * Math.cos(a), Math.cos(dd) * Math.sin(a), Math.sin(dd)];
  const node = [-Math.sin(a), Math.cos(a), 0];
  const q = [pole[1] * node[2] - pole[2] * node[1], pole[2] * node[0] - pole[0] * node[2], pole[0] * node[1] - pole[1] * node[0]];
  const x = [0, 1, 2].map((i) => Math.cos(w) * node[i] + Math.sin(w) * q[i]);          // prime meridian on the equator
  const yb = [0, 1, 2].map((i) => -Math.sin(w) * node[i] + Math.cos(w) * q[i]);       // lon +90°
  // engine convention: (x, y, z) = (prime meridian, pole, -lon90)
  return [x[0], x[1], x[2], pole[0], pole[1], pole[2], -yb[0], -yb[1], -yb[2]];
}
export const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const applyT = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

export const BODIES = {
  sun: { name: 'Soleil', r: 696340e3, tex: 'sun.jpg', emissive: true },
  mercury: { name: 'Mercure', r: 2439.7e3, tex: 'mercury.jpg' },
  venus: { name: 'Vénus', r: 6051.8e3, tex: 'venus.jpg', atmo: [1.0, 0.85, 0.55] },
  earth: { name: 'Terre', r: 6371e3, tex: 'earthcolor.jpg', atmo: [0.35, 0.6, 1.0], terrain: true },
  moon: { name: 'Lune', r: 1737.4e3, tex: 'moon.jpg', terrain: true },
  mars: { name: 'Mars', r: 3389.5e3, tex: 'mars.jpg', atmo: [1.0, 0.62, 0.42], terrain: true },
  jupiter: { name: 'Jupiter', r: 69911e3, tex: 'jupiter.jpg' },
  saturn: { name: 'Saturne', r: 58232e3, tex: 'saturn.jpg', rings: [74500e3, 140220e3] },
  uranus: { name: 'Uranus', r: 25362e3, tex: 'uranus.jpg', atmo: [0.6, 0.9, 1.0] },
  neptune: { name: 'Neptune', r: 24622e3, tex: 'neptune.jpg', atmo: [0.4, 0.6, 1.0] },
};

// inertial positions of every body relative to the Sun, metres
export function positions(jd) {
  const out = { sun: [0, 0, 0] };
  for (const n of Object.keys(EL)) out[n] = planetHelio(n, jd);
  const m = moonGeo(jd);
  out.moon = [out.earth[0] + m[0], out.earth[1] + m[1], out.earth[2] + m[2]];
  return out;
}
export const PLANETS = Object.keys(EL);
