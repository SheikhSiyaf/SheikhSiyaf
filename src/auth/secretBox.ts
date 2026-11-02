// AES-256-GCM encryption for secrets stored in the database (two-factor secrets).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFrom = (secret: string) => createHash('sha256').update(`nusuh-books:secret-box:${secret}`).digest();

export function encryptSecret(key: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function decryptSecret(key: string, boxed: string): string {
  const raw = Buffer.from(boxed.replace(/^v1\./, ''), 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFrom(key), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
