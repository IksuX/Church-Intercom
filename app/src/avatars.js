// Zdjęcia profilowe z Planning Center – bufor na dysku, żeby działały też bez internetu.
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE = 24 * 3600e3;
export class Avatars {
  constructor(dir) {
    this.dir = path.join(dir, 'avatars');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    try { this.urls = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.urls = {}; }
    this.inflight = new Map();
  }
  // Planning Center podaje obrazek zastępczy dla osób bez zdjęcia – takie pomijamy (klient pokaże inicjały).
  static usable(url) { return typeof url === 'string' && (process.env.AVATAR_ALLOW_HTTP ? /^https?:\/\// : /^https:\/\//).test(url) && !/no_photo|default|avatar-placeholder/i.test(url); }
  remember(pid, url) {
    if (!pid || !Avatars.usable(url) || this.urls[pid] === url) return;
    this.urls[pid] = url;
    fs.writeFile(this.indexFile, JSON.stringify(this.urls), () => {});
  }
  has(pid) { return !!this.urls[pid] || fs.existsSync(this.file(pid)); }
  file(pid) { return path.join(this.dir, `${String(pid).replace(/[^\w-]/g, '')}.img`); }
  // Zwraca { data, type } albo null
  async get(pid) {
    const f = this.file(pid);
    let st = null;
    try { st = fs.statSync(f); } catch { /* brak w buforze */ }
    const url = this.urls[pid];
    if (st && (Date.now() - st.mtimeMs < MAX_AGE || !url)) return this.read(f);
    if (!url) return null;
    if (!this.inflight.has(pid)) {
      this.inflight.set(pid, (async () => {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const type = r.headers.get('content-type') || '';
          if (!r.ok || !type.startsWith('image/')) throw new Error(`HTTP ${r.status}`);
          const data = Buffer.from(await r.arrayBuffer());
          if (data.length > 2e6) throw new Error('za duże');
          fs.writeFileSync(f, data); fs.writeFileSync(f + '.type', type);
        } catch { /* brak internetu – zostaje stara kopia, jeśli jest */ }
        finally { this.inflight.delete(pid); }
      })());
    }
    await this.inflight.get(pid);
    return fs.existsSync(f) ? this.read(f) : null;
  }
  read(f) {
    let type = 'image/jpeg';
    try { type = fs.readFileSync(f + '.type', 'utf8'); } catch { /* domyślnie jpeg */ }
    return { data: fs.readFileSync(f), type };
  }
}
