// How every database connection is encrypted and verified, decided here rather than left to the connection string.
// Kept free of the rest of the program (no config, no session code) so settings validation, the server, the migration
// and the first-owner command can all use the same rule without importing each other.
import { X509Certificate } from 'node:crypto';
import type pg from 'pg';

/**
 * A database reached over the public internet holds every row of a client's books, so its certificate must be verified.
 * The driver's own default is not good enough to rely on: sslmode=require to a server holding a self-signed certificate
 * connects without complaint, so the connection is encrypted but the server is never checked.
 *
 * So: a database reached over the public internet must present a certificate we can verify. Most hosts use a public
 * authority (Neon, Render's external address) and nothing more is needed. Supabase does not: its certificates are signed
 * by its own authority, and its documentation tells you to download the CA file (prod-ca-2021.crt). An earlier version
 * of this comment said Supabase needed no such file; that was a guess, caught by reading their documentation. For such
 * a host the authority's certificate is supplied (DATABASE_CA_CERT, a public certificate and not a secret) and is then
 * the ONLY authority trusted for that connection. There is deliberately no way to switch verification off through the
 * connection string, because that switch would be the first thing a mistake reaches for.
 *
 * ONE EXCEPTION, which Render's own documentation requires: its internal address (a host name with no dots, such as
 * dpg-abc123-a) uses a self-signed certificate and "does not support sslmode=verify-ca or verify-full". A name with no
 * dots exists only on the host's private network and cannot be reached from the internet, so there is nobody to stand
 * in the middle. For those the connection is still encrypted, with no fall-back to plaintext, but the certificate is
 * accepted.
 *
 * Returns undefined for a local database, where there is no network to listen on and certificates are self-signed.
 */
export function sslFor(connectionString: string, ca?: string): pg.PoolConfig['ssl'] {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;   // not a URL at all: a unix socket or a local development setting
  }
  const local = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (local) return undefined;
  const privateName = !host.includes('.') && !host.includes(':') && !host.startsWith('[');
  if (privateName) return { rejectUnauthorized: false };
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/**
 * The certificate authority as it arrives in a host setting. Hosts differ in how they keep a multi-line value, so the
 * two characters "\n" between lines are accepted as well as real line breaks. Empty means not set. Anything else must
 * be a certificate we can parse: connecting "with an authority" that cannot verify anything would be worse than none.
 */
export function caFrom(value: string | undefined): string | undefined {
  const v = (value ?? '').trim().replace(/\\n/g, '\n');
  if (!v) return undefined;
  const pem = v.trim();
  try {
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) throw new Error('no certificate block');
    new X509Certificate(pem);
  } catch {
    throw new Error('DATABASE_CA_CERT is not a PEM certificate (it should start with -----BEGIN CERTIFICATE-----).');
  }
  return pem;
}

/** The settings for a single connection (migrations, demo data, the first owner), with the same verification rule. */
export function clientConfig(connectionString: string, ca?: string): pg.ClientConfig {
  return { connectionString, ssl: sslFor(connectionString, ca) };
}
