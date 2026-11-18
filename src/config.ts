// Reads settings from the environment, loading .env from the project folder if there is one.
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the real environment
}

const env = process.env;

const production = env.NODE_ENV === 'production';

/** Development and tests only, when ENCRYPTION_KEY is not set: a fixed key so local data stays readable. Never the
 *  session secret, and never in production (the server refuses to start without ENCRYPTION_KEY there). */
export const DEV_ENCRYPTION_KEY = 'nusuh-development-only-encryption-key-not-for-real-data';

export const config = {
  /** NODE_ENV=production: unsafe settings stop the server (see validateConfig). */
  production,
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  databaseUrl: env.DATABASE_URL ?? (production ? '' : 'postgres://nusuh_app:change-me@localhost:5432/nusuh'),
  /** Only for migrations and demo data; the running server never connects with it. */
  databaseAdminUrl: env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/nusuh',
  appDbPassword: env.APP_DB_PASSWORD,
  sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
  sessionSecretFromEnv: Boolean(env.SESSION_SECRET),
  cookieSecure: env.COOKIE_SECURE === 'true',
  /** Encrypts two-factor and provider secrets in the database. Never change it once in use. It never falls back to
   *  SESSION_SECRET; in production it must be set (validateConfig), elsewhere a fixed development key is used. */
  encryptionKey: env.ENCRYPTION_KEY || (production ? '' : DEV_ENCRYPTION_KEY),
  /** Address used in links in emails, e.g. https://books.example.com. In production the only address used. */
  publicUrl: env.PUBLIC_URL || '',
  /** Show the demo sign-in buttons on the sign-in page. Never on in production. */
  demoLogins: env.DEMO_LOGINS === 'true' && !production,
  /** Behind your own reverse proxy: take the client address from X-Forwarded-For (true, a hop count, or proxy addresses). Off by default. */
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
};

/** Every unsafe setting, in plain words. In production the server refuses to start while this list is not empty;
 *  elsewhere it is printed as warnings. Pure: give it an environment, get the problems back. */
export function validateConfig(e: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const session = e.SESSION_SECRET ?? '';
  const key = e.ENCRYPTION_KEY ?? '';
  if (!session) out.push('SESSION_SECRET is not set: sign-in cookies would be signed with a random secret.');
  else if (session.length < 32) out.push('SESSION_SECRET is shorter than 32 characters.');
  else if (exampleSecret(session)) out.push('SESSION_SECRET looks like an example value: generate a random one (see .env.example).');
  if (!key) out.push('ENCRYPTION_KEY is not set: it encrypts two-factor and provider secrets and must be set on its own.');
  else {
    if (key.length < 32) out.push('ENCRYPTION_KEY is shorter than 32 characters.');
    else if (exampleSecret(key)) out.push('ENCRYPTION_KEY looks like an example value: generate a random one (see .env.example).');
    if (key === session) out.push('ENCRYPTION_KEY is the same as SESSION_SECRET: use two different secrets.');
  }
  const db = e.DATABASE_URL ?? '';
  if (!db) out.push('DATABASE_URL is not set.');
  else {
    let u: URL | null = null;
    try { u = new URL(db); } catch { out.push('DATABASE_URL is not a valid postgres:// address.'); }
    if (u) {
      const user = decodeURIComponent(u.username);
      // Through a shared connection pooler the project is named in the username, after the role: Supabase's
      // "Connecting to your database" guide says "If you connect as a custom role through the shared pooler, the
      // username is [ROLE].[PROJECT-REF]". So the server signs in as nusuh_app.<project-ref> there. The role is
      // what row-level security applies to, so only the part before the dot decides, and a superuser is still
      // refused with or without a project suffix.
      const role = user.split('.')[0]!;
      if (role !== 'nusuh_app') out.push(`DATABASE_URL connects as "${user || '(none)'}": the server must connect as nusuh_app (row-level security applies to it), never as postgres or another superuser. A shared pooler adds the project to the username, as in nusuh_app.your-project-ref, and that is fine.`);
      if (decodeURIComponent(u.password) === 'change-me') out.push('DATABASE_URL uses the example password change-me.');
    }
    if (e.DATABASE_ADMIN_URL && e.DATABASE_ADMIN_URL === db) out.push('DATABASE_URL is the same as DATABASE_ADMIN_URL: the server must not use the owner connection.');
  }
  if (e.COOKIE_SECURE !== 'true') out.push('COOKIE_SECURE is not true: sign-in cookies would be sent without HTTPS.');
  const pub = e.PUBLIC_URL ?? '';
  if (!pub) out.push('PUBLIC_URL is not set: links in emails need the real https:// address.');
  else if (!/^https:\/\/[^\s/]+/i.test(pub)) out.push('PUBLIC_URL does not start with https://.');
  if (e.DEMO_LOGINS === 'true') out.push('DEMO_LOGINS is true: demo sign-in buttons must never be on with real data.');
  // Behind a host's proxy every visitor would otherwise share the proxy's address, so one person's wrong passwords would
  // lock everyone out of signing in. The setting must be a decision: the number of proxies in front, or false for none.
  if (!(e.TRUST_PROXY ?? '').trim()) out.push('TRUST_PROXY is not set: set it to the number of proxies in front of the server (1 on most hosts, such as Render), or false if visitors connect to it directly.');
  if (e.ERROR_REPORT_URL && !/^https:\/\/[^\s/]+/i.test(e.ERROR_REPORT_URL)) out.push('ERROR_REPORT_URL does not start with https://: error reports must be sent encrypted.');
  return out;
}

/** A secret someone typed or copied rather than generated: example words, the development key, or very few different
 *  characters (for example 32 times "a" or "abcabc..."). */
export function exampleSecret(s: string): boolean {
  if (s === DEV_ENCRYPTION_KEY) return true;
  if (/change.?me|example|replace|your.?(secret|key)|placeholder|secret|password|passw0rd|demo|test|sample|default|todo|xxxx|1234|abcd|qwerty/i.test(s)) return true;
  return new Set(s).size < 10;
}

export function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = (v ?? '').trim();
  if (!s || s === 'false' || s === '0') return false;
  if (s === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return s;   // a list of proxy addresses or ranges, e.g. 10.0.0.0/8
}
