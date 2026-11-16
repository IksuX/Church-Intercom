// Reżyseria – moduł miksera wideo (Blackmagic ATEM) w serwerze interkomu.
// Połączenie z mikserem, autopilot, ręczne przełączanie i komendy głosowe działają tylko tutaj, na serwerze.
// Kto może z tego korzystać, decyduje server.js (rola „Reżyser”) – moduł zakłada, że wywołujący ma prawo.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AtemMixer, EMPTY_SNAPSHOT } from './atem.js';
import { SimMixer } from './sim.js';
import { Scheduler, realTimers } from './scheduler.js';
import { sanitizeSettings, TRANSITION_LABELS, MAX_TRANSITION_FRAMES } from './settings.js';
import { parseCommand, describe } from './voice.js';

const VOICE_DEFAULTS = { minConfidence: 0.6, programTake: 'cut', fadeFrames: 25 };

function sanitizeVoice(v) {
  const o = v && typeof v === 'object' ? v : {};
  const conf = Number(o.minConfidence);
  return {
    minConfidence: Number.isFinite(conf) ? Math.min(0.95, Math.max(0, Math.round(conf * 100) / 100)) : VOICE_DEFAULTS.minConfidence,
    programTake: o.programTake === 'mix' ? 'mix' : 'cut', // jakim przejściem „Wchodzisz N”
    fadeFrames: Math.min(MAX_TRANSITION_FRAMES, Math.max(1, Math.round(Number(o.fadeFrames) || VOICE_DEFAULTS.fadeFrames))),
  };
}
export const cleanPresetName = (n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ').slice(0, 60) : '') || undefined;

export class MixerModule extends EventEmitter {
  /**
   * @param {{ dataDir:string, mixerFactory?:(sim:boolean)=>any, timers?:typeof realTimers, logger?:(m:string)=>void }} opts
   */
  constructor({ dataDir, mixerFactory, timers = realTimers, logger = (m) => console.log(`[reżyseria] ${m}`) }) {
    super();
    this.file = path.join(dataDir, 'mixer.json');
    this.timers = timers;
    this.logger = logger;
    this.mixerFactory = mixerFactory || ((sim) => (sim ? new SimMixer({ timers }) : new AtemMixer()));
    this.cfg = { enabled: false, host: '', me: 0, simulation: false };
    this.mixer = null;
    this.logs = [];
    this.voiceLog = [];
    this.voiceOn = new Set(); // klucze osób, które mają włączone sterowanie głosem
    this.changeQueued = false;

    const saved = this.load();
    this.data = {
      settings: sanitizeSettings(saved.settings),
      presets: {},
      lastPreset: undefined,
      voice: sanitizeVoice(saved.voice),
      deckKey: typeof saved.deckKey === 'string' && /^[a-f0-9]{32}$/.test(saved.deckKey) ? saved.deckKey : '',
    };
    for (const [n, s] of Object.entries(saved.presets || {})) { const name = cleanPresetName(n); if (name) this.data.presets[name] = sanitizeSettings(s); }
    if (saved.lastPreset && this.data.presets[saved.lastPreset]) this.data.lastPreset = saved.lastPreset;

    this.scheduler = new Scheduler({
      timers,
      execute: (sw, frames) => this.requireMixer().transition(this.cfg.me, sw.input, sw.transition, frames),
      log: (m) => this.log(m),
      onChange: () => this.changed(),
    });
    this.scheduler.setSettings(this.data.settings);
  }

  // ---------- zapis ----------
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) { this.logger(`nie udało się zapisać ${this.file}: ${e.message}`); }
    }, 300);
    this.saveTimer.unref?.();
  }

  // ---------- połączenie ----------
  /** Konfiguracja z panelu administratora (config.mixer). Łączy / rozłącza tylko przy zmianie. */
  async applyConfig(cfg) {
    const next = { enabled: !!cfg?.enabled, host: cfg?.host || '', me: cfg?.me || 0, simulation: !!cfg?.simulation };
    const prev = this.cfg;
    this.cfg = next;
    const reconnect = next.enabled !== prev.enabled || next.host !== prev.host || next.simulation !== prev.simulation || (next.enabled && !this.mixer);
    if (reconnect) {
      await this.dropMixer();
      if (next.enabled) {
        const m = this.mixerFactory(next.simulation);
        this.mixer = m;
        m.on('update', () => this.onMixerUpdate());
        m.on('log', (msg) => this.log(msg));
        this.log(next.simulation ? 'Tryb symulacji – fałszywy mikser' : `Łączę z mikserem ${next.host}…`);
        try { await m.connect(next.host); } catch (e) { this.log(`Nie udało się rozpocząć połączenia: ${e.message}`); }
      } else if (prev.enabled) this.log('Mikser wyłączony w panelu');
    }
    this.onMixerUpdate();
  }

  async dropMixer() {
    const m = this.mixer;
    this.mixer = null;
    if (m) { m.removeAllListeners(); await m.disconnect().catch(() => {}); }
  }

  snapshot() { return this.mixer ? this.mixer.snapshot(this.cfg.me) : { ...EMPTY_SNAPSHOT }; }

  requireMixer() {
    if (!this.mixer) throw new Error('Mikser wideo nie jest włączony');
    return this.mixer;
  }

  onMixerUpdate() {
    const s = this.snapshot();
    this.scheduler.updateMixer({ connected: s.status === 'connected', program: s.program, inTransition: s.inTransition, supportedTransitions: s.supportedTransitions, fps: s.fps });
    this.changed();
  }

  // ---------- ręczne przełączanie ----------
  inputLabel(id, snap = this.snapshot()) {
    const i = snap.inputs.find((x) => x.id === id);
    return i ? `${i.longName || i.shortName} (${id})` : `wejście ${id}`;
  }

  /** Sprawdza, czy można teraz przełączać; zwraca obraz stanu albo rzuca błąd z komunikatem. */
  ready(input) {
    const snap = this.snapshot();
    if (snap.status !== 'connected') throw new Error('Brak połączenia z mikserem');
    if (snap.inTransition) throw new Error('Przejście w toku – spróbuj za chwilę');
    if (input !== undefined && !snap.inputs.some((i) => i.id === input)) throw new Error(`Nie ma kamery ${input} w mikserze`);
    return snap;
  }

  async setPreview(input, who) {
    const snap = this.ready(input);
    await this.requireMixer().preview(this.cfg.me, input);
    this.log(`${who}: Preview → ${this.inputLabel(input, snap)}`);
    return { ok: true };
  }

  /** Na Program: `input` (przez Preview) albo – bez numeru – kamera z Preview. kind: 'cut' | 'mix'. */
  async take(kind, input, who) {
    const snap = this.ready(input);
    if (kind !== 'cut' && !snap.supportedTransitions.includes(kind)) throw new Error(`Mikser nie obsługuje przejścia ${TRANSITION_LABELS[kind] || kind}`);
    const target = input ?? snap.preview;
    if (target === undefined) throw new Error('Brak kamery na Preview');
    if (target === snap.program) throw new Error(`${this.inputLabel(target, snap)} już jest na programie`);
    const frames = this.data.voice.fadeFrames;
    this.scheduler.noteExternalSwitch();
    if (input !== undefined) await this.requireMixer().transition(this.cfg.me, input, kind, frames);
    else await this.requireMixer().take(this.cfg.me, kind, frames);
    this.log(`${who}: ${kind === 'cut' ? 'Cut' : 'Fade'} → ${this.inputLabel(target, snap)}`);
    return { ok: true };
  }

  // ---------- komendy głosowe ----------
  setVoice(key, on) {
    if (on) this.voiceOn.add(key); else this.voiceOn.delete(key);
    this.changed();
  }
  voiceEnabledFor(key) { return this.voiceOn.has(key); }

  /**
   * Tekst z transkrypcji wypowiedzi Reżysera. Zwraca wpis dziennika albo null (zwykła rozmowa – nic nie robimy).
   * @param {{text:string, confidence?:number|null, who:string, sttMs?:number, startedAt?:number}} p
   */
  async voiceCommand({ text, confidence, who, sttMs, startedAt }) {
    const cmd = parseCommand(text);
    if (!cmd) return null;
    const entry = { t: this.timers.now(), who, heard: String(text).slice(0, 200), confidence: confidence ?? null, sttMs: sttMs ?? null, ok: false, result: '' };
    const min = this.data.voice.minConfidence;
    if (!cmd.ok) entry.result = cmd.error;
    else if (typeof confidence === 'number' && confidence < min) {
      entry.result = `Niska pewność rozpoznania (${Math.round(confidence * 100)}% < ${Math.round(min * 100)}%) – nic nie wykonano`;
    } else {
      try {
        const label = (id) => this.inputLabel(id);
        if (cmd.action === 'preview') await this.setPreview(cmd.input, `głos (${who})`);
        else if (cmd.action === 'program') await this.take(this.data.voice.programTake, cmd.input, `głos (${who})`);
        else await this.take(cmd.action === 'cut' ? 'cut' : 'mix', cmd.input, `głos (${who})`);
        entry.ok = true;
        entry.result = describe(cmd, label);
      } catch (e) {
        entry.result = `${e.message} – nic nie wykonano`;
      }
    }
    if (startedAt) entry.totalMs = this.timers.now() - startedAt;
    this.voiceLog.push(entry);
    if (this.voiceLog.length > 50) this.voiceLog.shift();
    this.logger(`głos ${who}: „${entry.heard}” → ${entry.result}${entry.totalMs ? ` (${entry.totalMs} ms)` : ''}`);
    this.changed();
    this.emit('voice', entry);
    return entry;
  }

  /** Komendy nie udało się rozpoznać (np. usługa STT nie działa) – też do dziennika, żeby Reżyser wiedział. */
  voiceFailed(who, result) {
    this.voiceLog.push({ t: this.timers.now(), who, heard: '', confidence: null, ok: false, result });
    if (this.voiceLog.length > 50) this.voiceLog.shift();
    this.logger(`głos ${who}: ${result}`);
    this.changed();
  }

  setVoiceOptions(v) {
    this.data.voice = sanitizeVoice({ ...this.data.voice, ...(v && typeof v === 'object' ? v : {}) });
    this.save();
    this.changed();
    return { ok: true };
  }

  // ---------- autopilot ----------
  start() {
    this.scheduler.start();
    return this.data.settings.cameras.length < 2 ? { ok: true, message: 'Autopilot uruchomiony, ale zaznacz co najmniej dwie kamery' } : { ok: true };
  }
  stop() { this.scheduler.stop(); return { ok: true }; }
  pause() { this.scheduler.pause(); return { ok: true }; }
  resume() { this.scheduler.resume(); return { ok: true }; }
  toggle() { this.scheduler.togglePause(); return { ok: true }; }
  next() { return this.scheduler.nextNow(); }

  setSettings(raw) {
    this.data.settings = sanitizeSettings(raw);
    this.scheduler.setSettings(this.data.settings);
    this.save();
    return { ok: true };
  }

  savePreset(raw) {
    const name = cleanPresetName(raw);
    if (!name) return { ok: false, message: 'Podaj nazwę presetu' };
    if (!this.data.presets[name] && Object.keys(this.data.presets).length >= 50) return { ok: false, message: 'Za dużo presetów (najwyżej 50)' };
    this.data.presets[name] = this.data.settings;
    this.data.lastPreset = name;
    this.save();
    this.log(`Zapisano preset „${name}”`);
    return { ok: true };
  }
  loadPreset(raw) {
    const name = cleanPresetName(raw);
    const p = name && this.data.presets[name];
    if (!p) return { ok: false, message: `Nie ma presetu „${raw}”` };
    this.data.settings = p;
    this.data.lastPreset = name;
    this.scheduler.setSettings(p);
    this.save();
    this.log(`Wczytano preset „${name}”`);
    return { ok: true };
  }
  deletePreset(raw) {
    const name = cleanPresetName(raw);
    if (!name || !this.data.presets[name]) return { ok: false, message: `Nie ma presetu „${raw}”` };
    delete this.data.presets[name];
    if (this.data.lastPreset === name) this.data.lastPreset = undefined;
    this.save();
    this.log(`Usunięto preset „${name}”`);
    return { ok: true };
  }

  // ---------- Stream Deck ----------
  newDeckKey() {
    this.data.deckKey = crypto.randomBytes(16).toString('hex');
    this.save();
    return this.data.deckKey;
  }
  clearDeckKey() { this.data.deckKey = ''; this.save(); }
  deckKeyOk(k) {
    const key = this.data.deckKey;
    return !!key && typeof k === 'string' && k.length === key.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(key));
  }

  // ---------- symulacja ----------
  simProgram(input) {
    if (!(this.mixer instanceof SimMixer)) return { ok: false, message: 'Dostępne tylko w trybie symulacji' };
    this.mixer.simulateManualProgram(this.cfg.me, Number(input));
    return { ok: true };
  }
  simDrop(seconds = 5) {
    if (!(this.mixer instanceof SimMixer)) return { ok: false, message: 'Dostępne tylko w trybie symulacji' };
    this.mixer.simulateDrop(Math.min(60, Math.max(1, Number(seconds) || 5)) * 1000);
    return { ok: true };
  }

  // ---------- stan ----------
  /** Stan dla Reżysera. `key` – klucz osoby (włącznik głosu jest osobisty). */
  state(key) {
    const s = this.snapshot();
    return {
      enabled: this.cfg.enabled,
      simulation: this.cfg.simulation,
      host: this.cfg.host,
      status: s.status,
      model: s.model,
      me: this.cfg.me,
      meCount: s.meCount,
      inputs: s.inputs,
      program: s.program,
      preview: s.preview,
      inTransition: s.inTransition,
      supportedTransitions: s.supportedTransitions,
      fps: s.fps,
      settings: this.data.settings,
      presets: Object.keys(this.data.presets).sort((a, b) => a.localeCompare(b, 'pl')),
      lastPreset: this.data.lastPreset,
      voice: { ...this.data.voice, on: key ? this.voiceOn.has(key) : false },
      voiceLog: this.voiceLog.slice(-20),
      autopilot: this.scheduler.status(),
      logs: this.logs.slice(-30),
      serverTime: this.timers.now(),
    };
  }

  /** Stan dla panelu administratora. */
  adminInfo() {
    const s = this.snapshot();
    return { ...this.cfg, status: s.status, model: s.model || null, meCount: s.meCount, inputs: s.inputs.length, deckKey: this.data.deckKey ? '••••' + this.data.deckKey.slice(-4) : '' };
  }

  log(msg) {
    this.logs.push({ t: this.timers.now(), msg });
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.logger(msg);
    this.changed();
  }

  changed() {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setImmediate(() => { this.changeQueued = false; this.emit('change'); });
  }

  async shutdown() {
    this.scheduler.dispose();
    await this.dropMixer();
  }
}
