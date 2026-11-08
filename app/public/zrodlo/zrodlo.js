// Interkom – nadajnik dźwięku transmisji (mix z konsolety → wszyscy w aplikacji)
// Strona działa na komputerze w kościele. Klucz z panelu przychodzi w linku (#k=…) i zostaje zapamiętany.
// Tor dźwięku (Web Audio): wejście → wybór kanałów (L/P albo mono) → poziom wejścia → ogranicznik → nadawanie.
import { Room, RoomEvent, Track, LocalAudioTrack } from '/vendor/livekit-client.esm.mjs';

const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('ikp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('ikp.' + k, JSON.stringify(v)); } catch {} },
};
const hashKey = new URLSearchParams(location.hash.slice(1)).get('k');
if (hashKey) { store.set('key', hashKey); history.replaceState(null, '', location.pathname); } // klucza nie zostawiamy w pasku adresu
const KEY = store.get('key', null);

const S = { room: null, stream: null, track: null, pub: null, want: false, muted: false, error: '', starting: false, wake: null,
  actx: null, g: null, nch: 2, raw: false, direct: false, lat: null, cmdSeq: store.get('cmdSeq', 0) };
const DEF = { gain: 0, l: 0, r: 1, mono: false, limiter: true };
let set = { ...DEF };
const devKey = () => 'set:' + ($('#dev').value || 'default');
const loadSet = () => { set = { ...DEF, ...store.get(devKey(), {}) }; };
const saveSet = () => store.set(devKey(), set);

function setState(kind, text, hint) {
  $('#dot').className = 'dot ' + kind;
  $('#state').textContent = text;
  if (hint !== undefined) $('#stateHint').textContent = hint;
}
function render() {
  const live = !!S.pub;
  $('#go').textContent = S.want ? '■ Zatrzymaj nadawanie' : '▶ Nadawaj';
  $('#go').classList.toggle('on', S.want);
  $('#mute').disabled = !live;
  $('#mute').setAttribute('aria-pressed', String(S.muted));
  $('#mute').textContent = S.muted ? '🔇 Wyciszone – włącz' : '🔇 Wycisz';
  $('#rawWarn').hidden = !(live && S.raw);
  if (S.error) setState('bad', 'Błąd', S.error);
  else if (live && S.muted) setState('warn', 'Wyciszone', 'Słuchacze nic nie słyszą, dopóki nie włączysz dźwięku.');
  else if (live) setState('ok', 'Nadaje', `${devLabel()} · ${routeText()} · poziom ${fmtGain(set.gain)} · ${S.direct && !S.raw ? 'tor bezpośredni (najmniejsze opóźnienie)' : 'z obróbką'}${S.lat ? ` · opóźnienie po stronie nadajnika ok. ${S.lat.total} ms${S.lat.tcp ? ' ⚠ połączenie TCP' : ''}` : ''}. Słuchacze włączają odsłuch przyciskiem 🎵 w aplikacji.`);
  else if (S.want) setState('warn', 'Łączenie…', 'Łączę z serwerem interkomu…');
  else setState('', 'Nie nadaje', 'Wybierz wejście z dźwiękiem z konsolety i kliknij „Nadawaj”.');
}
const devLabel = () => $('#dev').selectedOptions[0]?.textContent || 'wejście';
const routeText = () => (S.nch < 2 ? 'mono' : set.mono ? `mono z kanałów ${set.l + 1}+${set.r + 1}` : `kanały ${set.l + 1}/${set.r + 1}`);
const fmtGain = (g) => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g).toFixed(1).replace('.', ',')} dB`;

// ---------- wejścia ----------
async function listDevices() {
  let devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  if (devs.length && !devs[0].label) { // nazwy widać dopiero po zgodzie na mikrofon
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
  }
  const sel = $('#dev'), want = sel.value || store.get('dev', '');
  sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${(d.label || `Wejście ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('') || '<option value="">(brak wejść audio)</option>';
  if (devs.some((d) => d.deviceId === want)) sel.value = want;
}
async function openInput() {
  const id = $('#dev').value;
  // prosimy o wszystkie kanały – Chrome/Edge dają najwyżej 2, Firefox tyle, ile ma urządzenie
  const audio = { channelCount: { ideal: 32 }, sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(id ? { deviceId: { exact: id } } : {}) };
  const st = await navigator.mediaDevices.getUserMedia({ audio });
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = st;
  S.nch = Math.max(1, Number(st.getAudioTracks()[0].getSettings().channelCount) || 2);
  loadSet();
  if (set.l >= S.nch) set.l = 0;
  if (set.r >= S.nch) set.r = Math.min(1, S.nch - 1);
  buildGraph();
  renderControls();
  return st.getAudioTracks()[0];
}

