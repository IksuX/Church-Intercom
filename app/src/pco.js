// Integracja z Planning Center Services (API v2, JSON:API).
// Uwierzytelnianie: Personal Access Token (Application ID + Secret) – Basic Auth.
// Wszystko tylko do odczytu. Dane są buforowane – w razie braku internetu zostaje ostatni stan.

import { PCO_DEFAULTS } from './config.js';

const DEFAULT_BASE = 'https://api.planningcenteronline.com/services/v2';
const COLORS = ['#60a5fa', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9'];
const norm = (s) => String(s || '').trim().toLocaleLowerCase('pl');
const slug = (s) => norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'kanal';

export class PlanningCenter {
  constructor({ appId, secret, base, cfg = {}, onChange = () => {} }) {
    this.auth = 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64');
    this.base = (base || DEFAULT_BASE).replace(/\/$/, '');
    this.cfg = { ...PCO_DEFAULTS, ...cfg };
    this.onChange = onChange;
    this.state = { ok: false, error: null, serviceTypes: [], teams: [], leaders: new Set(), plan: null, roster: [], manualPlan: null };
    this.timers = [];
  }

  // ---------- HTTP ----------
  async req(pathOrUrl, attempt = 0, method = 'GET') {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.base + pathOrUrl;
    const r = await fetch(url, { method, headers: { authorization: this.auth, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429 && attempt < 3) {
      const wait = Number(r.headers.get('retry-after') || 5);
      await new Promise((res) => setTimeout(res, wait * 1000));
      return this.req(pathOrUrl, attempt + 1, method);
    }
    if (method !== 'GET') {
      if (!r.ok) { const e = new Error(`Planning Center: ${r.status}`); e.status = r.status; throw e; }
      return r.status === 204 ? {} : r.json().catch(() => ({}));
    }
    if (r.status === 401) throw new Error('Planning Center: nieprawidłowy token (401)');
    if (r.status === 403) throw new Error('Planning Center: brak uprawnień do Services (403)');
    if (!r.ok) throw new Error(`Planning Center: błąd ${r.status} dla ${url.replace(this.base, '')}`);
    return r.json();
  }
  async all(path) {
    const out = { data: [], included: [] };
    let next = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    for (let i = 0; next && i < 20; i++) {
      const j = await this.req(next);
      out.data.push(...(j.data || []));
      out.included.push(...(j.included || []));
      next = j.links?.next || null;
    }
    return out;
  }

  // ---------- dane podstawowe ----------
  async loadStructure() {
    try { const root = await this.req(''); this.state.orgId = root.data?.id ? String(root.data.id) : null; } catch { this.state.orgId = null; }
    const st = await this.all('/service_types');
    const wanted = this.cfg.serviceTypeIds.map(String);
    this.state.allServiceTypes = st.data.map((s) => ({ id: String(s.id), name: s.attributes?.name || `Typ ${s.id}` }));
    this.state.serviceTypes = st.data
      .filter((s) => !wanted.length || wanted.includes(String(s.id)))
      .map((s) => ({ id: String(s.id), name: s.attributes?.name || `Typ ${s.id}` }));
    const teams = [];
    for (const s of this.state.serviceTypes) {
      const t = await this.all(`/service_types/${s.id}/teams`);
      for (const x of t.data) if (!x.attributes?.archived_at) teams.push({ id: String(x.id), name: x.attributes?.name || `Zespół ${x.id}`, serviceTypeId: s.id });
    }
    this.state.teams = teams;
    const leaders = new Set();
    if (this.cfg.teamLeadersCanSpeak) {
      for (const t of teams) {
        try {
          const l = await this.all(`/teams/${t.id}/team_leaders`);
          for (const x of l.data) { const pid = x.relationships?.person?.data?.id; if (pid) leaders.add(String(pid)); }
        } catch { /* brak uprawnień do liderów – pomijamy */ }
      }
    }
    this.state.leaders = leaders;
    // wszystkie stanowiska w zespołach – podpowiedzi w panelu administratora
    const positions = new Set();
    for (const t of teams) {
      try {
        const tp = await this.all(`/teams/${t.id}/team_positions`);
        for (const x of tp.data) if (x.attributes?.name) positions.add(x.attributes.name);
      } catch { /* pomijamy */ }
    }
    this.state.positions = [...positions].sort((a, b) => a.localeCompare(b, 'pl'));
    // kolumny notatek w planie (Item Note Categories) – każdy w aplikacji wybiera, które ma widzieć w powiadomieniach
    const cats = new Set();
    for (const s of this.state.serviceTypes) {
      try {
        const c = await this.all(`/service_types/${s.id}/item_note_categories`);
        for (const x of c.data) if (x.attributes?.name) cats.add(x.attributes.name);
      } catch { /* pomijamy */ }
    }
    this.state.noteCategories = [...cats];
  }

  // Kanały z zespołów: łączone z istniejącymi po nazwie lub według teamChannelMap.
  // teamChannelMap: { "Nazwa zespołu": "id-kanału" | "Nazwa kanału" } – nieistniejąca nazwa tworzy nowy kanał,
  // więc kilka zespołów może trafić do jednego wspólnego kanału (np. „Muzycy”).
  channels(baseChannels) {
    const out = baseChannels.map((c) => ({ ...c }));
    this.teamToChannel = new Map();
    if (!this.cfg.teamChannels) return out;
    const byName = new Map(out.map((c) => [norm(c.name), c.id]));
    const byId = new Set(out.map((c) => c.id));
    const map = Object.fromEntries(Object.entries(this.cfg.teamChannelMap || {}).map(([k, v]) => [norm(k), String(v)]));
    let ci = 0;
    const ensure = (name, idHint) => {
      const k = norm(name);
      if (byName.has(k)) return byName.get(k);
      const id = idHint;
      out.push({ id, name, color: COLORS[ci++ % COLORS.length], pco: true });
      byName.set(k, id); byId.add(id);
      return id;
    };
    for (const t of this.state.teams) {
      const target = map[norm(t.name)];
      let id;
      if (target && byId.has(target)) id = target; // podano id istniejącego kanału
      else if (target) id = ensure(target, 'pco-' + slug(target)); // podano nazwę kanału (nowego lub istniejącego)
      else id = ensure(t.name, 'pco-' + t.id);
      this.teamToChannel.set(t.id, id);
    }
    return out;
  }
  channelsForTeams(teamIds) {
    return [...new Set(teamIds.map((t) => this.teamToChannel?.get(String(t))).filter(Boolean))];
  }

  // ---------- plany ----------
  async upcomingPlans() {
    const list = [];
    for (const s of this.state.serviceTypes) {
      const fut = await this.req(`/service_types/${s.id}/plans?filter=future&order=sort_date&per_page=4`);
      const past = await this.req(`/service_types/${s.id}/plans?filter=past&order=-sort_date&per_page=1`);
      for (const p of [...(past.data || []), ...(fut.data || [])]) {
        list.push({
          id: String(p.id), serviceTypeId: s.id, serviceTypeName: s.name,
          title: p.attributes?.title || '', dates: p.attributes?.dates || '', sortDate: p.attributes?.sort_date || null,
        });
      }
    }
    return list.sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));
  }

  // Bieżący plan: dzisiejszy/trwający (od 8 h przed do 18 h po teraz), inaczej najbliższy w ciągu 7 dni.
  // Starszych planów nie wybieramy automatycznie – administrator może je wskazać ręcznie.
  pickPlan(list) {
    const now = Date.now();
    const t = (p) => new Date(p.sortDate).getTime();
    const today = list.filter((p) => p.sortDate && now - t(p) < 8 * 3600e3 && t(p) - now < 18 * 3600e3)
      .sort((a, b) => Math.abs(t(a) - now) - Math.abs(t(b) - now));
    if (today.length) return today[0];
    return list.find((p) => p.sortDate && t(p) > now && t(p) - now < 7 * 24 * 3600e3) || null;
  }

  // Punkty planu razem ze szczegółami: aranżacja (tonacja, BPM, metrum, sekwencja, notatki),
  // utwór (autor) i notatki do punktów (np. „Audio”, „Światła”, „Wokal”).
  async loadItems(p) {
    const base = `/service_types/${p.serviceTypeId}/plans/${p.id}/items?order=sequence`;
    let res;
    try { res = await this.all(base + '&include=arrangement,key,song,item_notes'); }
    catch { res = await this.all(base); } // gdy include nie jest dostępny – same punkty
    const inc = new Map(res.included.map((x) => [`${x.type}:${x.id}`, x]));
    const rel = (it, name) => {
      const d = it.relationships?.[name]?.data;
      if (!d) return Array.isArray(d) ? [] : null;
      return Array.isArray(d) ? d.map((x) => inc.get(`${x.type}:${x.id}`)).filter(Boolean) : inc.get(`${d.type}:${d.id}`) || null;
    };
    const txt = (v) => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
    return res.data.map((it) => {
      const a = it.attributes || {};
      const arr = rel(it, 'arrangement')?.attributes || {};
      const key = rel(it, 'key')?.attributes || {};
      const song = rel(it, 'song')?.attributes || {};
      const notes = (rel(it, 'item_notes') || []).map((n) => ({ category: n.attributes?.category_name || '', text: txt(n.attributes?.content) })).filter((n) => n.text);
      const seq = Array.isArray(arr.sequence_short) ? arr.sequence_short : Array.isArray(arr.sequence) ? arr.sequence : [];
      return {
        id: String(it.id),
        title: a.title || '',
        type: a.item_type || 'item',
        length: a.length || 0,
        position: a.service_position || 'during',
        description: txt(a.description),
        key: a.key_name || key.name || key.starting_key || '',
        bpm: arr.bpm || null,
        meter: arr.meter || '',
        arrangement: arr.name && arr.name !== 'Default Arrangement' ? arr.name : '',
        sequence: seq.slice(0, 40),
        arrangementNotes: txt(arr.notes),
        author: song.author || '',
        notes,
        sequenceNo: a.sequence ?? 0,
      };
    }).sort((x, y) => x.sequenceNo - y.sequenceNo);
  }

  async loadPlan(p) {
    const [items, members] = await Promise.all([
      this.loadItems(p),
      this.all(`/service_types/${p.serviceTypeId}/plans/${p.id}/team_members`),
    ]);
    const plan = {
      ...p,
      items,
      currentItemId: this.state.plan?.id === p.id ? this.state.plan.currentItemId : null,
      live: this.state.plan?.id === p.id ? this.state.plan.live : false,
      manualCurrent: this.state.plan?.id === p.id ? !!this.state.plan.manualCurrent : false,
      currentStartedAt: this.state.plan?.id === p.id ? this.state.plan.currentStartedAt || null : null,
    };
    // obsada: grupujemy po osobie, bez odmów (status D)
    const teamName = new Map(this.state.teams.map((t) => [t.id, t.name]));
    const people = new Map();
    for (const m of members.data) {
      if (m.attributes?.status === 'D') continue;
      const pid = String(m.relationships?.person?.data?.id || 'tm' + m.id);
      const tid = String(m.relationships?.team?.data?.id || '');
      const pos = m.attributes?.team_position_name || '';
      const x = people.get(pid) || { personId: pid, name: m.attributes?.name || '?', teams: [], positions: [], photo: m.attributes?.photo_thumbnail || null };
      if (tid && !x.teams.includes(tid)) x.teams.push(tid);
      if (pos && !x.positions.includes(pos)) x.positions.push(pos);
      people.set(pid, x);
    }
    const posRules = this.cfg.speakerPositions.map(norm).filter(Boolean);
    const teamRules = new Set(this.cfg.speakerTeams.map(norm));
    const roster = [...people.values()].map((x) => ({
      ...x,
      teamNames: x.teams.map((t) => teamName.get(t) || t),
      canSpeak:
        (this.cfg.teamLeadersCanSpeak && this.state.leaders.has(x.personId)) ||
        x.positions.some((p) => posRules.some((r) => norm(p).includes(r))) ||
        x.teams.some((t) => teamRules.has(norm(teamName.get(t)))),
    })).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    this.state.plan = plan;
    this.state.roster = roster;
  }

  // Bieżący punkt z Planning Center Live
  async pollLive() {
    const p = this.state.plan;
    if (!p) return false;
    const j = await this.req(`/service_types/${p.serviceTypeId}/plans/${p.id}/live?include=current_item_time`);
    const citId = j.data?.relationships?.current_item_time?.data?.id;
    let itemId = null, startedAt = null;
    if (citId) {
      const it = (j.included || []).find((x) => String(x.id) === String(citId));
      itemId = it?.relationships?.item?.data?.id ? String(it.relationships.item.data.id) : null;
      // czas rozpoczęcia bieżącego punktu w Planning Center Live – odliczanie zgodne z PC Live
      const t = Date.parse(it?.attributes?.live_start_at || '');
      if (Number.isFinite(t)) startedAt = t;
    }
    const live = !!itemId;
    if (itemId !== p.currentItemId || live !== p.live) {
      // gdy Live nie jest używany, nie kasuj punktu ustawionego ręcznie przez admina
      if (!live && p.manualCurrent) return false;
      p.currentItemId = itemId; p.live = live; p.manualCurrent = false;
      p.currentStartedAt = startedAt || (itemId ? Date.now() : null); // brak czasu z PC – liczymy od chwili zmiany
      return true;
    }
    if (startedAt && Math.abs(startedAt - (p.currentStartedAt || 0)) > 1500) { p.currentStartedAt = startedAt; return true; } // np. restart punktu w PC Live
    return false;
  }

  // ---------- sterowanie Planning Center Live ----------
  // API pozwala tylko na „następny / poprzedni”. Gdy token nie ma sterowania, przejmujemy je (toggle_control).
  async liveAction(action) {
    const p = this.state.plan;
    if (!p) throw new Error('Brak bieżącego planu.');
    const path = `/service_types/${p.serviceTypeId}/plans/${p.id}/live/${action}`;
    try { return await this.req(path, 0, 'POST'); }
    catch (e) {
      if (![403, 409, 422].includes(e.status)) throw e;
      await this.req(`/service_types/${p.serviceTypeId}/plans/${p.id}/live/toggle_control`, 0, 'POST');
      try { return await this.req(path, 0, 'POST'); }
      catch (e2) { throw new Error(e2.status === 403 ? 'Brak uprawnień do sterowania Live (token musi należeć do Editora lub Administratora).' : e2.message); }
    }
  }
  async liveStep(dir) {
    await this.liveAction(dir > 0 ? 'go_to_next_item' : 'go_to_previous_item');
    await this.pollLive();
  }
  // Skok do dowolnego punktu = kilka kroków w odpowiednią stronę (maks. 40).
  async liveGoto(itemId) {
    const p = this.state.plan;
    const idx = (id) => p.items.findIndex((i) => i.id === id);
    const target = idx(itemId);
    if (target < 0) throw new Error('Nie ma takiego punktu.');
    for (let i = 0; i < 40; i++) {
      await this.pollLive();
      const cur = idx(p.currentItemId);
      if (cur === target) return;
      const before = p.currentItemId;
      await this.liveAction(cur < 0 || cur < target ? 'go_to_next_item' : 'go_to_previous_item');
      await this.pollLive();
      if (p.currentItemId === before) return; // koniec planu – dalej się nie da
    }
  }

  setCurrentManually(itemId) {
    const p = this.state.plan;
    if (!p || !p.items.some((i) => i.id === itemId)) return false;
    p.currentItemId = itemId; p.manualCurrent = true; p.currentStartedAt = Date.now();
    return true;
  }

  // ---------- cykl pracy ----------
  async refresh() {
    try {
      if (!this.state.serviceTypes.length || !this.state.teams.length) await this.loadStructure();
      const list = await this.upcomingPlans();
      const chosen = (this.state.manualPlan && list.find((p) => p.id === this.state.manualPlan)) || this.pickPlan(list);
      this.state.upcoming = list;
      if (chosen) await this.loadPlan(chosen); else { this.state.plan = null; this.state.roster = []; }
      this.state.ok = true; this.state.error = null;
    } catch (e) {
      this.state.ok = false; this.state.error = e.message;
      console.warn('[pco]', e.message);
    }
    this.onChange('plan');
  }
  async reloadStructure() {
    try { await this.loadStructure(); this.state.error = null; } catch (e) { this.state.error = e.message; console.warn('[pco]', e.message); }
    this.onChange('structure');
  }
  async selectPlan(planId) {
    this.state.manualPlan = planId || null;
    await this.refresh();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    clearInterval(this.structureTimer);
  }

  // Szybki test danych logowania (panel administratora)
  static async test(appId, secret, base) {
    const p = new PlanningCenter({ appId, secret, base });
    const st = await p.req('/service_types?per_page=100');
    return (st.data || []).map((s) => s.attributes?.name).filter(Boolean);
  }

  async start() {
    await this.reloadStructure();
    await this.refresh();
    if (this.stopped) return;
    const loopLive = async () => {
      if (this.stopped) return;
      try { if (await this.pollLive()) this.onChange('live'); } catch (e) { /* chwilowy brak sieci */ }
      this.timers[0] = setTimeout(loopLive, this.cfg.livePollSeconds * 1000);
    };
    const loopPlan = async () => {
      if (this.stopped) return;
      await this.refresh();
      this.timers[1] = setTimeout(loopPlan, this.cfg.refreshSeconds * 1000);
    };
    this.timers[0] = setTimeout(loopLive, 1000);
    this.timers[1] = setTimeout(loopPlan, this.cfg.refreshSeconds * 1000);
    // struktura (zespoły, liderzy) raz na godzinę
    this.structureTimer = setInterval(() => this.reloadStructure(), 3600e3);
  }

  // dane planu wysyłane do klientów
  // kolumny z PCO + te, które faktycznie występują w planie
  noteCategories() {
    const set = new Set(this.state.noteCategories || []);
    for (const it of this.state.plan?.items || []) for (const n of it.notes || []) if (n.category) set.add(n.category);
    return [...set];
  }

  publicPlan() {
    const p = this.state.plan;
    if (!p) return { ok: this.state.ok, error: this.state.error, plan: null };
    return {
      ok: this.state.ok, error: this.state.error,
      plan: { id: p.id, title: p.title, dates: p.dates, serviceTypeName: p.serviceTypeName, items: p.items, currentItemId: p.currentItemId, live: p.live, manual: !!p.manualCurrent, noteCategories: this.noteCategories(),
        currentStartedAt: p.currentStartedAt || null, now: Date.now() },
    };
  }
}
