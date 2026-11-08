// Logowanie kontem Planning Center (OAuth 2 + PKCE).
// Interkom nie przechowuje tokenów użytkownika – używa ich tylko raz, żeby ustalić, kim jest osoba.
import crypto from 'node:crypto';

const AUTH_BASE = process.env.PCO_OAUTH_BASE || 'https://api.planningcenteronline.com';
const pending = new Map(); // state -> { verifier, redirectUri, t }

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function startUrl({ clientId, redirectUri }) {
  for (const [k, v] of pending) if (Date.now() - v.t > 10 * 60e3) pending.delete(k);
  const state = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  pending.set(state, { verifier, redirectUri, t: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'services',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `${AUTH_BASE}/oauth/authorize?${q}`;
}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Planning Center odpowiedział ${r.status}`);
  return r.json();
}

// Wymiana kodu na token i ustalenie osoby + organizacji
export async function finish({ clientId, clientSecret, code, state }) {
  const p = pending.get(state);
  if (!p) throw new Error('Logowanie wygasło – spróbuj ponownie.');
  pending.delete(state);
  const r = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: p.redirectUri, code_verifier: p.verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `Nie udało się zalogować (${r.status}).`);
  const me = await getJson(`${AUTH_BASE}/services/v2/me`, tok.access_token);
  const org = await getJson(`${AUTH_BASE}/services/v2`, tok.access_token).catch(() => null);
  const a = me.data?.attributes || {};
  const name = a.full_name || a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Użytkownik PC';
  return { personId: String(me.data?.id || ''), name, photo: a.photo_thumbnail_url || a.photo_url || null, orgId: org?.data?.id ? String(org.data.id) : null };
}
