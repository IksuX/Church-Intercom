// Interkom – serwer aplikacji: logowanie PIN-em, kanały, czat, szybkie przyciski,
// sygnalizacja push-to-talk i wydawanie tokenów do serwera głosowego LiveKit.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AccessToken, TrackSource, RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { loadConfig, validateConfig, saveJson, readJson, ConfigError } from './config.js';
import { History } from './history.js';
import { StreamMonitor } from './streams.js';
import { Platforms } from './platforms.js';
import { ProPresenterSync } from './webpresenter.mjs';
import { PlanningCenter } from './pco.js';
import * as pcoOauth from './pco-oauth.js';
import { Avatars } from './avatars.js';
import { Push } from './push.js';
import { systemInfo, helperInfo, requestAction, updateInfo } from './system.js';

const VERSION = '0.49.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config', 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CADDY_ROOT_CA = process.env.CADDY_ROOT_CA || '/caddy-data/caddy/pki/authorities/local/root.crt';
const LK_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET || 'devsecret_devsecret_devsecret_devsecret';
const LK_URL = process.env.LIVEKIT_PUBLIC_URL || ''; // puste = ten sam host co aplikacja
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 24 * 3600 * 1000;
const ROOM = 'interkom';
const STT_URL = process.env.STT_URL || ''; // np. http://127.0.0.1:8001 – puste = transkrypcja wyłączona

if (!process.env.SESSION_SECRET) console.warn('[uwaga] Brak SESSION_SECRET – sesje wygasną po restarcie.');

const SECRETS_PATH = path.join(path.dirname(CONFIG_PATH), 'secrets.json');
const STARTED = Date.now();
let config = loadConfig(CONFIG_PATH);
const avatars = new Avatars(DATA_DIR);
const push = new Push(DATA_DIR);
const pendingCalls = new Map(); // klucz osoby -> wezwanie czekające na powrót aplikacji z tła
// Kanały: z config.json + (opcjonalnie) z zespołów Planning Center – lista może się zmieniać w trakcie pracy.
let channels = config.channels;
let channelIds = new Set(channels.map((c) => c.id));
let broadcastId = (config.channels.find((c) => c.broadcast) || config.channels[0]).id;
const history = new History(DATA_DIR, config.historyPerChannel);
history.restoreToday({ has: (id) => channelIds.has(id) || String(id).startsWith('pco-') });

function setChannels(list) {
  if (JSON.stringify(list) === JSON.stringify(channels)) return;
  channels = list;
  channelIds = new Set(list.map((c) => c.id));
  broadcast({ t: 'channels', channels });
  console.log(`[kanały] ${channels.map((c) => c.name).join(', ')}`);
}

// ---------- Planning Center ----------
// Dane logowania: z panelu administratora (config/secrets.json), a gdy ich brak – z .env.
function pcoCredentials() {
  const sec = readJson(SECRETS_PATH, {});
  if (sec.pcoAppId && sec.pcoSecret) return { appId: sec.pcoAppId, secret: sec.pcoSecret, source: 'panel' };
  if (process.env.PCO_APP_ID && process.env.PCO_SECRET) return { appId: process.env.PCO_APP_ID, secret: process.env.PCO_SECRET, source: 'env' };
  return null;
}
let pco = null;

// ---- transmisje live (Web Presenter) ----
const platforms = new Platforms(SECRETS_PATH);
const streams = new StreamMonitor({
  platforms,
  notify({ kind, text }) {
    const sc = config.streams;
    if (sc.events[kind === 'ok' ? 'problem' : kind] === false) return;
    const ch = channelIds.has(sc.channel) ? sc.channel : broadcastId;
    post({ type: 'stream', kind, channel: ch, from: 'stream', fromName: 'Transmisja', text, urgent: kind === 'problem' || undefined });
    notifyWho((pr) => pr.stream, { title: 'Transmisja', body: text, tag: 'stream-' + kind, url: '/', vib: kind === 'problem' ? 'urgent' : 'soft', urgent: kind === 'problem' });
    console.log(`[transmisja] ${text}`);
  },
  onChange(list) { broadcast({ t: 'streams', list }); },
});
const bridgeToken = () => readJson(SECRETS_PATH, {}).bridgeToken || null;

// ---- ProPresenter: zegar punktu zgodny z Planning Center (bezpośrednio albo przez mostek) ----
const pp = new ProPresenterSync();
let ppBridge = { status: null, seen: 0, force: false };
function ppTarget() {
  const p = pco?.state?.plan;
  if (!p?.currentItemId || !p.currentStartedAt) return null;
  const items = p.items.filter((x) => x.type !== 'header');
  const i = items.findIndex((x) => x.id === p.currentItemId), cur = items[i];
  if (!cur?.length) return null; // punkt bez ustalonej długości – zegar zatrzymany
  const remaining = cur.length - (Date.now() - p.currentStartedAt) / 1000;
  const rest = items.slice(i + 1).reduce((a, x) => a + (x.length || 0), 0);
  return { key: `${p.id}|${cur.id}|${p.currentStartedAt}`, remaining, endRemaining: Math.max(remaining, 0) + rest, title: cur.title, at: Date.now() };
}
function ppConfigure() { pp.configure(config.propresenter?.mode === 'direct' ? config.propresenter : null); }
setInterval(() => { if (config.propresenter?.enabled && config.propresenter.mode === 'direct') pp.setTarget(ppTarget()); }, 1000);
function startPco() {
  if (pco) pco.stop();
  pco = null;
  const cred = pcoCredentials();
  if (!cred || config.planningCenter?.enabled === false) {
    console.log('[pco] Planning Center wyłączony.');
    setChannels(config.channels);
    broadcast({ t: 'plan', ok: true, plan: null, disabled: true });
    return;
  }
  const inst = new PlanningCenter({
    appId: cred.appId, secret: cred.secret, base: process.env.PCO_BASE_URL,
    cfg: config.planningCenter || {},
    onChange: (kind) => {
      if (pco !== inst) return; // stara instancja po zmianie ustawień
      if (kind !== 'live') { setChannels(inst.channels(config.channels)); sendPerms(); for (const x of inst.state.roster) avatars.remember(x.personId, x.photo); }
      broadcastPlan();
    },
  });
  pco = inst;
  inst.start().then(() => console.log(`[pco] połączono: ${inst.state.teams.length} zespołów, plan: ${inst.state.plan?.title || inst.state.plan?.dates || 'brak'}`));
}

// Zastosowanie nowej konfiguracji bez restartu
function applyConfig(next) {
  const pcoChanged = JSON.stringify(next.planningCenter) !== JSON.stringify(config.planningCenter);
  const brChanged = next.program?.bitrate !== config.program?.bitrate;
  config = next;
  if (brChanged && prog.src) send(prog.src, { t: 'bitrate', kbps: config.program.bitrate }); // nadajnik zmienia jakość od razu
  broadcastId = (config.channels.find((c) => c.broadcast) || config.channels[0]).id;
  history.per = config.historyPerChannel;
  if (pcoChanged) startPco();
  else setChannels(pco ? pco.channels(config.channels) : config.channels);
  streams.configure(config.streams);
  ppConfigure();
  if (!config.program.enabled) kickProgram();
  nativeHearSoon();
  if (config.program.enabled && config.program.source === 'server' && !programKey()) saveJson(SECRETS_PATH, { ...readJson(SECRETS_PATH, {}), programKey: crypto.randomBytes(18).toString('base64url') }); // klucz dla usługi audio
  broadcast({ t: 'config', org: config.orgName, brand: brandPublic(), quick: config.quick, broadcastChannel: broadcastId, sttOff: config.sttOff || [], sttDm: config.sttDm !== false, program: publicProgram() });
  sendPerms();
}

// Plan do wszystkich + ogłoszenie zmiany bieżącego punktu na kanale ogólnym (czytane przez syntezator)
const announced = { planId: null, itemId: null };
function broadcastPlan() {
  if (!pco) return;
  broadcast({ t: 'plan', ...pco.publicPlan() });
  const p = pco.state.plan;
  if (!p) return;
  const first = announced.planId !== p.id; // pierwszy odczyt planu (np. po restarcie) – bez ogłaszania
  const changed = p.currentItemId && p.currentItemId !== announced.itemId;
  announced.planId = p.id; announced.itemId = p.currentItemId;
  if (first || !changed || config.planningCenter?.announce === false) return;
  const i = p.items.findIndex((x) => x.id === p.currentItemId);
  const cur = p.items[i];
  const next = p.items.slice(i + 1).find((x) => x.type !== 'header');
  const meta = (it) => [it.key && `tonacja ${it.key}`, it.bpm && `${it.bpm} BPM`].filter(Boolean).join(' · ');
  notifyWho((pr) => pr.plan, { title: `▶ Teraz: ${cur.title}`, body: next ? `Następnie: ${next.title}` : 'Ostatni punkt planu', tag: 'plan', url: '/', vib: 'soft' });
  post({
    type: 'plan', channel: broadcastId, from: 'plan', fromName: 'Plan',
    text: `Teraz: ${cur.title}`, itemId: cur.id, notes: (cur.notes || []).slice(0, 12),
    nowTitle: cur.title, nowMeta: meta(cur), nextTitle: next?.title || '', nextMeta: next ? meta(next) : '',
  });
}

// Kto może sterować Planning Center Live: administrator oraz osoby z obsady na wskazanych stanowiskach / w zespołach.
function canControlLive(u) {
  const lc = config.planningCenter?.liveControl;
  if (!pco || !lc?.enabled) return false;
  if (u.role === 'admin') return true;
  const g = u.sess ? grantFor(u.sess) : {};
  if (g.live === true || g.live === false) return g.live;
  return autoLive(u);
}
function autoLive(u) {
  const lc = config.planningCenter?.liveControl;
  if (!pco || !lc?.enabled) return false;
  if (u.role === 'admin') return true;
  const person = u.pid && pco.state.roster.find((x) => x.personId === u.pid);
  if (!person) return false;
  const low = (v) => String(v).toLocaleLowerCase('pl');
  return person.positions.some((p) => lc.positions.some((r) => low(p).includes(low(r))))
    || person.teamNames.some((t) => lc.teams.some((r) => low(r) === low(t)));
}
function perms(u) {
  const lc = !!config.planningCenter?.liveControl?.enabled;
  return { liveControl: canControlLive(u), manualPlan: !lc && (u.role === 'speaker' || u.role === 'admin'),
    moderate: canModerate(u), stt: !sttUserOff(u) };
}
// Kto może przenosić i wyciszać innych: administrator oraz osoby sterujące planem (reżyser, prowadzący – Planning Center)
function canModerate(u) { return u.role === 'admin' || canControlLive(u); }
function sendPerms() {
  for (const u of users.values()) for (const ws of u.sockets) send(ws, { t: 'perm', ...perms(u) });
}
// Zastosowanie zmian uprawnień w locie: rola w aplikacji + prawo nadawania w LiveKit
const lkAdmin = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', LK_KEY, LK_SECRET);
function applyGrants() {
  for (const u of users.values()) {
    if (!u.sess) continue;
    const role = effectiveRole(u.sess);
    if (role === u.role) continue;
    u.role = role;
    const canTalk = role === 'speaker' || role === 'admin';
    if (!canTalk && u.talking) endTalk(u);
    // najpierw uprawnienie w serwerze głosowym, potem informacja dla telefonu (żeby mikrofon mógł od razu nadawać)
    lkAdmin.updateParticipant(ROOM, u.id, { permission: { canSubscribe: true, canPublish: canTalk, canPublishData: false, canPublishSources: canTalk ? [TrackSource.MICROPHONE] : [] } })
      .catch((e) => console.warn(`[uprawnienia] LiveKit (${u.name}): ${e.message}`))
      .finally(() => { for (const ws of u.sockets) send(ws, { t: 'role', role }); });
    console.log(`[uprawnienia] ${u.name}: ${role}`);
  }
  sendPerms();
  schedulePresence();
}

let liveBusy = false;
async function liveCommand(u, ws, fn) {
  if (!canControlLive(u)) return send(ws, { t: 'liveError', error: 'Nie masz uprawnień do sterowania planem.' });
  if (liveBusy) return send(ws, { t: 'liveError', error: 'Poprzednie przełączenie punktu jeszcze trwa – spróbuj za chwilę.' });
  liveBusy = true;
  try { await fn(); console.log(`[live] ${u.name} → ${pco.state.plan?.items.find((i) => i.id === pco.state.plan.currentItemId)?.title || '?'}`); }
  catch (e) { send(ws, { t: 'liveError', error: e.message }); console.warn('[live]', e.message); }
  finally { liveBusy = false; broadcastPlan(); }
}

// ---------- sesje (bezstanowe tokeny podpisane HMAC – przetrwają restart serwera) ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
function signSession(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() - p.iat > SESSION_TTL_MS) return null;
    return p;
  } catch { return null; }
}

// ---------- ograniczenie prób PIN ----------
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 10 * 60 * 1000) { a.n = 0; a.t = now; }
  attempts.set(ip, a);
  return a.n >= 10;
}
const failAttempt = (ip) => { const a = attempts.get(ip); if (a) a.n++; };

// ---------- stan użytkowników online ----------
/** id -> { id, name, role, listen:Set, target, talking, talkStart, sockets:Set } */
const users = new Map();

