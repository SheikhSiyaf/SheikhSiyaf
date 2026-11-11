// Rental charges (src/books/rentals.ts), worked by hand: exact amounts, rounded once.
import { describe, it, expect } from 'vitest';
import * as R from '../src/books/rentals.js';
import { toMinor, fromMinor } from '../src/money.js';

const m = (v: bigint) => fromMinor(v);

describe('Rental charge', () => {
  it('by the day: days x rate x units, counting the first and last day', () => {
    expect(R.daysInclusive('2026-11-01', '2026-11-10')).toBe(10);
    expect(m(R.rentalAmount('day', toMinor('1500.00'), 1, { days: 10, hoursHundredths: 0 }))).toBe('15000.00');
    expect(m(R.rentalAmount('day', toMinor('2.50'), 400, { days: 3, hoursHundredths: 0 }))).toBe('3000.00');   // 400 scaffolding frames
  });
  it('by the hour: the hours recorded x rate', () => {
    expect(m(R.rentalAmount('hour', toMinor('350.00'), 1, { days: 5, hoursHundredths: 4250 }))).toBe('14875.00');   // 42.5 hours
  });
  it('by the week: rate x days / 7, exact, rounded once', () => {
    expect(m(R.rentalAmount('week', toMinor('7000.00'), 1, { days: 10, hoursHundredths: 0 }))).toBe('10000.00');
    expect(m(R.rentalAmount('week', toMinor('1000.00'), 1, { days: 3, hoursHundredths: 0 }))).toBe('428.57');      // 3000 / 7 = 428.571
  });
  it('by the month: rate x days / 30', () => {
    expect(m(R.rentalAmount('month', toMinor('45000.00'), 1, { days: 30, hoursHundredths: 0 }))).toBe('45000.00');
    expect(m(R.rentalAmount('month', toMinor('45000.00'), 2, { days: 31, hoursHundredths: 0 }))).toBe('93000.00');
    expect(m(R.rentalAmount('month', toMinor('10000.00'), 1, { days: 1, hoursHundredths: 0 }))).toBe('333.33');
  });
});

describe('What to bill', () => {
  it('from the day out (or after the last billed day) to the bill date or the return date, whichever is first', () => {
    expect(R.billRange({ outDate: '2026-11-03', returnDate: null }, null, '2026-11-30')).toEqual({ from: '2026-11-03', to: '2026-11-30' });
    expect(R.billRange({ outDate: '2026-11-03', returnDate: '2026-11-20' }, null, '2026-11-30')).toEqual({ from: '2026-11-03', to: '2026-11-20' });
    expect(R.billRange({ outDate: '2026-11-03', returnDate: null }, '2026-11-30', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('nothing when the item has not gone out yet, or everything is already billed', () => {
    expect(R.billRange({ outDate: '2026-12-05', returnDate: null }, null, '2026-11-30')).toBeNull();
    expect(R.billRange({ outDate: '2026-11-03', returnDate: '2026-11-20' }, '2026-11-20', '2026-11-30')).toBeNull();
  });
  it('the state of a line on a day: booked, on hire or returned', () => {
    expect(R.lineState({ outDate: '2026-12-05', returnDate: null }, '2026-11-30')).toBe('booked');
    expect(R.lineState({ outDate: '2026-11-05', returnDate: null }, '2026-11-30')).toBe('on_hire');
    expect(R.lineState({ outDate: '2026-11-05', returnDate: '2026-11-30' }, '2026-11-30')).toBe('on_hire');
    expect(R.lineState({ outDate: '2026-11-05', returnDate: '2026-11-20' }, '2026-11-30')).toBe('returned');
  });
});
