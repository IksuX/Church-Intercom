#!/usr/bin/env node
// Interkom – obsługa Blackmagic Web Presenter HD / 4K (Blackmagic Streaming Ethernet Protocol, TCP 9977)
//
// Ten plik działa na dwa sposoby:
//  1) moduł serwera Interkomu (serwer w sieci kościoła łączy się z urządzeniami bezpośrednio),
//  2) samodzielny „mostek” – gdy serwer stoi w chmurze (VPS). Uruchom na dowolnym komputerze w sieci kościoła:
//       node interkom-bridge.mjs --server https://twoj-serwer --token TOKEN
//     Mostek pobiera listę urządzeń z serwera i co kilka sekund wysyła ich stan (połączenie wychodzące HTTPS,
//     nic nie trzeba otwierać na routerze). Wymaga Node.js 18+ i nie ma żadnych zależności.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const POLL_MS = 5000; // Duration / Bitrate / Cache Used urządzenie podaje tylko na zapytanie
const DEAD_MS = 20000; // brak odpowiedzi tak długo = zerwane połączenie

export class WebPresenter extends EventEmitter {
  constructor({ host, port = 9977, name = '' }) {
    super();
    this.host = host; this.port = Number(port) || 9977; this.name = name;
    this.state = { online: false, status: null, model: '', label: '', platform: '', bitrate: 0, duration: '', cache: 0, error: '' };
    this.sock = null; this.buf = ''; this.stopped = false; this.retry = 2000; this.lastData = 0;
  }

  start() { this.stopped = false; this.connect(); return this; }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryT); clearInterval(this.pollT);
    this.sock?.destroy(); this.sock = null;
  }

  connect() {
    if (this.stopped) return;
    const s = net.createConnection({ host: this.host, port: this.port });
    this.sock = s; this.buf = '';
    s.setEncoding('utf8');
    s.setKeepAlive(true, 10000);
    s.setTimeout(8000, () => s.destroy(new Error('brak odpowiedzi urządzenia')));
    s.on('connect', () => {
      s.setTimeout(0);
      this.retry = 2000; this.lastData = Date.now();
      this.set({ online: true, error: '' });
      clearInterval(this.pollT);
      this.pollT = setInterval(() => {
        if (Date.now() - this.lastData > DEAD_MS) return s.destroy(new Error('urządzenie przestało odpowiadać'));
        s.write('STREAM STATE:\n\n');
      }, POLL_MS);
    });
    s.on('data', (d) => { this.lastData = Date.now(); this.buf += d; this.drain(); });
    s.on('error', (e) => { this.lastError = e.code === 'ECONNREFUSED' ? 'odmowa połączenia' : e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT' ? 'urządzenie nieosiągalne' : e.message; });
    s.on('close', () => {
      clearInterval(this.pollT);
      if (this.sock !== s) return;
      this.sock = null;
      this.set({ online: false, error: this.lastError || 'rozłączono' });
      if (!this.stopped) {
        this.retryT = setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 10000);
      }
    });
  }

  // Bloki tekstowe: „NAZWA BLOKU:\nKlucz: Wartość\n...\n\n”
  drain() {
    this.buf = this.buf.replace(/\r/g, '');
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
      const lines = block.split('\n').filter(Boolean);
      if (!lines.length) continue;
      const head = lines[0].replace(/:$/, '').trim().toUpperCase();
      const kv = {};
      for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) kv[l.slice(0, k).trim()] = l.slice(k + 1).trim(); }
      this.block(head, kv);
    }
    if (this.buf.length > 65536) this.buf = '';
  }

  block(head, kv) {
    if (head === 'STREAM STATE') {
      const p = {};
      if (kv.Status) p.status = kv.Status;
      if (kv.Bitrate !== undefined) p.bitrate = Number(kv.Bitrate) || 0;
      if (kv.Duration !== undefined) p.duration = kv.Duration;
      if (kv['Cache Used'] !== undefined) p.cache = Number(String(kv['Cache Used']).replace('%', '')) || 0;
      this.set(p);
    } else if (head === 'IDENTITY') {
      this.set({ model: kv['Model Name'] || this.state.model, label: kv.Label || this.state.label });
    } else if (head === 'STREAM SETTINGS') {
      if (kv['Current Platform'] !== undefined) this.set({ platform: kv['Current Platform'] });
    }
  }

  set(patch) {
    const before = JSON.stringify(this.state);
    Object.assign(this.state, patch);
    if (JSON.stringify(this.state) !== before) this.emit('state', { ...this.state });
  }
}

