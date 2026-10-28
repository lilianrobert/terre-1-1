// Tree models for one unit of height. Two kinds (broadleaf, conifer) and two levels of detail.
// Each vertex carries a baked ambient-occlusion term so crowns read as volumes, not blobs.
import * as THREE from 'three';
import { snoise } from './terrain-core.js';

function merge(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.g.attributes.position.count; ni += p.g.index ? p.g.index.count : p.g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), ao = new Float32Array(nv), wood = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const { g, aoFn, isWood } of parts) {
    const P = g.attributes.position, Nn = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      pos[(ov + i) * 3] = P.getX(i); pos[(ov + i) * 3 + 1] = P.getY(i); pos[(ov + i) * 3 + 2] = P.getZ(i);
      nrm[(ov + i) * 3] = Nn.getX(i); nrm[(ov + i) * 3 + 1] = Nn.getY(i); nrm[(ov + i) * 3 + 2] = Nn.getZ(i);
      ao[ov + i] = aoFn ? aoFn(P.getX(i), P.getY(i), P.getZ(i)) : 1;
      wood[ov + i] = isWood ? 1 : 0;
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) idx[oi + k] = g.index.getX(k) + ov;
    else for (let k = 0; k < P.count; k++) idx[oi + k] = k + ov;
    ov += P.count; oi += g.index ? g.index.count : P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  out.setAttribute('wood', new THREE.BufferAttribute(wood, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// a lumpy sphere: noise-displaced icosphere with smooth normals
function blob(cx, cy, cz, rx, ry, rz, detail, seed) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  // merge duplicated vertices so displacement keeps the surface closed
  const key = (i) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const map = new Map(), verts = [], index = [];
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let id = map.get(k);
    if (id === undefined) { id = verts.length / 3; map.set(k, id); verts.push(p.getX(i), p.getY(i), p.getZ(i)); }
    index.push(id);
  }
  const pos = new Float32Array(verts.length), nrm = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    const d = 1 + 0.22 * snoise(x * 1.7 + seed, y * 1.7, z * 1.7) + 0.1 * snoise(x * 4 + seed, y * 4, z * 4);
    pos[i] = cx + x * rx * d; pos[i + 1] = cy + y * ry * d; pos[i + 2] = cz + z * rz * d;
    const nl = Math.hypot(x / rx, y / ry, z / rz);
    nrm[i] = x / rx / nl; nrm[i + 1] = y / ry / nl; nrm[i + 2] = z / rz / nl;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setIndex(index);
  return out;
}

function trunk(r0, r1, h, seg) {
  return new THREE.CylinderGeometry(r1, r0, h, seg, 1, true).translate(0, h / 2, 0);
}

// occlusion: darker low and towards the core of the crown
const crownAO = (cy, r) => (x, y, z) => {
  const out = Math.min(1, Math.hypot(x, (y - cy) * 0.8, z) / r);
  return Math.max(0.25, Math.min(1, 0.35 + 0.45 * out + 0.4 * (y - cy) / r));
};

export function treeGeometries() {
  // broadleaf: a cluster of lumps over a tapering trunk
  const lumps = [
    [0, 0.64, 0, 0.3, 0.26, 0.3], [0.17, 0.56, 0.06, 0.2, 0.18, 0.2], [-0.15, 0.58, -0.08, 0.21, 0.19, 0.2],
    [0.04, 0.78, 0.12, 0.19, 0.16, 0.18], [-0.06, 0.52, 0.17, 0.18, 0.16, 0.17], [0.08, 0.5, -0.17, 0.18, 0.15, 0.17],
  ];
  const broadHi = merge([
    { g: trunk(0.045, 0.028, 0.6, 6), isWood: true, aoFn: (x, y) => 0.45 + 0.5 * (1 - y / 0.6) },
    ...lumps.map((l, i) => ({ g: blob(l[0], l[1], l[2], l[3], l[4], l[5], 1, i * 3.1), aoFn: crownAO(0.62, 0.38) })),
  ]);
  const broadLo = merge([
    { g: blob(0, 0.63, 0, 0.34, 0.3, 0.34, 0, 0.5), aoFn: crownAO(0.62, 0.36) },
  ]);

  // conifer: stacked drooping tiers
  const tiers = [];
  for (let t = 0; t < 5; t++) {
    const y = 0.14 + t * 0.16, r = 0.27 * (1 - t * 0.17), h = 0.3 - t * 0.02;
    const c = new THREE.ConeGeometry(r, h, 10, 1, false).translate(0, y + h / 2, 0);
    const p = c.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < y + 0.01) p.setY(i, y - 0.035 + 0.02 * Math.sin(i * 2.3));   // droop the skirt
    c.computeVertexNormals();
    tiers.push({ g: c, aoFn: (x, yy) => 0.45 + 0.55 * Math.min(1, (yy - 0.1) / 0.85) * (0.6 + 0.4 * Math.hypot(x, 0) / r) });
  }
  const conHi = merge([{ g: trunk(0.035, 0.02, 0.5, 5), isWood: true, aoFn: () => 0.5 }, ...tiers]);
  const conLo = merge([
    { g: new THREE.ConeGeometry(0.25, 0.9, 6, 1, false).translate(0, 0.55, 0), aoFn: (x, y) => 0.5 + 0.5 * (y - 0.1) / 0.9 },
  ]);
  return { broadHi, broadLo, conHi, conLo };
}
