// Prywatność i konto demo: strona /prywatnosc, informacja przy pierwszym logowaniu, okres przechowywania,
// usuwanie danych osoby oraz konto demo ograniczone do wybranych kanałów. Uruchamia prawdziwy serwer interkomu.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEMO_PIN = 'demo-test-1';

let dir, srv;

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
const send = (ws, o) => ws.send(JSON.stringify(o));
const texts = (ws) => ws.msgs.filter((m) => m.t === 'msg' && m.m.type === 'text').map((m) => `${m.m.channel}:${m.m.text}`);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-priv-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config', 'config.example.json'), 'utf8'));
  cfg.privacy = { controller: 'Parafia Testowa, ul. Próbna 1', contact: 'dane@example.org', retentionDays: 30 };
  cfg.demo = { enabled: true, pin: DEMO_PIN, channels: ['technika'], name: 'Recenzent Apple' };
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(cfg));
  // stary dziennik (sprzed okresu przechowywania) – serwer ma go usunąć przy starcie
  fs.mkdirSync(path.join(dir, 'data', 'log'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'log', '2020-01-01.jsonl'), JSON.stringify({ id: 'old', type: 'text', channel: 'ogolny', text: 'stare', ts: Date.parse('2020-01-01') }) + '\n');
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(dir, 'config', 'config.json'), DATA_DIR: path.join(dir, 'data'),
      SESSION_SECRET: 'test-secret-test-secret', STT_URL: '', LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:1', TLS_MODE: 'public' },
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

describe('prywatność', () => {
  it('strona /prywatnosc pokazuje administratora, kontakt i okres przechowywania', async () => {
    const r = await fetch(BASE + '/prywatnosc');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Parafia Testowa, ul\. Próbna 1/);
    assert.match(html, /mailto:dane@example\.org/);
    assert.match(html, /30 dni/);
    assert.match(html, /nie nagrywa rozmów/);
  });

  it('dziennik starszy niż okres przechowywania jest usuwany', async () => {
    await sleep(5500); // pierwsze porządki 5 s po starcie
    assert.equal(fs.existsSync(path.join(dir, 'data', 'log', '2020-01-01.jsonl')), false);
  });

  it('informacja przy pierwszym logowaniu: serwer zapamiętuje „Rozumiem”, nowa treść = ponownie', async () => {
    const a = (await call('/api/join', { method: 'POST', body: { name: 'Ola', pin: '1234' } })).data;
    assert.equal(a.privacy.ack, false);
    assert.equal(a.privacy.url, '/prywatnosc');
    assert.equal((await call('/api/privacy/ack', { method: 'POST', token: a.token, body: {} })).status, 200);
    assert.equal((await call('/api/session', { token: a.token })).data.privacy.ack, true);
    assert.equal((await call('/api/privacy/ack', { method: 'POST', body: {} })).status, 401);
    // administrator zmienia treść strony → nowa wersja
    const admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    const cfg = (await call('/api/admin/config', { token: admin })).data.config;
    cfg.privacy.notes = 'Nowa informacja';
    assert.equal((await call('/api/admin/config', { method: 'PUT', token: admin, body: { config: cfg } })).status, 200);
    assert.equal((await call('/api/session', { token: a.token })).data.privacy.ack, false);
  });

  it('usunięcie danych osoby zalogowanej PIN-em (po imieniu): pamięć, dziennik i ekrany innych', async () => {
    const kasia = (await call('/api/join', { method: 'POST', body: { name: 'Kasia', pin: '1234' } })).data;
    const obs = (await call('/api/join', { method: 'POST', body: { name: 'Obserwator', pin: '1234' } })).data;
    const k = await socket(kasia.token), o = await socket(obs.token);
    send(k, { t: 'msg', channel: 'ogolny', text: 'wiadomość Kasi' });
    send(o, { t: 'msg', channel: 'ogolny', text: 'wiadomość obserwatora' });
    await sleep(300);
    const admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    assert.equal((await call('/api/admin/forget', { method: 'POST', token: admin, body: { name: 'x' } })).status, 400);
    const r = await call('/api/admin/forget', { method: 'POST', token: admin, body: { name: 'kasia' } });
    assert.equal(r.status, 200);
    assert.ok(r.data.messages >= 1);
    await sleep(300);
    const del = o.msgs.find((m) => m.t === 'msgsDelete');
    assert.ok(del && del.ids.length >= 1, 'inni dostają listę usuniętych wpisów');
    const log = fs.readdirSync(path.join(dir, 'data', 'log')).map((f) => fs.readFileSync(path.join(dir, 'data', 'log', f), 'utf8')).join('');
    assert.doesNotMatch(log, /wiadomość Kasi/);
    assert.match(log, /wiadomość obserwatora/);
    const fresh = await socket(obs.token);
    const hello = fresh.msgs.find((m) => m.t === 'hello');
    assert.ok(!hello.history.some((m) => m.text === 'wiadomość Kasi'));
    k.close(); o.close(); fresh.close();
  });
});

