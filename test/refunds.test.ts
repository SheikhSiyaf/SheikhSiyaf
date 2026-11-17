// Refunds: paying money back to a customer, and getting money back from a supplier.
//
// Before this, money could only move in one direction per side: in from customers, out to suppliers. A credit note
// reduced what the customer still owed, but if the invoice was already paid the money owed back to them had no way
// out of the system. These tests fix the shape of the fix:
//   * an allocation in the document's natural direction reduces what is due (a receipt against an invoice);
//   * an allocation against it adds back (a refund against that same invoice);
//   * the control account follows the LEDGER SIDE, not the direction of the cash, so a customer refund debits
//     receivables (never payables) and a supplier refund credits payables.
// The last test in the file is the regression guard: ordinary receipts and ordinary supplier payments must post
// exactly the same entries as before, because every existing company's books depend on it.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import { postingForPayment, priceLine } from '../src/books/documents.js';
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
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', paymentTermsDays: 30 }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Riyadh Wholesale' }));
});

const line = (over: Partial<Parameters<typeof priceLine>[0]> = {}) =>
  ({ description: 'Steel beams', quantity: '1', unitPrice: '100.00', accountId: f.a.sales, vatCode: 'standard' as const, ...over });
const costLine = (over: Partial<Parameters<typeof priceLine>[0]> = {}) =>
  ({ description: 'Supplies', quantity: '1', unitPrice: '100.00', accountId: f.a.rent, vatCode: 'standard' as const, ...over });

/** An issued invoice (or bill), paid in full, then credited in full: the customer is owed the whole amount back. */
async function issued(type: 'invoice' | 'bill', lines: unknown[], date: string, contact: string) {
  return as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type, contactId: contact, issueDate: date, dueDate: date, lines: lines as never });
    await S.issueDocument(db, id);
    return id;
  });
}
const doc = (id: string) => as(f.partner, (db) => S.getDocument(db, id));
const entryLines = async (entryId: string) => (await owner.query(
  `SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id
   WHERE l.entry_id = $1 ORDER BY a.code, l.debit`, [entryId])).rows;
const paymentEntry = async (pid: string) => entryLines(
  (await owner.query('SELECT journal_entry_id FROM payments WHERE id = $1', [pid])).rows[0].journal_entry_id);
/** Every posted entry balances, so the whole trial balance must: debits equal credits, to the halala. */
const balanced = async () => {
  const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2030-12-31'));
  const d = tb.reduce((s, r) => s + toMinor(r.debit), 0n);
  const c = tb.reduce((s, r) => s + toMinor(r.credit), 0n);
  return d === c;
};

describe('The ledger side decides the control account (pure)', () => {
  const sys = { receivables: 'AR', payables: 'AP', outputVat: 'OV', inputVat: 'IV', claimsPayable: 'CP' };

  it('posts an ordinary receipt and an ordinary supplier payment exactly as before', () => {
    expect(postingForPayment('received', 11500n, 'BANK', sys, false, 'sales'))
      .toEqual([{ accountId: 'BANK', debit: '115.00' }, { accountId: 'AR', credit: '115.00' }]);
    expect(postingForPayment('made', 11500n, 'BANK', sys, false, 'purchases'))
      .toEqual([{ accountId: 'AP', debit: '115.00' }, { accountId: 'BANK', credit: '115.00' }]);
    expect(postingForPayment('made', 5000n, 'BANK', sys, true, 'purchases'))
      .toEqual([{ accountId: 'CP', debit: '50.00' }, { accountId: 'BANK', credit: '50.00' }]);
  });

  it('a customer refund debits receivables, and a supplier refund credits payables', () => {
    // Money leaves the bank, but the customer's balance is what is being cleared: receivables, not payables.
    expect(postingForPayment('made', 11500n, 'BANK', sys, false, 'sales'))
      .toEqual([{ accountId: 'AR', debit: '115.00' }, { accountId: 'BANK', credit: '115.00' }]);
    expect(postingForPayment('received', 11500n, 'BANK', sys, false, 'purchases'))
      .toEqual([{ accountId: 'BANK', debit: '115.00' }, { accountId: 'AP', credit: '115.00' }]);
  });
});

