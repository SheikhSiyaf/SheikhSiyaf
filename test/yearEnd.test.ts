// Year-end closing (db/migrations/0030_year_end.sql, src/books/yearEndService.ts):
// the year's income and expenses move to retained earnings, the year is locked, years close in order, reopening reverses it.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, sale, addPeriod, type Fixture } from './helpers.js';
import { postEntry } from '../src/ledger/ledger.js';
import * as Y from '../src/books/yearEndService.js';
import * as R from '../src/books/reportsService.js';

let f: Fixture;
const bal = async (code: string, to = '2099-12-31') => (await owner.query(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2 AND e.entry_date <= $3`, [f.a.id, code, to])).rows[0].v;

beforeAll(async () => {
  f = await seed();
  for (const y of [2024, 2025]) for (let m = 1; m <= 12; m++) {
    const s = `${y}-${String(m).padStart(2, '0')}-01`;
    await addPeriod(f.a.id, s, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), y === 2025 && m <= 6);
  }
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2024-05-10', '1000.00')));
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2025-08-10', '5000.00')));
  // Rent needs no cost centre here; branch costs do, so the closing keeps the cost centre on its line.
  await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2025-09-01', memo: 'Rent', lines: [{ accountId: f.a.rent, debit: '1200.00' }, { accountId: f.a.cash, credit: '1200.00' }] }));
  await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2025-09-02', memo: 'Branch', lines: [{ accountId: f.a.branchCosts, debit: '300.00', costCentreId: f.a.branch1 }, { accountId: f.a.cash, credit: '300.00' }] }));
});

describe('Year-end closing', () => {
  it('lists the years with their result; the oldest ended open year is next', async () => {
    const r = await as(f.partner, (db) => Y.years(db, f.a.id));
    expect(r.years.map((y) => [y.endDate, y.profit, Boolean(y.closed)])).toEqual(expect.arrayContaining([['2024-12-31', '1000.00', false], ['2025-12-31', '3500.00', false]]));
    expect(r.nextToClose).toBe('2024-12-31');
  });

  it('only the partner closes, in order, and only ended years', async () => {
    await expect(as(f.staff, (db) => Y.close(db, f.a.id, '2024-12-31'))).rejects.toThrow(/partner/);
    await expect(as(f.partner, (db) => Y.close(db, f.a.id, '2025-12-31'))).rejects.toThrow(/earlier years/);
    await expect(as(f.partner, (db) => Y.close(db, f.a.id, '2026-12-31'))).rejects.toThrow(/after it has ended|earlier years/);
    await as(f.partner, (db) => Y.close(db, f.a.id, '2024-12-31'));
  });

  it('moves the result to retained earnings per cost centre, locks every month, keeps the P&L as it was', async () => {
    const p = await as(f.partner, (db) => Y.preview(db, f.a.id, '2025-12-31'));
    expect(p.profit).toBe('3500.00');
    expect(p.lines.find((l) => l.code === '5100')).toMatchObject({ costCentreId: f.a.branch1, balance: '300.00' });
    const r = await as(f.partner, (db) => Y.close(db, f.a.id, '2025-12-31'));
    expect(await bal('4000', '2025-12-31')).toBe('0.00');
    expect(await bal('5000', '2025-12-31')).toBe('0.00');
    expect(await bal('3100')).toBe('-4500.00');                    // 1,000 (2024) + 3,500 (2025) retained
    expect((await owner.query(`SELECT count(*)::int AS n FROM periods WHERE company_id = $1 AND start_date BETWEEN '2025-01-01' AND '2025-12-31' AND locked_at IS NULL`, [f.a.id])).rows[0].n).toBe(0);
    const cc = (await owner.query(`SELECT l.cost_centre_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = '5100'`, [r.entryId])).rows[0];
    expect(cc.cost_centre_id).toBe(f.a.branch1);
    // Reports still show the year's result; the balance sheet still balances.
    expect((await as(f.partner, (db) => R.profitAndLoss(db, f.a.id, '2025-01-01', '2025-12-31'))).netProfit).toBe('3500.00');
    expect((await as(f.partner, (db) => db.query(`SELECT profit::text FROM profit_and_loss($1, '2025-01-01', '2025-12-31')`, [f.a.id]))).rows[0].profit).toBe('3500.00');
    const bs = await as(f.partner, (db) => R.balanceSheet(db, f.a.id, '2025-12-31'));
    expect(bs.balances).toBe(true);
  });

  it('a closed year takes no posting and its months cannot be unlocked', async () => {
    await expect(as(f.partner, (db) => postEntry(db, sale(f.a, '2025-12-31', '1.00')))).rejects.toThrow(/closed|locked/);
    await expect(as(f.partner, (db) => db.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND start_date = '2025-12-01'`, [f.a.id]))).rejects.toThrow(/closed year/);
    await expect(as(f.partner, (db) => Y.close(db, f.a.id, '2025-12-31'))).rejects.toThrow(/already closed/);
  });

  it('reopening: the latest year first, with a reason; the closing entry is reversed', async () => {
    const ys = (await as(f.partner, (db) => Y.years(db, f.a.id))).years;
    const y2024 = ys.find((y) => y.endDate === '2024-12-31')!.closed!, y2025 = ys.find((y) => y.endDate === '2025-12-31')!.closed!;
    await expect(as(f.partner, (db) => Y.reopen(db, y2024.id, 'Audit adjustment'))).rejects.toThrow(/later year/);
    await expect(as(f.partner, (db) => Y.reopen(db, y2025.id, ' '))).rejects.toThrow(/why/);
    await expect(as(f.staff, (db) => Y.reopen(db, y2025.id, 'x'))).rejects.toThrow();
    await as(f.partner, (db) => Y.reopen(db, y2025.id, 'Auditor adjustment to stock'));
    expect(await bal('4000', '2025-12-31')).toBe('-5000.00');
    expect(await bal('3100')).toBe('-1000.00');
    // Open again: the partner unlocks a month and posts; the year can be closed again.
    await as(f.partner, (db) => db.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND start_date = '2025-12-01'`, [f.a.id]));
    await as(f.partner, (db) => postEntry(db, sale(f.a, '2025-12-20', '100.00')));
    await as(f.partner, (db) => Y.close(db, f.a.id, '2025-12-31'));
    expect(await bal('3100')).toBe('-4600.00');
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT 1 FROM fiscal_years WHERE company_id = $1', [f.a.id]))).rows).toEqual([]);
  });
});
