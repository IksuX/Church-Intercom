// Inputlista: składanie listy z patchu i obsady, walidacja i zapis (moduł), a na prawdziwym serwerze –
// widoczność przez WebSocket, rola Dźwięk przy line checku i zgłoszenie problemu na kanał ekipy.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { InputList, build, warnings, exampleStore, sanitizeStore } from '../src/inputlist.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER = [
  { personId: '1', name: 'Ola', positions: ['Worship Leader'], teamNames: ['Zespół'] },
  { personId: '2', name: 'Kasia', positions: ['Vocal 2'], teamNames: ['Zespół'] },
  { personId: '3', name: 'Ania', positions: ['Vocal 1'], teamNames: ['Zespół'] },
  { personId: '4', name: 'Basia', positions: ['Vocal 3'], teamNames: ['Zespół'] },
  { personId: '5', name: 'Zosia', positions: ['Vocal 4'], teamNames: ['Zespół'] },
  { personId: '6', name: 'Piotr', positions: ['Drums'], teamNames: ['Zespół'] },
  { personId: '7', name: 'Janek', positions: ['Cello'], teamNames: ['Zespół'] },
  { personId: '8', name: 'Marek', positions: ['Usher'], teamNames: ['Służba porządkowa'] },
];

describe('inputlista – moduł', () => {
  const st = exampleStore();
  const v = build(st, { id: '123', title: 'Niedziela' }, ROSTER);
  const row = (n) => v.rows.find((r) => r.name === n);

  it('przykład jest poprawny i bez ostrzeżeń', () => {
    assert.equal(st.patch.length, 19);
    assert.deepEqual(warnings(st), []);
  });

  it('„1 os.”: wokale po kolei pozycji; zwykłe kanały: wszyscy pasujący', () => {
    assert.deepEqual(row('WL').people, ['Ola']);
    assert.deepEqual(['Wok 2', 'Wok 3', 'Wok 4'].map((n) => row(n).people), [['Ania'], ['Kasia'], ['Basia']]);
    for (const n of ['Kick In', 'Snare', 'OH L', 'OH R']) assert.deepEqual(row(n).people, ['Piotr'], n);
  });

  it('używane: obsadzone i „zawsze”; reszta wyłączona', () => {
    assert.equal(row('Bass').active, false);
    assert.equal(row('Pulpit').active, true);
    assert.equal(v.summary.used, 14);
  });

  it('nieprzypisani: bez kanału i bez wolnego kanału, bez osób z innych zespołów', () => {
    assert.deepEqual(v.unassigned.map((u) => [u.name, u.reason]), [['Janek', 'noChannel'], ['Zosia', 'noFreeChannel']]);
  });

  it('bez planu: cały patch bez obsady', () => {
    const v0 = build(st, null, ROSTER);
    assert.equal(v0.planId, 'local');
    assert.ok(v0.rows.every((r) => r.people.length === 0));
  });

  it('walidacja odrzuca śmieci', () => {
    const bad = sanitizeStore({ gear: [{ name: '' }, { name: 'X', count: -5 }], patch: [{ ch: 1, stereoWith: 'nope', name: 'abcdefghijklmnopq' }, { ch: 1, gearId: 'zzz' }, null], plans: { '../x': {} } });
    assert.equal(bad.gear.length, 1);
    assert.equal(bad.gear[0].count, 1);
    assert.equal(bad.patch[0].stereoWith, null);
    assert.equal(bad.patch[0].name.length, 12);
    assert.equal(bad.patch[2].ch, 3);
    assert.deepEqual(Object.keys(bad.plans), []);
    assert.equal(warnings(bad)[0].code, 'dupChannel');
  });

  it('poprawki, line check i kanały „tylko dziś” – zapis i odczyt z pliku', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-il-'));
    try {
      const il = new InputList({ dataDir: dir, logger: () => {} });
      il.loadExample();
      const bass = il.data.patch.find((c) => c.name === 'Bass').id;
      il.override('123', bass, { active: true, person: 'Gość Tomek' }, 'Niedziela');
      il.check('123', bass, 'problem', 'Tomek', 'trzeszczy');
      const x = il.addExtra('123', { name: 'Skrzypce', gearId: 'gdi' });
      const b = il.view({ id: '123' }, ROSTER).rows.find((r) => r.id === bass);
      assert.deepEqual(b.people, ['Gość Tomek']);
      assert.equal(b.check.note, 'trzeszczy');
      assert.ok(il.view({ id: '123' }, ROSTER).rows.find((r) => r.id === x.id).extra);
      il.override('123', bass, { active: null, person: null });
      assert.equal(il.view({ id: '123' }, ROSTER).rows.find((r) => r.id === bass).active, false);
      assert.throws(() => il.check('123', 'nope', 'ok', 'a'));
      il.flush();
      const il2 = new InputList({ dataDir: dir, logger: () => {} });
      assert.equal(il2.data.plans['123'].check[bass].state, 'problem');
      assert.equal(il2.data.plans['123'].extra.length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------- serwer ----------
let dir, srv;
async function call(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* brak treści */ }
  return { status: res.status, data };
}
const join = async (name) => (await call('/api/join', { method: 'POST', body: { name, pin: '1234' } })).data;
async function socket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(String(d))));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await sleep(150);
  ws.last = (t) => [...ws.msgs].reverse().find((m) => m.t === t);
  return ws;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-ilsrv-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config', 'config.example.json'), 'utf8'));
  cfg.inputList = { enabled: true, reportChannel: 'technika' };
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(cfg));
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(dir, 'config', 'config.json'), DATA_DIR: path.join(dir, 'data'),
      SESSION_SECRET: 'test-secret-test-secret', LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.log = '';
  srv.stdout.on('data', (d) => { srv.log += d; });
  srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* jeszcze startuje */ }
    await sleep(100);
  }
});

