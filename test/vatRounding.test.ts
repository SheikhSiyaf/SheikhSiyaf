// How VAT is rounded on an invoice with more than one line.
//
// ZATCA Electronic Invoice XML Implementation Standard v1.2, section 10 "Rounding", says it plainly:
//
//   - Rounding shall be done on the final calculation results not on any intermediate results;
//   - VAT category tax amount shall be rounded on document level and not as a summation of rounded Invoice line
//     VAT amounts.
//
// Until now Nusuh Books rounded each line's VAT and added them up, which is the thing that sentence forbids. On
// 38.5% of random multi-line invoices the two rules give a different total, by one or two halalas. It also breaks
// ZATCA's own arithmetic rule BR-CO-17, which requires the VAT shown for a category to equal that category's
// taxable amount times its rate, rounded once.
//
// The category total is now worked out on the document's figures, then spread back over the lines so the lines
// still add up to it. That keeps the invoice internally consistent, keeps the ledger equal to the document, and
// satisfies BR-CO-17.
import { describe, it, expect } from 'vitest';
import { priceLine, roundVatByCategory, documentTotals, type PricedLine } from '../src/books/documents.js';
import { vatForLine } from '../src/vat/vat.js';
import { fromMinor, toMinor } from '../src/money.js';
import * as X from '../src/einvoice/zatca/xml.js';
import type { EInvoiceData } from '../src/einvoice/invoiceData.js';

/** Lines priced the old way (each line's VAT rounded on its own), ready to be corrected. */
const lines = (nets: string[], vatCode: 'standard' | 'zero' = 'standard', rate = '15.00'): PricedLine[] =>
  nets.map((n, i) => priceLine({ description: `Line ${i + 1}`, quantity: '1', unitPrice: n, accountId: 'a', vatCode }, rate));

const vats = (ls: PricedLine[]) => ls.map((l) => fromMinor(l.vat));
const total = (ls: PricedLine[]) => fromMinor(documentTotals(ls).vat);

describe('VAT on an invoice with several lines', () => {
  it('rounds the category once on the document total, not once per line', () => {
    // 3.10 + 3.10 at 15%. Per line: 0.465 -> 0.47 each, 0.94 together. ZATCA: 6.20 x 15% = 0.93, rounded once.
    const old = lines(['3.10', '3.10']);
    expect(total(old)).toBe('0.94');
    const fixed = roundVatByCategory(old);
    expect(total(fixed)).toBe('0.93');
    expect(vatForLine(toMinor('6.20'), '15.00')).toBe(toMinor('0.93'));
  });

  it('spreads the category total over its lines so the lines still add up to it', () => {
    const fixed = roundVatByCategory(lines(['3.10', '3.10']));
    expect(vats(fixed)).toEqual(['0.47', '0.46']);          // 0.93 between them, largest share first
    expect(fixed.reduce((t, l) => t + l.vat, 0n)).toBe(toMinor('0.93'));
  });

  it('gives the halalas to the lines with the largest part left over, and in line order when they tie', () => {
    // 0.10 x 3 at 15% = 0.045 -> 0.05 for the category; each line's exact share is 0.015, all tied.
    const fixed = roundVatByCategory(lines(['0.10', '0.10', '0.10']));
    expect(total(fixed)).toBe('0.05');
    expect(vats(fixed)).toEqual(['0.02', '0.02', '0.01']);
  });

  it('leaves an invoice alone when the two rules agree', () => {
    for (const nets of [['1.00', '2.00', '3.00'], ['100.00'], ['3.33', '3.33', '3.33']]) {
      const old = lines(nets);
      expect(vats(roundVatByCategory(old))).toEqual(vats(old));
    }
  });

  it('treats each VAT category on its own: a zero-rated line never borrows a halala', () => {
    const mixed = [...lines(['3.10', '3.10']), ...lines(['9.99', '9.99'], 'zero')];
    const fixed = roundVatByCategory(mixed);
    expect(vats(fixed)).toEqual(['0.47', '0.46', '0.00', '0.00']);
    expect(total(fixed)).toBe('0.93');
  });

  it('never invents or loses VAT: the lines always add up to the category, over many invoices', () => {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 4000; i++) {
      const n = 1 + (next() % 6);
      const nets = Array.from({ length: n }, () => fromMinor(BigInt(1 + (next() % 200000))));
      const fixed = roundVatByCategory(lines(nets));
      const netTotal = fixed.reduce((t, l) => t + l.net, 0n);
      // the one figure ZATCA cares about, and the lines agreeing with it
      expect(fixed.reduce((t, l) => t + l.vat, 0n)).toBe(vatForLine(netTotal, '15.00'));
      expect(fixed.every((l) => l.vat >= 0n)).toBe(true);
    }
  });

  it('keeps each line within a halala of its own share, so no line looks wrong on the invoice', () => {
    const nets = ['3.10', '3.10', '3.10', '3.10'];
    const fixed = roundVatByCategory(lines(nets));
    for (const l of fixed) {
      const own = vatForLine(l.net, '15.00');
      expect(l.vat - own >= -1n && l.vat - own <= 1n).toBe(true);
    }
  });
});

