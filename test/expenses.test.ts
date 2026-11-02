// Expenses, recurring expenses and expense reports.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/expensesService.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
let bank: string, supplier: string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  bank = f.a.cash;
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Office Supplies Co' }));
});

const line = (over: Record<string, unknown> = {}) =>
  ({ description: 'Printer paper', quantity: '2', unitPrice: '50.00', accountId: f.a.rent, vatCode: 'standard' as const, ...over });
const entryLines = async (entryId: string) => (await owner.query(
  `SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code`, [entryId])).rows;

async function recorded(over: Partial<S.DocumentInput> = {}) {
  return as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type: 'expense', payee: 'Corner shop', paidFromAccountId: bank, issueDate: '2026-03-10', lines: [line()], ...over });
    await S.issueDocument(db, id);
    return id;
  });
}

describe('Expenses', () => {
  it('recording posts Dr expense / Dr input VAT / Cr the bank it was paid from, numbered EXP-', async () => {
    const id = await recorded();
    const d = await as(f.staff, (db) => S.getDocument(db, id));
    expect(d).toMatchObject({ type: 'expense', status: 'issued', number: 'EXP-0001', contactName: 'Corner shop', netTotal: '100.00', vatTotal: '15.00', grossTotal: '115.00', amountDue: '0.00' });
    expect((await entryLines(d.journalEntryId)).map((r) => [r.code, r.debit, r.credit])).toEqual([['1000', '0.00', '115.00'], ['1200', '15.00', '0.00'], ['5000', '100.00', '0.00']]);
  });

  it('can name a supplier instead of a payee, but needs one of the two', async () => {
    const withSupplier = await recorded({ payee: null, contactId: supplier });
    expect((await as(f.staff, (db) => S.getDocument(db, withSupplier))).contactName).toBe('Office Supplies Co');
    const draft = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'expense', paidFromAccountId: bank, issueDate: '2026-03-10', lines: [line()] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, draft))).rejects.toThrow(/who was paid/);
  });

  it('must be paid from a bank or cash account of the same company', async () => {
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'X', paidFromAccountId: f.a.sales, issueDate: '2026-03-10', lines: [line()] })))
      .rejects.toThrow(/bank or cash/);
    await expect(as(f.partner, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'X', paidFromAccountId: f.b.cash, issueDate: '2026-03-10', lines: [line()] })))
      .rejects.toThrow(/bank or cash/);
    const draft = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'X', issueDate: '2026-03-10', lines: [line()] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, draft))).rejects.toThrow(/bank or cash account/);
  });

  it('a recorded expense never changes; voiding posts the reversal once, and nothing else can change', async () => {
    const id = await recorded();
    await expect(owner.query(`UPDATE documents SET payee = 'other' WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`DELETE FROM documents WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
    await as(f.staff, (db) => E.voidExpense(db, id, '2026-03-11'));
    const d = (await owner.query('SELECT status, void_entry_id, journal_entry_id FROM documents WHERE id = $1', [id])).rows[0];
    expect(d.status).toBe('voided');
    expect((await owner.query('SELECT reverses_entry_id FROM journal_entries WHERE id = $1', [d.void_entry_id])).rows[0].reverses_entry_id).toBe(d.journal_entry_id);
    await expect(as(f.staff, (db) => E.voidExpense(db, id, '2026-03-11'))).rejects.toThrow(/already been voided/);
    await expect(owner.query(`UPDATE documents SET notes = 'x' WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
  });

  it('cannot be recorded or voided into a locked period', async () => {
    await addPeriod(f.a.id, '2026-01-01', '2026-01-31', true);
    const draft = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'X', paidFromAccountId: bank, issueDate: '2026-01-10', lines: [line()] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, draft))).rejects.toThrow(/period is locked/);
    const id = await recorded();
    await expect(as(f.staff, (db) => E.voidExpense(db, id, '2026-01-15'))).rejects.toThrow(/period is locked/);
  });

  it('view-only users cannot record or void expenses', async () => {
    const id = await recorded();
    await expect(as(f.a.clientViewer, (db) => S.saveDraft(db, f.a.id, { type: 'expense', payee: 'X', paidFromAccountId: bank, issueDate: '2026-03-10', lines: [line()] }))).rejects.toThrow(/row-level security/);
    await expect(as(f.a.clientViewer, (db) => E.voidExpense(db, id, '2026-03-12'))).rejects.toThrow();
  });
});

describe('Recurring expenses', () => {
  it('next dates keep month-end anchors and step by week, month, quarter and year', () => {
    expect(E.nextOccurrence('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(E.nextOccurrence('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(E.nextOccurrence('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
    expect(E.nextOccurrence('2026-12-29', 'weekly', 29)).toBe('2027-01-05');
    expect(E.nextOccurrence('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
  });

  it('creates draft expenses for every due date (posting nothing), moves the date on, and stops at the end date', async () => {
    const rid = await as(f.staff, (db) => E.saveRecurring(db, f.a.id, {
      name: 'Office rent', payee: 'Landlord', paidFromAccountId: bank, frequency: 'monthly', nextDate: '2026-02-28', endDate: '2026-04-30',
      lines: [line({ description: 'Rent', quantity: '1', unitPrice: '4000.00', vatCode: 'exempt' })] }));
    const created = await as(f.staff, (db) => E.generateRecurring(db, f.a.id, undefined, '2026-06-30'));
    const mine = await as(f.staff, async (db) => (await db.query(`SELECT issue_date::text AS d, status, journal_entry_id FROM documents WHERE recurring_id = $1 ORDER BY issue_date`, [rid])).rows);
    expect(mine.map((d) => d.d)).toEqual(['2026-02-28', '2026-03-28', '2026-04-28']);
    expect(mine.every((d) => d.status === 'draft' && d.journal_entry_id === null)).toBe(true);
    expect(created.length).toBeGreaterThanOrEqual(3);
    const r = await as(f.staff, (db) => E.getRecurring(db, rid));
    expect(r).toMatchObject({ active: false, netAmount: '4000.00' });
    expect(await as(f.staff, (db) => E.generateRecurring(db, f.a.id, rid, '2026-12-31'))).toEqual([]);
  });

  it('a template must name who is paid and pay from a bank account of the company', async () => {
    await expect(as(f.staff, (db) => E.saveRecurring(db, f.a.id, { name: 'X', paidFromAccountId: bank, frequency: 'monthly', nextDate: '2026-03-01', lines: [line()] })))
      .rejects.toThrow(/who is paid/);
    await expect(as(f.staff, (db) => E.saveRecurring(db, f.a.id, { name: 'X', payee: 'Y', paidFromAccountId: f.a.sales, frequency: 'monthly', nextDate: '2026-03-01', lines: [line()] })))
      .rejects.toThrow(/bank or cash/);
  });

  it('another company cannot see the templates', async () => {
    const rid = await as(f.staff, (db) => E.saveRecurring(db, f.a.id, { name: 'Water', payee: 'Water co', paidFromAccountId: bank, frequency: 'weekly', nextDate: '2026-03-02', lines: [line()] }));
    await expect(as(f.b.clientAccountant, (db) => E.getRecurring(db, rid))).rejects.toThrow(/Not found/);
    expect(await as(f.b.clientAccountant, (db) => E.listRecurring(db, f.a.id))).toEqual([]);
  });
});

describe('Expense reports and categories', () => {
  it('by category follows the ledger, voids cancel out, and the books still balance', async () => {
    const before = await as(f.partner, (db) => E.expensesByCategory(db, f.a.id, '2026-05-01', '2026-05-31'));
    const keep = await recorded({ issueDate: '2026-05-05', lines: [line({ unitPrice: '200.00', quantity: '1' })] });
    const gone = await recorded({ issueDate: '2026-05-06', lines: [line({ unitPrice: '999.00', quantity: '1' })] });
    await as(f.staff, (db) => E.voidExpense(db, gone, '2026-05-07'));
    const after = await as(f.partner, (db) => E.expensesByCategory(db, f.a.id, '2026-05-01', '2026-05-31'));
    expect(toMinor(after.total) - toMinor(before.total)).toBe(20000n);
    expect(keep).toBeTruthy();
    const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-12-31'));
    expect(tb.reduce((s, r) => s + toMinor(r.debit), 0n)).toBe(tb.reduce((s, r) => s + toMinor(r.credit), 0n));
  });

  it('by payee groups bills and expenses per supplier or payee, excluding voided ones', async () => {
    await recorded({ payee: 'Taxi', issueDate: '2026-06-02', lines: [line({ unitPrice: '30.00', quantity: '1', vatCode: 'zero' })] });
    await recorded({ payee: 'Taxi', issueDate: '2026-06-03', lines: [line({ unitPrice: '45.00', quantity: '1', vatCode: 'zero' })] });
    const r = await as(f.partner, (db) => E.expensesByPayee(db, f.a.id, '2026-06-01', '2026-06-30'));
    expect(r.rows.find((x) => x.name === 'Taxi')).toMatchObject({ documents: 2, net: '75.00', vat: '0.00', gross: '75.00' });
  });

  it('a new category becomes the next free 5xxx expense account', async () => {
    const id = await as(f.staff, (db) => E.addCategory(db, f.a.id, { name: 'Travel', nameAr: 'السفر' }));
    const a = (await owner.query('SELECT code, type FROM accounts WHERE id = $1', [id])).rows[0];
    expect(a).toEqual({ code: '5200', type: 'expense' });
    await expect(as(f.a.clientViewer, (db) => E.addCategory(db, f.a.id, { name: 'X' }))).rejects.toThrow(/row-level security/);
  });
});