const isDm = (ch) => typeof ch === 'string' && ch.startsWith('dm:');
function publicUser(u) {
  // rozmowy prywatne nie są widoczne dla innych – ukrywamy cel szeptu
  return { id: u.id, key: pk(u), name: u.name, role: u.role, pid: u.pid && avatars.has(u.pid) ? u.pid : null, listen: [...u.listen],
    target: isDm(u.target) ? null : u.target, talking: isDm(u.talking) ? null : u.talking, nicks: getNicks(pk(u)), sttOff: sttUserOff(u) };
}

// ================= KSYWKI i OZNACZANIE @ =================
// Ksywki per osoba (klucz jak przy rozmowach prywatnych): osoby z Planning Center – na stałe, z PIN-u – do wylogowania.
const NICKS_PATH = path.join(DATA_DIR, 'nicknames.json');
let nicks = readJson(NICKS_PATH, {});
const getNicks = (key) => nicks[key] || [];
function cleanNicks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[,;\n]/)) {
    const n = String(raw).trim().replace(/^@+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 24);
    if (n.length >= 2 && !out.some((x) => x.toLocaleLowerCase('pl') === n.toLocaleLowerCase('pl'))) out.push(n);
  }
  return out.slice(0, 4);
}
function setNicks(key, list) {
  const v = cleanNicks(list);
  if (v.length) nicks[key] = v; else delete nicks[key];
  saveJson(NICKS_PATH, nicks);
  schedulePresence();
  return v;
}
// Oznaczenia z wiadomości: id osób wybrane z listy w aplikacji + rozpoznane w tekście (@imię, @ksywka, @wszyscy)
const normH = (x) => String(x || '').toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
function resolveMentions(text, ids) {
  const keys = new Set();
  for (const id of Array.isArray(ids) ? ids.slice(0, 20) : []) { const x = users.get(String(id)); if (x) keys.add(pk(x)); }
  const handles = [...String(text).matchAll(/@([\p{L}\p{N}_.-]{2,30})/gu)].map((m) => normH(m[1]).replace(/[.]+$/, ''));
  const all = handles.includes('wszyscy');
  for (const h of handles) {
    if (h === 'wszyscy') continue;
    const hit = [...users.values()].filter((x) => x.sockets.size && (getNicks(pk(x)).some((n) => normH(n) === h) || normH(x.name.split(/\s+/)[0]) === h));
    if (hit.length === 1) keys.add(pk(hit[0])); // niejednoznaczne imię – tylko gdy wybrano osobę z listy
  }
  return { mentions: [...keys], mentionAll: all };
}

// ================= ROZMOWY PRYWATNE =================
// Klucz osoby: z Planning Center – stały (p<id>), zalogowani PIN-em – na czas sesji (s<id sesji>).
// Wiadomości trafiają tylko do dwóch uczestników, są w pamięci i znikają przy czyszczeniu czatu (bez dziennika na dysku).
function pk(u) { return u.pid ? 'p' + u.pid : 's' + u.id; }
// Push tylko wtedy, gdy aplikacja nie jest na ekranie (w tle, zablokowany telefon albo rozłączona)
function notifyPush(key, payload) {
  const online = usersByKey(key).filter((x) => x.sockets.size && !x.hidden);
  if (online.length) return;
  nativeNotify(key, payload); // aplikacja na telefonie (iPhone/Android) – powiadomienie przez połączenie głosowe, także w tle
  if (!push.has(key)) return;
  if (!payload.urgent && payload.tag && push.throttled(key, payload.tag)) {
    // za szybko po poprzednim – nie gubimy: zbieramy i wysyłamy jedno zbiorcze po chwili
    const k = key + '|' + payload.tag, q = pushQueue.get(k) || { n: 0 };
    q.n++; q.payload = payload;
    if (!q.timer) q.timer = setTimeout(() => {
      pushQueue.delete(k);
      if (usersByKey(key).some((x) => x.sockets.size && !x.hidden)) return; // w międzyczasie otworzył aplikację
      const p = q.payload, more = q.n - 1;
      push.last.set(k, Date.now());
      push.send(key, more ? { ...p, body: `${p.body}  (+${more} wcześniej)` } : p).catch(() => {});
    }, 4000);
    pushQueue.set(k, q);
    return;
  }
  push.send(key, payload).catch(() => {});
}
const pushQueue = new Map();
// osoby z otwartą aplikacją są „w akcji” – odświeżaj ich znacznik co minutę; raz na godzinę porządki
setInterval(() => { for (const u of users.values()) if (u.sockets.size) push.touch(pk(u), u.sess.iat + SESSION_TTL_MS); }, 60000);
setInterval(() => push.prune(), 3600000);
// Powiadomienie do wszystkich, którzy tego chcą (preferencje z ustawień aplikacji)
function notifyWho(want, payload, exceptKey) {
  for (const key of new Set([...push.keys(), ...nativeKeys()])) if (key !== exceptKey && want(push.pref(key), key)) notifyPush(key, payload);
}
// Kanał: osoby, które go słuchają (teraz albo według ostatnio zapisanej listy)
function listensTo(key, ch) {
  return usersByKey(key).some((x) => x.listen.has(ch)) || push.pref(key).listen.includes(ch);
}
function notifyChannel(fromKey, ch, title, body, opts = {}) {
  const chName = channels.find((c) => c.id === ch)?.name || ch;
  notifyWho((p, key) => (opts.urgent || p.channels) && listensTo(key, ch),
    { title: `${title} · ${chName}`, body, tag: (opts.urgent ? 'urgent-' : 'ch-') + ch, url: '/', vib: opts.urgent ? 'urgent' : 'msg', urgent: !!opts.urgent }, fromKey);
}
const dms = new Map(); // convKey -> { members: { key: { name, pid } }, msgs: [] }
const convKey = (a, b) => [a, b].sort().join('|');
function usersByKey(key) { return [...users.values()].filter((x) => pk(x) === key); }
function dmPeer(u, ch) {
  if (!isDm(ch)) return null;
  const key = ch.slice(3);
  if (!key || key === pk(u)) return null;
  const online = usersByKey(key)[0];
  const known = [...dms.values()].find((c) => c.members[key] && c.members[pk(u)]);
  if (!online && !known) return null;
  return { key, name: online?.name || known.members[key].name, pid: online?.pid || known?.members[key].pid || null };
}
// ta sama wiadomość widziana z perspektywy odbiorcy (kanał = dm:<druga osoba>)
function dmView(m, viewerKey, conv) {
  const otherKey = m.fromKey === viewerKey ? m.toKey : m.fromKey;
  const other = conv.members[otherKey] || {};
  return { ...m, channel: 'dm:' + otherKey, peerName: other.name, peerPid: other.pid && avatars.has(other.pid) ? other.pid : null };
}
function dmDeliver(t, m) {
  const conv = dms.get(m.conv);
  for (const key of [m.fromKey, m.toKey]) for (const x of usersByKey(key)) for (const ws of x.sockets) send(ws, { t, m: dmView(m, key, conv) });
}
function dmPost(u, peer, msg) {
  const from = pk(u);
  const ck = convKey(from, peer.key);
  const conv = dms.get(ck) || { members: {}, msgs: [] };
  conv.members[from] = { name: u.name, pid: u.pid || null };
  conv.members[peer.key] = { name: peer.name, pid: peer.pid || null };
  dms.set(ck, conv);
  const full = { ...msg, id: msg.id || crypto.randomBytes(6).toString('hex'), ts: Date.now(), dm: true, conv: ck, fromKey: from, toKey: peer.key };
  delete full.channel;
  conv.msgs.push(full);
  if (conv.msgs.length > 300) conv.msgs.splice(0, conv.msgs.length - 300);
  dmDeliver('msg', full);
  if (push.pref(peer.key).dm || full.urgent) notifyPush(peer.key, { title: `💬 ${u.name} (prywatnie)`, body: full.type === 'voice' ? '🎙 szept' : full.text, tag: 'dm-' + from, url: '/', vib: 'msg' });
  return full;
}
function dmFind(id) { for (const c of dms.values()) { const m = c.msgs.find((x) => x.id === id); if (m) return m; } return null; }
function dmHistoryFor(u) {
  const k = pk(u);
  const out = [];
  for (const c of dms.values()) if (c.members[k]) for (const m of c.msgs) out.push(dmView(m, k, c));
  return out;
}
// kto szepcze do kogo (żeby odbiorca miał kanał audio otwarty zawczasu – bez uciętego początku)
function setWhisperTarget(u, ch) {
  const prev = u.wPeer || null;
  const peer = dmPeer(u, ch);
  u.wPeer = peer ? peer.key : null;
  if (prev && prev !== u.wPeer) for (const x of usersByKey(prev)) for (const ws of x.sockets) send(ws, { t: 'wtarget', user: u.id, on: false });
  if (u.wPeer) for (const x of usersByKey(u.wPeer)) for (const ws of x.sockets) send(ws, { t: 'wtarget', user: u.id, on: true });
}
function presence() {
  // aplikacja natywna przy zablokowanym ekranie nie ma otwartej strony, ale słucha – też jest obecna („w tle”)
  return [...users.values()].filter((u) => u.sockets.size > 0 || nativeActive(u.id)).map((u) => (u.sockets.size ? publicUser(u) : { ...publicUser(u), bg: true }));
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const u of users.values()) for (const ws of u.sockets) if (ws.readyState === 1) ws.send(s);
}
let presenceTimer = null;
function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => { presenceTimer = null; broadcast({ t: 'presence', users: presence() }); }, 50);
}

async function livekitToken(s) {
  const canTalk = s.role === 'speaker' || s.role === 'admin';
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: s.id, name: s.name, ttl: '24h' });
  at.addGrant({
    room: ROOM, roomJoin: true, canSubscribe: true,
    canPublish: canTalk, canPublishSources: canTalk ? [TrackSource.MICROPHONE] : [],
    canPublishData: false, canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

// Rola i zespoły liczone na bieżąco z obsady Planning Center (zmiany w grafiku działają bez ponownego logowania).
function rosterPerson(s) { return s.pid && pco ? pco.state.roster.find((x) => x.personId === s.pid) : null; }
// Ręczne uprawnienia z panelu: osoby z Planning Center – trwale (config.grants), pozostali – do końca sesji.
const sessionGrants = new Map();
function grantFor(s) { return (s.pid ? config.grants?.[s.pid] : sessionGrants.get(s.id)) || {}; }
function autoRole(s) {
  if (s.role === 'admin' || s.role === 'speaker') return s.role;
  return rosterPerson(s)?.canSpeak ? 'speaker' : 'listener';
}
function effectiveRole(s) {
  if (s.role === 'admin') return 'admin';
  const g = grantFor(s);
  if (g.admin === true) return 'admin'; // administrator nadany w panelu (np. osobie z Planning Center)
  if (g.speak === true) return 'speaker';
  if (g.speak === false) return 'listener';
  return autoRole(s);
}
function effective(s) {
  const person = rosterPerson(s);
  return { ...s, role: effectiveRole(s), teams: person ? person.teams : (s.teams || []), teamNames: person ? person.teamNames : [] };
}

async function sessionResponse(token, s0) {
  const s = effective(s0);
  return {
    token,
    me: { id: s.id, name: s.name, role: s.role, fromRoster: !!s.pid,
      teams: s.teamNames, viaPco: s.via === 'pco' },
    org: config.orgName,
    brand: brandPublic(),
    version: VERSION,
    channels,
    defaultListen: pco && s.teams?.length ? [broadcastId, ...pco.channelsForTeams(s.teams)] : null,
    broadcastChannel: broadcastId,
    pco: !!pco,
    quick: config.quick,
    stt: !!STT_URL, sttOff: config.sttOff || [], sttDm: config.sttDm !== false,
    livekit: { url: LK_URL, token: await livekitToken(s) },
  };
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // przed aplikacją stoi tylko Caddy na tym komputerze – nagłówkom X-Forwarded-For klienta nie ufamy

// ---------- dostęp spoza sieci kościoła ----------
// Adres „prywatny” = sieć lokalna, VPN (100.64/10) albo ten komputer. Wszystko inne to internet (przekierowane porty).
function isPrivateIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return true;
  const m = ip.match(/^(\d+)\.(\d+)\./); if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
// adres klienta zza Caddy: ostatni wpis X-Forwarded-For (dopisuje go Caddy), tylko gdy połączenie przyszło z tego komputera
function clientIp(req) {
  const peer = req.socket?.remoteAddress || '';
  if (!isPrivateIp(peer) || !/^(::ffff:)?127\.|^::1$/.test(peer)) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : peer;
}
// Ograniczenia „spoza sieci” mają sens tylko dla serwera w sieci kościoła. Serwer w chmurze (tryb VPS, TLS_MODE=public)
// z natury obsługuje wszystkich przez internet – tam nikt nie jest „spoza sieci”.
const LAN_SERVER = process.env.TLS_MODE !== 'public';
const isRemote = (req) => LAN_SERVER && !isPrivateIp(req.ip ?? clientIp(req));
const REMOTE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interkom</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ebf2;font:16px system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:44px">📡</div><h1 style="font-size:22px">Dostęp spoza sieci jest wyłączony</h1><p style="color:#8b93a7">Interkom działa teraz tylko w sieci Wi-Fi kościoła. Administrator może włączyć dostęp zdalny w panelu.</p></div></body>`;
app.use((req, res, next) => {
  if (!isRemote(req) || config.remote?.enabled !== false) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(403).json({ error: 'Dostęp spoza sieci kościoła jest wyłączony.' });
  res.status(403).type('html').send(REMOTE_PAGE);
});
// panel administracyjny z internetu – tylko gdy administrator na to pozwolił
app.use((req, res, next) => {
  if (!(req.path === '/admin' || req.path === '/admin.html' || req.path.startsWith('/api/admin/')) || !isRemote(req) || config.remote?.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Panel administracyjny jest dostępny tylko w sieci kościoła (można to zmienić w panelu: Ogólne → Dostęp spoza sieci).' });
  res.status(403).type('html').send(REMOTE_PAGE.replace('Dostęp spoza sieci jest wyłączony', 'Panel administracyjny – tylko w sieci kościoła').replace('Interkom działa teraz tylko w sieci Wi-Fi kościoła. Administrator może włączyć dostęp zdalny w panelu.', 'Zaloguj się do panelu z sieci kościoła albo poproś administratora o włączenie panelu spoza sieci.'));
});
const remotePinBlocked = (req) => isRemote(req) && !config.remote?.pin;
const REMOTE_PIN_MSG = 'Spoza sieci kościoła zaloguj się kontem Planning Center (logowanie PIN-em działa tylko w kościele).';
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/admin/restore' ? next() : smallJson(req, res, next))); // kopia ustawień ma własny, większy limit

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, online: presence().length }));

app.post('/api/join', async (req, res) => {
  const ip = req.ip;
  if (remotePinBlocked(req)) return res.status(403).json({ error: REMOTE_PIN_MSG });
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Za dużo prób. Odczekaj 10 minut.' });
  // PIN ekipy + wpisane imię (goście, zastępstwa). Tożsamość z grafiku potwierdza tylko logowanie kontem Planning Center.
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const pin = String(req.body?.pin || '');
  const rolePin = String(req.body?.rolePin || '');
  if (!name) return res.status(400).json({ error: 'Podaj imię.' });
  if (pin !== String(config.accessPin)) { failAttempt(ip); return res.status(401).json({ error: 'Nieprawidłowy PIN.' }); }
  let role = 'listener'; // prawo mówienia z grafiku dolicza effectiveRole()
  if (rolePin) {
    if (config.adminPin && rolePin === String(config.adminPin)) role = 'admin';
    else if (rolePin === String(config.speakerPin)) role = 'speaker';
    else { failAttempt(ip); return res.status(401).json({ error: 'Nieprawidłowy PIN mówiącego.' }); }
  }
  const s = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name, role, iat: Date.now() };
  res.json(await sessionResponse(signSession(s), s));
});

