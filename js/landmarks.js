// Hand-modelled Paris landmarks, built procedurally to their real dimensions.
// Local frame: x along `heading` (degrees from north, clockwise), y up, z = x × up. Units: metres.
// Vertex attribute aL = (u across the face 0..1, v height in m, face width in m, material kind):
//   0 stone/metal   1 Eiffel lattice (cut out in the shader)   2 glass curtain wall
//   3 lead/zinc roof   4 gilded   5 glass pyramid (framed panes)
import * as THREE from 'three';

const lin = (r, g, b) => [Math.pow(r / 255, 2.2), Math.pow(g / 255, 2.2), Math.pow(b / 255, 2.2)];
const STONE = lin(222, 210, 186), WHITE = lin(238, 234, 224), LEAD = lin(96, 104, 112), IRON = lin(84, 66, 50);
const GOLD = lin(214, 170, 80), GLASS = lin(62, 74, 88), DARK = lin(70, 66, 60);

class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.l = []; this.i = []; this.o = []; }
  v(p, n, c, l) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2]); this.l.push(l[0], l[1], l[2], l[3]);
    return this.p.length / 3 - 1;
  }
  // quad a,b,c,d (a-b along the bottom, d-c along the top); normal oriented away from `ref`
  quad(a, b, c, d, col, kind, ref, uv = [0, 1], width = null) {
    const e1 = sub(b, a), e2 = sub(d, a);
    let n = norm(cross(e1, e2));
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
    if (ref && dot(n, sub(mid, ref)) < 0) n = [-n[0], -n[1], -n[2]];
    const w = width ?? len(e1);
    const i0 = this.v(a, n, col, [uv[0], a[1], w, kind]), i1 = this.v(b, n, col, [uv[1], b[1], w, kind]);
    const i2 = this.v(c, n, col, [uv[1], c[1], w, kind]), i3 = this.v(d, n, col, [uv[0], d[1], w, kind]);
    this.i.push(i0, i1, i2, i0, i2, i3);
  }
  tri(a, b, c, col, kind, ref) {
    let n = norm(cross(sub(b, a), sub(c, a)));
    const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (ref && dot(n, sub(mid, ref)) < 0) n = [-n[0], -n[1], -n[2]];
    const w = len(sub(b, a));
    const i0 = this.v(a, n, col, [0, a[1], w, kind]), i1 = this.v(b, n, col, [1, b[1], w, kind]), i2 = this.v(c, n, col, [0.5, c[1], w, kind]);
    this.i.push(i0, i1, i2);
  }
  box(x0, x1, y0, y1, z0, z1, col, kind = 0, sideKind = kind) {
    const ref = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const P = (x, y, z) => [x, y, z];
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), col, sideKind, ref);
    this.quad(P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1), P(x1, y1, z1), col, sideKind, ref);
    this.quad(P(x0, y0, z1), P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), col, sideKind, ref);
    this.quad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), col, sideKind, ref);
    this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), col, kind === 1 ? 0 : kind, ref);
  }
  // rectangular tube through sections [{y, x0, x1, z0, z1}]
  tube(sec, col, kind, capTop = false) {
    for (let s = 0; s + 1 < sec.length; s++) {
      const A = sec[s], B = sec[s + 1];
      const ref = [(A.x0 + A.x1 + B.x0 + B.x1) / 4, (A.y + B.y) / 2, (A.z0 + A.z1 + B.z0 + B.z1) / 4];
      this.quad([A.x0, A.y, A.z0], [A.x1, A.y, A.z0], [B.x1, B.y, B.z0], [B.x0, B.y, B.z0], col, kind, ref, [0, 1], A.x1 - A.x0);
      this.quad([A.x1, A.y, A.z1], [A.x0, A.y, A.z1], [B.x0, B.y, B.z1], [B.x1, B.y, B.z1], col, kind, ref, [0, 1], A.x1 - A.x0);
      this.quad([A.x0, A.y, A.z1], [A.x0, A.y, A.z0], [B.x0, B.y, B.z0], [B.x0, B.y, B.z1], col, kind, ref, [0, 1], A.z1 - A.z0);
      this.quad([A.x1, A.y, A.z0], [A.x1, A.y, A.z1], [B.x1, B.y, B.z1], [B.x1, B.y, B.z0], col, kind, ref, [0, 1], A.z1 - A.z0);
    }
    if (capTop) {
      const T = sec[sec.length - 1];
      this.quad([T.x0, T.y, T.z0], [T.x1, T.y, T.z0], [T.x1, T.y, T.z1], [T.x0, T.y, T.z1], col, 0, [(T.x0 + T.x1) / 2, T.y - 1, (T.z0 + T.z1) / 2]);
    }
  }
  cyl(cx, cz, rx, rz, y0, y1, seg, col, kind = 0, topScale = 1, cap = true) {
    const ref = [cx, (y0 + y1) / 2, cz];
    const circ = 2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2);
    for (let k = 0; k < seg; k++) {
      const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
      const p = (a, s, y) => [cx + Math.cos(a) * rx * s, y, cz + Math.sin(a) * rz * s];
      this.quad(p(a0, 1, y0), p(a1, 1, y0), p(a1, topScale, y1), p(a0, topScale, y1), col, kind, ref, [k / seg, (k + 1) / seg], circ);
      if (cap && topScale > 0) this.tri(p(a0, topScale, y1), p(a1, topScale, y1), [cx, y1, cz], col, 0, [cx, y1 - 1, cz]);
    }
  }
  dome(cx, cy, cz, rx, ry, rz, seg, col, kind = 0, rings = 8, pointed = 0) {
    const ref = [cx, cy, cz];
    for (let r = 0; r < rings; r++) {
      const t0 = r / rings * Math.PI / 2, t1 = (r + 1) / rings * Math.PI / 2;
      for (let k = 0; k < seg; k++) {
        const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
        const p = (a, t) => {
          const s = Math.cos(t) * (1 - pointed * Math.pow(Math.sin(t), 4) * 0.3);
          return [cx + Math.cos(a) * rx * s, cy + Math.sin(t) * ry, cz + Math.sin(a) * rz * s];
        };
        this.quad(p(a0, t0), p(a1, t0), p(a1, t1), p(a0, t1), col, kind, ref, [k / seg, (k + 1) / seg], 2 * Math.PI * rx);
      }
    }
  }
  pyramid(cx, cz, hx, hz, y0, y1, col, kind = 0) {
    const ref = [cx, y0, cz];
    const c = [[cx - hx, y0, cz - hz], [cx + hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx - hx, y0, cz + hz]];
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      // two triangles so the pane grid can use u across the face
      this.quad(a, b, [cx + (b[0] - cx) * 0.001, y1, cz + (b[2] - cz) * 0.001], [cx + (a[0] - cx) * 0.001, y1, cz + (a[2] - cz) * 0.001], col, kind, ref, [0, 1], len(sub(b, a)));
    }
  }
  // roof ridge along x between z0..z1
  gableX(x0, x1, z0, z1, y0, y1, col) {
    const zm = (z0 + z1) / 2, ref = [(x0 + x1) / 2, y0, zm];
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, zm], [x0, y1, zm], col, 3, ref);
    this.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, zm], [x1, y1, zm], col, 3, ref);
    this.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zm], STONE, 0, ref);
    this.tri([x1, y0, z1], [x1, y0, z0], [x1, y1, zm], STONE, 0, ref);
  }
  gableZ(x0, x1, z0, z1, y0, y1, col) {
    const xm = (x0 + x1) / 2, ref = [xm, y0, (z0 + z1) / 2];
    this.quad([x0, y0, z1], [x0, y0, z0], [xm, y1, z0], [xm, y1, z1], col, 3, ref);
    this.quad([x1, y0, z0], [x1, y0, z1], [xm, y1, z1], [xm, y1, z0], col, 3, ref);
    this.tri([x0, y0, z0], [x1, y0, z0], [xm, y1, z0], STONE, 0, ref);
    this.tri([x1, y0, z1], [x0, y0, z1], [xm, y1, z1], STONE, 0, ref);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aL', new THREE.Float32BufferAttribute(this.l, 4));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------ Tour Eiffel (330 m)
function eiffel() {
  const b = new Builder();
  const w = (y) => Math.max(4.6, 62.5 * Math.exp(-y / 101));              // outer half-width
  const wi = (y) => 37.5 * Math.pow(Math.max(0, 1 - y / 115), 1.25);     // inner edge of the legs
  // four legs, curving in until they merge at the second floor
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const sec = [];
    for (let k = 0; k <= 14; k++) {
      const y = 115 * Math.pow(k / 14, 1.1);
      const a = wi(y), o = w(y);
      sec.push({ y, x0: sx > 0 ? a : -o, x1: sx > 0 ? o : -a, z0: sz > 0 ? a : -o, z1: sz > 0 ? o : -a });
    }
    b.tube(sec, IRON, 1);
    // stone pier under each leg
    const a = wi(0), o = w(0);
    b.box(sx > 0 ? a : -o, sx > 0 ? o : -a, -2, 3, sz > 0 ? a : -o, sz > 0 ? o : -a, lin(150, 140, 120), 0);
  }
  // the upper shaft
  const shaft = [];
  for (let k = 0; k <= 12; k++) { const y = 115 + (276 - 115) * k / 12; const o = w(y); shaft.push({ y, x0: -o, x1: o, z0: -o, z1: o }); }
  b.tube(shaft, IRON, 1);
  // decorative arches under the first floor
  const D = 41;
  for (let side = 0; side < 4; side++) {
    const pts = [];
    for (let k = 0; k <= 20; k++) {
      const t = k / 20 * Math.PI;
      pts.push([Math.cos(t) * 34, 12 + Math.sin(t) * 38, Math.cos(t) * 37, 12 + Math.sin(t) * 41.5]);
    }
    for (let k = 0; k < 20; k++) {
      const [x0, y0, X0, Y0] = pts[k], [x1, y1, X1, Y1] = pts[k + 1];
      const map = (x, y) => (side === 0 ? [x, y, D] : side === 1 ? [x, y, -D] : side === 2 ? [D, y, x] : [-D, y, x]);
      b.quad(map(x0, y0), map(x1, y1), map(X1, Y1), map(X0, Y0), IRON, 1, [0, 30, 0], [k / 20, (k + 1) / 20], 3.4);
    }
  }
  // platforms and their galleries
  const deck = (y, h, gal) => {
    const o = w(y) + 1.5;
    b.box(-o, o, y, y + h, -o, o, IRON, 0);
    b.tube([{ y: y + h, x0: -o, x1: o, z0: -o, z1: o }, { y: y + h + gal, x0: -o, x1: o, z0: -o, z1: o }], IRON, 1);
  };
  deck(57, 6, 4.5);
  deck(115.7, 4.5, 4);
  // top: campanile, lantern and antennas
  b.box(-7.5, 7.5, 276, 281, -7.5, 7.5, IRON, 0);
  b.tube([{ y: 281, x0: -6, x1: 6, z0: -6, z1: 6 }, { y: 289, x0: -4.5, x1: 4.5, z0: -4.5, z1: 4.5 }], IRON, 1);
  b.cyl(0, 0, 2.6, 2.6, 289, 300, 12, IRON, 0, 0.75);
  b.cyl(0, 0, 1.2, 1.2, 300, 330, 8, lin(200, 196, 190), 0, 0.35);
  return { geo: b.build(), height: 330 };
}

