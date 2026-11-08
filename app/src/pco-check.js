// Sprawdzenie połączenia z Planning Center i podgląd danych do konfiguracji.
// Użycie na serwerze:  sudo docker compose exec app node src/pco-check.js
import { PlanningCenter } from './pco.js';
import { loadConfig } from './config.js';

const cfg = loadConfig(process.env.CONFIG_PATH || '/config/config.json');
if (!process.env.PCO_APP_ID || !process.env.PCO_SECRET) {
  console.log('Brak PCO_APP_ID / PCO_SECRET w pliku .env. Uruchom: sudo bash install.sh --pco');
  process.exit(1);
}
const pco = new PlanningCenter({ appId: process.env.PCO_APP_ID, secret: process.env.PCO_SECRET, base: process.env.PCO_BASE_URL, cfg: cfg.planningCenter || {} });
try {
  await pco.loadStructure();
  console.log('\n✔ Połączenie z Planning Center działa.\n');
  console.log('Typy nabożeństw (id – nazwa):');
  for (const s of pco.state.serviceTypes) console.log(`  ${s.id} – ${s.name}`);
  console.log('\nZespoły → kanały w interkomie:');
  const ch = pco.channels(cfg.channels);
  for (const t of pco.state.teams) console.log(`  ${t.name}  →  ${ch.find((c) => c.id === pco.teamToChannel.get(t.id))?.name}`);
  await pco.refresh();
  const p = pco.state.plan;
  console.log(`\nBieżący plan: ${p ? `${p.serviceTypeName} · ${p.dates} ${p.title} (${p.items.length} punktów)` : 'brak'}`);
  if (p) {
    console.log('\nObsada (🎙 = może mówić):');
    for (const x of pco.state.roster) console.log(`  ${x.canSpeak ? '🎙' : '  '} ${x.name} – ${x.teamNames.join(', ')} – ${x.positions.join(', ')}`);
    const pos = [...new Set(pco.state.roster.flatMap((x) => x.positions))].sort();
    console.log(`\nStanowiska w tym planie (do "speakerPositions"): ${pos.join(', ') || '—'}`);
  }
  console.log(`Liderzy zespołów: ${pco.state.leaders.size} (mogą mówić: ${pco.cfg.teamLeadersCanSpeak ? 'tak' : 'nie'})\n`);
} catch (e) {
  console.log('\n✘ ' + e.message + '\n');
  process.exit(1);
}