after(async () => {
  srv?.kill();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('inputlista – serwer', () => {
  let admin, ola, olaWs;

  it('panel: bez logowania 401, przykład się zapisuje', async () => {
    assert.equal((await call('/api/admin/inputlist')).status, 401);
    admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    const ex = await call('/api/admin/inputlist/example', { token: admin });
    const r = await call('/api/admin/inputlist', { method: 'PUT', token: admin, body: ex.data });
    assert.equal(r.status, 200);
    assert.equal(r.data.patch.length, 19);
  });

  it('bez roli Dźwięk: brak listy przez WebSocket, 403 w HTTP, line check odrzucony', async () => {
    ola = await join('Ola');
    olaWs = await socket(ola.token);
    assert.equal(olaWs.last('perm').sound, false);
    assert.equal(olaWs.last('inputlist'), undefined);
    assert.equal((await call('/api/inputlist', { token: ola.token })).status, 403);
    olaWs.send(JSON.stringify({ t: 'ilCheck', ch: 'cohl', state: 'ok' }));
    await sleep(200);
    assert.match(olaWs.last('ilError').error, /Dźwięk/);
  });

  it('po nadaniu roli: lista przychodzi sama, line check i zgłoszenie problemu na kanał', async () => {
    const users = (await call('/api/admin/users', { token: admin })).data.users;
    const me = users.find((u) => u.name === 'Ola');
    await call('/api/admin/grant', { method: 'POST', token: admin, body: { userId: me.id, sound: true } });
    await sleep(300);
    assert.equal(olaWs.last('perm').sound, true);
    assert.equal(olaWs.last('inputlist').view.rows.length, 19);
    assert.equal((await call('/api/inputlist', { token: ola.token })).status, 200);

    olaWs.send(JSON.stringify({ t: 'ilCheck', ch: 'cohl', state: 'ok' }));
    await sleep(200);
    assert.equal(olaWs.last('inputlist').view.rows.find((r) => r.id === 'cohl').check.by, 'Ola');

    olaWs.send(JSON.stringify({ t: 'ilCheck', ch: 'cohr', state: 'problem', note: 'brak sygnału' }));
    await sleep(200);
    const msg = olaWs.msgs.filter((m) => m.t === 'msg' && m.m.channel === 'technika').pop();
    assert.match(msg.m.text, /Kanał 10 \(OH R/);
    assert.match(msg.m.text, /brak sygnału/);
    // to samo zgłoszenie drugi raz nie idzie na kanał
    olaWs.send(JSON.stringify({ t: 'ilCheck', ch: 'cohr', state: 'problem', note: 'brak sygnału' }));
    await sleep(200);
    assert.equal(olaWs.msgs.filter((m) => m.t === 'msg' && m.m.channel === 'technika').length, 1);

    olaWs.send(JSON.stringify({ t: 'ilReset' }));
    await sleep(200);
    assert.equal(olaWs.last('inputlist').view.summary.ok, 0);
  });

  it('po odebraniu roli lista znika (jednorazowo null)', async () => {
    const users = (await call('/api/admin/users', { token: admin })).data.users;
    const me = users.find((u) => u.name === 'Ola');
    await call('/api/admin/grant', { method: 'POST', token: admin, body: { userId: me.id, sound: false } });
    await sleep(300);
    assert.equal(olaWs.last('inputlist').view, null);
    olaWs.close();
  });
});
