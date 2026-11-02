// docs/ACCOUNTING_RULES.md > Cost centres
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, type Fixture } from './helpers.js';
import { postEntry, type EntryInput } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
beforeAll(async () => { f = await seed(); });

describe('Cost centres', () => {
  it('account marked cost-centre-required rejects a line with no cost centre', async () => {
    const entry = (costCentreId?: string): EntryInput => ({ companyId: f.a.id, entryDate: '2026-03-01', lines: [
      { accountId: f.a.branchCosts, debit: '80.00', costCentreId }, { accountId: f.a.cash, credit: '80.00' }] });
    await expect(as(f.staff, (db) => postEntry(db, entry()))).rejects.toThrow(/cost centre is required/);
    await expect(as(f.staff, (db) => postEntry(db, entry(f.a.branch1)))).resolves.toBeTruthy();
  });

  it('one entry can split lines across several cost centres', async () => {
    const id = await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-02', lines: [
      { accountId: f.a.branchCosts, debit: '60.00', costCentreId: f.a.headOffice },
      { accountId: f.a.branchCosts, debit: '40.00', costCentreId: f.a.branch1 },
      { accountId: f.a.cash, credit: '100.00' }] }));
    const { rows } = await as(f.staff, (db) => db.query(
      'SELECT count(DISTINCT cost_centre_id)::int AS n FROM journal_lines WHERE entry_id = $1', [id]));
    expect(rows[0].n).toBe(2);
  });

  it('a cost centre from another company cannot be used', async () => {
    await expect(as(f.partner, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-02', lines: [
      { accountId: f.a.branchCosts, debit: '1.00', costCentreId: f.b.branch1 },
      { accountId: f.a.cash, credit: '1.00' }] }))).rejects.toThrow(/different company/);
  });

  it('P&L by cost centre sums to company P&L', async () => {
    await as(f.staff, async (db) => {
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-04-01', lines: [
        { accountId: f.a.cash, debit: '1000.00' },
        { accountId: f.a.sales, credit: '700.00', costCentreId: f.a.headOffice },
        { accountId: f.a.sales, credit: '250.00', costCentreId: f.a.branch1 },
        { accountId: f.a.sales, credit: '50.00' }] });                          // untagged
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-04-02', lines: [
        { accountId: f.a.rent, debit: '333.33' },                              // untagged
        { accountId: f.a.branchCosts, debit: '66.67', costCentreId: f.a.branch1 },
        { accountId: f.a.cash, credit: '400.00' }] });
    });
    const [from, to] = ['2026-01-01', '2026-12-31'];
    const total = (await as(f.partner, (db) => db.query('SELECT * FROM profit_and_loss($1,$2,$3)', [f.a.id, from, to]))).rows[0];
    const byCc = (await as(f.partner, (db) => db.query('SELECT * FROM profit_and_loss_by_cost_centre($1,$2,$3)', [f.a.id, from, to]))).rows;
    expect(byCc.length).toBeGreaterThanOrEqual(3);
    for (const k of ['income', 'expense', 'profit'] as const) {
      expect(byCc.reduce((s, r) => s + toMinor(r[k]), 0n), k).toBe(toMinor(total[k]));
    }
    expect(toMinor(total.profit)).toBe(toMinor(total.income) - toMinor(total.expense));
  });
});
