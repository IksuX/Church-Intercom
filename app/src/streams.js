// Interkom – monitorowanie transmisji live (Blackmagic Web Presenter → YouTube / Facebook)
// Tryb „direct”: serwer łączy się z urządzeniami w sieci lokalnej.
// Tryb „bridge”: stan przysyła mostek (webpresenter.mjs) uruchomiony w sieci kościoła – gdy serwer jest w chmurze.
import { WebPresenter, fmtDuration } from './webpresenter.mjs';
import { PLATFORM_NAMES } from './platforms.js';

const OFFLINE_GRACE_MS = 15000; // chwilowa utrata połączenia z urządzeniem nie jest jeszcze alarmem
const CONNECTING_WARN_MS = 25000; // tyle „Connecting” = nie może dotrzeć do serwera platformy
const BRIDGE_DEAD_MS = 25000;

export class StreamMonitor {
  /** notify({ kind: 'start'|'stop'|'signal'|'problem'|'ok', device, text }) ; onChange(list) */
  constructor({ notify, onChange, platforms }) {
    this.notify = notify; this.onChange = onChange; this.platforms = platforms; this.pollAt = {};
    this.cfg = { enabled: false, mode: 'direct', devices: [] };
    this.devs = new Map(); // id -> { cfg, wp?, st, ev }
    this.bridgeSeen = 0;
    this.tick = setInterval(() => { this.check(); this.pollPlatforms(); }, 2000);
  }

  configure(cfg) {
    const prevMode = this.cfg.mode;
    this.cfg = cfg;
    const want = new Map(cfg.enabled ? cfg.devices.map((d) => [d.id, d]) : []);
    for (const [id, x] of this.devs) {
      const w = want.get(id);
      if (!w || w.host !== x.cfg.host || w.port !== x.cfg.port || cfg.mode !== prevMode) { x.wp?.stop(); this.devs.delete(id); }
      else { if (w.platform !== x.cfg.platform) x.plat = { live: null }; x.cfg = w; } // np. zmiana nazwy / platformy
    }
    for (const [id, d] of want) {
      if (this.devs.has(id)) continue;
      const x = { cfg: d, st: { online: false, status: null }, ev: { phase: 'unknown' }, plat: { live: null } };
      if (cfg.mode === 'direct') {
        x.wp = new WebPresenter(d).start();
        x.wp.on('state', (s) => this.update(id, s));
      }
      this.devs.set(id, x);
    }
    this.onChange(this.list());
  }

  // stan od mostka
  bridgeReport(devices) {
    this.bridgeSeen = Date.now();
    for (const d of Array.isArray(devices) ? devices : []) if (this.devs.has(d?.id)) this.update(d.id, d);
  }
  bridgeDevices() { return this.cfg.enabled && this.cfg.mode === 'bridge' ? this.cfg.devices.map(({ id, name, host, port }) => ({ id, name, host, port })) : []; }

  update(id, s) {
    const x = this.devs.get(id);
    if (!x) return;
    const st = {
      online: !!s.online, status: s.status ? String(s.status).slice(0, 20) : null,
      cache: Math.max(0, Math.min(100, Number(s.cache) || 0)), bitrate: Number(s.bitrate) || 0,
      duration: String(s.duration || '').slice(0, 20), model: String(s.model || '').slice(0, 60), error: String(s.error || '').slice(0, 80),
    };
    const changed = st.online !== x.st.online || st.status !== x.st.status || Math.abs(st.cache - (x.st.cache || 0)) >= 5;
    if (st.online && st.status) { x.lastDuration = st.duration || x.lastDuration; }
    x.st = st;
    this.evaluate(x);
    if (changed) this.onChange(this.list());
  }

