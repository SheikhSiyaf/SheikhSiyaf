// docs/ACCOUNTING_RULES.md > Ledger
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, sale, owner, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, trialBalance, checkEntry } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
beforeAll(async () => { f = await seed(); });

describe('Ledger', () => {
  it('balanced 2-line entry posts successfully', async () => {
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-01', '100.00')));
    const { rows } = await owner.query('SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC', [id]);
    expect(rows).toEqual([{ debit: '100.00', credit: '0.00' }, { debit: '0.00', credit: '100.00' }]);
  });

  it('entry with debit total different from credit total is rejected', async () => {
    const input = { companyId: f.a.id, entryDate: '2026-03-01', lines: [
      { accountId: f.a.cash, debit: '100.00' }, { accountId: f.a.sales, credit: '99.99' }] };
    expect(checkEntry(input)).toContain('Entry does not balance (debit 100.00, credit 99.99).');
    await expect(as(f.staff, (db) => postEntry(db, input))).rejects.toThrow(/does not balance/);
  });

  it('entry with fewer than 2 lines is rejected (one line, and no lines)', async () => {
    const one = { companyId: f.a.id, entryDate: '2026-03-01', lines: [{ accountId: f.a.cash, debit: '10.00' }] };
    expect(checkEntry(one)).toContain('An entry needs at least two lines.');
    await expect(as(f.staff, (db) => postEntry(db, one))).rejects.toThrow(/at least two lines/);
    await expect(as(f.staff, (db) => postEntry(db, { ...one, lines: [] }))).rejects.toThrow(/at least two lines/);
  });

  it('line with both debit and credit, or a negative amount, is rejected', async () => {
    const both = { companyId: f.a.id, entryDate: '2026-03-01', lines: [
      { accountId: f.a.cash, debit: '10.00', credit: '10.00' }, { accountId: f.a.sales, credit: '0.00', debit: '0.00' }] };
    expect(checkEntry(both).length).toBeGreaterThan(0);
    await expect(as(f.staff, (db) => postEntry(db, both))).rejects.toThrow(/check constraint/);

    const negative = { companyId: f.a.id, entryDate: '2026-03-01', lines: [
      { accountId: f.a.cash, debit: '-10.00' }, { accountId: f.a.sales, debit: '10.00' }] };
    expect(checkEntry(negative)).toContain('Line 1: amounts cannot be negative.');
    await expect(as(f.staff, (db) => postEntry(db, negative))).rejects.toThrow(/check constraint/);
  });

  it('zero-amount line is rejected', async () => {
    const zero = { companyId: f.a.id, entryDate: '2026-03-01', lines: [
      { accountId: f.a.cash, debit: '5.00' }, { accountId: f.a.sales, credit: '5.00' }, { accountId: f.a.rent, debit: '0' }] };
    await expect(as(f.staff, (db) => postEntry(db, zero))).rejects.toThrow(/check constraint/);
  });

  it('UPDATE or DELETE on a posted entry or line is rejected', async () => {
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-02', '50.00')));
    const msg = /cannot be changed or deleted/;
    // Even the owner role (which bypasses RLS and grants) is stopped by the triggers.
    await expect(owner.query(`UPDATE journal_entries SET memo = 'x' WHERE id = $1`, [id])).rejects.toThrow(msg);
    await expect(owner.query(`DELETE FROM journal_entries WHERE id = $1`, [id])).rejects.toThrow(msg);
    await expect(owner.query(`UPDATE journal_lines SET debit = 1 WHERE entry_id = $1 AND debit > 0`, [id])).rejects.toThrow(msg);
    await expect(owner.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [id])).rejects.toThrow(msg);
    // The app role has no UPDATE/DELETE permission at all.
    await expect(as(f.staff, (db) => db.query(`UPDATE journal_entries SET memo = 'x' WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(as(f.staff, (db) => db.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    // Adding balanced lines to an entry posted earlier is also an edit, and is rejected.
    await expect(as(f.staff, (db) => db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit) VALUES ($1, $2, 1), ($1, $3, 0.01)`, [id, f.a.cash, f.a.rent],
    ))).rejects.toThrow(msg);
  });

  it('reversal creates a new entry with debits and credits swapped; reversing twice is rejected', async () => {
    const id = await as(f.staff, (db) => postEntry(db, {
      companyId: f.a.id, entryDate: '2026-03-03', memo: 'Rent', lines: [
        { accountId: f.a.rent, debit: '700.00' },
        { accountId: f.a.branchCosts, debit: '300.00', costCentreId: f.a.branch1 },
        { accountId: f.a.cash, credit: '1000.00' }] }));
    const rev = await as(f.staff, (db) => reverseEntry(db, id, '2026-03-04'));
    expect(rev).not.toBe(id);

    const lines = async (e: string) => (await owner.query(
      `SELECT account_id, cost_centre_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY account_id, debit, credit`, [e])).rows;
    const swapped = (await lines(id)).map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    const sortKey = (l: { account_id: string; debit: string; credit: string }) => `${l.account_id}${l.debit}${l.credit}`;
    expect((await lines(rev)).sort((x, y) => sortKey(x).localeCompare(sortKey(y))))
      .toEqual(swapped.sort((x, y) => sortKey(x).localeCompare(sortKey(y))));
    const { rows } = await owner.query('SELECT reverses_entry_id, entry_date::text FROM journal_entries WHERE id = $1', [rev]);
    expect(rows[0]).toEqual({ reverses_entry_id: id, entry_date: '2026-03-04' });

    await expect(as(f.staff, (db) => reverseEntry(db, id, '2026-03-05'))).rejects.toThrow(/already been reversed/);
    await expect(as(f.staff, (db) => reverseEntry(db, rev, '2026-03-05'))).rejects.toThrow(/itself a reversal/);
  });

  it('trial balance at any date: total debits equal total credits', async () => {
    await as(f.staff, async (db) => {
      await postEntry(db, sale(f.a, '2026-04-01', '1234.56'));
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-04-15', lines: [
        { accountId: f.a.rent, debit: '400.10' }, { accountId: f.a.cash, credit: '400.10' }] });
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-05-20', lines: [
        { accountId: f.a.cash, debit: '115.00' }, { accountId: f.a.sales, credit: '100.00' }, { accountId: f.a.outputVat, credit: '15.00' }] });
    });
    for (const date of ['2025-12-31', '2026-03-01', '2026-03-03', '2026-04-10', '2026-04-30', '2026-12-31']) {
      const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, date));
      const d = tb.reduce((s, r) => s + toMinor(r.debit), 0n);
      const c = tb.reduce((s, r) => s + toMinor(r.credit), 0n);
      expect(d, `as of ${date}`).toBe(c);
    }
    const year = await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-12-31'));
    expect(year.length).toBeGreaterThan(2);
  });
});
