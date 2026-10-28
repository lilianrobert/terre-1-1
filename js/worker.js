import { setData } from './terrain-core.js';
import { buildChunk } from './chunk.js';
import { setBodyTex } from './bodies.js';
import { setCraters } from './craters.js';

const cancelled = new Set();
let cityMod = null;   // loaded on first use (pulls earcut from the CDN)

async function city(m) {
  if (!cityMod) cityMod = import('./city.js');
  const { buildCity } = await cityMod;
  const r = await buildCity(m.z, m.x, m.y, m.opts, () => cancelled.has(m.id));
  cancelled.delete(m.id);
  if (!r) { self.postMessage({ type: 'city', id: m.id, cancelled: true }); return; }
  r.type = 'city';
  r.id = m.id;
  const transfer = [];
  if (r.bld) transfer.push(r.bld.pos.buffer, r.bld.nrm.buffer, r.bld.col.buffer, r.bld.fac.buffer, r.bld.idx.buffer);
  if (r.blocks) for (const b of r.blocks) { if (b.broad) transfer.push(b.broad.buffer); if (b.con) transfer.push(b.con.buffer); }
  self.postMessage(r, transfer);
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    setData(m.data, m.dw, m.dh, m.color, m.cw, m.ch);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type === 'bodyData') { setBodyTex(m.id, m.data, m.w, m.h); return; }
  if (m.type === 'craters') { setCraters(m.list); return; }
  if (m.type === 'city') {
    try { await city(m); } catch (err) {
      cancelled.delete(m.id);
      self.postMessage({ type: 'city', id: m.id, error: String(err && err.stack || err) });
    }
    return;
  }
  try {
    const r = await buildChunk(m.face, m.x0, m.y0, m.size, m.level, () => cancelled.has(m.id), m.body);
    cancelled.delete(m.id);
    if (!r) { self.postMessage({ type: 'chunk', id: m.id, cancelled: true }); return; }
    r.type = 'chunk';
    r.id = m.id;
    r.body = m.body;
    const transfer = [r.pos.buffer, r.nrm.buffer, r.uv.buffer, r.hv.buffer, r.tex.buffer];
    if (r.opos) transfer.push(r.opos.buffer);
    self.postMessage(r, transfer);
  } catch (err) {
    cancelled.delete(m.id);
    self.postMessage({ type: 'chunk', id: m.id, error: String(err && err.stack || err) });
  }
};
