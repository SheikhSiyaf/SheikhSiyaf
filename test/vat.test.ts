// docs/ACCOUNTING_RULES.md > VAT (before invoices are built)
import { describe, it, expect } from 'vitest';
import { vatForLine, priceInvoice, creditNoteFor, rateToBasisPoints } from '../src/vat/vat.js';
import { toMinor, fromMinor } from '../src/money.js';

describe('Money', () => {
  it('parses and formats decimal strings exactly, never through floats', () => {
    expect(toMinor('0.1') + toMinor('0.2')).toBe(toMinor('0.30'));
    expect(fromMinor(toMinor('9999999999999999.99'))).toBe('9999999999999999.99');
    expect(fromMinor(-5n)).toBe('-0.05');
    expect(() => toMinor('1.234')).toThrow();
    expect(() => toMinor('1e3')).toThrow();
  });
});

describe('VAT', () => {
  it('invoice VAT = line amount x company vat_rate, rounded per line (half up, 2 dp)', () => {
    expect(rateToBasisPoints('15.00')).toBe(1500n);
    expect(vatForLine(toMinor('100.00'), '15.00')).toBe(toMinor('15.00'));
    expect(vatForLine(toMinor('100.00'), '5')).toBe(toMinor('5.00'));
    expect(vatForLine(toMinor('0.10'), '15.00')).toBe(toMinor('0.02'));   // 0.015 -> 0.02
    expect(vatForLine(toMinor('0.03'), '15.00')).toBe(toMinor('0.00'));   // 0.0045 -> 0.00
    expect(vatForLine(toMinor('33.33'), '5.00')).toBe(toMinor('1.67'));   // 1.6665 -> 1.67
    expect(vatForLine(toMinor('-0.10'), '15.00')).toBe(toMinor('-0.02'));
    expect(vatForLine(toMinor('1234.56'), '0')).toBe(0n);

    const inv = priceInvoice([
      { description: 'A', netMinor: toMinor('0.10') },
      { description: 'B', netMinor: toMinor('0.10') },
      { description: 'C', netMinor: toMinor('0.10') },
    ], '15.00');
    expect(fromMinor(inv.vatMinor)).toBe('0.06');       // per line, not 0.30 x 15% = 0.05 on the total
    expect(inv.grossMinor).toBe(inv.netMinor + inv.vatMinor);
  });

  it('credit note reverses the original invoice VAT exactly', () => {
    const inv = priceInvoice([
      { description: 'Widgets', netMinor: toMinor('1999.99') },
      { description: 'Delivery', netMinor: toMinor('33.33') },
      { description: 'Tiny', netMinor: toMinor('0.10') },
    ], '15.00');
    const cn = creditNoteFor(inv);
    expect(cn.vatMinor).toBe(-inv.vatMinor);
    expect(cn.netMinor).toBe(-inv.netMinor);
    expect(cn.grossMinor).toBe(-inv.grossMinor);
    cn.lines.forEach((l, i) => expect(l.vatMinor).toBe(-inv.lines[i]!.vatMinor));
  });

  it('credit note keeps the invoice VAT even if recomputing today would differ', () => {
    // The invoice was issued at 5%; the company is later at 15%. The credit note must still reverse 5%.
    const inv = priceInvoice([{ description: 'Old sale', netMinor: toMinor('100.00') }], '5.00');
    const cn = creditNoteFor(inv);
    expect(fromMinor(cn.vatMinor)).toBe('-5.00');
    expect(cn.vatRate).toBe('5.00');
  });
});
