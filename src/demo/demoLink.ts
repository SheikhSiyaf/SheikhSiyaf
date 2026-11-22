// The signed, short-lived link from the live app to the demo site, and the pass the demo site then gives the browser.
// Both are `payload.signature`: the payload says what it is for and when it expires, the signature is an HMAC with the
// secret both sites hold (DEMO_LINK_SECRET). A link made for one purpose is refused for the other, so a pass cannot be
// used to open the demo from nothing and a link cannot be kept as a long-lived pass.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type DemoPurpose = 'link' | 'pass';
export const MIN_SECRET = 32;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest();

export function signDemoToken(secret: string, purpose: DemoPurpose, ttlSeconds = 900, now = Date.now()): string {
  if (secret.length < MIN_SECRET) throw new Error(`The demo link secret must be at least ${MIN_SECRET} characters.`);
  const payload = b64(JSON.stringify({ p: purpose, e: now + ttlSeconds * 1000, n: randomBytes(8).toString('hex') }));
  return `${payload}.${b64(sign(secret, payload))}`;
}

export function verifyDemoToken(secret: string, token: unknown, purpose: DemoPurpose, now = Date.now()): boolean {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET || typeof token !== 'string' || token.length > 600) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const want = sign(secret, parts[0]);
  let got: Buffer;
  try { got = Buffer.from(parts[1], 'base64url'); } catch { return false; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { p?: unknown; e?: unknown };
    return p.p === purpose && typeof p.e === 'number' && p.e > now;
  } catch { return false; }
}
