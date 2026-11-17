// Opening balances brought in as individual open invoices and bills.
//
// A client moving from Excel or another system does not start from zero: they are owed money on particular
// invoices and owe money on particular bills. Until now the bulk import put the whole receivable in as ONE total,
// so the aged debtors report, customer statements and payment matching were wrong from the first day.
//
// An opening document is the real document from the old system: its own number, issue date and due date. It is
// NOT a new sale. The revenue and the VAT belong to the previous system and were declared there, so an opening
// invoice posts Dr receivables / Cr opening balances (3000) with no income and no VAT at all, and it is never
// sent to ZATCA. Everything after that treats it as an ordinary issued invoice: ageing, statements, payments.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as I from '../src/books/importService.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
let customer: string, supplier: string, bank: string;

async function accountId(co: Company, code: string, name: string, type: string) {
  const found = await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [co.id, code]);
  if (found.rows[0]) return found.rows[0].id;
  return (await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) RETURNING id',
    [co.id, code, name, type])).rows[0].id;
}

beforeAll(async () => {
  f = await seed();
  await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.a.cash]);
  bank = f.a.cash;
  await accountId(f.a, '1100', 'Receivables', 'asset');
  await accountId(f.a, '1200', 'Input VAT', 'asset');
  await accountId(f.a, '2000', 'Payables', 'liability');
  await accountId(f.a, '3000', 'Opening balances', 'equity');
  // Company B is used for the old single-total opening import and for the separation checks.
  await accountId(f.b, '1000', 'Cash in bank', 'asset');
  await accountId(f.b, '3000', 'Opening balances', 'equity');
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', paymentTermsDays: 30 }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
});

const doc = (id: string) => as(f.partner, (db) => S.getDocument(db, id));
const entryLines = async (entryId: string) => (await owner.query(
  `SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id
   WHERE l.entry_id = $1 ORDER BY a.code`, [entryId])).rows;
const linesOf = async (id: string) => entryLines((await owner.query('SELECT journal_entry_id FROM documents WHERE id = $1', [id])).rows[0].journal_entry_id);
const opening = (over: Partial<S.OpeningDocInput> = {}): S.OpeningDocInput => ({
  type: 'invoice', contactId: customer, number: 'OLD-1001', issueDate: '2026-02-10', dueDate: '2026-03-12', amount: '1150.00', ...over,
});

describe('An opening invoice', () => {
  it('keeps the number from the old system and posts Dr receivables / Cr opening balances, with no income and no VAT', async () => {
    const id = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening()));
    const d = await doc(id);
    expect(d).toMatchObject({ number: 'OLD-1001', type: 'invoice', status: 'issued', grossTotal: '1150.00', amountDue: '1150.00' });
    // The whole amount goes to opening balances: no 4000 revenue line and no 2100 VAT line anywhere.
    expect(await linesOf(id)).toEqual([
      { code: '1100', debit: '1150.00', credit: '0.00' },
      { code: '3000', debit: '0.00', credit: '1150.00' },
    ]);
    expect(d.vatTotal).toBe('0.00');
  });

  it('keeps its own due date, so the aged report puts it in the right bucket', async () => {
    const id = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening({ number: 'OLD-1002', issueDate: '2026-01-05', dueDate: '2026-02-04', amount: '500.00' })));
    expect((await doc(id)).dueDate).toBe('2026-02-04');
    const agedRows = (await as(f.partner, (db) => S.aged(db, f.a.id, 'sales', '2026-05-06'))).rows;
    const row = agedRows.find((r) => r.contactId === customer) as unknown as Record<string, string>;
    // 2026-02-04 is more than 90 days before 2026-05-06.
    expect(toMinor(row.d90_plus!)).toBeGreaterThanOrEqual(toMinor('500.00'));
  });

  it('is paid like any other invoice, and the payment settles it exactly', async () => {
    const id = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening({ number: 'OLD-1003', amount: '300.00' })));
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-04-01',
      amount: '300.00', accountId: bank, allocations: [{ documentId: id, amount: '300.00' }] }));
    expect(pid).toBeTruthy();
    expect((await doc(id))).toMatchObject({ amountDue: '0.00', state: 'paid' });
  });

  it('is never sent to ZATCA: the revenue and the VAT were declared in the old system', async () => {
    const id = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening({ number: 'OLD-1004', amount: '200.00' })));
    const e = await owner.query('SELECT count(*)::int AS n FROM einvoices WHERE document_id = $1', [id]);
    expect(e.rows[0].n).toBe(0);
    // Even asked for directly, by someone who may write in this company, an opening document is refused.
    await expect(as(f.staff, (db) => db.query(
      `INSERT INTO einvoices (company_id, document_id, scheme, kind, uuid, xml, status) VALUES ($1, $2, 'zatca', 'standard', gen_random_uuid(), '<x/>', 'ready')`,
      [f.a.id, id]))).rejects.toThrow(/opening/i);
  });
});

describe('An opening bill', () => {
  it('posts Cr payables / Dr opening balances, with no expense and no VAT', async () => {
    const id = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening({ type: 'bill', contactId: supplier, number: 'SUP-77', amount: '800.00' })));
    expect(await linesOf(id)).toEqual([
      { code: '2000', debit: '0.00', credit: '800.00' },
      { code: '3000', debit: '800.00', credit: '0.00' },
    ]);
    expect((await doc(id))).toMatchObject({ number: 'SUP-77', amountDue: '800.00' });
  });
});

