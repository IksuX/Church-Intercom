// Reżyseria – rozpoznawanie komend głosowych w tekście z transkrypcji (Whisper).
//
//   „Przygotuj <nr>”        → kamera <nr> na Preview
//   „Wchodzisz <nr>”        → kamera <nr> na Program (przejściem domyślnym)
//   „Cut wchodzisz [<nr>]”  → na Program cięciem (bez numeru: kamera z Preview)
//   „Fade wchodzisz [<nr>]” → na Program przejściem Mix (bez numeru: kamera z Preview)
//
// Zasada bezpieczeństwa: komenda musi być „czysta” – oprócz słów komendy, numeru i kilku słów-wypełniaczy
// („kamera”, „teraz”, „proszę”…) nie może być nic więcej. Wypowiedź bez słowa komendy to zwykła rozmowa – ignorujemy ją.

const NUMBER_WORDS = [
  [/^(jedenaście|jedenascie|jedenast\p{L}*)$/u, 11],
  [/^(dwanaście|dwanascie|dwunast\p{L}*)$/u, 12],
  [/^(trzynaście|trzynascie|trzynast\p{L}*)$/u, 13],
  [/^(czternaście|czternascie|czternast\p{L}*)$/u, 14],
  [/^(piętnaście|pietnascie|piętnast\p{L}*|pietnast\p{L}*)$/u, 15],
  [/^(szesnaście|szesnascie|szesnast\p{L}*)$/u, 16],
  [/^(siedemnaście|siedemnascie|siedemnast\p{L}*)$/u, 17],
  [/^(osiemnaście|osiemnascie|osiemnast\p{L}*)$/u, 18],
  [/^(dziewiętnaście|dziewietnascie|dziewiętnast\p{L}*|dziewietnast\p{L}*)$/u, 19],
  [/^(dwadzieścia|dwadziescia|dwudziest\p{L}*)$/u, 20],
  [/^(jeden|jedna|jedno|jedynk\p{L}*|jedynecz\p{L}*|pierwsz\p{L}*)$/u, 1],
  [/^(dwa|dwie|dwu|dwo|dwój\p{L}*|dwuj\p{L}*|dwojk\p{L}*|drug\p{L}*)$/u, 2], // „dwój”, „dwo” – typowe przekręcenia Whispera
  [/^(trzy|trójk\p{L}*|trujk\p{L}*|trojk\p{L}*|trzeci\p{L}*)$/u, 3],
  [/^(cztery|czwórk\p{L}*|czwurk\p{L}*|czwork\p{L}*|twórk\p{L}*|czwart\p{L}*)$/u, 4], // „twórka” – przekręcone „czwórka”
  [/^(pięć|piec|pięc|piątk\p{L}*|piatk\p{L}*|piąt\p{L}*|piat\p{L}*)$/u, 5],
  [/^(sześć|szesc|sześc|szóstk\p{L}*|szostk\p{L}*|szóst\p{L}*|szost\p{L}*)$/u, 6],
  [/^(siedem|siódemk\p{L}*|siodemk\p{L}*|siódm\p{L}*|siodm\p{L}*)$/u, 7],
  [/^(osiem|ósemk\p{L}*|osemk\p{L}*|ósm\p{L}*|osm\p{L}*)$/u, 8],
  [/^(dziewięć|dziewiec|dziewiątk\p{L}*|dziewiatk\p{L}*|dziewiąt\p{L}*|dziewiat\p{L}*)$/u, 9],
  [/^(dziesięć|dziesiec|dziesiątk\p{L}*|dziesiatk\p{L}*|dziesiąt\p{L}*|dziesiat\p{L}*)$/u, 10],
];