describe('konto demo', () => {
  it('logowanie PIN-em demo: stała nazwa, prawo mówienia, tylko kanał ogólny i wybrane kanały', async () => {
    const d = await call('/api/join', { method: 'POST', body: { name: 'cokolwiek', pin: DEMO_PIN } });
    assert.equal(d.status, 200);
    assert.equal(d.data.me.name, 'Recenzent Apple');
    assert.equal(d.data.me.role, 'speaker');
    assert.equal(d.data.me.demo, true);
    assert.deepEqual(d.data.channels.map((c) => c.id).sort(), ['ogolny', 'technika']);
  });

  it('nie widzi innych kanałów ani listy ekipy, nie pisze poza swoimi kanałami, ma przykładowe wiadomości', async () => {
    const d = (await call('/api/join', { method: 'POST', body: { name: 'x', pin: DEMO_PIN } })).data;
    const t = (await call('/api/join', { method: 'POST', body: { name: 'Technik', pin: '1234' } })).data;
    const dw = await socket(d.token), tw = await socket(t.token);
    const hello = dw.msgs.find((m) => m.t === 'hello');
    assert.deepEqual(hello.channels.map((c) => c.id).sort(), ['ogolny', 'technika']);
    assert.ok(hello.history.some((m) => m.from === 'demo-sample' && m.channel === 'technika'), 'przykładowe wiadomości');
    assert.ok(hello.history.every((m) => ['ogolny', 'technika'].includes(m.channel)));
    send(tw, { t: 'listen', channels: ['technika', 'kamery'] });
    send(dw, { t: 'listen', channels: ['technika', 'kamery'] });
    await sleep(100);
    send(tw, { t: 'msg', channel: 'kamery', text: 'tylko dla ekipy' });
    send(tw, { t: 'msg', channel: 'technika', text: 'na technice' });
    send(dw, { t: 'msg', channel: 'kamery', text: 'demo na kamery' });
    send(dw, { t: 'msg', channel: 'technika', text: 'demo na technice' });
    await sleep(400);
    assert.deepEqual(texts(dw), ['technika:na technice', 'technika:demo na technice']);
    assert.ok(!texts(tw).includes('kamery:demo na kamery'));
    const pres = [...dw.msgs].reverse().find((m) => m.t === 'presence');
    assert.ok(pres.users.every((u) => u.name === 'Recenzent Apple'), 'lista obecnych bez ekipy');
    dw.close(); tw.close();
  });

  it('PIN demo musi różnić się od pozostałych', async () => {
    const admin = (await call('/api/admin/login', { method: 'POST', body: { pin: '9999' } })).data.token;
    const cfg = (await call('/api/admin/config', { token: admin })).data.config;
    cfg.demo.pin = cfg.accessPin;
    const r = await call('/api/admin/config', { method: 'PUT', token: admin, body: { config: cfg } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Konto demo/);
  });
});