// ---------- tor Web Audio ----------
function ensureCtx() {
  if (S.actx) return;
  S.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  S.dest = S.actx.createMediaStreamDestination(); // stały – zmiana kanałów i poziomu nie wymaga ponownego publikowania
  S.dest.channelCount = 2; S.dest.channelCountMode = 'explicit';
  S.trim = S.actx.createGain();
  S.lim = S.actx.createDynamicsCompressor();
  Object.assign(S.lim, {}); S.lim.threshold.value = -3; S.lim.knee.value = 0; S.lim.ratio.value = 20; S.lim.attack.value = 0.002; S.lim.release.value = 0.15;
  S.post = S.actx.createGain(); // punkt pomiaru = to, co słyszą słuchacze
  S.post.connect(S.dest);
  const sp = S.actx.createChannelSplitter(2); S.post.connect(sp);
  S.an = [0, 1].map((i) => { const a = S.actx.createAnalyser(); a.fftSize = 2048; sp.connect(a, i); return a; });
  S.actx.onstatechange = () => { renderCtxHint(); if (S.actx.state === 'running') useProcessed(); };
}
function buildGraph() {
  ensureCtx();
  try { S.src?.disconnect(); S.splitter?.disconnect(); S.merger?.disconnect(); S.half?.forEach((n) => n.disconnect()); } catch {}
  S.src = S.actx.createMediaStreamSource(S.stream);
  const n = S.nch;
  S.src.channelCount = n; S.src.channelCountMode = 'explicit'; S.src.channelInterpretation = 'discrete';
  S.splitter = S.actx.createChannelSplitter(Math.max(1, n));
  S.src.connect(S.splitter);
  S.merger = S.actx.createChannelMerger(2);
  S.half = [];
  if (n === 1) { S.splitter.connect(S.merger, 0, 0); S.splitter.connect(S.merger, 0, 1); }
  else if (set.mono) { // suma dwóch wybranych kanałów na oba wyjścia (−6 dB, żeby nie przesterować)
    const chans = set.l === set.r ? [set.l] : [set.l, set.r];
    for (const c of chans) { const h = S.actx.createGain(); h.gain.value = chans.length > 1 ? 0.5 : 1; S.splitter.connect(h, c); h.connect(S.merger, 0, 0); h.connect(S.merger, 0, 1); S.half.push(h); }
  } else { S.splitter.connect(S.merger, set.l, 0); S.splitter.connect(S.merger, set.r, 1); }
  try { S.merger.disconnect(); S.trim.disconnect(); S.lim.disconnect(); } catch {}
  S.merger.connect(S.trim);
  if (set.limiter) { S.trim.connect(S.lim); S.lim.connect(S.post); } else S.trim.connect(S.post);
  applyGain();
  renderCtxHint();
}
function applyGain() { if (S.trim) S.trim.gain.setTargetAtTime(Math.pow(10, set.gain / 20), S.actx.currentTime, 0.02); }
const processedTrack = () => S.dest.stream.getAudioTracks()[0];
const rawTrack = () => S.stream.getAudioTracks()[0];
const ctxRunning = () => S.actx?.state === 'running';
// Ustawienia „neutralne” (0 dB, kanały 1/2 stereo) – dźwięk idzie prosto z wejścia, z pominięciem Web Audio:
// kilka–kilkanaście ms mniej opóźnienia. Obróbka włącza się sama, gdy zmienisz poziom albo kanały.
const neutral = () => set.gain === 0 && !set.mono && S.nch === 2 && set.l === 0 && set.r === 1;
const wantDirect = () => neutral() || !ctxRunning();
async function syncTrack() {
  localSync();
  if (!S.track || !S.stream) return;
  const direct = wantDirect();
  S.raw = direct && !neutral(); // bez regulacji wbrew ustawieniom (czeka na kliknięcie)
  if (direct === S.direct && S.track.mediaStreamTrack === (direct ? rawTrack() : processedTrack())) { render(); return; }
  try { await S.track.replaceTrack(direct ? rawTrack() : processedTrack(), true); S.direct = direct; } catch (e) { console.warn(e); }
  render();
}
// Bez kliknięcia przeglądarka nie uruchamia Web Audio – wtedy nadajemy wejście bez obróbki (kanały 1–2, poziom 0 dB)
// i przełączamy na tor z regulacją, gdy tylko ktoś kliknie w stronę.
const useProcessed = () => syncTrack();
function renderCtxHint() {
  const run = ctxRunning();
  $('#meterHint').classList.toggle('err', !run);
  $('#meterHint').textContent = run ? 'Wskaźnik pokazuje poziom wysyłany do słuchaczy (po regulacji). Najlepiej, gdy szczyty dochodzą do −12…−6 dB i nie zapalają się na czerwono.'
    : 'Kliknij gdziekolwiek na stronie, żeby włączyć wskaźnik i regulację poziomu (przeglądarka wymaga jednego kliknięcia).';
}
document.addEventListener('pointerdown', () => { if (S.actx && !ctxRunning()) S.actx.resume(); });

