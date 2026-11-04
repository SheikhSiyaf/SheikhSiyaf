// Reads settings from the environment, loading .env from the project folder if there is one.
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the real environment
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  databaseUrl: env.DATABASE_URL ?? 'postgres://nusuh_app:change-me@localhost:5432/nusuh',
  databaseAdminUrl: env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/nusuh',
  appDbPassword: env.APP_DB_PASSWORD,
  sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
  sessionSecretFromEnv: Boolean(env.SESSION_SECRET),
  cookieSecure: env.COOKIE_SECURE === 'true',
  /** Encrypts two-factor secrets in the database. Falls back to SESSION_SECRET. Never change it once in use. */
  encryptionKey: env.ENCRYPTION_KEY || env.SESSION_SECRET || '',
  /** Address used in invitation links, e.g. https://books.example.com. Defaults to the address the Administrator is using. */
  publicUrl: env.PUBLIC_URL || '',
  /** Show the demo sign-in buttons on the sign-in page. Never turn on for real client data. */
  demoLogins: env.DEMO_LOGINS === 'true',
  /** Behind your own reverse proxy: take the client address from X-Forwarded-For (true, a hop count, or proxy addresses). Off by default. */
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
};

export function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = (v ?? '').trim();
  if (!s || s === 'false' || s === '0') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return s;   // a list of proxy addresses or ranges, e.g. 10.0.0.0/8
}