// PIN mówiącego / administratora dla już zalogowanej osoby (np. przez Planning Center) – zachowuje tożsamość i zespoły
app.post('/api/elevate', async (req, res) => {
  const ip = req.ip;
  if (remotePinBlocked(req)) return res.status(403).json({ error: 'PIN mówiącego działa tylko w sieci kościoła.' });
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Za dużo prób. Odczekaj 10 minut.' });
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).json({ error: 'Sesja wygasła.' });
  const pin = String(req.body?.pin || '');
  let role;
  if (config.adminPin && pin === String(config.adminPin)) role = 'admin';
  else if (pin === String(config.speakerPin)) role = s.role === 'admin' ? 'admin' : 'speaker';
  else { failAttempt(ip); return res.status(401).json({ error: 'Nieprawidłowy PIN.' }); }
  const next = { ...s, role, iat: Date.now() };
  console.log(`[login] ${s.name}: PIN → ${role}`);
  res.json(await sessionResponse(signSession(next), next));
});

app.get('/api/session', async (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = verifySession(token);
  if (!s) return res.status(401).json({ error: 'Sesja wygasła.' });
  res.json(await sessionResponse(token, s));
});

// ---------- transkrypcja: klient wysyła kopię wypowiedzi PO jej zakończeniu ----------
// (głos na żywo idzie osobno przez LiveKit – ten tor niczego nie opóźnia)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// podpowiedź dla Whispera: krótkie zdanie ze słownictwem. Bez list imion – długie listy powodują,
// że model zaczyna je „przepisywać” zamiast słuchać nagrania (zapętlenia).
// Bez domyślnej podpowiedzi – ciągnęła model w stronę tych słów i zmieniała sens wypowiedzi.
const sttPrompt = () => (config.sttPrompt || '').slice(0, 160);
// Słowa podpowiadane modelowi (hotwords): słownik z panelu + tytuły z bieżącego planu (+ opcjonalnie imiona z grafiku).
// Kolejność = priorytet; razem maks. ~400 znaków, żeby podpowiedź nie „przejęła” wypowiedzi.
function sttHotwords() {
  const out = [], seen = new Set();
  const add = (w) => {
    w = String(w || '').replace(/^(pieśń|piosenka|utwór|song)\s*:\s*/i, '').replace(/[„”"«»]/g, '').replace(/\s+/g, ' ').trim();
    const k = w.toLocaleLowerCase('pl');
    if (w.length < 2 || w.length > 60 || seen.has(k)) return;
    seen.add(k); out.push(w);
  };
  String(config.sttDictionary || '').split(/[,;\n]/).forEach(add);
  const p = pco?.state?.plan;
  if (p && config.sttHints?.plan !== false) {
    const items = p.items.filter((x) => x.type !== 'header');
    const i = Math.max(0, items.findIndex((x) => x.id === p.currentItemId));
    [...items.slice(i, i + 4), ...items].forEach((x) => add(x.title)); // najpierw bieżący i najbliższe punkty
  }
  if (config.sttHints?.names) for (const r of pco?.state?.roster || []) add(String(r.name || '').split(' ')[0]);
  let s = '';
  for (const w of out) { if ((s + ', ' + w).length > 400) break; s = s ? `${s}, ${w}` : w; }
  return s;
}
const sttQuery = (who) => `lang=${encodeURIComponent(config.sttLanguage || 'pl')}&prompt=${encodeURIComponent(sttPrompt())}&hotwords=${encodeURIComponent(sttHotwords())}&who=${encodeURIComponent(who || '')}`;
// osoby bez transkrypcji: po kluczu (osoby z Planning Center), a zalogowane PIN-em – także po imieniu (klucz zmienia się po wylogowaniu)
function sttUserOff(u) {
  const low = (x) => String(x || '').trim().toLocaleLowerCase('pl');
  return (config.sttOffUsers || []).some((x) => x.key === pk(u) || (!u.pid && x.key.startsWith('s') && low(x.name) === low(u.name)));
}
const sttEnabledFor = (ch, isDmTalk, u) => !!STT_URL && !(u && sttUserOff(u)) && (isDmTalk ? config.sttDm !== false : !(config.sttOff || []).includes(ch));

app.post('/api/stt/:talkId', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).json({ error: 'Sesja wygasła.' });
  if (!STT_URL) return res.status(404).json({ error: 'Transkrypcja wyłączona.' });
  if (!/^[a-z0-9]{4,32}$/i.test(req.params.talkId)) return res.status(400).end();
  const id = voiceMsgId(s.id, req.params.talkId);
  // wpis o wypowiedzi powstaje po sygnale „koniec mówienia” – daj mu chwilę
  let m = history.get(id) || dmFind(id);
  for (let i = 0; !m && i < 30; i++) { await sleep(100); m = history.get(id) || dmFind(id); }
  if (!m || m.stt !== 'pending') return res.status(204).end(); // za krótka wypowiedź albo kanał bez transkrypcji
  const size = req.body?.length || 0, ctype = req.get('content-type') || '?';
  if (req.query.error || !size) {
    const why = String(req.query.error || 'puste nagranie').slice(0, 120);
    console.warn(`[stt] ${s.name}: brak nagrania – ${why} (${ctype})`);
    updateMsg(id, { stt: 'failed', sttError: why });
    return res.status(400).end();
  }
  res.status(202).json({ ok: true });
  try {
    const url = `${STT_URL}/transcribe?${sttQuery(s.name)}`;
    const r = await fetch(url, { method: 'POST', body: req.body, headers: { 'content-type': req.get('content-type') || 'application/octet-stream' }, signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `STT ${r.status}`);
    updateMsg(id, { text: String(j.text || '').slice(0, 1000), stt: j.text ? 'done' : 'empty', sttConf: typeof j.confidence === 'number' ? j.confidence : null });
    if (m.channel) notifyChannel(sessionKey(s), m.channel, `🎙 ${s.name}`, j.text ? String(j.text).slice(0, 300) : `mówił(a) ${Math.round((m.durationMs || 0) / 1000)} s`);
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'przekroczony czas (serwer transkrypcji zbyt wolny)'
      : err.cause?.code === 'ECONNREFUSED' || err.message === 'fetch failed' ? 'usługa transkrypcji nie działa'
      : err.message;
    console.warn(`[stt] ${s.name}: ${why} (${ctype}, ${Math.round(size / 1024)} kB)`);
    updateMsg(id, { stt: 'failed', sttError: why });
    if (m.channel) notifyChannel(sessionKey(s), m.channel, `🎙 ${s.name}`, `mówił(a) ${Math.round((m.durationMs || 0) / 1000)} s`);
  }
});

// ================= MOSTEK TRANSMISJI (serwer w chmurze, urządzenia w sieci kościoła) =================
function requireBridge(req, res, next) {
  const t = bridgeToken(), got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t || got.length !== t.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t))) return res.status(401).json({ error: 'zły token mostka' });
  next();
}
app.get('/api/bridge/config', requireBridge, (_req, res) => {
  const c = config.propresenter;
  res.json({ devices: streams.bridgeDevices(), propresenter: c.enabled && c.mode === 'bridge' ? { enabled: true, host: c.host, port: c.port, timer: c.timer, endTimer: c.endTimer } : null });
});
app.get('/api/bridge/pp', requireBridge, (_req, res) => {
  const force = ppBridge.force; ppBridge.force = false;
  const t = ppTarget();
  res.json({ target: t ? { key: t.key, remaining: t.remaining, endRemaining: t.endRemaining, title: t.title } : null, force });
});
app.post('/api/bridge/report', requireBridge, express.json({ limit: '64kb' }), (req, res) => {
  streams.bridgeReport(req.body?.devices);
  if (req.body?.pp) ppBridge = { ...ppBridge, status: req.body.pp, seen: Date.now() };
  res.json({ ok: true });
});
// program mostka do pobrania (ten sam plik co moduł serwera)
app.get('/interkom-bridge.mjs', (_req, res) => res.type('text/javascript').sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'webpresenter.mjs')));

// ================= LOGOWANIE PRZEZ PLANNING CENTER =================
function oauthCreds() {
  const sec = readJson(SECRETS_PATH, {});
  return sec.pcoOauthId && sec.pcoOauthSecret ? { clientId: sec.pcoOauthId, clientSecret: sec.pcoOauthSecret } : null;
}
const oauthEnabled = () => !!(pco && config.planningCenter?.oauthLogin?.enabled && oauthCreds());
const redirectUri = (req) => `${req.protocol}://${req.get('host')}/auth/pco/callback`;

app.get('/api/login-options', (req, res) => res.json({ org: config.orgName, pcoLogin: oauthEnabled(), logo: logoUrl(), brand: brandPublic(), remote: isRemote(req), pinLogin: !remotePinBlocked(req), apps: appLinks() }));

// ---------- plik aplikacji na Androida (APK) trzymany na tym serwerze ----------
// Administrator wgrywa plik w panelu; ekran logowania pokazuje przycisk „Pobierz na Androida”, gdy nie ma linku do Google Play.
const DL_DIR = path.join(DATA_DIR, 'download');
const APK_PATH = path.join(DL_DIR, 'interkom.apk'), APK_META = path.join(DL_DIR, 'interkom.apk.json');
const APK_URL = '/pobierz/interkom.apk';
function apkInfo() {
  try { const st = fs.statSync(APK_PATH); const m = readJson(APK_META, {}); return { url: APK_URL, size: st.size, at: m.at || st.mtime.toISOString(), name: m.name || 'interkom.apk', downloads: m.downloads || 0 }; }
  catch { return null; }
}
const appLinks = () => ({ ios: config.apps?.ios || '', android: config.apps?.android || (apkInfo() ? `${APK_URL}?v=${encodeURIComponent(apkInfo().at)}` : '') });
app.get(APK_URL, (req, res) => {
  const info = apkInfo();
  if (!info) return res.status(404).type('text').send('Plik aplikacji nie został jeszcze wgrany (panel → Ogólne → Aplikacja na telefon).');
  try { saveJson(APK_META, { ...readJson(APK_META, {}), downloads: (info.downloads || 0) + 1 }); } catch {}
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.android.package-archive');
  res.download(APK_PATH, 'interkom.apk');
});
app.get('/api/admin/apk', requireAdmin, (_req, res) => res.json({ apk: apkInfo() }));
app.post('/api/admin/apk', requireAdmin, (req, res) => {
  fs.mkdirSync(DL_DIR, { recursive: true });
  const tmp = APK_PATH + '.part';
  const out = fs.createWriteStream(tmp);
  let size = 0, head = null, tooBig = false;
  req.on('data', (c) => { if (!head) head = c.subarray(0, 4); size += c.length; if (size > 300 * 1024 * 1024 && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); res.status(413).json({ error: 'Plik jest za duży (maks. 300 MB).' }); req.resume(); } });
  req.pipe(out);
  out.on('finish', () => {
    if (tooBig) return fs.rm(tmp, { force: true }, () => {});
    if (!head || head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) { fs.rm(tmp, { force: true }, () => {}); return res.status(400).json({ error: 'To nie jest plik APK (zbuduj go w Android Studio: Build → Build APK(s)).' }); }
    fs.renameSync(tmp, APK_PATH);
    saveJson(APK_META, { name: String(req.get('x-file-name') || 'interkom.apk').slice(0, 120), at: new Date().toISOString(), downloads: 0 });
    console.log(`[admin] wgrano aplikację na Androida (${Math.round(size / 1024 / 1024)} MB, ${req.ip})`);
    res.json({ ok: true, apk: apkInfo() });
  });
  out.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: 'Nie udało się zapisać pliku: ' + e.message }); });
});
app.delete('/api/admin/apk', requireAdmin, (_req, res) => {
  fs.rm(APK_PATH, { force: true }, () => {}); fs.rm(APK_META, { force: true }, () => {});
  res.json({ ok: true, apk: null });
});