// ---------- kontrolki: kanały, poziom, ogranicznik ----------
function renderControls() {
  const n = S.nch;
  const opts = Array.from({ length: n }, (_, i) => `<option value="${i}">Kanał ${i + 1}</option>`).join('');
  $('#chL').innerHTML = opts; $('#chR').innerHTML = opts;
  $('#chL').value = set.l; $('#chR').value = set.r;
  $('#chMode').value = set.mono ? 'mono' : 'stereo';
  $('#chRow').hidden = n < 2;
  $('#chRLabel').textContent = set.mono ? '+ kanał' : 'P (prawy)';
  $('#chInfo').innerHTML = n < 2 ? 'To wejście ma jeden kanał – idzie na oba (mono).'
    : `Przeglądarka widzi <b>${n}</b> ${n < 5 ? 'kanały' : 'kanałów'} tego wejścia.` + (n === 2 ? ' Potrzebujesz innych kanałów (np. 17–18)? Zobacz „Konsoleta wielokanałowa / Dante” niżej.' : '');
  $('#gain').value = set.gain; $('#gainVal').textContent = fmtGain(set.gain);
  $('#limiter').checked = set.limiter;
}
const onRoute = () => { set.l = Number($('#chL').value); set.r = Number($('#chR').value); set.mono = $('#chMode').value === 'mono'; saveSet(); buildGraph(); renderControls(); syncTrack(); };
$('#chL').onchange = onRoute; $('#chR').onchange = onRoute; $('#chMode').onchange = onRoute;
function setGain(db, fromRemote) {
  set.gain = Math.max(-24, Math.min(24, Math.round(db * 2) / 2)); saveSet(); applyGain();
  $('#gain').value = set.gain; $('#gainVal').textContent = fmtGain(set.gain);
  syncTrack();
}
$('#gain').oninput = (e) => setGain(Number(e.target.value));
$('#gain0').onclick = () => setGain(0);
$('#gainDn').onclick = () => setGain(set.gain - 1);
$('#gainUp').onclick = () => setGain(set.gain + 1);
$('#limiter').onchange = (e) => { set.limiter = e.target.checked; saveSet(); buildGraph(); };

// ---------- wskaźnik poziomu L/P ----------
const peakHold = [{ v: -Infinity, t: 0 }, { v: -Infinity, t: 0 }], lastPeak = [0, 0];
const buf = new Float32Array(2048);
function meterLoop() {
  ['L', 'R'].forEach((side, i) => {
    const a = S.an?.[i];
    let peak = 0;
    if (a && ctxRunning()) { a.getFloatTimeDomainData(buf); for (let j = 0; j < buf.length; j++) { const v = Math.abs(buf[j]); if (v > peak) peak = v; } }
    if (S.muted) peak = 0;
    lastPeak[i] = Math.max(peak, lastPeak[i] * 0.9);
    const db = lastPeak[i] > 0.000001 ? 20 * Math.log10(lastPeak[i]) : -Infinity;
    const pos = (d) => Math.max(0, Math.min(100, ((d + 60) / 60) * 100));
    const h = peakHold[i], now = performance.now();
    if (db > h.v || now - h.t > 1500) { h.v = db; h.t = now; }
    const bar = $('#m' + side); bar.style.width = pos(db) + '%'; bar.style.setProperty('--w', `${10000 / Math.max(1, pos(db))}%`);
    $('#p' + side).style.left = `calc(${pos(h.v)}% - 2px)`;
    $('#d' + side).textContent = Number.isFinite(db) ? `${db.toFixed(0)} dB` : '–∞ dB';
  });
  requestAnimationFrame(meterLoop);
}

