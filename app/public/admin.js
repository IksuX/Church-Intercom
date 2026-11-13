// Interkom – panel administracyjny
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem('ik.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ik.' + k, v); } catch {} },
  del(k) { try { localStorage.removeItem('ik.' + k); } catch {} },
};
const TONES = [['ok', 'Zielony – OK'], ['wait', 'Fioletowy – czekaj'], ['info', 'Niebieski – info'], ['warn', 'Pomarańczowy – uwaga'], ['urgent', 'Czerwony – pilne']];
const PALETTE = ['#60a5fa', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9'];
const ROLE = { admin: 'administrator', speaker: 'mówi', listener: 'słucha / czyta' };

// panel przyjmuje też sesję z aplikacji, jeśli ta osoba jest administratorem (np. zalogowana przez Planning Center)
const appToken = (() => { try { return JSON.parse(store.get('token') || 'null'); } catch { return null; } })();
let token = store.get('adminToken') || appToken;
let saved = null; // konfiguracja zapisana na serwerze
let cfg = null; // edytowana kopia
let meta = null; // dane z Planning Center
let pcoInfo = null;

// ---------- API ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { logout(); throw new Error(j.error || 'Sesja wygasła'); }
  if (!r.ok) throw new Error(j.error || `Błąd ${r.status}`);
  return j;
}
let toastT;
function toast(msg, kind = 'ok') {
  const t = $('#aToast'); t.textContent = msg; t.className = 'a-toast ' + kind; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), kind === 'err' ? 7000 : 3000);
}

// ---------- logowanie ----------
$('#aLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#aLoginErr').textContent = '';
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: $('#aPin').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Błąd logowania');
    token = j.token; store.set('adminToken', token);
    boot();
  } catch (err) { $('#aLoginErr').textContent = err.message; }
});
function logout() { store.del('adminToken'); token = null; $('#aMain').hidden = true; $('#aLogin').hidden = false; }
$('#aLogout').onclick = logout;

async function boot() {
  try {
    const j = await api('GET', '/api/admin/config');
    saved = j.config; pcoInfo = j.pco;
    cfg = structuredClone(saved);
    $('#aLogin').hidden = true; $('#aMain').hidden = false;
    renderAll();
    loadStatus();
    loadNicks();
    loadMeta();
  } catch { logout(); }
}

