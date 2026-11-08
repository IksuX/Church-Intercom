// Interkom – nadajnik dźwięku transmisji działający na serwerze.
// Wejście audio serwera (line-in płyty głównej, Qu-SB przez USB, interfejs USB) → wybór kanałów, poziom, ogranicznik
// → Opus → (1) telefony w sieci lokalnej: tryb ultra (kanał danych WebRTC bez powtórzeń), (2) LiveKit: pozostali.
// Sterowanie wyłącznie z panelu administratora; tu nie ma żadnego interfejsu ani przeglądarki.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import ndc from 'node-datachannel';
import { Room, RoomEvent, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const require = createRequire(import.meta.url);
const OpusScript = require('opusscript');

const CONFIG_PATH = process.env.CONFIG_PATH || '/config/config.json';
const SECRETS_PATH = path.join(path.dirname(CONFIG_PATH), 'secrets.json');
const APP = (process.env.IK_APP || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const LK_INTERNAL = process.env.LIVEKIT_INTERNAL_WS || 'ws://127.0.0.1:7880';
// ik-publish (Go): wysyła do LiveKit gotowe pakiety Opus jako ścieżkę stereo; bez niego – zapasowo przez rtc-node (mono)
const PUBLISHER = process.env.IK_PUBLISH || '/usr/local/bin/ik-publish';
const HAVE_PUBLISHER = fs.existsSync(PUBLISHER);
const SR = 48000, FRAME = 480; // 10 ms
const log = (...a) => console.log('[audio]', ...a);

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const DEF = { on: false, device: 'test', l: 0, r: 1, mono: false, gain: 0, limiter: true, muted: false };
const S = {
  key: null, active: false, set: { ...DEF }, name: 'Dźwięk transmisji',
  devices: [], cap: null, capCh: 2, capDev: null, error: '', peak: [0, 0], meterPeak: [0, 0],
  seq: 0, enc: null, kbps: 160, env: 1, lk: null, lkSource: null, lkBusy: false, ws: null, peers: new Map(), stats: { frames: 0 },
};

// ---------- konfiguracja (plik z panelu) ----------
function loadConfig() {
  const c = readJson(CONFIG_PATH, {});
  const p = c.program || {};
  S.key = readJson(SECRETS_PATH, {}).programKey || null;
  S.name = p.name || 'Dźwięk transmisji';
  setBitrate(p.bitrate);
  const want = !!(p.enabled && p.source === 'server' && S.key);
  applySettings({ ...DEF, ...(p.server || {}) }, true);
  if (want !== S.active) { S.active = want; log(want ? 'aktywny – źródłem jest wejście serwera' : 'nieaktywny (źródło: przeglądarka albo wyłączone)'); }
  sync();
}
let cfgStamp = '';
setInterval(() => {
  try { const st = fs.statSync(CONFIG_PATH), st2 = fs.existsSync(SECRETS_PATH) ? fs.statSync(SECRETS_PATH).mtimeMs : 0; const k = `${st.mtimeMs}|${st2}`; if (k !== cfgStamp) { cfgStamp = k; loadConfig(); } } catch {}
}, 1000);

function applySettings(x, fromFile) {
  const prev = S.set;
  const n = {
    on: !!x.on, device: String(x.device || 'test').slice(0, 120),
    l: Math.max(0, Math.min(63, Number(x.l) || 0)), r: Math.max(0, Math.min(63, Number(x.r ?? 1) || 0)),
    mono: !!x.mono, gain: Math.max(-24, Math.min(24, Number(x.gain) || 0)), limiter: x.limiter !== false, muted: !!x.muted,
  };
  S.set = n;
  if (!fromFile) log('ustawienia z panelu', JSON.stringify(n));
  if (prev.device !== n.device || prev.on !== n.on) restartCapture();
}

// ---------- lista wejść (ALSA) ----------
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 4000 }, (e, out, err) => ok(String(out || '') + String(err || ''))));
async function scanDevices() {
  const out = await run('arecord', ['-l']);
  const list = [{ id: 'test', name: 'Sygnał testowy (440 Hz lewy / 660 Hz prawy)', maxCh: 2 }];
  for (const m of out.matchAll(/card (\d+): (\S+) \[([^\]]*)\], device (\d+): [^[]*\[([^\]]*)\]/g)) {
    const [, , card, cardName, dev, devName] = m;
    const hw = `hw:CARD=${card},DEV=${dev}`;
    // ile kanałów ma wejście (np. Qu-SB przez USB: 18+) – bez ograniczenia przeglądarki do 2
    const p = await run('arecord', ['-D', hw, '--dump-hw-params', '-d', '1', '-f', 'S16_LE', '-r', '48000', '-t', 'raw', '/dev/null']);
    const ch = /CHANNELS:\s*(?:\[(\d+)\s+(\d+)\]|(\d+))/.exec(p);
    const maxCh = ch ? Number(ch[2] || ch[3]) : 2;
    list.push({ id: hw, name: `${cardName} – ${devName}`, maxCh: Math.max(1, Math.min(64, maxCh)) });
  }
  S.devices = list;
  return list;
}

