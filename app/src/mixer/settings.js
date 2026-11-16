// Reżyseria – ustawienia autopilota (kamery, czasy, kolejność, przejścia) i ich walidacja.

/** @typedef {'cut'|'mix'|'dip'|'wipe'} TransitionKind */
export const TRANSITION_KINDS = ['cut', 'mix', 'dip', 'wipe'];
export const TRANSITION_LABELS = { cut: 'Cut', mix: 'Mix', dip: 'Dip', wipe: 'Wipe' };

export const DEFAULT_SETTINGS = Object.freeze({
  cameras: [],
  timing: { mode: 'fixed', fixedSec: 10, minSec: 6, maxSec: 14, perCameraEnabled: false, perCamera: {} },
  order: 'sequential',
  transitions: { style: 'cut', random: false, pool: ['cut', 'mix'], duration: 25, unit: 'frames' },
});

export const MIN_INTERVAL_SEC = 1;
export const MAX_INTERVAL_SEC = 3600;
export const MAX_TRANSITION_FRAMES = 250;

function num(v, def, min, max) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
const isKind = (v) => typeof v === 'string' && TRANSITION_KINDS.includes(v);

/** Poprawia ustawienia z interfejsu, API albo pliku. Nigdy nie rzuca wyjątku. */
export function sanitizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_SETTINGS;

  const cameras = [];
  if (Array.isArray(s.cameras)) {
    for (const c of s.cameras) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 0 && !cameras.includes(n) && cameras.length < 64) cameras.push(n);
    }
  }

  const t = s.timing && typeof s.timing === 'object' ? s.timing : {};
  let minSec = num(t.minSec, d.timing.minSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  let maxSec = num(t.maxSec, d.timing.maxSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
  if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec];
  const perCamera = {};
  if (t.perCamera && typeof t.perCamera === 'object') {
    for (const [k, v] of Object.entries(t.perCamera)) {
      const id = Number(k);
      const sec = num(v, 0, 0, MAX_INTERVAL_SEC);
      if (Number.isInteger(id) && id >= 0 && sec >= MIN_INTERVAL_SEC) perCamera[String(id)] = sec;
    }
  }

  const tr = s.transitions && typeof s.transitions === 'object' ? s.transitions : {};
  const pool = Array.isArray(tr.pool) ? TRANSITION_KINDS.filter((k) => tr.pool.includes(k)) : [...d.transitions.pool];
  const unit = tr.unit === 'seconds' ? 'seconds' : 'frames';

  return {
    cameras,
    timing: {
      mode: t.mode === 'random' ? 'random' : 'fixed',
      fixedSec: num(t.fixedSec, d.timing.fixedSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
      minSec,
      maxSec,
      perCameraEnabled: Boolean(t.perCameraEnabled),
      perCamera,
    },
    order: s.order === 'random' ? 'random' : 'sequential',
    transitions: {
      style: isKind(tr.style) ? tr.style : d.transitions.style,
      random: Boolean(tr.random),
      pool,
      duration: unit === 'seconds' ? num(tr.duration, 1, 0.04, 10) : Math.round(num(tr.duration, 25, 1, MAX_TRANSITION_FRAMES)),
      unit,
    },
  };
}
