// Inputlista w aplikacji – kanały konsolety na bieżące nabożeństwo: kto, na czym, do którego wejścia.
// Stan przychodzi z serwera przez WebSocket ({ t: 'inputlist', view }); null = brak dostępu.
// Rola Dźwięk (perm.sound) odhacza line check, zgłasza problemy i poprawia kanały na to jedno nabożeństwo –
// polecenia idą przez WebSocket (ilCheck / ilOverride / ilReset), a nowy widok wraca do wszystkich.
import { canExport, downloadCsv, printList } from '/inputlist-export.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const FILTERS = [['used', 'Używane'], ['todo', 'Do sprawdzenia'], ['problem', 'Problemy'], ['all', 'Wszystkie']];

export function createInputList({ onOpen, isOpen, send, org = () => '' }) {
  const btn = document.getElementById('btnInputlist');
  const box = document.getElementById('sheetInputlist');
  let view = null;
  let allowed = false, canEdit = false;
  let filter = 'used';
  let openId = null;      // kanał z rozwiniętym panelem (zgłoszenie / poprawka)
  let draft = {};         // to, co ktoś wpisuje w panelu – przetrwa odświeżenie listy przez innych
  let error = '';
  let resetArmed = 0;
  try { filter = localStorage.getItem('ik-il-filter') || 'used'; } catch {}
  if (!FILTERS.some(([k]) => k === filter)) filter = 'used';

  btn.onclick = () => onOpen();

  const row = (id) => view?.rows.find((r) => r.id === id);
  function openEditor(id) {
    if (openId === id) { openId = null; render(); return; }
    const r = row(id);
    if (!r) return;
    openId = id;
    // poprawka „na dziś”: stan z serwera (przy braku poprawki pola są puste = jak w patchu)
    draft = { note: r.check?.state === 'problem' ? r.check.note : '', active: '', person: '', notes: '' };
    render();
    box.querySelector('.il-ed [data-f="note"]')?.focus({ preventScroll: true });
  }

  box.addEventListener('click', (e) => {
    const t = e.target;
    const f = t.closest('[data-ilf]');
    if (f) {
      filter = f.dataset.ilf;
      try { localStorage.setItem('ik-il-filter', filter); } catch {}
      return render();
    }
    const ex = t.closest('[data-x]')?.dataset.x;
    if (ex && view) return ex === 'print' ? printList(view, org()) : downloadCsv(view);
    if (!canEdit) return;
    const li = t.closest('.il-row');
    const id = li?.dataset.id;
    const a = t.closest('[data-a]')?.dataset.a;
    if (a === 'check') {
      const r = row(id);
      // ○ → ✓ → ○; zgłoszony problem po dotknięciu uznajemy za rozwiązany (✓)
      send({ t: 'ilCheck', ch: id, state: r?.check?.state === 'ok' ? null : 'ok' });
      return;
    }
    if (a === 'problem') { send({ t: 'ilCheck', ch: openId, state: 'problem', note: draft.note || '' }); openId = null; return render(); }
    if (a === 'clear') { send({ t: 'ilCheck', ch: openId, state: null }); openId = null; return render(); }
    if (a === 'save') {
      const patch = {};
      if (draft.active) patch.active = draft.active === 'on';
      if (draft.person.trim()) patch.person = draft.person.trim();
      if (draft.notes.trim()) patch.notes = draft.notes.trim();
      if (Object.keys(patch).length) send({ t: 'ilOverride', ch: openId, patch });
      openId = null; return render();
    }
    if (a === 'restore') { send({ t: 'ilOverride', ch: openId, patch: { active: null, person: null, notes: null } }); openId = null; return render(); }
    if (a === 'close') { openId = null; return render(); }
    if (a === 'reset') {
      if (Date.now() - resetArmed < 4000) { resetArmed = 0; send({ t: 'ilReset' }); }
      else { resetArmed = Date.now(); setTimeout(render, 4100); }
      return render();
    }
    if (li && !t.closest('.il-ed')) openEditor(id);
  });
  box.addEventListener('input', (e) => { const k = e.target.dataset.f; if (k) draft[k] = e.target.value; });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.f === 'note') { e.preventDefault(); box.querySelector('[data-a="problem"]')?.click(); }
    if (e.key === 'Escape' && openId) { openId = null; render(); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('il-main') && canEdit) { e.preventDefault(); openEditor(e.target.closest('.il-row').dataset.id); }
  });

  function syncButton() {
    btn.hidden = !allowed;
    const p = view?.summary.problem || 0;
    btn.classList.toggle('il-alert', p > 0);
    btn.title = p ? `Inputlista – zgłoszone problemy: ${p}` : 'Inputlista – kanały na to nabożeństwo';
  }

  function checkHtml(r) {
    const c = r.check;
    if (!c) return '';
    return c.state === 'ok'
      ? `<div class="il-ck ok">✓ ${esc(c.by)} · ${hhmm(c.at)}</div>`
      : `<div class="il-ck bad">⚠ ${esc(c.note || 'problem')} <span class="il-dim">· ${esc(c.by)} · ${hhmm(c.at)}</span></div>`;
  }

  function editorHtml(r) {
    const act = [['', `Jak w patchu (${r.active ? 'używany' : 'nieużywany'})`], ['on', 'Używany dziś'], ['off', 'Nieużywany dziś']];
    return `<div class="il-ed">
      <label class="il-f">Problem na line checku<input data-f="note" maxlength="200" value="${esc(draft.note)}" placeholder="np. trzeszczy, brak sygnału" enterkeyhint="send"></label>
      <div class="il-btns">
        <button type="button" data-a="problem" class="danger">⚠ Zgłoś problem</button>
        ${r.check ? '<button type="button" data-a="clear">Wyczyść stan</button>' : ''}
      </div>
      <div class="il-sep">Tylko na to nabożeństwo${r.overridden ? ' <span class="il-tag">poprawiony</span>' : ''}</div>
      <label class="il-f">Kanał<select data-f="active">${act.map(([v, l]) => `<option value="${v}" ${draft.active === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="il-f">Kto (zamiast obsady)<input data-f="person" maxlength="60" value="${esc(draft.person)}" placeholder="${esc(r.people.join(', ') || 'np. gość')}"></label>
      <label class="il-f">Uwagi<input data-f="notes" maxlength="200" value="${esc(draft.notes)}" placeholder="${esc(r.notes || 'np. własny DI')}"></label>
      <div class="il-btns">
        <button type="button" data-a="save" class="primary">Zapisz poprawkę</button>
        ${r.overridden ? '<button type="button" data-a="restore">Przywróć z patchu</button>' : ''}
        <button type="button" data-a="close">Zamknij</button>
      </div>
    </div>`;
  }

  function rowHtml(r, byId) {
    const pair = r.stereoWith && byId.get(r.stereoWith);
    const meta = [r.gear, r.input, r.phantom && '48V', r.stand && `statyw: ${r.stand}`, pair && `stereo z kan. ${pair.ch}`]
      .filter(Boolean).map(esc).join(' · ');
    const who = r.people.length ? esc(r.people.join(', ')) : r.always ? '<span class="il-dim">zawsze</span>' : r.active ? '' : '<span class="il-dim">nieużywany</span>';
    const st = r.check?.state || 'none';
    const ckLabel = { none: 'Oznacz jako sprawdzony', ok: 'Sprawdzony – dotknij, żeby cofnąć', problem: 'Problem – dotknij, gdy rozwiązany' }[st];
    return `<li class="il-row${r.active ? '' : ' off'}${r.extra ? ' extra' : ''}${canEdit ? ' edit' : ''}${openId === r.id ? ' open' : ''}" data-id="${esc(r.id)}">
      <span class="il-ch" aria-label="Kanał ${r.ch}">${r.ch}</span>
      <div class="il-main"${canEdit ? ` role="button" tabindex="0" aria-expanded="${openId === r.id}" aria-label="Kanał ${r.ch}: zgłoś problem albo popraw"` : ''}>
        <div class="il-t"><b>${esc(r.name) || '—'}</b>${r.source ? `<span class="il-src">${esc(r.source)}</span>` : ''}${r.extra ? '<span class="il-tag">tylko dziś</span>' : ''}${r.overridden ? '<span class="il-tag">poprawiony</span>' : ''}</div>
        ${who ? `<div class="il-who">${who}</div>` : ''}
        ${meta ? `<div class="il-meta">${meta}</div>` : ''}
        ${r.notes ? `<div class="il-note">${esc(r.notes)}</div>` : ''}
        ${checkHtml(r)}
      </div>
      ${canEdit && r.active ? `<button type="button" class="il-cb ${st}" data-a="check" aria-label="${ckLabel}" title="${ckLabel}">${st === 'ok' ? '✓' : st === 'problem' ? '!' : ''}</button>` : canEdit ? '<span></span>' : ''}
      ${openId === r.id ? editorHtml(r) : ''}
    </li>`;
  }

  function footHtml(s) {
    const armed = resetArmed && Date.now() - resetArmed < 4000;
    const btns = [
      canExport() && view.rows.length && '<button type="button" data-x="print">Drukuj / PDF</button>',
      canExport() && view.rows.length && '<button type="button" data-x="csv">Pobierz CSV</button>',
      canEdit && (s.ok || s.problem) && `<button type="button" data-a="reset" class="${armed ? 'danger' : ''}">${armed ? 'Na pewno? Dotknij ponownie' : 'Wyzeruj line check'}</button>`,
    ].filter(Boolean);
    const hint = !canExport() && view.rows.length ? '<p class="hint">Wydruk i plik CSV – z przeglądarki na komputerze albo z panelu administracyjnego.</p>' : '';
    return btns.length || hint ? `<div class="il-foot">${btns.join('')}</div>${hint}` : '';
  }

  function render() {
    syncButton();
    if (!isOpen()) return;
    if (!view) {
      box.innerHTML = `<p class="hint">${allowed ? 'Wczytuję inputlistę…' : 'Inputlista jest niedostępna – brak połączenia z serwerem albo uprawnień.'}</p>`;
      return;
    }
    // odświeżenie przez innych nie może zabrać kursora z pola, w którym ktoś pisze
    const ae = document.activeElement;
    const focus = ae && box.contains(ae) && ae.dataset.f ? { f: ae.dataset.f, s: ae.selectionStart, e: ae.selectionEnd } : null;
    const scroll = box.scrollTop;

    const v = view, s = v.summary;
    if (openId && !row(openId)) openId = null;
    const byId = new Map(v.rows.map((r) => [r.id, r]));
    const pick = {
      used: (r) => r.active,
      todo: (r) => r.active && r.check?.state !== 'ok',
      problem: (r) => r.check?.state === 'problem',
      all: () => true,
    }[filter];
    const rows = v.rows.filter((r) => pick(r) || r.id === openId);
    const planTxt = v.plan ? [v.plan.title, v.plan.dates].filter(Boolean).join(' · ') || 'Bieżący plan' : 'Bez planu z Planning Center – cały patch, bez obsady';
    const empty = { used: 'Żaden kanał nie jest dziś używany.', todo: 'Wszystkie używane kanały są sprawdzone. ✓', problem: 'Brak zgłoszonych problemów.', all: '' }[filter];
    box.innerHTML = `
      <div class="il-head">
        <p class="hint">${esc(planTxt)}</p>
        <div class="il-sum"><span><b>${s.ok}</b> z ${s.used} sprawdzonych</span>${s.problem ? `<span class="il-bad">⚠ ${s.problem} ${s.problem === 1 ? 'problem' : s.problem < 5 ? 'problemy' : 'problemów'}</span>` : ''}<span class="il-dim">· ${s.used} z ${s.channels} kanałów w użyciu</span></div>
        <div class="il-bar" aria-hidden="true"><i style="width:${s.used ? Math.round((s.ok / s.used) * 100) : 0}%"></i></div>
        <div class="il-filter" role="group" aria-label="Pokaż kanały">${FILTERS.map(([k, l]) => `<button type="button" data-ilf="${k}" aria-pressed="${filter === k}">${l}${k === 'problem' && s.problem ? ` (${s.problem})` : ''}</button>`).join('')}</div>
        ${error ? `<p class="il-err" role="alert">${esc(error)}</p>` : ''}
      </div>
      ${rows.length ? `<ol class="il-rows">${rows.map((r) => rowHtml(r, byId)).join('')}</ol>`
        : `<p class="hint">${v.rows.length ? empty : 'Patch jest pusty – administrator uzupełnia go w panelu (zakładka Inputlista).'}</p>`}
      ${v.unassigned.length ? `<div class="il-un"><h3>Bez kanału</h3><ul>${v.unassigned.map((x) => `<li><b>${esc(x.name)}</b> <span class="il-dim">${esc(x.positions.join(', ') || 'bez pozycji')}${x.reason === 'noFreeChannel' ? ' – zabrakło wolnego kanału' : ''}</span></li>`).join('')}</ul></div>` : ''}
      ${footHtml(s)}`;

    box.scrollTop = scroll;
    if (focus) {
      const el = box.querySelector(`.il-ed [data-f="${focus.f}"]`);
      if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(focus.s, focus.e); } catch {} }
    }
  }

  return {
    perm(p) {
      allowed = !!p?.inputList; canEdit = allowed && !!p?.sound;
      if (!allowed) view = null;
      if (!canEdit) openId = null;
      render();
    },
    state(v) { view = v || null; if (v) allowed = true; error = ''; render(); },
    error(msg) { error = msg || ''; render(); setTimeout(() => { if (error === msg) { error = ''; render(); } }, 6000); },
    render,
  };
}