// ---------- zakładki ----------
$$('#aTabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
const TAB_ALIAS = { quick: 'channels' }; // stare nazwy zakładek (zapamiętane w przeglądarce)
function showTab(tab) {
  tab = TAB_ALIAS[tab] || tab;
  if (!$(`[data-panel="${tab}"]`)) tab = 'status';
  $$('#aTabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  try { $(`#aTabs button[data-tab="${tab}"]`).scrollIntoView({ block: 'nearest', inline: 'center' }); } catch {}
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  try { sessionStorage.setItem('ik.adminTab', tab); } catch {}
  if (tab === 'status') { loadStatus(); loadNicks(); }
  if (tab === 'pco') { loadMeta(); loadPP(); }
  if (tab === 'stt') { loadStt(); loadRecent(); }
  if (tab === 'server') { loadSystem(); loadUpdate(true); }
  if (tab === 'audio') loadProgram();
  if (tab === 'streams') { renderStreams(); loadStreams(); loadPlatforms(); }
  window.scrollTo(0, 0);
}

// ---------- zapisywanie ----------
function dirty() {
  const d = JSON.stringify(cfg) !== JSON.stringify(saved);
  $('#aSave').hidden = !d;
  return d;
}
$('#aRevert').onclick = () => { cfg = structuredClone(saved); renderAll(); };
$('#aSaveBtn').onclick = async () => {
  try {
    const j = await api('PUT', '/api/admin/config', { config: cfg });
    saved = j.config; cfg = structuredClone(saved);
    renderAll();
    toast('Zapisano. Zmiany działają od razu u wszystkich.');
    setTimeout(loadMeta, 1500);
  } catch (e) { toast(e.message, 'err'); }
};
window.addEventListener('beforeunload', (e) => { if (cfg && dirty()) { e.preventDefault(); e.returnValue = ''; } });

function renderAll() {
  $('#aOrg').textContent = cfg.orgName;
  renderGeneral(); renderChannels(); renderQuick(); renderPco(); renderStreams(); renderPP(); renderProgram();
  dirty();
}

// ---------- STAN ----------
async function loadStatus() {
  try {
    const s = await api('GET', '/api/admin/status');
    const up = s.uptimeSec > 86400 ? `${Math.floor(s.uptimeSec / 86400)} d` : s.uptimeSec > 3600 ? `${Math.floor(s.uptimeSec / 3600)} h` : `${Math.floor(s.uptimeSec / 60)} min`;
    const stt = !s.stt.enabled ? ['wyłączona', 'warn-t', ''] : s.stt.ready ? ['działa', 'ok-t', `model: ${s.stt.model}`] : ['nie gotowa', 'bad-t', s.stt.error || 'model się ładuje'];
    const pc = !s.pco.hasCredentials ? ['niepodłączony', 'warn-t', ''] : s.pco.connected ? ['połączony', 'ok-t', ''] : ['błąd', 'bad-t', s.pco.error || ''];
    const speakers = s.users.filter((u) => u.role !== 'listener').length;
    $('#stCards').innerHTML = [
      ['Online', s.users.length, 'ok-t', `mówiących: ${speakers}`],
      ['Transkrypcja', stt[0], stt[1], stt[2]],
      ['Planning Center', pc[0], pc[1], pc[2]],
      ['Wersja', s.version, '', `działa od ${up}`],
    ].map(([k, v, c, d]) => `<div class="a-stat"><div class="k">${k}</div><div class="v ${c}">${esc(v)}</div>${d ? `<div class="d">${esc(d)}</div>` : ''}</div>`).join('');
    const chName = (id) => s.channels.find((c) => c.id === id)?.name || id;
    $('#stOnlineN').textContent = s.users.length;
    if (document.activeElement?.closest?.('#stUsers, #stGrants')) return; // nie przerywaj wyboru
    const g = await api('GET', '/api/admin/users');
    const sel = (kind, x, disabled) => {
      const autoTxt = `Auto (${x.auto ? 'tak' : 'nie'})`;
      return `<select data-kind="${kind}" ${disabled ? 'disabled title="Włącz sterowanie Live w zakładce Planning Center"' : ''} class="${x.effective ? 'on' : ''}">
        <option value="" ${x.value === null ? 'selected' : ''}>${autoTxt}</option>
        <option value="true" ${x.value === true ? 'selected' : ''}>Tak – zawsze</option>
        <option value="false" ${x.value === false ? 'selected' : ''}>Nie – nigdy</option></select>`;
    };
    const via = { pco: 'Planning Center', roster: 'z grafiku', pin: 'PIN' };
    $('#stUsers').innerHTML = g.users.map((u) => `<tr data-uid="${esc(u.id)}">
        <td><b>${esc(u.name)}</b><div class="hint">${ROLE[u.role] || u.role} · ${via[u.via] || u.via}${u.talking ? ` · <span class="ok-t">🎙 mówi</span>` : ''}</div></td>
        <td data-l="Słucha">${esc(u.listen.map(chName).join(', ')) || '—'}</td>
        <td data-l="Administrator">${u.admin.viaPin ? '<span class="hint">PIN admina</span>' : `<select data-kind="admin" class="${u.admin.value ? 'on' : ''}"><option value="false" ${u.admin.value ? '' : 'selected'}>Nie</option><option value="true" ${u.admin.value ? 'selected' : ''}>Tak${u.persistent ? ' – na stałe' : ''}</option></select>`}</td>
        <td data-l="Mówienie">${u.role === 'admin' ? '<span class="hint">administrator</span>' : sel('speak', u.speak)}</td>
        <td data-l="Sterowanie planem">${u.role === 'admin' ? '<span class="hint">zawsze</span>' : sel('live', u.live, !g.liveEnabled)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="hint">Nikogo nie ma online.</td></tr>';
    $$('#stUsers select').forEach((el) => (el.onchange = () => setGrant({ userId: el.closest('tr').dataset.uid }, el.dataset.kind, el.value)));
    const lbl = (v) => (v === true ? 'Tak – zawsze' : v === false ? 'Nie – nigdy' : 'Auto');
    $('#stGrantsCard').hidden = !g.grants.length;
    $('#stGrants').innerHTML = g.grants.map((x) => `<tr data-pid="${esc(x.pid)}"><td>${esc(x.name)}${x.online ? ' <span class="ok-t">● online</span>' : ''}</td><td data-l="Administrator">${x.admin ? 'Tak' : '—'}</td><td data-l="Mówienie">${lbl(x.speak)}</td><td data-l="Sterowanie planem">${lbl(x.live)}</td>
        <td><button type="button" data-reset>↺ Przywróć auto</button></td></tr>`).join('');
    $$('#stGrants [data-reset]').forEach((b) => (b.onclick = () => setGrant({ pid: b.closest('tr').dataset.pid }, null, null)));
  } catch (e) { toast(e.message, 'err'); }
}
async function setGrant(who, kind, value) {
  const v = value === 'true' ? true : value === 'false' ? false : null;
  const body = kind ? { ...who, [kind]: v } : { ...who, speak: null, live: null, admin: null };
  try { await api('POST', '/api/admin/grant', body); toast('Uprawnienia zmienione.'); } catch (e) { toast(e.message, 'err'); }
  document.activeElement?.blur?.();
  loadStatus();
}
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="status"]').hidden) loadStatus(); }, 5000);
// ---------- SERWER: procesor, pamięć, dysk, usługi, restart ----------
const gb = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`);
const dur = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
function sysBar(id, pct, warn, bad) { const el = $(id); el.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`; el.className = pct >= bad ? 'bad' : pct >= warn ? 'warn' : ''; }
let sysHelper = false, sysWaiting = null;
const SYS_HINT = $('#sysHint').textContent;
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="server"]').hidden) loadSystem(); }, 5000);
async function loadSystem() {
  let s;
  try { s = await api('GET', '/api/admin/system'); } catch { if (sysWaiting) $('#sysHint').textContent = sysWaiting; return; }
  if (sysWaiting) { sysWaiting = null; toast('Serwer znowu działa.'); }
  const c = s.cpu, m = s.mem, d = s.disk;
  $('#sysCpu').textContent = c.pct == null ? '…' : `${Math.round(c.pct)}%`; sysBar('#sysCpuBar', c.pct, 70, 90);
  $('#sysCpuS').textContent = `${c.cores} rdz. · obciążenie ${c.load.join(' / ')}`; $('#sysCpuS').title = c.model;
  const mp = (m.used / m.total) * 100;
  $('#sysMem').textContent = `${Math.round(mp)}%`; sysBar('#sysMemBar', mp, 75, 90);
  $('#sysMemS').textContent = `${gb(m.used)} z ${gb(m.total)}${m.swapUsed > 50e6 ? ` · swap ${gb(m.swapUsed)}` : ''}`;
  if (d) { const dp = (d.used / (d.used + d.free)) * 100; /* jak „df”: miejsce zarezerwowane dla systemu się nie liczy */ $('#sysDisk').textContent = `${Math.round(dp)}%`; sysBar('#sysDiskBar', dp, 80, 92); $('#sysDiskS').textContent = `wolne ${gb(d.free)} z ${gb(d.total)}`; }
  $('#sysTemp').textContent = c.temp == null ? 'brak czujnika' : `${c.temp}°C`; sysBar('#sysTempBar', c.temp == null ? 0 : c.temp, 70, 85);
  $('#sysTemp').style.fontSize = c.temp == null ? '15px' : '';
  $('#sysUp').textContent = `komputer działa ${dur(s.uptimeSec)} · interkom ${dur(s.appUptimeSec)}`;
  $('#sysHost').textContent = `wersja ${s.version}`;
  const sv = s.services, item = (name, v) => (v == null ? '' : `<span class="${v ? 'ok' : 'bad'}">${v ? '✔' : '✖'} ${name}</span>`);
  $('#sysSvc').innerHTML = item('Interkom', sv.app) + item('Głos (LiveKit)', sv.livekit) + item('Transkrypcja', sv.stt) + item('Nadajnik dźwięku', sv.audio);
  sysHelper = !!s.helper?.installed;
  $('#sysReboot').disabled = $('#sysOff').disabled = !sysHelper;
  if (sysHelper && !sysWaiting) $('#sysHint').textContent = SYS_HINT;
  if (!sysHelper) $('#sysHint').textContent = 'Restart i wyłączenie komputera wymagają usługi sterowania na serwerze – uruchom raz instalator ponownie: sudo ./install.sh. „Uruchom ponownie interkom” zrestartuje wtedy tylko aplikację.';
}
async function sysAction(action, question, wait) {
  if (!confirm(question)) return;
  try {
    await api('POST', '/api/admin/system/action', { action });
    sysWaiting = wait; $('#sysHint').textContent = wait; toast(wait);
  } catch (e) { toast(e.message, 'err'); }
}
$('#sysRestart').onclick = () => sysAction(sysHelper ? 'restart' : 'restart-app', 'Uruchomić ponownie interkom? Przez ok. 30 s nikt nie będzie się słyszał – telefony połączą się same.', 'Interkom uruchamia się ponownie – panel odświeży się sam, gdy wróci.');
$('#sysReboot').onclick = () => sysAction('reboot', 'Uruchomić ponownie komputer-serwer? Interkom będzie niedostępny przez 1–2 minuty.', 'Komputer uruchamia się ponownie (1–2 min)…');
$('#sysOff').onclick = () => {
  if (!confirm('WYŁĄCZYĆ komputer-serwer? Interkom przestanie działać, dopóki ktoś nie włączy komputera przyciskiem na obudowie.')) return;
  sysAction('poweroff', 'Na pewno wyłączyć? Tej operacji nie da się cofnąć z panelu.', 'Komputer się wyłącza. Włączysz go przyciskiem na obudowie.');
};

// ---------- SERWER: aktualizacje z GitHuba ----------
let upWait = null; // 'check' | 'run' – czekamy na wynik usługi na serwerze
let upSince = 0, upFrom = null; // wersja sprzed aktualizacji – po zmianie panel się odświeża
const upEsc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function loadUpdate(auto) {
  let u;
  try { u = await api('GET', '/api/admin/update'); } catch {
    if (upWait === 'run') $('#upStatus').innerHTML = '⏳ Aktualizacja trwa – interkom uruchamia się z nową wersją. Panel połączy się sam…';
    return;
  }
  const st = u.state, ck = u.check;
  if (upFrom == null) upFrom = u.version;
  if (upWait === 'run' && st && st.state !== 'running' && Date.parse(st.at) >= upSince - 5000) {
    upWait = null;
    if (st.state === 'failed') toast('Aktualizacja nie powiodła się – zobacz dziennik.', 'err');
    else if (u.version !== upFrom) { toast(`Zaktualizowano do wersji ${u.version}. Odświeżam panel…`); setTimeout(() => location.reload(), 1500); }
    else toast('Aktualizacja zakończona.');
  }
  if (!u.helper || !u.supported) {
    $('#upStatus').innerHTML = 'Aktualizacja z panelu wymaga nowszej usługi sterowania. Uruchom <b>raz</b> na serwerze: <code>cd ~/interkom && ./update.sh</code>';
    $('#upCheck').disabled = true; $('#upRun').hidden = true; return;
  }
  $('#upCheck').disabled = false;
  const checkedAt = ck?.at ? Date.parse(ck.at) : 0;
  if (upWait === 'check' && (checkedAt >= upSince - 5000 || ck?.error)) upWait = null;
  const running = st?.state === 'running' && Date.now() - Date.parse(st.at) < 20 * 60e3;
  if (running) upWait = 'run';
  let html;
  if (running || upWait === 'run') html = `⏳ Aktualizacja trwa${st?.from ? ` (z wersji ${upEsc(st.from)})` : ''} – zwykle 1–5 minut. Panel połączy się sam.`;
  else if (upWait === 'check') html = '⏳ Sprawdzam GitHuba…';
  else if (ck?.git === false) html = 'Folder interkomu na serwerze nie jest połączony z GitHubem – zob. README, rozdział „Aktualizacje z GitHuba”.';
  else if (ck?.error) html = `<span class="bad-t">✖ ${upEsc(ck.error)}</span>`;
  else if (!ck) html = `Zainstalowana wersja <b>${upEsc(u.version)}</b>. Kliknij „Sprawdź aktualizacje”.`;
  else if (ck.behind > 0) html = `<span class="warn-t">Dostępna nowa wersja <b>${upEsc(ck.latest)}</b></span> (zainstalowana ${upEsc(u.version)}) · sprawdzono ${new Date(ck.at).toLocaleString('pl-PL')}`;
  else html = `<span class="ok-t">✔ Masz najnowszą wersję ${upEsc(u.version)}</span> · sprawdzono ${new Date(ck.at).toLocaleString('pl-PL')}`;
  if (!running && upWait !== 'run' && st && st.state !== 'running') {
    html += st.state === 'done' ? `<br><span class="hint">Ostatnia aktualizacja: ${upEsc(st.from)} → ${upEsc(st.to)}, ${new Date(st.at).toLocaleString('pl-PL')}</span>`
      : `<br><span class="bad-t">✖ Ostatnia aktualizacja nie powiodła się (${new Date(st.at).toLocaleString('pl-PL')}) – zobacz dziennik niżej.</span>`;
  }
  $('#upStatus').innerHTML = html;
  const ch = (!running && ck?.behind > 0 && ck.changes) || [];
  $('#upChanges').hidden = !ch.length;
  $('#upChanges').innerHTML = ch.map((c) => `<li>${upEsc(c)}</li>`).join('');
  $('#upRun').hidden = !(ck?.behind > 0) || running || upWait === 'run';
  $('#upCheck').disabled = running || !!upWait;
  $('#upLogBox').hidden = !u.log?.length;
  $('#upLog').textContent = (u.log || []).join('\n');
  if (st?.state === 'failed' && !running) $('#upLogBox').open = true;
  // przy wejściu do zakładki: sprawdź sam, jeśli ostatnio dawno (albo nigdy)
  if (auto && !upWait && !running && ck?.git !== false && Date.now() - checkedAt > 30 * 60e3) upAction('check', true);
}
async function upAction(what, quiet) {
  if (what === 'run' && !confirm('Zaktualizować interkom teraz? Pod koniec (ok. 30 s) nikt nie będzie się słyszał – telefony połączą się same. Ustawienia zostają.')) return;
  try {
    await api('POST', '/api/admin/update', { action: what });
    upWait = what; upSince = Date.now(); loadUpdate();
    if (what === 'run') toast('Aktualizacja rozpoczęta.');
  } catch (e) { if (!quiet) toast(e.message, 'err'); }
}
$('#upCheck').onclick = () => upAction('check');
$('#upRun').onclick = () => upAction('run');
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="server"]').hidden && upWait) loadUpdate(); }, 2000);
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="server"]').hidden && !upWait) loadUpdate(); }, 15000);

$('#stClear').onclick = async () => {
  if (!confirm('Wyczyścić czat na wszystkich kanałach u wszystkich osób?')) return;
  try { await api('POST', '/api/admin/clear-chat'); toast('Czat wyczyszczony.'); } catch (e) { toast(e.message, 'err'); }
};

// ---------- OGÓLNE ----------
function renderGeneral() {
  const bind = (id, get, set) => { const el = $(id); el.value = get(); el.oninput = () => { set(el.value); dirty(); if (id === '#gOrg') $('#aOrg').textContent = el.value; }; };
  bind('#gOrg', () => cfg.orgName, (v) => (cfg.orgName = v));
  bind('#gAccess', () => cfg.accessPin, (v) => (cfg.accessPin = v.trim()));
  bind('#gSpeaker', () => cfg.speakerPin, (v) => (cfg.speakerPin = v.trim()));
  bind('#gAdmin', () => cfg.adminPin, (v) => (cfg.adminPin = v.trim()));
  bind('#gStt', () => cfg.sttPrompt || '', (v) => (cfg.sttPrompt = v));
  bind('#gDict', () => cfg.sttDictionary || '', (v) => (cfg.sttDictionary = v));
  cfg.sttHints ||= { plan: true, names: false };
  for (const [id, k] of [['#hintPlan', 'plan'], ['#hintNames', 'names']]) { const el = $(id); el.checked = !!cfg.sttHints[k]; el.onchange = () => { cfg.sttHints[k] = el.checked; dirty(); }; }
  if (!$('[data-panel="stt"]').hidden) renderSttChans();
  $$('[data-pin]').forEach((i) => (i.type = 'password'));
  renderBrand();
  renderRemote();
  cfg.apps ||= { ios: '', android: '' };
  for (const [id, k] of [['#apIos', 'ios'], ['#apAndroid', 'android']]) { const el = $(id); el.value = cfg.apps[k] || ''; el.oninput = () => { cfg.apps[k] = el.value.trim(); dirty(); }; }
  loadApk();
}
function renderRemote() {
  cfg.remote ||= { enabled: true, pin: false, admin: false };
  for (const [id, k] of [['#rmEnabled', 'enabled'], ['#rmPin', 'pin'], ['#rmAdmin', 'admin']]) {
    const el = $(id); el.checked = !!cfg.remote[k];
    el.onchange = () => { cfg.remote[k] = el.checked; dirty(); $('#rmPin').disabled = $('#rmAdmin').disabled = !cfg.remote.enabled; };
  }
  $('#rmPin').disabled = $('#rmAdmin').disabled = !cfg.remote.enabled;
  api('GET', '/api/admin/remote').then((r) => {
    if (r.cloud) { $('#rmAddr').innerHTML = 'Ten serwer działa w internecie (tryb VPS) – wszyscy łączą się z zewnątrz, więc poniższe ograniczenia go nie dotyczą. Mają znaczenie dla serwera w sieci kościoła.'; return; }
    $('#rmAddr').innerHTML = r.remote
      ? `W kościele: <b>https://${esc(r.lan)}</b> · Spoza sieci: <b>https://${esc(r.remote)}</b>${r.youAreRemote ? ' · <b>teraz łączysz się spoza sieci</b>' : ''}`
      : `Adres zdalny nie jest jeszcze skonfigurowany – uruchom na serwerze <code>sudo ./install.sh --remote</code> i przekieruj porty w routerze (szczegóły niżej).`;
  }).catch(() => {});
}
// ---------- WYGLĄD ----------
const BRAND_DEFAULT = '#5ab9fc';
const BRAND_PRESETS = ['#5ab9fc', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#a3a3a3'];
function renderBrand() {
  cfg.branding ||= { accent: BRAND_DEFAULT, logo: '' };
  const set = (hex) => {
    cfg.branding.accent = hex; dirty();
    document.documentElement.style.setProperty('--accent', hex);
    { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); document.documentElement.style.setProperty('--accent-fg', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#0a0d14' : '#fff'); }
    $('#gAccent').value = hex; $('#gAccentHex').textContent = hex;
    $$('#gAccentPresets button').forEach((b) => b.classList.toggle('sel', b.dataset.c === hex));
    showLogo();
  };
  $('#gAccentPresets').innerHTML = BRAND_PRESETS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
  $$('#gAccentPresets button').forEach((b) => (b.onclick = () => set(b.dataset.c)));
  $('#gAccent').oninput = (e) => set(e.target.value.toLowerCase());
  $('#gAccentReset').onclick = () => set(BRAND_DEFAULT);
  const a = cfg.branding.accent || BRAND_DEFAULT;
  document.documentElement.style.setProperty('--accent', a);
  $('#gAccent').value = a; $('#gAccentHex').textContent = a;
  $$('#gAccentPresets button').forEach((b) => b.classList.toggle('sel', b.dataset.c === a));
  // kolor logo
  const lc = cfg.branding.logoColor || '';
  const known = ['', '#ffffff', '#000000', 'accent'];
  $('#gLogoColor').value = known.includes(lc) ? lc : 'custom';
  $('#gLogoCustom').hidden = known.includes(lc); if (!known.includes(lc)) $('#gLogoCustom').value = lc;
  $('#gLogoColor').onchange = () => {
    const v = $('#gLogoColor').value;
    $('#gLogoCustom').hidden = v !== 'custom';
    cfg.branding.logoColor = v === 'custom' ? $('#gLogoCustom').value : v; dirty(); showLogo();
  };
  $('#gLogoCustom').oninput = () => { cfg.branding.logoColor = $('#gLogoCustom').value; dirty(); showLogo(); };
  fetch('/api/login-options').then((r) => r.json()).then((o) => { brandInfo = o.brand || {}; showLogo(); }).catch(() => showLogo());
}
let brandInfo = {}; // proporcje logo i czy da się je przekolorować (liczy serwer)
function showLogo() {
  const url = cfg.branding.logo ? '/branding/logo?v=' + encodeURIComponent(cfg.branding.logo) : null;
  const tint = !!(url && brandInfo.tintable && brandInfo.ratio);
  $('#gLogoColorRow').hidden = !tint; $('#gLogoTintHint').hidden = !(tint && cfg.branding.logoColor); $('#gLogoColorHint').hidden = !url || tint;
  if ($('#gLogoColorHint').hidden === false) $('#gLogoColorHint').textContent = 'Kolor logo można zmienić dla plików SVG i PNG z przezroczystym tłem.';
  const lc = cfg.branding.logoColor, color = tint && lc ? (lc === 'accent' ? cfg.branding.accent : lc) : null;
  let html = 'brak logo';
  if (url && color) {
    const h = Math.min(96, 220 / brandInfo.ratio), w = h * brandInfo.ratio;
    html = `<span class="logo-tint" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;background:${esc(color)};--logo:url('${esc(url)}')"></span>`;
  } else if (url && brandInfo.ratio) {
    const h = Math.min(96, 220 / brandInfo.ratio), w = h * brandInfo.ratio;
    html = `<img src="${esc(url)}" alt="Logo" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px">`;
  } else if (url) html = `<img src="${esc(url)}" alt="Logo" style="height:96px;width:auto;max-width:220px">`;
  $('#gLogoPrev').innerHTML = html;
  $('#gLogoDel').hidden = !url;
}
function brandSaved(b, info) { // serwer zapisał logo w konfiguracji – nie nadpisuj go starą kopią przy następnym „Zapisz”
  cfg.branding.logo = b.logo; if (saved?.branding) saved.branding.logo = b.logo;
  if (info) brandInfo = info;
  dirty(); showLogo();
}
$('#gLogoFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) return toast('Plik jest za duży (maks. 2 MB).', 'err');
  try {
    const r = await fetch('/api/admin/branding/logo', { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream', authorization: 'Bearer ' + token }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Błąd ${r.status}`);
    brandSaved(j.branding, j.brand); toast('Logo zapisane – widać je od razu u wszystkich.');
  } catch (err) { toast(err.message, 'err'); }
};
$('#gLogoDel').onclick = async () => {
  if (!confirm('Usunąć logo?')) return;
  try { const j = await api('DELETE', '/api/admin/branding/logo'); brandSaved(j.branding, j.brand); toast('Logo usunięte.'); } catch (err) { toast(err.message, 'err'); }
};
// ---------- plik APK na serwerze ----------
const mb = (n) => (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
function showApk(a) {
  $('#apkDel').hidden = !a;
  $('#apkState').innerHTML = a ? `✔ Wgrany ${esc(new Date(a.at).toLocaleString('pl-PL'))} · ${mb(a.size)} · pobrań: ${a.downloads || 0} · <a href="${esc(a.url)}">${esc(location.origin + a.url)}</a>` : 'Brak pliku na serwerze.';
}
async function loadApk() { try { showApk((await api('GET', '/api/admin/apk')).apk); } catch { $('#apkState').textContent = ''; } }
$('#apkFile').onchange = (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  if (!f) return;
  if (!/\.apk$/i.test(f.name)) return toast('Wybierz plik .apk', 'err');
  const x = new XMLHttpRequest();
  x.open('POST', '/api/admin/apk');
  x.setRequestHeader('authorization', 'Bearer ' + token);
  x.setRequestHeader('content-type', 'application/vnd.android.package-archive');
  x.setRequestHeader('x-file-name', f.name.replace(/[^\w.\- ]/g, '_'));
  x.upload.onprogress = (ev) => { if (ev.lengthComputable) $('#apkState').textContent = `Wysyłanie… ${Math.round(ev.loaded / ev.total * 100)}% z ${mb(ev.total)}`; };
  x.onload = () => {
    let j = {}; try { j = JSON.parse(x.responseText); } catch {}
    if (x.status >= 200 && x.status < 300) { showApk(j.apk); toast('Aplikacja wgrana – przycisk pobierania jest na ekranie logowania.'); }
    else { toast(j.error || `Błąd ${x.status}`, 'err'); loadApk(); }
  };
  x.onerror = () => { toast('Wysyłanie przerwane.', 'err'); loadApk(); };
  x.send(f);
};
$('#apkFile').parentElement.querySelector('span').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('#apkFile').click(); };
$('#apkDel').onclick = async () => {
  if (!confirm('Usunąć plik aplikacji z serwera?')) return;
  try { showApk((await api('DELETE', '/api/admin/apk')).apk); toast('Plik usunięty.'); } catch (err) { toast(err.message, 'err'); }
};
$$('.a-eye').forEach((b) => (b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; }));

// ---------- TRANSKRYPCJA ----------
async function renderSttChans() {
  let chans = cfg.channels;
  try { chans = (await api('GET', '/api/admin/status')).channels; } catch {}
  cfg.sttOff ||= [];
  $('#sttChans').innerHTML = chans.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${cfg.sttOff.includes(c.id) ? '' : 'checked'}> ${esc(c.name)}</label>`).join('');
  $$('#sttChans input').forEach((i) => (i.onchange = () => { cfg.sttOff = $$('#sttChans input:not(:checked)').map((x) => x.value); dirty(); }));
  $('#sttDm').checked = cfg.sttDm !== false;
  $('#sttDm').onchange = () => { cfg.sttDm = $('#sttDm').checked; dirty(); };
  // osoby bez transkrypcji
  cfg.sttOffUsers ||= [];
  let people = [];
  try { people = (await api('GET', '/api/admin/nicks')).people || []; } catch {}
  const all = new Map(people.map((p) => [p.key, { key: p.key, name: p.name, online: p.online }]));
  for (const x of cfg.sttOffUsers) if (!all.has(x.key)) all.set(x.key, { key: x.key, name: x.name, online: false });
  const off = new Set(cfg.sttOffUsers.map((x) => x.key));
  $('#sttUsers').innerHTML = [...all.values()].map((p) => `<label><input type="checkbox" value="${esc(p.key)}" data-name="${esc(p.name)}" ${off.has(p.key) ? '' : 'checked'}> ${esc(p.name)}${p.online ? ' <small>(online)</small>' : ''}</label>`).join('') || '<p class="hint">Nikogo jeszcze nie ma na liście.</p>';
  $$('#sttUsers input').forEach((i) => (i.onchange = () => { cfg.sttOffUsers = $$('#sttUsers input:not(:checked)').map((x) => ({ key: x.value, name: x.dataset.name })); dirty(); }));
}
async function loadStt() {
  renderSttChans();
  try {
    const h = await api('GET', '/api/admin/stt');
    const st = $('#sttStatus');
    if (!h.ok) { st.innerHTML = `<span class="bad-t">✘ ${esc(h.error || 'niedostępna')}</span>`; return; }
    const speed = h.stats ? ` · średnio ${h.stats.avgRtf}× czasu mowy (ostatnio ${h.stats.last.audio} s mowy → ${h.stats.last.seconds} s)` : '';
    st.innerHTML = (h.loading ? `<span class="warn-t">⏳ Ładuję model „${esc(h.loading)}”…</span> ` : '')
      + (h.ready ? `<span class="ok-t">✔ Działa: ${esc(h.model)}</span>` : `<span class="bad-t">✘ ${esc(h.error || 'nie gotowa')}</span>`)
      + `<span class="hint"> · procesor: ${h.cpu.cores} rdz.${h.cpu.avx2 === false ? ', <b class="bad-t">brak AVX2 – będzie wolno</b>' : ''} · zalecany: ${esc(h.auto)}${speed}</span>`;
    const sel = $('#sttModel');
    if (document.activeElement !== sel) sel.value = h.loading || h.model || h.auto;
    if (document.activeElement !== $('#sttQuality')) $('#sttQuality').value = h.quality || 'balanced';
    api('GET', '/api/admin/stt/hotwords').then((r) => ($('#hotPreview').textContent = r.hotwords || '(nic)')).catch(() => {});
    if (h.loading) setTimeout(loadStt, 3000);
  } catch (e) { $('#sttStatus').textContent = e.message; }
}
$('#sttModel').onchange = async () => {
  try { await api('POST', '/api/admin/stt/model', { name: $('#sttModel').value }); toast('Ładuję nowy model – do tego czasu działa poprzedni.'); setTimeout(loadStt, 800); }
  catch (e) { toast(e.message, 'err'); }
};
$('#sttQuality').onchange = async () => {
  try { await api('POST', '/api/admin/stt/settings', { quality: $('#sttQuality').value }); toast('Zapisano dokładność.'); } catch (e) { toast(e.message, 'err'); }
};
const fmtT = (ts) => new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sttRes = (r) => `„${esc(r.text || '(brak słów)')}” <span class="hint">· ${esc(r.model)}/${esc({ fast: 'szybko', balanced: 'zrównoważona', accurate: 'dokładnie' }[r.quality] || r.quality || '')} · ${r.seconds} s · pewność ${Math.round((r.confidence || 0) * 100)}%</span>`;
async function loadRecent() {
  try {
    const { items } = await api('GET', '/api/admin/stt/recent');
    $('#sttRecent').innerHTML = items.map((r) => `<div class="sr" data-id="${esc(r.id)}">
        <div class="sr-h"><b>${esc(r.who || '?')}</b> <span class="hint">${fmtT(r.ts)} · ${r.audio} s</span>
          <button type="button" data-play>▶ Odsłuchaj</button><button type="button" data-redo>↻ Ponów</button></div>
        <div>${sttRes(r)}</div>${r.redo ? `<div class="sr-redo">Ponownie: ${sttRes(r.redo)}</div>` : ''}</div>`).join('') || '<p class="hint">Brak nagrań – powiedz coś przez interkom.</p>';
    $$('#sttRecent [data-play]').forEach((b) => (b.onclick = async () => {
      const id = b.closest('.sr').dataset.id;
      try {
        const r = await fetch(`/api/admin/stt/recent/${id}/audio`, { headers: { authorization: 'Bearer ' + token } });
        if (!r.ok) throw new Error('Nagranie już usunięte.');
        const a = new Audio(URL.createObjectURL(await r.blob())); a.play();
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('#sttRecent [data-redo]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = '⏳ Transkrybuję…';
      try { await api('POST', `/api/admin/stt/recent/${b.closest('.sr').dataset.id}/redo`); } catch (e) { toast(e.message, 'err'); }
      loadRecent();
    }));
  } catch (e) { $('#sttRecent').innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}
$('#sttRecentLoad').onclick = loadRecent;
$('#sttBench').onclick = async () => {
  const b = $('#sttBench'); b.disabled = true; $('#sttBenchOut').textContent = 'Transkrybuję…';
  try {
    const r = await api('POST', '/api/admin/stt/bench');
    $('#sttBenchOut').innerHTML = `Model <b>${esc(r.model)}</b>: ${r.audio} s mowy w <b>${r.seconds} s</b> → „${esc(r.text || '(brak słów)')}”`;
    loadStt();
  } catch (e) { $('#sttBenchOut').textContent = e.message; }
  b.disabled = false;
};

// ---------- KANAŁY ----------
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'kanal';
function uniqueId(base) { let id = base, i = 2; while (cfg.channels.some((c) => c.id === id)) id = `${base}-${i++}`; return id; }
function move(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }

function renderChannels() {
  $('#chList').innerHTML = cfg.channels.map((c, i) => `
    <div class="a-row" data-i="${i}">
      <input type="color" value="${esc(c.color)}" data-k="color" aria-label="Kolor">
      <input value="${esc(c.name)}" data-k="name" maxlength="30" placeholder="Nazwa kanału">
      <label class="a-bc" title="Kanał ogólny – słyszą go domyślnie wszyscy"><input type="radio" name="bc" ${c.broadcast ? 'checked' : ''} data-k="broadcast"> ogólny</label>
      <button type="button" data-a="up" aria-label="W górę">↑</button>
      <button type="button" data-a="down" aria-label="W dół">↓</button>
      <button type="button" data-a="del" class="danger" aria-label="Usuń" ${cfg.channels.length < 2 ? 'disabled' : ''}>✕</button>
      <div class="a-id">id: ${esc(c.id)}</div>
    </div>`).join('');
  $$('#chList .a-row').forEach((row) => {
    const i = Number(row.dataset.i), c = cfg.channels[i];
    $$('input', row).forEach((inp) => (inp.oninput = inp.onchange = () => {
      if (inp.dataset.k === 'broadcast') { cfg.channels.forEach((x) => delete x.broadcast); c.broadcast = true; }
      else c[inp.dataset.k] = inp.value;
      dirty();
    }));
    $$('button', row).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'up') move(cfg.channels, i, -1);
      if (b.dataset.a === 'down') move(cfg.channels, i, 1);
      if (b.dataset.a === 'del') {
        if (!confirm(`Usunąć kanał „${c.name}”?`)) return;
        const wasBc = c.broadcast; cfg.channels.splice(i, 1);
        for (const [k, v] of Object.entries(pc().teamChannelMap)) if (v === c.id) delete pc().teamChannelMap[k];
        if (wasBc) cfg.channels[0].broadcast = true;
      }
      renderChannels(); renderPcoMap(); dirty();
    }));
  });
}
$('#chAdd').onclick = () => {
  const name = 'Nowy kanał';
  cfg.channels.push({ id: uniqueId(slug(name)), name, color: PALETTE[cfg.channels.length % PALETTE.length] });
  renderChannels(); dirty();
  const inputs = $$('#chList input[data-k="name"]'); inputs.at(-1).select();
};
// id nowego kanału podąża za nazwą, dopóki kanał nie został zapisany
$('#chList').addEventListener('change', (e) => {
  if (e.target.dataset.k !== 'name') return;
  const i = Number(e.target.closest('.a-row').dataset.i), c = cfg.channels[i];
  if (!saved.channels.some((s) => s.id === c.id)) { c.id = ''; c.id = uniqueId(slug(c.name)); renderChannels(); dirty(); }
});

// ---------- SZYBKIE PRZYCISKI ----------
function renderQuick() {
  $('#qList').innerHTML = cfg.quick.map((q, i) => `
    <div class="a-row a-qrow" data-i="${i}">
      <input value="${esc(q.label)}" data-k="label" maxlength="24" placeholder="Napis">
      <select data-k="tone">${TONES.map(([v, l]) => `<option value="${v}" ${q.tone === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="a-bc"><input type="checkbox" data-k="urgent" ${q.urgent ? 'checked' : ''}> alarm</label>
      <button type="button" data-a="up" aria-label="W górę">↑</button>
      <button type="button" data-a="down" aria-label="W dół">↓</button>
      <button type="button" data-a="del" class="danger" aria-label="Usuń">✕</button>
    </div>`).join('') || '<p class="hint">Brak przycisków.</p>';
  $$('#qList .a-row').forEach((row) => {
    const i = Number(row.dataset.i), q = cfg.quick[i];
    $$('input, select', row).forEach((el) => (el.oninput = el.onchange = () => {
      if (el.dataset.k === 'urgent') { if (el.checked) q.urgent = true; else delete q.urgent; }
      else q[el.dataset.k] = el.value;
      renderQuickPreview(); dirty();
    }));
    $$('button', row).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'up') move(cfg.quick, i, -1);
      if (b.dataset.a === 'down') move(cfg.quick, i, 1);
      if (b.dataset.a === 'del') cfg.quick.splice(i, 1);
      renderQuick(); dirty();
    }));
  });
  $('#qAdd').disabled = cfg.quick.length >= 12;
  renderQuickPreview();
}
function renderQuickPreview() {
  $('#qPreview').innerHTML = cfg.quick.map((q) => `<button type="button" class="tone-${esc(q.tone)}">${esc(q.label || '…')}</button>`).join('');
}
$('#qAdd').onclick = () => {
  cfg.quick.push({ key: 'q' + Date.now().toString(36), label: 'Nowy', tone: 'info' });
  renderQuick(); dirty();
  $$('#qList input[data-k="label"]').at(-1).select();
};

// ---------- PLANNING CENTER ----------
async function loadMeta() {
  try {
    meta = await api('GET', '/api/admin/pco/meta');
    pcoInfo = meta.pco;
    renderPco();
  } catch (e) { toast(e.message, 'err'); }
}
const pc = () => cfg.planningCenter;

function renderPco() {
  const info = pcoInfo || {};
  $('#pStatus').innerHTML = !info.hasCredentials ? '<span class="warn-t">Nie podłączono konta Planning Center.</span>'
    : info.connected ? `<span class="ok-t">✔ Połączono</span> <span class="hint">(token ${esc(info.appIdMasked)}${info.source === 'env' ? ', z pliku .env' : ''})</span>`
    : `<span class="bad-t">✘ ${esc(info.error || 'Łączenie…')}</span>`;
  $('#pCredSummary').textContent = info.hasCredentials ? 'Zmień token' : 'Podłącz konto Planning Center';
  $('#pCredBox').open = !info.hasCredentials;
  $('#pDisconnect').hidden = info.source !== 'panel';
  $('#pEnabled').checked = pc().enabled !== false;
  $('#pEnabled').onchange = () => { pc().enabled = $('#pEnabled').checked; dirty(); };
  $('#pConfigured').hidden = !info.hasCredentials || !meta?.serviceTypes;
  if (!meta?.serviceTypes) return;

  // plan
  const p = meta.plan;
  $('#pPlan').innerHTML = p ? `Bieżący: <b>${esc(p.serviceTypeName)} · ${esc(p.dates)} ${esc(p.title)}</b> <span class="hint">(${p.items} punktów)</span>`
    : '<span class="warn-t">Brak wydarzenia na dziś ani w najbliższych 7 dniach.</span> <span class="hint">Możesz wybrać plan ręcznie.</span>';
  const opt = (id, label, checked) => `<label><input type="radio" name="plan" value="${esc(id)}" ${checked ? 'checked' : ''}> ${label}</label>`;
  $('#pPlans').innerHTML = opt('', 'Automatycznie (dzisiejszy lub najbliższy w ciągu 7 dni)', !meta.manualPlan)
    + meta.upcoming.map((x) => opt(x.id, `${esc(x.serviceTypeName)} · ${esc(x.dates)} ${esc(x.title)}`, meta.manualPlan === x.id)).join('');
  $$('#pPlans input').forEach((i) => (i.onchange = async () => {
    try { await api('POST', '/api/admin/pco/select', { planId: i.value || null }); toast('Plan zmieniony.'); loadMeta(); } catch (e) { toast(e.message, 'err'); }
  }));

  $('#pAnnounce').checked = pc().announce !== false;
  $('#pAnnounce').onchange = () => { pc().announce = $('#pAnnounce').checked; dirty(); };

  // typy wydarzeń
  const chk = (name, value, checked, label) => `<label><input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
  $('#pTypes').innerHTML = meta.serviceTypes.map((t) => chk('st', t.id, pc().serviceTypeIds.includes(t.id), t.name)).join('');
  $$('#pTypes input').forEach((i) => (i.onchange = () => { pc().serviceTypeIds = $$('#pTypes input:checked').map((x) => x.value); dirty(); }));

  // kto mówi
  $('#pLeaders').checked = pc().teamLeadersCanSpeak !== false;
  $('#pLeaders').onchange = () => { pc().teamLeadersCanSpeak = $('#pLeaders').checked; dirty(); };
  $('#pLeadersN').textContent = meta.leaders ? `(${meta.leaders} w Planning Center)` : '';
  $('#pSpeakTeams').innerHTML = meta.teams.map((t) => chk('sp', t, pc().speakerTeams.some((x) => x.toLowerCase() === t.toLowerCase()), t)).join('');
  $$('#pSpeakTeams input').forEach((i) => (i.onchange = () => { pc().speakerTeams = $$('#pSpeakTeams input:checked').map((x) => x.value); dirty(); }));
  renderPositions();
  renderLiveControl();
  renderOauth();
  renderPcoMap();

  // obsada
  $('#pRoster').innerHTML = meta.roster.map((x) => `<tr><td class="a-rname"><b>${esc(x.name)}</b>${x.canSpeak ? ' 🎙' : ''}</td><td data-l="Zespoły">${esc(x.teams.join(', '))}</td><td data-l="Stanowiska">${esc(x.positions.join(', '))}</td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">Brak obsady (brak bieżącego planu).</td></tr>';
}

function renderPositions() {
  const all = [...new Set([...(meta?.positions || []), ...pc().speakerPositions])].sort((a, b) => a.localeCompare(b, 'pl'));
  const on = (p) => pc().speakerPositions.some((x) => x.toLowerCase() === p.toLowerCase());
  $('#pPositions').innerHTML = all.map((p) => `<label><input type="checkbox" value="${esc(p)}" ${on(p) ? 'checked' : ''}> ${esc(p)}</label>`).join('') || '<span class="hint">Brak stanowisk.</span>';
  $$('#pPositions input').forEach((i) => (i.onchange = () => { pc().speakerPositions = $$('#pPositions input:checked').map((x) => x.value); dirty(); }));
}
$('#pPosAdd').onclick = () => {
  const v = $('#pPosNew').value.trim();
  if (!v) return;
  if (!pc().speakerPositions.includes(v)) pc().speakerPositions.push(v);
  $('#pPosNew').value = ''; renderPositions(); dirty();
};

function renderOauth() {
  const oa = (pc().oauthLogin ||= { enabled: false, rosterOnly: false });
  const has = !!pcoInfo?.oauth?.hasCredentials;
  $('#oaEnabled').checked = !!oa.enabled; $('#oaRoster').checked = !!oa.rosterOnly;
  $('#oaEnabled').onchange = () => { oa.enabled = $('#oaEnabled').checked; dirty(); };
  $('#oaRoster').onchange = () => { oa.rosterOnly = $('#oaRoster').checked; dirty(); };
  $('#oaStatus').innerHTML = has ? `<span class="ok-t">✔ Aplikacja OAuth skonfigurowana</span> <span class="hint">(Client ID ${esc(pcoInfo.oauth.clientIdMasked)})</span>${oa.enabled ? '' : ' <span class="warn-t">– włącz przycisk powyżej i zapisz</span>'}`
    : '<span class="warn-t">Brak aplikacji OAuth – skonfiguruj ją poniżej.</span>';
  $('#oaSummary').textContent = has ? 'Zmień aplikację OAuth' : 'Skonfiguruj aplikację OAuth';
  $('#oaRemove').hidden = !has;
  if (!$('#oaRedirect').value) api('GET', '/api/admin/oauth').then((j) => {
    const all = j.redirectUris?.length ? j.redirectUris : [j.redirectUri];
    $('#oaRedirect').value = all.join('\n'); // każdy adres w osobnej linii – w Planning Center wklej wszystkie
    $('#oaRedirect').title = all.length > 1 ? 'W Planning Center wpisz wszystkie adresy (każdy w nowej linii)' : '';
  }).catch(() => {});
}
$('#oaCopy').onclick = () => { $('#oaRedirect').select(); navigator.clipboard?.writeText($('#oaRedirect').value).then(() => toast('Skopiowano adres.')).catch(() => document.execCommand('copy')); };
$('#oaSave').onclick = async () => {
  try { const j = await api('POST', '/api/admin/oauth', { clientId: $('#oaId').value, clientSecret: $('#oaSecret').value }); pcoInfo = j.pco; $('#oaId').value = ''; $('#oaSecret').value = ''; renderOauth(); toast('Zapisano aplikację OAuth.'); }
  catch (e) { toast(e.message, 'err'); }
};
$('#oaRemove').onclick = async () => {
  if (!confirm('Usunąć aplikację OAuth? Logowanie przez Planning Center przestanie działać.')) return;
  try { const j = await api('DELETE', '/api/admin/oauth'); pcoInfo = j.pco; renderOauth(); toast('Usunięto.'); } catch (e) { toast(e.message, 'err'); }
};

function renderLiveControl() {
  const lc = (pc().liveControl ||= { enabled: false, positions: [], teams: [] });
  $('#lcEnabled').checked = !!lc.enabled;
  $('#lcEnabled').onchange = () => { lc.enabled = $('#lcEnabled').checked; $('#lcBox').hidden = !lc.enabled; dirty(); };
  $('#lcBox').hidden = !lc.enabled;
  const has = (arr, v) => arr.some((x) => x.toLowerCase() === v.toLowerCase());
  const positions = [...new Set([...(meta?.positions || []), ...lc.positions])].sort((a, b) => a.localeCompare(b, 'pl'));
  $('#lcPositions').innerHTML = positions.map((p) => `<label><input type="checkbox" value="${esc(p)}" ${has(lc.positions, p) ? 'checked' : ''}> ${esc(p)}</label>`).join('') || '<span class="hint">Brak stanowisk.</span>';
  $('#lcTeams').innerHTML = (meta?.teams || []).map((t) => `<label><input type="checkbox" value="${esc(t)}" ${has(lc.teams, t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
  $$('#lcPositions input').forEach((i) => (i.onchange = () => { lc.positions = $$('#lcPositions input:checked').map((x) => x.value); dirty(); }));
  $$('#lcTeams input').forEach((i) => (i.onchange = () => { lc.teams = $$('#lcTeams input:checked').map((x) => x.value); dirty(); }));
}

// Zespół → kanał: automatycznie (własny kanał) / istniejący kanał / wspólny nowy kanał (po nazwie)
function renderPcoMap() {
  if (!meta?.teams) return;
  $('#pTeamCh').checked = pc().teamChannels !== false;
  $('#pTeamCh').onchange = () => { pc().teamChannels = $('#pTeamCh').checked; renderPcoMap(); dirty(); };
  const map = pc().teamChannelMap;
  const findKey = (team) => Object.keys(map).find((k) => k.toLowerCase() === team.toLowerCase());
  const newNames = [...new Set(Object.values(map).filter((v) => !cfg.channels.some((c) => c.id === v)))];
  $('#pMap').innerHTML = meta.teams.map((team) => {
    const key = findKey(team), val = key ? map[key] : '';
    const opts = [`<option value="">Automatycznie – ${cfg.channels.some((c) => c.name.toLowerCase() === team.toLowerCase()) ? 'istniejący kanał o tej nazwie' : `nowy kanał „${esc(team)}”`}</option>`]
      .concat(cfg.channels.map((c) => `<option value="${esc(c.id)}" ${val === c.id ? 'selected' : ''}>Kanał: ${esc(c.name)}</option>`))
      .concat(newNames.map((n) => `<option value="${esc(n)}" ${val === n ? 'selected' : ''}>Wspólny kanał: ${esc(n)}</option>`))
      .concat('<option value="__new">+ Nowy wspólny kanał…</option>');
    return `<tr data-team="${esc(team)}"><td>${esc(team)}</td><td><select ${pc().teamChannels === false ? 'disabled' : ''}>${opts.join('')}</select>
      <input class="a-newch" placeholder="Nazwa wspólnego kanału, np. Muzycy" hidden></td></tr>`;
  }).join('');
  $$('#pMap tr').forEach((tr) => {
    const team = tr.dataset.team, sel = $('select', tr), inp = $('input', tr);
    const set = (v) => { const k = findKey(team); if (k) delete map[k]; if (v) map[team] = v; dirty(); };
    sel.onchange = () => {
      if (sel.value === '__new') { inp.hidden = false; inp.focus(); return; }
      inp.hidden = true; set(sel.value); renderPcoMap();
    };
    inp.onchange = () => { const v = inp.value.trim(); if (v) { set(v); renderPcoMap(); } };
  });
}

$('#pConnect').onclick = async () => {
  const b = $('#pConnect'); b.disabled = true; b.textContent = 'Sprawdzam…';
  try {
    const j = await api('POST', '/api/admin/pco/credentials', { appId: $('#pAppId').value, secret: $('#pSecret').value });
    pcoInfo = j.pco; $('#pAppId').value = ''; $('#pSecret').value = '';
    toast(`Połączono. Typy wydarzeń: ${j.serviceTypes.join(', ') || '—'}`);
    setTimeout(loadMeta, 2500);
  } catch (e) { toast(e.message, 'err'); }
  b.disabled = false; b.textContent = 'Połącz i sprawdź';
};
$('#pDisconnect').onclick = async () => {
  if (!confirm('Odłączyć konto Planning Center?')) return;
  try { const j = await api('DELETE', '/api/admin/pco/credentials'); pcoInfo = j.pco; meta = null; renderPco(); loadMeta(); toast('Odłączono.'); } catch (e) { toast(e.message, 'err'); }
};
$('#pRefresh').onclick = async () => {
  const b = $('#pRefresh'); b.disabled = true; b.textContent = 'Odświeżanie…';
  try { await api('POST', '/api/admin/pco/refresh'); await loadMeta(); toast('Dane odświeżone.'); } catch (e) { toast(e.message, 'err'); }
  b.disabled = false; b.textContent = 'Odśwież dane z Planning Center';
};

// ---------- start ----------
if (token) boot().then(() => { try { const t = sessionStorage.getItem('ik.adminTab'); if (t) showTab(t); } catch {} });

// ---------- TRANSMISJA ----------
const STATUS_PL = { Idle: 'Web Presenter nie nadaje', Connecting: 'łączy się z serwerem…', Streaming: '📡 sygnał dociera', Interrupted: '⚠️ sygnał przerwany – łączy ponownie' };
function renderStreams() {
  const sm = (cfg.streams ||= { enabled: false, mode: 'direct', channel: '', cacheWarn: 50, events: { start: true, stop: true, problem: true }, devices: [] });
  const chk = (id, get, set) => { const el = $(id); el.checked = get(); el.onchange = () => { set(el.checked); dirty(); renderStreamsMode(); }; };
  chk('#smEnabled', () => sm.enabled, (v) => (sm.enabled = v));
  chk('#smEvSignal', () => sm.events.signal !== false, (v) => (sm.events.signal = v));
  chk('#smEvStart', () => sm.events.start, (v) => (sm.events.start = v));
  chk('#smEvStop', () => sm.events.stop, (v) => (sm.events.stop = v));
  chk('#smEvProblem', () => sm.events.problem, (v) => (sm.events.problem = v));
  const mode = $('#smMode'); mode.value = sm.mode; mode.onchange = () => { sm.mode = mode.value; dirty(); renderStreamsMode(); };
  const cache = $('#smCache'); cache.value = sm.cacheWarn; cache.oninput = () => { sm.cacheWarn = Number(cache.value) || 50; dirty(); };
  const ch = $('#smChannel');
  ch.innerHTML = `<option value="">Kanał ogólny</option>` + cfg.channels.filter((c) => !c.broadcast).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  ch.value = sm.channel || ''; ch.onchange = () => { sm.channel = ch.value; dirty(); };
  $('#smList').innerHTML = sm.devices.map((d, i) => `<div class="a-row sm-row" data-i="${i}">
      <input data-k="name" placeholder="Nazwa, np. YouTube" value="${esc(d.name)}">
      <input data-k="host" placeholder="IP, np. 192.168.1.50" value="${esc(d.host)}">
      <input data-k="port" type="number" min="1" max="65535" value="${esc(d.port || 9977)}" title="Port (domyślnie 9977)">
      <select data-k="platform" title="Platforma"><option value="">— platforma —</option><option value="youtube" ${d.platform === 'youtube' ? 'selected' : ''}>YouTube</option><option value="facebook" ${d.platform === 'facebook' ? 'selected' : ''}>Facebook</option></select>
      <button type="button" data-del title="Usuń">✕</button></div>`).join('') || '<p class="hint">Brak urządzeń.</p>';
  $$('#smList .a-row').forEach((row) => {
    const d = sm.devices[row.dataset.i];
    $$('input', row).forEach((inp) => (inp.oninput = () => { d[inp.dataset.k] = inp.dataset.k === 'port' ? Number(inp.value) || 9977 : inp.value.trim(); dirty(); }));
    $('select', row).onchange = (e) => { d.platform = e.target.value; dirty(); };
    $('[data-del]', row).onclick = () => { sm.devices.splice(row.dataset.i, 1); renderStreams(); dirty(); };
  });
  $('#smAdd').onclick = () => { const fb = sm.devices.length > 0; sm.devices.push({ id: '', name: fb ? 'Facebook' : 'YouTube', host: '', port: 9977, platform: fb ? 'facebook' : 'youtube' }); renderStreams(); dirty(); };
  renderStreamsMode();
}
function renderStreamsMode() {
  $('#smBridgeCard').hidden = !(cfg.streams.enabled && cfg.streams.mode === 'bridge');
}
let bridgeTok = null;
async function loadStreams() {
  try {
    const s = await api('GET', '/api/admin/status');
    const st = s.streams || { devices: [] };
    $('#smStatus').innerHTML = !st.enabled ? 'Obserwowanie wyłączone (albo niezapisane).'
      : st.devices.map((d) => `<div><b>${esc(d.name)}</b>: ${d.platformOn ? (d.live ? '<span class="bad-t">🔴 NA ŻYWO</span> · ' : '<span class="hint">niepubliczna</span> · ') : ''}${!d.online ? `<span class="bad-t">brak kontaktu${d.error ? ' – ' + esc(d.error) : ''}</span>` : `<span class="${d.status === 'Streaming' ? 'ok-t' : d.status === 'Interrupted' ? 'bad-t' : ''}">${esc(STATUS_PL[d.status] || d.status || 'połączono')}</span>${d.duration && d.status !== 'Idle' ? ` · ${esc(d.duration)}` : ''}${d.status === 'Streaming' ? ` · bufor ${d.cache}%` : ''}${d.model ? ` <span class="hint">(${esc(d.model)})</span>` : ''}`}</div>`).join('') || 'Brak urządzeń.';
    if (st.mode === 'bridge') {
      const ago = st.bridgeSeen ? Math.round((Date.now() - st.bridgeSeen) / 1000) : null;
      $('#smBridgeState').innerHTML = ago === null ? '<span class="warn-t">Mostek jeszcze się nie zgłosił.</span>' : ago < 30 ? '<span class="ok-t">Mostek działa.</span>' : `<span class="bad-t">Mostek milczy od ${ago} s.</span>`;
    }
    if (bridgeTok === null) { bridgeTok = (await api('GET', '/api/admin/bridge')).token || ''; showBridgeCmds(); }
  } catch (e) { toast(e.message, 'err'); }
}
function showBridgeCmds() {
  $('#smCmds').hidden = !bridgeTok;
  $('#smToken').textContent = bridgeTok ? 'Wygeneruj nowy token' : 'Wygeneruj token mostka';
  if (!bridgeTok) return;
  const url = location.origin;
  $('#smCmdDocker').textContent = `docker run -d --name interkom-bridge --restart unless-stopped node:22-alpine sh -c "wget -qO /b.mjs ${url}/interkom-bridge.mjs && node /b.mjs --server ${url} --token ${bridgeTok}"`;
  $('#smCmdNode').textContent = `curl -o interkom-bridge.mjs ${url}/interkom-bridge.mjs\nnode interkom-bridge.mjs --server ${url} --token ${bridgeTok}`;
}
$('#smToken').onclick = async () => {
  if (bridgeTok && !confirm('Nowy token unieważni obecny mostek. Kontynuować?')) return;
  try { bridgeTok = (await api('POST', '/api/admin/bridge/token')).token; showBridgeCmds(); toast('Token gotowy – skopiuj polecenie.'); } catch (e) { toast(e.message, 'err'); }
};
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="streams"]').hidden) loadStreams(); }, 4000);

// ---------- YOUTUBE / FACEBOOK ----------
let platT = null;
async function loadPlatforms() {
  try {
    const p = await api('GET', '/api/admin/platforms');
    const yt = p.youtube, fb = p.facebook;
    const when = (t) => (t ? ` · sprawdzono ${new Date(t).toLocaleTimeString('pl-PL')}` : '');
    $('#ytState').innerHTML = yt.connected
      ? `<span class="ok-t">Połączono</span>${yt.channel ? ` – kanał <b>${esc(yt.channel)}</b>` : ''}${yt.live === true ? ' · <span class="bad-t">🔴 transmisja publiczna</span>' : yt.live === false ? ' · brak publicznej transmisji' : ''}${when(yt.checked)}${yt.error ? `<br><span class="bad-t">${esc(yt.error)}</span>` : ''}`
      : `<span class="warn-t">Niepołączony</span>${yt.error ? ` – <span class="bad-t">${esc(yt.error)}</span>` : ''}`;
    $('#ytCode').hidden = !yt.device;
    if (yt.device) $('#ytCode').innerHTML = `Otwórz <a href="${esc(yt.device.url)}" target="_blank" rel="noopener">${esc(yt.device.url)}</a> i wpisz kod: <b style="font-size:20px;letter-spacing:.1em">${esc(yt.device.code)}</b>`;
    $('#ytSetup').open = !yt.connected && !yt.hasClient;
    $('#ytConnect').textContent = yt.connected ? 'Połącz ponownie' : 'Połącz z YouTube';
    $('#ytCheck').hidden = $('#ytOff').hidden = !yt.connected;
    $('#fbState').innerHTML = fb.connected
      ? `<span class="ok-t">Połączono</span> – strona <b>${esc(fb.page)}</b>${fb.live === true ? ' · <span class="bad-t">🔴 transmisja publiczna</span>' : fb.live === false ? ' · brak publicznej transmisji' : ''}${when(fb.checked)}${fb.error ? `<br><span class="bad-t">${esc(fb.error)}</span>` : ''}`
      : `<span class="warn-t">Niepołączony</span>${fb.error ? ` – <span class="bad-t">${esc(fb.error)}</span>` : ''}`;
    $('#fbSetup').open = !fb.connected && !fb.pages && !fb.savedPages;
    $('#fbCheck').hidden = $('#fbOff').hidden = !fb.connected;
    $('#fbSwitch').hidden = !fb.savedPages;
    $('#fbSavedHint').hidden = !fb.hasApp;
    fbState = fb;
    if (fb.pages) renderFbPages(fb.pages);
    clearTimeout(platT);
    if (yt.device) platT = setTimeout(loadPlatforms, 4000); // czekamy na wpisanie kodu
  } catch (e) { toast(e.message, 'err'); }
}
let fbState = null;
function renderFbPages(pages) {
  const cur = fbState?.pageId;
  $('#fbPageList').innerHTML = pages ? '<p class="hint">Wybierz stronę:</p>' + pages.map((p) => `<button type="button" data-page="${esc(p.id)}" class="${p.id === cur ? 'primary' : ''}">${p.id === cur ? '✔ ' : ''}${esc(p.name)}</button>`).join('')
    + (fbState?.hasUserToken ? '<button type="button" id="fbRefresh" title="Pobierz listę stron na nowo (np. gdy doszła nowa strona)">↻ Odśwież listę</button>' : '') : '';
  $('#fbRefresh')?.addEventListener('click', async () => {
    try { renderFbPages((await api('GET', '/api/admin/platforms/facebook/pages?refresh=1')).pages); toast('Lista stron odświeżona.'); } catch (e) { toast(e.message, 'err'); }
  });
  $$('#fbPageList [data-page]').forEach((b) => (b.onclick = async () => {
    try { await api('POST', '/api/admin/platforms/facebook/page', { pageId: b.dataset.page }); toast(`Wybrano stronę: ${b.textContent.replace('✔ ', '')}`); $('#fbPageList').innerHTML = ''; loadPlatforms(); } catch (e) { toast(e.message, 'err'); }
  }));
}
$('#fbSwitch').onclick = async () => {
  try { renderFbPages((await api('GET', '/api/admin/platforms/facebook/pages')).pages); } catch (e) { toast(e.message, 'err'); }
};
$('#ytConnect').onclick = async () => {
  try { await api('POST', '/api/admin/platforms/youtube/start', { clientId: $('#ytId').value, clientSecret: $('#ytSecret').value }); $('#ytSecret').value = ''; loadPlatforms(); } catch (e) { $('#ytSetup').open = true; toast(e.message, 'err'); }
};
$('#fbPages').onclick = async () => {
  try { const r = await api('POST', '/api/admin/platforms/facebook/connect', { appId: $('#fbAppId').value, appSecret: $('#fbAppSecret').value, userToken: $('#fbToken').value }); $('#fbToken').value = ''; $('#fbAppSecret').value = ''; renderFbPages(r.pages); } catch (e) { toast(e.message, 'err'); }
};
for (const p of ['yt', 'fb']) {
  const name = p === 'yt' ? 'youtube' : 'facebook';
  $(`#${p}Check`).onclick = async () => { try { const r = await api('POST', `/api/admin/platforms/${name}/check`); toast(r.error ? r.error : r.live ? `Transmisja publiczna: ${r.title || 'tak'}` : 'Brak publicznej transmisji.', r.error ? 'err' : 'ok'); loadPlatforms(); } catch (e) { toast(e.message, 'err'); } };
  $(`#${p}Off`).onclick = async () => { if (!confirm('Odłączyć konto?')) return; try { await api('POST', `/api/admin/platforms/${name}/disconnect`); loadPlatforms(); } catch (e) { toast(e.message, 'err'); } };
}

// ---------- KSYWKI ----------
let nkPeople = [];
async function loadNicks() {
  try { nkPeople = (await api('GET', '/api/admin/nicks')).people; renderNicks(); } catch (e) { toast(e.message, 'err'); }
}
function renderNicks() {
  const q = ($('#nkFilter').value || '').toLocaleLowerCase('pl');
  const list = nkPeople.filter((p) => !q || p.name.toLocaleLowerCase('pl').includes(q) || p.nicks.some((n) => n.toLocaleLowerCase('pl').includes(q)));
  $('#nkN').textContent = nkPeople.filter((p) => p.nicks.length).length ? `${nkPeople.filter((p) => p.nicks.length).length} z ksywkami` : '';
  $('#nkList').innerHTML = list.slice(0, 80).map((p) => `<div class="nk-row" data-key="${esc(p.key)}">
      <div class="nk-who"><b>${esc(p.name)}</b><span class="hint">${p.online ? '<span class="ok-t">● online</span> · ' : ''}${p.pco ? 'Planning Center' : 'PIN (do wylogowania)'}</span></div>
      <input value="${esc(p.nicks.join(', '))}" placeholder="ksywki oddzielone przecinkami" maxlength="100" autocomplete="off">
      <button type="button">Zapisz</button></div>`).join('') || '<p class="hint">Brak osób.</p>';
  $$('#nkList .nk-row').forEach((row) => {
    const save = async () => {
      try {
        const r = await api('PUT', '/api/admin/nicks', { key: row.dataset.key, nicks: $('input', row).value });
        const p = nkPeople.find((x) => x.key === row.dataset.key); if (p) p.nicks = r.nicks;
        $('input', row).value = r.nicks.join(', ');
        toast(r.nicks.length ? `Zapisano: ${r.nicks.map((n) => '@' + n).join(', ')}` : 'Usunięto ksywki.');
      } catch (e) { toast(e.message, 'err'); }
    };
    $('button', row).onclick = save;
    $('input', row).onkeydown = (e) => { if (e.key === 'Enter') save(); };
  });
}
$('#nkFilter').oninput = renderNicks;

// ---------- ProPresenter ----------
const fmtS = (x) => { if (x == null) return '—'; const a = Math.abs(Math.round(x)); return `${x < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`; };
function renderPP() {
  const c = (cfg.propresenter ||= { enabled: false, mode: 'direct', host: '', port: 50001, timer: 'Interkom – punkt', endTimer: '' });
  const bind = (id, k, num) => { const el = $(id); el.value = c[k] ?? ''; el.oninput = () => { c[k] = num ? Number(el.value) || 0 : el.value.trim(); dirty(); }; };
  bind('#ppHost', 'host'); bind('#ppPort', 'port', true); bind('#ppTimer', 'timer'); bind('#ppEnd', 'endTimer');
  const en = $('#ppEnabled'); en.checked = c.enabled; en.onchange = () => { c.enabled = en.checked; dirty(); };
  const m = $('#ppMode'); m.value = c.mode; m.onchange = () => { c.mode = m.value; dirty(); };
}
async function loadPP() {
  try {
    const r = await api('GET', '/api/admin/propresenter');
    const st = r.status || {};
    const tm = Object.entries(st.timers || {}).map(([n, t]) => `„${esc(n)}”: ProPresenter <b>${esc(t.shown || '—')}</b> (${esc({ running: 'odlicza', stopped: 'zatrzymany', overrun: 'po czasie' }[t.state] || t.state || '?')}), powinno być ${fmtS(t.expected)}`).join('<br>');
    $('#ppState').innerHTML = !r.enabled ? '<span class="hint">Wyłączone (albo niezapisane).</span>'
      : (st.online ? `<span class="ok-t">● Połączono</span>${st.version ? ` <span class="hint">${esc(st.version)}</span>` : ''}` : `<span class="bad-t">● ${esc(st.error || (r.mode === 'bridge' ? 'mostek jeszcze nie zgłosił ProPresenter' : 'brak połączenia'))}</span>`)
        + `<br><span class="hint">Bieżący punkt: ${r.target ? `${esc(r.target.title)} – zostało ${fmtS(r.target.remaining)}` : 'brak (albo punkt bez długości) – zegar zatrzymany'}</span>`
        + (tm ? `<br>${tm}` : '');
  } catch (e) { $('#ppState').textContent = e.message; }
}
$('#ppSync').onclick = async () => { try { const r = await api('POST', '/api/admin/propresenter/sync'); toast(r.via === 'bridge' ? 'Wysłano do mostka.' : r.ok ? 'Zegar zsynchronizowany.' : r.error || 'Brak połączenia', r.ok || r.via ? 'ok' : 'err'); setTimeout(loadPP, 1500); } catch (e) { toast(e.message, 'err'); } };
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="pco"]').hidden) loadPP(); }, 3000);

// ---------- kopia ustawień ----------
$('#bkDownload').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/admin/backup', { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Błąd ${r.status}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'interkom-ustawienia.json';
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('#bkState').textContent = `Zapisano plik ${name}.`;
  } catch (e) { toast(e.message, 'err'); }
});
$('#bkFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  if (!f) return;
  let b;
  try { b = JSON.parse(await f.text()); } catch { return toast('To nie jest plik kopii ustawień (zły format).', 'err'); }
  if (b?.app !== 'interkom' || !b.files) return toast('To nie jest plik kopii ustawień Interkomu.', 'err');
  const when = b.created ? new Date(b.created).toLocaleString('pl-PL') : '?';
  if (!confirm(`Wczytać kopię z ${when} (wersja ${b.version || '?'})?\n\nObecne ustawienia zostaną zastąpione, a interkom uruchomi się ponownie (kilka sekund przerwy w łączności).`)) return;
  try {
    const r = await api('POST', '/api/admin/restore', b);
    $('#bkState').textContent = `Przywrócono ${r.files} plików. Interkom uruchamia się ponownie…`;
    toast('Ustawienia przywrócone – trwa ponowne uruchomienie.');
    // poczekaj, aż serwer wstanie, i odśwież panel
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      try { if ((await fetch('/api/health', { cache: 'no-store' })).ok && i > 1) { location.reload(); return; } } catch {}
    }
    $('#bkState').textContent = 'Serwer nie wrócił po minucie – sprawdź: sudo docker compose ps';
  } catch (e2) { toast(e2.message, 'err'); }
});