// ---------- nadawanie ----------
async function start() {
  if (S.starting) return;
  S.starting = true; S.error = ''; render();
  try {
    const r = await fetch('/api/program/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 409) S.want = false; // 409: źródłem jest wejście audio serwera // zły klucz – ponawianie nic nie da (wyłączone w panelu = 403: próbujemy dalej co 10 s)
    if (!r.ok) throw new Error(j.error || `Serwer odpowiedział ${r.status}`);
    $('#org').textContent = `${j.org || 'Interkom'} · słuchacze widzą: „${j.name}”`;
    if (j.bitrate) setBitrate(j.bitrate);
    if (!S.stream || S.stream.getAudioTracks()[0]?.readyState !== 'live') await openInput();
    try { await S.actx.resume(); } catch {}
    localStart(); // telefony w sieci kościoła mogą słuchać prosto stąd, niezależnie od serwera w chmurze
    const room = new Room({ adaptiveStream: false, dynacast: false });
    room.on(RoomEvent.Disconnected, () => {
      if (S.room !== room) return;
      S.pub = null; S.room = null; S.track = null; render();
      if (S.want) setTimeout(() => S.want && !S.room && start(), 3000); // samo wraca po utracie internetu
    });
    room.on(RoomEvent.Reconnecting, () => setState('warn', 'Łączenie…', 'Chwilowa utrata połączenia – wracam…'));
    room.on(RoomEvent.Reconnected, render);
    const url = j.livekit.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    await room.connect(url, j.livekit.token);
    S.room = room;
    S.direct = wantDirect(); S.raw = S.direct && !neutral();
    S.track = new LocalAudioTrack(S.direct ? rawTrack() : processedTrack(), undefined, true);
    S.pub = await room.localParticipant.publishTrack(S.track, {
      name: 'program', source: Track.Source.Microphone,
      audioPreset: { maxBitrate: KBPS() * 1000, priority: 'high' }, forceStereo: true, dtx: false, red: false,
    });
    if (S.muted) await S.pub.mute();
    store.set('dev', $('#dev').value);
    keepAwake();
  } catch (e) {
    S.error = /Permission|NotAllowed/i.test(e?.name + e?.message) ? 'Przeglądarka nie dała dostępu do wejścia audio – zezwól na mikrofon dla tej strony.' : (e?.message || String(e));
    await stop(true);
    if (S.want) setTimeout(() => S.want && !S.room && start(), 10000); // np. serwer niedostępny – próbuj dalej
  } finally { S.starting = false; render(); }
}
async function stop(keepWant) {
  if (!keepWant) { S.want = false; localStop(); }
  const room = S.room; S.room = null; S.pub = null;
  try { await room?.disconnect(); } catch {}
  S.track = null;
  render();
}
$('#go').onclick = async () => {
  S.actx?.resume();
  if (S.want) { await stop(); return; }
  S.want = true; await start();
};
$('#mute').onclick = async () => {
  S.muted = !S.muted;
  try { if (S.pub) await (S.muted ? S.pub.mute() : S.pub.unmute()); } catch {}
  localSync();
  render();
};
$('#dev').onchange = async () => {
  store.set('dev', $('#dev').value);
  try {
    await openInput();
    if (S.track) { S.direct = null; await syncTrack(); } // nowe wejście – podmień nadawaną ścieżkę
    S.error = ''; render();
  } catch (e) { S.error = e.message; render(); }
};
$('#refresh').onclick = listDevices;
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
$('#auto').checked = store.get('auto', false);
$('#auto').onchange = () => store.set('auto', $('#auto').checked);

async function keepAwake() { try { S.wake ||= await navigator.wakeLock?.request('screen'); S.wake?.addEventListener('release', () => (S.wake = null)); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.pub) keepAwake(); });

