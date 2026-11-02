// Sales and purchases: invoices, credit notes, bills, quotations and payments.
// Each rule is checked against the database through the app role (row-level security applies).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import { priceLine, postingFor, ageBucket, autoAllocate } from '../src/books/documents.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
let customer: string, customer2: string, supplier: string;
let bank: string;

async function accountId(co: Company, code: string, name: string, type: string, extra = '') {
  const found = await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [co.id, code]);
  if (found.rows[0]) return found.rows[0].id;
  return (await owner.query(`INSERT INTO accounts (company_id, code, name, type${extra ? ', is_bank' : ''}) VALUES ($1,$2,$3,$4${extra ? ', true' : ''}) RETURNING id`,
    [co.id, code, name, type])).rows[0].id;
}

beforeAll(async () => {
  f = await seed();
  // The test chart has 1000 cash, 2100 output VAT, 4000 sales, 5000 rent, 5100 branch costs; add what documents need.
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  bank = f.a.cash;
  await accountId(f.a, '1100', 'Receivables', 'asset');
  await accountId(f.a, '1200', 'Input VAT', 'asset');
  await accountId(f.a, '2000', 'Payables', 'liability');
  await accountId(f.b, '1100', 'Receivables', 'asset');
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', vatNumber: '300000000000003', paymentTermsDays: 30 }));
  customer2 = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Other Customer' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Riyadh Wholesale' }));
});

const line = (over: Partial<Parameters<typeof priceLine>[0]> = {}) =>
  ({ description: 'Steel beams', quantity: '2', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' as const, ...over });

async function issuedInvoice(lines = [line()], date = '2026-03-10', contact = customer) {
  return as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: contact, issueDate: date, dueDate: '2026-04-09', lines });
    await S.issueDocument(db, id);
    return id;
  });
}
const doc = (id: string) => as(f.partner, (db) => S.getDocument(db, id));
const entryLines = async (entryId: string) => (await owner.query(
  `SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code, l.debit`, [entryId])).rows;

describe('Line maths (pure)', () => {
  it('net = quantity x price and VAT = net x rate, each rounded half away from zero', () => {
    const l = priceLine(line({ quantity: '3', unitPrice: '33.33' }), '15.00');
    expect([l.net, l.vat]).toEqual([9999n, 1500n]);          // 99.99 and 14.9985 -> 15.00
    const q = priceLine(line({ quantity: '0.125', unitPrice: '10.00' }), '5.00');
    expect([q.net, q.vat]).toEqual([125n, 6n]);              // 1.25 and 0.0625 -> 0.06
    expect(priceLine(line({ vatCode: 'zero' }), '15.00').vat).toBe(0n);
    expect(() => priceLine(line({ quantity: '0' }), '15.00')).toThrow();
  });

  it('invoice posting balances: Dr receivables, Cr income, Cr output VAT', () => {
    const lines = [priceLine(line(), '15.00'), priceLine(line({ unitPrice: '0.10', quantity: '1', vatCode: 'exempt' }), '15.00')];
    const p = postingFor('invoice', lines, { receivables: 'AR', payables: 'AP', outputVat: 'OV', inputVat: 'IV' });
    const d = p.reduce((s, x) => s + toMinor(x.debit ?? '0'), 0n), c = p.reduce((s, x) => s + toMinor(x.credit ?? '0'), 0n);
    expect(d).toBe(c);
    expect(p[0]).toEqual({ accountId: 'AR', debit: '2300.10' });
  });

  it('ageing buckets and oldest-first allocation', () => {
    expect(ageBucket('2026-03-01', '2026-03-01')).toBe('current');
    expect(ageBucket('2026-03-01', '2026-03-31')).toBe('d1_30');
    expect(ageBucket('2026-01-01', '2026-04-15')).toBe('d90_plus');
    expect(autoAllocate(150n, [{ id: 'a', due: 100n }, { id: 'b', due: 100n }])).toEqual([{ id: 'a', amount: 100n }, { id: 'b', amount: 50n }]);
  });
});

