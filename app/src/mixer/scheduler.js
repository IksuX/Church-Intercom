// Reżyseria – harmonogram autopilota. Czysta logika, bez wiedzy o protokole ATEM.
//
// Zasady:
// - odliczanie liczy się od chwili wyzwolenia przejścia,
// - przejście nie jest wyzwalane, gdy inne jest w toku (ponowna próba po BUSY_RETRY_MS),
// - zmiana Program, której nie wywołał autopilot, to ręczna ingerencja: czas od nowa, bez powrotu do „swojej” kamery,
// - bez połączenia nic się nie odlicza; po powrocie zaczyna się nowy odcinek – zaległe zmiany nie są wysyłane.
import { pickDurationMs, pickNextCamera, pickTransition, transitionFrames } from './pick.js';
import { DEFAULT_SETTINGS } from './settings.js';

export const BUSY_RETRY_MS = 250;
export const ERROR_RETRY_MS = 3000;
const EXPECT_GRACE_MS = 5000;

export const realTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

const sameList = (a, b) => a.length === b.length && a.every((k, i) => b[i] === k);

export class Scheduler {
  /**
   * @param {{ execute:(sw:{input:number,transition:string}, frames:number)=>Promise<void>,
   *           log?:(m:string)=>void, onChange?:()=>void, rng?:()=>number, timers?:typeof realTimers }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.rng = deps.rng || Math.random;
    this.timers = deps.timers || realTimers;
    this.settings = DEFAULT_SETTINGS;
    this.runState = 'stopped';
    this.mixer = { connected: false, program: undefined, inTransition: false, supportedTransitions: ['cut'], fps: 25 };
    this.timer = null;
    this.deadline = undefined;
    this.intervalMs = undefined;
    this.remaining = undefined;
    this.next = undefined;
    this.last = undefined;
    this.expect = undefined;
    this.executing = false;
    this.everConnected = false;
  }

  now() { return this.timers.now(); }

  // ---------- wejścia ----------

  setSettings(settings) {
    const timingChanged = JSON.stringify(settings.timing) !== JSON.stringify(this.settings.timing);
    this.settings = settings;
    if (timingChanged && this.runState === 'running' && this.mixer.connected && !this.executing) this.beginInterval(this.mixer.program);
    else if (!this.executing) this.next = this.plan(this.mixer.program);
    this.changed();
  }

  /** Wywoływane przy każdej zmianie stanu miksera. */
  updateMixer(view) {
    const prev = this.mixer;
    this.mixer = { ...view, supportedTransitions: [...view.supportedTransitions] };

    if (prev.connected && !view.connected) {
      this.clearTimer();
      this.deadline = undefined;
      this.expect = undefined;
      if (this.runState !== 'stopped') this.log('Brak połączenia z mikserem – autopilot czeka');
      this.changed();
      return;
    }
    if (!view.connected) return;

    if (!prev.connected || prev.program === undefined) {
      if (view.program !== undefined) {
        const wasEver = this.everConnected;
        this.everConnected = true;
        if (this.runState === 'running') {
          if (wasEver) this.log('Połączenie wróciło – autopilot liczy czas od nowa');
          this.beginInterval(view.program);
        } else {
          this.next = this.plan(view.program);
        }
        this.changed();
      }
      return;
    }

    if (view.program !== prev.program) this.onProgramChanged(view.program);
    else if (!sameList(prev.supportedTransitions, view.supportedTransitions) && !this.executing) {
      this.next = this.plan(view.program);
      this.changed();
    } else if (prev.inTransition !== view.inTransition) this.changed();
  }

  /** Zmianę Program zleca ktoś inny niż autopilot (ręcznie z Reżyserii albo głosem) – jak operator na mikserze. */
  noteExternalSwitch() {
    this.expect = undefined;
  }

  // ---------- sterowanie ----------

  start() {
    if (this.runState === 'running') return;
    if (this.runState === 'paused') return this.resume();
    this.runState = 'running';
    this.log('Autopilot uruchomiony');
    if (this.mixer.connected && this.mixer.program !== undefined) this.beginInterval(this.mixer.program);
    this.changed();
  }

  stop() {
    if (this.runState === 'stopped') return;
    this.runState = 'stopped';
    this.clearTimer();
    this.deadline = this.remaining = this.intervalMs = undefined;
    this.log('Autopilot zatrzymany');
    this.changed();
  }

  pause() {
    if (this.runState !== 'running') return;
    this.runState = 'paused';
    this.remaining = this.deadline !== undefined ? Math.max(0, this.deadline - this.now()) : undefined;
    this.deadline = undefined;
    this.clearTimer();
    this.log('Autopilot wstrzymany (pauza)');
    this.changed();
  }

  resume() {
    if (this.runState !== 'paused') return;
    this.runState = 'running';
    this.log('Autopilot wznowiony');
    if (this.mixer.connected && this.mixer.program !== undefined) {
      const ms = this.remaining ?? pickDurationMs(this.settings, this.mixer.program, this.rng);
      this.remaining = undefined;
      if (!this.next) this.next = this.plan(this.mixer.program);
      this.deadline = this.now() + ms;
      this.intervalMs ??= ms;
      this.arm(ms);
    }
    this.changed();
  }

