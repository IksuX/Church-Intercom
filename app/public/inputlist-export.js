// Inputlista – wydruk (też „Zapisz jako PDF” w oknie drukowania) i plik CSV.
// Wszystko liczone w przeglądarce z widoku, który już przyszedł z serwera – działa bez internetu.
// Używane w aplikacji (inputlist.js) i w panelu (admin.js).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// W aplikacji natywnej (iPhone / Android) okno drukowania i pobieranie plików z przeglądarki nie działają.
export const canExport = () => !window.Capacitor?.isNativePlatform?.();

const planLabel = (v) => (v.plan ? [v.plan.title, v.plan.dates].filter(Boolean).join(' · ') || 'Bieżący plan' : 'Patch sali (bez planu z Planning Center)');
const stamp = () => new Date().toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
const checkText = (c) => (!c ? '' : c.state === 'ok' ? 'OK' : `PROBLEM${c.note ? ': ' + c.note : ''}`);

function rowsWithPairs(v) {
  const byId = new Map(v.rows.map((r) => [r.id, r]));
  return v.rows.map((r) => ({ ...r, pairCh: r.stereoWith ? byId.get(r.stereoWith)?.ch ?? '' : '' }));
}

// ---------- CSV ----------
// Średnik i znacznik BOM – tak, żeby polski Excel od razu rozdzielił kolumny i pokazał polskie litery.
const cell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(v) {
  const head = ['Kanał', 'Nazwa', 'Źródło', 'Kto', 'Sprzęt', 'Wejście', '48V', 'Statyw', 'Stereo z kanałem', 'Uwagi', 'Używany', 'Line check', 'Sprawdził'];
  const lines = rowsWithPairs(v).map((r) => [
    r.ch, r.name, r.source, r.people.join(', ') || (r.always ? 'zawsze' : ''), r.gear, r.input, r.phantom ? 'tak' : '', r.stand,
    r.pairCh, r.notes, r.active ? 'tak' : 'nie', checkText(r.check), r.check?.by || '',
  ]);
  return '﻿' + [head, ...lines].map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n';
}
const fileName = (v, ext) => {
  const base = (v.plan ? [v.plan.dates, v.plan.title].filter(Boolean).join(' ') : 'patch') || 'plan';
  return `inputlista-${base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'plan'}.${ext}`;
};
export function downloadCsv(v) {
  const url = URL.createObjectURL(new Blob([toCsv(v)], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName(v, 'csv') });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- wydruk ----------
// Osobny blok na końcu strony + style tylko do druku: reszta strony znika na czas drukowania.
// Kolumna „✓” zostaje pusta (kratka do odhaczenia na papierze), chyba że kanał już sprawdzono w aplikacji.
const PRINT_CSS = `
@media screen { #ikIlPrint { display: none !important; } }
@media print {
  @page { size: A4 landscape; margin: 10mm; }
  html, body { background: #fff !important; color: #000 !important; height: auto !important; overflow: visible !important; }
  body > *:not(#ikIlPrint) { display: none !important; }
  #ikIlPrint { display: block !important; font: 10pt/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #000; }
  #ikIlPrint h1 { font-size: 15pt; margin: 0 0 2pt; }
  #ikIlPrint .sub { font-size: 9pt; color: #444; margin: 0 0 8pt; display: flex; justify-content: space-between; gap: 12pt; }
  #ikIlPrint table { width: 100%; border-collapse: collapse; }
  #ikIlPrint th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1.5pt solid #000; padding: 3pt 4pt; }
  #ikIlPrint td { border-bottom: .5pt solid #999; padding: 4pt; vertical-align: top; }
  #ikIlPrint tr { break-inside: avoid; }
  #ikIlPrint td.ch { font-weight: 700; font-size: 12pt; width: 26pt; text-align: center; }
  #ikIlPrint td.ck { width: 18pt; text-align: center; font-size: 11pt; }
  #ikIlPrint .box { display: inline-block; width: 10pt; height: 10pt; border: 1pt solid #000; }
  #ikIlPrint tr.off td { color: #888; }
  #ikIlPrint tr.off td.ch { color: #aaa; }
  #ikIlPrint .who { font-weight: 600; }
  #ikIlPrint .bad { font-weight: 700; }
  #ikIlPrint .un { margin-top: 8pt; font-size: 9pt; }
}`;
export function printList(v, org = '') {
  document.getElementById('ikIlPrint')?.remove();
  const el = document.createElement('div');
  el.id = 'ikIlPrint';
  const rows = rowsWithPairs(v);
  el.innerHTML = `<style>${PRINT_CSS}</style>
    <h1>Inputlista${org ? ' – ' + esc(org) : ''}</h1>
    <p class="sub"><span>${esc(planLabel(v))} · w użyciu ${v.summary.used} z ${v.summary.channels} kanałów</span><span>Wydrukowano ${esc(stamp())}</span></p>
    <table>
      <thead><tr><th>Kan.</th><th>Nazwa</th><th>Źródło</th><th>Kto</th><th>Sprzęt</th><th>Wejście</th><th>48V</th><th>Statyw</th><th>Uwagi</th><th>✓</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.active ? '' : 'off'}">
        <td class="ch">${r.ch}</td>
        <td><b>${esc(r.name)}</b></td>
        <td>${esc(r.source)}</td>
        <td class="who">${esc(r.people.join(', ')) || (r.always ? 'zawsze' : r.active ? '' : '—')}</td>
        <td>${esc(r.gear)}</td>
        <td>${esc(r.input)}</td>
        <td>${r.phantom ? '48V' : ''}</td>
        <td>${esc(r.stand)}</td>
        <td>${[r.pairCh && esc(`stereo z ${r.pairCh}`), r.notes && esc(r.notes), r.check?.state === 'problem' && `<span class="bad">⚠ ${esc(r.check.note || 'problem')}</span>`].filter(Boolean).join(' · ')}</td>
        <td class="ck">${r.check?.state === 'ok' ? '✓' : r.active ? '<span class="box"></span>' : ''}</td></tr>`).join('')}</tbody>
    </table>
    ${v.unassigned.length ? `<p class="un"><b>Bez kanału:</b> ${v.unassigned.map((x) => `${esc(x.name)} (${esc(x.positions.join(', ') || 'bez pozycji')})`).join(', ')}</p>` : ''}`;
  document.body.append(el);
  const done = () => { el.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
