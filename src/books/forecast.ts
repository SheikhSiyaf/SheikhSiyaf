// Cash flow forecast rules: pure functions shared by the API and the demo. Amounts are integer minor units.
// The books provide the flows (src/books/forecastService.ts); this file only places them in periods.

export type Grain = 'week' | 'month';
export type Repeat = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export const IN_CATEGORIES = ['receivables', 'other_in'] as const;
export const OUT_CATEGORIES = ['payables', 'approvals', 'claims', 'recurring', 'payroll', 'social_insurance', 'vat', 'other_out'] as const;
export type Category = (typeof IN_CATEGORIES)[number] | (typeof OUT_CATEGORIES)[number];
export interface Flow {
  date: string; amount: bigint; direction: 'in' | 'out'; category: Category; label: string;
  /** What it comes from, to open it: a document, a recurring expense, a forecast item. */
  ref?: { type: string; id: string };
}
export interface Period { start: string; end: string }
export interface Row extends Period {
  opening: bigint; inflows: Record<string, bigint>; outflows: Record<string, bigint>; totalIn: bigint; totalOut: bigint; net: bigint; closing: bigint; belowMinimum: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parts = (s: string) => s.split('-').map(Number) as [number, number, number];
export const addDays = (s: string, n: number) => { const [y, m, d] = parts(s); return iso(new Date(Date.UTC(y, m - 1, d + n))); };
const monthEndOf = (y: number, m: number) => iso(new Date(Date.UTC(y, m, 0)));
const dayIn = (y: number, m: number, day: number) => { const [ey, em, last] = parts(monthEndOf(y, m)); return iso(new Date(Date.UTC(ey, em - 1, Math.min(day, last)))); };

/** Weeks: seven-day blocks starting today. Months: the rest of this month, then whole months. */
export function periods(today: string, grain: Grain, count: number): Period[] {
  const out: Period[] = [];
  if (grain === 'week') {
    for (let i = 0; i < count; i++) out.push({ start: addDays(today, i * 7), end: addDays(today, i * 7 + 6) });
    return out;
  }
  const [y, m] = parts(today);
  for (let i = 0; i < count; i++) out.push({ start: i === 0 ? today : `${monthEndOf(y, m + i).slice(0, 8)}01`, end: monthEndOf(y, m + i) });
  return out;
}

/** The dates a repeating item falls on between from and to (inclusive), up to its end date. */
export function repeatDates(first: string, repeat: Repeat, from: string, to: string, end: string | null): string[] {
  const last = end && end < to ? end : to;
  if (repeat === 'none') return first >= from && first <= last ? [first] : [];
  const out: string[] = [];
  if (repeat === 'weekly') {
    for (let d = first, i = 0; d <= last && i < 1000; d = addDays(d, 7), i++) if (d >= from) out.push(d);
    return out;
  }
  const step = repeat === 'monthly' ? 1 : repeat === 'quarterly' ? 3 : 12;
  const [y, m, day] = parts(first);
  for (let i = 0; i < 1000; i++) {
    const d = dayIn(y, m + i * step, day);
    if (d > last) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** "Customers pay N days late": what customers owe moves later (counted from today when already overdue). */
export function delayReceivables(flows: Flow[], days: number, today: string): Flow[] {
  if (!days) return flows;
  return flows.map((f) => (f.category === 'receivables' ? { ...f, date: addDays(f.date < today ? today : f.date, days) } : f));
}

export interface Result {
  rows: Row[];
  /** Every flow with the period it falls in (null: after the last period); overdue ones are in the first. */
  flows: (Flow & { period: number | null; overdue: boolean })[];
  lowest: { amount: bigint; period: number };
}
export function forecast(opening: bigint, flows: Flow[], ps: Period[], o: { minimumCash: bigint }): Result {
  const zero = (cats: readonly string[]) => Object.fromEntries(cats.map((c) => [c, 0n])) as Record<string, bigint>;
  const rows: Row[] = ps.map((p) => ({ ...p, opening: 0n, inflows: zero(IN_CATEGORIES), outflows: zero(OUT_CATEGORIES), totalIn: 0n, totalOut: 0n, net: 0n, closing: 0n, belowMinimum: false }));
  const placed = flows.map((f) => {
    const overdue = f.date < ps[0]!.start;
    const i = overdue ? 0 : ps.findIndex((p) => f.date >= p.start && f.date <= p.end);
    return { ...f, period: i < 0 ? null : i, overdue };
  }).sort((a, b) => a.date.localeCompare(b.date));
  for (const f of placed) {
    if (f.period === null) continue;
    const r = rows[f.period]!;
    if (f.direction === 'in') { r.inflows[f.category] = (r.inflows[f.category] ?? 0n) + f.amount; r.totalIn += f.amount; }
    else { r.outflows[f.category] = (r.outflows[f.category] ?? 0n) + f.amount; r.totalOut += f.amount; }
  }
  let cash = opening;
  let lowest = { amount: opening, period: 0 };
  rows.forEach((r, i) => {
    r.opening = cash; r.net = r.totalIn - r.totalOut; r.closing = cash + r.net; cash = r.closing;
    r.belowMinimum = r.closing < o.minimumCash;
    if (i === 0 || r.closing < lowest.amount) lowest = { amount: r.closing, period: i };
  });
  return { rows, flows: placed, lowest };
}
