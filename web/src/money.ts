// Display and parse amounts as exact decimal strings (shared minor-unit maths from src/money.ts).
export { toMinor, fromMinor } from '../../src/money.ts';
import { toMinor, fromMinor } from '../../src/money.ts';

/** "1234567.5" -> "1,234,567.50"; "-3680.00" -> "-3,680.00". Never converts to a float. */
export function fmt(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  let minor: bigint;
  try { minor = toMinor(normalise(amount)); } catch { return amount; }
  const s = fromMinor(minor);
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.') as [string, string];
  return `${neg ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** Accepts "0", "12.5", "1,000.25" and returns a canonical decimal string. */
export function normalise(amount: string): string {
  const s = amount.replace(/,/g, '').trim();
  return /^-?\d+$/.test(s) ? `${s}.00` : s;
}

export function isAmount(s: string): boolean {
  return /^\d{1,16}(\.\d{1,2})?$/.test(s.replace(/,/g, '').trim());
}

export function neg(amount: string): string {
  return fromMinor(-toMinor(normalise(amount)));
}
