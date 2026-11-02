// Money in code is bigint minor units (halalas, fils). Never floats.
// The database stores NUMERIC(18,2); pg returns NUMERIC as a string, which we parse exactly.

export type Minor = bigint;

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function toMinor(amount: string): Minor {
  const m = DECIMAL.exec(amount.trim());
  if (!m) throw new Error(`Not a valid amount with at most 2 decimals: "${amount}"`);
  const [, sign, whole, frac = ''] = m;
  const v = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return sign ? -v : v;
}

export function fromMinor(v: Minor): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Divide and round half away from zero. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('Divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}
