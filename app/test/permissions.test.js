// Reżyseria: uprawnienia sprawdzane na serwerze (HTTP i WebSocket) i komendy głosowe tylko od Reżysera.
// Uruchamia prawdziwy serwer interkomu (symulator miksera) i fałszywą usługę STT.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir, srv, stt, sttPort;
const sttCalls = []; // { path, size }
let sttReply = { text: 'Przygotuj dwójkę', confidence: 0.92 };

async function call(p, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* brak treści */ }
  return { status: res.status, data };
}
const join = async (name, rolePin) => (await call('/api/join', { method: 'POST', body: { name, pin: '1234', ...(rolePin ? { rolePin } : {}) } })).data;

/** Połączenie WebSocket z zapisem wiadomości. */
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-perm-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config', 'config.example.json'), 'utf8'));
  cfg.mixer = { enabled: true, simulation: true };
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(cfg));
  // fałszywa usługa STT – zapisuje, kto do niej trafił
  stt = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      sttCalls.push({ path: url.pathname, size: Buffer.concat(chunks).length, prompt: url.searchParams.get('prompt') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...sttReply, seconds: 0.21, audio: 1.4 }));
    });
  });
  await new Promise((r) => stt.listen(0, '127.0.0.1', r));
  sttPort = stt.address().port;
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(dir, 'config', 'config.json'), DATA_DIR: path.join(dir, 'data'),
      SESSION_SECRET: 'test-secret-test-secret', STT_URL: `http://127.0.0.1:${sttPort}`, LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.log = '';
  srv.stdout.on('data', (d) => { srv.log += d; });
  srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* jeszcze startuje */ }
    await sleep(100);
  }
  await sleep(500); // symulator „łączy się” 300 ms
});