describe('What an opening document refuses', () => {
  const add = (o: Partial<S.OpeningDocInput>) => as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, opening(o)));

  it('refuses a number already used, a missing contact, and an amount of zero or less', async () => {
    await add({ number: 'DUP-1', amount: '10.00' });
    await expect(add({ number: 'DUP-1', amount: '10.00' })).rejects.toThrow();
    await expect(add({ number: 'X-1', contactId: supplier })).rejects.toThrow();          // a supplier on a sales document
    await expect(add({ number: 'X-2', amount: '0.00' })).rejects.toThrow(/amount/i);
    await expect(add({ number: 'X-3', amount: '-5.00' })).rejects.toThrow(/amount/i);
    await expect(add({ number: '', amount: '10.00' })).rejects.toThrow(/number/i);
  });

  it('refuses a locked period and a user of another company', async () => {
    await addPeriod(f.a.id, '2025-01-01', '2025-01-31', true);
    await expect(add({ number: 'L-1', issueDate: '2025-01-15', dueDate: '2025-02-14' })).rejects.toThrow(/locked/i);
    await expect(as(f.staff, (db) => S.addOpeningDocument(db, f.b.id, opening({ number: 'B-1' })))).rejects.toThrow();
  });

  it('cannot be turned into an ordinary invoice afterwards, and VAT cannot be slipped onto it', async () => {
    const id = await add({ number: 'FIX-1', amount: '100.00' });
    await expect(owner.query('UPDATE documents SET is_opening = false WHERE id = $1', [id])).rejects.toThrow();
    await expect(owner.query('UPDATE document_lines SET vat_amount = 15 WHERE document_id = $1', [id])).rejects.toThrow();
  });
});

describe('Importing a list of open invoices and bills', () => {
  const rows = (list: string[][]) => [['Customer', 'Invoice number', 'Issue date', 'Due date', 'Amount'], ...list];

  it('reads the file, flags an unknown customer, a repeated number and a bad date, and imports the rest', async () => {
    const file = rows([
      ['Gulf Steel', 'IMP-1', '2026-02-01', '2026-03-03', '1,000.00'],
      ['Gulf Steel', 'IMP-2', '2026-02-02', '2026-03-04', '250.50'],
      ['Nobody Ltd', 'IMP-3', '2026-02-03', '2026-03-05', '100.00'],      // not a customer in the books
      ['Gulf Steel', 'IMP-1', '2026-02-04', '2026-03-06', '100.00'],      // the same number twice in the file
      ['Gulf Steel', 'IMP-5', 'not a date', '2026-03-07', '100.00'],
      ['Gulf Steel', 'IMP-6', '2026-02-06', '2026-03-08', 'abc'],
    ]);
    const p = await as(f.staff, (db) => I.preview(db, f.a.id, 'open-invoices', file));
    expect(p.counts).toMatchObject({ new: 2, error: 4 });
    expect(p.rows[2]!.problems).toContain('imp.p.noContact');
    expect(p.rows[3]!.problems).toContain('imp.p.repeated');
    expect(p.rows[4]!.problems).toContain('imp.p.date');
    expect(p.rows[5]!.problems).toContain('imp.p.amount');

    const good = rows([
      ['Gulf Steel', 'IMP-1', '2026-02-01', '2026-03-03', '1,000.00'],
      ['Gulf Steel', 'IMP-2', '2026-02-02', '2026-03-04', '250.50'],
    ]);
    const r = await as(f.staff, (db) => I.run(db, f.a.id, 'open-invoices', good));
    expect(r.imported).toBe(2);
    const made = await as(f.partner, (db) => S.listDocuments(db, f.a.id, 'invoice', {}));
    const imported = made.filter((d) => d.number === 'IMP-1' || d.number === 'IMP-2');
    expect(imported.map((d) => d.amountDue).sort()).toEqual(['1000.00', '250.50']);
  });

  it('a number already in the books is reported, not imported twice', async () => {
    const file = rows([['Gulf Steel', 'IMP-1', '2026-02-01', '2026-03-03', '1,000.00']]);
    const p = await as(f.staff, (db) => I.preview(db, f.a.id, 'open-invoices', file));
    expect(p.rows[0]!.status).toBe('exists');
    await expect(as(f.staff, (db) => I.run(db, f.a.id, 'open-invoices', file))).rejects.toThrow(/nothing new/i);
  });

  it('open bills import against the supplier side', async () => {
    const file = [['Supplier', 'Bill number', 'Issue date', 'Due date', 'Amount'],
      ['Najd Wholesale', 'BILL-9', '2026-02-10', '2026-03-12', '640.00']];
    const r = await as(f.staff, (db) => I.run(db, f.a.id, 'open-bills', file));
    expect(r.imported).toBe(1);
    const bills = await as(f.partner, (db) => S.listDocuments(db, f.a.id, 'bill', {}));
    expect(bills.find((b) => b.number === 'BILL-9')?.amountDue).toBe('640.00');
  });

  it('the books still balance after everything imported', async () => {
    const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2030-12-31'));
    const d = tb.reduce((s, r) => s + toMinor(r.debit), 0n);
    const c = tb.reduce((s, r) => s + toMinor(r.credit), 0n);
    expect(d).toBe(c);
    // Everything brought in sits against opening balances, never against income.
    const revenue = tb.find((r) => r.code === '4000');
    expect(revenue ? toMinor(revenue.credit) - toMinor(revenue.debit) : 0n).toBe(0n);
  });
});

describe('The old single-total opening balance import still works', () => {
  it('posts one balanced entry from account codes, exactly as before', async () => {
    // Company B is kept by the partner and the reviewer; the staff accountant is not assigned to it.
    const file = [['Account code', 'Debit', 'Credit'], ['1000', '5000.00', '0.00'], ['3000', '0.00', '5000.00']];
    const r = await as(f.partner, (db) => I.run(db, f.b.id, 'opening', file, { date: '2026-03-01' }));
    expect(r.entryId).toBeTruthy();
    expect(r.imported).toBe(2);
  });
});