// ------------------------------------------------------------------ Arc de Triomphe (50 m)
function arc() {
  const b = new Builder();
  const W = 22.5, Dz = 11, H = 50;
  // two piers, each pierced by the small transverse arch
  for (const s of [-1, 1]) {
    const xa = s * 7.3, xb = s * W;
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    b.box(x0, x1, 0, 18.7, -Dz, -4.2, STONE, 0);
    b.box(x0, x1, 0, 18.7, 4.2, Dz, STONE, 0);
    b.box(x0, x1, 18.7, 29.2, -Dz, Dz, STONE, 0);
  }
  // vault over the great arch (stepped), entablature, attic
  b.box(-7.3, -4.5, 29.2, 33, -Dz, Dz, STONE, 0);
  b.box(4.5, 7.3, 29.2, 33, -Dz, Dz, STONE, 0);
  b.box(-4.5, 4.5, 31.8, 33, -Dz, Dz, STONE, 0);
  b.box(-W, W, 33, 37.5, -Dz, Dz, STONE, 0);
  b.box(-W - 0.6, W + 0.6, 37.5, 39.5, -Dz - 0.6, Dz + 0.6, lin(206, 194, 170), 0);   // cornice
  b.box(-W, W, 39.5, H, -Dz, Dz, STONE, 0);
  b.box(-W - 0.4, W + 0.4, H - 1.2, H, -Dz - 0.4, Dz + 0.4, lin(206, 194, 170), 0);
  return { geo: b.build(), height: H };
}