after(async () => {
  srv?.kill();
  stt?.close();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('uprawnienia Reżyserii', () => {
  let ola, jan, admin, olaWs, janWs;

  it('bez sesji – 401', async () => {
    assert.equal((await call('/api/mixer/state')).status, 401);
    assert.equal((await call('/api/mixer/cut', { method: 'POST' })).status, 401);
  });

  it('słuchający i mówiący bez roli Reżyser – 403 na każdym poleceniu, bez stanu miksera przez WebSocket', async () => {
    ola = await join('Ola');
    jan = await join('Jan', '5678');
    olaWs = await socket(ola.token);
    janWs = await socket(jan.token);
    for (const t of [ola.token, jan.token]) {
      assert.equal((await call('/api/mixer/state', { token: t })).status, 403);
      for (const a of ['preview', 'program', 'cut', 'fade', 'start', 'next']) {
        const r = await call(`/api/mixer/${a}`, { method: 'POST', token: t, body: { input: 2 } });
        assert.equal(r.status, 403, a);
        assert.match(r.data.error, /Reżyser/);
      }
      assert.equal((await call('/api/mixer/settings', { method: 'PUT', token: t, body: { settings: { cameras: [1, 2] } } })).status, 403);
      assert.equal((await call('/api/mixer/voice', { method: 'PUT', token: t, body: { on: true } })).status, 403);
      assert.equal((await call('/api/mixer/presets', { method: 'POST', token: t, body: { name: 'x' } })).status, 403);
      assert.equal((await call('/api/mixer/presets/x', { method: 'DELETE', token: t })).status, 403);
    }
    assert.equal(olaWs.last('perm').director, false);
    assert.equal(olaWs.last('mixer'), undefined);
    assert.equal(janWs.last('mixer'), undefined);
  });

  it('administrator nadaje rolę Reżyser – działa od razu (HTTP i WebSocket)', async () => {
    admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    const users = (await call('/api/admin/users', { token: admin })).data.users;
    const janU = users.find((u) => u.name === 'Jan');
    assert.equal(janU.director.effective, false);
    assert.equal((await call('/api/admin/grant', { method: 'POST', token: admin, body: { userId: janU.id, director: true } })).status, 200);
    await sleep(200);
    assert.equal(janWs.last('perm').director, true);
    const st = janWs.last('mixer').state;
    assert.equal(st.status, 'connected');
    assert.ok(st.inputs.length > 5);
    assert.equal(olaWs.last('mixer'), undefined); // Ola dalej nic nie dostaje
    const r = await call('/api/mixer/preview', { method: 'POST', token: jan.token, body: { input: 3 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await call('/api/mixer/state', { token: jan.token })).data.preview, 3);
    assert.equal((await call('/api/mixer/cut', { method: 'POST', token: jan.token })).status, 200);
    assert.equal((await call('/api/mixer/state', { token: jan.token })).data.program, 3);
    assert.equal((await call('/api/mixer/preview', { method: 'POST', token: jan.token, body: { input: 99 } })).status, 400);
  });

  it('komendy głosowe: tylko od Reżysera z włączonym sterowaniem głosem', async () => {
    const wav = Buffer.alloc(32000, 1);
    // Reżyser z wyłączonym sterowaniem głosem – nic nie idzie do rozpoznawania komend
    await call('/api/stt/talk0001', { method: 'POST', token: jan.token, body: wav, headers: { 'content-type': 'audio/wav' } });
    assert.equal(sttCalls.filter((c) => c.path === '/command').length, 0);
    // włącza
    const v = await call('/api/mixer/voice', { method: 'PUT', token: jan.token, body: { on: true } });
    assert.equal(v.data.on, true);
    await call('/api/stt/talk0002', { method: 'POST', token: jan.token, body: wav, headers: { 'content-type': 'audio/wav' } });
    await sleep(300);
    assert.equal(sttCalls.filter((c) => c.path === '/command').length, 1);
    assert.match(sttCalls.find((c) => c.path === '/command').prompt, /Przygotuj/);
    let st = (await call('/api/mixer/state', { token: jan.token })).data;
    assert.equal(st.preview, 2);
    assert.equal(st.voiceLog.at(-1).ok, true);
    assert.match(st.voiceLog.at(-1).result, /Preview → Ambona/);
    // niska pewność – nic
    sttReply = { text: 'Cut wchodzisz', confidence: 0.3 };
    await call('/api/stt/talk0003', { method: 'POST', token: jan.token, body: wav, headers: { 'content-type': 'audio/wav' } });
    await sleep(300);
    st = (await call('/api/mixer/state', { token: jan.token })).data;
    assert.equal(st.program, 3);
    assert.match(st.voiceLog.at(-1).result, /Niska pewność/);
    // słuchający (bez roli) – jego nagranie nie trafia do komend
    sttReply = { text: 'Cut wchodzisz', confidence: 0.95 };
    const before = sttCalls.filter((c) => c.path === '/command').length;
    await call('/api/stt/talk0004', { method: 'POST', token: ola.token, body: wav, headers: { 'content-type': 'audio/wav' } });
    await sleep(300);
    assert.equal(sttCalls.filter((c) => c.path === '/command').length, before);
    assert.equal((await call('/api/mixer/state', { token: jan.token })).data.program, 3);
  });

  it('odebranie roli – od razu 403 i „null” przez WebSocket; nagrania przestają sterować', async () => {
    const janU = (await call('/api/admin/users', { token: admin })).data.users.find((u) => u.name === 'Jan');
    await call('/api/admin/grant', { method: 'POST', token: admin, body: { userId: janU.id, director: false } });
    await sleep(200);
    assert.equal(janWs.last('perm').director, false);
    assert.equal(janWs.last('mixer').state, null);
    assert.equal((await call('/api/mixer/cut', { method: 'POST', token: jan.token })).status, 403);
    const before = sttCalls.filter((c) => c.path === '/command').length;
    await call('/api/stt/talk0005', { method: 'POST', token: jan.token, body: Buffer.alloc(32000, 1), headers: { 'content-type': 'audio/wav' } });
    await sleep(300);
    assert.equal(sttCalls.filter((c) => c.path === '/command').length, before);
  });

  it('Stream Deck: bez klucza wyłączony, z kluczem z panelu działa', async () => {
    assert.equal((await call('/api/mixer/deck/next')).status, 403);
    assert.equal((await call('/api/mixer/deck/next?key=zly')).status, 403);
    const key = (await call('/api/admin/mixer/deck-key', { method: 'POST', token: admin, body: {} })).data.key;
    assert.match(key, /^[a-f0-9]{32}$/);
    const r = await call(`/api/mixer/deck/preview?key=${key}&input=4`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await call(`/api/mixer/deck/fade?key=${key}`, { method: 'POST' })).status, 200);
    await call('/api/admin/mixer/deck-key', { method: 'POST', token: admin, body: { clear: true } });
    assert.equal((await call(`/api/mixer/deck/next?key=${key}`)).status, 403);
  });

  it('administrator (PIN) ma dostęp; panel widzi stan miksera', async () => {
    assert.equal((await call('/api/mixer/state', { token: admin })).status, 200);
    const info = (await call('/api/admin/mixer', { token: admin })).data;
    assert.equal(info.status, 'connected');
    assert.equal(info.simulation, true);
    olaWs.close();
    janWs.close();
  });
});
