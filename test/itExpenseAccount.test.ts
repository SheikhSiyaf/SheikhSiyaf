// IT costs: the standard chart now has an expense account for them, so a bill put on it reaches Expenses by category and Profit and Loss. The old
// "Computers and IT equipment" account is an asset, so a cost put on it goes to the balance sheet instead (and that is still true).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/expensesService.js';
import { profitAndLoss } from '../src/books/reportsService.js';
import { CHART_TEMPLATE as CHART } from '../src/books/chartTemplate.js';

const MIGRATION = readFileSync(new URL('../db/migrations/0094_it_expense_account.sql', import.meta.url), 'utf8');
let f: Fixture, supplier: string;
beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['1530', 'Computers and IT equipment', 'asset']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'IT Supplier Co' }));
});
const acct = async (code: string) => (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = $2`, [f.a.id, code])).rows[0].id as string;
const bill = (accountId: string, date: string) => as(f.staff, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: date, dueDate: date, lines: [{ description: 'Laptop and licences', quantity: '1', unitPrice: '100.00', accountId, vatCode: 'standard' as const }] });
  await S.issueDocument(db, id);
});
const category = (from: string, to: string) => as(f.staff, (db) => E.expensesByCategory(db, f.a.id, from, to));
const pnl = (from: string, to: string) => as(f.staff, (db) => profitAndLoss(db, f.a.id, from, to));

describe('IT and software expenses', () => {
  it('the standard chart for new companies has an expense account for IT, besides the equipment asset', () => {
    const it = CHART.find((a) => a.name === 'IT and software expenses');
    expect(it).toMatchObject({ type: 'expense', code: '5410' });
    expect(CHART.find((a) => a.code === '1530')).toMatchObject({ type: 'asset' });
    expect(new Set(CHART.map((a) => a.code)).size).toBe(CHART.length);   // no code used twice
  });

  it('the migration gives an existing company the account once, on the first free code, and changes nothing else', async () => {
    const before = Number((await owner.query('SELECT count(*) AS n FROM accounts WHERE company_id = $1', [f.a.id])).rows[0].n);
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '5410', 'Something else', 'expense')`, [f.a.id]);   // the usual code is taken
    await owner.query(MIGRATION);
    const got = (await owner.query(`SELECT code, type, pnl_group FROM accounts WHERE company_id = $1 AND name = 'IT and software expenses'`, [f.a.id])).rows;
    expect(got).toEqual([{ code: '5411', type: 'expense', pnl_group: 'indirect_expense' }]);
    await owner.query(MIGRATION);                                                                           // again: nothing new
    expect(Number((await owner.query('SELECT count(*) AS n FROM accounts WHERE company_id = $1', [f.a.id])).rows[0].n)).toBe(before + 2);
  });

  it('a bill put on the IT expense account shows in Expenses by category and in Profit and Loss; one on the equipment asset does not', async () => {
    const it = await acct('5411'), equipment = await acct('1530');
    await bill(it, '2026-09-10');
    const c = await category('2026-09-01', '2026-09-30');
    expect(c.total).toBe('100.00');
    expect(c.rows.map((r) => [r.name, r.spent])).toEqual([['IT and software expenses', '100.00']]);
    const p = await pnl('2026-09-01', '2026-09-30');
    expect(p.indirectExpenses).toBe('100.00');
    expect(p.lines.map((l) => [l.name, l.amount])).toEqual([['IT and software expenses', '100.00']]);
    await bill(equipment, '2026-10-10');                                                                    // equipment: the balance sheet, not expenses
    expect((await category('2026-10-01', '2026-10-31')).total).toBe('0.00');
    expect((await pnl('2026-10-01', '2026-10-31')).indirectExpenses).toBe('0.00');
  });
});