// ------------------------------------------------------------------ Notre-Dame (towers 69 m, spire 96 m)
function notreDame() {
  const b = new Builder();
  const X = (x) => x - 63;   // centre the 127 m long building on its origin
  b.box(X(0), X(12), 0, 43, -20, 20, STONE, 0);                          // west facade
  b.box(X(0), X(12), 43, 69, -20, -6, STONE, 0);                         // towers
  b.box(X(0), X(12), 43, 69, 6, 20, STONE, 0);
  b.box(X(-0.5), X(12.5), 68, 69.5, -20.5, -5.5, lin(206, 194, 170), 0);
  b.box(X(-0.5), X(12.5), 68, 69.5, 5.5, 20.5, lin(206, 194, 170), 0);
  b.box(X(0), X(12), 43, 46, -6, 6, STONE, 0);                           // gallery between the towers
  b.box(X(12), X(100), 0, 33, -6.5, 6.5, STONE, 0);                      // nave
  b.gableX(X(12), X(100), -6.5, 6.5, 33, 43, LEAD);
  b.box(X(12), X(100), 0, 20, -20, -6.5, STONE, 0);                      // aisles
  b.box(X(12), X(100), 0, 20, 6.5, 20, STONE, 0);
  b.box(X(12), X(100), 20, 22, -20, -6.5, LEAD, 3);
  b.box(X(12), X(100), 20, 22, 6.5, 20, LEAD, 3);
  b.box(X(58), X(72), 0, 33, -24, 24, STONE, 0);                         // transept
  b.gableZ(X(58), X(72), -24, 24, 33, 43, LEAD);
  b.cyl(X(100), 0, 12, 12, 0, 33, 16, STONE, 0, 1, false);                // apse
  b.dome(X(100), 33, 0, 12, 8, 12, 16, LEAD, 3, 5);
  b.cyl(X(100), 0, 20, 20, 0, 20, 18, STONE, 0, 1, false);
  b.dome(X(100), 20, 0, 20, 5, 20, 18, LEAD, 3, 4);
  // flying buttresses along the nave
  for (let k = 0; k < 8; k++) for (const s of [-1, 1]) {
    const x = X(18 + k * 11);
    b.box(x - 0.8, x + 0.8, 0, 26, s * 20, s * 24, STONE, 0);
    b.quad([x - 0.6, 26, s * 22], [x + 0.6, 26, s * 22], [x + 0.6, 31, s * 7], [x - 0.6, 31, s * 7], STONE, 0, [x, 0, 0]);
  }
  b.pyramid(X(65), 0, 3, 3, 43, 96, LEAD, 3);                             // spire
  b.cyl(X(65), 0, 3.4, 3.4, 43, 52, 8, LEAD, 3, 0.85, false);
  return { geo: b.build(), height: 96 };
}

