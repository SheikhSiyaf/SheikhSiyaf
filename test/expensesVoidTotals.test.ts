// Voiding an expense: what the Expenses totals, Profit and Loss and the trial balance show afterwards.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/expensesService.js';
import { profitAndLoss } from '../src/books/reportsService.js';
import { trialBalance } from '../src/ledger/ledger.js';

let f: Fixture;
beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
});

const record = (date: string, price = '20.00') => as(f.staff, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'expense', payee: 'IT supplier', paidFromAccountId: f.a.cash, issueDate: date,
    lines: [{ description: 'IT expenses', quantity: '1', unitPrice: price, accountId: f.a.rent, vatCode: 'standard' as const }] });
  await S.issueDocument(db, id);
  return id;
});
const spent = (from: string, to: string) => as(f.staff, async (db) => E.expensesByCategory(db, f.a.id, from, to)).then((r) => r.total);
const pnlExpenses = (from: string, to: string) => as(f.staff, (db) => profitAndLoss(db, f.a.id, from, to)).then((r) => r.lines.find((l) => l.accountId === f.a.rent)?.amount ?? '0.00');

describe('voiding an expense', () => {
  it('an expense and its reversal net to zero in the Expenses totals, Profit and Loss and the trial balance', async () => {
    const id = await record('2026-03-05');
    await as(f.staff, (db) => E.voidExpense(db, id, '2026-03-05'));
    expect(await spent('2026-03-01', '2026-03-31')).toBe('0.00');
    expect(await pnlExpenses('2026-03-01', '2026-03-31')).toBe('0.00');
    const tb = await as(f.staff, (db) => trialBalance(db, f.a.id, '2026-12-31'));
    expect(tb.find((r) => r.code === '5000')).toBeUndefined();
  });

  const tbNet = async (code: string) => (await as(f.staff, (db) => trialBalance(db, f.a.id, '2026-12-31'))).filter((r) => r.code === code)
    .reduce((t, r) => t + Math.round((Number(r.debit) - Number(r.credit)) * 100), 0);

  it('an expense of an earlier month, voided with no date given, is reversed on the expense\'s own day: every month nets to zero', async () => {
    const id = await record('2026-02-10', '33.00');
    const used = await as(f.staff, (db) => E.voidExpense(db, id));
    expect(used).toBe('2026-02-10');
    for (const [from, to] of [['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']] as const) {
      expect(await spent(from, to)).toBe(await pnlExpenses(from, to));   // the Expenses total and Profit and Loss always agree
    }
    expect(await spent('2026-02-01', '2026-02-28')).toBe('0.00');
    expect(await spent('2026-03-01', '2026-03-31')).toBe('0.00');
    expect(await tbNet('5000')).toBe(0);
  });

  it('a date typed in by the caller is respected: the reversal then falls in that month, and the totals still agree with Profit and Loss', async () => {
    const id = await record('2026-02-12', '20.00');
    await as(f.staff, (db) => E.voidExpense(db, id, '2026-03-12'));
    expect(await spent('2026-02-01', '2026-02-28')).toBe('20.00');
    expect(await spent('2026-03-01', '2026-03-31')).toBe('-20.00');
    expect(await pnlExpenses('2026-02-01', '2026-02-28')).toBe('20.00');
    expect(await pnlExpenses('2026-03-01', '2026-03-31')).toBe('-20.00');
    expect(await tbNet('5000')).toBe(0);   // over the whole year the pair still cancels
  });

  it('when the expense\'s month is closed the reversal is dated today instead, and the closed month never changes', async () => {
    const id = await record('2026-04-08', '50.00');
    await addPeriod(f.a.id, '2026-04-01', '2026-04-30', true);   // April is closed
    const used = await as(f.staff, (db) => E.voidExpense(db, id));
    expect(used).toBe(new Date().toISOString().slice(0, 10));
    expect(await spent('2026-04-01', '2026-04-30')).toBe('50.00');
  });

  it('an expense cannot be written in another currency, so there is no foreign-currency expense to void (the bill route is for that)', async () => {
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'IT supplier', paidFromAccountId: f.a.cash, issueDate: '2026-03-05', currency: 'USD', fxRate: '3.75',
      lines: [{ description: 'IT expenses', quantity: '1', unitPrice: '20.00', accountId: f.a.rent, vatCode: 'standard' as const }] }))).rejects.toThrow(/own currency/);
  });
});
