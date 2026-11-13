// Room charges (src/books/rooms.ts), worked by hand. Nightly rates include VAT; the invoice carries the price before
// VAT per night, worked back and rounded to the halala, so a bill can differ from the quoted price by a halala or two.
import { describe, it, expect } from 'vitest';
import * as R from '../src/books/rooms.js';
import { toMinor, fromMinor } from '../src/money.js';

const m = (v: bigint) => fromMinor(v);

describe('Nights', () => {
  it('a stay is counted in nights: arrival day to departure day, the departure day not charged', () => {
    expect(R.nights('2026-11-10', '2026-11-13')).toBe(3);
    expect(R.nights('2026-12-31', '2027-01-02')).toBe(2);
    expect(R.nightDates('2026-11-10', '2026-11-13')).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(R.nights('2026-11-10', '2026-11-10')).toBe(0);
  });
});

describe('Price before VAT from a price with VAT', () => {
  it('at 15%: 575.00 is 500.00 + 75.00 exactly', () => {
    expect(m(R.netFromGross(toMinor('575.00'), '15.00'))).toBe('500.00');
  });
  it('at 15%: 450.00 per night works back to 391.30 (391.304...), rounded to the halala', () => {
    expect(m(R.netFromGross(toMinor('450.00'), '15.00'))).toBe('391.30');
  });
  it('at 5% (UAE) and 0% (not VAT registered)', () => {
    expect(m(R.netFromGross(toMinor('420.00'), '5.00'))).toBe('400.00');
    expect(m(R.netFromGross(toMinor('333.33'), '0.00'))).toBe('333.33');
  });
});

describe('Rate for each night', () => {
  const seasons = [{ from: '2026-12-20', to: '2027-01-05', rate: '900.00' }, { from: '2027-03-01', to: '2027-03-31', rate: '700.00' }];
  it('a season covering the night wins; otherwise the room type rate', () => {
    expect(R.rateForNight('2026-12-19', '600.00', seasons)).toBe('600.00');
    expect(R.rateForNight('2026-12-20', '600.00', seasons)).toBe('900.00');
    expect(R.rateForNight('2027-01-05', '600.00', seasons)).toBe('900.00');
    expect(R.rateForNight('2027-01-06', '600.00', seasons)).toBe('600.00');
  });
  it('a stay across a season start is split into groups of nights at the same rate', () => {
    expect(R.groupNights('2026-12-18', '2026-12-22', '600.00', seasons)).toEqual([
      { from: '2026-12-18', to: '2026-12-19', nights: 2, rate: '600.00' },
      { from: '2026-12-20', to: '2026-12-21', nights: 2, rate: '900.00' },
    ]);
  });
  it('an agreed rate on the booking replaces every other rate', () => {
    expect(R.groupNights('2026-12-18', '2026-12-22', '600.00', seasons, '500.00')).toEqual([{ from: '2026-12-18', to: '2026-12-21', nights: 4, rate: '500.00' }]);
  });
});

describe('Bill line for a group of nights', () => {
  it('575.00 x 3 nights at 15%: 500.00 x 3 = 1,500.00 + VAT 225.00 = 1,725.00, as quoted', () => {
    expect(R.nightsLine(3, '575.00', '15.00')).toEqual({ quantity: 3, unitPrice: '500.00', net: '1500.00', vat: '225.00', total: '1725.00', quoted: '1725.00', difference: '0.00' });
  });
  it('450.00 x 3 nights at 15%: 391.30 x 3 = 1,173.90 + VAT 176.09 = 1,349.99, one halala under the quoted 1,350.00', () => {
    expect(R.nightsLine(3, '450.00', '15.00')).toEqual({ quantity: 3, unitPrice: '391.30', net: '1173.90', vat: '176.09', total: '1349.99', quoted: '1350.00', difference: '-0.01' });
  });
  it('VAT is rounded the same way as invoice lines (half away from zero)', () => {
    // 0.10 + VAT: 0.09 net per night x 1 = 0.09, VAT 0.0135 -> 0.01
    expect(R.nightsLine(1, '0.10', '15.00')).toMatchObject({ unitPrice: '0.09', vat: '0.01', total: '0.10' });
  });
});

describe('Extras', () => {
  it('3 x laundry at 23.00 with VAT (15%): 20.00 x 3 = 60.00 + 9.00 = 69.00', () => {
    expect(R.extraLine('3', '23.00', '15.00')).toMatchObject({ unitPrice: '20.00', net: '60.00', vat: '9.00', total: '69.00', quoted: '69.00', difference: '0.00' });
  });
  it('1.5 x 10.00 with VAT: 8.70 x 1.5 = 13.05 + 1.96 = 15.01, one halala over 15.00', () => {
    expect(R.extraLine('1.5', '10.00', '15.00')).toMatchObject({ unitPrice: '8.70', net: '13.05', vat: '1.96', total: '15.01', quoted: '15.00', difference: '0.01' });
  });
});