// ---------- pomiar opóźnienia po stronie nadajnika ----------
// wejście (bufor sterownika) + obróbka Web Audio + ramka Opus (20 ms) + droga do serwera (połowa RTT)
async function measure() {
  if (!S.track) { S.lat = null; return; }
  try {
    const rep = await S.track.getRTCStatsReport();
    let pair = null, tr = null, rin = null;
    rep?.forEach((x) => { if (x.type === 'transport') tr = x; if (x.type === 'remote-inbound-rtp') rin = x; });
    if (tr?.selectedCandidatePairId) pair = rep.get(tr.selectedCandidatePairId);
    if (!pair) rep?.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
    const local = pair ? rep.get(pair.localCandidateId) : null;
    const rtt = (pair?.currentRoundTripTime ?? rin?.roundTripTime ?? 0) * 1000;
    const cap = Math.round((Number(rawTrack()?.getSettings?.().latency) || 0.01) * 1000);
    const proc = S.direct ? 0 : Math.round(((S.actx?.baseLatency || 0.01) * 1000) + 10);
    const up = Math.round(rtt / 2);
    S.lat = { cap, proc, enc: 20, up, total: cap + proc + 20 + up, tcp: local?.protocol === 'tcp' || local?.relayProtocol === 'tcp' || local?.relayProtocol === 'tls', relay: local?.candidateType === 'relay' };
  } catch { S.lat = null; }
  render();
}
setInterval(measure, 3000);

// stan dla panelu administratora; panel może też zdalnie zmienić poziom wejścia
async function beat() {
  if (!KEY) return;
  try {
    const r = await fetch('/api/program/beat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY, on: !!S.pub, muted: S.muted, device: devLabel(), peak: lastPeak, error: S.error,
        gain: set.gain, route: routeText(), nch: S.nch, raw: S.raw, direct: !!S.direct, limiter: set.limiter, lat: S.lat, local: S.localCount?.() ?? 0, cmdSeq: S.cmdSeq }) });
    if (r.status === 401) { S.error = 'Klucz nadajnika jest nieaktualny – otwórz nowy link z panelu.'; render(); return; }
    const j = await r.json().catch(() => ({}));
    if (j.cmd && j.cmd.seq > S.cmdSeq) {
      S.cmdSeq = j.cmd.seq; store.set('cmdSeq', S.cmdSeq);
      if (typeof j.cmd.gain === 'number') setGain(j.cmd.gain);
      if (typeof j.cmd.muted === 'boolean' && j.cmd.muted !== S.muted) $('#mute').click();
    }
  } catch {}
}
setInterval(beat, 2000);

