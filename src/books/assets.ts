// Fixed assets: monthly straight-line depreciation and disposal. Pure functions shared by the API and
// the demo build. The database computes the same amounts (depreciation_due in db/migrations/0012).
import { divRoundHalfUp, type Minor } from '../money.js';

export interface AssetTerms { cost: Minor; residual: Minor; lifeMonths: number; start: string; opening: Minor; disposedOn?: string | null }

/** Last day of the month of a date (YYYY-MM-DD). */
export function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
/** First day of the month of a date. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
/** The month end after the given month end. */
export const nextMonthEnd = (end: string) => monthEnd(new Date(Date.UTC(+end.slice(0, 4), +end.slice(5, 7), 1)).toISOString().slice(0, 10));
/** The month end before the month of a date. */
export const previousMonthEnd = (date: string) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);

/** Months of life used by the end of the given month (1 = the start month). */
export const monthsUsed = (start: string, periodEnd: string) =>
  (+periodEnd.slice(0, 4) * 12 + +periodEnd.slice(5, 7)) - (+start.slice(0, 4) * 12 + +start.slice(5, 7)) + 1;

/** Depreciation the asset should have by the end of the month: (cost - residual) x months used / life; all of it at end of life. */
export function targetDepreciation(a: AssetTerms, periodEnd: string): Minor {
  const n = monthsUsed(a.start, periodEnd);
  if (n <= 0) return 0n;
  const depreciable = a.cost - a.residual;
  return n >= a.lifeMonths ? depreciable : divRoundHalfUp(depreciable * BigInt(n), BigInt(a.lifeMonths));
}

/** What to book for the month, given what earlier runs booked. Never negative; catches up missed months. */
export function depreciationDue(a: AssetTerms, periodEnd: string, bookedBefore: Minor): Minor {
  if (a.disposedOn && a.disposedOn <= periodEnd) return 0n;
  const due = targetDepreciation(a, periodEnd) - a.opening - bookedBefore;
  return due > 0n ? due : 0n;
}

/** Gain (positive) or loss (negative) on disposal: proceeds - (cost - accumulated depreciation). */
export const disposalResult = (cost: Minor, accumulated: Minor, proceeds: Minor): Minor => proceeds - (cost - accumulated);
