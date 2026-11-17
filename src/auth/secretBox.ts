// AES-256-GCM encryption for secrets stored in the database (two-factor secrets).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFrom = (secret: string) => createHash('sha256').update(`nusuh-books:secret-box:${secret}`).digest();

export function encryptSecret(key: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

/** Thrown when a stored secret cannot be read with the ENCRYPTION_KEY the server is running with: almost always a
 *  database restored onto a server set up with a different key, which is why that key must be kept safe separately
 *  from the backups. Named so the API answers with the reason instead of an unexplained failure. */
export class SecretUnreadable extends Error {
  readonly key = 'err.secretKey';
  constructor() {
    super('A stored secret could not be read. This database was encrypted with a different ENCRYPTION_KEY than the one this server is using.');
    this.name = 'SecretUnreadable';
  }
}

export function decryptSecret(key: string, boxed: string): string {
  const raw = Buffer.from(boxed.replace(/^v1\./, ''), 'base64');
  try {
    const d = createDecipheriv('aes-256-gcm', keyFrom(key), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new SecretUnreadable();
  }
}
