// Inputlista – stały patch sali + obsada z Planning Center = lista kanałów na konkretne nabożeństwo.
// Dane w DATA_DIR/inputlist.json: biblioteka sprzętu, patch sali i – osobno dla każdego planu –
// ręczne poprawki oraz stan line checku. Kto może czytać i zmieniać, decyduje server.js (rola „Dźwięk”).
// build() i warnings() są czyste (bez zapisu i sieci), więc można je sprawdzać w `node -e`.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { channels: 128, gear: 200, extra: 32, positions: 12, plans: 40, planDays: 60 };
export const GEAR_KINDS = ['mic', 'di', 'wireless', 'line', 'other'];
export const GEAR_KIND_LABELS = { mic: 'Mikrofon', di: 'DI', wireless: 'Bezprzewodowy', line: 'Linia', other: 'Inne' };
export const CHECK_STATES = ['ok', 'problem'];
export const LOCAL_PLAN = 'local'; // klucz poprawek i line checku, gdy nie ma planu z Planning Center

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const strList = (v, max, n) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean))].slice(0, n);
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const newId = (p) => p + crypto.randomBytes(4).toString('hex');
const norm = (v) => str(v, 200).toLocaleLowerCase('pl');
const cmp = (a, b) => String(a).localeCompare(String(b), 'pl', { numeric: true, sensitivity: 'base' });
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

// ---------- walidacja ----------

function uniqueId(raw, prefix, used) {
  let id = typeof raw === 'string' && ID_RE.test(raw) && !used.has(raw) ? raw : newId(prefix);
  while (used.has(id)) id = newId(prefix);
  used.add(id);
  return id;
}

export function sanitizeGear(list) {
  const used = new Set();
  return (Array.isArray(list) ? list : []).slice(0, LIMITS.gear).map((g) => {
    const o = g && typeof g === 'object' ? g : {};
    const name = str(o.name, 60);
    if (!name) return null;
    return {
      id: uniqueId(o.id, 'g', used),
      name,
      kind: GEAR_KINDS.includes(o.kind) ? o.kind : 'other',
      count: int(o.count, 0, 999) ?? 1,
    };
  }).filter(Boolean);
}

// Jeden kanał patchu (albo kanał dodany tylko na jedno nabożeństwo – ten sam kształt).
function sanitizeChannel(c, i, used, gearIds) {
  const o = c && typeof c === 'object' ? c : {};
  const gearId = typeof o.gearId === 'string' && gearIds.has(o.gearId) ? o.gearId : null;
  return {
    id: uniqueId(o.id, 'c', used),
    ch: int(o.ch, 1, 999) ?? i + 1,
    name: str(o.name, 12),          // krótka nazwa – pod przyszły eksport nazw do konsolety
    source: str(o.source, 60),
    gearId,
    gearText: gearId ? '' : str(o.gearText, 60),
    input: str(o.input, 20),        // gniazdo stageboxa / multicore
    phantom: o.phantom === true,
    stand: str(o.stand, 40),
    stereoWith: typeof o.stereoWith === 'string' ? o.stereoWith : null, // poprawiane w fixStereo()
    positions: strList(o.positions, 60, LIMITS.positions),
    always: o.always === true,
    slot: o.slot === true,          // po jednej osobie z pozycji na kanał (wokale); inaczej wszyscy pasujący (perkusja na 6 kanałach)
    notes: str(o.notes, 200),
  };
}

// Para stereo musi wskazywać istniejący, inny kanał – i działać w obie strony.
function fixStereo(list) {
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const c of list) if (c.stereoWith && (c.stereoWith === c.id || !byId.has(c.stereoWith))) c.stereoWith = null;
  for (const c of list) {
    const p = c.stereoWith && byId.get(c.stereoWith);
    if (p && p.stereoWith !== c.id) {
      if (p.stereoWith) c.stereoWith = null; // partner ma już inną parę
      else p.stereoWith = c.id;
    }
  }
  return list;
}

export function sanitizePatch(list, gear, used = new Set()) {
  const gearIds = new Set(gear.map((g) => g.id));
  return fixStereo((Array.isArray(list) ? list : []).slice(0, LIMITS.channels).map((c, i) => sanitizeChannel(c, i, used, gearIds)));
}

function sanitizeCheck(v) {
  const o = v && typeof v === 'object' ? v : {};
  if (!CHECK_STATES.includes(o.state)) return null;
  return { state: o.state, note: o.state === 'problem' ? str(o.note, 200) : '', by: str(o.by, 60), at: int(o.at, 0, 8.64e15) ?? Date.now() };
}