// ------------------------------------------------------------------ Sacré-Cœur (83 m, on Montmartre)
function sacreCoeur() {
  const b = new Builder();
  b.box(-30, 32, 0, 27, -18, 18, WHITE, 0);
  b.box(-40, -30, 0, 21, -14, 14, WHITE, 0);                               // portico
  for (let k = 0; k < 3; k++) b.box(-41, -40, 0, 21, -10 + k * 10 - 1.2, -10 + k * 10 + 1.2, WHITE, 0);
  b.cyl(0, 0, 10.5, 10.5, 27, 50, 24, WHITE, 0, 1, false);                 // drum
  b.dome(0, 50, 0, 10.5, 18, 10.5, 24, WHITE, 0, 10, 1);                   // ovoid main dome
  b.cyl(0, 0, 2.6, 2.6, 67, 76, 12, WHITE, 0, 1, false);                   // lantern
  b.dome(0, 76, 0, 2.6, 5, 2.6, 12, WHITE, 0, 5, 1);
  b.cyl(0, 0, 0.3, 0.3, 80.5, 83.5, 4, GOLD, 4, 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx * 19, cz = sz * 12;
    b.cyl(cx, cz, 4.2, 4.2, 27, 38, 14, WHITE, 0, 1, false);
    b.dome(cx, 38, cz, 4.2, 7, 4.2, 14, WHITE, 0, 6, 1);
  }
  b.box(30, 41, 0, 66, -5.5, 5.5, WHITE, 0);                                // campanile
  b.cyl(35.5, 0, 4.4, 4.4, 66, 72, 12, WHITE, 0, 1, false);
  b.dome(35.5, 72, 0, 4.4, 9, 4.4, 12, WHITE, 0, 6, 1);
  return { geo: b.build(), height: 84 };
}

