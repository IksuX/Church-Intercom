// Interkom – klient (PWA). Tekst + szybkie przyciski przez WebSocket, głos przez LiveKit (WebRTC).
import { Room, RoomEvent, Track } from '/vendor/livekit-client.esm.mjs';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// Aplikacja natywna (iPhone / Android, Capacitor): dźwięk, mówienie i przyciski Bluetooth obsługuje kod natywny,
// który działa także przy zablokowanym ekranie. Strona zostaje taka sama – zmienia się tylko „silnik” głosu.
const NAT = window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.IkAudio || null : null;
if (NAT) document.documentElement.classList.add('native');
const store = {
  get(k, d) { try { const v = localStorage.getItem('ik.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ik.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ik.' + k); } catch {} },
};

const S = {
  session: null, me: null, channels: [], quick: [], broadcast: null,
  users: new Map(), talking: new Map(), // userId -> channel
  msgs: new Map(), unread: new Map(), urgent: new Set(),
  active: null, listen: new Set(),
  opt: Object.assign({ voice: true, tts: false, vibrate: true, wake: true, sttShow: 'always' }, store.get('opt', {})),
  ws: null, wsTries: 0, room: null, micPub: null, pttOn: false, pttLocked: false,
};
const canTalk = () => S.me && (S.me.role === 'speaker' || S.me.role === 'admin');
// Rozmowy prywatne to pseudo-kanały „dm:<klucz osoby>”
const isDm = (id) => typeof id === 'string' && id.startsWith('dm:');
S.dms = new Map(); S.wtarget = new Set();
const chan = (id) => {
  if (isDm(id)) { const d = S.dms.get(id.slice(3)); return d ? { id, name: '💬 ' + d.name, color: '#38bdf8', dm: true, pid: d.pid } : null; }
  return S.channels.find((c) => c.id === id);
};
const listening = (ch) => S.listen.has(ch) || isDm(ch);
// „moja” wiadomość: z tej sesji albo (osoby z Planning Center) z mojego konta na innym urządzeniu
const isMine = (m) => m.from === S.me.id || (!!m.fromKey && m.fromKey === S.myKey);
function ensureDm(key, name, pid) {
  const d = S.dms.get(key) || { key, name: name || '?', pid: pid || null };
  if (name) d.name = name;
  if (pid) d.pid = pid;
  d.hidden = false;
  S.dms.set(key, d);
  return d;
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ================= LOGOWANIE =================
// Konto Planning Center (tożsamość potwierdzona) albo PIN ekipy + imię (goście, zastępstwa).
$('#fPin').value = store.get('pin', '');
$('#fName').value = store.get('name', '');
$('#stepManual').hidden = false; $('#speakerBox').hidden = false; $('#loginBtn').textContent = 'Dołącz';
async function join(body) {
  unlockAudio();
  $('#loginErr').textContent = '';
  try {
    const r = await fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: $('#fPin').value, rolePin: $('#fRolePin').value, ...body }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Błąd logowania');
    store.set('pin', $('#fPin').value); store.set('name', body.name);
    store.set('token', j.token);
    start(j);
  } catch (err) { $('#loginErr').textContent = err.message; }
}
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#fName').value.trim();
  if (!name) { $('#loginErr').textContent = 'Podaj imię.'; return; }
  join({ name });
});

