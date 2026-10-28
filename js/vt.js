// Minimal Mapbox Vector Tile (protobuf) decoder: only what the city builder needs.
// Returns { layerName: { extent, features: [{ type, props, rings }] } } for the requested layers.
// Polygons come back as a list of polygons, each a list of rings ([x0,y0,x1,y1,...]), outer ring first.

export function decodeMVT(buffer, wanted) {
  const b = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let p = 0;
  const varint = () => {
    let r = 0, s = 1, x;
    do { x = b[p++]; r += (x & 0x7f) * s; s *= 128; } while (x & 0x80);
    return r;
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) p += 8;
    else if (wire === 2) p += varint();
    else if (wire === 5) p += 4;
  };
  const str = (end) => new TextDecoder().decode(b.subarray(p, end));

  const out = {};
  while (p < b.length) {
    const tag = varint();
    if ((tag >> 3) !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
    const len = varint(), end = p + len;
    // ---- layer
    let name = '', extent = 4096;
    const keys = [], values = [], raw = [];
    while (p < end) {
      const t = varint(), f = t >> 3, w = t & 7;
      if (f === 1 && w === 2) { const l = varint(); name = str(p + l); p += l; }
      else if (f === 2 && w === 2) { const l = varint(); raw.push([p, p + l]); p += l; }
      else if (f === 3 && w === 2) { const l = varint(); keys.push(str(p + l)); p += l; }
      else if (f === 4 && w === 2) {
        const l = varint(), ve = p + l;
        let v = null;
        while (p < ve) {
          const vt = varint(), vf = vt >> 3;
          if (vf === 1) { const sl = varint(); v = str(p + sl); p += sl; }
          else if (vf === 2) { v = dv.getFloat32(p, true); p += 4; }
          else if (vf === 3) { v = dv.getFloat64(p, true); p += 8; }
          else if (vf === 4 || vf === 5) v = varint();
          else if (vf === 6) { const z = varint(); v = z % 2 ? -(z + 1) / 2 : z / 2; }
          else if (vf === 7) v = !!varint();
          else skip(vt & 7);
        }
        values.push(v);
      }
      else if (f === 5 && w === 0) extent = varint();
      else skip(w);
    }
    p = end;
    if (!wanted.includes(name)) continue;

    // ---- features of this layer
    const features = [];
    for (const [fs, fe] of raw) {
      p = fs;
      let type = 0, tags = null, geom = null;
      while (p < fe) {
        const t = varint(), f = t >> 3, w = t & 7;
        if (f === 2 && w === 2) { const l = varint(), e = p + l; tags = []; while (p < e) tags.push(varint()); }
        else if (f === 3 && w === 0) type = varint();
        else if (f === 4 && w === 2) { const l = varint(), e = p + l; geom = []; while (p < e) geom.push(varint()); }
        else skip(w);
      }
      if (!geom) continue;
      const props = {};
      if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      features.push({ type, props, rings: geometry(geom, type) });
    }
    p = end;
    out[name] = { extent, features };
  }
  return out;
}

const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function geometry(g, type) {
  const lines = [];
  let x = 0, y = 0, cur = null, i = 0;
  while (i < g.length) {
    const c = g[i++], id = c & 7, n = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < n; k++) {
        x += zz(g[i++]); y += zz(g[i++]);
        if (id === 1) { cur = [x, y]; lines.push(cur); } else cur.push(x, y);
      }
    } else if (id === 7) { /* ClosePath: rings are implicitly closed */ }
  }
  if (type !== 3) return lines;
  // group rings into polygons: positive signed area = outer ring (MVT spec), negative = hole
  const polys = [];
  for (const r of lines) {
    if (r.length < 6) continue;
    let a = 0;
    for (let k = 0, n = r.length; k < n; k += 2) {
      const j = (k + 2) % n;
      a += r[k] * r[j + 1] - r[j] * r[k + 1];
    }
    if (a > 0 || !polys.length) polys.push([r]);
    else polys[polys.length - 1].push(r);
  }
  return polys;
}