  // Zdarzenia z Web Presentera (sygnał i jakość łącza). „Na żywo publicznie” rozstrzyga platforma – patrz evaluatePlatform.
  evaluate(x) {
    const ev = x.ev, st = x.st, name = x.cfg.name, now = Date.now();
    const say = (kind, text) => this.notify({ kind, device: name, text });
    const live = st.status === 'Streaming', interrupted = st.status === 'Interrupted';
    const plat = this.platformOf(x), pname = PLATFORM_NAMES[x.cfg.platform] || 'platformy';
    const gen = { YouTube: 'YouTube', Facebook: 'Facebooka' }[pname] || pname, loc = { YouTube: 'YouTube', Facebook: 'Facebooku' }[pname] || pname;

    if (!st.online) {
      if (ev.phase === 'live' || ev.phase === 'interrupted') {
        ev.offlineSince ||= now;
        if (!ev.offlineWarned && now - ev.offlineSince > OFFLINE_GRACE_MS) {
          ev.offlineWarned = true;
          say('problem', `⚠️ ${name}: ${st.error === 'brak kontaktu z mostkiem' ? 'brak kontaktu z mostkiem w sieci kościoła' : 'brak kontaktu z Web Presenterem'} – nie wiem, czy sygnał dociera`);
        }
      }
      return;
    }
    ev.offlineSince = 0;
    if (ev.offlineWarned) {
      ev.offlineWarned = false;
      say(live ? 'ok' : 'problem', live ? `✅ ${name}: kontakt z Web Presenterem przywrócony, sygnał dociera` : `⚠️ ${name}: kontakt przywrócony, ale Web Presenter nie nadaje (${st.status || 'brak stanu'})`);
      if (!live && !interrupted) { ev.phase = 'idle'; return; }
    }

    if (ev.phase === 'unknown') { // pierwszy odczyt po starcie serwera – bez ogłoszeń
      if (!st.status) return;
      ev.phase = live ? 'live' : interrupted ? 'interrupted' : 'idle';
      return;
    }

    if (live) {
      if (ev.phase === 'idle' || ev.phase === 'connecting') {
        ev.signalSince = now;
        if (plat && x.plat.live) { /* transmisja już publiczna – nic nowego */ }
        else if (plat) say('signal', `📡 ${name}: sygnał dociera do ${gen} (podgląd) – transmisja czeka na uruchomienie`);
        else say('signal', `📡 ${name}: Web Presenter zaczął nadawać – pamiętaj o uruchomieniu transmisji na platformie`);
        this.wake(x.cfg.platform);
      } else if (ev.phase === 'interrupted') say('ok', `✅ ${name}: sygnał wznowiony`);
      ev.phase = 'live'; ev.connectingSince = 0;
      // słabe łącze: zapełnia się bufor urządzenia
      const warnAt = this.cfg.cacheWarn || 50;
      if (st.cache >= warnAt && !ev.cacheWarned) { ev.cacheWarned = true; say('problem', `⚠️ ${name}: słabe łącze – bufor zapełniony w ${st.cache}%`); }
      else if (st.cache < Math.min(20, warnAt / 2) && ev.cacheWarned) { ev.cacheWarned = false; say('ok', `✅ ${name}: łącze znów nadąża`); }
    } else if (interrupted) {
      if (ev.phase !== 'interrupted') say('problem', `⚠️ ${name}: sygnał przerwany – Web Presenter próbuje połączyć się ponownie`);
      ev.phase = 'interrupted';
    } else if (st.status === 'Connecting') {
      if (ev.phase === 'live' || ev.phase === 'interrupted') { ev.phase = 'interrupted'; return; }
      if (ev.phase !== 'connecting') { ev.phase = 'connecting'; ev.connectingSince = now; ev.connWarned = false; }
      if (!ev.connWarned && now - ev.connectingSince > CONNECTING_WARN_MS) { ev.connWarned = true; say('problem', `⚠️ ${name}: Web Presenter nie może połączyć się z serwerem ${gen} (sprawdź klucz i internet)`); }
    } else if (st.status === 'Idle') {
      if (ev.phase === 'live' || ev.phase === 'interrupted') {
        ev.endedAt = now;
        if (plat && x.plat.live) say('problem', `⚠️ ${name}: Web Presenter przestał nadawać, a transmisja na ${loc} nadal trwa!`);
        else if (plat) say('signal', `📡 ${name}: Web Presenter przestał nadawać`);
        else { const d = fmtDuration(x.lastDuration); say('signal', `📡 ${name}: Web Presenter zakończył nadawanie${d ? ` (czas ${d})` : ''}`); }
        this.wake(x.cfg.platform);
      }
      ev.phase = 'idle'; ev.cacheWarned = false; x.lastDuration = '';
    }
  }

