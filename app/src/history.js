import fs from 'node:fs';
import path from 'node:path';

// Historia czatu: w pamięci (ostatnie N na kanał) + dziennik JSONL na dysku, dzień po dniu.
export class History {
  constructor(dir, perChannel = 300) {
    this.dir = path.join(dir, 'log');
    this.per = perChannel;
    this.byChannel = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(d = new Date()) {
    const s = d.toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Europe/Warsaw' });
    return path.join(this.dir, `${s}.jsonl`);
  }
  push(m) {
    const arr = this.byChannel.get(m.channel) || [];
    arr.push(m);
    if (arr.length > this.per) arr.splice(0, arr.length - this.per);
    this.byChannel.set(m.channel, arr);
  }
  add(m) {
    this.push(m);
    fs.appendFile(this.file(), JSON.stringify(m) + '\n', () => {});
  }
  get(id) {
    for (const arr of this.byChannel.values()) { const m = arr.find((x) => x.id === id); if (m) return m; }
    return null;
  }
  update(id, patch, log = true) {
    const m = this.get(id);
    if (!m) return null;
    Object.assign(m, patch);
    if (log) fs.appendFile(this.file(), JSON.stringify({ type: 'update', id, patch, ts: Date.now() }) + '\n', () => {});
    return m;
  }
  all() { return [...this.byChannel.values()].flat().sort((a, b) => a.ts - b.ts); }
  clear() {
    this.byChannel.clear();
    fs.appendFile(this.file(), JSON.stringify({ type: 'clear', ts: Date.now() }) + '\n', () => {});
  }
  // Okres przechowywania: usuwa z pamięci wpisy starsze niż `cutoff` (ms) i całe pliki dziennika z dni przed tą datą.
  prune(cutoff) {
    let removed = 0;
    for (const [ch, arr] of this.byChannel) {
      const keep = arr.filter((m) => !(m.ts < cutoff));
      removed += arr.length - keep.length;
      if (keep.length) this.byChannel.set(ch, keep); else this.byChannel.delete(ch);
    }
    const day = path.basename(this.file(new Date(cutoff)), '.jsonl');
    let files = 0;
    for (const f of this.logFiles()) if (path.basename(f, '.jsonl') < day) { try { fs.rmSync(f); files++; } catch {} }
    return { removed, files };
  }
  logFiles() {
    try { return fs.readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => path.join(this.dir, n)); } catch { return []; }
  }
  // Usunięcie danych osoby: wpisy spełniające `match` – w pamięci i we wszystkich plikach dziennika. Zwraca usunięte id.
  forget(match) {
    const ids = new Set();
    for (const [ch, arr] of this.byChannel) {
      const keep = arr.filter((m) => { if (match(m)) { ids.add(m.id); return false; } return true; });
      if (keep.length) this.byChannel.set(ch, keep); else this.byChannel.delete(ch);
    }
    for (const f of this.logFiles()) {
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      const out = [];
      let changed = false;
      for (const line of lines) {
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { out.push(line); continue; }
        if (m.type === 'update' ? ids.has(m.id) : m.type !== 'clear' && match(m)) { if (m.id) ids.add(m.id); changed = true; continue; }
        out.push(line);
      }
      // poprawki (np. transkrypcja) mogą stać przed odczytaniem pasującego wpisu w późniejszym pliku – druga runda niżej
      if (changed) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, out.map((x) => x + '\n').join(''), { mode: 0o600 }); fs.renameSync(tmp, f); }
    }
    for (const f of this.logFiles()) { // pozostałe poprawki usuniętych wpisów
      let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
      const out = lines.filter((line) => { try { const m = JSON.parse(line); return !(m.type === 'update' && ids.has(m.id)); } catch { return true; } });
      if (out.length !== lines.length) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, out.map((x) => x + '\n').join(''), { mode: 0o600 }); fs.renameSync(tmp, f); }
    }
    return [...ids];
  }
  restoreToday(validChannels) {
    const f = this.file();
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'clear') { this.byChannel.clear(); continue; }
        if (m.type === 'update') { this.update(m.id, m.patch, false); continue; }
        if (validChannels.has(m.channel)) this.push(m);
      } catch { /* pomiń uszkodzoną linię */ }
    }
  }
}