// ---------- przechwytywanie ----------
let pending = Buffer.alloc(0);
function restartCapture() {
  stopCapture();
  if (!S.active || !S.set.on) return;
  const dev = S.set.device || 'test';
  S.capDev = dev; S.error = '';
  if (dev === 'test') { startTestTone(); return; }
  const info = S.devices.find((d) => d.id === dev);
  const ch = Math.max(2, Math.min(info?.maxCh || 2, 64));
  S.capCh = ch;
  // „plughw” przelicza częstotliwość/format, gdy karta nie ma 48 kHz; krótki bufor = małe opóźnienie
  const args = ['-D', dev.replace(/^hw:/, 'plughw:'), '-t', 'raw', '-f', 'S16_LE', '-r', String(SR), '-c', String(ch), '--period-time=5000', '--buffer-time=20000', '-q'];
  log('wejście:', dev, `${ch} kan.`);
  const p = spawn('arecord', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  S.cap = p; pending = Buffer.alloc(0);
  p.stdout.on('data', (b) => onPcm(b));
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code) => {
    if (S.cap !== p) return;
    S.cap = null;
    S.error = `wejście audio przestało działać${err ? ': ' + err.trim().split('\n').pop().slice(0, 100) : ''}`;
    log(S.error, code);
    setTimeout(() => { if (!S.cap && S.active && S.set.on) restartCapture(); }, 3000);
  });
}
function stopCapture() {
  if (S.cap?.kill) { const p = S.cap; S.cap = null; try { p.kill(); } catch {} }
  if (S.tone) { clearInterval(S.tone); S.tone = null; }
  S.cap = null;
}
function startTestTone() {
  S.capCh = 2;
  let t0 = process.hrtime.bigint(), sent = 0, ph = [0, 0];
  S.cap = { test: true };
  S.tone = setInterval(() => {
    const due = Math.floor(Number(process.hrtime.bigint() - t0) / 1e9 * SR / FRAME);
    while (sent < due) {
      const b = Buffer.alloc(FRAME * 4);
      for (let i = 0; i < FRAME; i++) {
        ph[0] += 2 * Math.PI * 440 / SR; ph[1] += 2 * Math.PI * 660 / SR;
        b.writeInt16LE(Math.round(Math.sin(ph[0]) * 9000), i * 4); b.writeInt16LE(Math.round(Math.sin(ph[1]) * 4000), i * 4 + 2);
      }
      onPcm(b); sent++;
    }
  }, 5);
}

