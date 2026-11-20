// A check of Nusuh Books against a REAL hosted PostgreSQL (written for Supabase; works for any host). It exists because
// everything else here is tested against a local database, and a hosted one differs in ways that matter: certificates
// from a private authority, a public web API in front of the tables, an owner login that is not a superuser, a pooler
// in the path, a network between the program and the data.
//
// It runs the program's own code against the database: the migrations, the app's own login, row-level security, the
// sign-in flow through the real API. It prints a plain table and exits non-zero if anything failed. It never prints a
// password or a connection string.
//
// USE A THROWAWAY DATABASE (a new, empty Supabase project that you delete afterwards). The check refuses a database
// that already holds a customer, and it leaves one throwaway owner account behind: do not put real data in the project
// it ran against. Settings, all from the environment (in GitHub: repository secrets, see .github/workflows):
//   HOSTED_DATABASE_ADMIN_URL   the project's owner login (postgres.<ref>) via the SESSION pooler, port 5432
//   HOSTED_DATABASE_URL         the same address with the user nusuh_app.<ref> and the password below
//   HOSTED_APP_DB_PASSWORD      the password to give nusuh_app (20+ letters and digits, chosen by you)
//   HOSTED_DATABASE_CA_CERT     optional: the host's certificate authority (Supabase: prod-ca-2021.crt), a public file
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set.`); process.exit(2); } return v; };
const adminUrl = need('HOSTED_DATABASE_ADMIN_URL'), appUrl = need('HOSTED_DATABASE_URL'), appPassword = need('HOSTED_APP_DB_PASSWORD');
if (process.env.HOSTED_DATABASE_CA_CERT) process.env.DATABASE_CA_CERT = process.env.HOSTED_DATABASE_CA_CERT;   // before config is read
if (appPassword.length < 16) { console.error('HOSTED_APP_DB_PASSWORD must be at least 16 characters.'); process.exit(2); }

const { clientConfig, createPool, withUser } = await import('../src/db/session.js');
const { config } = await import('../src/config.js');
const { migrate } = await import('../src/db/migrate.js');
const { createOwner } = await import('../src/db/install.js');
const { buildServer } = await import('../src/api/server.js');

const rows: Array<{ name: string; ok: boolean; note: string }> = [];
const record = (name: string, ok: boolean, note = '') => { rows.push({ name, ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  - ' + note : ''}`); };
const step = async (name: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); record(name, true, note ?? ''); } catch (e) { record(name, false, (e as Error).message.split('\n')[0]!.slice(0, 240)); }
};
const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;

const admin = new pg.Client(clientConfig(adminUrl, config.databaseCa));
// A local database (a dry run of this script) has no TLS to check; a hosted one must have it.
const wantTls = clientConfig(adminUrl, config.databaseCa).ssl !== undefined;
let pool: pg.Pool | undefined;

await step('connect as the project owner over verified TLS', async () => {
  await admin.connect();
  const r = (await admin.query(`SELECT current_user AS u, version() AS v, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
    (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS cr,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`)).rows[0];
  if (wantTls && !r.ssl) throw new Error('the connection is not encrypted');
  return `${String(r.v).split(' ').slice(0, 2).join(' ')}, owner is ${r.su ? 'a superuser' : 'NOT a superuser'}${r.cr ? ', may create roles' : ', may NOT create roles'}, ${r.ssl ? 'TLS on' : 'local, no TLS'}`;
});

await step('the database is a throwaway: no customer in it', async () => {
  const t = await admin.query(`SELECT to_regclass('public.firms') AS f`);
  if (t.rows[0].f) {
    const n = (await admin.query(`SELECT count(*)::int AS n FROM firms WHERE kind <> 'platform'`)).rows[0].n;
    if (n > 0) throw new Error(`${n} customer firm(s) already exist; refusing to touch it`);
  }
  return 'empty or only the platform';
});
if (rows.some((r) => !r.ok)) { console.log('\nStopping: the first checks failed.'); process.exit(1); }