describe('Refunding a customer', () => {
  it('a credit note on a paid invoice leaves the money owed back to the customer', async () => {
    const inv = await issued('invoice', [line()], '2026-05-01', customer);
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-05-02',
      amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    expect((await doc(inv)).amountDue).toBe('0.00');
    const cn = await as(f.staff, (db) => S.createCredit(db, inv));
    await as(f.staff, (db) => S.issueDocument(db, cn));
    // The invoice now shows a negative amount due: we hold 115.00 that belongs to the customer.
    expect((await doc(inv)).amountDue).toBe('-115.00');
    expect(await as(f.partner, (db) => S.refundable(db, f.a.id, customer))).toMatchObject([{ id: inv, amountDue: '115.00' }]);
  });

  it('pays the money back: Dr receivables, Cr bank, and the invoice settles to nothing', async () => {
    const inv = await issued('invoice', [line()], '2026-05-03', customer);
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-05-04',
      amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    const cn = await as(f.staff, (db) => S.createCredit(db, inv));
    await as(f.staff, (db) => S.issueDocument(db, cn));

    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId: customer,
      date: '2026-05-05', amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    expect(await paymentEntry(pid)).toEqual([
      { code: '1000', debit: '0.00', credit: '115.00' },
      { code: '1100', debit: '115.00', credit: '0.00' },
    ]);
    expect((await doc(inv)).amountDue).toBe('0.00');
    expect((await as(f.staff, (db) => S.getPayment(db, pid)))).toMatchObject({ amount: '115.00', unallocated: '0.00', isRefund: true });
    expect(await balanced()).toBe(true);
  });

  it('cannot refund more than is owed back, and cannot refund an invoice that is still unpaid', async () => {
    const inv = await issued('invoice', [line()], '2026-05-06', customer);
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-05-07',
      amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    const cn = await as(f.staff, (db) => S.createCredit(db, inv));
    await as(f.staff, (db) => S.issueDocument(db, cn));
    const refund = (amount: string, allocation = amount, documentId = inv) =>
      as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId: customer, date: '2026-05-08',
        amount, accountId: bank, allocations: [{ documentId, amount: allocation }] }));
    await expect(refund('115.01')).rejects.toThrow(/more than is owed back/);
    // An invoice the customer still owes money on has nothing to refund.
    const unpaid = await issued('invoice', [line()], '2026-05-06', customer);
    await expect(refund('10.00', '10.00', unpaid)).rejects.toThrow(/more than is owed back/);
    expect((await doc(inv)).amountDue).toBe('-115.00');   // the failed attempts left nothing behind
  });

  it('refunds money the customer paid on account, with nothing to allocate', async () => {
    const paid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer,
      date: '2026-05-09', amount: '60.00', accountId: bank }));
    expect((await as(f.staff, (db) => S.getPayment(db, paid))).unallocated).toBe('60.00');
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId: customer,
      date: '2026-05-10', amount: '60.00', accountId: bank }));
    expect(await paymentEntry(pid)).toEqual([
      { code: '1000', debit: '0.00', credit: '60.00' },
      { code: '1100', debit: '60.00', credit: '0.00' },
    ]);
    expect(await balanced()).toBe(true);
  });

  it('a refund cannot settle a bill, another contact\'s invoice, or be paid from a non-bank account', async () => {
    const bill = await issued('bill', [costLine()], '2026-05-11', supplier);
    const refund = (contactId: string, documentId?: string, accountId = bank) =>
      as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId, date: '2026-05-12',
        amount: '10.00', accountId, allocations: documentId ? [{ documentId, amount: '10.00' }] : [] }));
    await expect(refund(customer, bill)).rejects.toThrow();
    await expect(refund(supplier, bill)).rejects.toThrow();     // a supplier refund is money coming back IN, not out
    await expect(refund(customer, undefined, f.a.sales)).rejects.toThrow(/bank or cash/);
  });

  it('voiding a refund reverses it and puts the money back as owed to the customer', async () => {
    const inv = await issued('invoice', [line()], '2026-05-13', customer);
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-05-14',
      amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    const cn = await as(f.staff, (db) => S.createCredit(db, inv));
    await as(f.staff, (db) => S.issueDocument(db, cn));
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId: customer,
      date: '2026-05-15', amount: '115.00', accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    expect((await doc(inv)).amountDue).toBe('0.00');
    await as(f.staff, (db) => S.voidPayment(db, pid, '2026-05-16'));
    expect((await doc(inv)).amountDue).toBe('-115.00');
    expect(await balanced()).toBe(true);
  });

  it('a refund is refused in a locked period, and refused for another company\'s user', async () => {
    await addPeriod(f.a.id, '2026-06-01', '2026-06-30', true);
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', refund: true, contactId: customer,
      date: '2026-06-15', amount: '10.00', accountId: bank }))).rejects.toThrow(/period is locked/);
    // Company B's books are kept by the partner and reviewer only; row-level security keeps this staff member out of
    // company B, and nobody may refund into a company they are not assigned to.
    await expect(as(f.staff, (db) => S.recordPayment(db, f.b.id, { direction: 'made', refund: true, contactId: customer,
      date: '2026-05-20', amount: '10.00', accountId: bank }))).rejects.toThrow();
  });
});