// ---------- obróbka 10 ms: kanały, poziom, ogranicznik ----------
const out16 = new Int16Array(FRAME * 2);
function onPcm(b) {
  pending = pending.length ? Buffer.concat([pending, b]) : b;
  const bytes = FRAME * S.capCh * 2;
  while (pending.length >= bytes) {
    const blk = pending.subarray(0, bytes); pending = pending.subarray(bytes);
    processBlock(blk);
  }
}
function processBlock(blk) {
  const n = S.capCh, s = S.set, g = Math.pow(10, s.gain / 20), thr = 0.89; // ok. −1 dBFS
  const l = Math.min(s.l, n - 1), r = Math.min(s.r, n - 1);
  let pk0 = 0, pk1 = 0;
  for (let i = 0; i < FRAME; i++) {
    const base = i * n * 2;
    let a = blk.readInt16LE(base + l * 2) / 32768, c = blk.readInt16LE(base + r * 2) / 32768;
    if (s.mono || n === 1) { const m = l === r ? a : (a + c) * 0.5; a = m; c = m; }
    a *= g; c *= g;
    if (s.limiter) { // ogranicznik szczytowy: natychmiastowy atak, powrót ok. 80 ms
      const pk = Math.max(Math.abs(a), Math.abs(c)) * S.env;
      if (pk > thr) S.env *= thr / pk; else S.env += (1 - S.env) * 0.0003;
      a *= S.env; c *= S.env;
    }
    a = Math.max(-1, Math.min(1, a)); c = Math.max(-1, Math.min(1, c));
    if (s.muted) { a = 0; c = 0; }
    const aa = Math.abs(a), cc = Math.abs(c); if (aa > pk0) pk0 = aa; if (cc > pk1) pk1 = cc;
    out16[i * 2] = Math.round(a * 32767); out16[i * 2 + 1] = Math.round(c * 32767);
  }
  S.meterPeak = [Math.max(S.meterPeak[0], pk0), Math.max(S.meterPeak[1], pk1)];
  S.stats.frames++;
  const needOpus = S.pub?.live || [...S.peers.values()].some((p) => p.open);
  const opus = needOpus ? encodeFrame() : null;
  sendLocal(opus);
  sendLiveKit(opus);
}

// ---------- tor „ultra”: Opus low-delay → kanał danych do telefonów w sieci lokalnej ----------
// jeden koder Opus (stereo, ramki 10 ms) dla obu torów: ultra i LiveKit (przez ik-publish) – bez kodowania dwa razy
function encoder() {
  if (!S.enc) { S.enc = new OpusScript(SR, 2, OpusScript.Application.RESTRICTED_LOWDELAY); S.enc.setBitrate(S.kbps * 1000); }
  return S.enc;
}
function setBitrate(v) {
  const k = [96, 128, 160, 192, 256, 320].includes(Number(v)) ? Number(v) : 160;
  if (k === S.kbps) return;
  S.kbps = k;
  try { S.enc?.setBitrate(k * 1000); } catch { S.enc = null; }
  log('jakość dźwięku:', k, 'kb/s stereo');
}
function encodeFrame() {
  try { return Buffer.from(encoder().encode(Buffer.from(out16.buffer, out16.byteOffset, out16.byteLength), FRAME)); }
  catch (e) { log('koder', e.message); return null; }
}
function sendLocal(opus) {
  const open = [...S.peers.values()].filter((p) => p.open);
  if (!open.length || !opus) return;
  const pkt = Buffer.alloc(4 + opus.length); pkt.writeUInt32BE(S.seq++ >>> 0, 0); opus.copy(pkt, 4);
  for (const p of open) {
    try { if (p.dc.bufferedAmount() < 4000) p.dc.sendMessageBinary(pkt); } catch {} // zatkane łącze – pomijamy pakiet zamiast go opóźniać
  }
}