const KEYWORDS = {
  prepare: /^(przygotuj\p{L}*|przygotow\p{L}*|szykuj\p{L}*)$/u,
  enter: /^(wchodzisz|wchodzimy|wchodzi|wchodź|wchodz|wejdź|wejdz|wchodzicie)$/u,
  cut: /^(cut|cat|kat|kad|kut|kąt|katt|cięcie|ciecie|cięciem|cieciem|tnij)$/u,
  fade: /^(fade|fejd|fejt|fejda|fejdem|feid|fajd|fed|fade'em|mix|miks|mixem|miksem|przenikanie|przenikaniem)$/u,
};

// słowa, które mogą stać obok komendy i niczego nie zmieniają
const FILLERS = new Set([
  'kamera', 'kamerę', 'kamere', 'kamery', 'kamerą', 'kamerka', 'kamerkę', 'kamerke', 'kam', 'cam', 'camera',
  'numer', 'nr', 'na', 'do', 'teraz', 'proszę', 'prosze', 'uwaga', 'dobra', 'dobrze', 'ok', 'okej', 'okay',
  'i', 'się', 'sie', 'to', 'już', 'juz', 'no', 'a', 'jest', 'ty', 'ją', 'go', 'program', 'programie',
]);

/** Zamienia tekst na słowa: małe litery, bez interpunkcji, cyfry odklejone od liter („kamera2” → „kamera 2”). */
export function tokenize(text) {
  return String(text || '')
    .toLocaleLowerCase('pl')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\d'\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function numberOf(token) {
  if (/^\d{1,4}$/.test(token)) return Number(token);
  for (const [re, n] of NUMBER_WORDS) if (re.test(token)) return n;
  return undefined;
}

function classify(token) {
  for (const [k, re] of Object.entries(KEYWORDS)) if (re.test(token)) return { k };
  const n = numberOf(token);
  if (n !== undefined) return { k: 'num', n };
  if (FILLERS.has(token)) return { k: 'fill' };
  return { k: 'other' };
}

/**
 * @returns {null | {ok:true, action:'preview'|'program'|'cut'|'fade', input?:number} | {ok:false, error:string}}
 *   null = to nie była komenda (zwykła rozmowa).
 */
export function parseCommand(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const parts = tokens.map(classify);
  const has = (k) => parts.some((p) => p.k === k);
  if (!['prepare', 'enter', 'cut', 'fade'].some(has)) return null;

  const others = tokens.filter((_, i) => parts[i].k === 'other');
  if (others.length) return { ok: false, error: `Niejasna komenda (nieznane słowa: ${others.slice(0, 4).join(', ')}) – nic nie wykonano` };

  const nums = [...new Set(parts.filter((p) => p.k === 'num').map((p) => p.n))];
  if (nums.length > 1) return { ok: false, error: `Kilka numerów kamer (${nums.join(', ')}) – nic nie wykonano` };
  const input = nums[0];

  const count = (k) => parts.filter((p) => p.k === k).length;
  if (has('cut') && has('fade')) return { ok: false, error: 'Naraz „cut” i „fade” – nic nie wykonano' };
  if (has('cut') || has('fade')) {
    if (has('prepare')) return { ok: false, error: 'Naraz „przygotuj” i wejście na program – nic nie wykonano' };
    return input === undefined ? { ok: true, action: has('cut') ? 'cut' : 'fade' } : { ok: true, action: has('cut') ? 'cut' : 'fade', input };
  }
  if (has('prepare') && has('enter')) return { ok: false, error: 'Naraz „przygotuj” i „wchodzisz” – nic nie wykonano' };
  if (count('prepare') + count('enter') > 2) return { ok: false, error: 'Niejasna komenda – nic nie wykonano' };
  if (input === undefined) return { ok: false, error: 'Brak numeru kamery – nic nie wykonano' };
  return { ok: true, action: has('prepare') ? 'preview' : 'program', input };
}

/** Słownik dla Whispera – podpowiada pisownię komend i liczebników. */
export const VOICE_PROMPT = 'Przygotuj dwójkę. Wchodzisz trzy. Cut wchodzisz. Fade wchodzisz cztery. Przygotuj kamerę pięć.';
export const VOICE_HOTWORDS = 'przygotuj, wchodzisz, cut, fade, kamera, jedynka, dwójka, trójka, czwórka, piątka, szóstka, siódemka, ósemka';

/** Opis komendy dla dziennika. */
export function describe(cmd, label) {
  const name = cmd.input !== undefined ? label(cmd.input) : 'kamera z Preview';
  switch (cmd.action) {
    case 'preview': return `Preview → ${name}`;
    case 'program': return `Program → ${name}`;
    case 'cut': return `Cut → ${name}`;
    case 'fade': return `Fade → ${name}`;
    default: return cmd.action;
  }
}