// Powrót z logowania przez Planning Center: #session=… albo #loginError=…
(function handleHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('session')) store.set('token', h.get('session'));
  if (h.get('loginError')) $('#loginErr').textContent = h.get('loginError');
  if (h.has('session') || h.has('loginError')) history.replaceState(null, '', location.pathname);
})();
// przyciski pobrania aplikacji (linki ustawia administrator: Ogólne → Aplikacja na telefon); w samej aplikacji ukryte
function appBadge(url, kind) {
  const ios = kind === 'ios', tf = /testflight\.apple\.com/i.test(url), play = /play\.google\.com/i.test(url);
  const small = ios ? (tf ? 'Pobierz przez' : 'Pobierz z') : play ? 'Pobierz z' : 'Pobierz na';
  const big = ios ? (tf ? 'TestFlight' : 'App Store') : play ? 'Google Play' : 'Androida (APK)';
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>' + (ios ? '' : '<path d="M12 7v6m-2.5-2.5L12 13l2.5-2.5"/>') + '</svg>';
  return `<a class="app-badge" href="${esc(url)}" target="_blank" rel="noopener">${icon}<span><small>${small}</small><b>${big}</b></span></a>`;
}
function renderAppLinks(apps) {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let list = [apps?.ios && ['ios', apps.ios], apps?.android && ['android', apps.android]].filter(Boolean);
  if (/Android/i.test(navigator.userAgent)) list = list.filter((x) => x[0] === 'android').concat(list.filter((x) => x[0] !== 'android'));
  else if (isIOS) list = list.filter((x) => x[0] === 'ios').concat(list.filter((x) => x[0] !== 'ios'));
  for (const id of ['#appLinks', '#appLinksSet']) {
    const box = $(id); if (!box) continue;
    box.hidden = NAT != null || !list.length;
    box.innerHTML = list.length ? `<p class="al-h">📱 Aplikacja na telefon – rozmowy także przy zablokowanym ekranie</p><div class="al-row">${list.map(([k, u]) => appBadge(u, k)).join('')}</div>` : '';
  }
}
// wygląd ustawiony przez administratora: kolor przewodni (też z /branding.css) i logo
function applyBrand(b) {
  if (!b) return;
  if (b.accent) {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(b.accent.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    document.documentElement.style.setProperty('--accent', b.accent);
    document.documentElement.style.setProperty('--accent-fg', 0.2126 * r + 0.7152 * g + 0.0722 * bl > 0.45 ? '#111' : '#fff');
  }
  const hd = $('#orgLogo');
  hd.innerHTML = b.logo ? logoHtml(b, 90, 26) : ''; hd.hidden = !b.logo;
  $('#loginLogo').innerHTML = b.logo ? logoHtml(b, 220, 96) : '🎧';
}
// logo w oryginalnych kolorach (<img>) albo przekolorowane: kształt logo jako maska wypełniona kolorem
function logoHtml(b, maxW, maxH) {
  // SVG bez width/height nie ma własnego rozmiaru – wymiary liczymy z proporcji (podaje je serwer)
  if (!b.ratio) return `<img src="${esc(b.logo)}" alt="" style="height:${maxH}px;width:auto;max-width:${maxW}px">`;
  const h = Math.min(maxH, maxW / b.ratio), w = h * b.ratio;
  if (!b.logoColor) return `<img src="${esc(b.logo)}" alt="" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px">`;
  return `<span class="logo-tint" role="img" style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;background:${esc(b.logoColor)};--logo:url('${esc(b.logo)}')"></span>`;
}
fetch('/api/login-options').then((r) => r.json()).then((o) => {
  $('#pcoLoginBox').hidden = !o.pcoLogin;
  if (o.org) $('#loginTitle').textContent = o.org;
  applyBrand(o.brand || { logo: o.logo });
  renderAppLinks(o.apps);
  // spoza sieci kościoła: bez logowania PIN-em (chyba że administrator pozwolił) – tylko konto Planning Center
  S.pinLogin = o.pinLogin !== false;
  if (!S.pinLogin) {
    for (const id of ['#stepPin', '#stepManual', '#speakerBox', '#loginBtn']) $(id).hidden = true;
    $('#fPin').required = false;
    const n = $('#remoteNote'); n.hidden = false;
    n.textContent = o.pcoLogin ? '🌐 Łączysz się spoza sieci kościoła – zaloguj się kontem Planning Center.'
      : '🌐 Łączysz się spoza sieci kościoła. Dostęp zdalny wymaga logowania kontem Planning Center, które nie jest jeszcze włączone – skontaktuj się z administratorem.';
  }
}).catch(() => {});

async function tryResume() {
  const token = store.get('token');
  if (!token) return;
  try {
    const r = await fetch('/api/session', { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) throw 0;
    start(await r.json(), true);
  } catch { store.del('token'); }
}

// ================= START =================
function start(sess, resumed = false) {
  S.session = sess; S.me = sess.me; S.channels = sess.channels; S.quick = sess.quick; S.broadcast = sess.broadcastChannel;
  document.title = sess.org;
  $('#orgName').textContent = sess.org;
  applyBrand(sess.brand);
  $('#ver').textContent = 'Wersja ' + sess.version;
  const savedListen = store.get('listen:' + S.me.id, null) || sess.defaultListen || store.get('listen', null);
  S.listen = new Set((savedListen || [S.broadcast]).filter((id) => chan(id)));
  if (!S.listen.size) S.listen.add(S.broadcast);
  S.active = sess.defaultListen ? null : store.get('active', null);
  if (!chan(S.active)) S.active = [...S.listen].find((c) => c !== S.broadcast) || S.broadcast;
  $('#login').hidden = true; $('#main').hidden = false;
  $('#pttRow').hidden = !canTalk(); document.body.classList.toggle('can-talk', canTalk());
  $('#adminBox').hidden = S.me.role !== 'admin';
  $('#pcoAdmin').hidden = !(sess.pco && S.me.role === 'admin');
  $('#adminLink').hidden = S.me.role !== 'admin';
  $('#elevateBox').hidden = S.me.role === 'admin' || S.pinLogin === false;
  renderPush(); ensurePush(false).catch(() => {});
  $('#optPlanRow').hidden = !sess.pco;
  $('#meLine').textContent = `${S.me.name} · ${roleName(S.me.role)}`;
  renderTabs(); renderQuick(); renderFeed(); renderSettings(); applyLayout(); loadPushPrefs();
  connectWs();
  connectVoice();
  applyWake();
  if (resumed) showAudioHintIfNeeded();
}
const roleName = (r) => ({ admin: 'administrator (mówi)', speaker: 'mówiący', listener: 'słucha / czyta' }[r] || r);

// ================= WEBSOCKET =================
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.session.token)}`);
  S.ws = ws;
  setConn();
  ws.onopen = () => {
    S.wsTries = 0; setConn();
    wsSend({ t: 'listen', channels: [...S.listen] });
    wsSend({ t: 'vis', hidden: document.hidden });
    wsSend({ t: 'target', channel: S.active });
  };
  ws.onmessage = (e) => onWs(JSON.parse(e.data));
  ws.onclose = (e) => {
    setConn();
    if (e.code === 4001) { store.del('token'); location.reload(); return; }
    const delay = Math.min(10000, 500 * 2 ** S.wsTries++);
    setTimeout(connectWs, delay);
  };
}
const wsSend = (o) => { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); return true; } return false; };

function onWs(m) {
  switch (m.t) {
    case 'hello':
      S.myKey = m.you?.key || null;
      if (m.channels) applyChannels(m.channels);
      if (m.plan) setPlan(m.plan, false);
      S.msgs.clear();
      for (const x of m.history) { if (isDm(x.channel)) ensureDm(x.channel.slice(3), x.peerName, x.peerPid); addMsg(x, false); }
      setUsers(m.users);
      setStreams(m.streams || []);
      setProgCfg(m.program);
      renderFeed(); renderTabs();
      break;
    case 'presence': setUsers(m.users); break;
    case 'wtarget': if (m.on) S.wtarget.add(m.user); else S.wtarget.delete(m.user); updateGates(); break;
    case 'channels': applyChannels(m.channels); break;
    case 'plan': S.session.pco = !m.disabled; $('#optPlanRow').hidden = !S.session.pco; setPlan(m, true); if (splitOn() !== !!S.session.pco) applyLayout(); break;
    case 'config': // administrator zmienił ustawienia w panelu
      S.quick = m.quick; S.broadcast = m.broadcastChannel;
      S.session.sttOff = m.sttOff || []; S.session.sttDm = m.sttDm !== false;
      document.title = m.org; $('#orgName').textContent = m.org; applyBrand(m.brand);
      renderQuick(); setProgCfg(m.program);
      break;
    case 'pcoPlans': renderPcoPlans(m); break;
    case 'role': { // administrator zmienił prawo mówienia
      const could = canTalk();
      S.me.role = m.role; nativeSync();
      $('#meLine').textContent = `${S.me.name} · ${roleName(S.me.role)}`;
      $('#pttRow').hidden = !canTalk(); document.body.classList.toggle('can-talk', canTalk());
      $('#adminBox').hidden = $('#adminLink').hidden = S.me.role !== 'admin';
      $('#elevateBox').hidden = S.me.role === 'admin' || S.pinLogin === false;
      if (canTalk() && !could) { setTimeout(() => prepareMic(), 500); sysMsg('Administrator dał Ci prawo mówienia.'); }
      if (!canTalk() && could) { S.pttLocked = false; stopTalk(); stopCapture(); S.micPub = null; sysMsg('Administrator odebrał Ci prawo mówienia.'); }
      break;
    }
    case 'call': showCall(m); break;
    case 'modDone': toast({ channel: S.broadcast, fromName: m.ok ? '✔' : '⚠️', text: m.text, plan: true, urgent: !m.ok }); if (!$('#sheetPeople').hidden) renderPeople(); break;
    case 'modMuted': onModMuted(m.by); break;
    case 'modMoved': onModMoved(m.channel, m.by, m.wasTalking); break;
    case 'callStatus': toast({ channel: S.broadcast, fromName: m.ok ? '📣 Wezwanie' : '⚠️', text: m.ok ? `wysłane do: ${m.to}` : m.error, plan: true, urgent: !m.ok }); break;
    case 'callReply': toast({ channel: S.broadcast, fromName: m.answer === 'yes' ? '✓ ' + m.from.name : '✗ ' + m.from.name, text: m.answer === 'yes' ? 'idzie' : 'nie może teraz', plan: true, urgent: m.answer !== 'yes' }); vibrate(m.answer === 'yes' ? 60 : [200, 100, 200]); break;
    case 'perm': S.perm = m; renderPlanBar(); if (!$('#sheetPlan').hidden) renderPlanSheet(); break;
    case 'liveError': liveDone(); toast({ channel: S.broadcast, fromName: '⚠️ Plan', text: m.error, plan: true, urgent: true }); break;
    case 'msgUpdate': updateMsg(m.m); break;
    case 'msg': addMsg(m.m, true); break;
    case 'nicks': $('#optNicks').value = (m.nicks || []).join(', '); sysMsg(m.nicks?.length ? `Twoje ksywki: ${m.nicks.map((n) => '@' + n).join(', ')}` : 'Usunięto ksywki.'); break;
    case 'timer':
      if (!S.pushPrefs?.timer) break;
      vibrate(m.kind === 'over' ? [250, 120, 250, 120, 700] : [250, 120, 250]);
      toast({ channel: S.broadcast, fromName: m.kind === 'over' ? '⏰ Przekroczony czas' : '⏳ Ostatnia minuta', text: m.title, plan: true, urgent: m.kind === 'over' });
      if (S.opt.planTts !== false && m.kind === 'minute') say('Ostatnia minuta.');
      break;
    case 'streams': setStreams(m.list || []); break;
    case 'progLat': prog.cfg.lat = m.lat; renderProgLat(); break;
    case 'program': setProgCfg(m.program); break;
    case 'plOffer': progLocalOffer(m.sdp, m.fast).catch((e) => progLocalFail('offer: ' + e.message)); break;
    case 'plBye': progLocalFail('bye'); break;
    case 'ptt':
      if (m.on) S.talking.set(m.user, m.channel); else S.talking.delete(m.user);
      const u = S.users.get(m.user); if (u) u.target = m.channel;
      updateGates(); renderTalkNow(); renderTabs();
      if (!$('#sheetPeople').hidden) renderPeople();
      break;
    case 'cleared':
      S.msgs.clear(); S.unread.clear(); S.urgent.clear(); S.dms.clear();
      if (isDm(S.active)) S.active = S.broadcast;
      addMsg({ id: 'c' + Date.now(), type: 'system', channel: S.active, ts: Date.now(), text: `Czat wyczyszczony przez: ${m.by}` }, false);
      renderFeed(); renderTabs();
      break;
  }
}

function setUsers(list) {
  S.users = new Map(list.map((u) => [u.id, u]));
  const whisper = [...S.talking].filter(([, ch]) => isDm(ch)); // szepty nie są widoczne w obecności – zachowaj
  S.talking = new Map([...list.filter((u) => u.talking).map((u) => [u.id, u.talking]), ...whisper]);
  $('#onlineCount').textContent = list.length;
  updateGates(); renderTalkNow(); renderTabs();
  if (!$('#sheetPeople').hidden) renderPeople();
}

// ================= WIADOMOŚCI =================
function addMsg(m, live) {
  if (isDm(m.channel)) ensureDm(m.channel.slice(3), m.peerName, m.peerPid);
  const arr = S.msgs.get(m.channel) || [];
  if (arr.some((x) => x.id === m.id)) return;
  arr.push(m); S.msgs.set(m.channel, arr);
  if (!live) return;
  const mine = isMine(m);
  const colFeeds = [...document.querySelectorAll('.xfeed')].filter((f) => f.dataset.ch === m.channel);
  colFeeds.forEach((f) => appendMsgEl(m, true, f));
  if (m.type === 'member') { if (m.channel === S.active) appendMsgEl(m); return; } // bez dźwięku, wibracji i licznika
  const tagged = mentionsMe(m);
  if (m.channel === S.active) appendMsgEl(m);
  else if (colFeeds.length) { /* widoczny w kolumnie – bez licznika nieprzeczytanych */ }
  else if (!mine && (listening(m.channel) || tagged)) {
    S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
    if (m.urgent || tagged) S.urgent.add(m.channel);
    renderTabs();
  }
  if (tagged) { // ktoś mnie oznaczył – jak wezwanie, tylko lżej
    beep(); vibrate([200, 100, 200, 100, 200]);
    toast({ ...m, urgent: true, fromName: '@ ' + m.fromName });
    if (S.opt.tts || S.opt.voice) say(`${m.fromName} do Ciebie: ${m.text.replace(/@[\p{L}\p{N}_.-]+\s*/gu, '')}`);
    return;
  }
  if (mine || !listening(m.channel)) return;
  if (m.type === 'voice') return;
  if (m.urgent) { beep(); vibrate([300, 100, 300, 100, 300]); }
  else vibrate(80);
  if ((m.channel !== S.active && !shownInCol(m.channel)) || document.hidden) toast(m);
  speak(m);
}

// Transkrypcja dotarła później niż sama wypowiedź – podmień wpis w miejscu.
function updateMsg(m) {
  const arr = S.msgs.get(m.channel) || [];
  const i = arr.findIndex((x) => x.id === m.id);
  if (i >= 0) arr[i] = m; else { arr.push(m); S.msgs.set(m.channel, arr); }
  document.querySelectorAll(`[data-mid="${CSS.escape(m.id)}"]`).forEach((el) => el.replaceWith(msgEl(m))); // także w kolumnach
  if (m.stt === 'done' && showStt() && m.from !== S.me.id && listening(m.channel) && (m.channel !== S.active || document.hidden)) {
    toast({ ...m, text: '🎙 ' + m.text });
  }
}

// ---- @oznaczenia ----
const normH = (x) => String(x || '').toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
const myHandles = () => [S.me?.name?.split(/\s+/)[0], ...(S.users.get(S.me?.id)?.nicks || [])].filter(Boolean).map(normH);
const mentionsMe = (m) => !isMine(m) && ((m.mentions || []).includes(S.myKey) || (m.mentionAll && listening(m.channel)));
function fmtMentions(text) {
  const mine = myHandles();
  return esc(text).replace(/@([\p{L}\p{N}_.-]{2,30})/gu, (all, h) => {
    const n = normH(h).replace(/[.]+$/, '');
    return `<span class="mention ${n === 'wszyscy' || mine.includes(n) ? 'me' : ''}">${all}</span>`;
  });
}

function fillFeed(feed, ch) {
  feed.innerHTML = '';
  const arr = S.msgs.get(ch) || [];
  if (!arr.length) feed.innerHTML = `<div class="empty">Brak wiadomości na kanale <b>${esc(chan(ch)?.name || '')}</b>.</div>`;
  for (const m of arr) appendMsgEl(m, false, feed);
  feed.scrollTop = feed.scrollHeight;
}
function renderFeed() {
  fillFeed($('#feed'), S.active);
  renderCols();
}

// ---- kilka kanałów obok siebie (tablet, komputer): kolumna 1 = kanał, na który mówisz; pozostałe = podgląd ----
const colsWide = window.matchMedia('(min-width: 700px)');
const colsN = () => (colsWide.matches ? Math.max(1, Math.min(4, Number(S.opt.cols) || 1)) : 1);
const colChoices = () => [...S.channels.map((c) => ({ id: c.id, name: c.name })), ...[...S.dms.values()].filter((d) => !d.hidden).map((d) => ({ id: 'dm:' + d.key, name: '💬 ' + d.name }))];
function colChannels() { // kanały kolumn podglądu – bez powtórzeń i bez kanału głównego
  const n = colsN() - 1, ok = new Set(colChoices().map((c) => c.id));
  const want = (S.opt.colCh || []).filter((id) => ok.has(id) && id !== S.active);
  const out = [];
  for (const id of want) if (!out.includes(id) && out.length < n) out.push(id);
  for (const c of [...[...S.listen].filter((x) => ok.has(x)), ...colChoices().map((c) => c.id)]) if (out.length < n && c !== S.active && !out.includes(c)) out.push(c);
  return out;
}
const shownInCol = (ch) => colsN() > 1 && colChannels().includes(ch);
function renderCols() {
  const box = $('#feeds');
  const extra = colChannels();
  document.body.classList.toggle('cols', extra.length > 0);
  const head = $('#mainHead');
  head.hidden = !extra.length;
  if (extra.length) { const c = chan(S.active); head.style.setProperty('--c', c?.color || '#38bdf8'); head.innerHTML = `<b>${esc(c?.name || '')}</b> · mówisz tutaj`; }
  box.querySelectorAll('.fcol.extra').forEach((el) => el.remove());
  extra.forEach((ch, i) => {
    const col = document.createElement('section');
    col.className = 'fcol extra';
    const c = chan(ch);
    col.innerHTML = `<div class="colhead" style="--c:${esc(c?.color || '#38bdf8')}"><select aria-label="Kanał w kolumnie ${i + 2}">${colChoices().map((o) => `<option value="${esc(o.id)}" ${o.id === ch ? 'selected' : ''} ${o.id === S.active ? 'disabled' : ''}>${esc(o.name)}</option>`).join('')}</select><button type="button" class="xx" title="Mów na tym kanale">🎙</button><button type="button" class="xx" title="Zamknij kolumnę">✕</button></div><div class="feed xfeed" data-ch="${esc(ch)}" aria-live="polite"></div>`;
    const [sel, talk, close] = [col.querySelector('select'), ...col.querySelectorAll('button')];
    sel.onchange = () => { const list = colChannels(); list[i] = sel.value; S.opt.colCh = list; store.set('opt', S.opt); S.unread.delete(sel.value); renderCols(); renderTabs(); };
    talk.onclick = () => setActive(ch);
    close.onclick = () => { const list = colChannels(); list.splice(i, 1); S.opt.colCh = list; S.opt.cols = colsN() - 1; store.set('opt', S.opt); if ($('#optCols')) $('#optCols').value = String(S.opt.cols); renderCols(); };
    box.appendChild(col);
    fillFeed(col.querySelector('.xfeed'), ch);
    S.unread.delete(ch); S.urgent.delete(ch);
  });
  markColTalking();
}
function markColTalking() {
  const talkingCh = new Set(S.talking.values());
  $('#mainHead')?.classList.toggle('talking', talkingCh.has(S.active));
  document.querySelectorAll('.fcol.extra').forEach((col) => col.querySelector('.colhead')?.classList.toggle('talking', talkingCh.has(col.querySelector('.xfeed')?.dataset.ch)));
}
colsWide.addEventListener?.('change', () => renderCols());

function appendMsgEl(m, scroll = true, feed = $('#feed')) {
  feed.querySelector('.empty')?.remove();
  const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const mine = isMine(m);
  if (m.type === 'member') {
    // kolejne informacje o wejściach/wyjściach łączą się w jedną linię; szybki powrót (np. po wygaszeniu ekranu) znika
    let g = feed.lastElementChild;
    if (!g?._mg || m.ts - g._mg.ts > 10 * 60000) {
      g = document.createElement('div'); g.className = 'msg member'; g._mg = { ts: m.ts, who: new Map() };
      feed.appendChild(g);
    }
    const prev = g._mg.who.get(m.fromName);
    if ((prev === 'gone' || prev === 'leave') && m.kind === 'join') g._mg.who.delete(m.fromName);
    else g._mg.who.set(m.fromName, m.kind);
    g._mg.last = m.ts;
    renderMemberGroup(g);
    if (scroll && near) feed.scrollTop = feed.scrollHeight;
    return;
  }
  feed.appendChild(msgEl(m));
  if (scroll && (near || mine)) feed.scrollTop = feed.scrollHeight;
}
function renderMemberGroup(g) {
  const by = { join: [], leave: [], gone: [] };
  for (const [n, k] of g._mg.who) by[k]?.push(n);
  const many = (arr, one, more) => `<b>${arr.map(esc).join(', ')}</b> ${arr.length > 1 ? more : one}`;
  const parts = [
    by.join.length && `➕ ${many(by.join, 'dołączył(a)', 'dołączyli')}`,
    by.leave.length && `➖ ${many(by.leave, 'opuścił(a) kanał', 'opuścili kanał')}`,
    by.gone.length && `⏏ ${many(by.gone, 'rozłączył(a) się', 'rozłączyli się')}`,
  ].filter(Boolean);
  g.hidden = !parts.length;
  g.innerHTML = `${parts.join(' · ')} · ${fmtTime(g._mg.last)}`;
}
// Awatar: zdjęcie z Planning Center albo kółko z inicjałami
function initials(name) { return String(name || '?').trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'; }
function hue(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function initialsEl(name) { return `<span class="av ini" style="--h:${hue(name)}">${esc(initials(name))}</span>`; }
function avatar(pid, name) {
  if (!pid) return initialsEl(name);
  return `<img class="av" src="/avatar/${encodeURIComponent(pid)}?s=${encodeURIComponent(S.session.token)}" alt="" loading="lazy" data-name="${esc(name)}">`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.classList.contains('av')) img.outerHTML = initialsEl(img.dataset.name);
}, true);

function msgEl(m) {
  const el = document.createElement('div');
  const mine = isMine(m);
  if (m.id) el.dataset.mid = m.id;
  el.className = `msg ${m.type} ${mine ? 'mine' : ''} ${m.urgent ? 'urgent' : ''} ${m.tone ? 'tone-' + m.tone : ''}`;
  if (m.type === 'system') el.textContent = m.text;
  else if (m.type === 'stream') { el.classList.add('k-' + m.kind); el.innerHTML = `${esc(m.text)} <span class="st-time">· ${fmtTime(m.ts)}</span>`; }
  else if (m.type === 'member') el.innerHTML = `${{ join: '➕', leave: '➖', gone: '⏏' }[m.kind] || '•'} <b>${esc(m.fromName)}</b> ${esc(m.text)} · ${fmtTime(m.ts)}`;
  else if (m.type === 'plan') {
    el.innerHTML = `<div class="pl-now2"><span class="pl-tag">▶ TERAZ</span> <b>${esc(m.nowTitle)}</b>${m.nowMeta ? ` <span class="pm">${esc(m.nowMeta)}</span>` : ''}</div>`
      + (m.nextTitle ? `<div class="pl-next2">Następnie: ${esc(m.nextTitle)}${m.nextMeta ? ` · ${esc(m.nextMeta)}` : ''}</div>` : '')
      + myNotes(m).map((n) => `<div class="pnote mine"><b>${esc(n.category)}:</b> ${esc(n.text)}</div>`).join('')
      + `<div class="pl-time">${fmtTime(m.ts)}</div>`;
    el.onclick = () => openSheet('plan');
  }
  else if (m.type === 'voice') {
    const sec = Math.max(1, Math.round(m.durationMs / 1000));
    const low = typeof m.sttConf === 'number' && m.sttConf < 0.5;
    const tr = !showStt() ? ''
      : m.stt === 'done' && m.text ? `<div class="text ${low ? 'lowconf' : ''}">${low ? '≈ ' : ''}„${esc(m.text)}”${low ? ' <span class="stt">(niepewne)</span>' : ''}</div>`
      : m.stt === 'pending' && Date.now() - m.ts < 125000 ? '<div class="stt">transkrypcja…</div>'
      : m.stt === 'empty' ? '<div class="stt">(nie rozpoznano słów)</div>'
      : m.stt === 'failed' ? `<div class="stt">(transkrypcja nieudana${m.sttError ? ': ' + esc(m.sttError) : ''})</div>` : '';
    el.innerHTML = `<div class="vline">${avatar(m.fromPid, m.fromName)}<span>🎙 <b>${esc(m.fromName)}</b> mówił(a) ${sec} s${m.part ? ' (fragment)' : ''} · ${fmtTime(m.ts)}</span></div>${tr}`;
  } else {
    el.innerHTML = `<div class="meta">${mine ? '' : avatar(m.fromPid, m.fromName)}<span class="who">${esc(m.fromName)}</span><span>${fmtTime(m.ts)}</span></div><div class="text">${fmtMentions(m.text)}</div>`;
  }
  return el;
}

let toastTimer;
function toast(m) {
  const c = chan(m.channel);
  const t = $('#toast');
  t.className = 'toast' + (m.urgent ? ' urgent' : '');
  t.style.setProperty('--c', c?.color);
  t.innerHTML = m.plan ? `<b>${esc(m.fromName)}:</b> ${esc(m.text)}`
    : isDm(m.channel) ? `<b>💬 ${esc(m.fromName)}</b> (prywatnie): ${esc(m.text)}`
    : `<b>${esc(c?.name)}</b> · ${esc(m.fromName)}: ${esc(m.text)}`;
  t.hidden = false;
  t.onclick = () => { t.hidden = true; if (m.plan) openSheet('plan'); else setActive(m.channel); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), m.urgent ? 10000 : 4000);
}

// ================= ZAKŁADKI / KANAŁY =================
function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  const talkingCh = new Set(S.talking.values());
  for (const c of S.channels) {
    const b = document.createElement('button');
    b.className = 'tab' + (S.listen.has(c.id) ? '' : ' muted') + (talkingCh.has(c.id) ? ' talking' : '');
    b.style.setProperty('--c', c.color);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', c.id === S.active);
    const n = S.unread.get(c.id);
    b.innerHTML = esc(c.name) + (n ? `<span class="badge ${S.urgent.has(c.id) ? 'urgent' : ''}">${n}</span>` : '');
    b.onclick = () => setActive(c.id);
    tabs.appendChild(b);
  }
  for (const d of S.dms.values()) {
    const id = 'dm:' + d.key;
    if (d.hidden && id !== S.active) continue;
    const b = document.createElement('button');
    const talking = [...S.talking.entries()].some(([uid, ch]) => ch === id && uid !== S.me.id);
    b.className = 'tab dmtab' + (talking ? ' talking' : '');
    b.style.setProperty('--c', '#38bdf8');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', id === S.active);
    const n = S.unread.get(id);
    b.innerHTML = `${avatar(d.pid, d.name)} ${esc(d.name)}` + (n ? `<span class="badge ${S.urgent.has(id) ? 'urgent' : ''}">${n}</span>` : '')
      + (id === S.active ? '<span class="dmclose" title="Zamknij rozmowę">✕</span>' : '');
    b.onclick = (e) => {
      if (e.target.classList.contains('dmclose')) { d.hidden = true; setActive(S.broadcast); return; }
      setActive(id);
    };
    tabs.appendChild(b);
  }
  tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  markColTalking();
}
function setActive(id) {
  if (S.pttOn) stopTalk();
  const cols = colChannels(), at = cols.indexOf(id);
  if (at >= 0 && S.active && S.active !== id) { cols[at] = S.active; S.opt.colCh = cols; store.set('opt', S.opt); } // zamiana kolumn
  S.active = id; store.set('active', id);
  S.unread.delete(id); S.urgent.delete(id);
  wsSend({ t: 'target', channel: id });
  renderTabs(); renderFeed(); renderPttLabel();
  $('#msgInput').placeholder = `Napisz do: ${chan(id).name}…`;
}

function renderQuick() {
  const q = $('#quickBar');
  q.innerHTML = '';
  for (const x of S.quick) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = x.label; b.className = 'tone-' + (x.tone || 'info');
    b.onclick = () => { wsSend({ t: 'quick', channel: S.active, key: x.key }); vibrate(30); };
    q.appendChild(b);
  }
  $('#msgInput').placeholder = `Napisz do: ${chan(S.active).name}…`;
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (mention.open && mention.items.length) { pickMention(mention.items[mention.sel]); return; } // Enter wybiera z listy
  const i = $('#msgInput');
  const text = i.value.trim();
  if (!text) return;
  // osoby wybrane z listy (rozróżnia np. dwie Kasie); wysyłamy tylko te, których @ nadal jest w tekście
  const ids = [...mention.picked].filter(([h]) => new RegExp('@' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'u').test(text)).map(([, id]) => id);
  wsSend({ t: 'msg', channel: S.active, text, mentions: ids });
  i.value = ''; mention.picked.clear(); closeMention();
});
const mention = { open: false, items: [], sel: 0, start: 0, picked: new Map() };
const handleOf = (u) => (u.nicks?.[0] || u.name.split(/\s+/)[0]).replace(/\s+/g, '_');
function closeMention() { mention.open = false; $('#mentionBox').hidden = true; }
function updateMention() {
  const i = $('#msgInput'), pos = i.selectionStart ?? i.value.length;
  const m = /(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u.exec(i.value.slice(0, pos));
  if (!m) return closeMention();
  const q = normH(m[2]);
  const people = [...S.users.values()].filter((u) => u.id !== S.me.id)
    .map((u) => ({ u, keys: [u.name, ...(u.nicks || [])].map(normH) }))
    .filter((x) => !q || x.keys.some((k) => k.startsWith(q) || k.split(/[\s_-]+/).some((w) => w.startsWith(q))))
    .slice(0, 8).map((x) => ({ id: x.u.id, handle: handleOf(x.u), label: x.u.name, sub: (x.u.nicks || []).map((n) => '@' + n).join(' '), pid: x.u.pid }));
  if (!isDm(S.active) && 'wszyscy'.startsWith(q)) people.push({ id: 'all', handle: 'wszyscy', label: 'wszyscy', sub: 'cały kanał ' + (chan(S.active)?.name || '') });
  if (!people.length) return closeMention();
  Object.assign(mention, { open: true, items: people, sel: 0, start: pos - m[2].length - 1 });
  const box = $('#mentionBox');
  box.innerHTML = people.map((p, n) => `<button type="button" role="option" data-n="${n}" class="${n === 0 ? 'sel' : ''}">${p.id === 'all' ? '<span class="av ini" style="--h:210">@</span>' : avatar(p.pid, p.label)}<span class="mn"><b>${esc(p.label)}</b>${p.sub ? `<small>${esc(p.sub)}</small>` : ''}</span></button>`).join('');
  box.hidden = false;
  box.querySelectorAll('button').forEach((b) => (b.onpointerdown = (e) => { e.preventDefault(); pickMention(mention.items[Number(b.dataset.n)]); }));
}
function pickMention(p) {
  const i = $('#msgInput'), pos = i.selectionStart ?? i.value.length;
  const ins = '@' + p.handle + ' ';
  i.value = i.value.slice(0, mention.start) + ins + i.value.slice(pos);
  const c = mention.start + ins.length; i.setSelectionRange(c, c); i.focus();
  if (p.id !== 'all') mention.picked.set(p.handle, p.id);
  closeMention();
}
$('#msgInput').addEventListener('input', updateMention);
$('#msgInput').addEventListener('keydown', (e) => {
  if (!mention.open) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
    $$('#mentionBox button').forEach((b, n) => b.classList.toggle('sel', n === mention.sel));
  } else if (e.key === 'Tab') { e.preventDefault(); pickMention(mention.items[mention.sel]); }
  else if (e.key === 'Escape') closeMention();
});
$('#msgInput').addEventListener('blur', () => setTimeout(closeMention, 150));

// ================= URZĄDZENIA AUDIO (wybór mikrofonu i głośnika) =================
const volLevel = () => (typeof S.opt.vol === 'number' ? S.opt.vol : 100) / 100;
// Redukcja echa przeglądarki = systemowa obróbka rozmowy (macOS: Voice Processing, Windows: tryb komunikacji), która
// na czas mówienia ŚCISZA MUZYKĘ I FILMY W INNYCH PROGRAMACH – tego nie da się wyłączyć z poziomu strony. Na komputerze
// (zwykle słuchawki) domyślnie wyłączona; na telefonie (głośnik przy uchu) włączona.
const ecOn = () => (typeof S.opt.ec === 'boolean' ? S.opt.ec : !isDesktopUA());
function micConstraints() {
  return {
    ...(S.opt.micId ? { deviceId: S.opt.micId } : {}),
    echoCancellation: ecOn(), noiseSuppression: S.opt.ns !== false, autoGainControl: S.opt.agc !== false,
  };
}
const canPickOutput = () => 'setSinkId' in HTMLMediaElement.prototype;
async function renderDevices() {
  await resolveDevices();
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const opt = (d, i, kind) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${kind} ${i + 1}`)}</option>`;
  const ins = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const outs = devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  $('#micBox').hidden = !canTalk();
  $('#boomBox').hidden = !!NAT; // w aplikacji mikrofon obsługuje część natywna – tam w kolejnej wersji
  $('#optBoom').checked = !!S.opt.boom; renderBoom();
  $('#micRelRow').hidden = $('#micRelHint').hidden = !!NAT;
  $('#optMicRel').checked = micRelease(); $('#optMicRel').disabled = !!S.opt.boom;
  const mic = $('#optMic');
  mic.innerHTML = '<option value="">Domyślny systemowy</option>' + ins.filter((d) => d.deviceId !== 'default').map((d, i) => opt(d, i, 'Mikrofon')).join('');
  mic.value = ins.some((d) => d.deviceId === S.opt.micId) ? S.opt.micId : '';
  const showOut = canPickOutput() && outs.length > 0;
  $('#spkRow').hidden = !showOut; $('#spkHint').hidden = showOut || !isIOS;
  const spk = $('#optSpk');
  spk.innerHTML = '<option value="">Domyślny systemowy</option>' + outs.filter((d) => d.deviceId !== 'default').map((d, i) => opt(d, i, 'Wyjście')).join('');
  spk.value = outs.some((d) => d.deviceId === S.opt.spkId) ? S.opt.spkId : '';
  // bez zgody na mikrofon (albo ze zgodą „tylko tym razem” i zamkniętym mikrofonem) przeglądarka zwraca okrojoną listę:
  // po jednym urządzeniu bez nazwy – wtedy proponujemy chwilowe otwarcie mikrofonu, które odsłania wszystkie urządzenia
  const limited = devs.some((d) => (d.kind === 'audiooutput' || d.kind === 'audioinput') && !d.label);
  const pickable = !!navigator.mediaDevices?.selectAudioOutput; // Firefox: wyjścia tylko przez systemowe okno wyboru
  $('#devMoreRow').hidden = !(limited || pickable);
  $('#devMore').hidden = !limited;
  $('#devMoreHint').hidden = !limited;
  $('#spkPick').hidden = !pickable;
  if (pickable && !showOut && canPickOutput()) $('#spkRow').hidden = false;
  for (const [id, k] of [['#optEc', 'ec'], ['#optNs', 'ns'], ['#optAgc', 'agc']]) $(id).checked = k === 'ec' ? ecOn() : S.opt[k] !== false;
  renderMixer();
}
// Zmiana mikrofonu / przetwarzania: LiveKit podmienia ścieżkę, zachowując wyciszenie (nikt nie zacznie nadawać przypadkiem)
async function applyMic() {
  store.set('opt', S.opt);
  if (S.room) S.room.options.audioCaptureDefaults = micConstraints();
  const tr = S.micPub?.track;
  if (!tr) return;
  try {
    const c = micConstraints();
    await tr.restartTrack({ ...c, ...(c.deviceId ? { deviceId: { exact: c.deviceId } } : {}) });
    if (actx) await ensureCapture(); // kopia do transkrypcji i wskaźnik poziomu – z nowego mikrofonu (zamykana po wyjściu z ustawień)
    $('#micHint').textContent = '✓ Mikrofon przełączony. Mów – pasek powinien się ruszać.';
  } catch (err) {
    sysMsg('Nie udało się przełączyć mikrofonu: ' + (err?.message || err));
    S.opt.micId = ''; store.set('opt', S.opt); renderDevices();
  }
}
// Web Audio (transmisja – także „ultra”, sygnały, podgląd) gra przez AudioContext, nie przez elementy <audio>:
// wybrane wyjście trzeba ustawić także na nim, i to za każdym razem, gdy kontekst powstaje
let ctxSinkFor = null;
function applyCtxSink() {
  if (!actx?.setSinkId) return;
  const want = S.opt.spkId || '';
  if (ctxSinkFor === want) return;
  ctxSinkFor = want;
  actx.setSinkId(want).catch((err) => { ctxSinkFor = null; console.warn('wyjście dźwięku (Web Audio)', err); });
}
async function applySpeaker() {
  store.set('opt', S.opt);
  const id = S.opt.spkId || 'default';
  try { await S.room?.switchActiveDevice('audiooutput', id); } catch (err) { console.warn(err); }
  for (const el of document.querySelectorAll('audio[data-pid], audio[data-prog], #spkTest')) el.setSinkId?.(id).catch(() => {});
  ctxSinkFor = null; applyCtxSink();
}
// Przeglądarki (zwłaszcza Safari) potrafią zmienić identyfikator urządzenia po ponownym uruchomieniu – zapamiętujemy też
// nazwę i po niej odnajdujemy urządzenie. Inaczej przeglądarka po cichu brała domyślne i wybór „nie działał”.
async function resolveDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  let changed = false;
  for (const [kind, idK, labK] of [['audioinput', 'micId', 'micLabel'], ['audiooutput', 'spkId', 'spkLabel']]) {
    if (!S.opt[idK]) continue;
    const list = devs.filter((d) => d.kind === kind);
    if (!list.length || list.every((d) => !d.label)) continue; // bez zgody na mikrofon nazwy są puste – nie da się sprawdzić
    if (list.some((d) => d.deviceId === S.opt[idK])) continue;
    const m = S.opt[labK] && list.find((d) => d.label === S.opt[labK]);
    if (m) { S.opt[idK] = m.deviceId; changed = true; }
  }
  if (changed) { store.set('opt', S.opt); if (S.room) S.room.options.audioCaptureDefaults = micConstraints(); }
}
$('#optMicRel').onchange = (e) => { S.opt.micRelease = e.target.checked; store.set('opt', S.opt); applyMicRelease(); if (!$('#sheet').hidden) micPreview(); };
const devLabel = (sel) => sel.selectedOptions?.[0]?.textContent || '';
$('#optMic').onchange = (e) => { S.opt.micId = e.target.value; S.opt.micLabel = e.target.value ? devLabel(e.target) : ''; applyMic(); };
$('#devMore').onclick = async () => {
  const b = $('#devMore'); b.disabled = true;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    await renderDevices(); // lista z nazwami – póki mikrofon jest otwarty
    st.getTracks().forEach((t) => t.stop());
  } catch (err) { sysMsg('Bez zgody na mikrofon przeglądarka nie pokaże listy urządzeń (' + (err?.message || err) + ').'); }
  b.disabled = false;
};
$('#spkPick').onclick = async () => {
  try {
    const d = await navigator.mediaDevices.selectAudioOutput();
    S.opt.spkId = d.deviceId; S.opt.spkLabel = d.label || '';
    await renderDevices(); $('#optSpk').value = d.deviceId; applySpeaker();
  } catch {}
};
$('#optSpk').onchange = (e) => { S.opt.spkId = e.target.value; S.opt.spkLabel = e.target.value ? devLabel(e.target) : ''; applySpeaker(); };
for (const [id, k] of [['#optEc', 'ec'], ['#optNs', 'ns'], ['#optAgc', 'agc']]) $(id).onchange = (e) => { S.opt[k] = e.target.checked; applyMic(); };
// ================= MIKSER (głośności na tym urządzeniu) =================
// Głosy, dźwięk transmisji, komunikaty czytane na głos (plan, wiadomości, transmisja) i sygnały – każdy z suwakiem i wyciszeniem.
const pct = (v, d) => (typeof v === 'number' ? v : d);
const MIX = [
  { k: 'voice', ic: '🎙', name: 'Głosy',
    vol: () => pct(S.opt.vol, 100), muted: () => S.opt.voice === false,
    setVol: (v) => { S.opt.vol = v; for (const el of document.querySelectorAll('audio[data-pid]:not([data-prog])')) el.volume = volLevel(); nativeSync(); },
    setMute: (m) => { S.opt.voice = !m; $('#optVoice').checked = !m; updateGates(); renderFeed(); nativeSync(); } },
  { k: 'prog', ic: '🎵', name: 'Transmisja', na: () => !prog.cfg.enabled,
    vol: () => progVolPct(), muted: () => !S.opt.progOn,
    setVol: (v) => { S.opt.progVol = v; $('#progVol').value = v; $('#progVolVal').textContent = `${v}%`; progLevel(); },
    setMute: (m) => { unlockAudio(); S.opt.progOn = !m; S.room?.startAudio?.(); renderProg(); } },
  { k: 'tts', ic: '🗣', name: 'Komunikaty',
    vol: () => pct(S.opt.ttsVol, 100), muted: () => !!S.opt.ttsMute,
    setVol: (v) => { S.opt.ttsVol = v; }, test: () => { unlockAudio(); if (!NAT) speechSynthesis?.cancel?.(); say('Komunikat'); },
    setMute: (m) => { S.opt.ttsMute = m; if (m) speechSynthesis?.cancel?.(); } },
  { k: 'beep', ic: '🔔', name: 'Sygnały',
    vol: () => pct(S.opt.beepVol, 100), muted: () => !!S.opt.beepMute,
    setVol: (v) => { S.opt.beepVol = v; }, test: () => { unlockAudio(); beep(); },
    setMute: (m) => { S.opt.beepMute = m; } },
];
function faderShow(st, v) {
  st.querySelector('.mx-fill').style.height = `${v}%`;
  st.querySelector('.mx-knob').style.bottom = `${v}%`;
  st.querySelector('.mx-fader').setAttribute('aria-valuenow', String(v));
  st.querySelector('.mx-val').textContent = `${v}%`;
}
function renderMixer() {
  const box = $('#mixer'); if (!box) return;
  if (!box.childElementCount) {
    box.style.setProperty('--n', MIX.length);
    box.innerHTML = MIX.map((c) => `<div class="mx-strip" data-k="${c.k}"><span class="mx-ic" aria-hidden="true">${c.ic}</span><span class="mx-name">${c.name}</span>
      <div class="mx-fader" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-label="Głośność: ${c.name}"><div class="mx-fill"></div><div class="mx-knob"></div></div><span class="mx-val"></span>
      <button type="button" class="mx-mute" aria-pressed="false">MUTE</button></div>`).join('');
    for (const c of MIX) {
      const st = box.querySelector(`[data-k="${c.k}"]`), f = st.querySelector('.mx-fader');
      // suwak pionowy (własny – działa tak samo na każdym telefonie); po puszczeniu krótka próbka, żeby usłyszeć poziom
      const setV = (v) => { v = Math.max(0, Math.min(100, Math.round(v))); c.setVol(v); store.set('opt', S.opt); faderShow(st, v); };
      const fromY = (e) => { const r = f.getBoundingClientRect(); return ((r.bottom - e.clientY) / r.height) * 100; };
      let drag = false;
      f.onpointerdown = (e) => { drag = true; f.setPointerCapture(e.pointerId); setV(fromY(e)); e.preventDefault(); };
      f.onpointermove = (e) => { if (drag) setV(fromY(e)); };
      f.onpointerup = f.onpointercancel = () => { if (!drag) return; drag = false; if (!c.muted() && c.test) c.test(); };
      f.onkeydown = (e) => {
        const d = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 20, PageDown: -20 }[e.key];
        if (d) { setV(c.vol() + d); e.preventDefault(); }
      };
      f.ondblclick = () => setV(100);
      st.querySelector('.mx-mute').onclick = () => { c.setMute(!c.muted()); store.set('opt', S.opt); renderMixer(); };
    }
  }
  for (const c of MIX) {
    const st = box.querySelector(`[data-k="${c.k}"]`), f = st.querySelector('.mx-fader'), m = st.querySelector('.mx-mute'), muted = c.muted();
    faderShow(st, c.vol());
    m.classList.toggle('on', muted); m.setAttribute('aria-pressed', String(muted));
    st.classList.toggle('off', muted);
    const na = !!c.na?.(); st.classList.toggle('na', na); st.title = na ? 'Realizator nie nadaje teraz dźwięku transmisji' : '';
  }
  $('#mixDuck').checked = S.opt.progDuck !== false;
  $('#mixDuckRow').hidden = !prog.cfg.enabled;
}
$('#mixDuck').onchange = (e) => { S.opt.progDuck = e.target.checked; store.set('opt', S.opt); renderProg(); progLevel(); };
$('#btnMix').onclick = () => {
  const box = $('#mixBox'); box.hidden = !box.hidden; $('#btnMix').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) { $('#progBox').hidden = true; renderMixer(); }
};
document.addEventListener('pointerdown', (e) => { const box = $('#mixBox'); if (!box.hidden && !box.contains(e.target) && !$('#btnMix').contains(e.target)) { box.hidden = true; $('#btnMix').setAttribute('aria-expanded', 'false'); } });
$('#btnDevRefresh').onclick = renderDevices;
$('#btnSpkTest').onclick = async () => {
  unlockAudio();
  // krótki dźwięk przez wybrane wyjście (osobny element audio – tak samo jak głosy rozmówców)
  const sr = 16000, f = new Float32Array(sr * 0.9);
  for (let i = 0; i < f.length; i++) { const t = i / sr, n = Math.floor(t / 0.3); f[i] = 0.25 * Math.sin(2 * Math.PI * [660, 880, 990][n] * t) * Math.min(1, (0.3 - (t % 0.3)) * 30, (t % 0.3) * 30); }
  let el = $('#spkTest');
  if (!el) { el = document.createElement('audio'); el.id = 'spkTest'; document.body.appendChild(el); }
  el.src = URL.createObjectURL(encodeWav(f)); el.volume = volLevel();
  try { if (S.opt.spkId && el.setSinkId) await el.setSinkId(S.opt.spkId); await el.play(); } catch (err) { sysMsg('Test dźwięku nie powiódł się: ' + (err?.message || err)); }
};
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!$('#sheet').hidden && !$('#sheetSettings').hidden) renderDevices(); });
// wskaźnik poziomu mikrofonu (z kopii mikrofonu, gdy otwarte są ustawienia)
let meterLvl = 0;
function meterFeed(f) {
  if ($('#sheet').hidden || $('#sheetSettings').hidden) return;
  let peak = 0; for (let i = 0; i < f.length; i += 4) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
  meterLvl = Math.max(peak, meterLvl * 0.85);
  $('#micMeter').style.width = `${Math.min(100, Math.round(Math.sqrt(meterLvl) * 100))}%`;
}

// ================= GŁOS (LiveKit) =================
async function connectVoice() {
  if (NAT) return nativeConnect();
  await resolveDevices();
  const room = new Room({
    adaptiveStream: false, dynacast: false,
    audioCaptureDefaults: micConstraints(),
    ...(S.opt.spkId ? { audioOutput: { deviceId: S.opt.spkId } } : {}),
    publishDefaults: { dtx: true, red: true },
  });
  S.room = room;
  room
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (isProg(p)) { progAttach(track); return; }
      const el = track.attach();
      el.dataset.pid = p.identity;
      el.volume = volLevel();
      document.body.appendChild(el);
      gate(p);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); if (track === prog.track) { prog.track = null; progClearEls(); } })
    .on(RoomEvent.TrackPublished, (_pub, p) => { gate(p); if (isProg(p)) renderProg(); })
    .on(RoomEvent.TrackUnpublished, (_pub, p) => { if (isProg(p)) renderProg(); })
    .on(RoomEvent.TrackMuted, (_pub, p) => { if (isProg(p)) renderProg(); })
    .on(RoomEvent.TrackUnmuted, (_pub, p) => { if (isProg(p)) renderProg(); })
    .on(RoomEvent.ParticipantConnected, (p) => { if (isProg(p)) renderProg(); })
    .on(RoomEvent.ParticipantDisconnected, (p) => { if (isProg(p)) { prog.track = null; progClearEls(); renderProg(); } })
    .on(RoomEvent.AudioPlaybackStatusChanged, showAudioHintIfNeeded)
    .on(RoomEvent.Disconnected, () => { setConn(); setTimeout(() => S.room === room && reconnectVoice(), 3000); })
    .on(RoomEvent.Reconnecting, setConn)
    .on(RoomEvent.Reconnected, setConn)
    .on(RoomEvent.Connected, setConn);
  const url = S.session.livekit.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  try {
    await room.connect(url, S.session.livekit.token);
    if (canTalk()) await prepareMic();
  } catch (err) {
    console.error('Głos niedostępny', err);
    sysMsg('Połączenie głosowe niedostępne: ' + (err?.message || err) + '. Tekst działa dalej.');
  }
  setConn(); showAudioHintIfNeeded(); updateGates();
}
// ---- głos w aplikacji natywnej ----
const nativeOpts = () => ({ voice: S.opt.voice !== false, vol: volLevel(), prog: progWanted(), progVol: progVolPct() / 100, progDuck: S.opt.progDuck !== false, duck: (prog.cfg.duck ?? 30) / 100, canTalk: canTalk(), progStereo: S.opt.progStereo !== false, hiFi: !!S.opt.hiFi });
function nativeSync() { // tylko gdy coś się zmieniło – inaczej strona i telefon odbijają się w nieskończoność
  if (!NAT || !S.session) return;
  const o = nativeOpts(), k = JSON.stringify(o);
  if (k === S.natLast) return;
  S.natLast = k; NAT.configure(o).catch(() => { S.natLast = null; });
}
async function nativeConnect() {
  if (!S.natListeners) {
    S.natListeners = true;
    NAT.addListener('state', (e) => { S.natState = e.state; setConn(); });
    NAT.addListener('ptt', (e) => { // mówienie z przycisku Bluetooth / słuchawek / głośności
      S.pttOn = !!e.on; if (e.talkId) S.talkId = e.talkId;
      $('#ptt').classList.toggle('live', S.pttOn);
      if (S.pttOn) $('#ptt .ptt-l1').textContent = 'MÓWISZ'; else renderPttLabel();
    });
    NAT.addListener('program', (e) => { if (prog.natLive === !!e.live) return; prog.natLive = !!e.live; renderProg(); });
    NAT.addListener('notice', (e) => sysMsg(e.message));
    NAT.addListener('forceMute', (e) => onModMuted(e.by || 'Reżyser')); // gdy strona spała – aplikacja przekazuje po wybudzeniu
    NAT.addListener('moveTo', (e) => onModMoved(e.channel, e.by || 'Reżyser', false));
  }
  try {
    S.natLast = JSON.stringify(nativeOpts());
    await NAT.connect({ url: S.session.livekit.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, token: S.session.livekit.token, session: S.session.token, server: location.origin, ...nativeOpts() });
    $('#ptt').disabled = !canTalk();
    renderPttLabel();
  } catch (err) { sysMsg('Połączenie głosowe niedostępne: ' + (err?.message || err)); }
  setConn(); renderNativeButtons();
}
// ---- przyciski sprzętowe (tylko aplikacja) ----
async function renderNativeButtons() {
  if (!NAT) return;
  $('#natBox').hidden = false;
  let b = {};
  try { b = await NAT.getButtons(); } catch {}
  $('#nbMedia').checked = b.media !== false; $('#nbVol').checked = !!b.volume; $('#nbMode').value = b.mode || 'hold';
  $('#nbLearn').hidden = $('#nbKey').hidden = b.platform === 'ios';
  $('#nbMode').disabled = b.platform === 'ios'; if (b.platform === 'ios') $('#nbMode').value = 'toggle';
  $('#nbKey').textContent = b.keyName ? `Przycisk PTT: ${b.keyName}` : 'Brak przypisanego przycisku PTT';
  $('#nbHint').textContent = b.platform === 'ios'
    ? 'iPhone: przyciski słuchawek i Bluetooth (także pilot PTT) działają w trybie „naciśnij – mów, naciśnij ponownie – koniec” – również przy zablokowanym ekranie. Przyciski głośności – tylko gdy aplikacja jest na ekranie.'
    : 'Android: przytrzymanie działa dla przycisków słuchawek, Bluetooth i przypisanego przycisku PTT – także przy zablokowanym ekranie. Przyciski głośności – gdy ekran jest włączony.';
}
const saveButtons = () => NAT?.setButtons({ media: $('#nbMedia').checked, volume: $('#nbVol').checked, mode: $('#nbMode').value }).catch(() => {});
$('#nbMedia').onchange = saveButtons; $('#nbVol').onchange = saveButtons; $('#nbMode').onchange = saveButtons;
$('#nbLearn').onclick = async () => {
  $('#nbKey').textContent = 'Naciśnij teraz przycisk PTT… (10 s)';
  try { const r = await NAT.learnButton({ timeoutMs: 10000 }); $('#nbKey').textContent = r?.keyName ? `Przycisk PTT: ${r.keyName}` : 'Nie wykryto przycisku.'; }
  catch (e) { $('#nbKey').textContent = e?.message || 'Nie udało się.'; }
};
async function reconnectVoice() {
  try { await S.room.connect(S.session.livekit.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, S.session.livekit.token); if (canTalk()) await prepareMic(); }
  catch { setTimeout(() => reconnectVoice(), 5000); }
  setConn(); updateGates();
}

// Mikrofon otwarty tylko podczas mówienia (domyślnie na komputerze). Otwarty mikrofon z redukcją echa włącza
// systemowy tryb rozmowy (macOS: „voice processing”, Windows: tryb komunikacji), który ŚCISZA DŹWIĘK INNYCH APLIKACJI
// (muzyka, filmy) – a ściszać mamy tylko transmisję w samej apce. Koszt: start mówienia ok. 0,2–0,4 s później,
// bez bufora 0,6 s sprzed naciśnięcia. Tryb pałąka potrzebuje stale otwartego mikrofonu, więc go wyłącza.
function isDesktopUA() { return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
const micRelease = () => !NAT && !S.opt.boom && (S.opt.micRelease ?? isDesktopUA());
function applyMicRelease() {
  const tr = S.micPub?.track;
  if (tr) tr.stopOnMute = micRelease();
  if (micRelease() && !S.pttOn && S.micPub) { stopCapture(); if (S.micPub.isMuted) { try { tr?.mediaStreamTrack?.stop(); } catch {} } }
  else if (!micRelease() && S.micPub && !micHealthy()) reviveMic('mikrofon stale gotowy');
}
async function prepareMic() {
  if (NAT) { nativeSync(); $('#ptt').disabled = !canTalk(); renderPttLabel(); return; }
  try {
    await S.room.localParticipant.setMicrophoneEnabled(true);
    S.micPub = S.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (S.micPub?.track) S.micPub.track.stopOnMute = micRelease();
    if (actx && !micRelease()) ensureCapture(); // bufor sprzed wciśnięcia działa od pierwszego razu
    await S.micPub?.mute(); // mikrofon gotowy, ale wyciszony – włączenie jest natychmiastowe
    $('#ptt').disabled = false;
    renderPttLabel();
  } catch (err) {
    if (S.opt.micId) { // zapamiętany mikrofon zniknął (np. odłączone słuchawki) – spróbuj domyślnego
      S.opt.micId = ''; store.set('opt', S.opt); S.room.options.audioCaptureDefaults = micConstraints();
      sysMsg('Wybrany mikrofon jest niedostępny – używam domyślnego.');
      return prepareMic();
    }
    $('#ptt').disabled = true;
    sysMsg('Brak dostępu do mikrofonu. Sprawdź uprawnienia przeglądarki (wymagane HTTPS).');
  }
}

// Czy mam słyszeć danego uczestnika? – tylko gdy kanał, na który mówi, jest na mojej liście.
function shouldHear(uid) {
  if (!S.opt.voice || uid === S.me.id) return false;
  const u = S.users.get(uid);
  if (S.wtarget.has(uid)) return true; // ktoś ma otwartą rozmowę prywatną ze mną – kanał audio gotowy
  const ch = S.talking.get(uid) || u?.target;
  if (isDm(ch)) return true; // szept dociera tylko do adresata
  return !!ch && S.listen.has(ch);
}
function gate(p) {
  const on = isProg(p) ? progWanted() && prog.local.state !== 'on' : shouldHear(p.identity);
  for (const pub of p.audioTrackPublications.values()) {
    if (pub.isEnabled !== on) pub.setEnabled(on);
  }
}
function updateGates() {
  if (NAT) { nativeSync(); return; } // w aplikacji natywnej to serwer mówi telefonowi, kogo ma słyszeć
  if (!S.room) return;
  for (const p of S.room.remoteParticipants.values()) gate(p);
  progLevel();
}

// ================= DŹWIĘK TRANSMISJI (program) =================
// Komputer w kościele nadaje miks z konsolety jako uczestnik „ik-program”. Każdy sam włącza odsłuch (🎵)
// i ustawia głośność; gdy ktoś mówi przez interkom, program jest automatycznie ściszany.
const prog = { cfg: { enabled: false, name: 'Dźwięk transmisji', duck: 30, id: 'ik-program' }, track: null };
const isProg = (p) => p?.identity === prog.cfg.id;
const progParticipant = () => (S.room ? [...S.room.remoteParticipants.values()].find(isProg) : null);
const progPub = () => { const p = progParticipant(); return p ? [...p.audioTrackPublications.values()][0] || null : null; };
const progWanted = () => !!S.opt.progOn && prog.cfg.enabled;
const progVolPct = () => (typeof S.opt.progVol === 'number' ? S.opt.progVol : 50);
const progDucking = () => S.opt.progDuck !== false && (S.pttOn || [...S.talking.keys()].some((uid) => shouldHear(uid)));
function progLevel() {
  if (NAT) { nativeSync(); return; }
  const v = (progVolPct() / 100) * (progDucking() ? prog.cfg.duck / 100 : 1);
  if (prog.track) { try { prog.track.setVolume(v); } catch {} }
  const lo = prog.local;
  if (FP.node) FP.node.port.postMessage({ gain: v });
  if (lo.gain) lo.gain.gain.setTargetAtTime(v, lo.gain.context.currentTime, 0.03);
  else if (lo.el && lo.state === 'on') lo.el.volume = Math.min(1, v);
}
// iPhone nie pozwala zmieniać głośności elementu <audio> – dlatego tam program idzie przez Web Audio (wzmacniacz).
// Na komputerze i Androidzie zwykły element <audio>: Web Audio w Chrome nie nadąża za zmianą częstotliwości
// wyjścia (np. słuchawki Bluetooth przechodzą w tryb rozmowy przy otwarciu mikrofonu, inna karta przestawia
// urządzenie) i transmisja grała wtedy za szybko / za wolno – zmieniała się wysokość dźwięku.
const progViaCtx = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function progAttach(track) {
  if (prog.track && prog.track !== track) prog.track.detach().forEach((el) => el.remove());
  prog.track = track;
  track.detach().forEach((el) => el.remove());
  progClearEls();
  prog.ctx = null;
  if (actx && progViaCtx()) { try { track.setAudioContext(actx); prog.ctx = actx; } catch {} }
  else { try { track.setAudioContext(undefined); } catch {} }
  const el = track.attach();
  el.dataset.pid = prog.cfg.id; el.dataset.prog = '1';
  if (S.opt.spkId) el.setSinkId?.(S.opt.spkId).catch(() => {});
  document.body.appendChild(el);
  progLevel(); renderProg();
}
const progClearEls = () => document.querySelectorAll('audio[data-prog]').forEach((el) => { el.srcObject = null; el.remove(); });
function progUseCtx() { // po pierwszym dotknięciu (utworzenie AudioContext)
  if (prog.track && actx && progViaCtx() && prog.ctx !== actx) progAttach(prog.track);
  // lokalnie w zwykłym trybie, a „ultra” stało się możliwe – przełącz
  const lo = prog.local;
  if (actx && lo.state === 'on' && !lo.fast && !lo.fastAsk && S.opt.progFast !== false) { progLocalStop(); lo.failedAt = 0; setTimeout(progLocalSync, 50); }
  // wcześniejsza próba bez Web Audio się nie udała (np. nadajnik na serwerze obsługuje tylko tryb ultra) – spróbuj od razu ponownie
  else if (actx && lo.state === 'idle' && lo.failedAt && !lo.fastTried && S.opt.progFast !== false && !prog.fastBroken) { lo.fastTried = true; lo.failedAt = 0; setTimeout(progLocalSync, 50); }
}
function renderProg() {
  const pub = progPub(), live = prog.cfg.enabled && (!!pub || prog.local.state === 'on' || (!!NAT && !!prog.natLive));
  const btn = $('#btnProg');
  btn.hidden = !live;
  if (!prog.cfg.enabled) $('#progBox').hidden = true;
  btn.classList.toggle('on', !!S.opt.progOn && live);
  btn.classList.toggle('muted', !!(pub?.isMuted || prog.cfg.muted));
  $('#progName').textContent = prog.cfg.name;
  const st = $('#progState');
  const loc = prog.local.state === 'on';
  const muted = !!(pub?.isMuted || prog.cfg.muted);
  st.textContent = !pub && !loc ? 'nie nadaje' : muted ? 'wyciszone przez realizatora' : loc ? (prog.local.fast ? '● na żywo · ⚡ ultra' : '● na żywo · lokalnie') : '● na żywo';
  st.title = loc ? 'Dźwięk idzie prosto z komputera w kościele (sieć lokalna), z pominięciem serwera' : 'Dźwięk idzie przez serwer interkomu';
  st.className = 'pb-st ' + (!pub && !loc ? '' : muted ? 'warn' : 'ok');
  $('#progOn').checked = !!S.opt.progOn;
  $('#progVol').value = progVolPct(); $('#progVolVal').textContent = `${progVolPct()}%`;
  $('#progDuck').checked = S.opt.progDuck !== false;
  $('#progUltraRow').hidden = !prog.cfg.local || !!NAT; // w aplikacji telefon słucha natywnie (LiveKit)
  const natPlat = NAT ? window.Capacitor?.getPlatform?.() : '';
  $('#progNatRow').hidden = !NAT;
  $('#progStereoRow').hidden = natPlat !== 'ios'; // Android: biblioteka LiveKit odbiera transmisję w mono – przełącznik nic by nie zmienił
  $('#progStereo').checked = S.opt.progStereo !== false; $('#progHiFi').checked = !!S.opt.hiFi;
  $('#progFast').checked = S.opt.progFast !== false;
  $('#progBuf').value = S.opt.progBuf || 'auto';
  $('#progBuf').disabled = S.opt.progFast === false;
  $('#progHint').textContent = NAT && S.opt.hiFi ? `Jakość muzyczna: telefon nie przełącza dźwięku w tryb rozmowy telefonicznej. Słuchawki Bluetooth grają w trybie muzycznym, ale mówisz wtedy do mikrofonu telefonu. Bez słuchawek lepiej wyłączyć – głośnik może dawać echo.${natPlat === 'android' ? ' Na Androidzie transmisja przez serwer jest jeszcze mono.' : ''}` : !S.opt.voice ? 'Masz wyłączone „Odtwarzaj głos” – rozmów nie słychać, dźwięk transmisji działa niezależnie.'
    : S.opt.progDuck !== false && prog.cfg.duck < 100 ? `Gdy ktoś mówi, transmisja cichnie do ${prog.cfg.duck}% ustawionej głośności.` : '';
  updateGatesOnlyProg();
  progLocalSync();
  renderMixer();
}
function updateGatesOnlyProg() { const p = progParticipant(); if (p) gate(p); progLevel(); }
if (/[?&]ikdebug\b/.test(location.search)) window.__ik = { S, prog, progAttach }; // tylko do testów
// ---- lokalny odsłuch: prosto z komputera w kościele (WebRTC w sieci lokalnej), bez serwera w chmurze ----
// Telefon prosi nadajnik o połączenie; jeśli w ciągu kilku sekund się nie uda (np. telefon poza siecią kościoła),
// zostaje odsłuch przez serwer. Gdy połączenie lokalne padnie w trakcie – płynnie wracamy do serwera.
prog.local = { state: 'idle', pc: null, stream: null, el: null, gain: null, src: null, failedAt: 0, timer: null };
const LOCAL_RETRY_MS = 60000;
function progLocalSync() {
  if (NAT) return; // w aplikacji natywnej dźwięk transmisji idzie natywnie (tryb lokalny/ultra – w kolejnej wersji)
  const lo = prog.local, want = progWanted() && prog.cfg.local && !!S.ws && S.ws.readyState === 1;
  if (!want) { if (lo.state !== 'idle') progLocalStop(); return; }
  if (lo.state === 'idle' && Date.now() - lo.failedAt > LOCAL_RETRY_MS) progLocalStart();
}
function progLocalStart() {
  const lo = prog.local;
  lo.state = 'trying';
  const pc = new RTCPeerConnection({ iceServers: [] }); // tylko sieć lokalna
  lo.pc = pc;
  pc.ontrack = (e) => { lo.stream = e.streams[0] || new MediaStream([e.track]); progLocalMaybeOn(); };
  pc.ondatachannel = (e) => { lo.chan = e.channel; lo.chan.binaryType = 'arraybuffer'; lo.chan.onopen = progLocalMaybeOn; lo.chan.onmessage = (ev) => fastPacket(ev.data); lo.chan.onclose = () => lo.state === 'on' && progLocalFail('kanał zamknięty'); if (lo.chan.readyState === 'open') progLocalMaybeOn(); };
  pc.onconnectionstatechange = () => {
    if (pc !== lo.pc) return;
    if (pc.connectionState === 'connected') progLocalMaybeOn();
    if (['failed', 'closed'].includes(pc.connectionState)) progLocalFail(pc.connectionState);
    if (pc.connectionState === 'disconnected') { clearTimeout(lo.dcT); lo.dcT = setTimeout(() => pc.connectionState === 'disconnected' && progLocalFail('disconnected'), 2500); }
  };
  // tor „ultra” wymaga Web Audio (po pierwszym dotknięciu) – bez niego zwykły tor WebRTC
  lo.fastAsk = S.opt.progFast !== false && !!actx?.audioWorklet && !prog.fastBroken;
  if (lo.fastAsk) lo.fastTried = true;
  wsSend({ t: 'plReq', fast: lo.fastAsk });
  clearTimeout(lo.timer);
  lo.timer = setTimeout(() => { if (lo.state === 'trying') progLocalFail('timeout'); }, 6000);
}
// Opus: stereo, bez DTX, ramki 10 ms (mniejsze opóźnienie w sieci lokalnej)
function tuneOpus(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  sdp = sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_, p) => {
    const o = Object.fromEntries(p.split(';').filter(Boolean).map((kv) => kv.trim().split('=')));
    Object.assign(o, { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', usedtx: '0', useinbandfec: '1', minptime: '10' });
    return `a=fmtp:${pt} ` + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(';');
  });
  if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(a=rtpmap:\d+ opus\/48000[^\r\n]*\r\n)/i, '$1a=ptime:10\r\na=maxptime:10\r\n');
  return sdp;
}
async function progLocalOffer(sdp, fast) {
  const lo = prog.local;
  lo.fast = !!fast;
  if (!lo.pc || lo.state !== 'trying' || typeof sdp !== 'string') return;
  await lo.pc.setRemoteDescription({ type: 'offer', sdp });
  const ans = await lo.pc.createAnswer();
  await lo.pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(ans.sdp) }); // stereo=1 w odpowiedzi – inaczej nadajnik wyśle mono
  await new Promise((ok) => { if (lo.pc.iceGatheringState === 'complete') return ok(); const t = setTimeout(ok, 1500); lo.pc.addEventListener('icegatheringstatechange', () => { if (lo.pc?.iceGatheringState === 'complete') { clearTimeout(t); ok(); } }); });
  if (lo.pc) wsSend({ t: 'plAnswer', sdp: lo.pc.localDescription.sdp });
}
function progLocalMaybeOn() {
  const lo = prog.local;
  if (lo.state !== 'trying' || lo.pc?.connectionState !== 'connected') return;
  if (lo.fast) { if (lo.chan?.readyState === 'open' && !lo.fastStarting) { lo.fastStarting = true; fastStart().catch((e) => progLocalFail('ultra: ' + e.message)).finally(() => { lo.fastStarting = false; }); } return; }
  if (!lo.stream) return;
  clearTimeout(lo.timer);
  lo.state = 'on';
  // Chrome podaje dźwięk WebRTC do Web Audio tylko wtedy, gdy strumień gra też w elemencie <audio> (wyciszonym)
  lo.el = document.createElement('audio'); lo.el.autoplay = true; lo.el.dataset.proglocal = '1';
  lo.el.srcObject = lo.stream;
  if (actx && progViaCtx()) {
    lo.el.muted = true;
    lo.src = actx.createMediaStreamSource(lo.stream); lo.gain = actx.createGain(); lo.gain.gain.value = 0;
    lo.src.connect(lo.gain); lo.gain.connect(actx.destination);
  } else if (S.opt.spkId) lo.el.setSinkId?.(S.opt.spkId).catch(() => {});
  document.body.appendChild(lo.el);
  lo.el.play().catch(() => {});
  progLevel(); progMeas.last = null;
  renderProg(); // wyłącza odbiór przez serwer
}
function progLocalStop() {
  const lo = prog.local;
  clearTimeout(lo.timer); clearTimeout(lo.dcT);
  const wasOn = lo.state === 'on';
  if (lo.pc) { try { lo.pc.close(); } catch {} wsSend({ t: 'plBye' }); }
  try { lo.src?.disconnect(); lo.gain?.disconnect(); } catch {}
  if (lo.el) { lo.el.srcObject = null; lo.el.remove(); }
  fastStop();
  Object.assign(lo, { state: 'idle', pc: null, stream: null, el: null, gain: null, src: null, chan: null, fast: false });
  if (wasOn) { progMeas.last = null; renderProg(); }
}
function progLocalFail(why) {
  const lo = prog.local;
  if (lo.state === 'idle') return;
  console.info('[odsłuch lokalny]', why);
  if (String(why).startsWith('ultra')) prog.fastBroken = true; // ta przeglądarka nie obsłuży trybu ultra – dalej zwykły tor lokalny
  const wasOn = lo.state === 'on';
  progLocalStop();
  // po zerwaniu działającego połączenia spróbuj szybko jeszcze raz; gdy w ogóle się nie udało – za minutę
  lo.failedAt = wasOn ? Date.now() - LOCAL_RETRY_MS + 8000 : Date.now();
  renderProg();
}
setInterval(progLocalSync, 5000);

// ---- tor „ultra”: własny bufor zamiast mechanizmu WebRTC ----
// Pakiety Opus (10 ms) przychodzą kanałem danych bez powtórzeń (jak UDP). Dekoder WASM, a odtwarzanie w AudioWorklet
// z krótkim buforem, który sami ustawiamy: przy równym Wi-Fi 10–20 ms. Odtwarzacz lekko przyspiesza/zwalnia
// najwyżej o ±0,3% (ok. 5 centów – niesłyszalne), płynnie i według średniego zapełnienia bufora z ok. pół sekundy,
// żeby utrzymać zadany bufor i zrównać zegary nadajnika i telefonu. (Do 0.44.0 korekta sięgała ±2–3% i skakała
// z każdą porcją z Wi-Fi – na muzyce było słychać „pływanie” wysokości dźwięku.)
const PLAYER = `class IkPlay extends AudioWorkletProcessor {
  constructor() {
    super(); this.N = 48000; this.L = new Float32Array(this.N); this.R = new Float32Array(this.N);
    this.w = 0; this.r = 0; this.fill = 0; this.target = 960; this.play = false; this.gain = 0; this.g = 0; this.under = 0; this.t = 0;
    this.avg = 960; this.adj = 0;
    this.port.onmessage = (e) => { const d = e.data;
      if (d.pcm) { const [l, r] = d.pcm; for (let i = 0; i < l.length; i++) { this.L[this.w] = l[i]; this.R[this.w] = r[i]; this.w = (this.w + 1) % this.N; }
        this.fill += l.length; if (this.fill > this.N - 2048) { const drop = this.fill - this.target; this.r = (this.r + drop) % this.N; this.fill -= drop; } }
      if (d.target) this.target = d.target; if (d.gain !== undefined) this.gain = d.gain; };
  }
  process(_, out) {
    const oL = out[0][0], oR = out[0][1] || out[0][0], n = oL.length;
    if (!this.play && this.fill >= this.target) { this.play = true; this.avg = this.fill; }
    if (!this.play) { oL.fill(0); if (oR !== oL) oR.fill(0); return this.stat(n); }
    // za dużo w buforze (np. chwilowy zator Wi-Fi już minął, inny zegar karty) – przeskocz nadmiar, zamiast grać z opóźnieniem
    if (this.fill > this.target + Math.max(2880, this.target)) { const skip = this.fill - this.target; this.r = (this.r + skip) % this.N; this.fill -= skip; this.g = 0; this.avg = this.fill; this.skips = (this.skips || 0) + 1; }
    // regulacja tempa: średnio za dużo w buforze → minimalnie szybciej, za mało → minimalnie wolniej.
    // Średnia z ok. 0,5 s (porcje z Wi-Fi przychodzą nierówno) i powolna zmiana tempa – bez słyszalnego „pływania”.
    this.avg += (this.fill - this.avg) * Math.min(1, n / 24000);
    const err = (this.avg - this.target) / Math.max(480, this.target);
    const want = Math.max(-0.003, Math.min(0.003, err * 0.003));
    this.adj += (want - this.adj) * Math.min(1, n / 48000);
    // dane są w 48 kHz; telefon może grać w 44,1 kHz – wtedy czytamy szybciej (resampling liniowy)
    const rate = (48000 / sampleRate) * (1 + this.adj);
    for (let i = 0; i < n; i++) {
      if (this.fill < 2) { // bufor pusty – łagodne wyciszenie i czekanie na dane
        for (let k = i; k < n; k++) { oL[k] = 0; if (oR !== oL) oR[k] = 0; }
        this.play = false; this.under++; break;
      }
      const i0 = Math.floor(this.r), f = this.r - i0, i1 = (i0 + 1) % this.N;
      this.g += (this.gain - this.g) * 0.002;
      oL[i] = (this.L[i0 % this.N] * (1 - f) + this.L[i1] * f) * this.g;
      if (oR !== oL) oR[i] = (this.R[i0 % this.N] * (1 - f) + this.R[i1] * f) * this.g;
      const nr = this.r + rate, adv = Math.floor(nr) - i0;
      this.r = nr % this.N; this.fill -= adv;
    }
    return this.stat(n);
  }
  stat(n) { this.t += n; if (this.t >= 12000) { this.t = 0; this.port.postMessage({ fill: this.fill, under: this.under, play: this.play, skips: this.skips || 0 }); } return true; }
}
registerProcessor('ik-play', IkPlay);`;
const FP = { node: null, dec: null, lastSeq: -1, target: 960, arr: [], fill: 0, under: 0, underAt: 0, bump: 0, lost: 0, got: 0 };
if (window.__ik) window.__ik.FP = FP;
const BUF_MODES = { min: { floor: 5, extra: 2 }, auto: { floor: 10, extra: 8 }, stable: { floor: 40, extra: 15 } };
async function fastStart() {
  const lo = prog.local;
  if (!actx?.audioWorklet) throw new Error('brak Web Audio');
  if (!window['opus-decoder']) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = '/vendor-opus/opus-decoder.min.js'; sc.onload = ok; sc.onerror = () => no(new Error('dekoder')); document.head.appendChild(sc); });
  FP.dec = new window['opus-decoder'].OpusDecoder({ channels: 2, forceStereo: true });
  await FP.dec.ready;
  if (!actx._ikPlay) actx._ikPlay = actx.audioWorklet.addModule(URL.createObjectURL(new Blob([PLAYER], { type: 'text/javascript' })));
  await actx._ikPlay;
  FP.node = new AudioWorkletNode(actx, 'ik-play', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  FP.node.connect(actx.destination);
  FP.node.port.onmessage = (e) => {
    const d = e.data; FP.fill = d.fill; FP.skips = d.skips;
    if (d.under > FP.under) { FP.under = d.under; FP.underAt = Date.now(); FP.bump = Math.min(60, FP.bump + 8); } // przycięcie → trochę większy bufor
  };
  Object.assign(FP, { lastSeq: -1, arr: [], under: 0, bump: 0, lost: 0, got: 0 });
  if (prog.local.state !== 'trying') return fastStop();
  clearTimeout(lo.timer);
  lo.state = 'on';
  progLevel(); progMeas.last = null;
  renderProg();
}
function fastStop() { try { FP.node?.disconnect(); } catch {} FP.node = null; try { FP.dec?.free(); } catch {} FP.dec = null; }
function fastPacket(buf) {
  if (!FP.dec || !FP.node || !(buf instanceof ArrayBuffer) || buf.byteLength < 5) return;
  const now = performance.now(), seq = new DataView(buf).getUint32(0);
  if (FP.lastSeq >= 0) { const gap = seq - FP.lastSeq; if (gap <= 0) return; FP.lost += gap - 1; } // spóźniony duplikat / stary pakiet – pomijamy
  FP.lastSeq = seq; FP.got++;
  // rozrzut czasu przyjścia (jitter): opóźnienie względem „idealnego” zegara nadajnika
  FP.arr.push([now, now - seq * 10]); while (FP.arr.length && now - FP.arr[0][0] > 4000) FP.arr.shift();
  let pcm;
  try { pcm = FP.dec.decodeFrame(new Uint8Array(buf, 4)); } catch { return; }
  if (!pcm.samplesDecoded) return;
  FP.node.port.postMessage({ pcm: pcm.channelData });
  if (FP.got % 25 === 0) fastTarget();
}
function fastTarget() {
  const m = BUF_MODES[S.opt.progBuf] || BUF_MODES.auto;
  const ds = FP.arr.map((x) => x[1]).sort((a, b) => a - b);
  const jit = ds.length > 10 ? ds[Math.floor(ds.length * 0.97)] - ds[0] : 10; // 97. percentyl rozrzutu z ostatnich 4 s
  if (FP.bump > 0 && Date.now() - FP.underAt > 3000) FP.bump = Math.max(0, FP.bump - 1); // po spokojnym okresie wracamy do niższego
  const ms = Math.max(m.floor, Math.min(250, jit + m.extra + FP.bump));
  FP.target = Math.round(ms * 48);
  FP.node?.port.postMessage({ target: FP.target });
}

// ---- pomiar opóźnienia dźwięku transmisji ----
// nadajnik (wejście + obróbka + ramka Opus + droga do serwera) + droga do mnie + bufor wyrównujący Wi-Fi + odtwarzanie
const progMeas = { last: null, jb: null, rtt: null, loss: 0, tcp: false, bt: false };
async function progMeasure() {
  const t = prog.track, lo = prog.local;
  if ((!t && lo.state !== 'on') || $('#progBox').hidden || !S.opt.progOn) return;
  try {
    const rep = lo.state === 'on' ? await lo.pc.getStats() : await t.getRTCStatsReport();
    if (lo.state === 'on' && lo.fast) { // tor „ultra”: bufor i straty z naszego odtwarzacza
      progMeas.jb = Math.round(FP.fill / 48); progMeas.target = Math.round(FP.target / 48);
      const tot = FP.got + FP.lost; progMeas.loss = tot ? FP.lost / tot : 0; FP.got = 0; FP.lost = 0;
    }
    let inb = null, tr = null, pair = null;
    rep?.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'audio') inb = x; if (x.type === 'transport') tr = x; });
    if (tr?.selectedCandidatePairId) pair = rep.get(tr.selectedCandidatePairId);
    if (!pair) rep?.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
    const local = pair ? rep.get(pair.localCandidateId) : null;
    if (inb && !(lo.state === 'on' && lo.fast)) {
      const prev = progMeas.last;
      if (prev && inb.jitterBufferEmittedCount > prev.n) progMeas.jb = Math.round(((inb.jitterBufferDelay - prev.d) / (inb.jitterBufferEmittedCount - prev.n)) * 1000);
      else if (!prev && inb.jitterBufferEmittedCount) progMeas.jb = Math.round((inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000);
      const lost = inb.packetsLost - (prev?.lost || 0), got = inb.packetsReceived - (prev?.got || 0);
      progMeas.loss = prev && got + lost > 0 ? Math.max(0, lost) / (got + lost) : 0;
      progMeas.last = { d: inb.jitterBufferDelay, n: inb.jitterBufferEmittedCount, lost: inb.packetsLost, got: inb.packetsReceived };
    }
    progMeas.rtt = pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    progMeas.tcp = local?.protocol === 'tcp' || ['tcp', 'tls'].includes(local?.relayProtocol);
    progMeas.relay = local?.candidateType === 'relay';
    // słuchawki Bluetooth same dokładają ok. 150–250 ms
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      const cur = outs.find((d) => d.deviceId === (S.opt.spkId || 'default')) || outs[0];
      progMeas.bt = /bluetooth|airpods|buds|hands-?free|\bbt\b|headset.*wireless|wh-1000|jbl|bose/i.test(cur?.label || '');
    } catch { progMeas.bt = false; }
  } catch {}
  renderProgLat();
}
setInterval(progMeasure, 2000);
function renderProgLat() {
  const box = $('#progLat');
  if (!box) return;
  const loc = prog.local.state === 'on';
  const show = (!!prog.track || loc) && !!S.opt.progOn && progMeas.jb != null;
  box.hidden = !show;
  if (!show) return;
  // lokalnie: bez drogi nadajnik → serwer; ramki 10 ms zamiast 20 ms
  const ultra = loc && prog.local.fast;
  const src = prog.cfg.lat ? (ultra ? prog.cfg.lat.cap + 15 : loc ? prog.cfg.lat.cap + prog.cfg.lat.proc + 10 : prog.cfg.lat.total) : null; // ultra: ramka 10 ms + Opus low-delay 2,5 ms + przetwarzanie
  const net = progMeas.rtt != null ? Math.round(progMeas.rtt / 2) : null;
  const octx = loc ? prog.local.gain?.context : prog.ctx;
  const out = Math.round(((octx?.outputLatency || 0) + (octx?.baseLatency || 0)) * 1000) || 20;
  const parts = [src, net, progMeas.jb, out];
  const total = parts.every((x) => x != null) ? parts.reduce((a, b) => a + b, 0) : null;
  $('#progLatVal').textContent = total != null ? `ok. ${total} ms` : '…';
  $('#progLatVal').className = total == null ? '' : total < 150 ? 'ok' : total < 300 ? 'mid' : 'bad';
  $('#progLatDet').textContent = (ultra ? '⚡ ultra · ' : loc ? 'lokalnie · ' : 'przez serwer · ') + [src != null ? `nadajnik ${src}` : 'nadajnik ?', net != null ? `sieć ${net}` : null, `bufor ${progMeas.jb}`, `odtwarzanie ${out}`].filter(Boolean).join(' · ') + ' ms';
  const w = [];
  if (progMeas.bt) w.push('Słuchawki Bluetooth dodają ok. 150–250 ms – przewodowe będą dużo szybsze.');
  if (progMeas.tcp || prog.cfg.lat?.tcp) w.push('Połączenie idzie przez TCP (zablokowany UDP) – większe opóźnienie i przycięcia. Sprawdź port 7882/udp.');
  if (ultra && FP.bump >= 16) w.push('Były przycięcia – bufor sam się powiększył. Przy słabym Wi-Fi wybierz „Stabilny”.');
  if (progMeas.jb > 120) w.push('Duży bufor – Wi-Fi jest nierówne. Pomoże bliższy punkt dostępowy / sieć 5 GHz.');
  if (progMeas.loss > 0.02) w.push(`Gubione pakiety (${Math.round(progMeas.loss * 100)}%) – słaby zasięg Wi-Fi.`);
  $('#progLatWarn').innerHTML = w.map((x) => `<div>⚠ ${esc(x)}</div>`).join('');
}
function setProgCfg(c) { if (c) prog.cfg = { ...prog.cfg, ...c }; renderProg(); }
$('#btnProg').onclick = (e) => {
  e.stopPropagation(); unlockAudio(); progUseCtx();
  const box = $('#progBox'); box.hidden = !box.hidden; $('#btnProg').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) { $('#mixBox').hidden = true; progMeas.last = null; progMeasure(); }
};
document.addEventListener('pointerdown', (e) => { const box = $('#progBox'); if (!box.hidden && !box.contains(e.target) && e.target !== $('#btnProg')) { box.hidden = true; $('#btnProg').setAttribute('aria-expanded', 'false'); } });
$('#progOn').onchange = (e) => { unlockAudio(); S.opt.progOn = e.target.checked; store.set('opt', S.opt); S.room?.startAudio?.(); renderProg(); };
$('#progVol').oninput = (e) => { S.opt.progVol = Number(e.target.value); store.set('opt', S.opt); $('#progVolVal').textContent = `${S.opt.progVol}%`; progLevel(); renderMixer(); };
$('#progFast').onchange = (e) => { unlockAudio(); S.opt.progFast = e.target.checked; store.set('opt', S.opt); progLocalStop(); prog.local.failedAt = 0; renderProg(); };
$('#progBuf').onchange = (e) => { S.opt.progBuf = e.target.value; store.set('opt', S.opt); FP.bump = 0; if (FP.node) fastTarget(); };
$('#progStereo').onchange = (e) => { S.opt.progStereo = e.target.checked; store.set('opt', S.opt); nativeSync(); };
$('#progHiFi').onchange = (e) => { S.opt.hiFi = e.target.checked; store.set('opt', S.opt); nativeSync(); renderProg(); };
$('#progDuck').onchange = (e) => { S.opt.progDuck = e.target.checked; store.set('opt', S.opt); renderProg(); progLevel(); };

function showAudioHintIfNeeded() {
  $('#audioBlocked').hidden = !S.room || S.room.canPlaybackAudio;
}
$('#audioBlocked').onclick = async () => { unlockAudio(); await S.room?.startAudio(); showAudioHintIfNeeded(); };

// ---- push-to-talk ----
// Czy na danym kanale / w rozmowie działa transkrypcja (ustawia administrator)
const sttOnFor = (ch) => S.perm?.stt !== false && (isDm(ch) ? S.session.sttDm !== false : !(S.session.sttOff || []).includes(ch));
// Czy pokazywać tekst transkrypcji (wybór użytkownika)
const showStt = () => S.opt.sttShow === 'always' || (S.opt.sttShow === 'novoice' && !S.opt.voice);
// Nagranie kopii wypowiedzi do transkrypcji. Głos na żywo idzie niezależnie przez LiveKit.
// ---- nagrywanie do transkrypcji ----
// Własna kopia ścieżki mikrofonu (clone) jest włączona cały czas, także gdy mikrofon nadawania jest wyciszony.
// Dzięki temu nagranie ma bufor sprzed wciśnięcia przycisku (nie ucina pierwszych słów, nawet gdy włączanie
// mikrofonu w LiveKit trwa chwilę) i idzie jako czysty WAV 16 kHz – bez stratnej kompresji.
const PREROLL_S = 0.6, TAIL_MS = 450;
const cap = { track: null, src: null, node: null, sr: 48000, ring: [], ringLen: 0, seg: null, starting: null };
const noRecFor = (talkId) => (why) => fetch(`/api/stt/${talkId}?error=${encodeURIComponent(why)}`, { method: 'POST', headers: { authorization: 'Bearer ' + S.session.token } }).catch(() => {});

const WORKLET = `class IkCap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inp) { const c = inp[0] && inp[0][0]; if (c) { for (let i = 0; i < c.length; i++) { this.b[this.n++] = c[i]; if (this.n === 2048) { this.port.postMessage(this.b.slice(0)); this.n = 0; } } } return true; }
}
registerProcessor('ik-cap', IkCap);`;

function capLive() { return cap.track && cap.track.readyState === 'live' && cap.node; }
// Uruchom (albo odtwórz po podmianie ścieżki przez LiveKit) przechwytywanie dźwięku
async function ensureCapture() {
  const t = S.micPub?.track?.mediaStreamTrack;
  if (!t || !actx || t.readyState !== 'live') return false;
  if (capLive() && cap.from === t) return true;
  if (cap.starting) return cap.starting;
  cap.starting = (async () => {
    try {
      stopCapture();
      const clone = t.clone();
      clone.enabled = true; // kopia słyszy zawsze; na żywo idzie tylko oryginał (wyciszany przez PTT)
      cap.from = t; cap.track = clone; cap.sr = actx.sampleRate;
      cap.src = actx.createMediaStreamSource(new MediaStream([clone]));
      const onChunk = (f) => pushChunk(f);
      try {
        if (!actx.audioWorklet) throw new Error('brak AudioWorklet');
        if (!actx._ikWorklet) { const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })); actx._ikWorklet = actx.audioWorklet.addModule(url); }
        await actx._ikWorklet;
        cap.node = new AudioWorkletNode(actx, 'ik-cap');
        cap.node.port.onmessage = (e) => onChunk(e.data);
      } catch {
        cap.node = actx.createScriptProcessor(2048, 1, 1); // starsze przeglądarki
        cap.node.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0).slice(0));
      }
      const mute = actx.createGain(); mute.gain.value = 0; // węzeł musi być podłączony do wyjścia, ale bez dźwięku
      cap.src.connect(cap.node); cap.node.connect(mute); mute.connect(actx.destination);
      cap.mute = mute;
      return true;
    } catch (err) { console.warn('Przechwytywanie mikrofonu niedostępne', err); stopCapture(); return false; }
    finally { cap.starting = null; }
  })();
  return cap.starting;
}
function stopCapture() {
  try { cap.src?.disconnect(); cap.node?.disconnect(); cap.mute?.disconnect(); } catch {}
  try { cap.track?.stop(); } catch {}
  cap.track = cap.src = cap.node = cap.mute = cap.from = null; cap.ring = []; cap.ringLen = 0;
}
function pushChunk(f) {
  meterFeed(f);
  boomFeed(f);
  if (f.length && (Math.abs(f[0]) > 1e-6 || Math.abs(f[f.length >> 1]) > 1e-6 || Math.abs(f[f.length - 1]) > 1e-6)) cap.sound = Date.now(); // cokolwiek, nie cyfrowa cisza
  // bufor ostatnich ~0,6 s (do doklejenia przed wciśnięciem przycisku)
  cap.ring.push(f); cap.ringLen += f.length;
  while (cap.ringLen - cap.ring[0].length > PREROLL_S * cap.sr) cap.ringLen -= cap.ring.shift().length;
  if (cap.seg) { cap.seg.chunks.push(f); cap.seg.len += f.length; detectPause(f); }
}

function newSeg(talkId, withPreroll) {
  cap.seg = { talkId, chunks: withPreroll ? [...cap.ring] : [], len: withPreroll ? cap.ringLen : 0, since: Date.now(), quietMs: 0, speechMs: 0 };
}

async function startRecording(talkId) {
  if (!S.session.stt || !sttOnFor(S.active)) return;
  const noRec = noRecFor(talkId);
  if (!(await ensureCapture())) { setTimeout(() => noRec('brak dostępu do mikrofonu do nagrania'), 800); return; }
  if (!S.pttOn || S.talkId !== talkId) return;
  newSeg(talkId, true);
}
function stopRecording() {
  if (!cap.seg) return;
  const seg = cap.seg; cap.seg = null;
  finishSeg(seg);
}
// Zamknięcie fragmentu w przerwie w mowie: głos na żywo leci dalej, a gotowy fragment idzie do transkrypcji.
function cutSegment() {
  if (!cap.seg || !S.pttOn) return;
  const old = cap.seg, talkId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  S.talkId = talkId;
  wsSend({ t: 'pttSeg', talkId }); // serwer zakłada wpis dla kończącego się fragmentu
  newSeg(talkId, false);
  finishSeg(old);
}
function finishSeg(seg) {
  const noRec = noRecFor(seg.talkId);
  if (seg.len < cap.sr * 0.3) return noRec(`za krótkie nagranie (${(seg.len / cap.sr).toFixed(1)} s)`);
  try {
    const wav = encodeWav(resample16k(seg.chunks, seg.len, cap.sr));
    fetch(`/api/stt/${seg.talkId}`, { method: 'POST', body: wav, headers: { authorization: 'Bearer ' + S.session.token, 'content-type': 'audio/wav' } }).catch(() => {});
  } catch (err) { noRec('błąd przygotowania nagrania: ' + (err?.message || err)); }
}

// Zmiana częstotliwości na 16 kHz (uśrednianie w oknie = prosty filtr antyaliasingowy, wystarczający dla mowy)
function resample16k(chunks, len, sr) {
  const all = new Float32Array(len);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  if (sr === 16000) return all;
  const r = sr / 16000, n = Math.floor(len / r), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * r), b = Math.min(len, Math.floor((i + 1) * r));
    let sum = 0; for (let j = a; j < b; j++) sum += all[j];
    out[i] = b > a ? sum / (b - a) : all[a] || 0;
  }
  return out;
}
function encodeWav(f) {
  const buf = new ArrayBuffer(44 + f.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f.length * 2, true);
  for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// Wykrywanie przerw w mowie przy długim nadawaniu (kłódka): poziom głośności liczony z nagrywanego dźwięku
const SEG = { minLen: 4000, pause: 700, longLen: 18000, longPause: 300, maxLen: 30000 };
let voiceLvl = 0.02;
function detectPause(f) {
  const seg = cap.seg;
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length), ms = (f.length / cap.sr) * 1000;
  // próg ciszy dopasowuje się do głośności mówiącego (i szumu na sali)
  const quiet = rms < Math.max(0.004, voiceLvl * 0.18);
  if (!quiet) { voiceLvl = voiceLvl * 0.95 + rms * 0.05; seg.speechMs += ms; }
  seg.quietMs = quiet ? seg.quietMs + ms : 0;
  const len = Date.now() - seg.since;
  if (seg.speechMs < 800) { // w tym fragmencie nikt jeszcze nie mówi (kłódka, cisza) – nie twórz pustych wpisów
    if (len >= SEG.maxLen) { seg.chunks = []; seg.len = 0; seg.since = Date.now(); }
    return;
  }
  if ((len >= SEG.minLen && seg.quietMs >= SEG.pause) || (len >= SEG.longLen && seg.quietMs >= SEG.longPause) || len >= SEG.maxLen) cutSegment();
}

// Safari (Mac i iPhone) potrafi po jakimś czasie „uśpić” mikrofon: ścieżka jest wyciszona przez system albo zakończona
// i odciszenie nic nie daje (cisza do odświeżenia strony). Wtedy pobieramy mikrofon od nowa – w tej samej stronie bez pytania.
const micHealthy = () => { const t = S.micPub?.track?.mediaStreamTrack; return !!t && t.readyState === 'live' && !t.muted; };
let micFixing = null;
function reviveMic(why) {
  if (micFixing) return micFixing;
  micFixing = (async () => {
    const tr = S.micPub?.track;
    if (!tr) return false;
    try {
      const c = micConstraints();
      await tr.restartTrack({ ...c, ...(c.deviceId ? { deviceId: { exact: c.deviceId } } : {}) });
      if (S.micPub?.isMuted && !S.pttOn) tr.mediaStreamTrack.enabled = false; // nadal wyciszony, dopóki nie mówisz
      if (actx) await ensureCapture();
      console.info('[ik] mikrofon wznowiony:', why);
      return true;
    } catch (err) {
      sysMsg('Mikrofon przestał odpowiadać, a przeglądarka nie dała go ponownie (' + (err?.message || err) + '). Odśwież stronę.');
      return false;
    }
  })().finally(() => { micFixing = null; });
  return micFixing;
}
// sprawdzanie co kilka sekund i po powrocie na kartę – żeby mikrofon był gotowy, zanim ktoś naciśnie „mów”
setInterval(() => { if (!NAT && S.micPub && !S.pttOn && !micRelease() && document.visibilityState === 'visible' && !micHealthy()) reviveMic('sprawdzanie'); }, 5000);
document.addEventListener('visibilitychange', () => { if (!NAT && S.micPub && !micRelease() && document.visibilityState === 'visible' && !micHealthy()) setTimeout(() => !micHealthy() && reviveMic('powrót na kartę'), 800); });

function startTalk() {
  if (NAT) { // mikrofon i nagranie do transkrypcji po stronie natywnej
    if (!canTalk() || S.pttOn) return;
    S.pttOn = true;
    const talkId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    S.talkId = talkId;
    NAT.setMic({ on: true, talkId, channel: S.active }).catch(() => {});
    wsSend({ t: 'ptt', channel: S.active, on: true, talkId });
    $('#ptt').classList.add('live'); $('#ptt .ptt-l1').textContent = 'MÓWISZ'; vibrate(25);
    return;
  }
  if (!canTalk() || S.pttOn || !S.micPub) return;
  S.pttOn = true; progLevel();
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); applyCtxSink(); } catch {}
  clearTimeout(stopTimer); clearTimeout(recStopTimer); stopRecording();
  const talkId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  S.talkId = talkId;
  // nagranie startuje od razu (z buforem sprzed wciśnięcia), jeśli kopia mikrofonu żyje;
  // po wygaszeniu ekranu iOS kończy ścieżkę – wtedy LiveKit ją podmienia przy unmute i nagranie rusza po nim
  const healthy = micHealthy();
  const ready = healthy && capLive() && cap.from === S.micPub.track?.mediaStreamTrack;
  if (ready) startRecording(talkId);
  if (S.micPub.track) S.micPub.track.stopOnMute = micRelease();
  // mikrofon zamknięty między wypowiedziami (micRelease): LiveKit otwiera go sam przy odciszeniu
  const unmuted = healthy || micRelease() ? S.micPub.unmute() : reviveMic('naciśnięcie mów').then(() => S.micPub?.unmute());
  // mikrofon „żyje”, ale daje cyfrową ciszę (Safari) – po chwili pobierz go od nowa, mówienie trwa dalej
  if (healthy) setTimeout(() => {
    if (S.pttOn && S.talkId === talkId && capLive() && Date.now() - (cap.sound || 0) > 1500) reviveMic('cisza z mikrofonu').then((ok) => { if (ok && S.pttOn && S.talkId === talkId) S.micPub?.unmute(); });
  }, 1800);
  wsSend({ t: 'ptt', channel: S.active, on: true, talkId });
  if (!ready) Promise.resolve(unmuted).catch(() => {}).then(() => { if (S.pttOn && S.talkId === talkId) startRecording(talkId); });
  $('#ptt').classList.add('live');
  $('#ptt .ptt-l1').textContent = 'MÓWISZ';
  vibrate(25);
}
let stopTimer, recStopTimer;
function stopTalk() {
  if (NAT) {
    if (!S.pttOn) return;
    S.pttOn = false;
    NAT.setMic({ on: false }).catch(() => {});
    wsSend({ t: 'ptt', on: false });
    $('#ptt').classList.remove('live'); renderPttLabel();
    return;
  }
  if (!S.pttOn) return;
  S.pttOn = false; progLevel();
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => { if (!S.pttOn) S.micPub?.mute(); }, 250); // nie ucinaj końcówki na żywo
  clearTimeout(recStopTimer);
  recStopTimer = setTimeout(() => { if (!S.pttOn) { stopRecording(); if (micRelease()) stopCapture(); } }, TAIL_MS); // ani w nagraniu do transkrypcji; zamknięty mikrofon = bez kopii
  wsSend({ t: 'ptt', on: false });
  $('#ptt').classList.remove('live');
  renderPttLabel();
}
function renderPttLabel() {
  if (!canTalk()) return;
  $('#pttTarget').textContent = `→ ${chan(S.active).name}`;
  if (!S.pttOn) $('#ptt .ptt-l1').textContent = S.pttLocked ? 'Mikrofon włączony – dotknij 🔒' : S.opt.boom && !NAT ? 'Opuść pałąk albo przytrzymaj' : 'Przytrzymaj i mów';
}
const ptt = $('#ptt');
// Telefon + prawo mówienia: domyślnie duży przycisk mówienia, pole tekstu pod ⌨️ (więcej miejsca na wiadomości)
$('#btnToText').onclick = () => { document.body.classList.add('typing'); $('#msgInput').focus(); };
$('#btnToPtt').onclick = () => { document.body.classList.remove('typing'); $('#msgInput').blur(); };
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); try { ptt.setPointerCapture?.(e.pointerId); } catch {} if (!S.pttLocked) startTalk(); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => ptt.addEventListener(ev, () => { if (!S.pttLocked && !boom.talk) stopTalk(); }));
ptt.addEventListener('contextmenu', (e) => e.preventDefault());
$('#pttLock').onclick = () => {
  S.pttLocked = !S.pttLocked;
  $('#pttLock').setAttribute('aria-pressed', S.pttLocked);
  if (S.pttLocked) startTalk(); else stopTalk();
  renderPttLabel();
};
// iPhone (ekran początkowy): po schowaniu klawiatury iOS potrafi zostawić stronę przesuniętą – wtedy dotyk trafia
// w inne miejsce niż widać. Przywracamy położenie po wyjściu z pola tekstowego i po zmianie widocznego obszaru.
const resetShift = () => { if (window.scrollX || window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } };
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement?.matches?.('input, textarea, select')) resetShift(); }, 60));
window.visualViewport?.addEventListener('resize', () => { if (!document.activeElement?.matches?.('input, textarea')) resetShift(); });
window.addEventListener('orientationchange', () => setTimeout(resetShift, 300));

// Spacja na komputerze = PTT
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && !$('#main').hidden) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !S.pttLocked && !boom.talk) stopTalk(); });
// Strzałki / pilot do prezentacji: → lub PageDown = następny punkt, ← lub PageUp = poprzedni
let lastStep = 0;
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (!['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(k)) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.altKey || e.ctrlKey || e.metaKey || $('#main').hidden) return;
  if (!S.plan || !(S.perm.liveControl || S.perm.manualPlan)) return;
  e.preventDefault();
  if (e.repeat || Date.now() - lastStep < 400) return; // przytrzymanie klawisza nie przeskakuje kilku punktów
  lastStep = Date.now();
  planStep(k === 'ArrowRight' || k === 'PageDown' ? 1 : -1);
});
function planStep(dir) {
  if (S.perm.liveControl) return liveStep(dir);
  // bez sterowania PC Live (punkt ustawiany ręcznie): sąsiedni punkt planu
  const items = (S.plan.items || []).filter((x) => x.type !== 'header');
  const i = items.findIndex((x) => x.id === S.plan.currentItemId);
  const t = items[i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + dir))];
  if (t) { wsSend({ t: 'planCurrent', itemId: t.id }); vibrate(20); }
}
window.addEventListener('blur', () => { if (!S.pttLocked && !boom.talk) stopTalk(); });

// ================= PAŁĄK SŁUCHAWEK =================
// Słuchawki z wyciszaniem mikrofonu podniesieniem pałąka odcinają mikrofon – telefon dostaje wtedy (prawie) zero.
// Opuszczony pałąk zawsze daje jakiś szum tła, więc po poziomie sygnału widać, gdzie jest pałąk: w dół = mówi, w górę = koniec.
// Próg z kalibracji (opuść / podnieś), z histerezą; podniesienie musi trwać chwilę, żeby pauza w mowie nie kończyła mówienia.
const boom = { state: null, lvl: -120, since: 0, talk: false, cal: null, shown: 0 };
const BOOM_DOWN_MS = 120, BOOM_UP_MS = 500;
const boomThr = () => (Number.isFinite(S.opt.boomThr) ? S.opt.boomThr : -85); // bez kalibracji: tylko prawie cyfrowa cisza = pałąk w górę
function boomFeed(f) {
  let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i];
  const db = Math.max(-120, 10 * Math.log10(e / f.length + 1e-14));
  boom.lvl = db;
  if (boom.cal) boom.cal.vals.push(db);
  const ms = (f.length / (cap.sr || 48000)) * 1000;
  const thr = boomThr();
  const want = db > thr + 2 ? 'down' : db < thr - 2 ? 'up' : boom.state; // histereza ±2 dB
  if (want !== boom.pend) { boom.pend = want; boom.pendMs = 0; }
  boom.pendMs = (boom.pendMs || 0) + ms;
  if (want && want !== boom.state && boom.pendMs >= (want === 'down' ? BOOM_DOWN_MS : BOOM_UP_MS)) boomSet(want);
  if (Date.now() - boom.shown > 250) { boom.shown = Date.now(); renderBoom(); }
}
function boomSet(st) {
  boom.state = st;
  renderBoom();
  if (!S.opt.boom || boom.cal || NAT || !canTalk()) return;
  if (st === 'down' && !S.pttOn) { boom.talk = true; startTalk(); }
  else if (st === 'up' && boom.talk) { boom.talk = false; if (!S.pttLocked) stopTalk(); }
}
function renderBoom() {
  const el = $('#boomState'); if (!el || $('#sheet').hidden || $('#sheetSettings').hidden) return;
  if (boom.cal) { el.textContent = boom.cal.msg; return; }
  const st = !capLive() ? 'mikrofon nieaktywny' : boom.state === 'down' ? '<b class="dn">⬇ opuszczony</b>' : boom.state === 'up' ? '<b class="up">⬆ podniesiony</b>' : '…';
  el.innerHTML = `Pałąk: ${st} · sygnał ${Math.round(boom.lvl)} dB · próg ${Math.round(boomThr())} dB${Number.isFinite(S.opt.boomThr) ? '' : ' (bez kalibracji)'}`;
}
function boomEnsure() { if (S.opt.boom && !NAT && S.micPub && actx && !capLive()) ensureCapture(); }
setInterval(boomEnsure, 2000);
$('#optBoom').onchange = (e) => {
  unlockAudio();
  S.opt.boom = e.target.checked; store.set('opt', S.opt);
  if (!S.opt.boom && boom.talk) { boom.talk = false; if (!S.pttLocked) stopTalk(); }
  applyMicRelease(); boomEnsure(); renderBoom(); renderPttLabel();
  if (S.opt.boom && boom.state === 'down') boomSet('down'); // pałąk już opuszczony w chwili włączenia
  if (S.opt.boom && !Number.isFinite(S.opt.boomThr)) sysMsg('Pałąk: skalibruj słuchawki (⚙️ → Mikrofon → 📏 Kalibruj), żeby apka pewnie rozpoznawała jego położenie.');
};
$('#boomCal').onclick = async () => {
  unlockAudio();
  if (!S.micPub) return sysMsg('Kalibracja wymaga prawa mówienia (mikrofon jest włączany po zalogowaniu z PIN-em mówiącego).');
  if (!(await ensureCapture())) return sysMsg('Brak dostępu do mikrofonu.');
  const btn = $('#boomCal'); btn.disabled = true;
  const step = async (msg, ms) => { boom.cal = { vals: [], msg }; renderBoom(); await new Promise((ok) => setTimeout(ok, 800)); boom.cal.vals = []; await new Promise((ok) => setTimeout(ok, ms)); return boom.cal.vals.slice(); };
  try {
    const dn = await step('1/2 – OPUŚĆ pałąk (mikrofon przy ustach) i nic nie mów… 3 s', 3000);
    const up = await step('2/2 – PODNIEŚ pałąk… 3 s', 3000);
    boom.cal = null;
    const pctl = (a, q) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * q))] : -120; };
    const lDn = pctl(dn, 0.2), lUp = pctl(up, 0.9); // opuszczony: cichsze chwile (bez mowy); podniesiony: głośniejsze (trzaski, resztki)
    const gap = lDn - lUp;
    if (gap < 6) { sysMsg(`Pałąk: nie widać różnicy (opuszczony ${Math.round(lDn)} dB, podniesiony ${Math.round(lUp)} dB). Te słuchawki nie odcinają mikrofonu albo telefon wycisza ciszę – wyłącz redukcję szumów i wzmocnienie i spróbuj ponownie.`); return; }
    S.opt.boomThr = Math.round(lUp + gap * 0.4); store.set('opt', S.opt);
    sysMsg(`Pałąk skalibrowany: opuszczony ${Math.round(lDn)} dB, podniesiony ${Math.round(lUp)} dB → próg ${S.opt.boomThr} dB.${gap < 15 ? ' Różnica jest niewielka – w cichej sali apka może się mylić.' : ''}`);
  } finally { boom.cal = null; btn.disabled = false; renderBoom(); }
};

function renderTalkNow() {
  const parts = [];
  for (const [uid, ch] of S.talking) {
    const u = S.users.get(uid); if (!u) continue;
    const heard = shouldHear(uid);
    if (uid === S.me.id) continue; // własne mówienie widać na przycisku
    if (isDm(ch)) { parts.push(`${u.name} szepcze do Ciebie`); continue; }
    parts.push(`${u.name} → ${chan(ch)?.name || ch}${heard ? '' : ' (nie słuchasz)'}`);
  }
  const bar = $('#talkBar');
  bar.hidden = !parts.length;
  document.querySelector('.top').classList.toggle('talking', parts.length > 0);
  bar.innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('');
  bar.title = parts.join(' · ');
}

// ================= TTS / DŹWIĘK / WIBRACJE =================
let ttsVoice = null;
function pickVoice() {
  const vs = speechSynthesis?.getVoices?.() || [];
  ttsVoice = vs.find((v) => v.lang?.toLowerCase().startsWith('pl') && v.localService) || vs.find((v) => v.lang?.toLowerCase().startsWith('pl')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (S.opt.ttsMute) return; // wyciszone w mikserze
  // w aplikacji lektor jest natywny: działa też w tle i przy zablokowanym ekranie (synteza mowy w WebView bywa niema)
  if (NAT && typeof NAT.speak === 'function') { NAT.speak({ text, volume: Math.max(0, Math.min(1, pct(S.opt.ttsVol, 100) / 100)) }).catch(() => {}); return; }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL'; if (ttsVoice) u.voice = ttsVoice; u.rate = 1.1;
  u.volume = Math.max(0, Math.min(1, pct(S.opt.ttsVol, 100) / 100));
  speechSynthesis.speak(u);
}
function speak(m) {
  if (m.type === 'stream') { if (S.opt.streamTts !== false) say(m.text.replace(/^[^\p{L}\p{N}]+/u, '')); return; }
  if (m.type === 'plan') { // zmiana punktu planu – własny przełącznik
    if (S.opt.planTts !== false) say(`Teraz: ${m.nowTitle}.${myNotes(m).map((n) => ` ${n.category}: ${n.text}.`).join('')}${m.nextTitle ? ` Następnie: ${m.nextTitle}.` : ''}`);
    return;
  }
  if (!S.opt.tts || m.type === 'system') return;
  const prefix = isDm(m.channel) ? 'Prywatnie. ' : m.channel === S.active ? '' : `${chan(m.channel)?.name}. `;
  say(`${prefix}${m.fromName}: ${m.text}`);
}

// Stan transmisji live (Web Presenter) – znaczek w nagłówku
function setStreams(list) {
  S.streams = list;
  const b = $('#liveBadge');
  $('#optStreamRow').hidden = !list.length;
  const sending = (x) => x.online && (x.status === 'Streaming' || x.status === 'Interrupted');
  // publicznie na żywo: według platformy (YouTube/Facebook), a bez połączonej platformy – według Web Presentera
  const pub = list.filter((x) => (x.platformOn ? x.live : sending(x)));
  const preview = list.filter((x) => x.platformOn && !x.live && sending(x));
  const bad = list.some((x) => x.status === 'Interrupted' || (x.status === 'Streaming' && x.cache >= 50) || (x.platformOn && x.live && !sending(x)));
  const show = pub.length ? pub : preview;
  b.hidden = !show.length;
  b.className = 'live-badge' + (bad ? ' bad' : pub.length ? '' : ' preview');
  b.innerHTML = `${bad ? '⚠' : pub.length ? '●' : '◌'} ${pub.length ? 'LIVE' : 'PODGLĄD'}<span class="lb-names"> ${esc(show.map((x) => x.name).join(' · '))}</span>`;
  b.title = list.map((x) => `${x.name}: ${x.platformOn ? (x.live ? 'na żywo publicznie' : 'niepubliczna') + ' · ' : ''}Web Presenter ${!x.online ? 'brak kontaktu' : x.status || '?'}${x.duration ? ' · ' + x.duration : ''}${x.cache ? ` · bufor ${x.cache}%` : ''}`).join('\n');
}

let actx = null;
function unlockAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    actx.resume();
    progUseCtx();
    applyCtxSink();
    if (S.micPub && !micRelease()) ensureCapture();
    if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); }
  } catch {}
}
function beep() {
  if (S.opt.beepMute) return;
  if (NAT && typeof NAT.beep === 'function') { NAT.beep({ volume: Math.max(0, Math.min(1, pct(S.opt.beepVol, 100) / 100)) }).catch(() => {}); return; }
  if (!actx) return;
  const peak = Math.max(0.0002, 0.3 * pct(S.opt.beepVol, 100) / 100);
  const t = actx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 1100; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t + i * 0.22);
    g.gain.exponentialRampToValueAtTime(peak, t + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.16);
    o.start(t + i * 0.22); o.stop(t + i * 0.22 + 0.18);
  }
}
const vibrate = (p) => { if (S.opt.vibrate && navigator.vibrate) navigator.vibrate(p); };

let wakeLock = null;
async function applyWake() {
  try {
    if (S.opt.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    else if (!S.opt.wake && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { wsSend({ t: 'vis', hidden: document.hidden }); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { applyWake(); showAudioHintIfNeeded(); } });

// ================= STATUS POŁĄCZENIA =================
function setConn() {
  const wsOk = S.ws?.readyState === 1;
  const lkOk = NAT ? S.natState === 'connected' : S.room?.state === 'connected';
  const d = $('#conn');
  d.className = 'dot' + (wsOk && lkOk ? ' on' : wsOk ? ' half' : '');
  d.title = `Tekst: ${wsOk ? 'OK' : 'brak'} · Głos: ${lkOk ? 'OK' : 'brak'}`;
}
// Moderacja: ktoś (reżyser / administrator) wyciszył mnie albo przeniósł na inny kanał
const modOnce = (k) => { S.lastMod ||= {}; if (Date.now() - (S.lastMod[k] || 0) < 3000) return false; S.lastMod[k] = Date.now(); return true; }; // ta sama informacja z serwera i z aplikacji
function onModMuted(by) {
  if (!modOnce('mute')) return;
  boom.talk = false;
  if (S.pttLocked) { S.pttLocked = false; $('#pttLock').setAttribute('aria-pressed', 'false'); }
  stopTalk();
  renderPttLabel();
  beep(); vibrate([300, 100, 300]);
  const text = `${by} wyciszył(a) Twój mikrofon – był włączony. Aby mówić, naciśnij przycisk ponownie.`;
  toast({ channel: S.broadcast, fromName: '🔇 Wyciszono', text, plan: true, urgent: true });
  sysMsg('🔇 ' + text);
  say(`${by} wyciszył Twój mikrofon.`);
}
function onModMoved(ch, by, wasTalking) {
  const c = chan(ch); if (!c || !modOnce('move')) return;
  const keep = S.pttOn && (S.pttLocked || boom.talk); // mówienie „na stałe” (kłódka, pałąk) – kontynuuj na nowym kanale
  if (!S.listen.has(ch)) { S.listen.add(ch); store.set('listen:' + S.me.id, [...S.listen]); store.set('listen', [...S.listen]); wsSend({ t: 'listen', channels: [...S.listen] }); }
  setActive(ch);
  if (keep) startTalk();
  beep(); vibrate([200, 100, 200]);
  const text = `${by} przeniósł(a) Cię na kanał ${c.name}${wasTalking && !keep ? ' – mówiłeś na innym kanale. Naciśnij ponownie, żeby mówić' : ''}.`;
  toast({ channel: ch, fromName: '↪ Zmiana kanału', text, plan: true, urgent: true });
  sysMsg('↪ ' + text);
  say(`Przeniesiono Cię na kanał ${c.name}.`);
}
function sysMsg(text) {
  addMsg({ id: 's' + Date.now() + Math.random(), type: 'system', channel: S.active, ts: Date.now(), text }, false);
  appendMsgEl({ type: 'system', text }, true);
}

// ================= PANEL USTAWIEŃ / OSÓB =================
function openSheet(which) {
  if (which === 'plan' && splitOn()) { renderPlanSheet(); return; }
  $('#sheet').hidden = false;
  $('#sheetSettings').hidden = which !== 'settings';
  $('#sheetPeople').hidden = which !== 'people';
  if (!splitOn()) $('#sheetPlan').hidden = which !== 'plan';
  $('#sheetTitle').textContent = { people: 'Kto jest online', plan: 'Plan nabożeństwa', settings: 'Ustawienia' }[which];
  if (which === 'people') renderPeople();
  else if (which === 'plan') renderPlanSheet();
  else { renderSettings(); if (!$('#pcoAdmin').hidden) wsSend({ t: 'pcoPlans' }); }
}
$('#btnSettings').onclick = () => openSheet('settings');
$('#btnPeople').onclick = () => openSheet('people');
function closeSheet() { $('#sheet').hidden = true; if (micRelease() && !S.pttOn) applyMicRelease(); } // podgląd mikrofonu w ustawieniach – zamknij
$('#sheetClose').onclick = closeSheet;
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
// w ustawieniach mikrofon jest otwarty (wyciszony dla innych), żeby wskaźnik poziomu działał także w trybie „otwierany przy mówieniu”
async function micPreview() {
  if (!S.micPub?.track) return;
  if (micRelease() && !S.pttOn && !micHealthy()) { try { await reviveMic('podgląd w ustawieniach'); } catch {} }
  ensureCapture();
}

function renderSettings() {
  const myNicks = S.users.get(S.me?.id)?.nicks || [];
  if (document.activeElement !== $('#optNicks')) $('#optNicks').value = myNicks.join(', ');
  renderDevices();
  // wskaźnik poziomu; gdy mikrofon był zamknięty (komputer), po jego otwarciu przeglądarka odsłania pełną listę urządzeń
  if (canTalk() && S.micPub) { unlockAudio(); micPreview().then(() => { if (!$('#sheet').hidden && !$('#sheetSettings').hidden) renderDevices(); }); }
  renderNoteCats();
  const list = $('#listenList');
  list.innerHTML = '';
  for (const c of S.channels) {
    const l = document.createElement('label');
    l.style.setProperty('--c', c.color);
    l.innerHTML = `<input type="checkbox" ${S.listen.has(c.id) ? 'checked' : ''}><span class="sw"></span>${esc(c.name)}`;
    l.querySelector('input').onchange = (e) => {
      e.target.checked ? S.listen.add(c.id) : S.listen.delete(c.id);
      store.set('listen:' + S.me.id, [...S.listen]); store.set('listen', [...S.listen]);
      wsSend({ t: 'listen', channels: [...S.listen] });
      savePushPrefs();
      updateGates(); renderTabs(); renderTalkNow();
    };
    list.appendChild(l);
  }
  const oc = $('#optCols');
  oc.value = String(Math.max(1, Math.min(4, Number(S.opt.cols) || 1)));
  oc.onchange = () => { S.opt.cols = Number(oc.value); store.set('opt', S.opt); renderCols(); };
  const lay = $('#optLayout');
  lay.value = S.opt.layout || 'auto';
  lay.onchange = () => { S.opt.layout = lay.value; store.set('opt', S.opt); applyLayout(); };
  const ss = $('#optSttShow');
  ss.value = S.opt.sttShow || 'always';
  $('#optSttRow').hidden = !S.session.stt;
  ss.onchange = () => { S.opt.sttShow = ss.value; store.set('opt', S.opt); renderFeed(); };
  for (const [id, key] of [['#optVoice', 'voice'], ['#optTts', 'tts'], ['#optVibrate', 'vibrate'], ['#optWake', 'wake'], ['#optPlan', 'planTts'], ['#optStream', 'streamTts']]) {
    const el = $(id); el.checked = key === 'planTts' || key === 'streamTts' ? S.opt[key] !== false : !!S.opt[key];
    el.onchange = () => {
      S.opt[key] = el.checked; store.set('opt', S.opt);
      if (key === 'voice') { updateGates(); renderFeed(); nativeSync(); renderMixer(); }
      if (key === 'wake') applyWake();
      if (key === 'tts' && el.checked) { unlockAudio(); say('Czytanie wiadomości włączone'); }
    };
  }
}
$('#btnTestTts').onclick = () => { unlockAudio(); say('To jest test syntezy mowy.'); beep(); };
$('#btnLogout').onclick = async () => {
  // ten telefon przestaje dostawać powiadomienia tej osoby
  try {
    const sub = await swReg?.pushManager.getSubscription();
    await fetch('/api/push/logout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.session.token }, body: JSON.stringify({ endpoint: sub?.endpoint || '' }), signal: AbortSignal.timeout(3000) });
  } catch {}
  try { await NAT?.disconnect(); } catch {}
  store.del('token'); S.room?.disconnect(); location.reload();
};
// aplikacja: powrót do ekranu wyboru serwera (lista serwerów w sieci, ostatnie, adres ręcznie)
if (NAT && typeof NAT.getServer === 'function') {
  const host = location.host;
  for (const id of ['#btnSrv', '#btnSrvLogin']) {
    const b = $(id); b.hidden = false; b.textContent = `🔁 Zmień serwer (${host})`;
    b.onclick = async () => { try { await NAT.disconnect(); } catch {} location.href = 'ikapp://reset'; };
  }
}
$('#btnClear').onclick = () => { if (window.confirm('Wyczyścić czat na wszystkich kanałach?')) wsSend({ t: 'clear' }); };

// ================= WEZWANIA =================
let callCur = null, callBeep = null;
function showCall(m) {
  callCur = m;
  $('#callAv').innerHTML = avatar(m.from.pid, m.from.name);
  $('#callFrom').textContent = m.from.name;
  $('#callText').textContent = m.text || 'wzywa Cię';
  $('#callBox').hidden = false;
  beep(); clearInterval(callBeep); callBeep = setInterval(beep, 2500);
  if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]); // wezwanie wibruje zawsze
  say(`Wzywa Cię ${m.from.name}.${m.text ? ' ' + m.text : ''}`);
  setTimeout(() => { if (callCur === m) answerCall(null); }, 60000);
}
function answerCall(answer) {
  clearInterval(callBeep);
  $('#callBox').hidden = true;
  if (callCur && answer) wsSend({ t: 'callReply', to: callCur.from.id, callId: callCur.callId, answer });
  callCur = null;
}
$('#callYes').onclick = () => answerCall('yes');
$('#callNo').onclick = () => answerCall('no');
function openCall(u, row) {
  const had = row.nextElementSibling?.classList.contains('callform');
  $$('#peopleList .callform').forEach((f) => f.remove()); // także formularz moderacji
  if (had) return; // drugie stuknięcie zamyka
  if (!row) return;
  const f = document.createElement('div');
  f.className = 'callform';
  f.innerHTML = `<input maxlength="140" placeholder="Wiadomość (opcjonalnie), np. zbliżenie na mówcę"><button type="button" class="primary">📣 Wezwij</button><button type="button" class="dmbtn">💬 Napisz</button>`;
  row.after(f);
  if (S.perm?.moderate || S.me.role === 'admin') { // reżyser / administrator: wyciszenie, przeniesienie, transkrypcja
    const mod = document.createElement('div');
    mod.className = 'callform modform';
    const chOpts = S.channels.map((c) => `<option value="${esc(c.id)}" ${c.id === (S.talking.get(u.id) || u.target) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    mod.innerHTML = (S.perm?.moderate ? `<button type="button" class="m-mute">🔇 Wycisz</button><select class="m-ch" aria-label="Kanał">${chOpts}</select><button type="button" class="m-move">↪ Przenieś</button>` : '')
      + (S.me.role === 'admin' && S.session.stt ? `<button type="button" class="m-stt">${u.sttOff ? '📝 Włącz transkrypcję' : '📝 Wyłącz transkrypcję'}</button>` : '');
    f.after(mod);
    mod.querySelector('.m-mute')?.addEventListener('click', () => { wsSend({ t: 'modMute', to: u.id }); mod.remove(); f.remove(); });
    mod.querySelector('.m-move')?.addEventListener('click', () => { wsSend({ t: 'modMove', to: u.id, channel: mod.querySelector('.m-ch').value }); mod.remove(); f.remove(); });
    mod.querySelector('.m-stt')?.addEventListener('click', () => { wsSend({ t: 'sttUser', to: u.id, off: !u.sttOff }); mod.remove(); f.remove(); });
  }
  const inp = f.querySelector('input');
  const go = () => { unlockAudio(); wsSend({ t: 'call', to: u.id, text: inp.value }); f.remove(); };
  f.querySelector('button.primary').onclick = go;
  f.querySelector('.dmbtn').onclick = () => {
    ensureDm(u.key, u.name, u.pid);
    $('#sheet').hidden = true;
    setActive('dm:' + u.key);
    if (inp.value.trim()) { wsSend({ t: 'msg', channel: 'dm:' + u.key, text: inp.value.trim() }); }
    $('#msgInput').focus();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  inp.focus();
}

