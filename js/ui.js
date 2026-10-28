// HUD and controls overlay. Talks to the engine only through the callbacks it is given.
const $ = (id) => document.getElementById(id);
const fr = (x, d = 0) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function initUI(o) {
  const body = document.body;
  let locked = false, photo = false, booted = false, isReady = false;

  // ---- compass tape: 3 turns of ticks so it can scroll without gaps
  const PX = 2.2;   // px per degree
  const tape = $('tape');
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
  let html = '';
  for (let d = -360; d <= 720; d += 5) {
    const x = (d + 360) * PX, a = ((d % 360) + 360) % 360;
    html += `<span class="${a % 15 === 0 ? 'maj' : ''}" style="left:${x}px"></span>`;
    if (a % 45 === 0) html += `<b class="${a % 90 === 0 ? 'card' : ''}" style="left:${x}px">${names[a]}</b>`;
    else if (a % 15 === 0) html += `<b style="left:${x}px">${a}</b>`;
  }
  tape.innerHTML = html;
  const compass = $('compass');

  // ---- mode, speed, time
  const modeBtns = [...document.querySelectorAll('#mode button')];
  modeBtns.forEach((b) => b.addEventListener('click', () => o.onMode(b.dataset.mode)));
  document.querySelectorAll('#speed button').forEach((b) => b.addEventListener('click', () => o.onSpeed(+b.dataset.sp)));
  const hour = $('hour');
  let draggingHour = false;
  hour.addEventListener('input', () => { draggingHour = true; o.onHour(+hour.value); });
  hour.addEventListener('change', () => { draggingHour = false; });
  $('orbit').addEventListener('click', () => o.onOrbit());
  $('photo').addEventListener('click', () => togglePhoto());
  $('fire').addEventListener('click', () => o.onFire && o.onFire());
  const weaponBtn = $('weapon');
  weaponBtn.addEventListener('click', () => o.onWeapon && o.onWeapon());
  function setWeapon(w) {
    const a = w === 'asteroid';
    weaponBtn.setAttribute('aria-pressed', String(a));
    weaponBtn.querySelector('use').setAttribute('href', a ? '#i-rock' : '#i-rocket');
    weaponBtn.title = a ? 'Arme : astéroïde (V pour changer)' : 'Arme : missile (V pour changer)';
  }
  $('clearCraters').addEventListener('click', () => o.onClearCraters && o.onClearCraters());

  // ---- full sheet
  const sheet = $('sheet'), more = $('more');
  function toggleSheet(force) {
    const open = force ?? sheet.hidden;
    sheet.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  }
  more.addEventListener('click', () => toggleSheet());
  const placesBox = $('places');
  for (const p of o.places) {
    const b = document.createElement('button');
    b.innerHTML = `<kbd>${p.key.replace('Digit', '')}</kbd>${p.name}`;
    b.addEventListener('click', () => o.onPlace(p));
    placesBox.appendChild(b);
  }
  const spaceBox = $('spacebox');
  for (const p of o.space || []) {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.addEventListener('click', () => o.onSpace(p));
    spaceBox.appendChild(b);
  }
  const marksBox = $('marks');
  for (const l of o.landmarks || []) {
    const b = document.createElement('button');
    b.textContent = l.name;
    b.addEventListener('click', () => o.onLandmark(l));
    marksBox.appendChild(b);
  }
  const cfgInputs = [...document.querySelectorAll('[data-cfg]')];
  cfgInputs.forEach((inp) => {
    inp.addEventListener('change', () => { o.onCfg(inp.dataset.cfg, inp.checked); syncCfg(); });
  });
  const mute = $('mute');
  function syncCfg() {
    cfgInputs.forEach((inp) => { inp.checked = !!o.cfg[inp.dataset.cfg]; });
    const on = !!o.cfg.sound;
    mute.setAttribute('aria-pressed', String(!on));
    mute.title = on ? 'Couper le son (M)' : 'Remettre le son (M)';
    mute.setAttribute('aria-label', on ? 'Couper le son' : 'Remettre le son');
    mute.querySelector('use').setAttribute('href', on ? '#i-sound' : '#i-mute');
  }
  mute.addEventListener('click', () => { o.onCfg('sound', !o.cfg.sound); syncCfg(); toast(o.cfg.sound ? 'Son activé' : 'Son coupé'); });
  syncCfg();
  const qBtns = [...document.querySelectorAll('#quality button')];
  const paintQ = () => qBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.q === o.cfg.quality)));
  qBtns.forEach((b) => b.addEventListener('click', () => { o.onCfg('quality', b.dataset.q); paintQ(); }));
  paintQ();

  // ---- search (OpenStreetMap Nominatim, on Enter only to respect its usage policy)
  const q = $('q'), results = $('results');
  let items = [], sel = -1, lastQuery = 0;
  function paintResults() {
    results.hidden = items.length === 0;
    results.innerHTML = items.map((r, i) => r.msg
      ? `<li class="msg">${r.msg}</li>`
      : `<li role="option" aria-selected="${i === sel}" data-i="${i}"><b>${esc(r.name)}</b>${esc(r.detail)}</li>`).join('');
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function search(text) {
    const now = Date.now();
    if (now - lastQuery < 1100) return;
    lastQuery = now;
    items = [{ msg: 'Recherche…' }]; paintResults();
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=fr&q=${encodeURIComponent(text)}`;
      const res = await (await fetch(url)).json();
      items = res.map((r) => {
        const bb = r.boundingbox.map(Number);
        const span = Math.max(bb[1] - bb[0], (bb[3] - bb[2]) * Math.cos(+r.lat * Math.PI / 180)) * 111e3;
        const parts = r.display_name.split(', ');
        return { name: parts[0], detail: parts.slice(1, 4).join(', '), lat: +r.lat, lon: +r.lon, alt: Math.max(300, Math.min(2.5e6, span * 0.9)) };
      });
      if (!items.length) items = [{ msg: `Aucun lieu trouvé pour « ${esc(text)} »` }];
      sel = items[0].msg ? -1 : 0;
    } catch (e) {
      items = [{ msg: 'Recherche indisponible : vérifiez la connexion.' }];
    }
    paintResults();
  }
  function pick(i) {
    const r = items[i];
    if (!r || r.msg) return;
    results.hidden = true;
    q.value = r.name;
    q.blur();
    o.onSearchPick(r);
  }
  q.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { if (sel >= 0 && items[sel] && !items[sel].msg && q.value === q.dataset.last) pick(sel); else { q.dataset.last = q.value; search(q.value.trim()); } }
    else if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); paintResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); paintResults(); e.preventDefault(); }
    else if (e.key === 'Escape') { results.hidden = true; q.blur(); }
  });
  q.addEventListener('keyup', (e) => e.stopPropagation());
  results.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(+li.dataset.i); });

  // ---- boot card
  const boot = $('boot'), go = $('go');
  go.addEventListener('click', () => { if (isReady) { dismissBoot(); o.onStart(); } });
  function dismissBoot() { if (!isReady || booted) return; booted = true; boot.classList.add('gone'); }

  // ---- transient messages
  let toastT = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1700); }
  function flash(msg) { const f = $('flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); toast(msg); }
  const hint = $('hint');
  let hintT = 0;
  function setLocked(v) {
    locked = v;
    body.classList.toggle('locked', v);
    hint.style.opacity = 1;
    hint.textContent = v ? 'Échap pour reprendre la souris' : 'Cliquez sur la scène pour piloter · glisser pour regarder';
    clearTimeout(hintT);
    hintT = setTimeout(() => { hint.style.opacity = 0; }, v ? 2500 : 6000);
    if (v) { toggleSheet(false); results.hidden = true; }
  }
  function togglePhoto() { photo = !photo; body.classList.toggle('photo', photo); }

  // ---- per-frame readouts (throttled)
  const el = { alt: $('r-alt'), altU: $('r-alt-u'), spd: $('r-spd'), spdU: $('r-spd-u'), sub: $('r-sub'), where: $('where'), spmul: $('spmul'), hourv: $('hourv'), stats: $('stats'), cdeg: $('cdeg') };
  let acc = 0, fpsN = 0, fpsT = 0, fps = 0;
  function update(dt, r) {
    tape.style.transform = `translateX(${compass.clientWidth / 2 - (r.heading + 360) * PX}px)`;
    fpsN++; fpsT += dt;
    if (fpsT > 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
    acc += dt;
    if (acc < 0.12) return;
    acc = 0;
    const a = r.alt;
    if (a >= 1.5e10) { el.alt.textContent = fr(a / 1.495978707e11, 2); el.altU.textContent = 'UA'; }
    else if (a >= 10000) { el.alt.textContent = fr(a / 1000, a >= 100000 ? 0 : 1); el.altU.textContent = 'km'; }
    else { el.alt.textContent = fr(Math.round(a)); el.altU.textContent = 'm'; }
    // speed: km/h near the ground, km/s in orbit, multiples of the speed of light between planets
    const c = 299792458;
    if (r.speed > 0.05 * c) { el.spd.textContent = fr(r.speed / c, r.speed > 10 * c ? 0 : 2); el.spdU.textContent = '× c'; }
    else if (r.speed > 2000) { el.spd.textContent = fr(r.speed / 1000, r.speed > 1e5 ? 0 : 1); el.spdU.textContent = 'km/s'; }
    else { el.spd.textContent = fr(Math.round(r.speed * 3.6)); el.spdU.textContent = 'km/h'; }
    const mach = r.speed / (r.speedOfSound || 343);
    const altTxt = r.altSea > 1.5e10 ? `${fr(r.sunDist / 1.495978707e11, 2)} UA du Soleil` : r.altSea > 1e7 ? `${fr(Math.round(r.altSea / 1000))} km` : `${fr(Math.round(r.altSea))} m`;
    const air = r.air > 0.01;
    const machTxt = air ? `${mach >= 1 ? '<b>' : ''}Mach ${fr(mach, 2)}${mach >= 1 ? '</b>' : ''} · ` : '';
    const windTxt = air ? ` · vent ${fr(Math.round(r.wind * 3.6))} km/h` : '';
    const date = r.date ? r.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    el.sub.innerHTML = `<b class="body">${r.body || 'Terre'}</b> · ${machTxt}${altTxt}${windTxt} · ${date}`;
    el.cdeg.textContent = `${Math.round(r.heading) % 360}°`;
    el.where.textContent = `${fr(Math.abs(r.lat), 4)}° ${r.lat >= 0 ? 'N' : 'S'}  ${fr(Math.abs(r.lon), 4)}° ${r.lon >= 0 ? 'E' : 'O'}`;
    modeBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === r.mode)));
    el.spmul.textContent = `×${fr(r.speedMul, r.speedMul < 1 ? 2 : 1)}`;
    if (!draggingHour) hour.value = r.hour;
    const hh = Math.floor(r.hour), mm = Math.floor((r.hour - hh) * 60);
    el.hourv.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    el.stats.textContent = `${Math.round(fps)} i/s · ${r.chunks} tuiles${r.cityTiles ? ` · ${r.cityTiles} quartiers 3D` : ''}${r.pending ? ` · ${r.pending} en chargement` : ''}`;
  }

  setLocked(false);
  return {
    toast, flash, setLocked, toggleSheet, togglePhoto, dismissBoot, update, syncCfg, setWeapon,
    focusSearch: () => { if (photo) togglePhoto(); q.focus(); q.select(); },
    status: (s) => { $('status').textContent = s; },
    progress: (p) => { $('prog').style.width = `${Math.round(p * 100)}%`; },
    ready: () => { isReady = true; go.disabled = false; $('status').textContent = 'Décoller'; $('prog').style.width = '100%'; body.classList.add('ready'); },
  };
}