describe('Invoices', () => {
  it('a draft posts nothing; issuing gives the next number and posts Dr receivables / Cr sales / Cr output VAT', async () => {
    const id = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-05', lines: [line()] }));
    expect((await doc(id)).journalEntryId).toBeNull();
    await as(f.staff, (db) => S.issueDocument(db, id));
    const d = await doc(id);
    expect(d).toMatchObject({ status: 'issued', number: 'INV-0001', netTotal: '2000.00', vatTotal: '300.00', grossTotal: '2300.00', amountDue: '2300.00' });
    const codes = (await entryLines(d.journalEntryId)).map((r) => [r.code, r.debit, r.credit]);
    expect(codes).toEqual([['1100', '2300.00', '0.00'], ['2100', '0.00', '300.00'], ['4000', '0.00', '2000.00']]);
    const second = await issuedInvoice();
    expect((await doc(second)).number).toBe('INV-0002');
  });

  it('an issued invoice cannot be edited, re-issued or deleted, even by the owner role', async () => {
    const id = await issuedInvoice();
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { contactId: customer, issueDate: '2026-03-10', lines: [line()] }, id))).rejects.toThrow(/Only drafts/);
    await expect(as(f.staff, (db) => S.issueDocument(db, id))).rejects.toThrow(/already been issued/);
    await expect(owner.query(`UPDATE documents SET notes = 'x' WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`DELETE FROM documents WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`UPDATE document_lines SET description = 'x' WHERE document_id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`DELETE FROM document_lines WHERE document_id = $1`, [id])).rejects.toThrow(/never changed/);
  });

  it('the database rejects line amounts that do not follow quantity x price and the VAT rate', async () => {
    const id = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', lines: [line()] }));
    await expect(owner.query(`UPDATE document_lines SET net_amount = net_amount + 0.01 WHERE document_id = $1`, [id])).rejects.toThrow(/line_net_is_qty_times_price/);
    await expect(owner.query(`UPDATE document_lines SET vat_amount = vat_amount + 0.01 WHERE document_id = $1`, [id])).rejects.toThrow(/line_vat_is_net_times_rate/);
    await expect(owner.query(`UPDATE document_lines SET vat_rate = 5, vat_amount = 100 WHERE document_id = $1`, [id])).rejects.toThrow(/company VAT rate/);
    // Totals that do not match the lines cannot be issued.
    await owner.query(`UPDATE documents SET net_total = 1, vat_total = 0, gross_total = 1 WHERE id = $1`, [id]);
    await expect(as(f.staff, (db) => S.issueDocument(db, id))).rejects.toThrow(/totals do not match/);
  });

  it('cannot be issued into a locked period, and nothing is numbered or posted when it fails', async () => {
    await addPeriod(f.a.id, '2026-01-01', '2026-01-31', true);
    const before = (await owner.query(`SELECT next_no FROM document_sequences WHERE company_id = $1 AND type = 'invoice'`, [f.a.id])).rows[0].next_no;
    const id = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-01-15', lines: [line()] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, id))).rejects.toThrow(/period is locked/);
    expect((await doc(id)).status).toBe('draft');
    const after = (await owner.query(`SELECT next_no FROM document_sequences WHERE company_id = $1 AND type = 'invoice'`, [f.a.id])).rows[0].next_no;
    expect(after).toBe(before);
  });

  it('a sales line must use an income account; a required cost centre is enforced', async () => {
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', lines: [line({ accountId: f.a.rent })] })))
      .rejects.toThrow(/income account/);
    const billId = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-10',
      lines: [line({ accountId: f.a.branchCosts, description: 'Branch rent' })] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, billId))).rejects.toThrow(/cost centre is required/);
  });

  it('a customer of another company, or a supplier, cannot be used on an invoice', async () => {
    const other = await as(f.partner, (db) => S.saveContact(db, f.b.id, { isCustomer: true, name: 'B customer' }));
    await expect(as(f.partner, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: other, issueDate: '2026-03-10', lines: [line()] }))).rejects.toThrow(/different company/);
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: supplier, issueDate: '2026-03-10', lines: [line()] }))).rejects.toThrow(/Choose a customer/);
  });
});

describe('Credit notes', () => {
  it('reverses the invoice VAT exactly, reduces what is due, and cannot exceed the invoice', async () => {
    const inv = await issuedInvoice([line({ quantity: '3', unitPrice: '33.33' })]);   // 99.99 + 15.00
    const cn = await as(f.staff, (db) => S.createCredit(db, inv));
    await as(f.staff, (db) => S.issueDocument(db, cn));
    const c = await doc(cn);
    expect(c).toMatchObject({ number: expect.stringMatching(/^CN-/), vatTotal: '15.00', grossTotal: '114.99' });
    expect((await doc(inv)).amountDue).toBe('0.00');
    expect((await entryLines(c.journalEntryId)).map((r) => [r.code, r.debit, r.credit]))
      .toEqual([['1100', '0.00', '114.99'], ['2100', '15.00', '0.00'], ['4000', '99.99', '0.00']]);
    const again = await as(f.staff, (db) => S.createCredit(db, inv));
    await expect(as(f.staff, (db) => S.issueDocument(db, again))).rejects.toThrow(/cannot be more than what is left/);
  });

  it('only issued invoices can be credited, and only through the invoice', async () => {
    const draft = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', lines: [line()] }));
    await expect(as(f.staff, (db) => S.createCredit(db, draft))).rejects.toThrow(/Only issued/);
  });
});

describe('Payments received', () => {
  it('settles invoices oldest first, updates what is due, and posts Dr bank / Cr receivables', async () => {
    const a = await issuedInvoice([line({ quantity: '1', unitPrice: '100.00' })], '2026-03-01', customer2);   // 115
    const b = await issuedInvoice([line({ quantity: '1', unitPrice: '200.00' })], '2026-03-02', customer2);   // 230
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer2, date: '2026-03-20', amount: '200.00',
      accountId: bank, method: 'bank_transfer', allocations: [{ documentId: a, amount: '115.00' }, { documentId: b, amount: '85.00' }] }));
    expect((await doc(a)).state).toBe('paid');
    expect((await doc(b))).toMatchObject({ amountDue: '145.00', state: 'overdue' });   // partly paid, and its due date has passed
    const p = await as(f.staff, (db) => S.getPayment(db, pid));
    expect(p).toMatchObject({ number: 'RCPT-0001', amount: '200.00', unallocated: '0.00' });
    const je = (await owner.query('SELECT journal_entry_id FROM payments WHERE id = $1', [pid])).rows[0].journal_entry_id;
    expect((await entryLines(je)).map((r) => [r.code, r.debit, r.credit])).toEqual([['1000', '200.00', '0.00'], ['1100', '0.00', '200.00']]);
  });

  it('cannot settle more than is due, more than the payment, or another customer\'s invoice', async () => {
    const inv = await issuedInvoice([line({ quantity: '1', unitPrice: '100.00' })], '2026-03-03', customer2);  // 115
    const pay = (allocations: { documentId: string; amount: string }[], amount = '500.00', contactId = customer2) =>
      as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId, date: '2026-03-21', amount, accountId: bank, allocations }));
    await expect(pay([{ documentId: inv, amount: '115.01' }])).rejects.toThrow(/more than is due/);
    await expect(pay([{ documentId: inv, amount: '50.00' }], '40.00')).rejects.toThrow(/more than the payment/);
    await expect(pay([{ documentId: inv, amount: '10.00' }], '10.00', customer)).rejects.toThrow(/same customer/);
    expect((await doc(inv)).amountDue).toBe('115.00');   // nothing was left behind by the failed attempts
  });

  it('a payment cannot be changed or deleted; voiding posts the reversal and frees the invoice', async () => {
    const inv = await issuedInvoice([line({ quantity: '1', unitPrice: '100.00' })], '2026-03-04', customer2);
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer2, date: '2026-03-22', amount: '115.00',
      accountId: bank, allocations: [{ documentId: inv, amount: '115.00' }] }));
    await expect(owner.query(`UPDATE payments SET amount = 1 WHERE id = $1`, [pid])).rejects.toThrow(/never changed/);
    await expect(owner.query(`DELETE FROM payments WHERE id = $1`, [pid])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(owner.query(`DELETE FROM payment_allocations WHERE payment_id = $1`, [pid])).rejects.toThrow(/cannot be changed or deleted/);
    await as(f.staff, (db) => S.voidPayment(db, pid, '2026-03-23'));
    expect((await doc(inv)).amountDue).toBe('115.00');
    await expect(as(f.staff, (db) => S.voidPayment(db, pid, '2026-03-23'))).rejects.toThrow(/already been voided/);
    const p = (await owner.query('SELECT void_entry_id FROM payments WHERE id = $1', [pid])).rows[0];
    expect(p.void_entry_id).toBeTruthy();
  });

  it('money received with nothing to settle stays on account (customer in credit)', async () => {
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-03-24', amount: '50.00', accountId: bank }));
    expect((await as(f.staff, (db) => S.getPayment(db, pid))).unallocated).toBe('50.00');
  });

  it('only a bank or cash account can receive money', async () => {
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-03-24', amount: '5.00', accountId: f.a.sales })))
      .rejects.toThrow(/bank or cash/);
  });
});

describe('Bills and payments made', () => {
  it('a bill posts Dr expense / Dr input VAT / Cr payables; paying it posts Dr payables / Cr bank', async () => {
    const id = await as(f.staff, async (db) => {
      const d = await S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-12', reference: 'RW-7781',
        lines: [{ description: 'Stock', quantity: '10', unitPrice: '32.00', accountId: f.a.rent, vatCode: 'standard' }] });
      await S.issueDocument(db, d);
      return d;
    });
    const b = await doc(id);
    expect(b).toMatchObject({ number: 'BILL-0001', grossTotal: '368.00', reference: 'RW-7781' });
    expect((await entryLines(b.journalEntryId)).map((r) => [r.code, r.debit, r.credit])).toEqual([['1200', '48.00', '0.00'], ['2000', '0.00', '368.00'], ['5000', '320.00', '0.00']]);
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', contactId: supplier, date: '2026-03-25', amount: '368.00', accountId: bank,
      allocations: [{ documentId: id, amount: '368.00' }] }));
    expect((await doc(id)).state).toBe('paid');
    expect((await as(f.staff, (db) => S.getPayment(db, pid))).number).toBe('PAY-0001');
    const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-12-31'));
    expect(tb.reduce((s, r) => s + toMinor(r.debit), 0n)).toBe(tb.reduce((s, r) => s + toMinor(r.credit), 0n));
  });
});

describe('Quotations', () => {
  it('post nothing; sending numbers them; converting creates a draft invoice and closes the quotation', async () => {
    const q = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'quotation', contactId: customer, issueDate: '2026-03-01', lines: [line()] }));
    await expect(as(f.staff, (db) => S.convertQuotation(db, q))).rejects.toThrow(/Send or accept/);
    await as(f.staff, (db) => S.setQuotationStatus(db, q, 'sent'));
    const sent = await doc(q);
    expect(sent).toMatchObject({ status: 'sent', number: expect.stringMatching(/^QT-/), journalEntryId: null });
    await expect(owner.query(`UPDATE documents SET notes = 'changed' WHERE id = $1`, [q])).rejects.toThrow(/cannot be changed/);
    const inv = await as(f.staff, (db) => S.convertQuotation(db, q));
    expect((await doc(q)).status).toBe('invoiced');
    const d = await doc(inv);
    expect(d).toMatchObject({ type: 'invoice', status: 'draft', originalId: q, grossTotal: '2300.00', reference: sent.number });
  });
});

describe('Who can do what', () => {
  it('view-only users and reviewers can read but not create or issue', async () => {
    const inv = await issuedInvoice();
    for (const u of [f.a.clientViewer, f.reviewer]) {
      expect((await as(u, (db) => S.getDocument(db, inv))).id).toBe(inv);
      await expect(as(u, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', lines: [line()] }))).rejects.toThrow(/row-level security/);
      await expect(as(u, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'X' }))).rejects.toThrow(/row-level security/);
      await expect(as(u, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-03-24', amount: '5.00', accountId: bank }))).rejects.toThrow();
    }
  });

  it('another company\'s users cannot see these customers, documents or payments', async () => {
    const inv = await issuedInvoice();
    const u = f.b.clientAccountant;
    await expect(as(u, (db) => S.getDocument(db, inv))).rejects.toThrow(/Not found/);
    await expect(as(u, (db) => S.getContact(db, customer))).rejects.toThrow(/Not found/);
    expect(await as(u, (db) => S.listDocuments(db, f.a.id, 'invoice'))).toEqual([]);
    expect(await as(u, (db) => S.listPayments(db, f.a.id, 'received'))).toEqual([]);
    const due = await as(u, (db) => db.query('SELECT document_amount_due($1) AS d', [inv]));
    expect(due.rows[0].d).toBeNull();
  });

  it('every document and payment change is in the audit log', async () => {
    const inv = await issuedInvoice();
    const log = (await owner.query(`SELECT action FROM audit_log WHERE table_name = 'documents' AND row_id = $1 ORDER BY id`, [inv])).rows.map((r) => r.action);
    expect(log).toEqual(['insert', 'issue']);
  });
});

describe('Reports', () => {
  it('aged receivables puts each open invoice in the right column and totals per customer', async () => {
    const c = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Ageing Co' }));
    await as(f.staff, async (db) => {
      for (const [date, due] of [['2026-02-01', '2026-02-01'], ['2026-03-01', '2026-03-31'], ['2026-04-01', '2026-05-01']]) {
        const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: c, issueDate: date!, dueDate: due, lines: [line({ quantity: '1', unitPrice: '100.00' })] });
        await S.issueDocument(db, id);
      }
    });
    const r = await as(f.partner, (db) => S.aged(db, f.a.id, 'sales', '2026-05-10'));
    const row = r.rows.find((x) => x.contactId === c)!;
    expect(row).toMatchObject({ current: '0.00', d1_30: '115.00', d31_60: '115.00', d61_90: '0.00', d90_plus: '115.00', total: '345.00' });
  });
});
