// Sign in with Google: checking the "ID token" Google hands the browser. Nothing here trusts the browser: the token is a signed statement
// from Google, checked against Google's published public keys, our own Client ID (so a token made for another app is refused), its expiry,
// the one-time value (nonce) this server gave out, and that Google itself has verified the e-mail address.
// Only the public Client ID is needed (GOOGLE_CLIENT_ID); there is no client secret anywhere.
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import { assertOutsideCalls } from '../outside.js';

export interface GoogleIdentity { sub: string; email: string; name: string }
export type GoogleKeySet = { keys: (JsonWebKey & { kid?: string })[] };
export type GoogleKeyFetcher = () => Promise<GoogleKeySet>;
export type GoogleProblem = 'bad_token' | 'wrong_app' | 'expired' | 'wrong_nonce' | 'email_unverified' | 'unavailable';

export class GoogleTokenError extends Error {
  constructor(public problem: GoogleProblem) { super(problem); }
}

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const SKEW_SECONDS = 60;

/** Google's public keys, fetched once and kept for an hour (and refetched, at most every 5 minutes, when a token names a key we do not have). */
export function googleKeyCache(fetchKeys: GoogleKeyFetcher, now: () => number = Date.now) {
  let cached: { keys: GoogleKeySet['keys']; at: number } | undefined;
  return async (kid: string | undefined): Promise<(JsonWebKey & { kid?: string }) | undefined> => {
    const fresh = cached && now() - cached.at < 3_600_000;
    const known = cached?.keys.find((k) => k.kid === kid);
    if (fresh && known) return known;
    if (cached && !known && now() - cached.at < 300_000) return undefined;   // asked recently: do not hammer Google for a made-up key id
    try { cached = { keys: (await fetchKeys()).keys ?? [], at: now() }; } catch { throw new GoogleTokenError('unavailable'); }
    return cached.keys.find((k) => k.kid === kid);
  };
}

/** The real fetch of Google's keys. Refused while OUTSIDE_CALLS=off. */
export const fetchGoogleKeys: GoogleKeyFetcher = async () => {
  assertOutsideCalls();
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Google keys ${res.status}`);
  return (await res.json()) as GoogleKeySet;
};

const decode = (part: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

export async function verifyGoogleToken(
  idToken: unknown,
  o: { clientId: string; nonce: string; getKey: (kid: string | undefined) => Promise<(JsonWebKey & { kid?: string }) | undefined>; now?: () => number },
): Promise<GoogleIdentity> {
  if (typeof idToken !== 'string' || idToken.length > 4096) throw new GoogleTokenError('bad_token');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new GoogleTokenError('bad_token');
  const header = decode(parts[0]!), claims = decode(parts[1]!);
  if (!header || !claims || header.alg !== 'RS256') throw new GoogleTokenError('bad_token');   // never "none", never a shared-secret algorithm
  const jwk = await o.getKey(typeof header.kid === 'string' ? header.kid : undefined);
  if (!jwk || jwk.kty !== 'RSA') throw new GoogleTokenError('bad_token');
  let good = false;
  try {
    good = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
  } catch { good = false; }
  if (!good) throw new GoogleTokenError('bad_token');
  const nowSec = Math.floor((o.now ?? Date.now)() / 1000);
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) throw new GoogleTokenError('bad_token');
  const aud = claims.aud;
  if (aud !== o.clientId && !(Array.isArray(aud) && aud.includes(o.clientId))) throw new GoogleTokenError('wrong_app');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < nowSec) throw new GoogleTokenError('expired');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > nowSec) throw new GoogleTokenError('bad_token');
  if (typeof claims.nonce !== 'string' || claims.nonce !== o.nonce) throw new GoogleTokenError('wrong_nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleTokenError('bad_token');
  if (typeof claims.email !== 'string' || !claims.email) throw new GoogleTokenError('bad_token');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleTokenError('email_unverified');
  const name = typeof claims.name === 'string' ? claims.name : '';
  return { sub: claims.sub, email: claims.email, name };
}
