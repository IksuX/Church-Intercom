import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'config.example.json');
const TONES = ['ok', 'wait', 'info', 'warn', 'urgent'];

export class ConfigError extends Error {}
const fail = (msg) => { throw new ConfigError(msg); };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const strList = (v, max = 40) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean);

export const PCO_DEFAULTS = {
  enabled: true,
  serviceTypeIds: [],
  teamChannels: true,
  teamChannelMap: {},
  speakerPositions: ['Reżyser', 'Realizator', 'Prowadzący', 'Producent'],
  speakerTeams: [],
  teamLeadersCanSpeak: true,
  livePollSeconds: 5,
  refreshSeconds: 120,
  // sterowanie Planning Center Live z interkomu – tylko wskazane stanowiska / zespoły (i administrator)
  liveControl: { enabled: false, positions: [], teams: [] },
  // logowanie kontem Planning Center (OAuth); rosterOnly = tylko osoby z bieżącej obsady
  oauthLogin: { enabled: false, rosterOnly: false },
  announce: true, // ogłaszanie zmiany punktu planu na kanale ogólnym
};

// Sprawdza i porządkuje konfigurację. Rzuca ConfigError z komunikatem po polsku.
export function validateConfig(input) {
  const c = typeof input === 'object' && input ? structuredClone(input) : fail('Nieprawidłowa konfiguracja.');
  c.orgName = str(c.orgName, 60) || 'Interkom';
  for (const k of ['accessPin', 'speakerPin', 'adminPin']) {
    c[k] = str(c[k], 20);
    if (!/^\S{3,20}$/.test(c[k])) fail(`PIN (${{ accessPin: 'ekipy', speakerPin: 'mówiącego', adminPin: 'administratora' }[k]}) musi mieć 3–20 znaków bez spacji.`);
  }
  if (new Set([c.accessPin, c.speakerPin, c.adminPin]).size !== 3) fail('PIN ekipy, mówiącego i administratora muszą być różne.');

  if (!Array.isArray(c.channels) || !c.channels.length) fail('Potrzebny jest co najmniej jeden kanał.');
  if (c.channels.length > 40) fail('Za dużo kanałów (maks. 40).');
  const ids = new Set();
  c.channels = c.channels.map((ch) => {
    const x = { id: str(ch.id, 32), name: str(ch.name, 30), color: str(ch.color, 7) || '#9ca3af' };
    if (!x.name) fail('Każdy kanał musi mieć nazwę.');
    if (!/^[a-z0-9_-]{1,32}$/.test(x.id)) fail(`Nieprawidłowe id kanału „${x.name}”.`);
    if (ids.has(x.id)) fail(`Powtórzony kanał „${x.name}”.`);
    if (!/^#[0-9a-fA-F]{6}$/.test(x.color)) x.color = '#9ca3af';
    if (ch.broadcast) x.broadcast = true;
    ids.add(x.id);
    return x;
  });
  const bc = c.channels.filter((x) => x.broadcast);
  if (bc.length !== 1) { c.channels.forEach((x) => delete x.broadcast); c.channels[0].broadcast = true; }

  const keys = new Set();
  c.quick = (Array.isArray(c.quick) ? c.quick : []).slice(0, 12).map((q, i) => {
    const x = { key: str(q.key, 24) || `q${i}`, label: str(q.label, 24), tone: TONES.includes(q.tone) ? q.tone : 'info' };
    if (!x.label) fail('Każdy szybki przycisk musi mieć napis.');
    if (!/^[a-z0-9_-]{1,24}$/.test(x.key) || keys.has(x.key)) x.key = `q${i}_${Date.now().toString(36)}`;
    if (q.urgent) x.urgent = true;
    keys.add(x.key);
    return x;
  });

  const p = { ...PCO_DEFAULTS, ...(c.planningCenter || {}) };
  c.planningCenter = {
    enabled: p.enabled !== false,
    serviceTypeIds: strList(p.serviceTypeIds, 20),
    teamChannels: p.teamChannels !== false,
    teamChannelMap: Object.fromEntries(Object.entries(p.teamChannelMap || {}).map(([k, v]) => [str(k, 60), str(v, 32)]).filter(([k, v]) => k && v)),
    speakerPositions: strList(p.speakerPositions),
    speakerTeams: strList(p.speakerTeams, 60),
    teamLeadersCanSpeak: p.teamLeadersCanSpeak !== false,
    livePollSeconds: Math.min(60, Math.max(2, Number(p.livePollSeconds) || 5)),
    refreshSeconds: Math.min(3600, Math.max(30, Number(p.refreshSeconds) || 120)),
    announce: p.announce !== false,
    oauthLogin: { enabled: !!p.oauthLogin?.enabled, rosterOnly: !!p.oauthLogin?.rosterOnly },
    liveControl: {
      enabled: !!p.liveControl?.enabled,
      positions: strList(p.liveControl?.positions),
      teams: strList(p.liveControl?.teams, 60),
    },
  };
  c.sttPrompt = str(c.sttPrompt, 160);
  c.sttDictionary = str(c.sttDictionary, 600); // słowa, które model ma znać: imiona, nazwy, tytuły (oddzielone przecinkami)
  c.sttHints = { plan: c.sttHints?.plan !== false, names: !!c.sttHints?.names }; // podpowiedzi z Planning Center
  c.sttOff = strList(c.sttOff, 40); // kanały bez transkrypcji
  c.sttDm = c.sttDm !== false; // transkrypcja szeptów w rozmowach prywatnych
  // osoby bez transkrypcji ich wypowiedzi: [{ key: 'p<id PC>' | 's<sesja>', name }]
  c.sttOffUsers = (Array.isArray(c.sttOffUsers) ? c.sttOffUsers : []).filter((x) => x && /^[ps][\w-]{1,40}$/.test(String(x.key))).slice(0, 300)
    .map((x) => ({ key: String(x.key), name: String(x.name || '').slice(0, 60) }));
  // ręczne uprawnienia osób z Planning Center: { "<personId>": { name, speak: true|false, live: true|false } }
  const tri = (v) => (v === true || v === false ? v : undefined);
  c.grants = Object.fromEntries(Object.entries(c.grants && typeof c.grants === 'object' ? c.grants : {})
    .map(([pid, g]) => [str(pid, 32), { name: str(g?.name, 60), speak: tri(g?.speak), live: tri(g?.live), admin: g?.admin === true ? true : undefined }])
    .filter(([pid, g]) => pid && (g.speak !== undefined || g.live !== undefined || g.admin)));
  // transmisje live (Blackmagic Web Presenter)
  const sm = c.streams && typeof c.streams === 'object' ? c.streams : {};
  const devIds = new Set();
  c.streams = {
    enabled: !!sm.enabled,
    mode: sm.mode === 'bridge' ? 'bridge' : 'direct',
    channel: str(sm.channel, 32), // puste = kanał ogólny
    cacheWarn: Math.min(95, Math.max(10, Number(sm.cacheWarn) || 50)),
    events: { start: sm.events?.start !== false, stop: sm.events?.stop !== false, signal: sm.events?.signal !== false, problem: sm.events?.problem !== false },
    devices: (Array.isArray(sm.devices) ? sm.devices : []).slice(0, 8).map((d, i) => {
      const x = { id: str(d?.id, 16), name: str(d?.name, 30), host: str(d?.host, 64), port: Math.min(65535, Math.max(1, Number(d?.port) || 9977)), platform: ['youtube', 'facebook'].includes(d?.platform) ? d.platform : '' };
      if (!x.name) fail('Każde urządzenie transmisji musi mieć nazwę (np. YouTube).');
      if (!/^[a-zA-Z0-9.:_-]{1,64}$/.test(x.host)) fail(`Podaj adres IP urządzenia „${x.name}” (np. 192.168.1.50).`);
      if (!/^[a-z0-9]{1,16}$/.test(x.id) || devIds.has(x.id)) x.id = `d${i}${Date.now().toString(36)}`;
      devIds.add(x.id);
      return x;
    }),
  };
  // ProPresenter 7 – zegar bieżącego punktu zsynchronizowany z Planning Center
  const pp = c.propresenter && typeof c.propresenter === 'object' ? c.propresenter : {};
  c.propresenter = {
    enabled: !!pp.enabled,
    mode: pp.mode === 'bridge' ? 'bridge' : 'direct',
    host: /^[a-zA-Z0-9.:_-]{1,64}$/.test(str(pp.host, 64)) ? str(pp.host, 64) : '',
    port: Math.min(65535, Math.max(1, Number(pp.port) || 50001)),
    timer: str(pp.timer, 40) || 'Interkom – punkt',
    endTimer: str(pp.endTimer, 40),
  };
  if (c.propresenter.enabled && !c.propresenter.host) fail('ProPresenter: podaj adres IP komputera z ProPresenterem.');
  // dźwięk transmisji (mix z konsolety) – nadawany z komputera w kościele, każdy słucha u siebie z własną głośnością
  const pg = c.program && typeof c.program === 'object' ? c.program : {};
  c.program = {
    enabled: !!pg.enabled,
    name: str(pg.name, 30) || 'Dźwięk transmisji',
    local: pg.local !== false, // telefony w sieci kościoła słuchają prosto z nadajnika (bez serwera w chmurze)
    source: pg.source === 'server' ? 'server' : 'browser', // skąd dźwięk: strona nadajnika w przeglądarce albo wejście audio serwera
    server: { // ustawienia nadajnika na serwerze (usługa „audio”) – zmieniane z panelu
      on: !!pg.server?.on, device: str(pg.server?.device, 120) || 'test',
      l: Math.max(0, Math.min(63, Math.round(Number(pg.server?.l) || 0))), r: Math.max(0, Math.min(63, Math.round(Number(pg.server?.r ?? 1) || 0))),
      mono: !!pg.server?.mono, gain: Math.max(-24, Math.min(24, Math.round((Number(pg.server?.gain) || 0) * 2) / 2)),
      limiter: pg.server?.limiter !== false, muted: !!pg.server?.muted,
    },
    bitrate: [96, 128, 160, 192, 256, 320].includes(Number(pg.bitrate)) ? Number(pg.bitrate) : 160, // kb/s, stereo (Opus)
    duck: pg.duck == null || pg.duck === '' || !Number.isFinite(Number(pg.duck)) ? 30 : Math.min(100, Math.max(0, Math.round(Number(pg.duck)))), // % głośności, gdy ktoś mówi
  };
  // dostęp spoza sieci kościoła (przekierowanie portów na routerze) – co wolno osobom łączącym się z internetu
  const rm = c.remote && typeof c.remote === 'object' ? c.remote : {};
  // linki do pobrania aplikacji (ekran logowania i ustawienia w przeglądarce) – App Store / TestFlight, Google Play / plik APK
  const ap = c.apps && typeof c.apps === 'object' ? c.apps : {};
  const url = (v) => { const t = str(v, 300); return /^https:\/\/[^\s"'<>]+$/i.test(t) ? t : ''; };
  c.apps = { ios: url(ap.ios), android: url(ap.android) };
  if ((ap.ios && !c.apps.ios) || (ap.android && !c.apps.android)) fail('Link do aplikacji musi zaczynać się od https:// i nie może zawierać spacji.');
  c.remote = {
    enabled: rm.enabled !== false, // w ogóle wpuszczaj spoza sieci (gdy router przekierowuje porty)
    pin: !!rm.pin,                 // logowanie PIN-em ekipy spoza sieci (domyślnie nie – tylko Planning Center)
    admin: !!rm.admin,             // panel administracyjny spoza sieci (domyślnie nie)
  };
  // wygląd (panel → Ogólne → Wygląd): kolor przewodni i logo – takie same dla wszystkich
  const br = c.branding && typeof c.branding === 'object' ? c.branding : {};
  c.branding = {
    accent: /^#[0-9a-f]{6}$/i.test(br.accent || '') ? br.accent.toLowerCase() : '#ff5600',
    logo: /^[a-z0-9.-]{1,40}$/i.test(br.logo || '') ? br.logo : '', // nazwa pliku w data/branding (ustawia serwer przy wgraniu)
    // kolor logo (SVG/PNG z przezroczystym tłem): '' = oryginalny, 'accent' = jak kolor przewodni, '#rrggbb' = własny
    logoColor: br.logoColor === 'accent' || /^#[0-9a-f]{6}$/i.test(br.logoColor || '') ? String(br.logoColor).toLowerCase() : '',
  };
  c.historyPerChannel = Math.min(2000, Math.max(50, Number(c.historyPerChannel) || 300));
  return c;
}

export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[uwaga] Brak ${file} – tworzę z przykładu. Zmień PIN-y!`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(EXAMPLE, file);
  }
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Zapis atomowy (plik tymczasowy + zmiana nazwy) – awaria w trakcie nie uszkodzi konfiguracji.
export function saveJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