// „00:01:02:03” (DD:HH:MM:SS) → „1:02:03”
export function fmtDuration(d) {
  const p = String(d || '').split(':').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return '';
  const h = p[0] * 24 + p[1];
  return h ? `${h}:${String(p[2]).padStart(2, '0')}:${String(p[3]).padStart(2, '0')}` : `${p[2]}:${String(p[3]).padStart(2, '0')}`;
}

// ================= ProPresenter 7 (API sieciowe, od wersji 7.9) =================
// Ustawia wskazany zegar (timer) ProPresenter na czas pozostały do końca bieżącego punktu planu i pilnuje zgodności.
// Cel (target) liczony jest z Planning Center Live przez serwer Interkomu: { key, remaining, endRemaining, at }.
const PP_FIX_S = 2.5; // większa różnica = korekta zegara

export function parsePPTime(t) {
  const m = /^\s*(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(String(t || ''));
  if (!m) return null;
  const v = (Number(m[2] || 0) * 3600) + Number(m[3]) * 60 + Number(m[4]) + (m[5] ? Number('0.' + m[5]) : 0);
  return m[1] ? -v : v;
}

export class ProPresenterSync {
  constructor() {
    this.cfg = null; this.target = null; this.ids = {}; this.applied = {}; this.lastFix = {};
    this.status = { online: false, error: '', version: '', timers: {}, lastSync: 0 };
    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
  }
  stop() { clearInterval(this.timer); }
  configure(cfg) {
    const same = this.cfg && cfg && cfg.host === this.cfg.host && cfg.port === this.cfg.port && cfg.timer === this.cfg.timer && cfg.endTimer === this.cfg.endTimer;
    this.cfg = cfg?.enabled && cfg.host && cfg.port ? cfg : null;
    if (!same) { this.ids = {}; this.applied = {}; }
  }
  setTarget(t) { this.target = t ? { ...t, at: t.at || Date.now() } : null; }
  force() { this.applied = {}; this.lastFix = {}; return this.tick(); }
  async req(path, method = 'GET', body) {
    const r = await fetch(`http://${this.cfg.host}:${this.cfg.port}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) { const e = new Error(`ProPresenter ${r.status} ${path}`); e.status = r.status; throw e; }
    const txt = await r.text();
    try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
  }
  // zegar o danej nazwie – znajdź albo utwórz
  async timerId(name) {
    if (this.ids[name]) return this.ids[name];
    const list = await this.req('/v1/timers');
    let t = (Array.isArray(list) ? list : []).find((x) => String(x.id?.name || '').toLowerCase() === name.toLowerCase());
    if (!t) t = await this.req('/v1/timers', 'POST', { name, allows_overrun: true, countdown: { duration: 60 } });
    this.ids[name] = t?.id?.uuid || name;
    return this.ids[name];
  }
  async setCountdown(name, seconds) {
    const id = await this.timerId(name);
    const dur = Math.max(0, Math.round(seconds));
    await this.req(`/v1/timer/${encodeURIComponent(id)}`, 'PUT', { id: { name }, allows_overrun: true, countdown: { duration: dur } });
    await this.req(`/v1/timer/${encodeURIComponent(id)}/reset`);
    await new Promise((r) => setTimeout(r, 300)); // ProPresenter potrafi cofnąć zmianę, gdy start przyjdzie zbyt szybko
    await this.req(`/v1/timer/${encodeURIComponent(id)}/start`);
    this.status.lastSync = Date.now();
  }
  async tick() {
    if (!this.cfg) { this.status.online = false; return; }
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.status.version) { try { const v = await this.req('/version'); this.status.version = v?.name ? `${v.name} ${v.host_description || ''}`.trim() : 'ProPresenter'; } catch { /* starsze wersje */ } }
      const t = this.target;
      const now = Date.now();
      const want = {}; // nazwa zegara -> oczekiwany czas (s) albo null (zatrzymaj)
      want[this.cfg.timer] = t ? t.remaining - (now - t.at) / 1000 : null;
      if (this.cfg.endTimer) want[this.cfg.endTimer] = t && t.endRemaining != null ? t.endRemaining - (now - t.at) / 1000 : null;
      const current = await this.req('/v1/timers/current'); // brak odpowiedzi = ProPresenter niedostępny
      for (const [name, exp] of Object.entries(want)) {
        const id = await this.timerId(name);
        const cur = (Array.isArray(current) ? current : []).find((x) => x.id?.uuid === id || String(x.id?.name || '').toLowerCase() === name.toLowerCase());
        const shown = parsePPTime(cur?.time);
        const key = (t?.key || 'none') + (name === this.cfg.endTimer ? '|end' : '');
        this.status.timers[name] = { shown: cur?.time || '', state: cur?.state || '', expected: exp };
        if (exp === null) {
          if (this.applied[name] !== 'stopped') { await this.req(`/v1/timer/${encodeURIComponent(id)}/stop`).catch(() => {}); this.applied[name] = 'stopped'; }
          continue;
        }
        const drift = shown === null ? null : shown - exp;
        const needs = this.applied[name] !== key // nowy punkt
          || (cur && cur.state !== 'running' && cur.state !== 'overrun' && cur.state !== 'overrunning') // ktoś zatrzymał zegar
          || (drift !== null && Math.abs(drift) > PP_FIX_S && exp > 0 && now - (this.lastFix[name] || 0) > 10000); // rozjazd
        if (needs) { await this.setCountdown(name, exp); this.applied[name] = key; this.lastFix[name] = now; }
      }
      this.status.online = true; this.status.error = '';
    } catch (e) {
      this.status.online = false;
      this.status.error = e.cause?.code === 'ECONNREFUSED' ? 'ProPresenter nie odpowiada (sprawdź „Włącz sieć” i port)' : e.name === 'TimeoutError' ? 'brak odpowiedzi ProPresenter' : e.message;
      this.ids = {};
    } finally { this.busy = false; }
  }
}

// ================= MOSTEK (uruchomienie bezpośrednie) =================
async function bridgeMain() {
  const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : process.env['INTERKOM_' + n.toUpperCase()]; };
  const server = String(arg('server') || '').replace(/\/+$/, ''), token = arg('token');
  if (!server || !token) {
    console.error('Użycie: node interkom-bridge.mjs --server https://adres-interkomu --token TOKEN_Z_PANELU');
    process.exit(2);
  }
  const auth = { authorization: 'Bearer ' + token };
  const devs = new Map(); // id -> { cfg, wp }
  let dirty = true;
  const pp = new ProPresenterSync();

  async function loadConfig() {
    try {
      const r = await fetch(server + '/api/bridge/config', { headers: auth, signal: AbortSignal.timeout(10000) });
      if (r.status === 401) { console.error('[mostek] zły token – wygeneruj nowy w panelu (Transmisja)'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { devices = [], propresenter = null } = await r.json();
      if (JSON.stringify(propresenter) !== JSON.stringify(pp.cfg)) {
        pp.configure(propresenter);
        if (propresenter) console.log(`[mostek] ProPresenter: ${propresenter.host}:${propresenter.port}, zegar „${propresenter.timer}”`);
      }
      const want = new Map(devices.map((d) => [d.id, d]));
      for (const [id, x] of devs) {
        const w = want.get(id);
        if (!w || w.host !== x.cfg.host || Number(w.port) !== Number(x.cfg.port)) { x.wp.stop(); devs.delete(id); dirty = true; }
      }
      for (const [id, d] of want) {
        if (devs.has(id)) continue;
        const wp = new WebPresenter(d).start();
        let last = '';
        wp.on('state', (s) => {
          dirty = true;
          const line = s.online ? s.status || 'połączono' : 'brak połączenia – ' + s.error;
          if (line !== last) { last = line; console.log(`[mostek] ${d.name}: ${line}`); }
        });
        devs.set(id, { cfg: d, wp });
        console.log(`[mostek] obserwuję ${d.name} (${d.host}:${d.port || 9977})`);
      }
    } catch (e) { console.error('[mostek] nie mogę pobrać konfiguracji z serwera:', e.cause?.code || e.message); }
  }

  let lastSent = 0;
  async function report() {
    if (!dirty && Date.now() - lastSent < 5000) return;
    try {
      const body = { devices: [...devs].map(([id, x]) => ({ id, ...x.wp.state })), pp: pp.cfg ? pp.status : null };
      const r = await fetch(server + '/api/bridge/report', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (r.ok) { dirty = false; lastSent = Date.now(); }
    } catch (e) { console.error('[mostek] nie mogę wysłać stanu:', e.cause?.code || e.message); }
  }

  // cel zegara ProPresenter (czas punktu z Planning Center) – pobierany co 2 s
  async function ppTarget() {
    if (!pp.cfg) return;
    try {
      const r = await fetch(server + '/api/bridge/pp', { headers: auth, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); pp.setTarget(j.target ? { ...j.target, at: Date.now() } : null); if (j.force) pp.force(); dirty = true; }
    } catch { /* spróbujemy za chwilę */ }
  }

  console.log(`[mostek] Interkom: ${server}`);
  await loadConfig();
  setInterval(loadConfig, 30000);
  setInterval(ppTarget, 2000);
  setInterval(report, 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) bridgeMain();
