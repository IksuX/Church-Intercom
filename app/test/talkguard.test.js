// Limity mówienia przyciskiem (aplikacja natywna): ustawienia w panelu, przekazanie do telefonu i wyłączenie przez serwer.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dir, srv, me;

async function call(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* brak treści */ }
  return { status: res.status, data };
}
async function socket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(String(d))));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await sleep(150);
  return ws;
}
const ptt = (body) => call('/api/native/ptt', { method: 'POST', token: me.token, body });
const pttOff = (ws) => ws.msgs.filter((m) => m.t === 'ptt' && m.on === false).length;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-talk-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config', 'config.example.json'), 'utf8'));
  cfg.talkGuard = { max: 10, silence: 0, remind: 2 };
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(cfg));
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(dir, 'config', 'config.json'), DATA_DIR: path.join(dir, 'data'),
      SESSION_SECRET: 'test-secret-test-secret', STT_URL: '', LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:1', TLS_MODE: 'public' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* jeszcze startuje */ }
    await sleep(100);
  }
  const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8'));
  me = (await call('/api/join', { method: 'POST', body: { name: 'Operator', pin: cfg2.accessPin, rolePin: cfg2.speakerPin } })).data;
});
after(async () => { srv?.kill(); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); });

describe('limity mówienia przyciskiem', () => {
  it('telefon dostaje limity (poprawione do dozwolonego zakresu), nazwę kanału i mówiących', async () => {
    assert.ok(['speaker', 'admin'].includes(me.me.role), 'test wymaga prawa mówienia');
    const b = (await call('/api/native/beat', { method: 'POST', token: me.token, body: {} })).data;
    assert.deepEqual(b.talkGuard, { max: 10, silence: 0, remind: 5 });
    assert.deepEqual(me.talkGuard, b.talkGuard);
    assert.ok(b.targetName.length > 0);
    assert.deepEqual(b.names, []);
  });

  it('włącz/wyłącz: serwer wyłącza po limicie; przytrzymany mówi dalej; ręczne zakończenie anuluje limit', async () => {
    const ws = await socket(me.token);
    assert.equal((await ptt({ on: true, mode: 'toggle' })).status, 200);
    await ptt({ on: false });
    await sleep(300);
    const before = pttOff(ws);
    assert.equal((await ptt({ on: true, mode: 'toggle' })).status, 200);
    await sleep(12000);
    assert.equal(pttOff(ws), before, 'limit z poprzedniego mówienia nie działa na następne');
    await sleep(4000);
    assert.equal(pttOff(ws), before + 1, 'wyłączone po 10 + 5 s');
    assert.ok(ws.msgs.some((m) => m.t === 'talkLimit'));
    assert.equal((await ptt({ on: true, mode: 'hold' })).status, 200);
    await sleep(17000);
    assert.equal(pttOff(ws), before + 1, 'przytrzymany przycisk nie ma krótkiego limitu');
    await ptt({ on: false });
    ws.close();
  });

  it('panel zapisuje limity; błędne wartości wracają do zakresu', async () => {
    const admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    const cfg = (await call('/api/admin/config', { token: admin })).data.config;
    cfg.talkGuard = { max: 5000, silence: 1, remind: null };
    assert.equal((await call('/api/admin/config', { method: 'PUT', token: admin, body: { config: cfg } })).status, 200);
    const saved = (await call('/api/admin/config', { token: admin })).data.config.talkGuard;
    assert.deepEqual(saved, { max: 600, silence: 3, remind: 10 });
  });
});
