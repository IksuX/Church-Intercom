// Powiadomienia push (Web Push) – działają przy zablokowanym ekranie.
// iPhone: od iOS 16.4, tylko gdy interkom jest dodany do ekranu początkowego. Serwer potrzebuje internetu.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export class Push {
  constructor(dir) {
    this.file = path.join(dir, 'push.json');
    this.keysFile = path.join(dir, 'vapid.json');
    let keys;
    try { keys = JSON.parse(fs.readFileSync(this.keysFile, 'utf8')); } catch {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(this.keysFile, JSON.stringify(keys), { mode: 0o600 });
    }
    this.vapid = keys;
    this.publicKey = keys.publicKey;
    // Apple (iPhone) odrzuca podpis z adresem typu mailto:…@localhost (403 BadJwtToken) – potrzebny prawdziwy adres serwera.
    // Kolejność: VAPID_SUBJECT z .env → zapamiętany adres serwera → (tymczasowo) bezpieczny zastępczy.
    this.subject = process.env.VAPID_SUBJECT || keys.subject || null;
    this.applySubject();
    this.lastResult = new Map(); // klucz osoby -> ostatni wynik wysyłki (diagnostyka w aplikacji)
    try { this.subs = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.subs = {}; } // klucz osoby -> [subskrypcje]
    // co kto chce dostawać przy zablokowanym telefonie (+ kanały, których słucha – znane też po rozłączeniu)
    this.prefsFile = path.join(dir, 'push-prefs.json');
    try { this.prefs = JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')); } catch { this.prefs = {}; }
    this.last = new Map(); // ograniczenie częstotliwości: klucz|tag -> czas
    // Stare zapisy (sprzed 0.25) nie mają daty – traktujemy je jak nieaktywne, aż osoba znów otworzy aplikację.
    for (const k of Object.keys(this.subs)) this.subs[k] = (this.subs[k] || []).map((x) => ({ ...x, exp: x.exp || 0, seen: x.seen || 0 }));
    this.prune();
  }
  // Powiadomienia dostaje tylko ktoś, kto jest teraz „w akcji”: ma ważną sesję (nie wylogował się, logowanie
  // nie wygasło) i był w aplikacji w ciągu ostatnich godzin. Udział w jednym nabożeństwie nie oznacza
  // powiadomień na zawsze – przy kolejnym wystarczy otworzyć aplikację.
  static ACTIVE_MS = (Number(process.env.IK_PUSH_ACTIVE_H) || 6) * 3600 * 1000;
  isActive(x, now = Date.now()) { return x.exp > now && now - x.seen < Push.ACTIVE_MS; }
  active(key) { const now = Date.now(); return (this.subs[key] || []).filter((x) => this.isActive(x, now)); }
  // osoba jest w aplikacji (połączenie, ping, powrót z tła) – przedłuż ważność jej urządzeń
  touch(key, exp) {
    const list = this.subs[key];
    if (!list?.length) return;
    const now = Date.now();
    for (const x of list) { x.seen = now; if (exp) x.exp = Math.max(x.exp || 0, exp); }
    this.saveSoon();
  }
  // wylogowanie: to urządzenie przestaje dostawać powiadomienia tej osoby
  logout(key, endpoint) {
    if (!this.subs[key]) return;
    if (endpoint) this.subs[key] = this.subs[key].filter((x) => x.endpoint !== endpoint);
    else this.subs[key] = [];
    if (!this.subs[key].length) delete this.subs[key];
    this.save();
  }
  // porządki: zapisy wygasłe ponad tydzień temu usuwamy całkiem
  prune() {
    const old = Date.now() - 7 * 24 * 3600 * 1000;
    let changed = false;
    for (const k of Object.keys(this.subs)) {
      const keep = (this.subs[k] || []).filter((x) => Math.max(x.exp || 0, x.seen || 0) > old);
      if (keep.length !== (this.subs[k] || []).length) changed = true;
      if (keep.length) this.subs[k] = keep; else delete this.subs[k];
    }
    if (changed) this.save();
  }
  saveSoon() { if (this.saveT) return; this.saveT = setTimeout(() => { this.saveT = null; this.save(); }, 30000); }
  applySubject() {
    webpush.setVapidDetails(this.subject || 'https://interkom.invalid', this.vapid.publicKey, this.vapid.privateKey);
  }
  // adres serwera poznany z zapytania telefonu (https://adres-interkomu) – zapamiętany na stałe
  learnHost(host) {
    if (process.env.VAPID_SUBJECT || !host || /^(localhost|127\.|\[::1\])/.test(host)) return;
    const subj = 'https://' + host.replace(/[^a-zA-Z0-9.:\-[\]]/g, '');
    if (subj === this.subject) return;
    this.subject = subj; this.vapid.subject = subj;
    try { fs.writeFileSync(this.keysFile, JSON.stringify(this.vapid), { mode: 0o600 }); } catch {}
    this.applySubject();
    console.log(`[push] adres nadawcy powiadomień: ${subj}`);
  }
  static DEFAULTS = { dm: true, mentions: true, channels: true, plan: false, stream: false, timer: false, listen: [] };
  pref(key) { return { ...Push.DEFAULTS, ...(this.prefs[key] || {}) }; }
  setPrefs(key, p) {
    const b = (v, d) => (typeof v === 'boolean' ? v : d);
    const cur = this.pref(key);
    this.prefs[key] = {
      dm: b(p?.dm, cur.dm), mentions: b(p?.mentions, cur.mentions), channels: b(p?.channels, cur.channels), plan: b(p?.plan, cur.plan),
      stream: b(p?.stream, cur.stream), timer: b(p?.timer, cur.timer),
      listen: Array.isArray(p?.listen) ? p.listen.map(String).slice(0, 60) : cur.listen,
    };
    fs.writeFile(this.prefsFile, JSON.stringify(this.prefs), () => {});
  }
  keys() { return Object.keys(this.subs).filter((k) => this.active(k).length); }
  // ten sam rodzaj powiadomienia najwyżej co kilka sekund (np. szybka wymiana wiadomości na kanale)
  throttled(key, tag, ms = 4000) {
    const k = key + '|' + tag, now = Date.now();
    if (now - (this.last.get(k) || 0) < ms) return true;
    this.last.set(k, now);
    return false;
  }
  save() { fs.writeFile(this.file, JSON.stringify(this.subs), () => {}); }
  add(key, sub, exp) {
    if (!sub?.endpoint) return;
    // ten sam telefon mógł wcześniej należeć do innej osoby (wylogowanie i logowanie kogoś innego) – tylko bieżąca
    for (const k of Object.keys(this.subs)) if (k !== key) {
      const rest = this.subs[k].filter((s) => s.endpoint !== sub.endpoint);
      if (rest.length !== this.subs[k].length) { if (rest.length) this.subs[k] = rest; else delete this.subs[k]; }
    }
    const list = (this.subs[key] || []).filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: sub.keys, exp: exp || Date.now() + 24 * 3600 * 1000, seen: Date.now() });
    this.subs[key] = list.slice(-5); // maks. 5 urządzeń na osobę
    this.save();
  }
  remove(key, endpoint) {
    if (!this.subs[key]) return;
    this.subs[key] = this.subs[key].filter((s) => s.endpoint !== endpoint);
    this.save();
  }
  has(key) { return this.active(key).length > 0; }
  async send(key, payload) {
    const list = this.active(key);
    const results = await Promise.all(list.map(async (sub) => {
      const apple = /push\.apple\.com/.test(sub.endpoint);
      const where = apple ? 'Apple' : /googleapis|fcm/.test(sub.endpoint) ? 'Google' : /mozilla/.test(sub.endpoint) ? 'Mozilla' : 'serwer push';
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), {
          TTL: payload.urgent ? 300 : 120, urgency: 'high',
          ...(apple ? {} : { topic: String(payload.tag || '').replace(/[^\w-]/g, '').slice(0, 32) || undefined }),
        });
        return { ok: true, where };
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { this.remove(key, sub.endpoint); return { ok: false, where, error: 'subskrypcja wygasła – włącz powiadomienia ponownie' }; }
        let reason = ''; try { reason = JSON.parse(e.body || '{}').reason || ''; } catch { reason = String(e.body || '').slice(0, 80); }
        console.warn(`[push] ${where}: ${e.statusCode || ''} ${reason || e.message}`);
        return { ok: false, where, error: `${where} odrzucił powiadomienie: ${[e.statusCode, reason || e.message].filter(Boolean).join(' ')}` };
      }
    }));
    this.lastResult.set(key, { at: Date.now(), results });
    return results;
  }
}
