// Reżyseria: rozpoznawanie komend głosowych w tekście z transkrypcji i ich wykonanie na symulatorze.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCommand, numberOf } from '../src/mixer/voice.js';
import { MixerModule } from '../src/mixer/index.js';
import { SimMixer } from '../src/mixer/sim.js';
import { FakeClock } from './helpers.js';

const ok = (text, action, input) => {
  const r = parseCommand(text);
  assert.ok(r && r.ok, `„${text}” → ${JSON.stringify(r)}`);
  assert.equal(r.action, action, text);
  assert.equal(r.input, input, text);
};
const bad = (text, re) => {
  const r = parseCommand(text);
  assert.ok(r && !r.ok, `„${text}” powinno być odrzucone, jest ${JSON.stringify(r)}`);
  if (re) assert.match(r.error, re);
};

describe('numery kamer', () => {
  it('cyfry i słownie, w różnych formach', () => {
    const cases = { 2: 2, '12': 12, dwa: 2, dwie: 2, dwójka: 2, dwójkę: 2, dwójki: 2, drugą: 2, jedynkę: 1, pierwsza: 1,
      trzy: 3, trójkę: 3, trzecią: 3, cztery: 4, czwórka: 4, pięć: 5, piątkę: 5, sześć: 6, szóstka: 6, siedem: 7, siódemkę: 7,
      osiem: 8, ósemka: 8, dziewięć: 9, dziewiątka: 9, dziesięć: 10, dziesiątkę: 10, jedenaście: 11, dwanaście: 12, dwudziestka: 20 };
    for (const [w, n] of Object.entries(cases)) assert.equal(numberOf(w), n, w);
    assert.equal(numberOf('kamera'), undefined);
  });
});

describe('komendy', () => {
  it('Przygotuj <nr> → Preview', () => {
    ok('Przygotuj dwa', 'preview', 2);
    ok('Przygotuj dwójkę.', 'preview', 2);
    ok('przygotuj kamerę 3', 'preview', 3);
    ok('Kamera cztery, przygotuj.', 'preview', 4);
    ok('Przygotuj kamera2', 'preview', 2);
    ok('Piątka przygotuj się', 'preview', 5);
  });
  it('Wchodzisz <nr> → Program', () => {
    ok('Wchodzisz trzy', 'program', 3);
    ok('Wchodzisz dwójka!', 'program', 2);
    ok('Kamera jeden wchodzisz', 'program', 1);
    ok('Trójka, wchodzisz teraz.', 'program', 3);
  });
  it('Cut / Fade wchodzisz – z numerem i bez', () => {
    ok('Cut wchodzisz', 'cut', undefined);
    ok('Kat, wchodzisz.', 'cut', undefined);
    ok('Cut wchodzisz dwa', 'cut', 2);
    ok('Fade wchodzisz', 'fade', undefined);
    ok('Fejd wchodzisz 3.', 'fade', 3);
    ok('Fade wchodzisz kamera cztery', 'fade', 4);
    ok('Mix wchodzisz', 'fade', undefined);
  });
  it('typowe przekręcenia Whispera (z nagrań testowych)', () => {
    ok('Przygotuj dwój.', 'preview', 2);
    ok('Wchodzisz, twórka.', 'program', 4);
    ok('Cut wchodzisz dwo.', 'cut', 2);
    ok('Kamerę pięć. Przygotuj.', 'preview', 5);
    ok('Jedynkę wchodzisz.', 'program', 1);
  });
  it('zwykła rozmowa nie jest komendą', () => {
    assert.equal(parseCommand('Kto ma klucze do zakrystii?'), null);
    assert.equal(parseCommand('Dwójka zrób zbliżenie'), null);
    assert.equal(parseCommand(''), null);
  });
  it('niejasne komendy są odrzucane', () => {
    bad('Wchodzisz', /Brak numeru/);
    bad('Przygotuj', /Brak numeru/);
    bad('Przygotuj dwa i trzy', /Kilka numerów/);
    bad('Przygotuj dwójkę i wchodzisz', /Naraz/);
    bad('Cut fade wchodzisz', /Naraz/);
    bad('Przygotuj dwójkę, zrób zbliżenie na pastora', /Niejasna/);
    bad('Za chwilę wchodzisz trzy', /Niejasna/);
  });
});

