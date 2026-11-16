// Reżyseria – wybór następnej kamery, czasu na Program i przejścia. Czyste funkcje (testowalne).
import { MAX_TRANSITION_FRAMES } from './settings.js';

function randomItem(items, rng) {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/**
 * Następna kamera. `current` – co jest teraz na Program (może być spoza listy, np. plansza),
 * `last` – kamera ostatnio wybrana przez autopilota. Nigdy nie zwraca kamery z Programu;
 * undefined = nie ma innej kamery.
 */
export function pickNextCamera(cameras, order, current, last, rng) {
  const candidates = cameras.filter((c) => c !== current);
  if (candidates.length === 0) return undefined;
  if (order === 'random') {
    const fresh = current !== undefined && cameras.includes(current) ? candidates : candidates.filter((c) => c !== last);
    return randomItem(fresh.length ? fresh : candidates, rng);
  }
  const anchor = current !== undefined && cameras.includes(current) ? current : last;
  const start = anchor !== undefined ? cameras.indexOf(anchor) : -1;
  for (let step = 1; step <= cameras.length; step++) {
    const c = cameras[(start + step + cameras.length) % cameras.length];
    if (c !== current) return c;
  }
  return undefined;
}

/** Czas (ms), przez jaki kamera zostaje na Program. */
export function pickDurationMs(settings, camera, rng) {
  const t = settings.timing;
  if (t.perCameraEnabled && camera !== undefined) {
    const own = t.perCamera[String(camera)];
    if (own && own > 0) return Math.round(own * 1000);
  }
  if (t.mode === 'random') return Math.round((t.minSec + rng() * (t.maxSec - t.minSec)) * 1000);
  return Math.round(t.fixedSec * 1000);
}

/** Przejście – tylko spośród obsługiwanych przez mikser; gdy nic nie pasuje – Cut. */
export function pickTransition(settings, supported, rng) {
  const tr = settings.transitions;
  if (tr.random) {
    const pool = tr.pool.filter((k) => supported.includes(k));
    return pool.length ? randomItem(pool, rng) : 'cut';
  }
  return supported.includes(tr.style) ? tr.style : 'cut';
}

/** Czas przejścia w klatkach dla danego klatkażu (ATEM: 1–250). */
export function transitionFrames(settings, fps) {
  const tr = settings.transitions;
  const frames = tr.unit === 'seconds' ? tr.duration * fps : tr.duration;
  return Math.max(1, Math.min(MAX_TRANSITION_FRAMES, Math.round(frames)));
}

/**
 * Klatkaż z nazwy trybu wideo ATEM-a (np. "N1080p5994", "P1080i50"). Biblioteka atem-connection go nie podaje.
 * Przy przeplocie (i) czas przejścia liczy się w klatkach, czyli połowie pól.
 */
export function fpsFromVideoModeName(name) {
  if (!name) return undefined;
  const m = /([pi])(\d+)/.exec(name); // wielkie N/P = NTSC/PAL, małe p/i = rodzaj obrazu
  if (!m) return undefined;
  const digits = m[2];
  const rate = digits.length <= 2 ? Number(digits) : digits === '5000' ? 50 : Number(digits) / 100;
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return m[1] === 'i' ? rate / 2 : rate;
}
