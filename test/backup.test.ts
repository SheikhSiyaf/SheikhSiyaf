// The backup and restore scripts, run for real against a seeded demo database.
//
// A backup nobody has restored is a hope, not a backup. This takes a real backup of the demo books, restores it into
// a new empty database, and compares the two table by table, then checks the things that matter most to a client:
// every ledger line, the debit and credit totals, the row-level security that keeps companies apart, and that the
// application's own login can read the restored data and sees only what it should.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { APP_PASSWORD, PG_ADMIN_URL } from './config.js';

const SOURCE = 'nusuh_backup_src';
const COPY = 'nusuh_backup_copy';
const PASS = 'correct horse battery staple 42';
const at = (db: string, user?: string, pw?: string) => {
  const u = new URL(PG_ADMIN_URL); u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pw ?? ''; }
  return u.toString();
};
const run = (cmd: string, args: string[], env: Record<string, string>) =>
  // The standard Supabase logins are server-wide and another test file creates and removes them, so these tests only touch their own.
  spawnSync(cmd, args, { env: { ...process.env, RESTORE_PLATFORM_ROLES: 'nusuh_test_platform_role', ...env }, encoding: 'utf8' });

let admin: pg.Client;
let dir: string;
let file: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nusuh-backup-'));
  admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  for (const db of [SOURCE, COPY]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SOURCE}`);
  await migrate(at(SOURCE), APP_PASSWORD);
  await seed(at(SOURCE), { production: false });
  const r = run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: at(SOURCE), BACKUP_PASSPHRASE: PASS, BACKUP_DIR: dir });
  expect(r.status, r.stderr).toBe(0);
  file = join(dir, readdirSync(dir).find((f) => f.endsWith('.dump.gpg'))!);
}, 120_000);

afterAll(async () => {
  for (const db of [SOURCE, COPY]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

async function counts(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    // our two sections: public, and subpay (the bank-transfer payments: orders, what customers said they paid, the slips). Losing the second in a restore would lose money records.
    const t = await c.query<{ s: string; t: string }>(`SELECT schemaname s, tablename t FROM pg_tables WHERE schemaname IN ('public', 'subpay') ORDER BY 1, 2`);
    const out: Record<string, number> = {};
    for (const { s, t: name } of t.rows) out[s === 'public' ? name : `${s}.${name}`] = Number((await c.query(`SELECT count(*) FROM "${s}"."${name}"`)).rows[0].count);
    return out;
  } finally { await c.end(); }
}

describe('backup.sh', () => {
  it('writes one encrypted file: the readable content is nowhere in it', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.dump.gpg'))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toHaveLength(0);
    expect(statSync(file).size).toBeGreaterThan(10_000);
    const bytes = readFileSync(file);
    // A custom-format dump starts with "PGDMP"; a plain one would also hold table names. Neither may show through.
    expect(bytes.subarray(0, 5).toString('latin1')).not.toBe('PGDMP');
    expect(bytes.includes(Buffer.from('journal_lines'))).toBe(false);
    expect(bytes.includes(Buffer.from('CREATE TABLE'))).toBe(false);
  });

  it('ignores a space or line break pasted at the end of the database address or the passphrase', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'backup-ws-'));
    try {
      const r = run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: `${at(SOURCE)}\n`, BACKUP_PASSPHRASE: `${PASS}\n`, BACKUP_DIR: d2 });
      expect(r.status, r.stderr).toBe(0);
      const made = readdirSync(d2).filter((f) => f.endsWith('.dump.gpg'));
      expect(made).toHaveLength(1);
      // and the restore side opens it with the same pasted passphrase (a line break at the end)
      const target = `nusuh_backup_ws`;
      await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${target}`);
      try {
        const rr = run('bash', ['scripts/restore.sh', join(d2, made[0]!), at(target)], { BACKUP_PASSPHRASE: `${PASS}\n` });
        expect(rr.status, rr.stderr).toBe(0);
      } finally { await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`); }
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });

  it('refuses to run without a database, without a passphrase, or with a short one, and keeps no file', () => {
    const before = readdirSync(dir).length;
    expect(run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: '', BACKUP_PASSPHRASE: PASS, BACKUP_DIR: dir }).status).not.toBe(0);
    expect(run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: at(SOURCE), BACKUP_PASSPHRASE: '', BACKUP_DIR: dir }).status).not.toBe(0);
    expect(run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: at(SOURCE), BACKUP_PASSPHRASE: 'short', BACKUP_DIR: dir }).status).toBe(2);
    expect(readdirSync(dir)).toHaveLength(before);
  });

  it('keeps no file when the database cannot be reached', () => {
    const r = run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: at('nusuh_no_such_database'), BACKUP_PASSPHRASE: PASS, BACKUP_DIR: dir });
    expect(r.status).not.toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith('.dump.gpg'))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toHaveLength(0);
  });
});

describe('a backup of a Supabase-style database', () => {
  // Supabase adds its own schemas (vault, auth, graphql ...) and gives its standard logins rights on our tables. A copy
  // of the whole database cannot be restored anywhere else; only our own section (public) is backed up, and the
  // standard logins are created empty on restore so the rights in the copy have somewhere to land.
  it('keeps only our data, and restores into a server that has none of those logins or schemas', async () => {
    const src = 'nusuh_backup_sb', dst = 'nusuh_backup_sb_copy', d3 = mkdtempSync(join(tmpdir(), 'backup-sb-'));
    for (const db of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${src}`);
    await migrate(at(src), APP_PASSWORD);
    const c = new pg.Client({ connectionString: at(src) });
    await c.connect();
    try {
      await c.query(`CREATE SCHEMA vault`);
      await c.query(`CREATE TABLE vault.secrets (id int)`);   // stands for a platform-owned schema that must not be in the copy
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nusuh_test_platform_role') THEN CREATE ROLE nusuh_test_platform_role NOLOGIN; END IF; END $$`);
      await c.query(`GRANT SELECT ON schema_migrations TO nusuh_test_platform_role`);
    } finally { await c.end(); }
    try {
      const b = run('bash', ['scripts/backup.sh'], { BACKUP_DATABASE_URL: at(src), BACKUP_PASSPHRASE: PASS, BACKUP_DIR: d3 });
      expect(b.status, b.stderr).toBe(0);
      const made = join(d3, readdirSync(d3).find((f) => f.endsWith('.dump.gpg'))!);
      // the login the copy gives rights to is gone where it is restored
      const c2 = new pg.Client({ connectionString: at(src) });
      await c2.connect();
      try { await c2.query(`REVOKE ALL ON schema_migrations FROM nusuh_test_platform_role`); } finally { await c2.end(); }
      await admin.query(`DROP ROLE IF EXISTS nusuh_test_platform_role`);
      await admin.query(`CREATE DATABASE ${dst}`);
      const r = run('bash', ['scripts/restore.sh', made, at(dst)], { BACKUP_PASSPHRASE: PASS });
      expect(r.status, r.stderr).toBe(0);
      const t = new pg.Client({ connectionString: at(dst) });
      await t.connect();
      try {
        expect((await t.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = 'vault'`)).rows[0].n).toBe(0);
        expect((await t.query(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n).toBeGreaterThan(0);
      } finally { await t.end(); }
    } finally {
      for (const db of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      rmSync(d3, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('restore.sh', () => {
  it('a wrong passphrase restores nothing', async () => {
    await admin.query(`CREATE DATABASE ${COPY}`);
    const r = run('bash', ['scripts/restore.sh', file, at(COPY)], { BACKUP_PASSPHRASE: 'wrong passphrase 0123456789' });
    expect(r.status).not.toBe(0);
    expect(Object.keys(await counts(at(COPY)))).toHaveLength(0);
  });

  it('restores every table with the same number of rows, and the ledger adds up to the same totals', async () => {
    const r = run('bash', ['scripts/restore.sh', file, at(COPY)], { BACKUP_PASSPHRASE: PASS });
    expect(r.status, r.stderr).toBe(0);
    const [a, b] = [await counts(at(SOURCE)), await counts(at(COPY))];
    expect(Object.keys(a).length).toBeGreaterThan(80);
    expect(b).toEqual(a);
    expect(a['journal_lines']).toBeGreaterThan(50);

    const total = async (url: string) => {
      const c = new pg.Client({ connectionString: url }); await c.connect();
      try { return (await c.query(`SELECT coalesce(sum(debit),0)::text d, coalesce(sum(credit),0)::text c, count(*)::int n FROM journal_lines`)).rows[0]; }
      finally { await c.end(); }
    };
    const [ta, tb] = [await total(at(SOURCE)), await total(at(COPY))];
    expect(tb).toEqual(ta);
    expect(ta.d).toBe(ta.c);   // debits equal credits, in the copy as in the original
  }, 120_000);

  it('keeps the migration history, so db:migrate on the copy has nothing left to do', async () => {
    expect(await migrate(at(COPY), APP_PASSWORD)).toEqual([]);
  });

  it('keeps row-level security: the application login reads the copy, and each company sees only its own rows', async () => {
    const c = new pg.Client({ connectionString: at(COPY, 'nusuh_app', APP_PASSWORD) });
    await c.connect();
    try {
      const pol = await c.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname='public'`);
      const src = new pg.Client({ connectionString: at(SOURCE) }); await src.connect();
      const want = (await src.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname='public'`)).rows[0].n;
      await src.end();
      expect(pol.rows[0].n).toBe(want);
      expect(want).toBeGreaterThan(50);
      // With no user set, row-level security must hide every company's rows, exactly as in the original.
      expect((await c.query(`SELECT count(*)::int n FROM journal_lines`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('refuses a database that already holds tables, so live books cannot be overwritten', () => {
    const r = run('bash', ['scripts/restore.sh', file, at(COPY)], { BACKUP_PASSPHRASE: PASS });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/already has/);
  });
});