// ---------- wygląd: kolor przewodni i logo (panel → Ogólne → Wygląd) ----------
const BRAND_DIR = path.join(DATA_DIR, 'branding');
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const logoUrl = () => (config.branding?.logo ? '/branding/logo?v=' + encodeURIComponent(config.branding.logo) : null);
// proporcje logo (szerokość/wysokość) – potrzebne do przekolorowania (maska CSS nie zna rozmiaru obrazka)
const logoRatios = new Map();
function logoRatio(f) {
  if (!f) return null;
  if (logoRatios.has(f)) return logoRatios.get(f);
  let r = null;
  try {
    const buf = fs.readFileSync(path.join(BRAND_DIR, f));
    if (f.endsWith('.png') && buf.length > 24) r = buf.readUInt32BE(16) / buf.readUInt32BE(20);
    else if (f.endsWith('.svg')) {
      const head = buf.subarray(0, 4096).toString('utf8'), tag = (head.match(/<svg\b[^>]*>/i) || [''])[0];
      const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i);
      const w = tag.match(/\swidth\s*=\s*["']\s*([\d.]+)/i), h = tag.match(/\sheight\s*=\s*["']\s*([\d.]+)/i);
      if (vb && +vb[2] > 0) r = +vb[1] / +vb[2]; else if (w && h && +h[1] > 0) r = +w[1] / +h[1];
    }
  } catch {}
  if (!(r > 0.05 && r < 50)) r = null;
  logoRatios.set(f, r);
  return r;
}
// kolor logo działa dla SVG i PNG (przezroczyste tło = kształt logo); JPG/WebP – zawsze oryginał
const logoTintable = (f) => !!f && (f.endsWith('.svg') || f.endsWith('.png')) && !!logoRatio(f);
function brandPublic() {
  const b = config.branding || {}, f = b.logo;
  const c = logoTintable(f) && b.logoColor ? (b.logoColor === 'accent' ? b.accent : b.logoColor) : null;
  return { accent: b.accent, logo: logoUrl(), logoColor: c, ratio: f ? logoRatio(f) : null, tintable: logoTintable(f) };
}
function brandCss() {
  // #3b82f6 i #5ab9fc to dawne kolory domyślne – traktujemy je jak brak wyboru (domyślnie pomarańcz w stylu Intercom)
  const a = !config.branding?.accent || ['#3b82f6', '#5ab9fc'].includes(config.branding.accent) ? '#ff5600' : config.branding.accent;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // tekst na kolorze przewodnim: ciemny albo biały – ten, który daje większy kontrast (próg WCAG ≈ 0,18)
  return `:root{--accent:${a};--accent-fg:${lum > 0.179 ? '#0a0d14' : '#fff'}}\n`;
}
app.get('/branding.css', (_req, res) => { res.set('cache-control', 'no-cache').type('text/css').send(brandCss()); });
app.get('/branding/logo', (_req, res) => {
  const f = config.branding?.logo; if (!f) return res.status(404).end();
  const p = path.join(BRAND_DIR, f); if (!fs.existsSync(p)) return res.status(404).end();
  if (f.endsWith('.svg')) res.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('cache-control', 'public, max-age=86400').sendFile(p);
});
function setBranding(patch) {
  const next = validateConfig({ ...config, branding: { ...config.branding, ...patch } });
  saveJson(CONFIG_PATH, next); applyConfig(next);
}
app.post('/api/admin/branding/logo', requireAdmin, express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
  const ext = LOGO_TYPES[(req.get('content-type') || '').split(';')[0].trim().toLowerCase()];
  if (!ext) return res.status(400).json({ error: 'Logo: obsługiwane są pliki PNG, JPG, WebP i SVG.' });
  if (!req.body?.length) return res.status(400).json({ error: 'Pusty plik.' });
  fs.mkdirSync(BRAND_DIR, { recursive: true });
  const name = `logo-${Date.now().toString(36)}.${ext}`;
  fs.writeFileSync(path.join(BRAND_DIR, name), req.body);
  const old = config.branding?.logo;
  setBranding({ logo: name });
  if (old && old !== name) fs.rm(path.join(BRAND_DIR, old), { force: true }, () => {});
  res.json({ ok: true, logo: logoUrl(), branding: config.branding, brand: brandPublic() });
});
app.delete('/api/admin/branding/logo', requireAdmin, (_req, res) => {
  const old = config.branding?.logo;
  setBranding({ logo: '' });
  if (old) fs.rm(path.join(BRAND_DIR, old), { force: true }, () => {});
  res.json({ ok: true, branding: config.branding, brand: brandPublic() });
});

app.get('/auth/pco/start', (req, res) => {
  if (!oauthEnabled()) return res.redirect('/#loginError=' + encodeURIComponent('Logowanie przez Planning Center jest wyłączone.'));
  res.redirect(pcoOauth.startUrl({ clientId: oauthCreds().clientId, redirectUri: redirectUri(req) }));
});

app.get('/auth/pco/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/#loginError=' + encodeURIComponent(msg));
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'Logowanie anulowane.' : `Planning Center: ${req.query.error}`);
  if (!oauthEnabled()) return fail('Logowanie przez Planning Center jest wyłączone.');
  try {
    const who = await pcoOauth.finish({ ...oauthCreds(), code: String(req.query.code || ''), state: String(req.query.state || '') });
    if (!who.personId) return fail('Nie udało się ustalić, kim jesteś.');
    if (pco.state.orgId && who.orgId && who.orgId !== pco.state.orgId) return fail('To konto należy do innej organizacji w Planning Center.');
    const person = pco.state.roster.find((x) => x.personId === who.personId);
    if (config.planningCenter.oauthLogin.rosterOnly && !person) return fail('Nie ma Cię w obsadzie bieżącego planu. Zaloguj się PIN-em ekipy.');
    const s = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name: (person?.name || who.name).slice(0, 40), role: 'listener', iat: Date.now(), pid: who.personId, via: 'pco' };
    avatars.remember(who.personId, who.photo);
    console.log(`[login] ${s.name} przez Planning Center${person ? '' : ' (spoza obsady)'}`);
    res.redirect('/#session=' + encodeURIComponent(signSession(s)));
  } catch (e) {
    console.warn('[login]', e.message);
    fail(e.message);
  }
});

// ================= PANEL ADMINISTRATORA (/admin) =================
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Za dużo prób. Odczekaj 10 minut.' });
  if (String(req.body?.pin || '') !== String(config.adminPin)) { failAttempt(ip); return res.status(401).json({ error: 'Nieprawidłowy PIN administratora.' }); }
  const s = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name: 'Administrator', role: 'admin', iat: Date.now(), panel: true };
  res.json({ token: signSession(s) });
});
function requireAdmin(req, res, next) {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s || effectiveRole(s) !== 'admin') return res.status(401).json({ error: 'Wymagane logowanie administratora.' });
  req.admin = s; next();
}
const adminErr = (res, e) => res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
function pcoInfo() {
  const cred = pcoCredentials();
  return {
    hasCredentials: !!cred, source: cred?.source || null,
    appIdMasked: cred ? cred.appId.slice(0, 4) + '…' + cred.appId.slice(-4) : null,
    connected: !!pco?.state.ok, error: pco?.state.error || null,
    oauth: { hasCredentials: !!oauthCreds(), clientIdMasked: oauthCreds() ? oauthCreds().clientId.slice(0, 4) + '…' + oauthCreds().clientId.slice(-4) : null },
  };
}

app.get('/api/admin/config', requireAdmin, (_req, res) => res.json({ config, pco: pcoInfo(), version: VERSION }));

app.put('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const next = validateConfig(req.body?.config);
    saveJson(CONFIG_PATH, next);
    applyConfig(next);
    console.log(`[admin] zapisano konfigurację (${req.ip})`);
    res.json({ ok: true, config });
  } catch (e) { adminErr(res, e); }
});

app.post('/api/admin/pco/credentials', requireAdmin, async (req, res) => {
  const appId = String(req.body?.appId || '').trim(), secret = String(req.body?.secret || '').trim();
  if (!appId || !secret) return res.status(400).json({ error: 'Podaj Application ID i Secret.' });
  try {
    const types = await PlanningCenter.test(appId, secret, process.env.PCO_BASE_URL);
    saveJson(SECRETS_PATH, { ...readJson(SECRETS_PATH, {}), pcoAppId: appId, pcoSecret: secret });
    startPco();
    res.json({ ok: true, serviceTypes: types, pco: pcoInfo() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/admin/pco/credentials', requireAdmin, (_req, res) => {
  const sec = readJson(SECRETS_PATH, {});
  delete sec.pcoAppId; delete sec.pcoSecret;
  saveJson(SECRETS_PATH, sec);
  startPco();
  res.json({ ok: true, pco: pcoInfo() });
});

app.get('/api/admin/oauth', requireAdmin, (req, res) => {
  // adres powrotu dla każdej nazwy serwera (w sieci i spoza sieci) – wszystkie trzeba dopisać w Planning Center
  const hosts = [...new Set([req.get('host'), process.env.DOMAIN, process.env.REMOTE_DOMAIN].filter((h) => h && !/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === req.get('host')))];
  res.json({ redirectUri: redirectUri(req), redirectUris: hosts.map((h) => `https://${h}/auth/pco/callback`), pco: pcoInfo() });
});
// dostęp spoza sieci: adresy i stan (panel → Ogólne → Dostęp spoza sieci)
app.get('/api/admin/remote', requireAdmin, (req, res) => res.json({ lan: process.env.DOMAIN || null, remote: process.env.REMOTE_DOMAIN || null, cloud: !LAN_SERVER, youAreRemote: isRemote(req), settings: config.remote }));
app.post('/api/admin/oauth', requireAdmin, (req, res) => {
  const clientId = String(req.body?.clientId || '').trim(), clientSecret = String(req.body?.clientSecret || '').trim();
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Podaj Client ID i Secret.' });
  saveJson(SECRETS_PATH, { ...readJson(SECRETS_PATH, {}), pcoOauthId: clientId, pcoOauthSecret: clientSecret });
  res.json({ ok: true, pco: pcoInfo() });
});
app.delete('/api/admin/oauth', requireAdmin, (_req, res) => {
  const sec = readJson(SECRETS_PATH, {}); delete sec.pcoOauthId; delete sec.pcoOauthSecret; saveJson(SECRETS_PATH, sec);
  res.json({ ok: true, pco: pcoInfo() });
});

app.get('/api/admin/pco/meta', requireAdmin, (_req, res) => {
  if (!pco) return res.json({ pco: pcoInfo() });
  const st = pco.state;
  const teamNames = [...new Set(st.teams.map((t) => t.name))].sort((a, b) => a.localeCompare(b, 'pl'));
  const rosterPositions = st.roster.flatMap((x) => x.positions);
  res.json({
    pco: pcoInfo(),
    serviceTypes: st.allServiceTypes || [],
    teams: teamNames,
    positions: [...new Set([...(st.positions || []), ...rosterPositions])].sort((a, b) => a.localeCompare(b, 'pl')),
    leaders: st.leaders.size,
    channels,
    teamChannel: Object.fromEntries(teamNames.map((n) => {
      const t = st.teams.find((x) => x.name === n);
      return [n, channels.find((c) => c.id === pco.teamToChannel?.get(t.id))?.name || null];
    })),
    plan: st.plan ? { id: st.plan.id, title: st.plan.title, dates: st.plan.dates, serviceTypeName: st.plan.serviceTypeName, items: st.plan.items.length } : null,
    roster: st.roster.map((x) => ({ name: x.name, teams: x.teamNames, positions: x.positions, canSpeak: x.canSpeak })),
    upcoming: st.upcoming || [],
    manualPlan: st.manualPlan || null,
  });
});
app.post('/api/admin/pco/select', requireAdmin, async (req, res) => {
  if (!pco) return res.status(400).json({ error: 'Planning Center nie jest podłączony.' });
  await pco.selectPlan(req.body?.planId ? String(req.body.planId) : null);
  res.json({ ok: true });
});
app.post('/api/admin/pco/refresh', requireAdmin, async (_req, res) => {
  if (!pco) return res.status(400).json({ error: 'Planning Center nie jest podłączony.' });
  await pco.reloadStructure(); await pco.refresh();
  res.json({ ok: true, pco: pcoInfo() });
});

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  let stt = { enabled: !!STT_URL };
  if (STT_URL) {
    try { stt = { enabled: true, ...(await (await fetch(`${STT_URL}/health`, { signal: AbortSignal.timeout(2000) })).json()) }; }
    catch { stt = { enabled: true, ready: false, error: 'usługa transkrypcji nie odpowiada' }; }
  }
  res.json({ version: VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000), users: presence(), stt, pco: pcoInfo(), channels, streams: streams.status() });
});