// ---------- lokalny serwer dźwięku: WebRTC prosto do telefonów w tej samej sieci ----------
// Ten komputer sam wysyła dźwięk każdemu telefonowi w sieci kościoła (bez przechodzenia przez VPS).
// Serwer interkomu tylko przekazuje kilka wiadomości przy łączeniu. Kto jest poza siecią kościoła, słucha przez serwer.
const L = { ws: null, peers: new Map(), want: false, retry: null };
const MAX_PEERS = 40;
function localOut() { if (!S.stream || S.muted) return null; return wantDirect() ? rawTrack() : processedTrack(); }
function localSync() { const t = localOut(); for (const p of L.peers.values()) if (p.sender && p.sender.track !== t) p.sender.replaceTrack(t).catch(() => {}); renderLocal(); }
function localStart() {
  L.want = true;
  if (L.ws && L.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?program=${encodeURIComponent(KEY)}`);
  L.ws = ws;
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onLocalMsg(m).catch((err) => console.warn('lokalny odsłuch', err)); };
  ws.onclose = () => {
    if (L.ws !== ws) return;
    L.ws = null; for (const id of [...L.peers.keys()]) dropPeer(id);
    if (L.want) { clearTimeout(L.retry); L.retry = setTimeout(localStart, 3000); }
    renderLocal();
  };
  ws.onopen = renderLocal;
}
function localStop() { L.want = false; clearTimeout(L.retry); for (const id of [...L.peers.keys()]) dropPeer(id); try { L.ws?.close(); } catch {} L.ws = null; renderLocal(); }
setInterval(() => { if (L.ws?.readyState === 1) L.ws.send('{"t":"ping"}'); }, 20000);
function dropPeer(id) { const p = L.peers.get(id); if (!p) return; L.peers.delete(id); try { p.pc.close(); } catch {} renderLocal(); }
// ---------- jakość dźwięku (kb/s, stereo) – ustawiana w panelu; zmiana działa od razu, bez ponownego łączenia ----------
let kbps = 160;
const KBPS = () => kbps;
async function setBitrate(v) {
  v = Number(v);
  if (!v || v === kbps) return;
  kbps = v;
  const bps = v * 1000;
  const senders = [S.pub?.track?.sender, ...[...L.peers.values()].map((p) => p.sender)].filter(Boolean);
  for (const sd of senders) {
    try { const ps = sd.getParameters(); if (ps.encodings?.length) { ps.encodings = ps.encodings.map((e) => ({ ...e, maxBitrate: bps })); await sd.setParameters(ps); } } catch {}
  }
  if (F.enc && F.cfg) { try { F.cfg = { ...F.cfg, bitrate: bps }; F.enc.configure(F.cfg); } catch {} }
  console.log('jakość dźwięku:', v, 'kb/s');
}
// Opus: stereo, bez DTX, ramki 10 ms (domyślnie 20 ms) – mniejsze opóźnienie w sieci lokalnej
function tuneOpus(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  sdp = sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_, p) => {
    const o = Object.fromEntries(p.split(';').filter(Boolean).map((kv) => kv.trim().split('=')));
    Object.assign(o, { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(KBPS() * 1000), usedtx: '0', useinbandfec: '1', minptime: '10' });
    return `a=fmtp:${pt} ` + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(';');
  });
  if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(a=rtpmap:\d+ opus\/48000[^\r\n]*\r\n)/i, '$1a=ptime:10\r\na=maxptime:10\r\n');
  return sdp;
}
const gathered = (pc) => new Promise((ok) => {
  if (pc.iceGatheringState === 'complete') return ok();
  const t = setTimeout(ok, 1500);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
});
async function onLocalMsg(m) {
  if (m.t === 'bitrate') { setBitrate(m.kbps); return; }
  if (m.t === 'plReq') {
    if (!S.want || L.peers.size >= MAX_PEERS) { L.ws.send(JSON.stringify({ t: 'plBye', to: m.id })); return; }
    dropPeer(m.id);
    const pc = new RTCPeerConnection({ iceServers: [] }); // tylko adresy w sieci lokalnej – bez serwerów pośredniczących
    const fast = !!m.fast && await fastReady(); // tor „ultra”: własny koder + kanał danych bez powtórzeń
    const peer = { pc, sender: null, dc: null, fast, name: m.name || '?', since: Date.now() };
    if (fast) {
      peer.dc = pc.createDataChannel('ik-audio', { ordered: false, maxRetransmits: 0, priority: 'high' });
      peer.dc.binaryType = 'arraybuffer';
      peer.dc.onopen = renderLocal; peer.dc.onclose = () => dropPeer(m.id);
    } else {
      const tr = pc.addTransceiver('audio', { direction: 'sendonly' });
      await tr.sender.replaceTrack(localOut());
      peer.sender = tr.sender;
      try { const ps = tr.sender.getParameters(); ps.encodings = [{ ...(ps.encodings?.[0] || {}), maxBitrate: KBPS() * 1000, priority: 'high', networkPriority: 'high' }]; await tr.sender.setParameters(ps); } catch {}
    }
    L.peers.set(m.id, peer);
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(m.id); renderLocal(); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp) });
    await gathered(pc);
    L.ws.send(JSON.stringify({ t: 'plOffer', to: m.id, sdp: pc.localDescription.sdp, fast }));
  } else if (m.t === 'plAnswer') {
    const p = L.peers.get(m.id);
    if (p && p.pc.signalingState === 'have-local-offer') await p.pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(m.sdp) });
  } else if (m.t === 'plBye') dropPeer(m.id);
}
// ---------- tor „ultra”: Opus (tryb niskiego opóźnienia, ramki 10 ms) przez kanał danych bez powtórzeń ----------
// Koder pracuje raz dla wszystkich słuchaczy; każdy telefon ma własny, krótki i regulowany bufor (AudioWorklet).
const ENC_WORKLET = `class IkTap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.L = new Float32Array(480); this.R = new Float32Array(480); }
  process(inp) {
    const i = inp[0]; if (!i || !i[0]) return true;
    const l = i[0], r = i[1] || i[0];
    for (let k = 0; k < l.length; k++) { this.L[this.n] = l[k]; this.R[this.n] = r[k]; if (++this.n === 480) { this.port.postMessage([this.L, this.R], [this.L.buffer, this.R.buffer]); this.L = new Float32Array(480); this.R = new Float32Array(480); this.n = 0; } }
    return true;
  }
}
registerProcessor('ik-tap', IkTap);`;
const F = { enc: null, tap: null, seq: 0, ts: 0, ready: null, cfg: null, sent: 0 };
async function fastReady() {
  if (F.ready) return F.ready;
  F.ready = (async () => {
    if (!('AudioEncoder' in window) || !S.actx?.audioWorklet || !ctxRunning()) return false;
    const base = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: KBPS() * 1000 };
    for (const opus of [{ frameDuration: 10000, application: 'lowdelay', complexity: 5, usedtx: false }, { frameDuration: 10000 }, undefined]) {
      const cfg = opus ? { ...base, opus } : base;
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) { F.cfg = cfg; break; } } catch {}
    }
    if (!F.cfg) return false;
    F.enc = new AudioEncoder({ output: fastSend, error: (e) => { console.warn('koder', e); F.ready = null; F.enc = null; } });
    F.enc.configure(F.cfg);
    await S.actx.audioWorklet.addModule(URL.createObjectURL(new Blob([ENC_WORKLET], { type: 'text/javascript' })));
    F.tap = new AudioWorkletNode(S.actx, 'ik-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const sink = S.actx.createGain(); sink.gain.value = 0; F.tap.connect(sink); sink.connect(S.actx.destination); // węzeł musi być podłączony, żeby pracował
    S.post.connect(F.tap); // to samo, co słyszą słuchacze przez serwer: po wyborze kanałów, poziomie i ograniczniku
    F.tap.port.onmessage = (e) => {
      if (!F.enc || F.enc.state !== 'configured' || ![...L.peers.values()].some((p) => p.fast && p.dc?.readyState === 'open')) return;
      const [l, r] = e.data, data = new Float32Array(960);
      if (!S.muted) { data.set(l, 0); data.set(r, 480); }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 480, numberOfChannels: 2, timestamp: F.ts, data });
      F.ts += 10000;
      try { F.enc.encode(ad); } finally { ad.close(); }
    };
    return true;
  })().catch((e) => { console.warn('tor ultra niedostępny', e); return false; });
  const ok = await F.ready;
  if (!ok) F.ready = null; // spróbuj ponownie przy następnym słuchaczu (np. po kliknięciu w stronę)
  return ok;
}
function fastSend(chunk) {
  const pkt = new Uint8Array(4 + chunk.byteLength);
  new DataView(pkt.buffer).setUint32(0, F.seq++ >>> 0);
  chunk.copyTo(pkt.subarray(4));
  for (const p of L.peers.values()) {
    // bez kolejkowania: jeśli łącze do telefonu się zatkało, pomijamy pakiet zamiast go opóźniać
    if (p.fast && p.dc?.readyState === 'open' && p.dc.bufferedAmount < 4000) { try { p.dc.send(pkt); } catch {} }
  }
  F.sent++;
}

function renderLocal() {
  const el = $('#localState');
  if (!el) return;
  const on = [...L.peers.values()].filter((p) => p.pc.connectionState === 'connected');
  el.textContent = !L.want ? 'wyłączony (nie nadajesz)' : L.ws?.readyState === 1 ? `działa · słucha lokalnie: ${on.length}${on.length ? ` (${on.map((p) => p.name + (p.fast ? ' ⚡' : '')).join(', ')})` : ''}` : 'łączenie z serwerem…';
  el.className = L.want && L.ws?.readyState === 1 ? 'ok-t' : '';
}
S.localCount = () => [...L.peers.values()].filter((p) => p.pc.connectionState === 'connected').length;

// ---------- start ----------
if (!KEY) { $('#noKey').hidden = false; }
else {
  $('#ui').hidden = false;
  render();
  await listDevices().catch(() => {});
  try { await openInput(); } catch { /* zgoda na mikrofon – po kliknięciu */ }
  meterLoop();
  if (store.get('auto', false)) { S.want = true; start(); }
}
