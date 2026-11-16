// Reżyseria – fałszywy ATEM do testów bez sprzętu: 6 kamer, 2 M/E, 25 kl./s, Cut/Mix/Dip/Wipe.
import { EventEmitter } from 'node:events';
import { realTimers } from './scheduler.js';
import { MAX_TRANSITION_FRAMES } from './settings.js';

export const SIM_INPUTS = [
  { id: 0, shortName: 'BLK', longName: 'Black', kind: 'other' },
  { id: 1, shortName: 'OGL', longName: 'Plan ogólny', kind: 'camera' },
  { id: 2, shortName: 'AMB', longName: 'Ambona', kind: 'camera' },
  { id: 3, shortName: 'ZESP', longName: 'Zespół', kind: 'camera' },
  { id: 4, shortName: 'SALA', longName: 'Sala', kind: 'camera' },
  { id: 5, shortName: 'BOK', longName: 'Kamera z boku', kind: 'camera' },
  { id: 6, shortName: 'CAM6', longName: 'Kamera 6', kind: 'camera' },
  { id: 1000, shortName: 'BARS', longName: 'Color Bars', kind: 'other' },
  { id: 3010, shortName: 'MP1', longName: 'Media Player 1', kind: 'other' },
];

export class SimMixer extends EventEmitter {
  constructor({ connectDelayMs = 300, timers = realTimers } = {}) {
    super();
    this.isSimulation = true;
    this.status = 'disconnected';
    this.connectDelayMs = connectDelayMs;
    this.timers = timers;
    this.connectTimer = null;
    this.fps = 25;
    this.mes = [0, 1].map(() => ({ program: 1, preview: 2, inTransition: false, timer: null }));
    this.history = []; // wszystkie polecenia – do testów
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
    this.emit('update');
  }

  async connect(address) {
    await this.disconnect();
    this.setStatus('connecting');
    this.connectTimer = this.timers.setTimeout(() => {
      this.emit('log', `Symulacja: połączono z „mikserem” ${address || ''}`.trim());
      this.setStatus('connected');
    }, this.connectDelayMs);
  }

  async disconnect() {
    if (this.connectTimer) this.timers.clearTimeout(this.connectTimer);
    for (const m of this.mes) { if (m.timer) this.timers.clearTimeout(m.timer); m.inTransition = false; }
    this.setStatus('disconnected');
  }

  snapshot(me) {
    const s = this.mes[me] ?? this.mes[0];
    const on = this.status === 'connected';
    return {
      status: this.status,
      model: on ? 'Symulator ATEM' : undefined,
      meCount: on ? this.mes.length : 1,
      inputs: on ? SIM_INPUTS.map((i) => ({ ...i })) : [],
      program: on ? s.program : undefined,
      preview: on ? s.preview : undefined,
      inTransition: on && s.inTransition,
      supportedTransitions: on ? ['cut', 'mix', 'dip', 'wipe'] : ['cut'],
      fps: this.fps,
    };
  }

  me(me) {
    if (this.status !== 'connected') throw new Error('Brak połączenia z mikserem');
    const s = this.mes[me];
    if (!s) throw new Error(`Brak M/E ${me + 1}`);
    return s;
  }

  async preview(me, input) {
    const s = this.me(me);
    this.history.push({ op: 'preview', me, input });
    s.preview = input;
    this.emit('update');
  }

  async take(me, kind, frames) {
    const s = this.me(me);
    if (s.inTransition) throw new Error('Przejście w toku');
    this.history.push({ op: 'take', me, kind, frames, input: s.preview });
    if (kind === 'cut') return this.swap(s);
    const rate = Math.max(1, Math.min(MAX_TRANSITION_FRAMES, Math.round(frames)));
    s.inTransition = true;
    this.emit('update');
    s.timer = this.timers.setTimeout(() => { s.timer = null; s.inTransition = false; this.swap(s); }, (rate / this.fps) * 1000);
  }

  async transition(me, input, kind, frames) {
    if (this.me(me).inTransition) throw new Error('Przejście w toku');
    await this.preview(me, input);
    await this.take(me, kind, frames);
  }

  swap(s) {
    const old = s.program;
    s.program = s.preview;
    s.preview = old;
    this.emit('update');
  }

  // --- sterowanie symulacją (panel) ---
  simulateManualProgram(me, input) {
    const s = this.mes[me];
    if (!s || this.status !== 'connected' || s.inTransition) return;
    this.emit('log', `Symulacja: operator przełączył ręcznie na wejście ${input}`);
    s.program = input;
    this.emit('update');
  }

  simulateDrop(ms = 5000) {
    if (this.status !== 'connected') return;
    this.emit('log', `Symulacja: zerwane połączenie na ${Math.round(ms / 1000)} s`);
    this.setStatus('reconnecting');
    this.connectTimer = this.timers.setTimeout(() => { this.emit('log', 'Symulacja: połączenie wróciło'); this.setStatus('connected'); }, ms);
  }
}