// Stan komputera-serwera i usług + ponowne uruchomienie (panel → Stan → Serwer)
app.get('/api/admin/system', requireAdmin, async (_req, res) => {
  const ping = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.status < 500; } catch { return false; } };
  const [lk, stt] = await Promise.all([ping(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880'), STT_URL ? ping(`${STT_URL}/health`) : null]);
  const srcServer = config.program?.enabled && config.program?.source === 'server';
  res.json({
    ...systemInfo(DATA_DIR),
    appUptimeSec: Math.round((Date.now() - STARTED) / 1000), version: VERSION,
    services: { app: true, livekit: lk, stt, audio: srcServer ? !!prog.src : null },
    helper: helperInfo(DATA_DIR),
  });
});
app.post('/api/admin/system/action', requireAdmin, (req, res) => {
  const action = String(req.body?.action || '');
  if (!['restart', 'reboot', 'poweroff', 'restart-app'].includes(action)) return res.status(400).json({ error: 'Nieznane polecenie.' });
  const helper = helperInfo(DATA_DIR).installed;
  if (action !== 'restart-app' && !helper) return res.status(409).json({ error: 'Na serwerze brakuje usługi sterowania – uruchom ponownie instalator (sudo ./install.sh).' });
  console.log(`[admin] polecenie dla serwera: ${action} (${req.ip})`);
  res.json({ ok: true, action });
  // najpierw odpowiedź, potem wykonanie (restart przerwie połączenie z panelem)
  setTimeout(() => {
    if (action === 'restart-app') process.exit(0); // Docker uruchamia aplikację ponownie (restart: unless-stopped)
    try { requestAction(DATA_DIR, action); } catch (e) { console.error('[admin] nie udało się zlecić polecenia:', e.message); }
  }, 400);
});

// Aktualizacje z GitHuba – sprawdzenie i aktualizacja wykonuje usługa sterowania na serwerze (git i instalator)
app.get('/api/admin/update', requireAdmin, (_req, res) => {
  res.json({ version: VERSION, helper: helperInfo(DATA_DIR).installed, ...updateInfo(DATA_DIR) });
});
app.post('/api/admin/update', requireAdmin, (req, res) => {
  const what = String(req.body?.action || '');
  if (!['check', 'run'].includes(what)) return res.status(400).json({ error: 'Nieznane polecenie.' });
  const u = updateInfo(DATA_DIR);
  if (!helperInfo(DATA_DIR).installed || !u.supported) return res.status(409).json({ error: 'Usługa sterowania na serwerze jest starsza – uruchom raz na serwerze: cd ~/interkom && ./update.sh' });
  if (u.check && u.check.git === false) return res.status(409).json({ error: 'Folder interkomu nie jest połączony z GitHubem – zob. README, „Aktualizacje z GitHuba”.' });
  if (what === 'run' && u.state?.state === 'running' && Date.now() - Date.parse(u.state.at) < 20 * 60e3) return res.status(409).json({ error: 'Aktualizacja już trwa.' });
  console.log(`[admin] aktualizacja: ${what} (${req.ip})`);
  try { requestAction(DATA_DIR, what === 'run' ? 'update' : 'update-check'); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// ProPresenter – stan i ręczna synchronizacja
app.get('/api/admin/propresenter', requireAdmin, (_req, res) => {
  const c = config.propresenter, t = ppTarget();
  const st = c.mode === 'bridge' ? ppBridge.status : pp.status;
  res.json({ enabled: c.enabled, mode: c.mode, status: st, bridgeSeen: c.mode === 'bridge' ? ppBridge.seen || null : null,
    target: t ? { title: t.title, remaining: Math.round(t.remaining), endRemaining: Math.round(t.endRemaining) } : null });
});
app.post('/api/admin/propresenter/sync', requireAdmin, async (_req, res) => {
  if (config.propresenter.mode === 'bridge') { ppBridge.force = true; return res.json({ ok: true, via: 'bridge' }); }
  pp.setTarget(ppTarget()); await pp.force();
  res.json({ ok: pp.status.online, error: pp.status.error || null });
});

// Ksywki – lista osób (online + grafik Planning Center) i zapis
app.get('/api/admin/nicks', requireAdmin, (_req, res) => {
  const people = new Map();
  for (const r of pco?.state?.roster || []) people.set('p' + r.personId, { key: 'p' + r.personId, name: r.name, pco: true, online: false });
  for (const u of users.values()) if (u.sockets.size) people.set(pk(u), { ...(people.get(pk(u)) || {}), key: pk(u), name: u.name, pco: !!u.pid, online: true });
  for (const key of Object.keys(nicks)) if (!people.has(key) && key.startsWith('p')) people.set(key, { key, name: '(osoba z Planning Center)', pco: true, online: false });
  res.json({ people: [...people.values()].map((x) => ({ ...x, nicks: getNicks(x.key) })).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, 'pl')) });
});
app.put('/api/admin/nicks', requireAdmin, (req, res) => {
  const key = String(req.body?.key || '');
  if (!/^[ps][\w-]{1,40}$/.test(key)) return res.status(400).json({ error: 'Nieprawidłowa osoba.' });
  res.json({ nicks: setNicks(key, req.body?.nicks) });
});

// Transmisje: połączenie z YouTube / Facebookiem (sprawdzanie, czy transmisja jest publiczna)
app.get('/api/admin/platforms', requireAdmin, (_req, res) => res.json(platforms.info()));
const platErr = (res, e) => res.status(400).json({ error: e.message });
app.post('/api/admin/platforms/youtube/start', requireAdmin, async (req, res) => {
  try { res.json(await platforms.ytStart(String(req.body?.clientId || ''), String(req.body?.clientSecret || ''))); } catch (e) { platErr(res, e); }
});
app.post('/api/admin/platforms/facebook/connect', requireAdmin, async (req, res) => {
  try { res.json({ pages: await platforms.fbConnect(String(req.body?.appId || ''), String(req.body?.appSecret || ''), String(req.body?.userToken || '')) }); } catch (e) { platErr(res, e); }
});
app.get('/api/admin/platforms/facebook/pages', requireAdmin, async (req, res) => {
  try { res.json({ pages: await platforms.fbPagesList(req.query.refresh === '1') }); } catch (e) { platErr(res, e); }
});
app.post('/api/admin/platforms/facebook/page', requireAdmin, (req, res) => {
  try { platforms.fbSelect(String(req.body?.pageId || '')); streams.wake('facebook'); res.json({ ok: true }); } catch (e) { platErr(res, e); }
});
app.post('/api/admin/platforms/:p/check', requireAdmin, async (req, res) => {
  const p = req.params.p === 'facebook' ? 'facebook' : 'youtube';
  if (!platforms.configured(p)) return res.status(400).json({ error: 'Najpierw połącz konto.' });
  res.json(await platforms.check(p));
});
app.post('/api/admin/platforms/:p/disconnect', requireAdmin, (req, res) => {
  if (req.params.p === 'facebook') platforms.fbDisconnect(); else platforms.ytDisconnect();
  res.json({ ok: true });
});

// Transmisje: token mostka
app.get('/api/admin/bridge', requireAdmin, (_req, res) => res.json({ token: bridgeToken() }));
app.post('/api/admin/bridge/token', requireAdmin, (_req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  saveJson(SECRETS_PATH, { ...readJson(SECRETS_PATH, {}), bridgeToken: token });
  console.log('[admin] nowy token mostka transmisji');
  res.json({ token });
});

// Transkrypcja: stan, zmiana modelu, test szybkości
async function sttCall(pathname, method = 'GET', body) {
  if (!STT_URL) throw new Error('Transkrypcja wyłączona.');
  const r = await fetch(STT_URL + pathname, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'GET' ? 3000 : 180000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `STT ${r.status}`);
  return j;
}
app.get('/api/admin/stt', requireAdmin, async (_req, res) => {
  try { res.json(await sttCall('/health')); } catch (e) { res.json({ ok: false, error: e.message.includes('fetch') ? 'usługa transkrypcji nie odpowiada' : e.message }); }
});
app.post('/api/admin/stt/model', requireAdmin, async (req, res) => {
  try { res.json(await sttCall('/model', 'POST', { name: req.body?.name })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/stt/settings', requireAdmin, async (req, res) => {
  try { res.json(await sttCall('/settings', 'POST', { quality: req.body?.quality })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/stt/hotwords', requireAdmin, (_req, res) => res.json({ hotwords: sttHotwords() }));
// ostatnie nagrania (pamięć usługi STT) – odsłuch i porównanie przy strojeniu jakości
app.get('/api/admin/stt/recent', requireAdmin, async (_req, res) => {
  try { res.json(await sttCall('/recent')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/stt/recent/:id/audio', requireAdmin, async (req, res) => {
  if (!STT_URL || !/^[a-z0-9]{1,20}$/.test(req.params.id)) return res.status(404).end();
  try {
    const r = await fetch(`${STT_URL}/recent/${req.params.id}/audio`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.status(404).end();
    res.type(r.headers.get('content-type') || 'audio/wav').send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});
app.post('/api/admin/stt/recent/:id/redo', requireAdmin, async (req, res) => {
  if (!/^[a-z0-9]{1,20}$/.test(req.params.id)) return res.status(400).end();
  try { res.json(await sttCall(`/recent/${req.params.id}/redo`, 'POST')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/stt/bench', requireAdmin, async (_req, res) => {
  try { res.json(await sttCall('/bench', 'POST')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Uprawnienia osób: speak/live = true (zawsze) | false (nigdy) | null (automatycznie)
function adminUserInfo(u) {
  const g = grantFor(u.sess || {});
  const autoR = autoRole(u.sess || {});
  return {
    ...publicUser(u), via: u.sess?.via || (u.sess?.pid ? 'roster' : 'pin'), persistent: !!u.sess?.pid,
    admin: { value: g.admin === true, viaPin: u.sess?.role === 'admin' },
    speak: { value: g.speak ?? null, auto: autoR === 'speaker' || autoR === 'admin', effective: u.role === 'speaker' || u.role === 'admin' },
    live: { value: g.live ?? null, auto: autoLive(u), effective: canControlLive(u), enabled: !!config.planningCenter?.liveControl?.enabled },
  };
}
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({
    users: [...users.values()].filter((u) => u.sockets.size > 0).map(adminUserInfo),
    grants: Object.entries(config.grants || {}).map(([pid, g]) => ({ pid, ...g, online: [...users.values()].some((u) => u.pid === pid && u.sockets.size) })),
    liveEnabled: !!config.planningCenter?.liveControl?.enabled && !!pco,
  });
});
app.post('/api/admin/grant', requireAdmin, (req, res) => {
  const norm = (v) => (v === true || v === false ? v : null);
  const { userId, pid: pidIn } = req.body || {};
  const u = userId ? users.get(String(userId)) : null;
  const pid = pidIn ? String(pidIn) : u?.sess?.pid || null;
  if (!u && !pid) return res.status(404).json({ error: 'Nie ma takiej osoby online.' });
  const patch = {};
  for (const k of ['speak', 'live', 'admin']) if (k in (req.body || {})) patch[k] = norm(req.body[k]);
  if (patch.admin === false) patch.admin = null; // „nie” = brak nadania (PIN administratora działa nadal)
  const merge = (g) => { const x = { ...g }; for (const [k, v] of Object.entries(patch)) { if (v === null) delete x[k]; else x[k] = v; } return x; };
  if (pid) {
    const next = structuredClone(config);
    const g = merge(next.grants?.[pid] || {});
    next.grants ||= {};
    if (g.speak === undefined && g.live === undefined && !g.admin) delete next.grants[pid];
    else next.grants[pid] = { ...g, name: g.name || u?.name || pid };
    config = validateConfig(next);
    saveJson(CONFIG_PATH, config);
  } else {
    const g = merge(sessionGrants.get(u.id) || {});
    if (g.speak === undefined && g.live === undefined && !g.admin) sessionGrants.delete(u.id); else sessionGrants.set(u.id, g);
  }
  applyGrants();
  console.log(`[admin] uprawnienia ${u?.name || pid}: ${JSON.stringify(patch)}`);
  res.json({ ok: true });
});

app.post('/api/admin/clear-chat', requireAdmin, (req, res) => {
  history.clear(); dms.clear();
  sttCall('/recent/clear', 'POST').catch(() => {}); // nagrania do strojenia też
  broadcast({ t: 'cleared', by: 'Administrator' });
  res.json({ ok: true });
});

// ---------- aplikacja natywna (iPhone / Android) ----------
// Dźwięk obsługuje w niej natywna biblioteka LiveKit, która działa też przy zablokowanym ekranie – wtedy strona
// (WebView) jest uśpiona. Dlatego to serwer mówi telefonowi, kogo ma słyszeć (lista „hear”), i wysyła mu powiadomienia –
// wszystko kanałem danych LiveKit. Telefon zgłasza się co ~20 s (/api/native/beat), a mówienie z przycisku Bluetooth
// zgłasza przez /api/native/ptt.
const natives = new Map(); // id sesji (= tożsamość w LiveKit) -> { key, at, voice, prog, hear }
const NATIVE_TTL = 70000;
const nativeActive = (id) => { const n = natives.get(id); return !!n && Date.now() - n.at < NATIVE_TTL; };
const nativeKeys = () => [...natives.values()].filter((n) => Date.now() - n.at < NATIVE_TTL).map((n) => n.key);
function sessionFrom(req) { return verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, '')); }
function nativeUser(s) { // użytkownik może nie mieć otwartej strony (telefon zablokowany) – utwórz wpis jak przy połączeniu
  let u = users.get(s.id);
  if (!u) {
    u = { id: s.id, sess: s, name: s.name, role: effective(s).role, pid: s.pid || null, listen: new Set(push.pref(sessionKey(s)).listen || []), target: broadcastId, talking: null, talkStart: 0, sockets: new Set() };
    users.set(s.id, u);
  }
  return u;
}
function hearFor(id, n) {
  if (n.voice === false) return n.prog ? [PROGRAM_ID] : [];
  const out = [];
  for (const t of users.values()) {
    if (!t.talking || t.id === id) continue;
    if (t.talkPeer) { if (t.talkPeer.key === n.key) out.push(t.id); continue; } // szept tylko do adresata
    if (listensTo(n.key, t.talking)) out.push(t.id);
  }
  if (n.prog && config.program?.enabled) out.push(PROGRAM_ID);
  return out;
}
function nativeSend(ids, obj) {
  if (!ids.length) return;
  lkAdmin.sendData(ROOM, Buffer.from(JSON.stringify(obj)), DataPacket_Kind.RELIABLE, { destinationIdentities: ids, topic: 'ik' }).catch(() => {});
}
function nativeHear(force) {
  for (const [id, n] of natives) {
    if (Date.now() - n.at > NATIVE_TTL) continue;
    const hear = hearFor(id, n), sig = hear.join(',');
    if (!force && sig === n.hear) continue;
    n.hear = sig;
    nativeSend([id], { t: 'hear', ids: hear, talking: hear.some((x) => x !== PROGRAM_ID) });
  }
}
let nativeHearT = null;
function nativeHearSoon() { if (!nativeHearT) nativeHearT = setTimeout(() => { nativeHearT = null; nativeHear(false); }, 20); }
setInterval(() => {
  nativeHear(true); // co jakiś czas pełna lista – na wypadek zgubionej wiadomości
  for (const [id, n] of natives) { // telefon przestał się zgłaszać (wyłączony, brak zasięgu) – rozłączony
    if (Date.now() - n.at < NATIVE_TTL) continue;
    natives.delete(id);
    const u = users.get(id);
    if (u && !u.sockets.size) { for (const ch of u.listen) announceMember(u, ch, 'gone'); u.listen = new Set(); }
    schedulePresence();
  }
}, 15000);
function nativeNotify(key, payload) {
  const ids = [...natives.entries()].filter(([, n]) => n.key === key && Date.now() - n.at < NATIVE_TTL).map(([id]) => id);
  nativeSend(ids, { t: 'notify', title: payload.title, body: payload.body, tag: payload.tag || '', vib: payload.vib || 'soft', urgent: !!payload.urgent });
}
app.post('/api/native/beat', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Sesja wygasła – otwórz aplikację i zaloguj się ponownie.' });
  const b = req.body || {}, prev = natives.get(s.id);
  const n = { key: sessionKey(s), at: Date.now(), voice: b.voice !== false, prog: !!b.prog, hear: prev?.hear ?? null };
  natives.set(s.id, n);
  const u = nativeUser(s);
  clearTimeout(u.goneTimer);
  push.touch(sessionKey(s), s.iat + SESSION_TTL_MS);
  if (!prev || prev.voice !== n.voice || prev.prog !== n.prog) n.hear = null; // ustawienia się zmieniły – wyślij listę od nowa
  if (!prev || Date.now() - prev.at > NATIVE_TTL) schedulePresence();
  nativeHearSoon();
  res.json({ ok: true, hear: hearFor(s.id, n), canTalk: ['speaker', 'admin'].includes(u.role), target: u.target, program: publicProgram() });
});
app.post('/api/native/ptt', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Sesja wygasła.' });
  const u = nativeUser(s);
  if (u.role !== 'speaker' && u.role !== 'admin') return res.status(403).json({ error: 'Nie masz prawa mówienia.' });
  if (req.body?.on) {
    const talkId = /^[a-z0-9]{4,32}$/i.test(req.body.talkId || '') ? req.body.talkId : crypto.randomBytes(6).toString('hex');
    const ch = req.body.channel && (channelIds.has(req.body.channel) || dmPeer(u, req.body.channel)) ? req.body.channel : u.target || broadcastId;
    if (!startTalkSrv(u, ch, talkId)) return res.status(400).json({ error: 'Nieznany kanał.' });
    return res.json({ ok: true, talkId, channel: ch });
  }
  if (u.talking) endTalk(u);
  res.json({ ok: true });
});
app.post('/api/native/bye', (req, res) => { const s = sessionFrom(req); if (s) natives.delete(s.id); res.json({ ok: true }); });

// ---------- dźwięk transmisji (program) ----------
// Komputer w kościele (wejście z konsolety, np. USB z Qu-SB) otwiera stronę /zrodlo z kluczem i nadaje stereo do LiveKit
// jako uczestnik „ik-program”. Każdy w aplikacji sam włącza odsłuch i ustawia głośność (przycisk 🎵).
const PROGRAM_ID = 'ik-program';
const programKey = () => readJson(SECRETS_PATH, {}).programKey || null;
const prog = { beat: 0, info: {}, live: false, cmd: null }; // cmd: zdalna zmiana z panelu (poziom, wyciszenie)
function publicProgram() { return { enabled: !!config.program?.enabled, name: config.program?.name || 'Dźwięk transmisji', duck: config.program?.duck ?? 30, id: PROGRAM_ID, lat: Date.now() - prog.beat < 10000 ? prog.info.lat || null : null, local: !!prog.src && config.program?.local !== false, muted: Date.now() - prog.beat < 10000 && !!prog.info.muted }; }
// ---- lokalny odsłuch: nadajnik w kościele sam wysyła dźwięk telefonom w tej samej sieci (WebRTC bezpośrednio) ----
// Serwer tylko pośredniczy w zestawieniu połączenia (kilka wiadomości); dźwięk nie przechodzi przez chmurę.
const plConns = new Map(); // id słuchacza -> ws
function programSocket(ws, key) {
  const k = programKey();
  if (!k || !key || key.length !== k.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(k))) { ws.close(4001, 'klucz'); return; }
  if (!config.program.enabled) { ws.close(4003, 'wyłączone'); return; }
  if (prog.src && prog.src !== ws) try { prog.src.close(4000, 'nowy nadajnik'); } catch {}
  prog.src = ws; ws.isAlive = true;
  send(ws, { t: 'bitrate', kbps: config.program.bitrate });
  ws.on('pong', () => { ws.isAlive = true; });
  console.log('[program] nadajnik gotowy do lokalnego odsłuchu');
  broadcast({ t: 'program', program: publicProgram() });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if ((m.t === 'plOffer' || m.t === 'plBye') && plConns.has(m.to)) send(plConns.get(m.to), { t: m.t, sdp: typeof m.sdp === 'string' ? m.sdp : undefined, fast: !!m.fast });
    if (m.t === 'ping') send(ws, { t: 'pong' });
  });
  ws.on('close', () => {
    if (prog.src !== ws) return;
    prog.src = null;
    broadcast({ t: 'program', program: publicProgram() });
  });
}
function kickProgram() { lkAdmin.removeParticipant(ROOM, PROGRAM_ID).catch(() => {}); try { prog.src?.close(4001, 'klucz'); } catch {} }
function programAuth(req) {
  const k = programKey(), got = String(req.body?.key || '');
  return !!(k && got && got.length === k.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(k)));
}
app.post('/api/program/join', async (req, res) => {
  if (!programAuth(req)) return res.status(401).json({ error: 'Nieprawidłowy klucz nadajnika – skopiuj nowy link z panelu (Transmisja → Dźwięk transmisji).' });
  if (!config.program.enabled) return res.status(403).json({ error: 'Dźwięk transmisji jest wyłączony w panelu administratora.' });
  if ((config.program.source === 'server') !== !!req.body?.server) return res.status(409).json({ error: config.program.source === 'server' ? 'Źródłem dźwięku jest teraz wejście audio serwera (panel → Transmisja). Ta strona nie jest potrzebna.' : 'Źródłem dźwięku jest strona nadajnika w przeglądarce.' });
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: PROGRAM_ID, name: config.program.name, ttl: '24h' });
  at.addGrant({ room: ROOM, roomJoin: true, canSubscribe: false, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false, canUpdateOwnMetadata: false });
  console.log(`[program] nadajnik połączony (${req.ip})`);
  res.json({ livekit: { url: LK_URL, token: await at.toJwt() }, name: config.program.name, org: config.orgName, bitrate: config.program.bitrate });
});
app.post('/api/program/beat', (req, res) => {
  if (!programAuth(req)) return res.status(401).json({ error: 'zły klucz' });
  const b = req.body || {};
  prog.beat = Date.now();
  const num = (x, a, z, d) => (Number.isFinite(Number(x)) ? Math.max(a, Math.min(z, Number(x))) : d);
  prog.info = { on: !!b.on, muted: !!b.muted, device: String(b.device || '').slice(0, 80), peak: Array.isArray(b.peak) ? b.peak.slice(0, 2).map((x) => num(x, 0, 1, 0)) : [], error: String(b.error || '').slice(0, 120),
    gain: num(b.gain, -24, 24, 0), route: String(b.route || '').slice(0, 60), nch: num(b.nch, 0, 64, 0), raw: !!b.raw, direct: !!b.direct, limiter: !!b.limiter, local: num(b.local, 0, 200, 0), localOn: !!prog.src,
    server: !!b.server, devices: Array.isArray(b.devices) ? b.devices.slice(0, 32).map((d) => ({ id: String(d?.id || '').slice(0, 120), name: String(d?.name || '').slice(0, 120), maxCh: num(d?.maxCh, 1, 64, 2) })) : undefined,
    lat: b.lat && typeof b.lat === 'object' ? { cap: num(b.lat.cap, 0, 2000, 0), proc: num(b.lat.proc, 0, 2000, 0), enc: num(b.lat.enc, 0, 200, 20), up: num(b.lat.up, 0, 5000, 0), total: num(b.lat.total, 0, 9000, 0), tcp: !!b.lat.tcp, relay: !!b.lat.relay } : null };
  if (!!prog.info.muted !== !!prog.sentMuted) { prog.sentMuted = !!prog.info.muted; broadcast({ t: 'program', program: publicProgram() }); } // wyciszenie widać w okienku 🎵
  // opóźnienie po stronie nadajnika – słuchacze doliczają je do swojego pomiaru (wysyłane przy zmianie)
  const l = prog.info.lat, sent = prog.sentLat;
  if (l && (!sent || Math.abs(l.total - sent.total) >= 8 || l.tcp !== sent.tcp) && Date.now() - (prog.sentAt || 0) > 4000) {
    prog.sentLat = l; prog.sentAt = Date.now();
    broadcast({ t: 'progLat', lat: l });
  }
  res.json({ ok: true, enabled: config.program.enabled, cmd: prog.cmd && prog.cmd.seq > Number(b.cmdSeq || 0) ? prog.cmd : null });
});
app.get('/api/admin/program', requireAdmin, async (_req, res) => {
  let published = null;
  try { const p = (await lkAdmin.listParticipants(ROOM)).find((x) => x.identity === PROGRAM_ID); published = p ? (p.tracks || []).some((t) => t.type === 0 || t.type === 'AUDIO') : false; } catch { /* LiveKit niedostępny */ }
  res.json({ ...publicProgram(), key: programKey(), beatAge: prog.beat ? Date.now() - prog.beat : null, info: prog.info, published, source: config.program.source, server: config.program.server });
});
app.post('/api/admin/program/control', requireAdmin, (req, res) => {
  const b = req.body || {}, cmd = { seq: Math.max((prog.cmd?.seq || 0) + 1, Date.now()) }; // numer = czas – nadajnik wykonuje tylko nowsze polecenia
  if (Number.isFinite(Number(b.gain))) cmd.gain = Math.max(-24, Math.min(24, Math.round(Number(b.gain) * 2) / 2));
  if (typeof b.muted === 'boolean') cmd.muted = b.muted;
  prog.cmd = cmd;
  if (prog.src) send(prog.src, { t: 'cmd', cmd }); // od razu, bez czekania na kolejny sygnał od nadajnika
  if (config.program.source === 'server' && (cmd.gain !== undefined || cmd.muted !== undefined)) { // zapamiętaj na serwerze
    const sv = { ...config.program.server, ...(cmd.gain !== undefined ? { gain: cmd.gain } : {}), ...(cmd.muted !== undefined ? { muted: cmd.muted } : {}) };
    config = validateConfig({ ...config, program: { ...config.program, server: sv } }); saveJson(CONFIG_PATH, config);
  }
  res.json({ ok: true, cmd });
});
// nadajnik na serwerze: wejście, kanały, poziom, ogranicznik, wł./wył. – zapis w konfiguracji + natychmiast do usługi audio
app.post('/api/admin/program/server', requireAdmin, (req, res) => {
  try {
    const sv = { ...config.program.server, ...(req.body?.server || {}) };
    config = validateConfig({ ...config, program: { ...config.program, server: sv } });
    saveJson(CONFIG_PATH, config);
    if (prog.src) send(prog.src, { t: 'set', server: config.program.server });
    res.json({ ok: true, server: config.program.server });
  } catch (e) { adminErr(res, e); }
});
app.post('/api/admin/program/scan', requireAdmin, (_req, res) => { if (prog.src) send(prog.src, { t: 'scan' }); res.json({ ok: true }); });
app.post('/api/admin/program/key', requireAdmin, (req, res) => {
  const key = crypto.randomBytes(18).toString('base64url');
  saveJson(SECRETS_PATH, { ...readJson(SECRETS_PATH, {}), programKey: key });
  kickProgram(); // stary link przestaje działać od razu
  console.log(`[admin] nowy klucz nadajnika dźwięku transmisji (${req.ip})`);
  res.json({ key });
});

// ---------- kopia ustawień (eksport / import) ----------
// Wszystko, co trzeba, żeby odtworzyć interkom na nowym serwerze: konfiguracja, klucze (Planning Center, YouTube,
// Facebook, mostek), ksywki, uprawnienia, klucze powiadomień i subskrypcje telefonów.
const BACKUP_DIRS = { config: path.dirname(CONFIG_PATH), data: DATA_DIR };
const BACKUP_NAME = /^[A-Za-z0-9._-]+\.json$/;
function backupFiles() {
  const files = {};
  for (const [tag, dir] of Object.entries(BACKUP_DIRS)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!BACKUP_NAME.test(n) || n.endsWith('.tmp.json')) continue;
      const v = readJson(path.join(dir, n), undefined);
      if (v !== undefined) files[`${tag}/${n}`] = v;
    }
  }
  // klucze Planning Center wpisane w instalatorze (.env) też trafiają do kopii – po wczytaniu działają z panelu
  const sec = files['config/secrets.json'] || {};
  if (!(sec.pcoAppId && sec.pcoSecret) && process.env.PCO_APP_ID && process.env.PCO_SECRET) {
    files['config/secrets.json'] = { ...sec, pcoAppId: process.env.PCO_APP_ID, pcoSecret: process.env.PCO_SECRET };
  }
  return files;
}
app.get('/api/admin/backup', requireAdmin, (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  console.log(`[admin] pobrano kopię ustawień (${req.ip})`);
  res.set('content-disposition', `attachment; filename="interkom-ustawienia-${day}.json"`);
  res.json({ app: 'interkom', kind: 'settings-backup', version: VERSION, created: new Date().toISOString(), files: backupFiles() });
});
app.post('/api/admin/restore', requireAdmin, express.json({ limit: '20mb' }), (req, res) => {
  try {
    const b = req.body;
    if (b?.app !== 'interkom' || b?.kind !== 'settings-backup' || !b.files || typeof b.files !== 'object') throw new ConfigError('To nie jest plik kopii ustawień Interkomu.');
    const todo = [];
    for (const [key, val] of Object.entries(b.files)) {
      const [tag, name, extra] = key.split('/');
      if (extra !== undefined || !BACKUP_DIRS[tag] || !BACKUP_NAME.test(name || '')) continue; // tylko pliki z naszej listy, bez ścieżek
      todo.push([path.join(BACKUP_DIRS[tag], name), val]);
    }
    const cfg = b.files['config/' + path.basename(CONFIG_PATH)];
    if (!cfg) throw new ConfigError('W kopii brakuje konfiguracji (config.json).');
    validateConfig(cfg); // błędna konfiguracja nie może zepsuć działającego serwera
    for (const [file, val] of todo) { fs.mkdirSync(path.dirname(file), { recursive: true }); saveJson(file, val); }
    console.log(`[admin] przywrócono kopię ustawień z ${b.created || '?'} (wersja ${b.version || '?'}, plików: ${todo.length}) – restart`);
    res.json({ ok: true, files: todo.length, restarting: true });
    setTimeout(() => process.exit(0), 600); // Docker uruchomi aplikację ponownie z przywróconymi ustawieniami
  } catch (e) { adminErr(res, e); }
});

// ---------- powiadomienia push ----------
const sessionKey = (s) => (s.pid ? 'p' + s.pid : 's' + s.id);
app.get('/api/push/key', (req, res) => { push.learnHost(req.get('host')); res.json({ publicKey: push.publicKey }); });
app.post('/api/push/subscribe', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).end();
  push.learnHost(req.get('host'));
  push.add(sessionKey(s), req.body?.subscription, s.iat + SESSION_TTL_MS);
  res.json({ ok: true, devices: (push.subs[sessionKey(s)] || []).length });
});
app.get('/api/push/prefs', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).end();
  res.json(push.pref(sessionKey(s)));
});
app.post('/api/push/prefs', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).end();
  push.setPrefs(sessionKey(s), req.body || {});
  res.json(push.pref(sessionKey(s)));
});
// wylogowanie: ten telefon przestaje dostawać powiadomienia (sesja przestaje działać po stronie aplikacji)
app.post('/api/push/logout', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.json({ ok: true });
  push.logout(sessionKey(s), String(req.body?.endpoint || '') || null);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).end();
  push.remove(sessionKey(s), String(req.body?.endpoint || ''));
  res.json({ ok: true });
});
app.post('/api/push/test', (req, res) => {
  const s = verifySession((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!s) return res.status(401).end();
  const key = sessionKey(s);
  if (!push.has(key)) return res.json({ ok: false, error: 'Serwer nie ma zapisanego tego telefonu – wyłącz i włącz powiadomienia ponownie.' });
  // po 5 s (czas na zablokowanie ekranu) wysyłamy i odpowiadamy wynikiem – telefon pokaże, czy Apple/Google przyjął
  setTimeout(async () => {
    const r = await push.send(key, { title: '🔔 Test interkomu', body: 'Powiadomienia działają.', tag: 'test', url: '/', vib: 'msg' });
    const bad = r.filter((x) => !x.ok);
    res.json({ ok: !bad.length, sent: r.length, error: bad.map((x) => x.error).join('; ') || null, subject: push.subject });
  }, 5000);
});

// Zdjęcie profilowe (tylko dla zalogowanych: ?s=<token sesji>)
app.get('/avatar/:pid', async (req, res) => {
  if (!verifySession(String(req.query.s || ''))) return res.status(401).end();
  const img = await avatars.get(String(req.params.pid));
  if (!img) return res.status(404).end();
  res.set('cache-control', 'private, max-age=86400').type(img.type).send(img.data);
});

// Certyfikat lokalnego CA Caddy – do instalacji na telefonach w trybie "bez domeny"
app.get('/ca.crt', (_req, res) => {
  if (!fs.existsSync(CADDY_ROOT_CA)) return res.status(404).send('Certyfikat CA niedostępny (tryb z domeną nie wymaga instalacji certyfikatu).');
  res.type('application/x-x509-ca-cert').attachment('interkom-ca.crt').send(fs.readFileSync(CADDY_ROOT_CA));
});

app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'livekit-client', 'dist'), { maxAge: '7d' }));
app.use('/vendor-opus', express.static(path.join(ROOT, 'node_modules', 'opus-decoder', 'dist'), { maxAge: '7d' })); // dekoder Opus (WASM) dla toru „ultra”
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 }); // opis połączenia WebRTC (lokalny odsłuch) ma kilka kB

