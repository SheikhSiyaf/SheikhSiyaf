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
    // the Expenses screens count live spending only: neither month shows the voided expense or its reversal (no negative month)...
    expect(await spent('2026-02-01', '2026-02-28')).toBe('0.00');
    expect(await spent('2026-03-01', '2026-03-31')).toBe('0.00');
    // ...while Profit and Loss reads the ledger as it is (the expense stays in February, the reversal sits in March), and the Expenses report says so
    expect(await pnlExpenses('2026-02-01', '2026-02-28')).toBe('20.00');
    expect(await pnlExpenses('2026-03-01', '2026-03-31')).toBe('-20.00');
    expect((await as(f.staff, (db) => E.expensesByCategory(db, f.a.id, '2026-03-01', '2026-03-31'))).voided).toBe('-20.00');
    expect((await as(f.staff, (db) => E.expensesByCategory(db, f.a.id, '2026-02-01', '2026-02-28'))).voided).toBe('20.00');
    expect(await tbNet('5000')).toBe(0);   // over the whole year the pair still cancels
  });

  it('when the expense\'s month is closed the reversal is dated today instead, and the closed month never changes', async () => {
    const id = await record('2026-04-08', '50.00');
    await addPeriod(f.a.id, '2026-04-01', '2026-04-30', true);   // April is closed
    const used = await as(f.staff, (db) => E.voidExpense(db, id));
    expect(used).toBe(new Date().toISOString().slice(0, 10));
    expect(await spent('2026-04-01', '2026-04-30')).toBe('0.00');   // live spending only: the voided expense is not counted, whichever month it sits in
    expect(await pnlExpenses('2026-04-01', '2026-04-30')).toBe('50.00');   // but the closed month in the ledger never changed
  });

  const usd = (over: Record<string, unknown> = {}) => ({ type: 'expense' as const, payee: 'US software vendor', paidFromAccountId: f.a.cash, issueDate: '2026-05-05', currency: 'USD', fxRate: '3.75',
    lines: [{ description: 'IT expenses', quantity: '1', unitPrice: '20.00', accountId: f.a.rent, vatCode: 'standard' as const }], ...over });
  const entryOf = async (docId: string) => (await owner.query(`SELECT a.code, l.debit::text AS debit, l.credit::text AS credit FROM documents d JOIN journal_lines l ON l.entry_id = d.journal_entry_id JOIN accounts a ON a.id = l.account_id WHERE d.id = $1 ORDER BY a.code`, [docId])).rows;

  it('an expense can be written in another currency: it shows as typed, and books the converted amounts at the entered rate', async () => {
    const id = await as(f.staff, async (db) => { const d = await S.saveDraft(db, f.a.id, usd()); await S.issueDocument(db, d); return d; });
    const d = (await owner.query(`SELECT currency, fx_rate::text AS rate, fx_net_total::text AS fxnet, fx_vat_total::text AS fxvat, fx_gross_total::text AS fxgross, net_total::text AS net, vat_total::text AS vat, gross_total::text AS gross, status FROM documents WHERE id = $1`, [id])).rows[0];
    expect(d).toMatchObject({ currency: 'USD', rate: '3.75000000', fxnet: '20.00', fxvat: '3.00', fxgross: '23.00', net: '75.00', vat: '11.25', gross: '86.25', status: 'issued' });   // USD 20 + 3 VAT = USD 23; SAR 75 + 11.25 = 86.25
    expect((await entryOf(id)).map((r) => [r.code, r.debit, r.credit])).toEqual([['1000', '0.00', '86.25'], ['1200', '11.25', '0.00'], ['5000', '75.00', '0.00']]);
    expect(await spent('2026-05-01', '2026-05-31')).toBe('75.00');
    expect(await pnlExpenses('2026-05-01', '2026-05-31')).toBe('75.00');
  });

  it('voiding an expense written in another currency reverses the same converted amounts: the month nets to zero everywhere', async () => {
    const before = await spent('2026-06-01', '2026-06-30');
    const id = await as(f.staff, async (db) => { const d = await S.saveDraft(db, f.a.id, usd({ issueDate: '2026-06-10', fxRate: '3.7512' })); await S.issueDocument(db, d); return d; });
    expect(await spent('2026-06-01', '2026-06-30')).toBe('75.02');   // 20 x 3.7512 = 75.024 -> 75.02
    await as(f.staff, (db) => E.voidExpense(db, id));
    const rev = (await owner.query(`SELECT a.code, l.debit::text AS debit, l.credit::text AS credit FROM documents d JOIN journal_lines l ON l.entry_id = d.void_entry_id JOIN accounts a ON a.id = l.account_id WHERE d.id = $1 ORDER BY a.code`, [id])).rows;
    const orig = await entryOf(id);
    expect(rev.map((r) => [r.code, r.debit, r.credit])).toEqual(orig.map((r) => [r.code, r.credit, r.debit]));   // the same figures, sides swapped
    expect(await spent('2026-06-01', '2026-06-30')).toBe(before);
    expect(await pnlExpenses('2026-06-01', '2026-06-30')).toBe(before);
  });

  it('an expense in another currency needs a rate, a real currency code and a positive rate; claims still stay in the company currency', async () => {
    for (const [patch, why] of [[{ fxRate: '' }, 'no rate'], [{ fxRate: '0' }, 'zero rate'], [{ fxRate: '-3' }, 'negative rate'], [{ currency: 'US' }, 'short code'], [{ currency: '$$$' }, 'not letters']] as const) {
      await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, usd(patch as never))), why).rejects.toThrow();
    }
    const staffMember = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Staff member' }));
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'claim', contactId: staffMember, issueDate: '2026-05-05', currency: 'USD', fxRate: '3.75',
      lines: [{ description: 'Taxi', quantity: '1', unitPrice: '20.00', accountId: f.a.rent, vatCode: 'standard' as const }] } as never))).rejects.toThrow(/own currency/);
    const own = await as(f.staff, async (db) => { const d = await S.saveDraft(db, f.a.id, usd({ currency: null, fxRate: null })); await S.issueDocument(db, d); return d; });
    expect((await owner.query('SELECT currency, fx_rate FROM documents WHERE id = $1', [own])).rows[0]).toEqual({ currency: null, fx_rate: null });   // company-currency expenses are as before
  });
});
