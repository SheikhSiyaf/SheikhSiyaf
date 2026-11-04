// Debit notes and purchase orders (db/migrations/0033, 0034).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let customer: string, supplier: string, invoice: string, expense: string;
const bal = async (code: string) => (await owner.query(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [f.a.id, code])).rows[0].v;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  expense = f.a.rent;
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale', paymentTermsDays: 15 }));
  invoice = await as(f.staff, async (db) => { const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', dueDate: '2026-04-09',
    lines: [{ description: 'Steel', quantity: '1', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' }] }); await S.issueDocument(db, id); return id; });
});

describe('Debit notes', () => {
  it('raise an issued invoice: numbered DN-, posted like an invoice, paid like one', async () => {
    const dn = await as(f.staff, (db) => S.createDebit(db, invoice));
    await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'debit_note', contactId: customer, issueDate: '2026-03-20', originalId: invoice,
      lines: [{ description: 'Delivery charge not on the invoice', quantity: '1', unitPrice: '200.00', accountId: f.a.sales, vatCode: 'standard' }] }, dn));
    const before = await bal('1100');
    await as(f.staff, (db) => S.issueDocument(db, dn));
    const d = await as(f.staff, (db) => S.getDocument(db, dn));
    expect(d).toMatchObject({ type: 'debit_note', number: 'DN-0001', grossTotal: '230.00', amountDue: '230.00' });
    expect(await bal('1100')).toBe((Number(before) + 230).toFixed(2));
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-03-25', amount: '230.00', accountId: f.a.cash, allocations: [{ documentId: dn, amount: '230.00' }] }));
    expect((await as(f.staff, (db) => S.getDocument(db, dn))).amountDue).toBe('0.00');
  });
  it('point to an issued invoice of the same customer', async () => {
    const other = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Other' }));
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'debit_note', contactId: other, issueDate: '2026-03-20', originalId: invoice,
      lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: f.a.sales, vatCode: 'standard' }] }))).rejects.toThrow();
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'debit_note', contactId: customer, issueDate: '2026-03-20',
      lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: f.a.sales, vatCode: 'standard' }] }))).rejects.toThrow();
  });
});

describe('Purchase orders', () => {
  it('sent (numbered PO-), received, then turned into the bill; never posted', async () => {
    const po = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'purchase_order', contactId: supplier, issueDate: '2026-03-05',
      lines: [{ description: 'Steel beams', quantity: '10', unitPrice: '400.00', accountId: expense, vatCode: 'standard' }] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, po))).rejects.toThrow(/sent, not issued/);
    await as(f.staff, (db) => S.setQuotationStatus(db, po, 'sent'));
    expect((await as(f.staff, (db) => S.getDocument(db, po)))).toMatchObject({ number: 'PO-0001', status: 'sent', journalEntryId: null });
    await expect(as(f.staff, (db) => db.query(`UPDATE documents SET notes = 'changed' WHERE id = $1`, [po]))).rejects.toThrow(/cannot be changed/);
    await as(f.staff, (db) => S.setQuotationStatus(db, po, 'received'));
    const bill = await as(f.staff, (db) => S.convertPurchaseOrder(db, po));
    const b = await as(f.staff, (db) => S.getDocument(db, bill));
    expect(b).toMatchObject({ type: 'bill', status: 'draft', reference: 'PO-0001', originalId: po, dueDate: expect.any(String) });
    expect((await as(f.staff, (db) => S.getDocument(db, po))).status).toBe('billed');
    await as(f.staff, (db) => S.issueDocument(db, bill));
    expect((await as(f.staff, (db) => S.getDocument(db, bill))).grossTotal).toBe('4600.00');
    await expect(as(f.staff, (db) => S.setQuotationStatus(db, po, 'cancelled'))).rejects.toThrow(/cannot move/);
  });
  it('a bill can only point to a purchase order of the same supplier', async () => {
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-05', originalId: invoice,
      lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: expense, vatCode: 'standard' }] }))).rejects.toThrow();
  });
});