wss.on('connection', (ws, req) => {
  if (isRemote(req) && config.remote?.enabled === false) { ws.close(4003, 'remote disabled'); return; }
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.has('program')) return programSocket(ws, url.searchParams.get('program'));
  const s = verifySession(url.searchParams.get('token'));
  if (!s) { ws.close(4001, 'unauthorized'); return; }

  const eff = effective(s);
  let u = users.get(s.id);
  if (u) { u.role = eff.role; u.sess = s; }
  if (!u) {
    u = { id: s.id, sess: s, name: s.name, role: eff.role, pid: s.pid || null, listen: new Set(), target: broadcastId, talking: null, talkStart: 0, sockets: new Set() };
    users.set(s.id, u);
  }
  u.sockets.add(ws);
  clearTimeout(u.goneTimer);
  push.touch(pk(u), s.iat + SESSION_TTL_MS); // jest w aplikacji – jego telefon może dostawać powiadomienia
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'perm', ...perms(u) });
  for (const x of users.values()) if (x.wPeer === pk(u) && x.sockets.size) send(ws, { t: 'wtarget', user: x.id, on: true });
  send(ws, { t: 'hello', users: presence(), history: [...history.all(), ...dmHistoryFor(u)], you: publicUser(u), channels, plan: pco ? pco.publicPlan() : null, streams: streams.list(), program: publicProgram() });
  const pend = pendingCalls.get(pk(u));
  if (pend && Date.now() - pend.ts < 90000) send(ws, pend); else pendingCalls.delete(pk(u));
  schedulePresence();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    // błąd przy obsłudze jednej wiadomości nie może wyłączyć całego serwera
    try { handle(u, m, ws); } catch (e) { console.error(`[błąd] obsługa „${m?.t}” od ${u.name}:`, e); }
  });
  ws.on('close', () => {
    u.sockets.delete(ws);
    if (ws._pl) { plConns.delete(ws._pl); if (prog.src) send(prog.src, { t: 'plBye', id: ws._pl }); }
    push.touch(pk(u)); // od tej chwili liczy się okno aktywności (np. zablokowany telefon w trakcie nabożeństwa)
    if (u.sockets.size === 0 && u.talking) endTalk(u);
    // telefony często na chwilę tracą Wi-Fi – rozłączenie ogłaszamy dopiero po 30 s bez powrotu
    if (u.sockets.size === 0) {
      clearTimeout(u.goneTimer);
      u.goneTimer = setTimeout(() => {
        if (u.sockets.size || nativeActive(u.id)) return; // aplikacja na telefonie w tle – nadal słucha
        for (const ch of u.listen) announceMember(u, ch, 'gone');
        u.listen = new Set();
      }, 30000);
    }
    schedulePresence();
  });
});

