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
