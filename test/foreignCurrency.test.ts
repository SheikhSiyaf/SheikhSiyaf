// Invoices, bills and payments written in another currency (phase 4).
//
// The ledger stays in ONE currency: the company's. That is deliberate and it is what keeps the trial balance
// provable. A foreign-currency document carries two sets of figures:
//   * the amounts as written on the document (fx_*), in the document's currency, which is what the customer sees
//     and what goes on the e-invoice;
//   * the same amounts converted at the document's own rate, in the company's currency, which is what posts to the
//     ledger and what every report, the aged list, the statement and `document_amount_due` already read.
// Nothing that existed before changes meaning: a document with no currency is a company-currency document, exactly
// as it was.
//
// When a foreign invoice is settled, the cash is worth a different number of riyals than when the invoice was
// raised. The receivable is relieved at the rate it was BOOKED at, the bank gets what actually arrived, and the
// difference is a realised exchange gain or loss (account 4951). That is the whole of IAS 21 realisation.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import { trialBalance } from '../src/ledger/ledger.js';
import * as X from '../src/einvoice/zatca/xml.js';
import type { EInvoiceData } from '../src/einvoice/invoiceData.js';

let f: Fixture;
let customer: string, supplier: string, bank: string;

async function need(co: Company, code: string, name: string, type: string) {
  const found = await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [co.id, code]);
  if (found.rows[0]) return found.rows[0].id as string;
  return (await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) RETURNING id',
    [co.id, code, name, type])).rows[0].id as string;
}

beforeAll(async () => {
  f = await seed();
  await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.a.cash]);
  bank = f.a.cash;
  await need(f.a, '1100', 'Accounts receivable', 'asset');
  await need(f.a, '1200', 'Input VAT', 'asset');
  await need(f.a, '2000', 'Accounts payable', 'liability');
  await need(f.a, '4951', 'Realised exchange gains and losses', 'income');
  await need(f.a, '3000', "Owner's equity", 'equity');
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', paymentTermsDays: 30 }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Hamburg Werke' }));
});

/** A line priced in the document's own currency. */
const line = (unitPrice = '100.00', quantity = '2') =>
  ({ description: 'Steel beams', quantity, unitPrice, accountId: f.a.sales, vatCode: 'standard' as const });
const costLine = (unitPrice = '100.00', quantity = '2') =>
  ({ description: 'Machine parts', quantity, unitPrice, accountId: f.a.rent, vatCode: 'standard' as const });

async function issued(type: 'invoice' | 'bill', lines: unknown[], over: Record<string, unknown> = {}) {
  return as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, {
      type, contactId: type === 'invoice' ? customer : supplier, issueDate: '2026-03-10', dueDate: '2026-04-10',
      lines: lines as never, ...over,
    });
    await S.issueDocument(db, id);
    return id;
  });
}

const entryLines = async (entryId: string) => (await owner.query(
  `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id
   WHERE l.entry_id = $1 ORDER BY a.code`, [entryId])).rows as { code: string; debit: string; credit: string }[];
const entryOf = async (docId: string) => (await owner.query('SELECT journal_entry_id FROM documents WHERE id = $1', [docId])).rows[0].journal_entry_id;
const payEntryOf = async (payId: string) => (await owner.query('SELECT journal_entry_id FROM payments WHERE id = $1', [payId])).rows[0].journal_entry_id;
const row = (ls: { code: string; debit: string; credit: string }[], code: string) => ls.find((l) => l.code === code);
const docRow = async (id: string) => (await owner.query(
  `SELECT currency, fx_rate::text AS fx_rate, fx_net_total::text AS fx_net, fx_vat_total::text AS fx_vat, fx_gross_total::text AS fx_gross,
          net_total::text AS net, vat_total::text AS vat, gross_total::text AS gross FROM documents WHERE id = $1`, [id])).rows[0];
const due = async (id: string) => (await owner.query('SELECT document_amount_due($1)::text AS d', [id])).rows[0].d;
const fxDue = async (id: string) => (await owner.query('SELECT document_fx_due($1)::text AS d', [id])).rows[0].d;
const balanced = async (co: Company, asOf = '2026-12-31') => {
  const rows = await as(f.partner, (db) => trialBalance(db, co.id, asOf));
  const dr = rows.reduce((s, r) => s + Math.round(Number(r.debit) * 100), 0);
  const cr = rows.reduce((s, r) => s + Math.round(Number(r.credit) * 100), 0);
  return { dr, cr };
};

