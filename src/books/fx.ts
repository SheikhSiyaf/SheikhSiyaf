// Foreign currency (IAS 21), pure functions shared by the server and the demo.
//
// * A rate is the value of 1 unit of the foreign currency in the company's currency (1 USD = 3.75 SAR), kept with
//   8 decimals as an integer scaled by 10^8. Amounts are minor units (bigint); conversion rounds half up to 2 decimals.
// * Transactions are recorded at the spot rate of their date (IAS 21.21). At each month end the foreign currency
//   monetary items are restated at the closing rate (IAS 21.23(a)); the difference goes to profit or loss (IAS 21.28).
//   An account whose foreign balance has come back to nil has its remaining difference shown as realised
//   (the exchange difference on settlement); the others as unrealised.
// * GCC currencies are pegged to the US dollar by their central banks, so their rates to each other and to USD are
//   always known, even when the rate provider cannot be reached.
import { divRoundHalfUp } from '../money.js';

export const RATE_SCALE = 100_000_000n;   // 8 decimals

/** "3.75" -> 375000000n. Up to 8 decimals, above 0. */
export function parseRate(v: string | number): bigint {
  const s = String(v).trim();
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error('A rate is a number above 0 with at most 8 decimals.');
  const r = BigInt(m[1]!) * RATE_SCALE + BigInt((m[2] ?? '').padEnd(8, '0'));
  if (r <= 0n) throw new Error('A rate is a number above 0 with at most 8 decimals.');
  return r;
}

/** 375000000n -> "3.75" (trailing zeros dropped, at least 2 decimals). */
export function rateText(r: bigint): string {
  const w = r / RATE_SCALE, f = (r % RATE_SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return `${w}.${f.padEnd(2, '0')}`;
}

/** Foreign minor units at a rate -> company currency minor units, rounded half up. */
export const toBase = (fxMinor: bigint, rate: bigint): bigint => (fxMinor < 0n ? -divRoundHalfUp(-fxMinor * rate, RATE_SCALE) : divRoundHalfUp(fxMinor * rate, RATE_SCALE));

/** 1 / rate, to 8 decimals. */
export const invert = (rate: bigint): bigint => divRoundHalfUp(RATE_SCALE * RATE_SCALE, rate);

/** Units of each GCC currency for 1 US dollar (central bank pegs). */
export const USD_PEGS: Record<string, string> = { USD: '1', SAR: '3.75', AED: '3.6725', OMR: '0.3845', BHD: '0.376', QAR: '3.64' };

/** Rates into `base` from the pegs (only when `base` is pegged): e.g. base SAR -> USD 3.75, AED 1.02110279, ... */
export function pegRates(base: string): Record<string, bigint> {
  if (!USD_PEGS[base]) return {};
  const perUsd = (c: string) => parseRate(USD_PEGS[c]!);
  const out: Record<string, bigint> = {};
  for (const c of Object.keys(USD_PEGS)) if (c !== base) out[c] = divRoundHalfUp(perUsd(base) * RATE_SCALE, perUsd(c));
  return out;
}

/** A provider number (JSON number or text, maybe in exponent form) -> scaled by 10^12. */
function big12(v: unknown): bigint | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const [w, f = ''] = n.toFixed(12).split('.');
  return BigInt(w!) * 1_000_000_000_000n + BigInt(f.padEnd(12, '0'));
}

/**
 * Reads a rate provider's answer: `{ "base" | "base_code": "USD", "rates": { "SAR": 3.75, ... } }`, where each rate is the
 * units of that currency for 1 base. Returns the rates into `base` for the currencies wanted (1 unit = ? base).
 */
export function ratesFromProvider(json: unknown, base: string, wanted: string[]): Record<string, bigint> {
  const j = json as { base?: string; base_code?: string; rates?: Record<string, unknown> } | null;
  const from = String(j?.base ?? j?.base_code ?? '').toUpperCase();
  const rates = j?.rates;
  if (!from || !rates || typeof rates !== 'object') throw new Error('The rate provider answered in a form we do not read.');
  const per = (c: string) => (c === from ? 1_000_000_000_000n : big12(rates[c]));
  const b = per(base);
  if (!b) throw new Error(`The rate provider has no rate for ${base}.`);
  const out: Record<string, bigint> = {};
  for (const c of wanted) {
    if (c === base) continue;
    const x = per(c);
    if (x) out[c] = divRoundHalfUp(b * RATE_SCALE, x);
  }
  return out;
}

