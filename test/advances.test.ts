// Advance payments (db/migrations/0046, src/books/advanceService.ts): the advance invoice posts to 2160 Customer
// advances with VAT; the final invoice carries the whole supply and its VAT less the advance (ZATCA "prepaid amount"),
// and its entry clears 2160 and the advance's VAT, so VAT is counted once. Company A is Saudi (15%).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as A from '../src/books/advanceService.js';
import * as S from '../src/books/documentsService.js';
import { vatReturn } from '../src/books/reportsService.js';

let f: Fixture;
let guest: string, other: string, adv: string, fin: string;
const bal = async (code: string) => (await owner.query(`SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l
  JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [f.a.id, code])).rows[0].v;
const due = async (id: string) => (await owner.query('SELECT document_amount_due($1)::text AS v', [id])).rows[0].v;
const sale = (contactId: string, net: string, date: string) => as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId, issueDate: date,
  lines: [{ description: 'Room nights', quantity: '1', unitPrice: net, accountId: f.a.sales, vatCode: 'standard' }] }));

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['2160', 'Customer advances', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.a.cash]);
  guest = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Hotel guest' }));
  other = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Another guest' }));
});

describe('The advance invoice', () => {
  it('1,150.00 with VAT: Dr Receivables 1,150 / Cr 2160 Customer advances 1,000 / Cr Output VAT 150; the receipt settles it', async () => {
    adv = await as(f.staff, (db) => A.createAdvance(db, f.a.id, { contactId: guest, amount: '1150.00', date: '2027-02-01', description: 'Advance for booking BKG-0001',
      payment: { accountId: f.a.cash, method: 'card' } }));
    const d = (await owner.query('SELECT is_advance, status, net_total::text AS net, vat_total::text AS vat, gross_total::text AS gross FROM documents WHERE id = $1', [adv])).rows[0];
    expect(d).toEqual({ is_advance: true, status: 'issued', net: '1000.00', vat: '150.00', gross: '1150.00' });
    expect(await bal('2160')).toBe('1000.00');
    expect(await bal('2100')).toBe('150.00');
    expect(await due(adv)).toBe('0.00');
  });

  it('an advance invoice posts to 2160 only, with one VAT rate', async () => {
    const id = await sale(guest, '100.00', '2027-02-01');
    await owner.query('UPDATE documents SET is_advance = true WHERE id = $1', [id]);
    await expect(as(f.staff, (db) => S.issueDocument(db, id))).rejects.toThrow(/2160 Customer advances only/);
  });
});

describe('The final invoice', () => {
  it('only a paid advance of the same customer is deducted, on a draft', async () => {
    const unpaid = await as(f.staff, (db) => A.createAdvance(db, f.a.id, { contactId: guest, amount: '115.00', date: '2027-02-02' }));
    fin = await sale(guest, '2000.00', '2027-02-05');                       // 2,000 + 300 VAT = 2,300
    await expect(as(f.staff, (db) => A.deduct(db, fin, unpaid))).rejects.toThrow(/not fully paid/);
    const theirs = await sale(other, '50.00', '2027-02-05');
    await expect(as(f.staff, (db) => A.deduct(db, theirs, adv))).rejects.toThrow(/same customer/);
    expect((await as(f.staff, (db) => A.available(db, f.a.id, guest))).map((x) => x.id)).toEqual([adv]);
  });

  it('2,300 less the 1,150 advance: the entry clears 2160 and the advance VAT; 1,150 left to pay; VAT counted once', async () => {
    await as(f.staff, (db) => A.deduct(db, fin, adv));
    expect(await as(f.staff, (db) => A.deductionsOf(db, fin))).toMatchObject([{ advanceId: adv, net: '1000.00', vat: '150.00', total: '1150.00' }]);
    await as(f.staff, (db) => S.issueDocument(db, fin));
    expect(await due(fin)).toBe('1150.00');
    expect(await bal('2160')).toBe('100.00');                               // only the unpaid 115.00 advance (100 + 15) is left
    // Output VAT: 150 (advance) + 300 (final invoice) - 150 (advance VAT taken off) = 300, the VAT of the whole supply.
    // (Plus 15.00 from the unpaid 115.00 advance issued above.)
    expect(await bal('2100')).toBe('315.00');
    const entry = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM documents d JOIN journal_lines l ON l.entry_id = d.journal_entry_id
      JOIN accounts a ON a.id = l.account_id WHERE d.id = $1 ORDER BY a.code, l.debit DESC`, [fin])).rows;
    expect(entry).toEqual([
      { code: '1100', debit: '2300.00', credit: '0.00' }, { code: '1100', debit: '0.00', credit: '1150.00' },
      { code: '2100', debit: '150.00', credit: '0.00' }, { code: '2100', debit: '0.00', credit: '300.00' },
      { code: '2160', debit: '1000.00', credit: '0.00' }, { code: '4000', debit: '0.00', credit: '2000.00' },
    ]);
  });

  it('the VAT worksheet takes the advance VAT off the final invoice and still agrees with the books', async () => {
    const r = await as(f.staff, (db) => vatReturn(db, f.a.id, '2027-02-01', '2027-02-28'));
    expect(r.sales.standard).toMatchObject({ net: '2100.00', vat: '315.00' });   // 1,000 + 100 advances + 2,000 - 1,000 taken off
    expect(r.agreesWithBooks).toBe(true);
  });

  it('an advance is used once; deductions on an issued invoice stay; a deducted advance is not credited', async () => {
    const again = await sale(guest, '500.00', '2027-02-06');
    await expect(as(f.staff, (db) => A.deduct(db, again, adv))).rejects.toThrow(/Nothing is left/);
    await expect(as(f.staff, (db) => A.removeDeduction(db, fin, adv))).rejects.toThrow(/no longer changes/);
    const cn = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'credit_note', contactId: guest, issueDate: '2027-02-07', originalId: adv,
      lines: [{ description: 'Refund', quantity: '1', unitPrice: '100.00', accountId: f.a.sales, vatCode: 'standard' }] }));
    await expect(as(f.staff, (db) => S.issueDocument(db, cn))).rejects.toThrow(/has been deducted/);
  });

  it('part of an advance: 500.00 advance, 230.00 taken now (200 + 30), the rest (234.78 + 35.22) later', async () => {
    const big = await as(f.staff, (db) => A.createAdvance(db, f.a.id, { contactId: other, amount: '500.00', date: '2027-03-01', payment: { accountId: f.a.cash } }));
    const one = await sale(other, '200.00', '2027-03-02');                  // 230 with VAT
    await as(f.staff, (db) => A.deduct(db, one, big));
    expect(await as(f.staff, (db) => A.deductionsOf(db, one))).toMatchObject([{ net: '200.00', vat: '30.00' }]);
    await as(f.staff, (db) => S.issueDocument(db, one));
    expect(await due(one)).toBe('0.00');
    const two = await sale(other, '1000.00', '2027-03-03');
    await as(f.staff, (db) => A.deduct(db, two, big));
    expect(await as(f.staff, (db) => A.deductionsOf(db, two))).toMatchObject([{ net: '234.78', vat: '35.22', total: '270.00' }]);
    await as(f.staff, (db) => S.issueDocument(db, two));
    expect(await due(two)).toBe('880.00');
    const left = (await owner.query('SELECT net::text, vat::text FROM advance_left($1)', [big])).rows[0];
    expect(left).toEqual({ net: '0.00', vat: '0.00' });
  });

  it('other companies see nothing; view-only people deduct nothing', async () => {
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM advance_deductions'))).rows).toHaveLength(0);
    const d = await sale(guest, '10.00', '2027-04-01');
    await expect(as(f.a.clientViewer, (db) => A.deduct(db, d, adv))).rejects.toThrow();
  });
});
