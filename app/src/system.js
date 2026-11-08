// Stan komputera-serwera (procesor, pamięć, dysk, temperatura) – odczyt z /proc i /sys hosta.
// Kontener widzi /proc/stat, /proc/meminfo, /proc/uptime i /sys całego komputera, więc liczby dotyczą serwera, nie kontenera.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// obciążenie procesora: różnica liczników z /proc/stat co 2 s
let prev = null, cpuPct = null;
function sampleCpu() {
  const line = read('/proc/stat').split('\n')[0];
  if (!line.startsWith('cpu ')) return;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0), total = v.reduce((a, b) => a + b, 0);
  if (prev && total > prev.total) cpuPct = Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10;
  prev = { idle, total };
}
sampleCpu();
setInterval(sampleCpu, 2000).unref();

function memInfo() {
  const m = {};
  for (const l of read('/proc/meminfo').split('\n')) { const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]) * 1024; }
  if (!m.MemTotal) return { total: os.totalmem(), avail: os.freemem(), used: os.totalmem() - os.freemem() };
  const avail = m.MemAvailable ?? m.MemFree;
  return { total: m.MemTotal, avail, used: m.MemTotal - avail, swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
}

function diskInfo(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - s.bfree * s.bsize };
  } catch { return null; }
}

// temperatura procesora: strefa „x86_pkg_temp”, potem czujnik coretemp/k10temp; inne strefy (np. karta Wi-Fi, ACPI)
// bywają zawyżone albo błędne – bierzemy je tylko w ostateczności i tylko w rozsądnym zakresie
function cpuTemp() {
  const zones = [];
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const type = read(`/sys/class/thermal/${z}/type`).trim(), t = Number(read(`/sys/class/thermal/${z}/temp`)) / 1000;
      if (t > 0 && t < 110) zones.push({ type, t });
    }
  } catch {}
  const pkg = zones.find((z) => z.type === 'x86_pkg_temp');
  if (pkg) return Math.round(pkg.t);
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const name = read(`/sys/class/hwmon/${h}/name`).trim();
      if (!/coretemp|k10temp|zenpower/.test(name)) continue;
      const t = Number(read(`/sys/class/hwmon/${h}/temp1_input`)) / 1000;
      if (t > 0 && t < 110) return Math.round(t);
    }
  } catch {}
  const cpuish = zones.filter((z) => /cpu|soc|acpitz|x86/i.test(z.type));
  return cpuish.length ? Math.round(Math.max(...cpuish.map((z) => z.t))) : null;
}

export function systemInfo(dataDir) {
  const cpus = os.cpus();
  const up = Number(read('/proc/uptime').split(' ')[0]) || os.uptime();
  return {
    cpu: { pct: cpuPct, cores: cpus.length, model: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(), load: os.loadavg().map((x) => Math.round(x * 100) / 100), temp: cpuTemp() },
    mem: memInfo(),
    disk: diskInfo(dataDir),
    uptimeSec: Math.round(up),
    kernel: read('/proc/sys/kernel/osrelease').trim() || os.release(),
  };
}

// Sterowanie komputerem: aplikacja w kontenerze nie może sama zrestartować serwera – zapisuje polecenie do pliku,
// a usługa systemd na serwerze (instalowana przez install.sh) je wykonuje. Plik „helper” = usługa jest zainstalowana.
export function controlDir(dataDir) { return path.join(dataDir, 'control'); }
export function helperInfo(dataDir) {
  const v = read(path.join(controlDir(dataDir), 'helper')).trim();
  return v ? { installed: true, version: v } : { installed: false };
}
export function requestAction(dataDir, action) {
  const dir = controlDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.tmp'), JSON.stringify({ action, at: new Date().toISOString() }));
  fs.renameSync(path.join(dir, 'request.tmp'), path.join(dir, 'request'));
}
