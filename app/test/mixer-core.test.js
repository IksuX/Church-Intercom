// Reżyseria: wybór kamer, czasy, przejścia, harmonogram autopilota, komendy do ATEM-a.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import atemPkg from 'atem-connection';
import { pickDurationMs, pickNextCamera, pickTransition, transitionFrames, fpsFromVideoModeName } from '../src/mixer/pick.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/mixer/settings.js';
import { Scheduler } from '../src/mixer/scheduler.js';
import { AtemMixer, snapshotFromState } from '../src/mixer/atem.js';
import { SimMixer } from '../src/mixer/sim.js';
import { FakeClock, seeded } from './helpers.js';

const { Enums } = atemPkg;
const S = (patch = {}) => sanitizeSettings({
  ...DEFAULT_SETTINGS, ...patch,
  timing: { ...DEFAULT_SETTINGS.timing, ...patch.timing },
  transitions: { ...DEFAULT_SETTINGS.transitions, ...patch.transitions },
});

describe('wybór kamery', () => {
  it('po kolei, z zawijaniem, bez kamery z Programu', () => {
    assert.equal(pickNextCamera([1, 3, 5], 'sequential', 1, undefined, Math.random), 3);
    assert.equal(pickNextCamera([1, 3, 5], 'sequential', 5, 3, Math.random), 1);
    assert.equal(pickNextCamera([1, 3, 5], 'sequential', 9, 3, Math.random), 5); // Program spoza listy – od ostatnio wybranej
    assert.equal(pickNextCamera([2], 'sequential', 2, undefined, Math.random), undefined);
  });
  it('losowo – nigdy dwa razy z rzędu, obejmuje wszystkie', () => {
    const rng = seeded(42);
    let cur = 1;
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const n = pickNextCamera([1, 2, 3, 4], 'random', cur, cur, rng);
      assert.notEqual(n, cur);
      seen.add(n);
      cur = n;
    }
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
  });
});

describe('czasy i przejścia', () => {
  it('stały, losowy i osobny dla kamery', () => {
    assert.equal(pickDurationMs(S({ timing: { fixedSec: 10 } }), 1, Math.random), 10000);
    const r = S({ timing: { mode: 'random', minSec: 6, maxSec: 14 } });
    const rng = seeded(3);
    for (let i = 0; i < 500; i++) { const d = pickDurationMs(r, 1, rng); assert.ok(d >= 6000 && d <= 14000); }
    const pc = S({ timing: { fixedSec: 8, perCameraEnabled: true, perCamera: { 1: 20 } } });
    assert.equal(pickDurationMs(pc, 1, Math.random), 20000);
    assert.equal(pickDurationMs(pc, 2, Math.random), 8000);
  });
  it('tylko obsługiwane przejścia; sekundy → klatki, max 250', () => {
    assert.equal(pickTransition(S({ transitions: { style: 'wipe' } }), ['cut', 'mix'], Math.random), 'cut');
    const rng = seeded(9);
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(pickTransition(S({ transitions: { random: true, pool: ['mix', 'dip', 'wipe'] } }), ['cut', 'mix', 'dip'], rng));
    assert.deepEqual([...seen].sort(), ['dip', 'mix']);
    assert.equal(transitionFrames(S({ transitions: { duration: 1, unit: 'seconds' } }), 25), 25);
    assert.equal(transitionFrames(S({ transitions: { duration: 10, unit: 'seconds' } }), 59.94), 250);
  });
  it('klatkaż z trybu wideo', () => {
    assert.equal(fpsFromVideoModeName('P1080p50'), 50);
    assert.equal(fpsFromVideoModeName('P1080i50'), 25);
    assert.ok(Math.abs(fpsFromVideoModeName('N1080p5994') - 59.94) < 0.01);
  });
  it('walidacja ustawień poprawia złe dane', () => {
    const s = sanitizeSettings({ cameras: [1, '2', 2, -1, 'x'], timing: { mode: 'random', minSec: 20, maxSec: 5, fixedSec: '7,5' }, transitions: { style: 'sting', duration: 9999 } });
    assert.deepEqual(s.cameras, [1, 2]);
    assert.equal(s.timing.minSec, 5);
    assert.equal(s.timing.fixedSec, 7.5);
    assert.equal(s.transitions.style, 'cut');
    assert.equal(s.transitions.duration, 250);
  });
});