  // ---- platformy: czy transmisja jest PUBLICZNIE na żywo ----
  platformOf(x) { return !!(this.platforms && x.cfg.platform && this.platforms.configured(x.cfg.platform)); }
  wake(p) { if (p && this.pollAt) this.pollAt[p] = 0; }

  async pollPlatforms() {
    if (!this.platforms || !this.cfg.enabled || this.polling) return;
    this.polling = true;
    try {
      for (const p of ['youtube', 'facebook']) {
        const devs = [...this.devs.values()].filter((x) => x.cfg.platform === p);
        if (!devs.length || !this.platforms.configured(p)) continue;
        const now = Date.now();
        // często, gdy coś się dzieje (sygnał, transmisja, chwila po końcu); rzadko w spoczynku – oszczędza limit API
        const busy = devs.some((x) => ['live', 'interrupted', 'connecting'].includes(x.ev.phase) || x.plat.live || now - (x.ev.endedAt || 0) < 180000);
        const every = busy ? Number(process.env.IK_TEST_PLATFORM_POLL_MS) || 15000 : 300000;
        if (now < (this.pollAt[p] || 0)) continue;
        this.pollAt[p] = now + every;
        const r = await this.platforms.check(p);
        for (const x of devs) this.evaluatePlatform(x, r);
        this.onChange(this.list());
      }
    } finally { this.polling = false; }
  }

  evaluatePlatform(x, r) {
    const name = x.cfg.name, pl = x.plat, now = Date.now();
    const say = (kind, text) => this.notify({ kind, device: name, text });
    if (r.error) {
      // błąd sprawdzania – ostrzeż raz, ale tylko gdy faktycznie nadajemy
      if (!pl.errWarned && x.ev.phase === 'live') { pl.errWarned = true; say('problem', `⚠️ ${name}: nie mogę sprawdzić, czy transmisja jest publiczna – ${r.error}`); }
      return;
    }
    pl.errWarned = false;
    if (pl.live === null) { pl.live = r.live; if (r.live) pl.since = now; return; } // pierwszy odczyt – bez ogłoszeń
    if (r.live && !pl.live) {
      pl.since = now;
      say('start', `🔴 Transmisja na żywo: ${name} – wystartowała${r.title ? ` („${r.title}”)` : ''}`);
    } else if (!r.live && pl.live) {
      const min = pl.since ? Math.round((now - pl.since) / 60000) : 0;
      say('stop', `⏹ ${name}: transmisja zakończona${min ? ` (czas ${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')})` : ''}`);
      pl.since = 0;
    }
    pl.live = r.live; pl.url = r.url || ''; pl.title = r.title || '';
  }

  check() {
    if (!this.cfg.enabled) return;
    if (this.cfg.mode === 'bridge' && this.bridgeSeen && Date.now() - this.bridgeSeen > BRIDGE_DEAD_MS) {
      for (const x of this.devs.values()) if (x.st.online) { x.st = { ...x.st, online: false, error: 'brak kontaktu z mostkiem' }; this.onChange(this.list()); }
    }
    for (const x of this.devs.values()) this.evaluate(x);
  }

  list() {
    return [...this.devs.values()].map((x) => ({
      id: x.cfg.id, name: x.cfg.name, online: x.st.online, status: x.st.status, cache: x.st.cache || 0,
      duration: fmtDuration(x.st.duration), error: x.st.online ? '' : x.st.error || '', model: x.st.model || '',
      platform: x.cfg.platform || '', platformOn: this.platformOf(x), live: this.platformOf(x) ? !!x.plat.live : null, url: x.plat.url || '',
    }));
  }

  status() {
    return { enabled: this.cfg.enabled, mode: this.cfg.mode, bridgeSeen: this.bridgeSeen || null, devices: this.list() };
  }
}