const osoby = (n) => `${n} ${n === 1 ? 'osoba' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'osoby' : 'osób'}`;
function renderPeople() {
  const box = $('#peopleList');
  const all = [...S.users.values()];
  const speakers = all.filter((u) => u.role !== 'listener').length;
  const row = (u, c) => {
    const talk = S.talking.get(u.id);
    const badge = talk === c.id ? '<span class="pbadge live">🎙 MÓWI</span>'
      : u.role !== 'listener' ? '<span class="pbadge can">🎙 może mówić</span>'
      : '<span class="pbadge">👂 słucha / czyta</span>';
    const here = u.target === c.id ? '<span class="here">ma otwarty ten kanał</span>' : '';
    return `<li style="--c:${c.color}" data-uid="${esc(u.id)}" class="${u.id === S.me.id ? '' : 'callable'}">${avatar(u.pid, u.name)}<span class="nm"><span class="nm1">${esc(u.name)}${u.id === S.me.id ? ' (Ty)' : ''}${u.sttOff && S.session.stt ? ' <span class="here" title="Bez transkrypcji">📝✕</span>' : ''}</span>${u.nicks?.length ? `<span class="here nk">${u.nicks.map((n) => '@' + esc(n)).join(' ')}</span>` : ''}${here}</span>${badge}</li>`;
  };
  const byName = (a, b) => (b.role !== 'listener') - (a.role !== 'listener') || a.name.localeCompare(b.name, 'pl');
  let html = `<p class="people-sum">Online: <b>${all.length}</b> · mogą mówić: <b>${speakers}</b></p>`;
  const empty = [];
  for (const c of S.channels) {
    const members = all.filter((u) => u.listen.includes(c.id)).sort(byName);
    if (!members.length) { empty.push(c); continue; }
    const sp = members.filter((u) => u.role !== 'listener').length;
    const sttBtn = S.me.role === 'admin' && S.session.stt ? `<button type="button" class="chstt" data-ch="${esc(c.id)}" title="Transkrypcja na tym kanale">${(S.session.sttOff || []).includes(c.id) ? '📝 wył.' : '📝 wł.'}</button>` : '';
    html += `<section class="pgroup" style="--c:${c.color}"><h4>${esc(c.name)}${sttBtn}<small>${osoby(members.length)}${sp ? ` · mówi: ${sp}` : ''}</small></h4>
      <ul class="people">${members.map((u) => row(u, c)).join('')}</ul></section>`;
  }
  if (empty.length) html += `<p class="people-empty">Nikt nie słucha: ${empty.map((c) => `<span style="--c:${c.color}">${esc(c.name)}</span>`).join(', ')}</p>`;
  const none = all.filter((u) => !u.listen.length).sort(byName);
  if (none.length) html += `<section class="pgroup" style="--c:#6b7280"><h4>Bez kanału<small>${osoby(none.length)}</small></h4>
      <ul class="people">${none.map((u) => row(u, { id: '', color: '#6b7280' })).join('')}</ul></section>`;
  box.innerHTML = html + `<p class="hint">Stuknij osobę, aby ją wezwać${S.perm?.moderate ? ', wyciszyć albo przenieść na inny kanał' : ''}.</p>`;
  $$('#peopleList .chstt').forEach((b) => (b.onclick = () => wsSend({ t: 'sttChan', channel: b.dataset.ch, off: !(S.session.sttOff || []).includes(b.dataset.ch) })));
  $$('#peopleList li.callable').forEach((li) => (li.onclick = () => { const u = S.users.get(li.dataset.uid); if (u) openCall(u, li); }));
}