function sanitizeOverride(v) {
  const o = v && typeof v === 'object' ? v : {};
  const r = {};
  if (o.active === true || o.active === false) r.active = o.active;
  if (typeof o.person === 'string') r.person = str(o.person, 60);
  if (typeof o.notes === 'string') r.notes = str(o.notes, 200);
  return Object.keys(r).length ? r : null;
}

function sanitizePlanEntry(v, gear, patchIds) {
  const o = v && typeof v === 'object' ? v : {};
  const used = new Set(patchIds);
  const extra = sanitizePatch(o.extra, gear, used).slice(0, LIMITS.extra);
  const known = new Set([...patchIds, ...extra.map((c) => c.id)]);
  const overrides = {}, check = {};
  for (const [id, x] of Object.entries(o.overrides || {})) { const s = known.has(id) && sanitizeOverride(x); if (s) overrides[id] = s; }
  for (const [id, x] of Object.entries(o.check || {})) { const s = known.has(id) && sanitizeCheck(x); if (s) check[id] = s; }
  return { touched: int(o.touched, 0, 8.64e15) ?? Date.now(), title: str(o.title, 120), overrides, extra, check };
}

// Stare plany wypadają: zostają te ruszane w ostatnich LIMITS.planDays dniach, najwyżej LIMITS.plans sztuk.
export function prunePlans(plans, now = Date.now(), keep = null) {
  const limit = now - LIMITS.planDays * 864e5;
  const ids = Object.keys(plans)
    .filter((id) => id === keep || id === LOCAL_PLAN || plans[id].touched >= limit)
    .sort((a, b) => (b === keep) - (a === keep) || plans[b].touched - plans[a].touched)
    .slice(0, LIMITS.plans);
  return Object.fromEntries(ids.map((id) => [id, plans[id]]));
}

export function sanitizeStore(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const gear = sanitizeGear(o.gear);
  const patch = sanitizePatch(o.patch, gear);
  const patchIds = patch.map((c) => c.id);
  const plans = {};
  for (const [id, v] of Object.entries(o.plans || {})) if (ID_RE.test(id)) plans[id] = sanitizePlanEntry(v, gear, patchIds);
  const opt = o.options && typeof o.options === 'object' ? o.options : {};
  return {
    version: 1,
    gear,
    patch,
    // zespoły, z których obsadę pokazujemy jako „nieprzypisaną”; pusto = zespoły, z których ktoś trafił na kanał
    options: { teams: strList(opt.teams, 60, 40) },
    plans: prunePlans(plans),
  };
}

// ---------- składanie listy ----------

// Pozycja osoby pasuje do reguły kanału: dokładnie albo zawiera ją (jak przy roli Reżyser),
// więc reguła „Vocal” obejmuje „Vocal 1” i „Vocal 2”.
const posMatch = (personPos, rule) => { const p = norm(personPos), r = norm(rule); return !!r && (p === r || p.includes(r)); };
const bestPos = (person, rules) => person.positions.filter((p) => rules.some((r) => posMatch(p, r))).sort(cmp)[0];

/**
 * Lista kanałów na nabożeństwo.
 * Zwykły kanał dostaje wszystkie osoby z pasującą pozycją (perkusista na wszystkich mikrofonach perkusji).
 * Kanały „po jednej osobie” (slot) z identycznym zestawem pozycji tworzą grupę: osoby rozchodzą się po jednej
 * na kanał, w kolejności pozycji („Vocal 1”, „Vocal 2”…) i imion; kto się nie zmieści, jest na liście „nieprzypisani”.
 * @param {object} store  wynik sanitizeStore()
 * @param {{id:string,title?:string,dates?:string}|null} plan  bieżący plan z Planning Center
 * @param {{personId:string,name:string,positions:string[],teamNames?:string[]}[]} roster  obsada planu
 */