  togglePause() {
    if (this.runState === 'running') this.pause();
    else if (this.runState === 'paused') this.resume();
    else this.start();
  }

  /** „Następna teraz”. Działa też przy pauzie i zatrzymanym autopilocie (jednorazowo). */
  async nextNow() {
    if (!this.mixer.connected) return { ok: false, message: 'Brak połączenia z mikserem' };
    if (this.isBusy()) return { ok: false, message: 'Przejście w toku – spróbuj za chwilę' };
    const sw = this.next ?? this.plan(this.mixer.program);
    if (!sw) return { ok: false, message: 'Brak innej kamery do przełączenia – zaznacz co najmniej dwie' };
    return this.doSwitch(sw);
  }

  isBusy() {
    if (this.mixer.inTransition || this.executing) return true;
    return !!(this.expect && this.expect.until > this.now());
  }

  // ---------- stan ----------

  status() {
    const st = { runState: this.runState, next: this.next, intervalMs: this.intervalMs };
    if (this.runState === 'running' && this.deadline !== undefined) {
      st.deadline = this.deadline;
      st.remainingMs = Math.max(0, this.deadline - this.now());
    } else if (this.runState === 'paused') st.remainingMs = this.remaining;
    if (this.runState !== 'stopped') st.waiting = this.waitingReason();
    return st;
  }

  dispose() { this.clearTimer(); }

  // ---------- wnętrze ----------

  waitingReason() {
    if (!this.mixer.connected) return 'Czekam na połączenie z mikserem';
    if (this.mixer.program === undefined) return 'Czekam na stan miksera';
    const cams = this.settings.cameras;
    if (!this.next) {
      if (cams.length === 0) return 'Zaznacz kamery do rotacji';
      if (cams.length < 2 && cams.includes(this.mixer.program)) return 'Zaznacz co najmniej dwie kamery';
      return 'Brak kamery do przełączenia';
    }
    if (this.runState === 'running' && this.isBusy() && this.deadline !== undefined && this.deadline <= this.now()) return 'Czekam na koniec przejścia';
    return undefined;
  }

  plan(current) {
    const input = pickNextCamera(this.settings.cameras, this.settings.order, current, this.last, this.rng);
    if (input === undefined) return undefined;
    return { input, transition: pickTransition(this.settings, this.mixer.supportedTransitions, this.rng) };
  }

  beginInterval(current) {
    this.next = this.plan(current);
    const ms = pickDurationMs(this.settings, current, this.rng);
    this.intervalMs = ms;
    if (this.runState === 'running') {
      this.deadline = this.now() + ms;
      this.arm(ms);
    } else if (this.runState === 'paused') {
      this.remaining = ms;
      this.deadline = undefined;
    } else this.deadline = undefined;
  }

  onProgramChanged(program) {
    if (this.expect && program === this.expect.input) {
      this.expect = undefined; // nasze przejście doszło do skutku
      this.changed();
      return;
    }
    this.expect = undefined;
    if (this.runState === 'stopped') {
      if (!this.executing) this.next = this.plan(program);
      this.changed();
      return;
    }
    this.log(`Zmiana Program poza autopilotem (wejście ${program}) – liczę czas od nowa`);
    if (this.mixer.connected) this.beginInterval(program);
    this.changed();
  }

  arm(ms) {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => this.fire(), Math.max(0, ms));
  }

  clearTimer() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  fire() {
    this.timer = null;
    if (this.runState !== 'running' || !this.mixer.connected) return;
    if (this.isBusy()) {
      this.arm(BUSY_RETRY_MS);
      this.changed();
      return;
    }
    const p = this.next;
    const sw = p && p.input !== this.mixer.program && this.settings.cameras.includes(p.input) ? p : this.plan(this.mixer.program);
    if (!sw) {
      this.beginInterval(this.mixer.program);
      this.changed();
      return;
    }
    void this.doSwitch(sw);
  }

  async doSwitch(sw) {
    const fps = this.mixer.fps || 25;
    const frames = transitionFrames(this.settings, fps);
    const transitionMs = sw.transition === 'cut' ? 0 : (frames / fps) * 1000;
    this.clearTimer();
    this.executing = true;
    this.expect = { input: sw.input, until: this.now() + transitionMs + EXPECT_GRACE_MS };
    this.last = sw.input;
    this.changed();
    try {
      await this.deps.execute(sw, frames);
    } catch (e) {
      this.executing = false;
      this.expect = undefined;
      const msg = `Przejście nie powiodło się: ${e.message}`;
      this.log(msg);
      if (this.runState === 'running' && this.mixer.connected) {
        this.deadline = this.now() + ERROR_RETRY_MS;
        this.intervalMs = ERROR_RETRY_MS;
        this.arm(ERROR_RETRY_MS);
      }
      this.changed();
      return { ok: false, message: msg };
    }
    this.executing = false;
    if (this.mixer.connected) this.beginInterval(sw.input);
    this.changed();
    return { ok: true };
  }

  log(m) { this.deps.log?.(m); }
  changed() { this.deps.onChange?.(); }
}