async function moduleWithSim() {
  const clock = new FakeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mixer-'));
  const sim = new SimMixer({ connectDelayMs: 10, timers: clock });
  const m = new MixerModule({ dataDir: dir, timers: clock, mixerFactory: () => sim, logger: () => {} });
  await m.applyConfig({ enabled: true, simulation: true, me: 0 });
  await clock.advance(20);
  return { m, sim, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('wykonanie komend głosowych (symulator)', () => {
  it('Przygotuj → Preview, Cut wchodzisz → Program, Fade wchodzisz N', async () => {
    const { m, sim, clock, cleanup } = await moduleWithSim();
    let e = await m.voiceCommand({ text: 'Przygotuj trójkę', confidence: 0.9, who: 'Jan' });
    assert.equal(e.ok, true);
    assert.equal(sim.snapshot(0).preview, 3);
    e = await m.voiceCommand({ text: 'Cut wchodzisz', confidence: 0.9, who: 'Jan' });
    assert.equal(e.ok, true);
    assert.equal(sim.snapshot(0).program, 3);
    e = await m.voiceCommand({ text: 'Fade wchodzisz 5', confidence: 0.9, who: 'Jan' });
    assert.equal(e.ok, true, e.result);
    assert.equal(sim.snapshot(0).inTransition, true);
    await clock.advance(1000);
    assert.equal(sim.snapshot(0).program, 5);
    e = await m.voiceCommand({ text: 'Wchodzisz dwa', confidence: 0.9, who: 'Jan' });
    assert.equal(e.ok, true);
    assert.equal(sim.snapshot(0).program, 2);
    assert.deepEqual(sim.history.at(-1), { op: 'take', me: 0, kind: 'cut', frames: 25, input: 2 });
    await m.shutdown();
    cleanup();
  });
  it('niska pewność, nieistniejąca kamera, trwające przejście – nic nie robi', async () => {
    const { m, sim, clock, cleanup } = await moduleWithSim();
    const before = sim.history.length;
    let e = await m.voiceCommand({ text: 'Wchodzisz trzy', confidence: 0.3, who: 'Jan' });
    assert.equal(e.ok, false);
    assert.match(e.result, /Niska pewność/);
    e = await m.voiceCommand({ text: 'Przygotuj dziewięć', confidence: 0.95, who: 'Jan' });
    assert.equal(e.ok, false);
    assert.match(e.result, /Nie ma kamery 9/);
    await m.voiceCommand({ text: 'Fade wchodzisz 4', confidence: 0.95, who: 'Jan' });
    e = await m.voiceCommand({ text: 'Cut wchodzisz 2', confidence: 0.95, who: 'Jan' });
    assert.match(e.result, /Przejście w toku/);
    e = await m.voiceCommand({ text: 'Wchodzisz jeden', confidence: 0.95, who: 'Jan' });
    await clock.advance(1000);
    assert.equal(sim.history.length, before + 2); // tylko Fade (preview + take)
    assert.equal(await m.voiceCommand({ text: 'Dzień dobry wszystkim', confidence: 0.9, who: 'Jan' }), null);
    assert.equal(m.state().voiceLog.length, 5);
    await m.shutdown();
    cleanup();
  });
  it('komenda głosowa podczas autopilota liczy czas od nowa', async () => {
    const { m, sim, clock, cleanup } = await moduleWithSim();
    m.setSettings({ cameras: [1, 2, 3], timing: { mode: 'fixed', fixedSec: 10 } });
    m.start();
    await clock.advance(8000);
    await m.voiceCommand({ text: 'Cut wchodzisz 5', confidence: 0.9, who: 'Jan' });
    await clock.advance(9000);
    assert.equal(sim.snapshot(0).program, 5);
    await clock.advance(1000);
    assert.notEqual(sim.snapshot(0).program, 5);
    await m.shutdown();
    cleanup();
  });
});
