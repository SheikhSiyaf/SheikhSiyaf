// Reports worked by hand: balance sheet (balances, sections, this year's profit), cash flow (agrees with the bank),
// P&L in columns, owner summary ratios, and the VAT return worksheet against the books.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import { postEntry } from '../src/ledger/ledger.js';
import * as R from '../src/books/reportsService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
const acct = async (code: string) => (await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0].id as string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE companies SET fy_end_month = 12, fy_end_day = 31 WHERE id = $1`, [f.a.id]);
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['1500', 'Equipment', 'asset'], ['2000', 'Payables', 'liability'], ['3000', 'Capital', 'equity']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  const post = (date: string, lines: { accountId: string; debit?: string; credit?: string }[]) => as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: date, lines }));
  await post('2026-01-01', [{ accountId: f.a.cash, debit: '10000.00' }, { accountId: await acct('3000'), credit: '10000.00' }]);              // capital in
  await post('2026-02-10', [{ accountId: await acct('1100'), debit: '1150.00' }, { accountId: f.a.sales, credit: '1000.00' }, { accountId: f.a.outputVat, credit: '150.00' }]);
  await post('2026-02-20', [{ accountId: f.a.cash, debit: '1150.00' }, { accountId: await acct('1100'), credit: '1150.00' }]);               // customer pays
  await post('2026-02-25', [{ accountId: await acct('1500'), debit: '3000.00' }, { accountId: f.a.cash, credit: '3000.00' }]);              // equipment
  await post('2026-02-26', [{ accountId: f.a.rent, debit: '400.00' }, { accountId: f.a.cash, credit: '400.00' }]);                           // rent
  const customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
  await as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-02-15', lines: [{ description: 'Steel', quantity: '1', unitPrice: '200.00', accountId: f.a.sales, vatCode: 'standard' }] });
    await S.issueDocument(db, id);
  });
});

describe('Balance sheet', () => {
  it('assets = liabilities + equity, with this year\'s profit in equity', async () => {
    const b = await as(f.partner, (db) => R.balanceSheet(db, f.a.id, '2026-02-28'));
    expect(b.balances).toBe(true);
    expect(b.totals).toMatchObject({ nonCurrentAssets: '3000.00', currentAssets: '7980.00', assets: '10980.00', currentLiabilities: '180.00', capital: '10000.00', thisYear: '800.00', earlierYears: '0.00', equity: '10800.00', liabilitiesAndEquity: '10980.00' });
    expect(b.sections.currentAssets.map((l) => [l.code, l.amount])).toEqual([['1000', '7750.00'], ['1100', '230.00']]);
    const jan = await as(f.partner, (db) => R.balanceSheet(db, f.a.id, '2026-01-31'));
    expect(jan.totals).toMatchObject({ assets: '10000.00', equity: '10000.00' });
  });
});

describe('Cash flow', () => {
  it('opening + operating + investing + financing = closing cash', async () => {
    const c = await as(f.partner, (db) => R.cashFlow(db, f.a.id, '2026-02-01', '2026-02-28'));
    expect(c).toMatchObject({ opening: '10000.00', closing: '7750.00', agrees: true, totals: { operating: '750.00', investing: '-3000.00', financing: '0.00', net: '-2250.00' } });
    const jan = await as(f.partner, (db) => R.cashFlow(db, f.a.id, '2026-01-01', '2026-01-31'));
    expect(jan.totals).toMatchObject({ financing: '10000.00' });
  });
});

describe('P&L in columns', () => {
  it('month by month, against the previous period and last year', async () => {
    const m = await as(f.partner, (db) => R.pnlColumns(db, f.a.id, '2026-01-01', '2026-02-28', 'monthly'));
    expect(m.columns.map((c) => [c.from, c.to, c.netProfit])).toEqual([['2026-01-01', '2026-01-31', '0.00'], ['2026-02-01', '2026-02-28', '800.00']]);
    const p = await as(f.partner, (db) => R.pnlColumns(db, f.a.id, '2026-02-01', '2026-02-28', 'previous'));
    expect(p.columns.map((c) => [c.from, c.to])).toEqual([['2026-02-01', '2026-02-28'], ['2026-01-01', '2026-01-31']]);
    expect(R.periodsFor('2026-02-01', '2026-02-28', 'lastYear')[1]).toEqual({ from: '2025-02-01', to: '2025-02-28' });
    expect(R.periodsFor('2026-03-10', '2026-03-19', 'previous')[1]).toEqual({ from: '2026-02-28', to: '2026-03-09' });
  });
});

describe('Owner summary', () => {
  it('this month, last month, year to date, position and ratios', async () => {
    const s = await as(f.partner, (db) => R.ownerSummary(db, f.a.id, '2026-02-28'));
    expect(s.month).toMatchObject({ revenue: '1200.00', grossProfit: '800.00', netProfit: '800.00' });
    expect(s.lastMonth.revenue).toBe('0.00');
    expect(s.position).toMatchObject({ cash: '7750.00', receivables: '230.00', vatDue: '180.00', workingCapital: '7800.00' });
    expect(s.ratios.grossMargin).toBe(66.6);
    expect(s.ratios.currentRatio).toBe(44.33);
    expect(s.topCustomers[0]).toMatchObject({ name: 'Gulf Steel', amount: '200.00' });
  });
});

describe('VAT return worksheet', () => {
  it('sales and purchases by VAT treatment from documents, next to the VAT accounts in the books', async () => {
    const v = await as(f.partner, (db) => R.vatReturn(db, f.a.id, '2026-02-01', '2026-02-28'));
    expect(v.sales.standard).toMatchObject({ net: '200.00', vat: '30.00' });
    expect(v.books).toMatchObject({ outputVat: '180.00', inputVat: '0.00' });
    expect(v.agreesWithBooks).toBe(false);   // the manual VAT entry is not on a document: shown so it can be checked
  });
  it('other companies get nothing', async () => {
    const b = await as(f.b.clientAccountant, (db) => R.balanceSheet(db, f.a.id, '2026-02-28'));
    expect(b.totals.assets).toBe('0.00');
  });
});
