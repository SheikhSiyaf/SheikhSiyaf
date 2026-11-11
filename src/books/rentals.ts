// Rental charges, as pure functions shared by the API and the demo build (db/migrations/0041). Money is in minor
// units (bigint); hours are in hundredths. Days count both the first and the last day.
import { divRoundHalfUp, type Minor } from '../money.js';

export type Basis = 'hour' | 'day' | 'week' | 'month';
export const BASES: Basis[] = ['hour', 'day', 'week', 'month'];
const dayNo = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const iso = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(dayNo(d) + n);
/** Days from a to b, both counted (the same day = 1). */
export const daysInclusive = (a: string, b: string) => dayNo(b) - dayNo(a) + 1;

/**
 * The charge for a period, exact and rounded once:
 * by the day = rate x days x units; by the hour = rate x hours x units; by the week = rate x days x units / 7;
 * by the month = rate x days x units / 30 (a month counts as 30 days).
 */
export function rentalAmount(basis: Basis, rate: Minor, units: number, q: { days: number; hoursHundredths: number }): Minor {
  const u = BigInt(units);
  switch (basis) {
    case 'day': return rate * BigInt(q.days) * u;
    case 'hour': return divRoundHalfUp(rate * BigInt(q.hoursHundredths) * u, 100n);
    case 'week': return divRoundHalfUp(rate * BigInt(q.days) * u, 7n);
    case 'month': return divRoundHalfUp(rate * BigInt(q.days) * u, 30n);
  }
}

export interface LineDates { outDate: string; returnDate: string | null }
/** What is left to bill on a line up to a day: from the day out (or after the last billed day) to that day or the
 *  return date, whichever comes first. Null when nothing is due. */
export function billRange(l: LineDates, billedTo: string | null, upTo: string): { from: string; to: string } | null {
  const from = billedTo && billedTo >= l.outDate ? addDays(billedTo, 1) : l.outDate;
  const to = l.returnDate && l.returnDate < upTo ? l.returnDate : upTo;
  return from <= to ? { from, to } : null;
}

/** Booked (not out yet), on hire, or returned, on a day. */
export const lineState = (l: LineDates, day: string): 'booked' | 'on_hire' | 'returned' =>
  day < l.outDate ? 'booked' : l.returnDate && l.returnDate < day ? 'returned' : 'on_hire';