export function build(store, plan, roster = []) {
  const planId = plan?.id ? String(plan.id) : LOCAL_PLAN;
  const entry = store.plans[planId] || { overrides: {}, extra: [], check: {} };
  const channels = [...store.patch, ...entry.extra.map((c) => ({ ...c, extra: true }))];
  const people = plan ? roster.map((p) => ({ ...p, positions: p.positions || [], teamNames: p.teamNames || [] })) : [];
  const gearById = new Map(store.gear.map((g) => [g.id, g]));

  const assigned = new Map(channels.map((c) => [c.id, []]));
  const placed = new Set();
  const overflow = new Map(); // osoby, które pasowały, ale zabrakło dla nich kanału w grupie
  const groups = new Map();
  for (const c of channels) {
    if (!c.positions.length) continue;
    const key = c.slot ? 'slot\n' + c.positions.map(norm).sort().join('\n') : 'ch\n' + c.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const chans of groups.values()) {
    const rules = chans[0].positions;
    const match = people.filter((p) => bestPos(p, rules))
      .sort((a, b) => cmp(bestPos(a, rules), bestPos(b, rules)) || cmp(a.name, b.name));
    if (!chans[0].slot) {
      for (const p of match) { assigned.get(chans[0].id).push(p); placed.add(p.personId); }
      continue;
    }
    match.forEach((p, i) => {
      if (i < chans.length) { assigned.get(chans[i].id).push(p); placed.add(p.personId); }
      else overflow.set(p.personId, p);
    });
  }

  const rows = channels.map((c) => {
    const ov = entry.overrides[c.id] || {};
    const who = assigned.get(c.id);
    const g = c.gearId && gearById.get(c.gearId);
    const names = who.map((p) => p.name);
    if (ov.person) names.splice(0, names.length, ov.person);
    const auto = c.always || who.length > 0 || !!c.extra;
    return {
      id: c.id, ch: c.ch, name: c.name, source: c.source,
      gear: g ? g.name : c.gearText, gearKind: g ? g.kind : null,
      input: c.input, phantom: c.phantom, stand: c.stand, stereoWith: c.stereoWith,
      positions: c.positions, always: c.always, extra: !!c.extra,
      people: names,
      active: ov.active ?? auto,
      notes: ov.notes ?? c.notes,
      overridden: Object.keys(ov).length > 0,
      check: entry.check[c.id] || null,
    };
  }).sort((a, b) => a.ch - b.ch);

  // „Nieprzypisani”: osoby z obsady wskazanych zespołów (albo zespołów, z których ktoś trafił na kanał),
  // które nie trafiły na żaden kanał.
  const teams = new Set((store.options.teams.length
    ? store.options.teams
    : people.filter((p) => placed.has(p.personId)).flatMap((p) => p.teamNames)).map(norm));
  const unassigned = people
    .filter((p) => !placed.has(p.personId) && (overflow.has(p.personId) || p.teamNames.some((t) => teams.has(norm(t)))))
    .map((p) => ({ name: p.name, positions: p.positions, reason: overflow.has(p.personId) ? 'noFreeChannel' : 'noChannel' }))
    .sort((a, b) => cmp(a.name, b.name));

  const used = rows.filter((r) => r.active);
  return {
    planId,
    plan: plan ? { id: String(plan.id), title: plan.title || '', dates: plan.dates || '' } : null,
    rows,
    unassigned,
    summary: {
      channels: rows.length,
      used: used.length,
      ok: used.filter((r) => r.check?.state === 'ok').length,
      problem: used.filter((r) => r.check?.state === 'problem').length,
    },
  };
}

// Ostrzeżenia do panelu: ten sam numer kanału dwa razy, sprzętu użyte więcej niż sztuk,
// pozycja przypisana do kilku różnych grup kanałów (bywa celowe – tylko informacja).
export function warnings(store) {
  const out = [];
  const byCh = new Map();
  for (const c of store.patch) byCh.set(c.ch, [...(byCh.get(c.ch) || []), c]);
  for (const [ch, list] of byCh) if (list.length > 1) out.push({ level: 'error', code: 'dupChannel', ch, text: `Kanał ${ch} jest wpisany ${list.length} razy.` });
  for (const g of store.gear) {
    const n = store.patch.filter((c) => c.gearId === g.id).length;
    if (n > g.count) out.push({ level: 'warn', code: 'gearCount', gearId: g.id, text: `${g.name}: użyty ${n} razy, a w bibliotece jest ${g.count} szt.` });
  }
  const groupsOf = new Map();
  for (const c of store.patch) {
    const key = c.positions.map(norm).sort().join('\n');
    for (const p of c.positions) { const k = norm(p); groupsOf.set(k, new Set([...(groupsOf.get(k) || []), key])); }
  }
  for (const c of store.patch) for (const p of c.positions) {
    const k = norm(p);
    if (groupsOf.get(k)?.size > 1) { out.push({ level: 'info', code: 'sharedPosition', position: p, text: `Pozycja „${p}” jest przypisana do kanałów z różnymi zestawami pozycji.` }); groupsOf.delete(k); }
  }
  return out;
}