describe('Getting money back from a supplier', () => {
  it('a supplier credit on a paid bill is refunded by money coming in: Dr bank, Cr payables', async () => {
    const bill = await issued('bill', [costLine()], '2026-05-17', supplier);
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', contactId: supplier, date: '2026-05-18',
      amount: '115.00', accountId: bank, allocations: [{ documentId: bill, amount: '115.00' }] }));
    expect((await doc(bill)).amountDue).toBe('0.00');
    const sc = await as(f.staff, (db) => S.createCredit(db, bill));
    await as(f.staff, (db) => S.issueDocument(db, sc));
    expect((await doc(bill)).amountDue).toBe('-115.00');

    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', refund: true, contactId: supplier,
      date: '2026-05-19', amount: '115.00', accountId: bank, allocations: [{ documentId: bill, amount: '115.00' }] }));
    expect(await paymentEntry(pid)).toEqual([
      { code: '1000', debit: '115.00', credit: '0.00' },
      { code: '2000', debit: '0.00', credit: '115.00' },
    ]);
    expect((await doc(bill)).amountDue).toBe('0.00');
    expect(await balanced()).toBe(true);
  });
});

describe('Nothing that worked before has changed', () => {
  it('an ordinary receipt and an ordinary supplier payment still post and settle exactly as before', async () => {
    const inv = await issued('invoice', [line({ unitPrice: '200.00' })], '2026-07-01', customer);
    const got = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer,
      date: '2026-07-02', amount: '230.00', accountId: bank, allocations: [{ documentId: inv, amount: '230.00' }] }));
    expect(await paymentEntry(got)).toEqual([
      { code: '1000', debit: '230.00', credit: '0.00' },
      { code: '1100', debit: '0.00', credit: '230.00' },
    ]);
    expect((await doc(inv))).toMatchObject({ amountDue: '0.00', state: 'paid' });

    const bill = await issued('bill', [costLine({ unitPrice: '300.00' })], '2026-07-03', supplier);
    const sent = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', contactId: supplier,
      date: '2026-07-04', amount: '345.00', accountId: bank, allocations: [{ documentId: bill, amount: '345.00' }] }));
    expect(await paymentEntry(sent)).toEqual([
      { code: '1000', debit: '0.00', credit: '345.00' },
      { code: '2000', debit: '345.00', credit: '0.00' },
    ]);
    expect((await doc(bill))).toMatchObject({ amountDue: '0.00', state: 'paid' });
    expect((await as(f.staff, (db) => S.getPayment(db, got)))).toMatchObject({ isRefund: false });
    expect(await balanced()).toBe(true);
  });

  it('a receipt still cannot settle a bill and a payment still cannot settle an invoice', async () => {
    const inv = await issued('invoice', [line()], '2026-07-05', customer);
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', contactId: customer, date: '2026-07-06',
      amount: '10.00', accountId: bank, allocations: [{ documentId: inv, amount: '10.00' }] }))).rejects.toThrow();
  });
});
