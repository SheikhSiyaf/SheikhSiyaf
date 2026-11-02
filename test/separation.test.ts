// docs/ACCOUNTING_RULES.md > Separation and audit: "User of company A cannot read or write company B rows."
import { describe, it, expect, beforeAll } from 'vitest';
import { as, app, seed, sale, owner, addPeriod, type Fixture } from './helpers.js';
import { postEntry, trialBalance } from '../src/ledger/ledger.js';

let f: Fixture;
let entryB: string;
beforeAll(async () => {
  f = await seed();
  await addPeriod(f.b.id, '2026-01-01', '2026-01-31');
  entryB = await as(f.partner, (db) => postEntry(db, sale(f.b, '2026-03-01', '500.00')));
  await as(f.partner, (db) => postEntry(db, sale(f.a, '2026-03-01', '100.00')));
});

const TABLES = ['companies', 'accounts', 'cost_centres', 'periods', 'journal_entries', 'journal_lines', 'audit_log', 'memberships'];

async function visibleCompanyIds(userId: string, table: string): Promise<Set<string>> {
  const sql = {
    companies: 'SELECT id AS c FROM companies',
    journal_lines: 'SELECT e.company_id AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id',
  }[table] ?? `SELECT company_id AS c FROM ${table}`;
  const { rows } = await as(userId, (db) => db.query(sql));
  return new Set(rows.map((r) => r.c));
}

describe('Data separation between companies', () => {
  it('the app role is not a superuser, does not own tables and cannot bypass RLS', async () => {
    const { rows } = await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nusuh_app'`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tableowner = 'nusuh_app'`);
    expect(owned.rows[0].n).toBe(0);
    const noRls = await owner.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND relname <> 'schema_migrations'`);
    expect(noRls.rows).toEqual([]);
  });

  for (const who of ['clientAccountant', 'clientViewer'] as const) {
    it(`client user (${who}) of company A sees only company A rows in every table`, async () => {
      for (const t of TABLES) {
        const seen = await visibleCompanyIds(f.a[who], t);
        expect([...seen].every((c) => c === f.a.id), t).toBe(true);
        expect(seen.has(f.b.id), t).toBe(false);
      }
    });
  }

  it('firm staff see only companies assigned to them', async () => {
    for (const t of TABLES.filter((t) => t !== 'memberships')) {
      expect((await visibleCompanyIds(f.staff, t)).has(f.b.id), t).toBe(false);
    }
    expect((await visibleCompanyIds(f.partner, 'journal_entries')).has(f.b.id)).toBe(true);
  });

  it('a user with no session identity sees nothing', async () => {
    const c = await app.connect();
    try {
      for (const t of TABLES) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect(rows[0].n, t).toBe(0);
      }
    } finally { c.release(); }
  });

  it('company A user cannot read a company B entry by id, or its trial balance', async () => {
    const { rows } = await as(f.a.clientAccountant, (db) => db.query('SELECT * FROM journal_entries WHERE id = $1', [entryB]));
    expect(rows).toEqual([]);
    expect(await as(f.a.clientAccountant, (db) => trialBalance(db, f.b.id, '2026-12-31'))).toEqual([]);
  });

  it('company A user cannot write company B rows', async () => {
    const u = f.a.clientAccountant;
    await expect(as(u, (db) => postEntry(db, sale(f.b, '2026-03-02', '1.00')))).rejects.toThrow(/row-level security/);
    await expect(as(f.staff, (db) => postEntry(db, sale(f.b, '2026-03-02', '1.00')))).rejects.toThrow(/row-level security/);
    await expect(as(u, (db) => db.query(
      `INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '9999', 'Sneaky', 'asset')`, [f.b.id]))).rejects.toThrow(/row-level security/);
    await expect(as(u, (db) => db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit) VALUES ($1, $2, 1)`, [entryB, f.b.cash]))).rejects.toThrow(/row-level security/);
    const upd = await as(u, (db) => db.query(`UPDATE accounts SET name = 'Hacked' WHERE company_id = $1`, [f.b.id]));
    expect(upd.rowCount).toBe(0);
    const upd2 = await as(u, (db) => db.query(`UPDATE companies SET name = 'Hacked' WHERE id = $1`, [f.b.id]));
    expect(upd2.rowCount).toBe(0);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM accounts WHERE company_id = $1 AND name = 'Hacked'`, [f.b.id]);
    expect(rows[0].n).toBe(0);
  });

  it('an entry cannot use an account of another company, even by a user of both', async () => {
    await expect(as(f.partner, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-02', lines: [
      { accountId: f.b.cash, debit: '1.00' }, { accountId: f.a.sales, credit: '1.00' }] }))).rejects.toThrow(/different company/);
  });

  it('the Administrator sees the client list but never the books', async () => {
    const companies = await visibleCompanyIds(f.admin, 'companies');
    expect(companies).toEqual(new Set([f.a.id, f.b.id]));
    for (const t of ['accounts', 'cost_centres', 'periods', 'journal_entries', 'journal_lines', 'audit_log']) {
      expect((await visibleCompanyIds(f.admin, t)).size, t).toBe(0);
    }
    await expect(as(f.admin, (db) => postEntry(db, sale(f.a, '2026-03-02', '1.00')))).rejects.toThrow(/row-level security/);
  });

  it('users of another firm see nothing of this firm', async () => {
    const other = await seed();
    for (const t of TABLES) {
      const seen = await visibleCompanyIds(other.partner, t);
      expect(seen.has(f.a.id) || seen.has(f.b.id), t).toBe(false);
    }
    expect((await visibleCompanyIds(other.admin, 'companies')).has(f.a.id)).toBe(false);
  });
});