// Przykład dla typowego zespołu uwielbienia – przycisk „Wypełnij przykładem” w panelu.
export function exampleStore() {
  const gear = [
    { id: 'g58', name: 'Shure SM58', kind: 'mic', count: 6 },
    { id: 'g57', name: 'Shure SM57', kind: 'mic', count: 4 },
    { id: 'gb91', name: 'Shure Beta 91A', kind: 'mic', count: 1 },
    { id: 'gb52', name: 'Shure Beta 52A', kind: 'mic', count: 1 },
    { id: 'gdi', name: 'DI aktywny', kind: 'di', count: 6 },
    { id: 'gcond', name: 'Mikrofon pojemnościowy', kind: 'mic', count: 2 },
    { id: 'gwl', name: 'Mikrofon bezprzewodowy', kind: 'wireless', count: 2 },
  ];
  const ch = (name, source, gearId, extra = {}) => ({ name, source, gearId, ...extra });
  const patch = [
    ch('WL', 'Wokal prowadzący', 'g58', { positions: ['Worship Leader'], stand: 'duży z wysięgnikiem' }),
    ch('Wok 2', 'Wokal', 'g58', { positions: ['Vocal'], slot: true, stand: 'duży z wysięgnikiem' }),
    ch('Wok 3', 'Wokal', 'g58', { positions: ['Vocal'], slot: true, stand: 'duży z wysięgnikiem' }),
    ch('Wok 4', 'Wokal', 'g58', { positions: ['Vocal'], slot: true, stand: 'duży z wysięgnikiem' }),
    ch('Kick In', 'Stopa – środek', 'gb91', { positions: ['Drums'], phantom: true }),
    ch('Kick Out', 'Stopa – zewnątrz', 'gb52', { positions: ['Drums'], stand: 'mały' }),
    ch('Snare', 'Werbel', 'g57', { positions: ['Drums'], stand: 'mały z wysięgnikiem' }),
    ch('Tom', 'Tom', 'g57', { positions: ['Drums'] }),
    ch('OH L', 'Overhead lewy', 'gcond', { positions: ['Drums'], phantom: true, stand: 'duży z wysięgnikiem', id: 'cohl', stereoWith: 'cohr' }),
    ch('OH R', 'Overhead prawy', 'gcond', { positions: ['Drums'], phantom: true, stand: 'duży z wysięgnikiem', id: 'cohr', stereoWith: 'cohl' }),
    ch('Bass', 'Gitara basowa', 'gdi', { positions: ['Bass'], phantom: true }),
    ch('E-Gtr', 'Gitara elektryczna', 'g57', { positions: ['Electric Guitar'], stand: 'mały z wysięgnikiem' }),
    ch('A-Gtr', 'Gitara akustyczna', 'gdi', { positions: ['Acoustic Guitar'], phantom: true }),
    ch('Keys L', 'Klawisze lewy', 'gdi', { positions: ['Keys'], phantom: true, id: 'ckl', stereoWith: 'ckr' }),
    ch('Keys R', 'Klawisze prawy', 'gdi', { positions: ['Keys'], phantom: true, id: 'ckr', stereoWith: 'ckl' }),
    ch('Pulpit', 'Pulpit / kazanie', 'gwl', { always: true }),
    ch('Ambona', 'Ogłoszenia', 'gwl', { always: true }),
    ch('PB L', 'Playback lewy', null, { gearText: 'komputer – linia', always: true, id: 'cpbl', stereoWith: 'cpbr' }),
    ch('PB R', 'Playback prawy', null, { gearText: 'komputer – linia', always: true, id: 'cpbr', stereoWith: 'cpbl' }),
  ].map((c, i) => ({ ...c, ch: i + 1, input: `SB ${i + 1}` }));
  return sanitizeStore({ gear, patch });
}

// ---------- moduł serwera ----------

