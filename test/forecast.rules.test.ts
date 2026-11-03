// Cash flow forecast rules (src/books/forecast.ts): periods, repeating items, buckets, late payment, the lowest point.
import { describe, it, expect } from 'vitest';
import * as F from '../src/books/forecast.js';
import { toMinor } from '../src/money.js';

const flow = (date: string, amount: string, direction: 'in' | 'out', category: F.Category, label = 'x'): F.Flow =>
  ({ date, amount: toMinor(amount), direction, category, label });

describe('Periods', () => {
  it('weeks are seven-day blocks from today; months are calendar months starting with the current one', () => {
    expect(F.periods('2026-11-03', 'week', 3)).toEqual([{ start: '2026-11-03', end: '2026-11-09' }, { start: '2026-11-10', end: '2026-11-16' }, { start: '2026-11-17', end: '2026-11-23' }]);
    expect(F.periods('2026-11-03', 'month', 3)).toEqual([{ start: '2026-11-03', end: '2026-11-30' }, { start: '2026-12-01', end: '2026-12-31' }, { start: '2027-01-01', end: '2027-01-31' }]);
  });
  it('repeating dates keep their day of the month (or the month end) and stop at the end date', () => {
    expect(F.repeatDates('2026-01-31', 'monthly', '2026-02-01', '2026-04-30', null)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect(F.repeatDates('2026-11-05', 'weekly', '2026-11-01', '2026-11-30', '2026-11-20')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
    expect(F.repeatDates('2026-12-01', 'none', '2026-11-01', '2026-12-31', null)).toEqual(['2026-12-01']);
    expect(F.repeatDates('2025-06-15', 'yearly', '2026-01-01', '2026-12-31', null)).toEqual(['2026-06-15']);
  });
});

describe('The forecast', () => {
  const ps = F.periods('2026-11-03', 'week', 4);
  it('opening, money in and out by kind, closing; what is overdue lands in the first period', () => {
    const r = F.forecast(100000n, [
      flow('2026-10-20', '500.00', 'in', 'receivables'),     // overdue: this week
      flow('2026-11-12', '1200.00', 'in', 'receivables'),
      flow('2026-11-04', '300.00', 'out', 'payables'),
      flow('2026-12-02', '900.00', 'out', 'payroll'),        // after the last period (ends 30 Nov): left out
    ], ps, { minimumCash: 0n });
    expect(r.rows.map((x) => [x.opening, x.totalIn, x.totalOut, x.closing])).toEqual([
      [100000n, 50000n, 30000n, 120000n], [120000n, 120000n, 0n, 240000n], [240000n, 0n, 0n, 240000n], [240000n, 0n, 0n, 240000n]]);
    expect(r.rows[0]!.inflows.receivables).toBe(50000n);
    expect(r.rows[0]!.outflows.payables).toBe(30000n);
    expect(r.flows.filter((f) => f.period === null).map((f) => f.category)).toEqual(['payroll']);
    expect(r.flows.find((f) => f.amount === 50000n)!.overdue).toBe(true);
  });

  it('flags the periods below the minimum cash and finds the lowest point', () => {
    const r = F.forecast(50000n, [flow('2026-11-11', '800.00', 'out', 'vat'), flow('2026-11-18', '1000.00', 'in', 'other_in')], ps, { minimumCash: 10000n });
    expect(r.rows.map((x) => x.belowMinimum)).toEqual([false, true, false, false]);
    expect(r.lowest).toEqual({ amount: -30000n, period: 1 });
    expect(r.rows[1]!.closing).toBe(-30000n);
  });

  it('customers paying later moves only what customers owe', () => {
    const flows = [flow('2026-11-04', '100.00', 'in', 'receivables'), flow('2026-11-04', '100.00', 'out', 'payables'), flow('2026-11-04', '100.00', 'in', 'other_in')];
    const late = F.delayReceivables(flows, 14, '2026-11-03');
    expect(late.map((f) => f.date)).toEqual(['2026-11-18', '2026-11-04', '2026-11-04']);
    // Overdue invoices are counted from today when they move.
    expect(F.delayReceivables([flow('2026-10-01', '1.00', 'in', 'receivables')], 7, '2026-11-03')[0]!.date).toBe('2026-11-10');
  });
});