// ================= KANAŁY (mogą się zmienić – np. nowe zespoły w Planning Center) =================
function applyChannels(list) {
  if (!list?.length) return;
  S.channels = list;
  for (const id of [...S.listen]) if (!chan(id)) S.listen.delete(id);
  if (!S.listen.size) S.listen.add(S.broadcast);
  if (!chan(S.active)) S.active = [...S.listen][0];
  renderTabs(); renderSettings(); renderFeed();
  $('#msgInput').placeholder = `Napisz do: ${chan(S.active).name}…`;
  renderPttLabel();
}

// ================= PLAN NABOŻEŃSTWA (Planning Center) =================
S.plan = null;
const fmtLen = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '');
function setPlan(data, live) {
  const prev = S.plan?.currentItemId;
  if (liveWait) liveDone(); // odpowiedź serwera na przełączenie (plan wysyłany po każdym poleceniu)
  S.plan = data.plan || null;
  if (S.plan?.now) S.clockOffset = S.plan.now - Date.now(); // zegar serwera – odliczanie identyczne na wszystkich telefonach
  S.planError = data.ok === false ? data.error : null;
  renderPlanBar();
  renderNoteCats();
  if (!$('#sheetPlan').hidden) renderPlanSheet();
  // zmianę punktu ogłasza serwer wpisem „Plan” na kanale ogólnym (patrz msgEl / speak)
}
function planPos() {
  const items = S.plan?.items || [];
  const i = items.findIndex((x) => x.id === S.plan.currentItemId);
  const next = items.slice(i + 1).find((x) => x.type !== 'header');
  return { cur: i >= 0 ? items[i] : null, next: i >= 0 ? next : items.find((x) => x.type !== 'header') };
}
S.perm = { liveControl: false, manualPlan: false };
// Krótki opis utworu/punktu: tonacja · BPM · metrum · czas
function barMeta(it) { return [it.key && `${esc(it.key)}`, it.bpm && `${esc(it.bpm)} BPM`].filter(Boolean).join(' · '); }
function itemMeta(it) {
  return [it.key && `tonacja ${esc(it.key)}`, it.bpm && `${esc(it.bpm)} BPM`, it.meter && esc(it.meter), fmtLen(it.length)].filter(Boolean).join(' · ');
}
const myTeams = () => (S.me?.teams || []).map((t) => t.toLocaleLowerCase('pl'));
// Wybrane kolumny notatek z Planning Center (null = automatycznie: kolumny o nazwach moich zespołów)
const lc = (x) => String(x || '').toLocaleLowerCase('pl');
function noteWanted(n) {
  const sel = Array.isArray(S.opt.noteCats) ? S.opt.noteCats.map(lc) : myTeams();
  return !!n.category && sel.includes(lc(n.category));
}
const myNotes = (it) => (it?.notes || []).filter(noteWanted);
function renderNoteCats() {
  const cats = S.plan?.noteCategories || [];
  $('#optNotesRow').hidden = !S.session?.pco || !cats.length;
  const auto = !Array.isArray(S.opt.noteCats);
  $('#optNotesAuto').checked = auto;
  $('#optNoteCats').innerHTML = cats.map((c) => `<label><input type="checkbox" value="${esc(c)}" ${noteWanted({ category: c }) ? 'checked' : ''} ${auto ? 'disabled' : ''}> ${esc(c)}</label>`).join('');
  $('#optNotesAuto').onchange = (e) => {
    S.opt.noteCats = e.target.checked ? null : cats.filter((c) => noteWanted({ category: c }));
    store.set('opt', S.opt); renderNoteCats(); renderPlanBar(); renderFeed();
  };
  $$('#optNoteCats input').forEach((el) => (el.onchange = () => {
    S.opt.noteCats = $$('#optNoteCats input:checked').map((x) => x.value);
    store.set('opt', S.opt); renderPlanBar(); renderFeed();
  }));
}
// Pełne szczegóły punktu: aranżacja, sekwencja, notatki (notatki mojego zespołu wyróżnione)
function itemDetails(it) {
  const isMine = noteWanted;
  const notes = [...(it.notes || [])].sort((a, b) => isMine(b) - isMine(a));
  return [
    it.arrangement || it.author ? `<div class="pd">${[it.arrangement && `Aranżacja: ${esc(it.arrangement)}`, it.author && esc(it.author)].filter(Boolean).join(' · ')}</div>` : '',
    it.sequence?.length ? `<div class="seq">${it.sequence.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '',
    it.arrangementNotes ? `<div class="pnote"><b>Aranżacja:</b> ${esc(it.arrangementNotes)}</div>` : '',
    it.description ? `<div class="pd">${esc(it.description)}</div>` : '',
    ...notes.map((n) => `<div class="pnote ${isMine(n) ? 'mine' : ''}">${n.category ? `<b>${esc(n.category)}:</b> ` : ''}${esc(n.text)}</div>`),
  ].join('');
}
function renderPlanBar() {
  const bar = $('#planBar');
  if (!S.session?.pco || splitOn()) { bar.hidden = true; return; }
  bar.hidden = false;
  if (!S.plan) { bar.innerHTML = `<div class="pl-main"><span class="pl-muted">${S.planError ? '⚠️ Planning Center: ' + esc(S.planError) : 'Brak wydarzenia w Planning Center'}</span></div>`; bindBar(); return; }
  const { cur, next } = planPos();
  const ctl = S.perm.liveControl ? `<div class="pl-ctl" title="Także strzałki ← → na klawiaturze"><button type="button" data-dir="-1" aria-label="Poprzedni punkt">◀</button><button type="button" data-dir="1" aria-label="Następny punkt">▶</button></div>` : '';
  const hasNotes = (it) => it.notes?.length || it.arrangementNotes;
  const nowRow = cur
    ? `<div class="pl-row"><span class="pl-lbl" ${S.plan.live ? 'title="Planning Center Live"' : ''}>${S.plan.live ? '<i class="pcl"></i>' : ''}TERAZ</span><span class="pl-now">${esc(cur.title)}</span>${barMeta(cur) ? `<span class="pl-meta">${barMeta(cur)}</span>` : ''}${hasNotes(cur) ? '<span class="pl-note">📝</span>' : ''}<span class="pl-cd" data-cd></span></div>`
    : `<div class="pl-row"><span class="pl-lbl">PLAN</span><span class="pl-now">${esc(S.plan.title || S.plan.dates || 'Plan nabożeństwa')}</span></div>`;
  const nextRow = next ? `<div class="pl-row pl-nextrow"><span class="pl-lbl">${cur ? 'DALEJ' : 'START'}</span><span class="pl-next">${esc(next.title)}</span>${barMeta(next) ? `<span class="pl-meta">${barMeta(next)}</span>` : ''}</div>` : '';
  const mn = myNotes(cur);
  const notesRow = mn.length ? `<div class="pl-row pl-mynotes">${mn.map((n) => `<span><b>${esc(n.category)}:</b> ${esc(n.text)}</span>`).join('')}</div>` : '';
  bar.innerHTML = `<div class="pl-main">${nowRow}${notesRow}${nextRow}</div>${ctl}`;
  tickCountdown();
  bindBar();
}
function bindBar() {
  $('#planBar .pl-main').onclick = () => openSheet('plan');
  $$('#planBar .pl-ctl button').forEach((b) => (b.onclick = () => liveStep(Number(b.dataset.dir), b)));
}
// Sterowanie Planning Center Live: przycisk pokazuje, że polecenie poszło, i czeka na odpowiedź (zmiana planu albo błąd).
// Wcześniej brak reakcji (np. zajęte poprzednie przełączenie, wolne PC) wyglądał tak, jakby przycisk nie działał.
let liveWait = null;
function liveSent(btn) {
  clearTimeout(liveWait?.t);
  liveWait?.btn && (liveWait.btn.disabled = false, liveWait.btn.classList.remove('busy'));
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  liveWait = { btn, t: setTimeout(() => { liveDone(); toast({ channel: S.broadcast, fromName: '⚠️ Plan', text: 'Planning Center nie odpowiedział – sprawdź połączenie i spróbuj ponownie.', plan: true, urgent: true }); }, 12000) };
}
function liveDone() { if (!liveWait) return; clearTimeout(liveWait.t); if (liveWait.btn) { liveWait.btn.disabled = false; liveWait.btn.classList.remove('busy'); } liveWait = null; }
function liveStep(dir, btn) { if (!wsSend({ t: 'liveStep', dir })) return liveOffline(); liveSent(btn); vibrate(20); }
function liveOffline() { toast({ channel: S.broadcast, fromName: '⚠️ Plan', text: 'Brak połączenia z serwerem – punktu nie przełączono.', plan: true, urgent: true }); }
$$('#planCtl button').forEach((b) => (b.onclick = () => liveStep(Number(b.dataset.dir), b)));
// ---- widok podzielony: plan Planning Center obok okna komunikacji ----
const wide = window.matchMedia('(min-width: 900px)');
function applyLayout() {
  const mode = S.opt.layout || 'auto';
  $('#optLayoutRow').hidden = !S.session?.pco;
  const split = !!S.session?.pco && (mode === 'left' || mode === 'right' || (mode === 'auto' && wide.matches));
  document.body.classList.toggle('split-on', split);
  document.body.classList.toggle('plan-right', split && mode === 'right');
  const sp = $('#sheetPlan'), pane = $('#planPane');
  pane.hidden = !split;
  if (split && sp.parentElement !== pane) { pane.appendChild(sp); sp.hidden = false; renderPlanSheet(); }
  if (!split && sp.parentElement === pane) { $('#sheet .sheet-body').appendChild(sp); sp.hidden = true; }
  renderPlanBar();
}
wide.addEventListener?.('change', applyLayout);
const splitOn = () => document.body.classList.contains('split-on');

// ---- odliczanie czasu bieżącego punktu (wg czasu startu z Planning Center Live) ----
const fmtClock = (sec) => { const a = Math.abs(Math.round(sec)), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), x = String(a % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
function countdown() {
  const p = S.plan;
  if (!p?.currentItemId || !p.currentStartedAt) return null;
  const items = p.items || [], i = items.findIndex((x) => x.id === p.currentItemId), cur = items[i];
  if (!cur) return null;
  const now = Date.now() + (S.clockOffset || 0), elapsed = (now - p.currentStartedAt) / 1000;
  const len = cur.length || 0, left = len - elapsed;
  // przewidywany koniec: reszta bieżącego + długości kolejnych punktów
  const rest = items.slice(i + 1).filter((x) => x.type !== 'header').reduce((a, x) => a + (x.length || 0), 0);
  const end = new Date(now - (S.clockOffset || 0) + (Math.max(left, 0) + rest) * 1000);
  return { len, elapsed, left, end, hasRest: rest > 0 || len > 0 };
}
function tickCountdown() {
  const c = countdown();
  for (const el of document.querySelectorAll('[data-cd]')) {
    if (!c) { el.textContent = ''; el.className = el.className.replace(/ ?cd-(over|warn|up)/g, ''); continue; }
    const over = c.len && c.left < 0, warn = c.len && !over && c.left <= 60;
    el.textContent = !c.len ? `⏱ ${fmtClock(c.elapsed)}` : over ? `+${fmtClock(-c.left)}` : fmtClock(c.left);
    el.classList.toggle('cd-over', !!over); el.classList.toggle('cd-warn', !!warn); el.classList.toggle('cd-up', !c.len);
    el.title = !c.len ? 'Punkt bez ustalonej długości – czas od rozpoczęcia' : over ? 'Przekroczony czas punktu' : 'Pozostało do końca punktu';
  }
  for (const el of document.querySelectorAll('[data-end]')) el.textContent = c?.hasRest ? `koniec nabożeństwa ok. ${c.end.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}` : '';
}
setInterval(tickCountdown, 1000);

function renderPlanSheet() {
  const p = S.plan;
  $('#planCtl').hidden = !(p && S.perm.liveControl);
  if (!p) { $('#planMeta').textContent = S.planError || 'Brak planu.'; $('#planList').innerHTML = ''; $('#planNow').innerHTML = ''; return; }
  const can = S.perm.liveControl || S.perm.manualPlan;
  $('#planMeta').textContent = `${p.serviceTypeName || ''} · ${p.title || ''} ${p.dates || ''} · ${p.live ? 'Planning Center Live aktywny' : p.manual ? 'punkt ustawiony ręcznie' : 'Live nieaktywny'}`;
  const { cur, next } = planPos();
  const card = (label, it, cls) => it ? `<div class="pcard ${cls}"><div class="pc-lbl">${label}</div><div class="pt">${esc(it.title)}${itemMeta(it) ? `<span class="pm">${itemMeta(it)}</span>` : ''}</div>${itemDetails(it)}</div>` : '';
  $('#planNow').innerHTML = card(p.live ? 'TERAZ · LIVE' : 'TERAZ', cur, 'now') + card('NASTĘPNIE', next, 'next');
  const nowCard = $('#planNow .pcard.now');
  if (nowCard) nowCard.insertAdjacentHTML('afterbegin', '<div class="pc-cd"><span class="cd-big" data-cd></span><span class="cd-end" data-end></span></div>');
  tickCountdown();
  // cały program: jedna linia na punkt; szczegóły po dotknięciu (stan rozwinięcia i przewinięcia zostaje przy odświeżeniu)
  S.planOpen ||= new Set();
  const box = $('#planScroll'), keepScroll = box.scrollTop;
  const hasDet = (it) => it.notes?.length || it.arrangementNotes || it.description || it.sequence?.length || it.arrangement;
  $('#planList').innerHTML = p.items.map((it) => {
    if (it.type === 'header') return `<li class="ph">${esc(it.title)}</li>`;
    const cls = [it.id === p.currentItemId ? 'cur' : '', next && it.id === next.id ? 'nxt' : '', S.planOpen.has(it.id) ? 'open' : ''].join(' ');
    const meta = [it.key && esc(it.key), fmtLen(it.length)].filter(Boolean).join(' · ');
    const goBtn = can && it.id !== p.currentItemId ? `<button type="button" class="pgo" data-go="${esc(it.id)}">${S.perm.liveControl ? '▶ Przełącz Live na ten punkt' : '▶ Ustaw jako bieżący'}</button>` : '';
    return `<li class="${cls}" data-iid="${esc(it.id)}"><div class="prow"><span class="pt1">${esc(it.title)}</span>${hasDet(it) ? '<span class="pdot" title="Notatki / szczegóły">•</span>' : ''}<span class="pm">${meta}</span></div>`
      + `<div class="pdet">${itemMeta(it) ? `<div class="pd">${itemMeta(it)}</div>` : ''}${itemDetails(it)}${goBtn}</div></li>`;
  }).join('');
  box.scrollTop = keepScroll;
  // jedna obsługa dla całej listy (przetrwa przerysowanie listy w trakcie kliknięcia)
  // przewiń do bieżącego punktu tylko przy jego ZMIANIE i gdy nikt właśnie nie przewija listy
  if (p.currentItemId !== S.planScrolledTo && Date.now() - (S.planTouched || 0) > 15000) {
    S.planScrolledTo = p.currentItemId;
    requestAnimationFrame(() => {
      const li = $('#planList li.cur');
      if (li && box.scrollHeight > box.clientHeight) box.scrollTo({ top: Math.max(0, li.offsetTop - box.offsetTop - 40), behavior: 'smooth' });
    });
  }
}
['scroll', 'touchstart', 'wheel'].forEach((ev) => $('#planScroll').addEventListener(ev, () => { S.planTouched = Date.now(); }, { passive: true }));
$('#planList').addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : e.target?.parentElement; // Safari potrafi podać węzeł tekstowy
  if (!el) return;
  const go = el.closest('[data-go]');
  if (go) { // przełączenie tylko osobnym przyciskiem – przypadkowe dotknięcie listy nie zmienia punktu
    e.stopPropagation();
    const ok = S.perm.liveControl ? wsSend({ t: 'liveGoto', itemId: go.dataset.go }) : wsSend({ t: 'planCurrent', itemId: go.dataset.go });
    if (!ok) return liveOffline();
    if (S.perm.liveControl) { go.textContent = '⏳ Przełączam w Planning Center…'; liveSent(go); }
    vibrate(20); return;
  }
  const li = el.closest('li[data-iid]'); if (!li) return;
  const id = li.dataset.iid;
  S.planOpen.has(id) ? S.planOpen.delete(id) : S.planOpen.add(id);
  li.classList.toggle('open');
});

function renderPcoPlans(m) {
  $('#pcoStatus').textContent = m.manual ? 'Plan wybrany ręcznie.' : 'Plan wybierany automatycznie (dzisiejszy lub najbliższy).';
  const opt = (id, label, checked) => `<label><input type="radio" name="pcoPlan" value="${esc(id)}" ${checked ? 'checked' : ''}> ${label}</label>`;
  $('#pcoPlans').innerHTML = opt('', 'Automatycznie', !m.manual) + (m.plans || []).map((p) =>
    opt(p.id, `${esc(p.serviceTypeName)} · ${esc(p.dates || '')} ${esc(p.title || '')}`, m.manual && p.id === m.selected)).join('');
  $('#pcoPlans').querySelectorAll('input').forEach((i) => (i.onchange = () => wsSend({ t: 'pcoSelect', planId: i.value || null })));
}
$('#btnPcoRefresh').onclick = () => { wsSend({ t: 'pcoRefresh' }); $('#pcoStatus').textContent = 'Odświeżanie…'; setTimeout(() => wsSend({ t: 'pcoPlans' }), 3000); };

// ================= POWIADOMIENIA PUSH =================
// Na iPhonie działają tylko w aplikacji dodanej do ekranu początkowego (iOS 16.4+).
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; renderPush(); if (S.session) ensurePush(false); }).catch(() => {});
function b64ToU8(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
async function ensurePush(ask) {
  if (!pushSupported() || !swReg || !S.session) return false;
  if (Notification.permission === 'denied') return false;
  if (Notification.permission !== 'granted') { if (!ask) return false; if (await Notification.requestPermission() !== 'granted') return false; }
  const { publicKey } = await (await fetch('/api/push/key')).json();
  let sub = await swReg.pushManager.getSubscription();
  if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.session.token }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  return true;
}
function renderPush() {
  renderPushPrefs();
  const info = $('#pushInfo'), btn = $('#btnPush'), test = $('#btnPushTest');
  test.hidden = true;
  if (isIOS && !standalone()) {
    info.innerHTML = 'Na iPhonie powiadomienia działają tylko po dodaniu interkomu do ekranu początkowego: w Safari <b>Udostępnij → Do ekranu początkowego</b>, potem otwórz interkom z ikony i wróć tutaj.';
    btn.hidden = true; return;
  }
  if (!pushSupported()) { info.textContent = 'Ta przeglądarka nie obsługuje powiadomień push.'; btn.hidden = true; return; }
  const p = Notification.permission;
  btn.hidden = p === 'granted' || p === 'denied';
  test.hidden = p !== 'granted';
  info.textContent = p === 'granted' ? '✔ Włączone – wezwania, wiadomości prywatne i PILNE! dotrą także przy zablokowanym ekranie. Przychodzą, dopóki jesteś zalogowany i przez 6 godzin od ostatniego otwarcia interkomu – przy kolejnym nabożeństwie wystarczy go otworzyć.'
    : p === 'denied' ? 'Powiadomienia są zablokowane – włącz je w ustawieniach telefonu dla tej aplikacji.'
    : 'Wezwania, wiadomości prywatne i PILNE! pojawią się także przy zablokowanym ekranie.';
}
// Co ma przychodzić na zablokowany telefon – zapisywane na serwerze (razem z listą słuchanych kanałów)
S.pushPrefs = { dm: true, channels: true, plan: false, stream: false, timer: false };
async function loadPushPrefs() {
  try { const r = await fetch('/api/push/prefs', { headers: { authorization: 'Bearer ' + S.session.token } }); if (r.ok) S.pushPrefs = await r.json(); } catch {}
  renderPushPrefs(); savePushPrefs();
}
function savePushPrefs() {
  if (!S.session) return;
  fetch('/api/push/prefs', { method: 'POST', headers: { authorization: 'Bearer ' + S.session.token, 'content-type': 'application/json' }, body: JSON.stringify({ ...S.pushPrefs, listen: [...S.listen] }) }).catch(() => {});
}
function renderPushPrefs() {
  $$('#pushPrefs [data-pp]').forEach((el) => {
    el.checked = !!S.pushPrefs[el.dataset.pp];
    el.onchange = () => { S.pushPrefs[el.dataset.pp] = el.checked; savePushPrefs(); };
  });
  $('#vibHint').textContent = isIOS
    ? 'iPhone: wibracje powiadomień ustawiasz w Ustawieniach → Dźwięki i haptyka. Gdy aplikacja jest otwarta, iPhone nie pozwala stronom wibrować – zostaje dźwięk i lektor.'
    : 'Każdy rodzaj powiadomienia ma własny wzór wibracji (wezwanie – najdłuższy).';
}
$('#btnPush').onclick = async () => {
  try { const ok = await ensurePush(true); if (!ok) sysMsg('Nie udało się włączyć powiadomień.'); } catch (e) { sysMsg('Powiadomienia: ' + e.message); }
  renderPush();
};
$('#btnNicks').onclick = () => wsSend({ t: 'nicks', nicks: $('#optNicks').value });
$('#optNicks').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btnNicks').click(); } });
$('#btnPushTest').onclick = async () => {
  const b = $('#btnPushTest'); b.disabled = true;
  try {
    await ensurePush(false);
    sysMsg('Test za 5 s – zablokuj teraz telefon.');
    const r = await (await fetch('/api/push/test', { method: 'POST', headers: { authorization: 'Bearer ' + S.session.token } })).json();
    $('#pushInfo').textContent = r.ok ? `✔ Powiadomienie wysłane (${r.sent} urządz.). Jeśli nie dotarło, sprawdź Ustawienia iPhone'a → Powiadomienia → Interkom.` : `✘ ${r.error}`;
    if (!r.ok) sysMsg('Powiadomienia: ' + r.error);
  } catch (e) { sysMsg('Test powiadomień nie powiódł się: ' + e.message); }
  b.disabled = false;
};

// PIN mówiącego / administratora dla zalogowanej osoby (np. przez Planning Center)
$('#btnElevate').onclick = async () => {
  try {
    const r = await fetch('/api/elevate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.session.token }, body: JSON.stringify({ pin: $('#elevPin').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Błąd');
    store.set('token', j.token);
    location.reload(); // nowa sesja z wyższą rolą – mikrofon, panel itd.
  } catch (e) { sysMsg(e.message); $('#elevPin').value = ''; }
};

tryResume();