// ---------- dźwięk transmisji (program) ----------
function renderProgram() {
  const c = (cfg.program ||= { enabled: false, name: 'Dźwięk transmisji', duck: 30 });
  const en = $('#pgEnabled'); en.checked = !!c.enabled; en.onchange = () => { c.enabled = en.checked; dirty(); };
  const nm = $('#pgName'); nm.value = c.name || ''; nm.oninput = () => { c.name = nm.value.trim() || 'Dźwięk transmisji'; dirty(); };
  const lc = $('#pgLocal'); lc.checked = c.local !== false; lc.onchange = () => { c.local = lc.checked; dirty(); };
  const so = $('#pgSource'); so.value = c.source || 'browser'; so.onchange = () => { c.source = so.value; dirty(); };
  const br = $('#pgBitrate'); br.value = String(c.bitrate || 160); br.onchange = () => { c.bitrate = Number(br.value); dirty(); };
  const dk = $('#pgDuck'); dk.value = c.duck ?? 30; $('#pgDuckVal').textContent = `${dk.value}%`;
  dk.oninput = () => { c.duck = Number(dk.value); $('#pgDuckVal').textContent = `${dk.value}%`; dirty(); };
}
let pgKey = null;
function showPgLink() {
  $('#pgLinkBox').hidden = !pgKey;
  $('#pgKey').textContent = pgKey ? 'Wygeneruj nowy link (stary przestanie działać)' : 'Wygeneruj link nadajnika';
  if (!pgKey) return;
  const url = `${location.origin}/zrodlo/#k=${pgKey}`;
  $('#pgLink').textContent = url; $('#pgOpen').href = url;
}
let pgLast = null;
async function loadProgram() {
  try {
    const r = await api('GET', '/api/admin/program');
    pgLast = r;
    const srv = r.source === 'server';
    $('#pgSrv').hidden = !(r.enabled && srv); $('#pgBrowser').hidden = srv;
    $('#pgSrcH').textContent = srv ? 'Nadajnik na serwerze' : 'Komputer z dźwiękiem (nadajnik)';
    if (srv) { renderServerSrc(r); return; }
    if (r.key !== pgKey) { pgKey = r.key; showPgLink(); }
    const i = r.info || {}, fresh = r.beatAge != null && r.beatAge < 10000;
    const db = (x) => (x > 0.000001 ? `${(20 * Math.log10(x)).toFixed(0)} dB` : '–∞');
    $('#pgState').innerHTML = !r.enabled ? '<span class="hint">Wyłączone (albo niezapisane).</span>'
      : !pgKey ? '<span class="hint">Wygeneruj link i otwórz go na komputerze z dźwiękiem.</span>'
      : !fresh ? '<span class="bad-t">● Nadajnik nie jest otwarty</span>'
      : i.error ? `<span class="bad-t">● ${esc(i.error)}</span>`
      : i.on && r.published !== false ? `<span class="${i.muted ? 'warn-t' : 'ok-t'}">● ${i.muted ? 'Wyciszony' : 'Nadaje'}</span> <span class="hint">${esc(i.device || '')} · ${esc(i.route || '')} · wejście ${fmtDb(i.gain)} · szczyty L ${db(i.peak?.[0])} / P ${db(i.peak?.[1])}${i.raw ? ' · ⚠ bez regulacji – ktoś musi kliknąć w stronę nadajnika' : ''}${r.local === false && i.localOn === false ? '' : `<br>📡 lokalny odsłuch: ${i.localOn ? `działa – słucha lokalnie ${i.local || 0} ${(i.local || 0) === 1 ? 'osoba' : 'osób'}` : 'nadajnik nie jest połączony do lokalnego odsłuchu'}`}${i.lat ? `<br>⏱ opóźnienie po stronie nadajnika ok. ${i.lat.total} ms (wejście ${i.lat.cap} · obróbka ${i.lat.proc}${i.direct ? ', tor bezpośredni' : ''} · Opus ${i.lat.enc} · do serwera ${i.lat.up})${i.lat.tcp ? ' · ⚠ połączenie przez TCP – sprawdź port 7882/udp' : ''}` : ''}</span>`
      : `<span class="warn-t">● Nadajnik otwarty, ale nie nadaje</span> <span class="hint">${esc(i.device || '')}</span>`;
    $('#pgRemote').hidden = !(r.enabled && fresh);
    if (fresh && Date.now() - pgTouched > 6000) { $('#pgGain').value = i.gain ?? 0; $('#pgGainVal').textContent = fmtDb(i.gain ?? 0); }
    pgMuted = !!i.muted; $('#pgMute').textContent = pgMuted ? '🔊 Włącz dźwięk' : '🔇 Wycisz u wszystkich';
  } catch (e) { $('#pgState').textContent = e.message; }
}
const fmtDb = (g) => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(Number(g) || 0).toFixed(1).replace('.', ',')} dB`;
let pgTouched = 0, pgMuted = false, pgGainT;
$('#pgGain').oninput = () => {
  pgTouched = Date.now(); $('#pgGainVal').textContent = fmtDb(Number($('#pgGain').value));
  clearTimeout(pgGainT); pgGainT = setTimeout(() => api('POST', '/api/admin/program/control', { gain: Number($('#pgGain').value) }).catch((e) => toast(e.message, 'err')), 250);
};
$('#pgGain0').onclick = () => { $('#pgGain').value = 0; $('#pgGain').oninput(); };
$('#pgMute').onclick = async () => { try { await api('POST', '/api/admin/program/control', { muted: !pgMuted }); toast(pgMuted ? 'Włączam dźwięk…' : 'Wyciszam…'); setTimeout(loadProgram, 2500); } catch (e) { toast(e.message, 'err'); } };
// ---- nadajnik na serwerze (usługa audio) ----
const pgDb = (x) => (x > 0.000001 ? `${(20 * Math.log10(x)).toFixed(0)} dB` : '–∞');
let psTouched = 0;
function renderServerSrc(r) {
  const i = r.info || {}, sv = r.server || {}, fresh = r.beatAge != null && r.beatAge < 3000 && i.server;
  const lat = i.lat ? ` · opóźnienie nadajnika ok. ${i.lat.total} ms` : '';
  $('#pgState').innerHTML = !fresh ? '<span class="bad-t">● Usługa audio na serwerze nie odpowiada</span> <span class="hint">– sprawdź: sudo docker compose ps (usługa „audio”; włączana instalatorem, gdy serwer ma kartę dźwiękową)</span>'
    : !sv.on ? '<span class="hint">● Gotowy – nadawanie wyłączone</span>'
    : i.error ? `<span class="bad-t">● ${esc(i.error)}</span>`
    : i.on ? `<span class="${i.muted ? 'warn-t' : 'ok-t'}">● ${i.muted ? 'Wyciszony' : 'Nadaje'}</span> <span class="hint">${esc(i.device || '')} · ${esc(i.route || '')} · lokalnie słucha ${i.local || 0}${lat}</span>`
    : '<span class="warn-t">● Uruchamianie…</span>';
  // wejścia
  const devs = i.devices || [{ id: 'test', name: 'Sygnał testowy', maxCh: 2 }];
  const sel = $('#psDev'), cur = sv.device || 'test';
  const opts = devs.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.maxCh > 2 ? ` (${d.maxCh} kan.)` : ''}</option>`).join('') + (devs.some((d) => d.id === cur) ? '' : `<option value="${esc(cur)}">${esc(cur)} (niedostępne)</option>`);
  if (sel.dataset.o !== opts) { sel.innerHTML = opts; sel.dataset.o = opts; }
  if (document.activeElement !== sel) sel.value = cur;
  const maxCh = (devs.find((d) => d.id === cur) || {}).maxCh || 2;
  const chOpts = Array.from({ length: maxCh }, (_, k) => `<option value="${k}">Kanał ${k + 1}</option>`).join('');
  for (const [id, v] of [['#psL', sv.l ?? 0], ['#psR', sv.r ?? 1]]) { const e = $(id); if (e.dataset.o !== chOpts) { e.innerHTML = chOpts; e.dataset.o = chOpts; } if (document.activeElement !== e) e.value = Math.min(v, maxCh - 1); }
  $('#psMode').value = sv.mono ? 'mono' : 'stereo'; $('#psRLab').textContent = sv.mono ? '+ kanał' : 'P (prawy)';
  $('#psChInfo').textContent = maxCh > 2 ? `To wejście ma ${maxCh} kanałów – wybierz te z miksem do transmisji (np. w Qu-SB domyślnie Main LR = 17 i 18).` : '';
  $('#psOn').checked = !!sv.on; $('#psLim').checked = sv.limiter !== false;
  if (Date.now() - psTouched > 3000) { $('#psGain').value = sv.gain ?? 0; $('#psGainVal').textContent = fmtDb(sv.gain ?? 0); }
  $('#psMute').textContent = sv.muted ? '🔊 Włącz dźwięk' : '🔇 Wycisz u wszystkich';
  // wskaźnik
  ['L', 'R'].forEach((k, n) => {
    const p = fresh && sv.on ? i.peak?.[n] || 0 : 0, db = p > 0.000001 ? 20 * Math.log10(p) : -60;
    const pos = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const bar = $('#psm' + k); bar.style.width = pos + '%'; bar.style.setProperty('--w', `${10000 / Math.max(1, pos)}%`);
    $('#psd' + k).textContent = fresh && sv.on ? pgDb(p) : '–∞';
  });
}
let psT;
async function postServer(patch, delay = 0) {
  clearTimeout(psT);
  psT = setTimeout(async () => {
    try { const r = await api('POST', '/api/admin/program/server', { server: patch }); if (pgLast) { pgLast.server = r.server; renderServerSrc(pgLast); } } catch (e) { toast(e.message, 'err'); }
  }, delay);
}
$('#psOn').onchange = (e) => postServer({ on: e.target.checked });
$('#psDev').onchange = (e) => postServer({ device: e.target.value, l: 0, r: 1 });
$('#psMode').onchange = (e) => postServer({ mono: e.target.value === 'mono' });
$('#psL').onchange = (e) => postServer({ l: Number(e.target.value) });
$('#psR').onchange = (e) => postServer({ r: Number(e.target.value) });
$('#psLim').onchange = (e) => postServer({ limiter: e.target.checked });
const psGain = (v) => { psTouched = Date.now(); v = Math.max(-24, Math.min(24, Math.round(v * 2) / 2)); $('#psGain').value = v; $('#psGainVal').textContent = fmtDb(v); postServer({ gain: v }, 150); };
$('#psGain').oninput = (e) => psGain(Number(e.target.value));
$('#psDn').onclick = () => psGain(Number($('#psGain').value) - 1);
$('#psUp').onclick = () => psGain(Number($('#psGain').value) + 1);
$('#psG0').onclick = () => psGain(0);
$('#psMute').onclick = () => postServer({ muted: !(pgLast?.server?.muted) });
$('#psScan').onclick = async () => { try { await api('POST', '/api/admin/program/scan'); toast('Szukam wejść…'); setTimeout(loadProgram, 2500); } catch (e) { toast(e.message, 'err'); } };
// szybsze odświeżanie wskaźnika, gdy widać nadajnik na serwerze
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="audio"]').hidden && !$('#pgSrv').hidden) loadProgram(); }, 600);

$('#pgKey').onclick = async () => {
  if (pgKey && !confirm('Nowy link unieważni poprzedni – nadajnik trzeba będzie otworzyć nowym linkiem. Kontynuować?')) return;
  try { pgKey = (await api('POST', '/api/admin/program/key')).key; showPgLink(); loadProgram(); } catch (e) { toast(e.message, 'err'); }
};
$('#pgCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#pgLink').textContent); toast('Skopiowano link.'); } catch { toast('Zaznacz link i skopiuj ręcznie.', 'err'); } };
setInterval(() => { if (!$('#aMain').hidden && !$('[data-panel="audio"]').hidden) loadProgram(); }, 3000);
