// Interkom – Reżyseria (mikser wideo Blackmagic ATEM): widok dla roli „Reżyser”.
// Połączenie z mikserem ma serwer; strona tylko pokazuje stan (WebSocket „mixer”) i wysyła polecenia (/api/mixer/*).
// Serwer sprawdza rolę przy każdym poleceniu – ukrycie widoku to tylko wygoda.

const TR = { cut: 'Cut', mix: 'Mix', dip: 'Dip', wipe: 'Wipe' };
const KINDS = ['cut', 'mix', 'dip', 'wipe'];
const STATUS = { connected: 'Połączono', connecting: 'Łączenie…', reconnecting: 'Brak połączenia – łączę ponownie…', disconnected: 'Rozłączono' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 2) => Number(n).toLocaleString('pl-PL', { maximumFractionDigits: d });
const time = (t) => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function createDirector({ token, onOpenChange }) {
  const M = { st: null, perm: null, open: false, local: null, saveT: null, offset: 0, busy: false };
  const root = document.getElementById('director');
  const btn = document.getElementById('btnDirector');
  const main = document.getElementById('main');

  async function api(path, method = 'POST', body) {
    try {
      const r = await fetch('/api/mixer/' + path, {
        method, headers: { authorization: 'Bearer ' + token(), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) note(j.error || `Błąd (${r.status})`, true);
      else if (j.message) note(j.message);
      return j;
    } catch { note('Brak łączności z serwerem', true); return { ok: false }; }
  }

  let noteT;
  function note(msg, err) {
    const el = root.querySelector('.dr-note');
    if (!el) return;
    el.textContent = msg;
    el.className = 'dr-note' + (err ? ' err' : '');
    el.hidden = false;
    clearTimeout(noteT);
    noteT = setTimeout(() => (el.hidden = true), err ? 6000 : 3500);
  }

  // ---------- widoczność ----------
  const allowed = () => !!(M.perm?.director && M.perm?.mixer && M.st);
  function setOpen(v) {
    M.open = v && allowed();
    root.hidden = !M.open;
    main.classList.toggle('directing', M.open);
    btn.classList.toggle('on', M.open);
    btn.setAttribute('aria-pressed', String(M.open));
    if (M.open) render();
    onOpenChange?.(M.open);
  }
  btn.onclick = () => setOpen(!M.open);
  function updateButton() {
    btn.hidden = !allowed();
    if (!allowed() && M.open) setOpen(false);
  }

  // ---------- szkielet widoku ----------
  root.innerHTML = `
    <div class="dr-wrap">
      <div class="dr-head">
        <h2>Reżyseria</h2>
        <span class="dr-conn" id="drConn"></span>
        <button type="button" class="icon dr-close" id="drClose" aria-label="Zamknij Reżyserię"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>
      </div>
      <div class="dr-bus">
        <div class="dr-tile pgm"><span class="dr-lbl">PROGRAM</span><b id="drPgm">—</b><small id="drPgmSub"></small></div>
        <div class="dr-tile pvw"><span class="dr-lbl">PREVIEW</span><b id="drPvw">—</b><small id="drPvwSub"></small></div>
      </div>
      <div class="dr-take">
        <button type="button" class="dr-big cut" id="drCut">CUT</button>
        <button type="button" class="dr-big fade" id="drFade">FADE</button>
      </div>
      <p class="dr-hint">Dotknij kamery, żeby ustawić ją na Preview. CUT / FADE przenosi Preview na Program.</p>
      <div class="dr-inputs" id="drInputs" role="group" aria-label="Kamery – Preview"></div>
      <details class="dr-more" id="drOther" hidden><summary>Inne źródła</summary><div class="dr-inputs" id="drOtherInputs"></div></details>
      <div class="dr-note" hidden role="status"></div>

      <section class="dr-card">
        <div class="dr-row between">
          <label class="dr-switch"><input type="checkbox" id="drVoice"><span>Sterowanie głosem</span></label>
          <span class="dr-pill" id="drVoiceState"></span>
        </div>
        <p class="dr-hint">Mów komendy przyciskiem <b>Mów</b> (na dowolnym kanale): „Przygotuj dwa”, „Wchodzisz trzy”, „Cut wchodzisz”, „Fade wchodzisz [numer]”. Działa tylko z Twojego mikrofonu.</p>
        <ol class="dr-vlog" id="drVlog"></ol>
        <details class="dr-more"><summary>Ustawienia komend</summary>
          <div class="dr-grid2">
            <label>„Wchodzisz N” przejściem <select id="drProgTake"><option value="cut">Cut</option><option value="mix">Fade (Mix)</option></select></label>
            <label>Czas Fade (klatki) <input id="drFadeFrames" type="number" min="1" max="250" inputmode="numeric"></label>
            <label>Minimalna pewność rozpoznania <select id="drMinConf"><option value="0.4">40%</option><option value="0.5">50%</option><option value="0.6">60%</option><option value="0.7">70%</option><option value="0.8">80%</option></select></label>
          </div>
        </details>
      </section>

      <details class="dr-card dr-auto" id="drAuto">
        <summary><span>Autopilot</span><span class="dr-pill" id="drAutoState"></span></summary>
        <div class="dr-ap">
          <div class="dr-cd"><b id="drCd">—</b><div class="dr-bar"><div id="drCdFill"></div></div><small id="drNext"></small></div>
          <div class="dr-row wrap">
            <button type="button" class="primary" id="drStart">▶ Start</button>
            <button type="button" id="drPause">❚❚ Pauza</button>
            <button type="button" id="drStop">■ Stop</button>
            <button type="button" id="drNextNow">⏭ Następna teraz</button>
          </div>
          <p class="dr-wait" id="drWait" hidden></p>
          <h3>Kamery w rotacji</h3>
          <div class="dr-chips" id="drCams"></div>
          <h3>Czas zmiany</h3>
          <div class="dr-row wrap">
            <div class="dr-seg" data-k="timing.mode"><button type="button" data-v="fixed">Stały</button><button type="button" data-v="random">Losowy</button></div>
            <label class="dr-num" data-show="fixed">co <input data-f="timing.fixedSec" type="number" min="1" max="3600" inputmode="decimal"> s</label>
            <label class="dr-num" data-show="random">od <input data-f="timing.minSec" type="number" min="1" max="3600" inputmode="decimal"> do <input data-f="timing.maxSec" type="number" min="1" max="3600" inputmode="decimal"> s</label>
          </div>
          <label class="dr-switch"><input type="checkbox" id="drPerCam"><span>Osobny czas dla kamer (pole przy kamerze)</span></label>
          <div class="dr-percam" id="drPerCamList" hidden></div>
          <h3>Kolejność</h3>
          <div class="dr-seg" data-k="order"><button type="button" data-v="sequential">Po kolei</button><button type="button" data-v="random">Losowo</button></div>
          <h3>Przejście</h3>
          <label class="dr-switch"><input type="checkbox" id="drTrRandom"><span>Losowo spośród zaznaczonych</span></label>
          <div class="dr-chips" id="drTr"></div>
          <label class="dr-num">czas <input data-f="transitions.duration" type="number" min="1" max="250" inputmode="numeric"> klatek <small id="drTrHint"></small></label>
          <h3>Presety</h3>
          <div class="dr-presets" id="drPresets"></div>
          <form class="dr-row" id="drPresetForm"><input id="drPresetName" maxlength="60" placeholder="Nazwa presetu" autocomplete="off"><button type="submit">Zapisz bieżące</button></form>
        </div>
      </details>

      <section class="dr-card dr-sim" id="drSim" hidden>
        <h3>Symulacja – udawaj operatora</h3>
        <div class="dr-chips" id="drSimBtns"></div>
        <button type="button" id="drSimDrop">Zerwij połączenie na 5 s</button>
      </section>

      <details class="dr-card"><summary>Dziennik</summary><ol class="dr-log" id="drLog"></ol></details>
    </div>`;
  const $ = (s) => root.querySelector(s);
  $('#drClose').onclick = () => setOpen(false);

  // ---------- ręczne przełączanie ----------
  async function act(path, body) {
    if (M.busy) return;
    M.busy = true;
    try { await api(path, 'POST', body); } finally { M.busy = false; }
  }
  $('#drCut').onclick = () => act('cut');
  $('#drFade').onclick = () => act('fade');
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || !root.contains(t)) return;
    if (t.dataset.pv !== undefined) return act('preview', { input: Number(t.dataset.pv) });
    if (t.dataset.cam !== undefined) return edit((s) => { const id = Number(t.dataset.cam); const i = s.cameras.indexOf(id); if (i >= 0) s.cameras.splice(i, 1); else s.cameras.push(id); }, true);
    if (t.dataset.tr !== undefined) return edit((s) => { const k = t.dataset.tr; if (s.transitions.random) { const i = s.transitions.pool.indexOf(k); if (i >= 0) s.transitions.pool.splice(i, 1); else s.transitions.pool.push(k); } else s.transitions.style = k; }, true);
    if (t.dataset.v !== undefined && t.parentElement.dataset.k) { const k = t.parentElement.dataset.k; return edit((s) => setPath(s, k, t.dataset.v), true); }
    if (t.dataset.load !== undefined) return api(`presets/${encodeURIComponent(t.dataset.load)}/load`);
    if (t.dataset.del !== undefined) { if (confirm(`Usunąć preset „${t.dataset.del}”?`)) api(`presets/${encodeURIComponent(t.dataset.del)}`, 'DELETE'); return; }
    if (t.dataset.sim !== undefined) return api('sim/program', 'POST', { input: Number(t.dataset.sim) });
  });
  $('#drStart').onclick = () => api(M.st?.autopilot.runState === 'paused' ? 'resume' : 'start');
  $('#drPause').onclick = () => api('toggle');
  $('#drStop').onclick = () => api('stop');
  $('#drNextNow').onclick = () => api('next');
  $('#drSimDrop').onclick = () => api('sim/drop', 'POST', { seconds: 5 });

  // ---------- głos ----------
  $('#drVoice').onchange = async (e) => {
    const r = await api('voice', 'PUT', { on: e.target.checked });
    if (r.ok === false) e.target.checked = !e.target.checked;
  };
  $('#drProgTake').onchange = (e) => api('voice', 'PUT', { programTake: e.target.value });
  $('#drMinConf').onchange = (e) => api('voice', 'PUT', { minConfidence: Number(e.target.value) });
  $('#drFadeFrames').onchange = (e) => api('voice', 'PUT', { fadeFrames: Number(e.target.value) });

  // ---------- ustawienia autopilota ----------
  const getPath = (o, p) => p.split('.').reduce((x, k) => (x ? x[k] : undefined), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; };
  function edit(fn, now) {
    if (!M.local) return;
    M.local = structuredClone(M.local);
    fn(M.local);
    renderAuto();
    clearTimeout(M.saveT);
    M.saveT = setTimeout(flush, now ? 0 : 600);
  }
  async function flush() { clearTimeout(M.saveT); M.saveT = null; await api('settings', 'PUT', { settings: M.local }); }
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.f) {
      const v = Number(String(t.value).replace(',', '.'));
      if (t.value === '' || !Number.isFinite(v)) return;
      edit((s) => setPath(s, t.dataset.f, v));
    } else if (t.dataset.own !== undefined) {
      const v = Number(String(t.value).replace(',', '.'));
      edit((s) => { if (!t.value || !Number.isFinite(v) || v <= 0) delete s.timing.perCamera[t.dataset.own]; else s.timing.perCamera[t.dataset.own] = v; });
    }
  });
  $('#drPerCam').onchange = (e) => edit((s) => (s.timing.perCameraEnabled = e.target.checked), true);
  $('#drTrRandom').onchange = (e) => edit((s) => { s.transitions.random = e.target.checked; if (s.transitions.random && !s.transitions.pool.length) s.transitions.pool = [s.transitions.style]; }, true);
  $('#drPresetForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#drPresetName').value.trim();
    if (!name) return note('Podaj nazwę presetu', true);
    if (M.saveT) await flush();
    if (M.st.presets.includes(name) && !confirm(`Nadpisać preset „${name}”?`)) return;
    const r = await api('presets', 'POST', { name });
    if (r.ok) { $('#drPresetName').value = ''; note(`Zapisano preset „${name}”`); }
  };

  // ---------- rysowanie ----------
  const label = (id) => { const i = M.st?.inputs.find((x) => x.id === id); return i ? i.longName || i.shortName : id === undefined ? '—' : `Wejście ${id}`; };
  const focused = (el) => document.activeElement === el;

  function render() {
    if (!M.open || !M.st) return;
    const s = M.st;
    const on = s.status === 'connected';
    $('#drConn').className = 'dr-conn ' + s.status;
    $('#drConn').textContent = `${STATUS[s.status] || s.status}${on && s.model ? ' · ' + s.model : ''}${s.simulation ? ' · symulacja' : ''}${s.meCount > 1 ? ` · M/E ${s.me + 1}` : ''}`;
    $('#drPgm').textContent = on ? label(s.program) : '—';
    $('#drPgmSub').textContent = on && s.program !== undefined ? (s.inTransition ? 'przejście w toku…' : `wejście ${s.program}`) : '';
    $('#drPvw').textContent = on ? label(s.preview) : '—';
    $('#drPvwSub').textContent = on && s.preview !== undefined ? `wejście ${s.preview}` : '';
    $('#drCut').disabled = !on || s.inTransition;
    $('#drFade').disabled = !on || s.inTransition || !s.supportedTransitions.includes('mix');

    const tile = (i) => `<button type="button" class="dr-in${i.id === s.program ? ' pgm' : i.id === s.preview ? ' pvw' : ''}" data-pv="${i.id}" ${on ? '' : 'disabled'}>
        <span class="n">${i.id}</span><span class="t">${esc(i.longName || i.shortName)}</span>${i.id === s.program ? '<span class="tag">PGM</span>' : i.id === s.preview ? '<span class="tag">PVW</span>' : ''}</button>`;
    const cams = s.inputs.filter((i) => i.kind === 'camera');
    const others = s.inputs.filter((i) => i.kind === 'other');
    $('#drInputs').innerHTML = cams.length ? cams.map(tile).join('') : `<p class="dr-hint">${on ? 'Mikser nie zgłosił kamer.' : 'Czekam na połączenie z mikserem…'}</p>`;
    $('#drOther').hidden = !others.length;
    $('#drOtherInputs').innerHTML = others.map(tile).join('');

    // głos
    $('#drVoice').checked = s.voice.on;
    const vs = $('#drVoiceState');
    const voiceProblem = !s.stt ? 'rozpoznawanie mowy wyłączone na serwerze' : M.perm?.canTalk === false ? 'brak prawa mówienia' : '';
    vs.textContent = s.voice.on ? voiceProblem || 'słucham komend' : 'wyłączone';
    vs.className = 'dr-pill' + (s.voice.on ? (voiceProblem ? ' warn' : ' ok') : '');
    if (!focused($('#drProgTake'))) $('#drProgTake').value = s.voice.programTake;
    if (!focused($('#drMinConf'))) $('#drMinConf').value = String(s.voice.minConfidence);
    if (!focused($('#drFadeFrames'))) $('#drFadeFrames').value = s.voice.fadeFrames;
    $('#drVlog').innerHTML = s.voiceLog.slice().reverse().slice(0, 8).map((v) => `<li class="${v.ok ? 'ok' : 'err'}">
        <time>${time(v.t)}</time><span class="heard">${v.heard ? `„${esc(v.heard)}”` : ''}${v.confidence != null ? ` <small>${Math.round(v.confidence * 100)}%</small>` : ''}</span>
        <span class="res">${v.ok ? '✓' : '✕'} ${esc(v.result)}${v.totalMs ? ` <small>${num(v.totalMs / 1000, 1)} s</small>` : ''}</span></li>`).join('')
      || '<li class="dr-empty">Rozpoznane komendy pojawią się tutaj.</li>';

    $('#drSim').hidden = !(s.simulation && on);
    const simSig = JSON.stringify(s.inputs.map((i) => i.id));
    if ($('#drSimBtns').dataset.sig !== simSig) { $('#drSimBtns').dataset.sig = simSig; $('#drSimBtns').innerHTML = s.inputs.map((i) => `<button type="button" data-sim="${i.id}">→ ${esc(i.longName)}</button>`).join(''); }
    $('#drLog').innerHTML = s.logs.slice().reverse().map((l) => `<li><time>${time(l.t)}</time> ${esc(l.msg)}</li>`).join('');
    renderAuto();
  }

  function renderAuto() {
    const s = M.st, L = M.local;
    if (!s || !L) return;
    const a = s.autopilot;
    $('#drAutoState').textContent = { running: 'działa', paused: 'pauza', stopped: 'zatrzymany' }[a.runState];
    $('#drAutoState').className = 'dr-pill' + (a.runState === 'running' ? ' ok' : a.runState === 'paused' ? ' warn' : '');
    $('#drStart').disabled = a.runState === 'running';
    $('#drStart').textContent = a.runState === 'paused' ? '▶ Wznów' : '▶ Start';
    $('#drPause').disabled = a.runState === 'stopped';
    $('#drPause').textContent = a.runState === 'paused' ? '▶ Wznów' : '❚❚ Pauza';
    $('#drStop').disabled = a.runState === 'stopped';
    $('#drNext').textContent = a.next ? `Następna: ${label(a.next.input)} (${TR[a.next.transition]})` : '';
    $('#drWait').hidden = !a.waiting;
    $('#drWait').textContent = a.waiting || '';
    const cams = s.inputs.filter((i) => i.kind === 'camera');
    $('#drCams').innerHTML = cams.map((i) => { const k = L.cameras.indexOf(i.id); return `<button type="button" class="dr-chip${k >= 0 ? ' on' : ''}" data-cam="${i.id}">${k >= 0 ? `<b>${k + 1}</b> ` : ''}${esc(i.longName || i.shortName)}</button>`; }).join('')
      || '<span class="dr-hint">Brak kamer.</span>';
    root.querySelectorAll('.dr-seg[data-k]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', getPath(L, seg.dataset.k) === b.dataset.v)));
    root.querySelectorAll('input[data-f]').forEach((el) => { if (!focused(el)) el.value = getPath(L, el.dataset.f); });
    root.querySelectorAll('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== L.timing.mode));
    $('#drPerCam').checked = L.timing.perCameraEnabled;
    const pc = $('#drPerCamList');
    pc.hidden = !L.timing.perCameraEnabled;
    if (L.timing.perCameraEnabled && !pc.contains(document.activeElement)) {
      pc.innerHTML = L.cameras.map((id) => `<label>${esc(label(id))} <input data-own="${id}" type="number" min="1" max="3600" inputmode="decimal" value="${L.timing.perCamera[id] ?? ''}" placeholder="ogólny"> s</label>`).join('') || '<span class="dr-hint">Najpierw zaznacz kamery.</span>';
    }
    $('#drTrRandom').checked = L.transitions.random;
    $('#drTr').innerHTML = KINDS.map((k) => { const ok = s.status !== 'connected' || s.supportedTransitions.includes(k); const on = L.transitions.random ? L.transitions.pool.includes(k) : L.transitions.style === k; return `<button type="button" class="dr-chip${on ? ' on' : ''}" data-tr="${k}" ${ok ? '' : 'disabled title="Mikser tego nie obsługuje"'}>${TR[k]}</button>`; }).join('');
    $('#drTrHint').textContent = `= ${num(L.transitions.duration / (s.fps || 25))} s przy ${num(s.fps || 25)} kl./s`;
    $('#drPresets').innerHTML = s.presets.map((p) => `<div class="dr-preset${p === s.lastPreset ? ' cur' : ''}"><span>${esc(p)}</span><button type="button" data-load="${esc(p)}">Wczytaj</button><button type="button" class="danger" data-del="${esc(p)}">Usuń</button></div>`).join('') || '<span class="dr-hint">Brak presetów.</span>';
    tick();
  }

  function tick() {
    if (!M.open || !M.st) return;
    const a = M.st.autopilot;
    let rem;
    if (a.runState === 'running' && a.deadline) rem = Math.max(0, a.deadline - (Date.now() + M.offset));
    else if (a.runState === 'paused') rem = a.remainingMs;
    $('#drCd').textContent = rem == null ? '—' : rem < 10000 ? num(rem / 1000, 1) + ' s' : Math.ceil(rem / 1000) + ' s';
    $('#drCdFill').style.width = rem == null ? '0%' : `${Math.min(100, Math.max(0, (1 - rem / (a.intervalMs || rem || 1)) * 100))}%`;
  }
  setInterval(tick, 200);

  return {
    /** Wiadomość WebSocket { t: 'mixer', state } – state = null, gdy nie ma (już) dostępu. */
    state(st) {
      M.st = st;
      if (st) {
        M.offset = st.serverTime - Date.now();
        const editing = M.saveT || root.querySelector('input[data-f]:focus, input[data-own]:focus');
        if (!M.local || !editing) M.local = structuredClone(st.settings);
      }
      updateButton();
      render();
    },
    perm(p) { M.perm = p; updateButton(); },
    /** Czy nagrywać wypowiedź także tam, gdzie transkrypcja czatu jest wyłączona. */
    voiceOn: () => !!(allowed() && M.st?.voice?.on),
    isOpen: () => M.open,
    close: () => setOpen(false),
  };
}