export class InputList extends EventEmitter {
  /** @param {{ dataDir:string, logger?:(m:string)=>void }} opts */
  constructor({ dataDir, logger = (m) => console.log(`[inputlista] ${m}`) }) {
    super();
    this.file = path.join(dataDir, 'inputlist.json');
    this.logger = logger;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') logger(`nie udało się odczytać ${this.file}: ${e.message}`); }
    this.data = sanitizeStore(raw);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
    this.saveTimer.unref?.();
  }
  flush() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.logger(`nie udało się zapisać ${this.file}: ${e.message}`); }
  }
  changed(planId) { this.save(); this.emit('change', planId ?? null); }

  // Panel: sprzęt, patch, opcje i ostrzeżenia
  adminData() {
    const { gear, patch, options } = this.data;
    return { gear, patch, options, warnings: warnings(this.data), kinds: GEAR_KIND_LABELS };
  }

  // Zapis z panelu. Poprawki i line check planów zostają; wpisy do kanałów, których już nie ma, wypadają.
  setPatch(body) {
    const b = body && typeof body === 'object' ? body : {};
    const next = sanitizeStore({
      gear: 'gear' in b ? b.gear : this.data.gear,
      patch: 'patch' in b ? b.patch : this.data.patch,
      options: 'options' in b ? b.options : this.data.options,
      plans: this.data.plans,
    });
    if (next.patch.length === 0 && Array.isArray(b.patch) && b.patch.length) throw new Error('Żaden kanał nie przeszedł sprawdzenia.');
    this.data = next;
    this.changed();
    return this.adminData();
  }

  loadExample() { this.data = sanitizeStore({ ...exampleStore(), plans: this.data.plans }); this.changed(); return this.adminData(); }

  view(plan, roster) { return build(this.data, plan, roster); }

  entry(planId, title = '') {
    const id = String(planId || LOCAL_PLAN);
    if (!ID_RE.test(id)) throw new Error('Nieprawidłowy plan.');
    const e = this.data.plans[id] || (this.data.plans[id] = { touched: Date.now(), title: '', overrides: {}, extra: [], check: {} });
    e.touched = Date.now();
    if (title) e.title = str(title, 120);
    this.data.plans = prunePlans(this.data.plans, Date.now(), id);
    return e;
  }
  knownChannel(e, chId) {
    if (this.data.patch.some((c) => c.id === chId) || e.extra.some((c) => c.id === chId)) return;
    throw new Error('Nie ma takiego kanału.');
  }

  // Poprawka na jedno nabożeństwo; pusta poprawka (np. { active: null }) przywraca stan z patchu i obsady.
  override(planId, chId, patch, title) {
    const e = this.entry(planId, title);
    this.knownChannel(e, chId);
    const merged = { ...(e.overrides[chId] || {}) };
    for (const k of ['active', 'person', 'notes']) {
      if (!patch || !(k in patch)) continue;
      if (patch[k] === null || patch[k] === '') delete merged[k]; else merged[k] = patch[k];
    }
    const s = sanitizeOverride(merged);
    if (s) e.overrides[chId] = s; else delete e.overrides[chId];
    this.changed(planId);
  }

  // Line check: state 'ok' | 'problem' | null (zerowanie)
  check(planId, chId, state, by, note = '', title) {
    const e = this.entry(planId, title);
    this.knownChannel(e, chId);
    if (state == null) delete e.check[chId];
    else {
      const s = sanitizeCheck({ state, note, by, at: Date.now() });
      if (!s) throw new Error('Nieznany stan line checku.');
      e.check[chId] = s;
    }
    this.changed(planId);
    return e.check[chId] || null;
  }

  resetCheck(planId) {
    const e = this.entry(planId);
    e.check = {};
    this.changed(planId);
  }

  // Kanał dodany tylko na to nabożeństwo (np. gość z własnym instrumentem)
  addExtra(planId, channel, title) {
    const e = this.entry(planId, title);
    if (e.extra.length >= LIMITS.extra) throw new Error(`Najwyżej ${LIMITS.extra} dodatkowych kanałów na nabożeństwo.`);
    const used = new Set([...this.data.patch.map((c) => c.id), ...e.extra.map((c) => c.id)]);
    const [c] = sanitizePatch([{ ...channel, id: undefined }], this.data.gear, used);
    c.stereoWith = null;
    e.extra.push(c);
    this.changed(planId);
    return c;
  }
  removeExtra(planId, chId) {
    const e = this.entry(planId);
    const i = e.extra.findIndex((c) => c.id === chId);
    if (i < 0) throw new Error('Nie ma takiego kanału.');
    e.extra.splice(i, 1);
    delete e.overrides[chId]; delete e.check[chId];
    this.changed(planId);
  }
}
