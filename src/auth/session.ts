// Stateless signed session token: <userId>.<expiresAtSeconds>.<hmac>. Stored in an HttpOnly cookie.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nb_session';
export const SESSION_HOURS = 12;

const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(secret: string, userId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_HOURS * 3600;
  const data = `${userId}.${exp}`;
  return `${data}.${mac(secret, data)}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [userId, exp, sig] = token.split('.');
  if (!userId || !exp || !sig) return null;
  const good = Buffer.from(mac(secret, `${userId}.${exp}`));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  if (Number(exp) * 1000 < now) return null;
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