/** Harmonogram z fałszywym mikserem: Cut natychmiast, Mix po czasie przejścia. */
function harness(settings = {}, clock = new FakeClock()) {
  const h = { clock, executed: [], logs: [], failNext: false };
  h.view = { connected: true, program: 1, inTransition: false, supportedTransitions: ['cut', 'mix', 'dip', 'wipe'], fps: 25 };
  h.set = (p) => { h.view = { ...h.view, ...p }; h.sched.updateMixer(h.view); };
  h.sched = new Scheduler({
    timers: clock, rng: seeded(5), log: (m) => h.logs.push(m),
    execute: async (sw, frames) => {
      if (h.failNext) { h.failNext = false; throw new Error('test'); }
      h.executed.push({ ...sw, frames });
      if (sw.transition === 'cut') h.set({ program: sw.input });
      else { h.set({ inTransition: true }); clock.setTimeout(() => h.set({ inTransition: false, program: sw.input }), (frames / 25) * 1000); }
    },
  });
  h.sched.setSettings(S({ cameras: [1, 2, 3], ...settings }));
  h.sched.updateMixer(h.view);
  h.inputs = () => h.executed.map((e) => e.input);
  return h;
}

describe('harmonogram autopilota', () => {
  it('po kolei co 10 s', async () => {
    const h = harness();
    h.sched.start();
    await h.clock.advance(9999);
    assert.equal(h.executed.length, 0);
    await h.clock.advance(1 + 20000);
    assert.deepEqual(h.inputs(), [2, 3, 1]);
  });
  it('pauza zachowuje pozostały czas, stop zatrzymuje', async () => {
    const h = harness();
    h.sched.start();
    await h.clock.advance(4000);
    h.sched.pause();
    assert.equal(h.sched.status().remainingMs, 6000);
    await h.clock.advance(60000);
    assert.equal(h.executed.length, 0);
    h.sched.resume();
    await h.clock.advance(6000);
    assert.deepEqual(h.inputs(), [2]);
    h.sched.stop();
    await h.clock.advance(60000);
    assert.deepEqual(h.inputs(), [2]);
  });
  it('ręczna zmiana: nie walczy i liczy czas od nowa', async () => {
    const h = harness();
    h.sched.start();
    await h.clock.advance(7000);
    h.set({ program: 3 });
    assert.equal(h.sched.status().next.input, 1);
    await h.clock.advance(9999);
    assert.equal(h.executed.length, 0);
    await h.clock.advance(1);
    assert.deepEqual(h.inputs(), [1]);
  });
  it('własny Mix nie jest ręczną zmianą; nie wyzwala w trakcie przejścia', async () => {
    const h = harness({ transitions: { ...DEFAULT_SETTINGS.transitions, style: 'mix', duration: 25 } });
    h.sched.start();
    await h.clock.advance(11000);
    assert.equal(h.view.program, 2);
    assert.ok(!h.logs.some((l) => l.includes('poza autopilotem')));
    h.set({ inTransition: true });
    await h.clock.advance(15000);
    assert.deepEqual(h.inputs(), [2]);
    h.set({ inTransition: false });
    await h.clock.advance(250);
    assert.deepEqual(h.inputs(), [2, 3]);
  });
  it('brak połączenia – bez zaległych zmian po powrocie', async () => {
    const h = harness();
    h.sched.start();
    await h.clock.advance(5000);
    h.set({ connected: false, program: undefined });
    await h.clock.advance(60000);
    h.set({ connected: true, program: 1 });
    await h.clock.advance(100);
    assert.equal(h.executed.length, 0);
    await h.clock.advance(9900);
    assert.deepEqual(h.inputs(), [2]);
  });
  it('nieudane przejście – ponowna próba po 3 s', async () => {
    const h = harness();
    h.failNext = true;
    h.sched.start();
    await h.clock.advance(10000);
    assert.equal(h.executed.length, 0);
    await h.clock.advance(3000);
    assert.deepEqual(h.inputs(), [2]);
  });
});

