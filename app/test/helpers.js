// Pomocnicze do testów: sterowany zegar i deterministyczny generator liczb losowych.

/** Zegar testowy – czas płynie tylko w advance(); po każdym zdarzeniu oddaje sterowanie obietnicom. */
export class FakeClock {
  constructor(start = 1_000_000) { this.t = start; this.timers = new Map(); this.seq = 0; }
  now = () => this.t;
  setTimeout = (fn, ms) => { const id = ++this.seq; this.timers.set(id, { at: this.t + Math.max(0, ms), fn, id }); return id; };
  clearTimeout = (id) => { this.timers.delete(id); };
  async flush() { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
  async advance(ms) {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      const due = [...this.timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id);
      this.t = due.at;
      due.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}

/** mulberry32 */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