function handle(u, m, ws) {
  switch (m.t) {
    case 'listen': {
      const list = Array.isArray(m.channels) ? m.channels.filter((c) => channelIds.has(c)) : [];
      const before = u.listen;
      u.listen = new Set([broadcastId, ...list]); // kanał ogólny (wywoławczy) słyszą wszyscy – nie da się go wyłączyć
      for (const ch of u.listen) if (!before.has(ch)) announceMember(u, ch, 'join');
      for (const ch of before) if (!u.listen.has(ch)) announceMember(u, ch, 'leave');
      schedulePresence();
      nativeHearSoon();
      break;
    }
    case 'target': {
      if (!channelIds.has(m.channel) && !dmPeer(u, m.channel)) return;
      u.target = m.channel;
      setWhisperTarget(u, m.channel);
      schedulePresence();
      break;
    }
    case 'msg': {
      const text = String(m.text || '').trim().slice(0, 500);
      if (!text) return;
      const peer = dmPeer(u, m.channel);
      if (peer) { dmPost(u, peer, { type: 'text', from: u.id, fromName: u.name, fromPid: u.pid || null, text }); return; }
      if (!channelIds.has(m.channel)) return;
      const men = resolveMentions(text, m.mentions);
      post({ type: 'text', channel: m.channel, from: u.id, fromName: u.name, fromPid: u.pid || null, text, ...(men.mentions.length ? { mentions: men.mentions } : {}), ...(men.mentionAll ? { mentionAll: true } : {}) });
      const chName = channels.find((c) => c.id === m.channel)?.name || m.channel;
      const tagged = new Set(men.mentions.filter((k) => k !== pk(u)));
      if (men.mentionAll) for (const k of push.keys()) if (k !== pk(u) && listensTo(k, m.channel)) tagged.add(k);
      // oznaczeni dostają powiadomienie zawsze (także gdy nie słuchają kanału), chyba że wyłączyli „oznaczenia”
      for (const k of tagged) if (push.pref(k).mentions) notifyPush(k, { title: `@ ${u.name} oznacza Cię · ${chName}`, body: text, tag: 'mention-' + m.channel, url: '/', vib: 'urgent' });
      notifyWho((p, key) => p.channels && listensTo(key, m.channel) && !tagged.has(key), { title: `💬 ${u.name} · ${chName}`, body: text, tag: 'ch-' + m.channel, url: '/', vib: 'msg' }, pk(u));
      break;
    }
    case 'quick': {
      const q = config.quick.find((x) => x.key === m.key);
      if (!q) return;
      const peer = dmPeer(u, m.channel);
      if (peer) { dmPost(u, peer, { type: 'quick', from: u.id, fromName: u.name, fromPid: u.pid || null, text: q.label, key: q.key, tone: q.tone, urgent: !!q.urgent }); return; }
      if (!channelIds.has(m.channel)) return;
      post({ type: 'quick', channel: m.channel, from: u.id, fromName: u.name, fromPid: u.pid || null, text: q.label, key: q.key, tone: q.tone, urgent: !!q.urgent });
      notifyChannel(pk(u), m.channel, q.urgent ? `🚨 ${q.label}` : `⚡ ${q.label}`, u.name, { urgent: !!q.urgent });
      break;
    }
    case 'ptt': {
      if (u.role !== 'speaker' && u.role !== 'admin') return;
      if (m.on) startTalkSrv(u, m.channel, m.talkId);
      else if (u.talking) endTalk(u);
      break;
    }
    case 'pttSeg': { // długie nadawanie (np. kłódka): telefon wykrył przerwę w mowie – zamknij fragment do transkrypcji, nadawanie trwa dalej
      if (!u.talking || !/^[a-z0-9]{4,32}$/i.test(m.talkId || '') || m.talkId === u.talkId) return;
      const now = Date.now();
      postVoice(u, u.talking, u.talkPeer, now - u.talkStart, u.talkId, true);
      u.talkId = m.talkId; u.talkStart = now;
      break;
    }
    case 'clear': {
      if (u.role !== 'admin') return;
      history.clear(); dms.clear();
      sttCall('/recent/clear', 'POST').catch(() => {});
      broadcast({ t: 'cleared', by: u.name });
      break;
    }
    case 'planCurrent': { // ręczne ustawienie bieżącego punktu (gdy nikt nie prowadzi PC Live)
      if (!pco || !perms(u).manualPlan) return;
      if (pco.setCurrentManually(String(m.itemId))) broadcastPlan();
      break;
    }
    case 'liveStep': liveCommand(u, ws, () => pco.liveStep(m.dir > 0 ? 1 : -1)); break;
    case 'liveGoto': liveCommand(u, ws, () => pco.liveGoto(String(m.itemId))); break;
    case 'pcoPlans': {
      if (!pco || u.role !== 'admin') return;
      send(ws, { t: 'pcoPlans', plans: pco.state.upcoming || [], selected: pco.state.plan?.id || null, manual: !!pco.state.manualPlan });
      break;
    }
    case 'pcoSelect': {
      if (!pco || u.role !== 'admin') return;
      pco.selectPlan(m.planId ? String(m.planId) : null).then(() => send(ws, { t: 'pcoPlans', plans: pco.state.upcoming || [], selected: pco.state.plan?.id || null, manual: !!pco.state.manualPlan }));
      break;
    }
    case 'pcoRefresh': {
      if (!pco || u.role !== 'admin') return;
      pco.reloadStructure().then(() => pco.refresh());
      break;
    }
    // ---- moderacja: wyciszenie i przeniesienie innej osoby, transkrypcja osoby / kanału ----
    case 'modMute': {
      if (!canModerate(u)) return send(ws, { t: 'modDone', ok: false, text: 'Nie masz uprawnień do wyciszania innych.' });
      const to = users.get(String(m.to));
      if (!to || to.id === u.id) return;
      if (to.talking) endTalk(to);
      forceMuteMic(to.id);
      const note = { t: 'modMuted', by: u.name };
      for (const s2 of to.sockets) send(s2, note);
      nativeSend([to.id], { t: 'forceMute', by: u.name });
      notifyPush(pk(to), { title: '🔇 Wyciszono Twój mikrofon', body: `${u.name} wyłączył(a) Twoje mówienie – mikrofon był włączony.`, tag: 'mute', urgent: true, url: '/' });
      send(ws, { t: 'modDone', ok: true, text: `🔇 Wyciszono: ${to.name}` });
      console.log(`[moderacja] ${u.name} wyciszył(a) ${to.name}`);
      break;
    }
    case 'modMove': {
      if (!canModerate(u)) return send(ws, { t: 'modDone', ok: false, text: 'Nie masz uprawnień do przenoszenia innych.' });
      const to = users.get(String(m.to)), ch = String(m.channel || '');
      if (!to || !channelIds.has(ch)) return;
      const wasTalking = !!to.talking;
      if (to.talking) endTalk(to);
      to.target = ch;
      if (!to.listen.has(ch)) { to.listen.add(ch); announceMember(to, ch, 'join'); }
      const chName = config.channels.find((c) => c.id === ch)?.name || ch;
      const note = { t: 'modMoved', by: u.name, channel: ch, wasTalking };
      for (const s2 of to.sockets) send(s2, note);
      nativeSend([to.id], { t: 'moveTo', channel: ch, by: u.name });
      notifyPush(pk(to), { title: `↪ Przeniesiono Cię na kanał ${chName}`, body: `${u.name}: mówisz teraz na kanał ${chName}.`, tag: 'move', urgent: true, url: '/' });
      schedulePresence(); nativeHearSoon();
      send(ws, { t: 'modDone', ok: true, text: `↪ ${to.name} → ${chName}` });
      console.log(`[moderacja] ${u.name} przeniósł(a) ${to.name} na ${chName}`);
      break;
    }
    case 'sttUser': { // transkrypcja wypowiedzi danej osoby – tylko administrator
      if (u.role !== 'admin') return;
      const to = users.get(String(m.to));
      const key = to ? pk(to) : String(m.key || ''), name = to ? to.name : String(m.name || '');
      if (!/^[ps][\w-]{1,40}$/.test(key)) return;
      const list = (config.sttOffUsers || []).filter((x) => x.key !== key && !(to && !to.pid && x.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl')));
      if (m.off) list.push({ key, name });
      config = validateConfig({ ...config, sttOffUsers: list }); saveJson(CONFIG_PATH, config);
      sendPerms(); schedulePresence();
      send(ws, { t: 'modDone', ok: true, text: `📝 Transkrypcja ${m.off ? 'wyłączona' : 'włączona'}: ${name}` });
      break;
    }
    case 'sttChan': { // transkrypcja na kanale – tylko administrator
      if (u.role !== 'admin' || !channelIds.has(String(m.channel))) return;
      const ch = String(m.channel), off = new Set(config.sttOff || []);
      if (m.off) off.add(ch); else off.delete(ch);
      const next = validateConfig({ ...config, sttOff: [...off] });
      saveJson(CONFIG_PATH, next); applyConfig(next);
      send(ws, { t: 'modDone', ok: true, text: `📝 Transkrypcja na kanale ${config.channels.find((c) => c.id === ch)?.name || ch}: ${m.off ? 'wyłączona' : 'włączona'}` });
      break;
    }
    case 'call': { // wezwanie konkretnej osoby
      const to = users.get(String(m.to));
      if (!to || to.id === u.id || (!to.sockets.size && !push.has(pk(to)) && !nativeActive(to.id))) return send(ws, { t: 'callStatus', ok: false, error: 'Ta osoba nie jest teraz połączona.' });
      if (Date.now() - (u.lastCall || 0) < 3000) return;
      u.lastCall = Date.now();
      const callId = crypto.randomBytes(5).toString('hex');
      const text = String(m.text || '').trim().slice(0, 140);
      const call = { t: 'call', callId, from: { id: u.id, name: u.name, pid: u.pid || null }, text, ts: Date.now() };
      for (const s2 of to.sockets) send(s2, call);
      pendingCalls.set(pk(to), call); // gdyby aplikacja była w tle – dostarczymy po powrocie
      notifyPush(pk(to), { title: `📣 Wezwanie: ${u.name}`, body: text || 'wzywa Cię', tag: 'call-' + callId, urgent: true, vib: 'call', url: '/' });
      send(ws, { t: 'callStatus', ok: true, callId, to: to.name });
      console.log(`[wezwanie] ${u.name} → ${to.name}${text ? ': ' + text : ''}`);
      break;
    }
    case 'callReply': {
      pendingCalls.delete(pk(u));
      const to = users.get(String(m.to));
      if (!to) return;
      const answer = m.answer === 'yes' ? 'yes' : 'no';
      for (const s2 of to.sockets) send(s2, { t: 'callReply', callId: String(m.callId || ''), from: { id: u.id, name: u.name }, answer });
      break;
    }
    case 'vis': u.hidden = !!m.hidden; push.touch(pk(u)); break;
    case 'plReq': // telefon chce słuchać transmisji prosto z nadajnika w sieci kościoła
      if (!prog.src || config.program?.local === false) { send(ws, { t: 'plBye' }); break; }
      ws._pl ||= 'L' + crypto.randomBytes(6).toString('hex');
      plConns.set(ws._pl, ws);
      send(prog.src, { t: 'plReq', id: ws._pl, name: u.name, fast: !!m.fast });
      break;
    case 'plAnswer': if (ws._pl && prog.src && typeof m.sdp === 'string') send(prog.src, { t: 'plAnswer', id: ws._pl, sdp: m.sdp }); break;
    case 'plBye': if (ws._pl) { if (prog.src) send(prog.src, { t: 'plBye', id: ws._pl }); plConns.delete(ws._pl); } break;
    case 'nicks': send(ws, { t: 'nicks', nicks: setNicks(pk(u), m.nicks) }); break;
    case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
  }
}

// Informacja techniczna na kanale: kto dołączył / opuścił / rozłączył się
function announceMember(u, channel, kind) {
  if (!channelIds.has(channel)) return;
  const text = { join: 'dołączył(a) do kanału', leave: 'opuścił(a) kanał', gone: 'rozłączył(a) się' }[kind];
  post({ type: 'member', kind, channel, from: u.id, fromName: u.name, fromPid: u.pid || null, text });
}

function startTalkSrv(u, channel, talkId) {
  const peer = dmPeer(u, channel);
  if (!channelIds.has(channel) && !peer) return false;
  if (u.talking) endTalk(u);
  u.talking = channel; u.target = channel; u.talkStart = Date.now();
  u.talkPeer = peer;
  u.talkId = /^[a-z0-9]{4,32}$/i.test(talkId || '') ? talkId : null;
  if (peer) { setWhisperTarget(u, channel); pttDm(u, peer, true); }
  else broadcast({ t: 'ptt', user: u.id, name: u.name, channel, on: true });
  schedulePresence();
  nativeHearSoon();
  return true;
}
// Wyciszenie mikrofonu w LiveKit od strony serwera – działa nawet wtedy, gdy telefon/przeglądarka nie zareaguje na wiadomość
async function forceMuteMic(identity) {
  try {
    const p = (await lkAdmin.listParticipants(ROOM)).find((x) => x.identity === identity);
    for (const t of p?.tracks || []) if ((t.type === 0 || t.type === 'AUDIO') && !t.muted) await lkAdmin.mutePublishedTrack(ROOM, identity, t.sid, true);
  } catch (e) { console.warn('[moderacja] wyciszenie w LiveKit:', e.message); }
}
function endTalk(u) {
  const ch = u.talking;
  u.talking = null;
  const peer = u.talkPeer; u.talkPeer = null;
  if (peer) pttDm(u, peer, false);
  else broadcast({ t: 'ptt', user: u.id, name: u.name, channel: ch, on: false });
  postVoice(u, ch, peer, Date.now() - u.talkStart, u.talkId);
  u.talkId = null;
  schedulePresence();
  nativeHearSoon();
}

// Wpis w czacie o wypowiedzi (lub jej fragmencie), żeby czytający wiedzieli, że padła – w wersji ze STT z transkrypcją
function postVoice(u, ch, peer, dur, talkId, part = false) {
  if (dur < 600) return;
  const sttOn = !!(talkId && sttEnabledFor(ch, !!peer, u));
  const id = talkId ? voiceMsgId(u.id, talkId) : undefined;
  const vm = { id, type: 'voice', from: u.id, fromName: u.name, fromPid: u.pid || null, durationMs: dur, text: '', stt: sttOn ? 'pending' : 'off', ...(part ? { part: true } : {}) };
  if (peer) dmPost(u, peer, vm); else post({ ...vm, channel: ch });
  if (!peer && !sttOn) notifyChannel(pk(u), ch, `🎙 ${u.name}`, `mówił(a) ${Math.round(dur / 1000)} s`);
  // gdyby nagranie nie dotarło – nie zostawiaj „transkrypcja…” na zawsze
  if (sttOn) setTimeout(() => { const m = history.get(id) || dmFind(id); if (m?.stt === 'pending') { console.warn(`[stt] ${u.name}: nagranie nie dotarło w 150 s`); updateMsg(id, { stt: 'failed', sttError: 'nagranie nie dotarło' }); } }, 150000);
}

const voiceMsgId = (uid, talkId) => `v_${uid}_${talkId}`;
function updateMsg(id, patch) {
  const m = history.update(id, patch);
  if (m) { broadcast({ t: 'msgUpdate', m }); return m; }
  const d = dmFind(id);
  if (d) { Object.assign(d, patch); dmDeliver('msgUpdate', d); }
  return d;
}
// szept: sygnał „mówi” tylko do nadawcy i odbiorcy
function pttDm(u, peer, on) {
  for (const ws of u.sockets) send(ws, { t: 'ptt', user: u.id, name: u.name, channel: 'dm:' + peer.key, on, whisper: true });
  for (const x of usersByKey(peer.key)) for (const ws of x.sockets) send(ws, { t: 'ptt', user: u.id, name: u.name, channel: 'dm:' + pk(u), on, whisper: true });
}

function post(msg) {
  const full = { ...msg, id: msg.id || crypto.randomBytes(6).toString('hex'), ts: Date.now() };
  history.add(full);
  broadcast({ t: 'msg', m: full });
}

// utrzymanie połączeń (telefony potrafią „zniknąć” bez zamknięcia gniazda)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

process.on('uncaughtException', (e) => console.error('[błąd – serwer działa dalej]', e));
process.on('unhandledRejection', (e) => console.error('[błąd – serwer działa dalej]', e));
startPco();
streams.configure(config.streams);
ppConfigure();

// Odliczanie punktu: sygnał przy ostatniej minucie i przy przekroczeniu (wibracja w aplikacji + push dla chętnych)
const timerSent = new Set();
setInterval(() => {
  const p = pco?.state?.plan;
  if (!p?.currentItemId || !p.currentStartedAt) return;
  const cur = p.items.find((x) => x.id === p.currentItemId);
  if (!cur?.length) return;
  const left = cur.length - (Date.now() - p.currentStartedAt) / 1000;
  const fire = (kind, title) => {
    const k = `${p.id}|${cur.id}|${p.currentStartedAt}|${kind}`;
    if (timerSent.has(k)) return;
    timerSent.add(k); if (timerSent.size > 200) timerSent.clear();
    broadcast({ t: 'timer', kind, title: cur.title });
    notifyWho((pr) => pr.timer, { title, body: cur.title, tag: 'timer', url: '/', vib: 'timer' });
  };
  if (left <= 0 && left > -120) fire('over', '⏰ Przekroczony czas punktu');
  else if (left <= 60 && left > 0 && cur.length > 120 && cur.length - left > 15) fire('minute', '⏳ Ostatnia minuta punktu'); // nie przy punkcie dopiero co rozpoczętym
}, 2000);

server.listen(PORT, HOST, () => {
  console.log(`Interkom ${VERSION} nasłuchuje na http://${HOST}:${PORT} (kanały: ${[...channelIds].join(', ')})`);
});
