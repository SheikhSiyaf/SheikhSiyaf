// Ownership rules as pure functions (no database). Percentages and share counts are whole numbers in units of
// 1/10,000 (four decimals), so 100% is 1,000,000 and nothing is ever a float. Amounts are minor units (bigint).

export const PERCENT_TOTAL = 1_000_000n;
const UNITS = /^(\d+)(?:\.(\d{1,4}))?$/;

/** A non-negative number with at most four decimals, in units of 1/10,000. */
export function parseUnits(v: unknown): bigint {
  const s = String(v ?? '').replace(/,/g, '').trim();
  const m = UNITS.exec(s);
  if (!m) throw new Error('Enter a number with at most 4 decimals.');
  return BigInt(m[1]!) * 10_000n + BigInt((m[2] ?? '').padEnd(4, '0'));
}
export const fmtUnits = (u: bigint): string => `${u / 10_000n}.${(u % 10_000n).toString().padStart(4, '0')}`;

/** A percentage from 0 to 100 with at most four decimals. */
export function parsePercent(v: unknown): bigint {
  const u = parseUnits(v);
  if (u > PERCENT_TOTAL) throw new Error('A percentage cannot be more than 100.');
  return u;
}
export const fmtPercent = fmtUnits;

/** Shares an amount by percentages that total exactly 100. The parts always add back to the amount: what rounding
 *  leaves over goes one halala at a time to the biggest remainders, the earlier owner first on a tie. */
export function splitByPercent(amount: bigint, percents: readonly bigint[]): bigint[] {
  if (amount < 0n) throw new Error('The amount to share cannot be negative.');
  if (!percents.length || percents.reduce((a, b) => a + b, 0n) !== PERCENT_TOTAL) throw new Error('The percentages must total exactly 100.');
  const parts = percents.map((p) => (amount * p) / PERCENT_TOTAL);
  let left = amount - parts.reduce((a, b) => a + b, 0n);
  const order = percents.map((p, i) => ({ i, r: (amount * p) % PERCENT_TOTAL })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of order) { if (left <= 0n) break; parts[i]! += 1n; left -= 1n; }
  return parts;
}

/** Percentages that follow from share counts, totalling exactly 100. */
export function percentsFromShares(shares: readonly bigint[]): bigint[] {
  const total = shares.reduce((a, b) => a + b, 0n);
  if (!shares.length || total <= 0n) throw new Error('Enter the number of shares for at least one owner.');
  return shareOut(shares, total);
}
function shareOut(shares: readonly bigint[], total: bigint): bigint[] {
  const parts = shares.map((s) => (s * PERCENT_TOTAL) / total);
  let left = PERCENT_TOTAL - parts.reduce((a, b) => a + b, 0n);
  const order = shares.map((s, i) => ({ i, r: (s * PERCENT_TOTAL) % total })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of order) { if (left <= 0n) break; parts[i]! += 1n; left -= 1n; }
  return parts;
}

export type OwnershipKind = 'sole' | 'partnership' | 'shares';
/** How owners are recorded for a company's legal form (the form is free text on the company). */
export function ownershipKind(legalForm: string): OwnershipKind {
  if (legalForm === 'Sole establishment') return 'sole';
  if (legalForm === 'Partnership') return 'partnership';
  return 'shares';
}