export interface FxBalance { accountId: string; code: string; name: string; currency: string; fxBalance: bigint; baseBalance: bigint }
export interface FxAdjustment extends FxBalance { rate: bigint | null; target: bigint | null; adjustment: bigint; kind: 'unrealised' | 'realised' }

/**
 * Month-end restatement. For each foreign account: value at the closing rate - value in the books.
 * A positive adjustment is a debit on the account; the gains and losses account takes the other side.
 * Accounts without a rate are returned with a null rate and no adjustment (the screen stops the posting).
 */
export function revalue(balances: FxBalance[], rates: Record<string, bigint | undefined>): { lines: FxAdjustment[]; unrealised: bigint; realised: bigint; missing: string[] } {
  const lines: FxAdjustment[] = [];
  const missing = new Set<string>();
  let unrealised = 0n, realised = 0n;
  for (const b of balances) {
    const rate = rates[b.currency] ?? null;
    if (b.fxBalance === 0n) {
      // Settled: what is left in the company currency is the exchange difference on settlement.
      const adjustment = -b.baseBalance;
      if (adjustment !== 0n) { lines.push({ ...b, rate, target: 0n, adjustment, kind: 'realised' }); realised += adjustment; }
      continue;
    }
    if (rate === null) { missing.add(b.currency); lines.push({ ...b, rate, target: null, adjustment: 0n, kind: 'unrealised' }); continue; }
    const target = toBase(b.fxBalance, rate);
    const adjustment = target - b.baseBalance;
    lines.push({ ...b, rate, target, adjustment, kind: 'unrealised' });
    unrealised += adjustment;
  }
  return { lines, unrealised, realised, missing: [...missing] };
}

/** Currencies offered for accounts and rates (ISO 4217), with Arabic names. */
export const CURRENCIES: { code: string; en: string; ar: string }[] = [
  { code: 'USD', en: 'US dollar', ar: 'دولار أمريكي' }, { code: 'EUR', en: 'Euro', ar: 'يورو' }, { code: 'GBP', en: 'Pound sterling', ar: 'جنيه إسترليني' },
  { code: 'SAR', en: 'Saudi riyal', ar: 'ريال سعودي' }, { code: 'AED', en: 'UAE dirham', ar: 'درهم إماراتي' }, { code: 'OMR', en: 'Omani rial', ar: 'ريال عماني' },
  { code: 'KWD', en: 'Kuwaiti dinar', ar: 'دينار كويتي' }, { code: 'BHD', en: 'Bahraini dinar', ar: 'دينار بحريني' }, { code: 'QAR', en: 'Qatari riyal', ar: 'ريال قطري' },
  { code: 'EGP', en: 'Egyptian pound', ar: 'جنيه مصري' }, { code: 'JOD', en: 'Jordanian dinar', ar: 'دينار أردني' }, { code: 'INR', en: 'Indian rupee', ar: 'روبية هندية' },
  { code: 'PKR', en: 'Pakistani rupee', ar: 'روبية باكستانية' }, { code: 'PHP', en: 'Philippine peso', ar: 'بيزو فلبيني' }, { code: 'BDT', en: 'Bangladeshi taka', ar: 'تاكا بنغلاديشية' },
  { code: 'LKR', en: 'Sri Lankan rupee', ar: 'روبية سريلانكية' }, { code: 'CNY', en: 'Chinese yuan', ar: 'يوان صيني' }, { code: 'JPY', en: 'Japanese yen', ar: 'ين ياباني' },
  { code: 'CHF', en: 'Swiss franc', ar: 'فرنك سويسري' }, { code: 'TRY', en: 'Turkish lira', ar: 'ليرة تركية' },
];
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && CURRENCIES.some((x) => x.code === c);