// ------------------------------------------------------------------ Tour Montparnasse (210 m)
function montparnasse() {
  const b = new Builder();
  b.cyl(0, 0, 25, 16, 0, 196, 32, GLASS, 2, 1, true);
  b.cyl(0, 0, 23.5, 14.5, 196, 210, 32, DARK, 0, 1, true);
  b.box(-35, 35, 0, 8, -26, 26, lin(150, 150, 150), 0);
  return { geo: b.build(), height: 210 };
}

// ------------------------------------------------------------------ Pyramide du Louvre (21.6 m)
function pyramide() {
  const b = new Builder();
  b.pyramid(0, 0, 17.7, 17.7, 0, 21.6, GLASS, 5);
  for (const [x, z, s] of [[30, 0, 4.5], [-30, 0, 4.5], [0, 30, 4.5]]) b.pyramid(x, z, s, s, 0, 5.5, GLASS, 5);
  return { geo: b.build(), height: 22 };
}

// ------------------------------------------------------------------ Grande Arche de la Défense (110 m)
function grandeArche() {
  const b = new Builder();
  b.box(-54, -35, 0, 110, -56, 56, WHITE, 0, 2);
  b.box(35, 54, 0, 110, -56, 56, WHITE, 0, 2);
  b.box(-35, 35, 93, 110, -56, 56, WHITE, 0, 2);
  b.box(-35, 35, 0, 7, -56, 56, WHITE, 0);
  b.box(-70, 70, -2, 0.5, -90, 90, lin(200, 196, 188), 0);
  return { geo: b.build(), height: 110 };
}

export const LANDMARKS = [
  { id: 'eiffel', name: 'Tour Eiffel', lat: 48.85826, lon: 2.29450, heading: 44, r: 85, build: eiffel, lit: true },
  { id: 'arc', name: 'Arc de Triomphe', lat: 48.87378, lon: 2.29504, heading: 26, r: 36, build: arc },
  { id: 'notredame', name: 'Notre-Dame de Paris', lat: 48.85296, lon: 2.34990, heading: 110, r: 75, build: notreDame },
  { id: 'sacrecoeur', name: 'Sacré-Cœur', lat: 48.88671, lon: 2.34312, heading: 0, r: 55, build: sacreCoeur },
  { id: 'montparnasse', name: 'Tour Montparnasse', lat: 48.84210, lon: 2.32202, heading: 30, r: 42, build: montparnasse },
  { id: 'pyramide', name: 'Pyramide du Louvre', lat: 48.86098, lon: 2.33585, heading: 26, r: 24, build: pyramide },
  { id: 'arche', name: 'Grande Arche', lat: 48.89257, lon: 2.23620, heading: 32, r: 72, build: grandeArche },
];