await step('btree_gist is available (the program needs it so two bookings can never overlap)', async () => {
  const have = (await admin.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).rowCount;
  if (!have) { const a = (await admin.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist'`)).rowCount; if (!a) throw new Error('not available on this host'); return 'available, installed by the migrations'; }
  return 'installed';
});

await step('all migrations run, as an owner that is not a superuser', async () => {
  const t = performance.now();
  const done = await migrate(adminUrl, appPassword);
  const total = (await admin.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
  return `${done.length} applied now, ${total} recorded, ${ms(t)}`;
});

await step('the app\'s login is not a superuser and cannot bypass row-level security', async () => {
  const r = (await admin.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'nusuh_app'`)).rows[0];
  if (!r) throw new Error('the role nusuh_app does not exist');
  if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb) throw new Error(`too powerful: ${JSON.stringify(r)}`);
  return 'no superuser, no bypass, cannot create roles or databases';
});

await step('the public web API roles (anon, authenticated, service_role) reach nothing of ours', async () => {
  const roles = (await admin.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows.map((x) => x.rolname as string);
  if (!roles.length) return 'those roles do not exist on this host';
  const found: string[] = [];
  for (const r of roles) {
    const t = await admin.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND CASE WHEN c.relkind IN ('r','v','m','p')
      THEN has_table_privilege('${r}', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ELSE false END`);
    const s = await admin.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND CASE WHEN c.relkind = 'S'
      THEN has_sequence_privilege('${r}', c.oid, 'USAGE, SELECT, UPDATE') ELSE false END`);
    const f = await admin.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p')
      AND has_function_privilege('${r}', p.oid, 'EXECUTE')`);
    found.push(...t.rows.map((x) => `${r}:${x.relname}`), ...s.rows.map((x) => `${r}:${x.relname}`), ...f.rows.map((x) => `${r}:${x.f}`));
  }
  if (found.length) throw new Error(`${found.length} objects reachable, e.g. ${found.slice(0, 3).join(', ')}`);
  return `checked ${roles.join(', ')}: nothing reachable`;
});

await step('the app\'s own login connects through the pool with verified TLS', async () => {
  pool = createPool(appUrl, { ca: config.databaseCa, max: 10 });
  const r = (await pool.query(`SELECT current_user AS u, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`)).rows[0];
  if (r.u !== 'nusuh_app') throw new Error(`connected as ${r.u}, not nusuh_app (the user in HOSTED_DATABASE_URL must be nusuh_app.<project>)`);
  if (wantTls && !r.ssl) throw new Error('not encrypted');
  return `connected as nusuh_app, ${r.ssl ? 'TLS on' : 'local, no TLS'}`;
});

await step('row-level security holds for that login: signed in as nobody it sees no firm and no company', async () => {
  const f = (await pool!.query('SELECT count(*)::int AS n FROM firms')).rows[0].n;
  const c = (await pool!.query('SELECT count(*)::int AS n FROM companies')).rows[0].n;
  if (f !== 0 || c !== 0) throw new Error(`sees ${f} firms and ${c} companies with no user`);
  return 'zero rows';
});

let ownerLink = '', ownerId = '';
await step('the first-owner command works against the host (the one-time link is made)', async () => {
  const r = await createOwner(adminUrl, { name: 'Hosted Check Owner', email: `hosted-check-${Date.now()}@example.test`, publicUrl: 'https://check.invalid' });
  ownerLink = r.link; ownerId = r.userId;
  return r.status;
});

const server = buildServer({ pool: pool!, sessionSecret: randomBytes(32).toString('hex') });
await step('sign-in works end to end through the real API: accept the invitation, sign in, be recognised', async () => {
  const token = ownerLink.split('/invite/')[1]!;
  const password = `Check-${randomBytes(9).toString('hex')}`;
  const set = await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password } });
  if (set.statusCode !== 200) throw new Error(`choosing a password: HTTP ${set.statusCode} ${set.body.slice(0, 120)}`);
  const email = (await admin.query('SELECT email FROM users WHERE id = $1', [ownerId])).rows[0].email as string;
  const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`sign-in: HTTP ${login.statusCode} ${login.body.slice(0, 120)}`);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  if (me.statusCode !== 200) throw new Error(`/api/me: HTTP ${me.statusCode}`);
  const wrong = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'wrong-password-1' } });
  if (wrong.statusCode === 200) throw new Error('a wrong password was accepted');
  return 'recognised as the owner; a wrong password is refused';
});

await step('a signed-in request runs inside row-level security (the owner sees the platform, nothing of any customer)', async () => {
  const r = await withUser(pool!, ownerId, (db) => db.query('SELECT count(*)::int AS n FROM firms'));
  return `${r.rows[0].n} firm visible to the owner`;
});

await step('speed: 40 one-after-another and 40 at once, each a signed-in request', async () => {
  const one = async () => { const t = performance.now(); await withUser(pool!, ownerId, (db) => db.query('SELECT count(*) FROM firms')); return performance.now() - t; };
  const seq: number[] = []; for (let i = 0; i < 40; i++) seq.push(await one());
  const t0 = performance.now(); const par = await Promise.all(Array.from({ length: 40 }, one)); const wall = performance.now() - t0;
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
  const mx = (await admin.query('SHOW max_connections')).rows[0].max_connections;
  return `one by one: median ${Math.round(q(seq, 0.5))} ms, slowest ${Math.round(q(seq, 0.95))} ms; 40 at once: ${Math.round(wall)} ms in all (the host allows ${mx} connections)`;
});

await step('a connection the host closes is replaced without an error reaching the caller', async () => {
  const pid = (await pool!.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  await admin.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  let ok = false; for (let i = 0; i < 3 && !ok; i++) { try { await pool!.query('SELECT 1'); ok = true; } catch { /* the pool drops the dead connection; try again */ } }
  if (!ok) throw new Error('the pool did not recover');
  return 'recovered';
});

await server.close(); await pool?.end(); await admin.end();
const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length} passed, ${bad.length} failed.`);
if (bad.length) { console.log('Failed: ' + bad.map((b) => b.name).join(' | ')); process.exit(1); }
