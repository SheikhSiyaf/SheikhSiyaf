// Item barcodes: check digits, the codes Nusuh makes, and the bars drawn for EAN-13 and Code 128.
import { describe, expect, it } from 'vitest';
import { badCheckDigit, barcodeModules, checkDigit, cleanBarcode, code128Modules, ean13Modules, internalEan, validBarcode } from '../src/books/barcode.js';

describe('barcode check digits', () => {
  it('computes the EAN-13, EAN-8 and UPC-A check digit', () => {
    expect(checkDigit('400638133393')).toBe(1);   // 4006381333931
    expect(checkDigit('590123412345')).toBe(7);   // 5901234123457
    expect(checkDigit('9638507')).toBe(4);        // EAN-8 96385074
    expect(checkDigit('03600029145')).toBe(2);    // UPC-A 036000291452
  });
  it('catches a mistyped retail code and leaves other codes alone', () => {
    expect(badCheckDigit('4006381333931')).toBe(false);
    expect(badCheckDigit('4006381333932')).toBe(true);
    expect(badCheckDigit('96385075')).toBe(true);
    expect(badCheckDigit('12345')).toBe(false);          // not a retail length: any code is fine
    expect(badCheckDigit('ABC-123')).toBe(false);
  });
  it('accepts printable codes and refuses spaces, empty and wrong check digits', () => {
    expect(validBarcode('RICE-25KG')).toBe(true);
    expect(validBarcode('4006381333931')).toBe(true);
    expect(validBarcode('4006381333932')).toBe(false);
    expect(validBarcode('')).toBe(false);
    expect(validBarcode('a b')).toBe(false);
    expect(validBarcode('x'.repeat(49))).toBe(false);
    expect(cleanBarcode(' 4006 3813 33931 ')).toBe('4006381333931');
  });
});

describe('codes Nusuh makes', () => {
  it('starts with 2 (for in-house use), has 13 digits and a correct check digit', () => {
    const c = internalEan(1);
    expect(c).toBe('2000000000015');
    expect(badCheckDigit(c)).toBe(false);
    expect(internalEan(12345678901n)).toMatch(/^212345678901\d$/);
    expect(() => internalEan(123456789012n)).toThrow();
  });
});

describe('bars', () => {
  it('draws EAN-13 as 95 modules with guards, left parity from the first digit', () => {
    const m = ean13Modules('4006381333931');
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe('101');
    expect(m.slice(45, 50)).toBe('01010');
    expect(m.slice(-3)).toBe('101');
    // First digit 4 = LGLLGG: second digit 0 in L, third digit 0 in G.
    expect(m.slice(3, 10)).toBe('0001101');
    expect(m.slice(10, 17)).toBe('0100111');
    expect(() => ean13Modules('4006381333932')).toThrow();
  });
  it('draws Code 128 B with the start, check and stop symbols', () => {
    const m = code128Modules('Wikipedia');
    expect(m).toHaveLength((9 + 3) * 11 + 2);
    expect(m.startsWith('11010010000')).toBe(true);    // start B
    expect(m.endsWith('1100011101011')).toBe(true);    // stop
    // The check symbol is (104 + Σ position × value) mod 103, drawn just before the stop.
    const values = [...'Wikipedia'].map((c) => c.charCodeAt(0) - 32);
    const check = (104 + values.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
    expect(m.slice(-24, -13)).toBe(code128Modules(String.fromCharCode(32 + check)).slice(11, 22));
    expect(() => code128Modules('é')).toThrow();
  });
  it('chooses EAN-13 for a valid 13-digit code and Code 128 for anything else', () => {
    expect(barcodeModules('2000000000015').kind).toBe('ean13');
    expect(barcodeModules('RICE-25KG').kind).toBe('code128');
    expect(barcodeModules('4006381333932').kind).toBe('code128');
  });
});