function fakeAtem(nextStyle = Enums.TransitionStyle.MIX) {
  const calls = [];
  const me = { transitionProperties: { nextStyle }, transitionSettings: { mix: { rate: 25 }, dip: { rate: 25 }, wipe: { rate: 25 } } };
  const rec = (n) => async (...a) => { calls.push(`${n}(${JSON.stringify(a)})`); };
  const m = new AtemMixer();
  m.atem = { state: { video: { mixEffects: [me, me] } }, changePreviewInput: rec('preview'), cut: rec('cut'), autoTransition: rec('auto'),
    setTransitionStyle: rec('style'), setMixTransitionSettings: rec('mixRate'), setDipTransitionSettings: rec('dipRate'), setWipeTransitionSettings: rec('wipeRate'), changeProgramInput: rec('PROGRAM') };
  m.status = 'connected';
  return { m, calls };
}

describe('komendy do ATEM-a', () => {
  it('Cut: Preview + Cut, nigdy bezpośrednio Program', async () => {
    const { m, calls } = fakeAtem();
    await m.transition(0, 3, 'cut', 25);
    assert.deepEqual(calls, ['preview([3,0])', 'cut([0])']);
  });
  it('Dip na M/E 2: styl, czas, Auto', async () => {
    const { m, calls } = fakeAtem();
    await m.transition(1, 4, 'dip', 50);
    assert.deepEqual(calls, ['preview([4,1])', `style([{"nextStyle":${Enums.TransitionStyle.DIP}},1])`, 'dipRate([{"rate":50},1])', 'auto([1])']);
  });
  it('take bez numeru (z Preview): sam Auto, czas ≤ 250', async () => {
    const { m, calls } = fakeAtem();
    await m.take(0, 'mix', 999);
    assert.deepEqual(calls, ['mixRate([{"rate":250},0])', 'auto([0])']);
  });
  it('bez połączenia odmawia', async () => {
    await assert.rejects(new AtemMixer().take(0, 'cut'), /Brak połączenia/);
  });
  it('obraz stanu: wejścia z miksera, M/E, przejścia', () => {
    const me = (i) => ({ index: i, programInput: 1, previewInput: 2, transitionPosition: { inTransition: false }, transitionProperties: {}, transitionSettings: { mix: {}, dip: {} } });
    const st = {
      info: { model: Enums.Model.Mini, capabilities: { mixEffects: 2 } }, settings: { videoMode: Enums.VideoMode.P1080p50 },
      video: { mixEffects: [me(0), me(1)] },
      inputs: {
        1: { inputId: 1, shortName: 'C1', longName: 'Kamera 1', internalPortType: Enums.InternalPortType.External, meAvailability: 15 },
        3: { inputId: 3, shortName: 'C3', longName: 'Kamera 3', internalPortType: Enums.InternalPortType.External, meAvailability: 1 },
        10010: { inputId: 10010, shortName: 'PGM', longName: 'Program', internalPortType: Enums.InternalPortType.MEOutput, meAvailability: 0 },
      },
    };
    const s = snapshotFromState(st, 1, 'connected');
    assert.deepEqual(s.inputs.map((i) => i.id), [1]);
    assert.deepEqual(s.supportedTransitions, ['cut', 'mix', 'dip']);
    assert.equal(s.fps, 50);
    assert.equal(snapshotFromState(st, 0, 'reconnecting').inputs.length, 0);
  });
  it('symulator: Mix przez Preview trwa zadany czas', async () => {
    const clock = new FakeClock();
    const sim = new SimMixer({ connectDelayMs: 10, timers: clock });
    await sim.connect('');
    await clock.advance(10);
    await sim.transition(0, 4, 'mix', 25);
    assert.equal(sim.snapshot(0).inTransition, true);
    await clock.advance(1000);
    assert.equal(sim.snapshot(0).program, 4);
    assert.equal(sim.snapshot(0).preview, 1);
  });
});