// ---------- LiveKit: dla telefonów poza siecią lokalną i jako zapas ----------
async function lkConnect() {
  if (S.lk || S.pub || S.lkBusy || !S.active || !S.set.on) return;
  S.lkBusy = true;
  try {
    const r = await fetch(APP + '/api/program/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: S.key, server: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (j.bitrate) setBitrate(j.bitrate);
    const lkUrl = j.livekit.url && !/^wss?:\/\/(127\.|localhost)/.test(j.livekit.url) ? j.livekit.url : LK_INTERNAL;
    if (HAVE_PUBLISHER) { await pubStart(lkUrl, j.livekit.token); return; }
    const room = new Room();
    room.on(RoomEvent.Disconnected, () => { if (S.lk === room) { S.lk = null; S.lkSource = null; log('LiveKit rozłączony'); } });
    await room.connect(lkUrl, j.livekit.token, { autoSubscribe: false, dynacast: false });
    const src = new AudioSource(SR, 2, 60);
    const track = LocalAudioTrack.createAudioTrack('program', src);
    await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: false, audioEncoding: { maxBitrate: BigInt(S.kbps * 1000) } }));
    S.lk = room; S.lkSource = src;
    log('LiveKit: nadaje (zapasowo przez rtc-node – mono)');
  } catch (e) {
    if (S.pub && !S.pub.live) { try { S.pub.p.kill(); } catch {} S.pub = null; }
    S.error = 'serwer głosu: ' + e.message; log(S.error);
  }
  finally { S.lkBusy = false; }
}
// ik-publish: osobny program, dostaje pakiety Opus na wejściu ([2 bajty długości][pakiet]) i nadaje je jako ścieżkę stereo
function pubStart(url, token) {
  return new Promise((ok, fail) => {
    const p = spawn(PUBLISHER, [url, token], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pub = { p, live: false };
    S.pub = pub;
    let buf = '', settled = false;
    const done = (e) => { if (settled) return; settled = true; e ? fail(e) : ok(); };
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('OK')) { pub.live = true; S.error = ''; log('LiveKit: nadaje stereo,', S.kbps, 'kb/s'); done(); }
        else if (line.startsWith('ERR')) { log('ik-publish:', line.slice(4)); if (!pub.live) done(new Error(line.slice(4))); }
        else if (line) log('ik-publish:', line);
      }
    });
    p.stderr.on('data', (d) => { if (process.env.IK_DEBUG) log('ik-publish (log):', String(d).trim().slice(0, 300)); });
    p.stdin.on('error', () => {});
    p.on('error', (e) => done(e));
    p.on('exit', (code) => {
      if (S.pub === pub) { S.pub = null; if (pub.live) log('LiveKit rozłączony (ik-publish zakończył się, kod', code + ')'); }
      done(new Error('ik-publish zakończył się (kod ' + code + ')'));
    });
    setTimeout(() => done(new Error('LiveKit nie odpowiada')), 15000);
  });
}
async function lkDisconnect() {
  const pub = S.pub; S.pub = null;
  if (pub) { try { pub.p.stdin.end(); } catch {} setTimeout(() => { try { pub.p.kill(); } catch {} }, 1000); }
  const r = S.lk; S.lk = null; S.lkSource = null; try { await r?.disconnect(); } catch {}
}
function sendLiveKit(opus) {
  const pub = S.pub;
  if (pub) {
    if (!pub.live || !opus || pub.p.stdin.writableLength > 16384) return; // zatkane – pomiń pakiet zamiast opóźniać
    const h = Buffer.alloc(2); h.writeUInt16BE(opus.length, 0);
    pub.p.stdin.write(Buffer.concat([h, opus]));
    return;
  }
  const src = S.lkSource;
  if (!src) return;
  const f = new AudioFrame(Int16Array.from(out16), SR, 2, FRAME);
  src.captureFrame(f).catch(() => {});
}

