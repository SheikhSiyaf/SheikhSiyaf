// Password hashing with scrypt (Node built-in). Stored as scrypt$N$r$p$salt$hash (base64).
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));

const N = 16384, R = 8, P = 1, LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Always does the same work, so response time does not reveal whether the email exists. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return Boolean(stored) && key.length === expected.length && timingSafeEqual(key, expected);
}