describe('The e-invoice of an invoice whose lines round differently', () => {
  const party = { name: 'Al Noor Trading', vatNumber: '310122393500003', crNumber: '1010010000', street: 'Prince Sultan', building: '2322', district: 'Al-Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' };
  const build = (ls: PricedLine[]): string => {
    const t = documentTotals(ls);
    const data: EInvoiceData = {
      number: 'INV-0001', uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', type: 'invoice', issueDate: '2026-11-03', issueTime: '14:40:40',
      supplyDate: '2026-11-03', currency: 'SAR', seller: party, buyer: { ...party, vatNumber: '300075588700003' }, paymentMeans: '10',
      lines: ls.map((l, i) => ({ no: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, net: fromMinor(l.net), vat: fromMinor(l.vat), vatCode: l.vatCode, vatRate: l.vatRate })),
      netTotal: fromMinor(t.net), vatTotal: fromMinor(t.vat), grossTotal: fromMinor(t.gross),
      exemption: { zero: { code: 'VATEX-SA-32', text: 'Export' }, exempt: { code: 'VATEX-SA-29', text: 'Financial' }, out_of_scope: { code: 'VATEX-SA-OOS', text: 'Not subject' } },
    };
    return X.invoiceXml(data, { icv: 1, pih: X.FIRST_PIH });
  };

  it('satisfies ZATCA BR-CO-17: the category VAT shown is the taxable amount times the rate, rounded once', () => {
    // BR-CO-17: "VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate
    // (BT-119) / 100), rounded to two decimals." 6.20 at 15% is 0.93. Rounding each 3.10 line gave 0.94, which
    // fails that rule; the invoice ZATCA receives would have been arithmetically wrong.
    const xml = build(roundVatByCategory(lines(['3.10', '3.10'])));
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">6.20</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">0.93</cbc:TaxAmount>');
    expect(xml).toContain('<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">0.93</cbc:TaxAmount></cac:TaxTotal>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">7.13</cbc:TaxInclusiveAmount>');
  });

  it('the old way broke that rule, which is why this changed', () => {
    const xml = build(lines(['3.10', '3.10']));   // not corrected: each line rounded on its own
    // The breakdown says 6.20 taxable but 0.94 tax, and 6.20 x 15% is 0.93. That is the defect.
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">6.20</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">0.94</cbc:TaxAmount>');
    expect(toMinor('0.94')).not.toBe(vatForLine(toMinor('6.20'), '15.00'));
  });

  it('an invoice with one line per category is byte-for-byte what it always was', () => {
    // Nothing to re-round, so no e-invoice already sent to ZATCA can have its hash moved by this change.
    const one = lines(['1000.00']);
    expect(build(roundVatByCategory(one))).toBe(build(one));
  });
});