// ---------------------------------------------------------------------------------------------------------------
describe('A document written in another currency', () => {
  it('keeps the written amounts and posts the converted ones', async () => {
    // USD 100.00 x 2 = USD 200.00 net, USD 30.00 VAT at 15%, USD 230.00 gross, at 3.75 SAR to the dollar.
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    const d = await docRow(id);
    expect(d.currency).toBe('USD');
    expect(d.fx_rate).toBe('3.75000000');
    expect([d.fx_net, d.fx_vat, d.fx_gross]).toEqual(['200.00', '30.00', '230.00']);
    // The company's books: 100.00 x 3.75 = 375.00 a unit, so 750.00 net, 112.50 VAT, 862.50 gross.
    expect([d.net, d.vat, d.gross]).toEqual(['750.00', '112.50', '862.50']);

    const ls = await entryLines(await entryOf(id));
    expect(row(ls, '1100')!.debit).toBe('862.50');
    expect(row(ls, '4000')!.credit).toBe('750.00');
    expect(row(ls, '2100')!.credit).toBe('112.50');
  });

  it('what is still owed is given in both currencies', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    expect(await due(id)).toBe('862.50');     // riyals, as every report and the aged list read it
    expect(await fxDue(id)).toBe('230.00');   // dollars, as the customer sees it
  });

  it('a bill in another currency posts the same way on the purchases side', async () => {
    const id = await issued('bill', [costLine('100.00', '2')], { currency: 'EUR', fxRate: '4.10' });
    const ls = await entryLines(await entryOf(id));
    expect(row(ls, '2000')!.credit).toBe('943.00');   // 410.00 x 2 = 820.00 + 123.00 VAT
    expect(row(ls, '5000')!.debit).toBe('820.00');
    expect(row(ls, '1200')!.debit).toBe('123.00');
  });

  it('a document with no currency is unchanged: no currency, no rate, no converted figures', async () => {
    const id = await issued('invoice', [line('100.00', '2')]);
    const d = await docRow(id);
    expect(d.currency).toBeNull();
    expect(d.fx_rate).toBeNull();
    expect(d.fx_gross).toBeNull();
    expect([d.net, d.vat, d.gross]).toEqual(['200.00', '30.00', '230.00']);
    expect(await fxDue(id)).toBe('230.00');   // falls back to the company's own currency
  });

  it('the company\'s own currency is not a foreign currency', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'SAR', fxRate: '1' });
    expect((await docRow(id)).currency).toBeNull();
  });

  it('refuses a currency without a usable rate, and a rate that is not positive', async () => {
    await expect(issued('invoice', [line()], { currency: 'USD' })).rejects.toThrow(/rate/i);
    await expect(issued('invoice', [line()], { currency: 'USD', fxRate: '0' })).rejects.toThrow(/rate/i);
    await expect(issued('invoice', [line()], { currency: 'USD', fxRate: '-3.75' })).rejects.toThrow(/rate/i);
    await expect(issued('invoice', [line()], { currency: 'usd!', fxRate: '3.75' })).rejects.toThrow(/currency/i);
  });

  it('an issued document never changes its currency or its rate', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    await expect(owner.query(`UPDATE documents SET fx_rate = 4 WHERE id = $1`, [id])).rejects.toThrow();
    await expect(owner.query(`UPDATE documents SET currency = 'EUR' WHERE id = $1`, [id])).rejects.toThrow();
  });

  it('an opening balance and an expense stay in the company\'s currency', async () => {
    const open = await as(f.staff, (db) => S.addOpeningDocument(db, f.a.id, {
      type: 'invoice', contactId: customer, number: 'OLD-FX-1', issueDate: '2026-01-01', dueDate: '2026-02-01', amount: '100.00',
    }));
    await expect(owner.query(`UPDATE documents SET currency = 'USD', fx_rate = 3.75, fx_net_total = 100, fx_vat_total = 0, fx_gross_total = 100 WHERE id = $1`, [open]))
      .rejects.toThrow();
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, {
      type: 'expense', issueDate: '2026-03-10', payee: 'Taxi', paidFromAccountId: bank,
      lines: [costLine()] as never, currency: 'USD', fxRate: '3.75',
    }))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Settling a foreign invoice', () => {
  it('relieves the receivable at the invoice\'s rate and books the gain', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    // USD 230.00 arrives when the dollar is worth 3.80: SAR 874.00 in the bank against a SAR 862.50 receivable.
    const pay = await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'USD', fxRate: '3.80', allocations: [{ documentId: id, amount: '230.00' }],
    }));
    const ls = await entryLines(await payEntryOf(pay));
    expect(row(ls, '1000')!.debit).toBe('874.00');
    expect(row(ls, '1100')!.credit).toBe('862.50');
    expect(row(ls, '4951')!.credit).toBe('11.50');
    expect(await due(id)).toBe('0.00');
    expect(await fxDue(id)).toBe('0.00');
  });

  it('books the loss when the currency has moved the other way', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    const pay = await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'USD', fxRate: '3.70', allocations: [{ documentId: id, amount: '230.00' }],
    }));
    const ls = await entryLines(await payEntryOf(pay));
    expect(row(ls, '1000')!.debit).toBe('851.00');
    expect(row(ls, '1100')!.credit).toBe('862.50');
    expect(row(ls, '4951')!.debit).toBe('11.50');
  });

  it('a supplier paid in euros: the payable goes at the bill\'s rate, the difference is ours', async () => {
    const id = await issued('bill', [costLine('100.00', '2')], { currency: 'EUR', fxRate: '4.10' });
    const pay = await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'made', contactId: supplier, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'EUR', fxRate: '4.20', allocations: [{ documentId: id, amount: '230.00' }],
    }));
    const ls = await entryLines(await payEntryOf(pay));
    expect(row(ls, '2000')!.debit).toBe('943.00');    // the payable as it was booked
    expect(row(ls, '1000')!.credit).toBe('966.00');   // what actually left the bank
    expect(row(ls, '4951')!.debit).toBe('23.00');     // paying later cost us more riyals
  });

  it('two part payments close the invoice exactly, in both currencies', async () => {
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '100.00', accountId: bank,
      currency: 'USD', fxRate: '3.80', allocations: [{ documentId: id, amount: '100.00' }],
    }));
    expect(await fxDue(id)).toBe('130.00');
    expect(await due(id)).toBe('487.50');            // 862.50 - round(100 x 3.75)
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-05-05', amount: '130.00', accountId: bank,
      currency: 'USD', fxRate: '3.90', allocations: [{ documentId: id, amount: '130.00' }],
    }));
    expect(await fxDue(id)).toBe('0.00');
    expect(await due(id)).toBe('0.00');              // no riyal left behind
  });

  it('refuses a payment in a currency the document is not in, and one left unallocated', async () => {
    const usd = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    const plain = await issued('invoice', [line('100.00', '2')]);
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'EUR', fxRate: '4.10', allocations: [{ documentId: usd, amount: '230.00' }],
    }))).rejects.toThrow(/currency/i);
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'USD', fxRate: '3.75', allocations: [{ documentId: plain, amount: '230.00' }],
    }))).rejects.toThrow(/currency/i);
    await expect(as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'USD', fxRate: '3.75', allocations: [{ documentId: usd, amount: '100.00' }],
    }))).rejects.toThrow(/settled in full|whole/i);
  });

  it('every entry balances and the trial balance still adds up', async () => {
    const before = await balanced(f.a);
    expect(before.dr).toBe(before.cr);
    const id = await issued('invoice', [line('100.00', '2')], { currency: 'USD', fxRate: '3.75' });
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, {
      direction: 'received', contactId: customer, date: '2026-04-05', amount: '230.00', accountId: bank,
      currency: 'USD', fxRate: '3.80', allocations: [{ documentId: id, amount: '230.00' }],
    }));
    const after = await balanced(f.a);
    expect(after.dr).toBe(after.cr);
    expect(after.dr).toBeGreaterThan(before.dr);
  });

  it('a company with no 4951 account is told so, not left with a broken entry', async () => {
    await need(f.b, '1100', 'Accounts receivable', 'asset');
    await need(f.b, '1200', 'Input VAT', 'asset');
    await need(f.b, '2000', 'Accounts payable', 'liability');
    await need(f.b, '4951', 'Realised exchange gains and losses', 'income');
    await owner.query(`UPDATE accounts SET code = '4952' WHERE company_id = $1 AND code = '4951'`, [f.b.id]);
    const other = await as(f.partner, (db) => S.saveContact(db, f.b.id, { isCustomer: true, name: 'Dubai Metals', country: 'AE' }));
    const id = await as(f.partner, async (db) => {
      const x = await S.saveDraft(db, f.b.id, { type: 'invoice', contactId: other, issueDate: '2026-03-10', dueDate: '2026-04-10',
        currency: 'USD', fxRate: '3.67', lines: [{ description: 'Pipes', quantity: '2', unitPrice: '100.00', accountId: f.b.sales, vatCode: 'standard' }] as never });
      await S.issueDocument(db, x);
      return x;
    });
    await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.b.cash]);
    await expect(as(f.partner, (db) => S.recordPayment(db, f.b.id, {
      direction: 'received', contactId: other, date: '2026-04-05', amount: '200.00', accountId: f.b.cash,
      currency: 'USD', fxRate: '3.70', allocations: [{ documentId: id, amount: '200.00' }],
    }))).rejects.toThrow(/4951/);
    await owner.query(`UPDATE accounts SET code = '4951' WHERE company_id = $1 AND code = '4952'`, [f.b.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('The e-invoice of a foreign-currency invoice', () => {
  const seller = { name: 'Al Noor Trading', vatNumber: '310122393500003', crNumber: '1010010000', street: 'Prince Sultan', building: '2322', district: 'Al-Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' };
  const buyer = { name: 'Gulf Steel & Sons', vatNumber: '300075588700003', street: 'King Fahd Road', building: '1111', district: 'Al-Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' };
  const data = (over: Partial<EInvoiceData> = {}): EInvoiceData => ({
    number: 'INV-0001', uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', type: 'invoice', issueDate: '2026-11-03', issueTime: '14:40:40', supplyDate: '2026-11-03',
    currency: 'SAR', seller, buyer, paymentMeans: '10',
    lines: [
      { no: 1, description: 'Steel pipes <2">', quantity: '2.000', unitPrice: '500.00', net: '1000.00', vat: '150.00', vatCode: 'standard', vatRate: '15.00' },
      { no: 2, description: 'Export packing', quantity: '1.000', unitPrice: '100.00', net: '100.00', vat: '0.00', vatCode: 'zero', vatRate: '0.00' },
    ],
    netTotal: '1100.00', vatTotal: '150.00', grossTotal: '1250.00',
    exemption: { zero: { code: 'VATEX-SA-32', text: 'Export of goods' }, exempt: { code: 'VATEX-SA-29', text: 'Financial services' }, out_of_scope: { code: 'VATEX-SA-OOS', text: 'Not subject to VAT' } },
    ...over,
  });

  // THE GUARD THAT MATTERS MOST. Every e-invoice already sent to ZATCA is chained by its hash. If this phase
  // changed one byte of the XML of an ordinary riyal invoice, every stored hash would stop matching and the chain
  // would break for every company already live. This hash was taken from the code BEFORE the phase began.
  it('leaves a riyal invoice byte-identical: the hash chain is untouched', () => {
    const xml = X.invoiceXml(data(), { icv: 7, pih: X.FIRST_PIH });
    expect(xml.length).toBe(5730);
    expect(X.invoiceHash(xml).base64).toBe('/PMfO2md4XfChMEP9PKPVOegINV4MHcui4HCaFED/NE=');
  });

  it('reports the VAT in riyals as well as the invoice currency', () => {
    // ZATCA BR-KSA-EN16931-02 and BR-53: the invoice is written in dollars, but the VAT is accounted for in SAR,
    // so the tax amount must also be given in SAR (BT-111).
    const xml = X.invoiceXml(data({ currency: 'USD', vatTotalInTaxCurrency: '562.50' }), { icv: 1, pih: X.FIRST_PIH });
    expect(xml).toContain('<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>');
    // the standalone tax total is the riyal one, the detailed breakdown stays in the invoice's currency
    expect(xml).toContain('<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">562.50</cbc:TaxAmount></cac:TaxTotal>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="USD">150.00</cbc:TaxAmount><cac:TaxSubtotal>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="USD">1000.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="USD">1250.00</cbc:PayableAmount>');
    // Both totals are the same element, so the breakdown marks BT-110 and the standalone one BT-111. When they
    // differ the breakdown comes first, which is the order EN16931 documents.
    expect(xml.indexOf('<cac:TaxSubtotal>')).toBeLessThan(xml.indexOf('<cbc:TaxAmount currencyID="SAR">562.50'));
  });

  it('a riyal invoice keeps the tax totals in the order the validator already accepted', () => {
    const xml = X.invoiceXml(data(), { icv: 1, pih: X.FIRST_PIH });
    // The standalone total first, then the breakdown: unchanged, which is why the hash above is unchanged.
    expect(xml).toContain('<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">150.00</cbc:TaxAmount></cac:TaxTotal><cac:TaxTotal>');
  });
});
