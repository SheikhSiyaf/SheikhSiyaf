// Foreign currency rules (src/books/fx.ts): rates, conversion, GCC pegs, provider answers and the month-end restatement (IAS 21).
import { describe, it, expect } from 'vitest';
import * as F from '../src/books/fx.js';

const r = F.parseRate;
describe('Rates and conversion', () => {
  it('rates keep 8 decimals and are above 0', () => {
    expect(r('3.75')).toBe(375_000_000n);
    expect(F.rateText(r('3.75'))).toBe('3.75');
    expect(F.rateText(r('1.02110279'))).toBe('1.02110279');
    expect(F.rateText(r('4'))).toBe('4.00');
    for (const bad of ['0', '-1', '1.123456789', 'abc', '']) expect(() => r(bad)).toThrow();
  });
  it('converts foreign amounts half up to 2 decimals, both signs', () => {
    expect(F.toBase(100_000n, r('3.75'))).toBe(375_000n);           // USD 1,000.00 -> SAR 3,750.00
    expect(F.toBase(1n, r('3.6725'))).toBe(4n);                      // 0.01 * 3.6725 = 0.036725 -> 0.04
    expect(F.toBase(-100_000n, r('3.6725'))).toBe(-367_250n);
    expect(F.toBase(33_333n, r('0.27229408'))).toBe(9_076n);         // 333.33 * 0.27229408 = 90.7637 -> 90.76
  });
  it('inverts a rate', () => { expect(F.invert(r('3.75'))).toBe(r('0.26666667')); });
});

describe('GCC pegs', () => {
  it('give every GCC rate into a pegged currency, through the US dollar', () => {
    const sar = F.pegRates('SAR');
    expect(F.rateText(sar.USD!)).toBe('3.75');
    expect(F.rateText(sar.AED!)).toBe('1.02110279');   // 3.75 / 3.6725
    expect(F.rateText(sar.OMR!)).toBe('9.75292588');   // 3.75 / 0.3845
    expect(F.rateText(F.pegRates('AED').USD!)).toBe('3.6725');
    expect(F.pegRates('EUR')).toEqual({});
  });
});

describe('Rate provider answers', () => {
  it('reads rates against any base and turns them into the company currency', () => {
    const answer = { result: 'success', base_code: 'USD', rates: { USD: 1, SAR: 3.75, AED: 3.6725, EUR: 0.9213, JPY: 151.62, INR: 83.4 } };
    const out = F.ratesFromProvider(answer, 'SAR', ['USD', 'EUR', 'JPY', 'SAR', 'XXX']);
    expect(F.rateText(out.USD!)).toBe('3.75');
    expect(F.rateText(out.EUR!)).toBe('4.0703354');
    expect(F.rateText(out.JPY!)).toBe('0.02473288');
    expect(out.SAR).toBeUndefined();
    expect(out.XXX).toBeUndefined();
    expect(F.rateText(F.ratesFromProvider({ base: 'EUR', rates: { USD: 1.0854, AED: 3.986 } }, 'AED', ['USD', 'EUR']).EUR!)).toBe('3.986');
  });
  it('refuses answers it cannot read', () => {
    expect(() => F.ratesFromProvider({ error: 'quota' }, 'SAR', ['USD'])).toThrow();
    expect(() => F.ratesFromProvider({ base: 'USD', rates: { EUR: 0.9 } }, 'SAR', ['EUR'])).toThrow(/SAR/);
  });
});

describe('Month-end restatement (IAS 21.23)', () => {
  const acct = (code: string, currency: string, fx: bigint, base: bigint): F.FxBalance => ({ accountId: code, code, name: code, currency, fxBalance: fx, baseBalance: base });
  it('restates monetary balances at the closing rate; gains and losses on assets and liabilities', () => {
    const out = F.revalue([
      acct('1020', 'USD', 1_000_000n, 3_740_000n),     // USD 10,000 booked at 3.74 -> 3.75: gain 1,000.00
      acct('2010', 'EUR', -500_000n, -2_000_000n),     // EUR 5,000 owed, booked 4.00 -> 4.07: loss 350.00 (credit)
      acct('1030', 'USD', 0n, 2_500n),                 // settled: 25.00 left -> realised
    ], { USD: r('3.75'), EUR: r('4.07') });
    expect(out.lines.map((l) => [l.code, l.adjustment, l.kind])).toEqual([['1020', 10_000n, 'unrealised'], ['2010', -35_000n, 'unrealised'], ['1030', -2_500n, 'realised']]);
    expect(out.unrealised).toBe(-25_000n);   // net: debit accounts 100.00 + credit 350.00 -> other side 250.00 loss
    expect(out.realised).toBe(-2_500n);
    expect(out.missing).toEqual([]);
  });
  it('a balance already at the closing rate needs nothing; a currency without a rate is reported', () => {
    const out = F.revalue([acct('1020', 'USD', 100_000n, 375_000n), acct('1040', 'JPY', 1_000_000n, 25_000n)], { USD: r('3.75') });
    expect(out.lines[0]!.adjustment).toBe(0n);
    expect(out.missing).toEqual(['JPY']);
  });
});