// ---------- połączenie z aplikacją: zestawianie połączeń lokalnych + polecenia z panelu ----------
function wsConnect() {
  if (S.ws || !S.active || !S.set.on) return;
  const ws = new WebSocket(APP.replace(/^http/, 'ws') + '/ws?program=' + encodeURIComponent(S.key));
  S.ws = ws;
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m).catch((err) => log('wiadomość', err.message)); };
  ws.onclose = () => { if (S.ws === ws) { S.ws = null; for (const id of [...S.peers.keys()]) dropPeer(id); } };
  ws.onerror = () => {};
}
const wsSend = (o) => { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(o)); };
async function onMsg(m) {
  if (m.t === 'bitrate') { setBitrate(m.kbps); return; }
  if (m.t === 'set' && m.server) { applySettings({ ...S.set, ...m.server }); sync(); }
  else if (m.t === 'cmd' && m.cmd) applyCmd(m.cmd);
  else if (m.t === 'scan') { await scanDevices(); beat(); }
  else if (m.t === 'plReq') {
    if (process.env.IK_DEBUG) log('plReq', m.id, 'fast', m.fast);
    if (!m.fast || S.peers.size >= 60) { wsSend({ t: 'plBye', to: m.id }); return; } // bez trybu ultra – telefon słucha przez LiveKit
    dropPeer(m.id);
    const pc = new ndc.PeerConnection('ik-' + m.id, { iceServers: [] });
    const peer = { pc, dc: null, open: false, name: m.name || '?' };
    S.peers.set(m.id, peer);
    pc.onStateChange((st) => { if (st === 'failed' || st === 'closed') dropPeer(m.id); });
    let sent = false;
    const offer = () => { if (sent) return; const d = pc.localDescription(); if (!d?.sdp) return; sent = true; wsSend({ t: 'plOffer', to: m.id, sdp: d.sdp, fast: true }); };
    pc.onGatheringStateChange((st) => { if (st === 'complete') offer(); });
    peer.dc = pc.createDataChannel('ik-audio', { unordered: true, maxRetransmits: 0 });
    peer.dc.onOpen(() => { peer.open = true; log('lokalnie słucha:', peer.name); });
    peer.dc.onClosed(() => dropPeer(m.id));
    setTimeout(offer, 1500); // gdy zbieranie adresów trwa długo – wyślij to, co jest
  } else if (m.t === 'plAnswer') {
    const p = S.peers.get(m.id);
    if (p && typeof m.sdp === 'string') { try { p.pc.setRemoteDescription(m.sdp, 'answer'); } catch (e) { log('odpowiedź', e.message); } }
  } else if (m.t === 'plBye') dropPeer(m.id);
}
function dropPeer(id) { const p = S.peers.get(id); if (!p) return; S.peers.delete(id); try { p.dc?.close(); } catch {} try { p.pc.close(); } catch {} }
let cmdSeq = 0;
function applyCmd(c) {
  if (!c || c.seq <= cmdSeq) return;
  cmdSeq = c.seq;
  const n = { ...S.set };
  if (typeof c.gain === 'number') n.gain = c.gain;
  if (typeof c.muted === 'boolean') n.muted = c.muted;
  applySettings(n);
}

// ---------- stan dla panelu ----------
async function beat() {
  if (!S.key) return;
  const pk = S.meterPeak; S.meterPeak = [0, 0];
  const s = S.set, dev = S.devices.find((d) => d.id === s.device);
  const local = [...S.peers.values()].filter((p) => p.open).length;
  try {
    const r = await fetch(APP + '/api/program/beat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      key: S.key, server: true, on: !!(S.active && s.on && S.cap && (S.lk || S.pub?.live || local)), muted: s.muted, device: s.device === 'test' ? 'Sygnał testowy' : dev?.name || s.device,
      peak: pk, error: S.active && s.on ? S.error : '', gain: s.gain, limiter: s.limiter, nch: S.capCh,
      route: S.capCh < 2 ? 'mono' : s.mono ? `mono z kanałów ${s.l + 1}+${s.r + 1}` : `kanały ${s.l + 1}/${s.r + 1}`,
      raw: false, direct: false, local, cmdSeq,
      lat: { cap: s.device === 'test' ? 0 : 10, proc: 1, enc: 3, up: 0, total: (s.device === 'test' ? 0 : 10) + 14, tcp: false, relay: false }, // wejście ALSA (bufor 5–20 ms) + ramka 10 ms + Opus 2,5 ms
      devices: S.devices.map((d) => ({ id: d.id, name: d.name, maxCh: d.maxCh })),
    }) });
    const j = await r.json().catch(() => ({}));
    if (j.cmd) applyCmd(j.cmd);
  } catch { /* aplikacja się uruchamia */ }
}
setInterval(beat, 500);

// ---------- uruchamianie / zatrzymywanie wszystkiego według ustawień ----------
function sync() {
  if (S.active && S.set.on) {
    if (!S.cap) restartCapture();
    wsConnect(); lkConnect();
  } else {
    stopCapture(); lkDisconnect();
    if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
    for (const id of [...S.peers.keys()]) dropPeer(id);
  }
}
setInterval(sync, 3000); // ponowne próby po utracie połączenia

process.on('uncaughtException', (e) => log('błąd (działa dalej):', e.message));
process.on('unhandledRejection', (e) => log('błąd (działa dalej):', e?.message || e));
process.on('SIGTERM', async () => { stopCapture(); await lkDisconnect(); ndc.cleanup?.(); process.exit(0); });

await scanDevices().catch(() => {});
setInterval(() => scanDevices().catch(() => {}), 30000);
loadConfig();
log(`gotowy · aplikacja ${APP} · wejść: ${S.devices.length - 1}`);
