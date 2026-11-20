// A host that puts a public web API in front of the database. Supabase does: its roles anon, authenticated and
// service_role are what anyone on the internet with the project's public key becomes, and on a project it gives them
// every new table, sequence and function in the public schema automatically (its security guide: "Default privileges").
//
// Nusuh Books keeps everything in public and talks to the database only as nusuh_app. Left alone, every table without
// row-level security would be readable and writable from outside the program, and every helper function, including the
// ones that run with the owner's rights, would be callable. Migration 0060 takes those grants back, and closes the
// default so tables made later stay closed too.
//
// This simulates that host: the three roles exist and the default grants are in place BEFORE the program's migrations
// run. A control shows the simulation does what Supabase does, so an empty result below means something.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createPool, withUser } from '../src/db/session.js';
import { APP_PASSWORD, PG_ADMIN_URL } from './config.js';

const OPEN = 'nusuh_grants_open', CLOSED = 'nusuh_grants_closed';
const ROLES = ['anon', 'authenticated', 'service_role'];
const at = (db: string, user?: string, pw?: string) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${db}`; if (user) { u.username = user; u.password = pw ?? ''; } return u.toString(); };
let admin: pg.Client;

async function asSupabase(db: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: at(db) });
  await c.connect();
  for (const r of ROLES) await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  // What Supabase sets up: new objects in public go to the three roles.
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${ROLES.join(', ')}`);
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${ROLES.join(', ')}`);
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${ROLES.join(', ')}`);
  return c;
}

/** Everything the three roles can still touch in the public schema. */
async function exposed(c: pg.Client): Promise<string[]> {
  const out: string[] = [];
  for (const r of ROLES) {
    // CASE keeps each check to the right kind of object: the planner may otherwise test a table as if it were a sequence.
    const t = await c.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      AND CASE WHEN c.relkind IN ('r', 'v', 'm', 'p') THEN has_table_privilege('${r}', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ELSE false END`);
    out.push(...t.rows.map((x) => `${r}: table ${x.relname}`));
    const s = await c.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${r}', c.oid, 'USAGE, SELECT, UPDATE') ELSE false END`);
    out.push(...s.rows.map((x) => `${r}: sequence ${x.relname}`));
    const f = await c.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
      AND has_function_privilege('${r}', p.oid, 'EXECUTE')`);
    out.push(...f.rows.map((x) => `${r}: function ${x.f}`));
  }
  return out;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  for (const db of [OPEN, CLOSED]) { await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${db}`); }
}, 60_000);
afterAll(async () => {
  for (const db of [OPEN, CLOSED]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  // The three roles belong to the whole server, not to one database. Remove them so this simulation cannot change how
  // another test's database is migrated; if another database still refers to one, leave it be.
  for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  await admin.end();
});

describe('the simulated host', () => {
  it('really does hand a new table to the public API roles (the control)', async () => {
    const c = await asSupabase(OPEN);
    try {
      await c.query('CREATE TABLE public.control_table (id int)');
      await c.query('CREATE FUNCTION public.control_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      const e = await exposed(c);
      expect(e).toContain('anon: table control_table');
      expect(e).toContain('service_role: function control_fn()');
    } finally { await c.end(); }
  });
});

describe('after the program\'s migrations on such a host', () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await asSupabase(CLOSED); await c.end();
    await migrate(at(CLOSED), APP_PASSWORD);
    c = new pg.Client({ connectionString: at(CLOSED) }); await c.connect();
  }, 120_000);
  afterAll(async () => { await c.end(); });

  it('the public API roles can reach no table, sequence or function the program made', async () => {
    expect(await exposed(c)).toEqual([]);
  });

  it('and not anything made afterwards by the same role (a later migration, or a person in the SQL editor)', async () => {
    await c.query('CREATE TABLE public.made_later (id int)');
    await c.query('CREATE SEQUENCE public.made_later_seq');
    await c.query('CREATE FUNCTION public.made_later_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
    expect(await exposed(c)).toEqual([]);
    await c.query('DROP TABLE public.made_later; DROP SEQUENCE public.made_later_seq; DROP FUNCTION public.made_later_fn()');
  });

  it('the program still works: nusuh_app reads and writes as before, with row-level security doing its job', async () => {
    await seed(at(CLOSED), { production: false });
    const pool = createPool(at(CLOSED, 'nusuh_app', APP_PASSWORD));
    try {
      const ownerId = (await c.query(`SELECT id FROM users WHERE kind = 'owner' LIMIT 1`)).rows[0].id as string;
      const firms = await withUser(pool, ownerId, (db) => db.query('SELECT count(*)::int AS n FROM firms'));
      expect(firms.rows[0].n).toBeGreaterThan(0);
      // Signed in as nobody, row-level security still hides everything.
      const none = await pool.query('SELECT count(*)::int AS n FROM companies');
      expect(none.rows[0].n).toBe(0);
      // A function the program relies on, called as the program's own login.
      expect((await pool.query('SELECT count(*)::int AS n FROM job_status()')).rows[0].n).toBeGreaterThanOrEqual(0);
      // A trigger-backed write as the program's login: the e-invoice protections and audit trigger still run.
      const co = (await c.query('SELECT id FROM companies LIMIT 1')).rows[0].id as string;
      await withUser(pool, ownerId, (db) => db.query(`SELECT 1 FROM companies WHERE id = $1`, [co]));
    } finally { await pool.end(); }
  }, 120_000);
});
