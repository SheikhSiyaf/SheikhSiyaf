// Sales and purchase documents: line maths, totals and the journal entry each one posts.
// Pure functions shared by the API (src/books/documentsService.ts) and the demo build.
// The database re-checks the same maths (db/migrations/0005_sales_purchases.sql).
import { divRoundHalfUp, fromMinor, toMinor, type Minor } from '../money.js';
import { rateToBasisPoints, vatForLine } from '../vat/vat.js';

export type DocType = 'quotation' | 'invoice' | 'credit_note' | 'debit_note' | 'bill' | 'supplier_credit' | 'expense' | 'claim' | 'purchase_order';
export type VatCode = 'standard' | 'zero' | 'exempt' | 'out_of_scope';
export type Direction = 'received' | 'made';

export const DOC_TYPES: DocType[] = ['quotation', 'invoice', 'credit_note', 'debit_note', 'bill', 'supplier_credit', 'expense', 'claim', 'purchase_order'];
export const VAT_CODES: VatCode[] = ['standard', 'zero', 'exempt', 'out_of_scope'];
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;

export const sideOf = (t: DocType): 'sales' | 'purchases' => (t === 'quotation' || t === 'invoice' || t === 'credit_note' || t === 'debit_note' ? 'sales' : 'purchases');
export const isCredit = (t: DocType) => t === 'credit_note' || t === 'supplier_credit';
export const posts = (t: DocType) => t !== 'quotation' && t !== 'purchase_order';

/** Number prefixes; invoices use the client's own invoice prefix. */
export function numberPrefix(type: DocType | 'receipt' | 'payment', invoicePrefix: string): string {
  return { invoice: invoicePrefix, quotation: 'QT-', credit_note: 'CN-', debit_note: 'DN-', purchase_order: 'PO-', bill: 'BILL-', supplier_credit: 'SC-', expense: 'EXP-', claim: 'CLM-', receipt: 'RCPT-', payment: 'PAY-' }[type];
}
export const formatNumber = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, '0')}`;

/** "2", "1.5", "0.125" -> thousandths. Quantity must be > 0 with at most 3 decimals. */
export function quantityToMilli(q: string): bigint {
  const m = /^(\d{1,10})(?:\.(\d{1,3}))?$/.exec(String(q).trim());
  if (!m) throw new Error('quantity');
  const v = BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
  if (v <= 0n) throw new Error('quantity');
  return v;
}
export const milliToString = (v: bigint) => `${v / 1000n}.${(v % 1000n).toString().padStart(3, '0')}`;

export interface LineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  costCentreId?: string | null;
  vatCode: VatCode;
}

export interface PricedLine extends LineInput {
  quantity: string;        // canonical, 3 decimals
  unitPrice: string;       // canonical, 2 decimals
  vatRate: string;
  net: Minor;
  vat: Minor;
}

// ------------------------------------------------------------------ another currency (0058)
const RATE_SCALE = 100000000n;   // rates carry 8 decimals, as exchange_rates.rate does

/** "3.75" -> the rate in eight-decimal units. One unit of the foreign currency is worth this much of the company's. */
export function rateToScaled(rate: string): bigint {
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(String(rate).trim());
  if (!m) throw new Error('rate');
  const v = BigInt(m[1]!) * RATE_SCALE + BigInt((m[2] ?? '').padEnd(8, '0'));
  if (v <= 0n) throw new Error('rate');
  return v;
}
export const rateToString = (v: bigint) => `${v / RATE_SCALE}.${(v % RATE_SCALE).toString().padStart(8, '0')}`;

/** An amount in the document's currency, in the company's currency. Rounded half away from zero, like all money. */
export const convertMinor = (amount: Minor, rateScaled: bigint): Minor => divRoundHalfUp(amount * rateScaled, RATE_SCALE);

/**
 * The same line, priced in the company's currency.
 * The rate is applied to the UNIT PRICE and the line amounts then follow the ordinary arithmetic (net = quantity x
 * price, VAT = net x rate). So a converted line satisfies exactly the same checks as any company-currency line, and
 * the document's totals still add up on their own: that is what stops a trial balance drifting (0058).
 */
export function convertLine(l: PricedLine, rateScaled: bigint, companyVatRate: string): PricedLine {
  return priceLine({ ...l, unitPrice: fromMinor(convertMinor(toMinor(l.unitPrice), rateScaled)) }, companyVatRate);
}

/** A currency a document can be written in: three capital letters, and not the company's own. */
export function foreignCurrency(given: string | null | undefined, companyCurrency: string): string | null {
  const c = String(given ?? '').trim().toUpperCase();
  if (!c || c === companyCurrency) return null;
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('currency');
  return c;
}

/** Net = quantity x price, VAT = net x rate; each rounded half away from zero to 2 decimals. */
export function priceLine(l: LineInput, companyVatRate: string): PricedLine {
  const qty = quantityToMilli(l.quantity);
  const price = toMinor(String(l.unitPrice).trim() || '0');
  if (price < 0n) throw new Error('price');
  const net = divRoundHalfUp(qty * price, 1000n);
  const vatRate = l.vatCode === 'standard' ? companyVatRate : '0.00';
  return { ...l, quantity: milliToString(qty), unitPrice: fromMinor(price), vatRate, net, vat: vatForLine(net, vatRate) };
}

/**
 * VAT the way ZATCA requires it on a document with more than one line.
 *
 * Their XML Implementation Standard v1.2, section 10 "Rounding": "Rounding shall be done on the final calculation
 * results not on any intermediate results" and "VAT category tax amount shall be rounded on document level and not
 * as a summation of rounded Invoice line VAT amounts." Rounding each line and adding up is the thing that forbids,
 * and it also breaks their arithmetic rule BR-CO-17, which wants the VAT shown for a category to equal that
 * category's taxable amount times its rate, rounded once.
 *
 * So each VAT category's total is worked out from the category's own net total, then handed back to its lines: the
 * whole halalas first, and the ones left over to the lines with the largest part left over, line order breaking a
 * tie. The lines therefore still add up to the category, which is what every report, the ledger entry and
 * check_document_complete rely on, and no line ends up more than a halala from its own share.
 */
export function roundVatByCategory(lines: PricedLine[]): PricedLine[] {
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const key = `${l.vatCode}|${l.vatRate}`;
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });
  const out = lines.map((l) => ({ ...l }));
  for (const idx of groups.values()) {
    const rate = rateToBasisPoints(lines[idx[0]!]!.vatRate);
    if (rate === 0n) { for (const i of idx) out[i]!.vat = 0n; continue; }
    const category = divRoundHalfUp(idx.reduce((t, i) => t + lines[i]!.net, 0n) * rate, 10_000n);
    // Each line's exact share is net x rate / 10000. Give out the whole halalas first.
    const share = idx.map((i) => lines[i]!.net * rate);
    const whole = share.map((v) => v / 10_000n);
    let left = category - whole.reduce((a, b) => a + b, 0n);
    // Rounding the sum can never give less than the sum of the parts rounded down, so `left` is never negative,
    // and it is below the number of lines, so every halala finds a line.
    const byRemainder = idx.map((_, j) => j).sort((a, b) => {
      const ra = share[a]! % 10_000n, rb = share[b]! % 10_000n;
      return ra === rb ? a - b : rb > ra ? 1 : -1;
    });
    const extra = idx.map(() => 0n);
    for (const j of byRemainder) { if (left <= 0n) break; extra[j] = 1n; left -= 1n; }
    idx.forEach((i, j) => { out[i]!.vat = whole[j]! + extra[j]!; });
  }
  return out;
}

export function documentTotals(lines: { net: Minor; vat: Minor }[]) {
  const net = lines.reduce((s, l) => s + l.net, 0n);
  const vat = lines.reduce((s, l) => s + l.vat, 0n);
  return { net, vat, gross: net + vat };
}

export interface SystemAccounts { receivables: string; payables: string; outputVat: string; inputVat: string; claimsPayable?: string; fxGainLoss?: string }
export interface PostingLine { accountId: string; costCentreId?: string | null; debit?: string; credit?: string }

/**
 * The journal entry a document posts.
 *   Invoice:          Dr receivables (gross)  Cr income lines (net)  Cr output VAT
 *   Credit note:      the invoice entry, reversed
 *   Bill:             Dr expense lines (net)  Dr input VAT  Cr payables (gross)
 *   Supplier credit:  the bill entry, reversed
 *   Expense:          Dr expense lines (net)  Dr input VAT  Cr the bank or cash account it was paid from (gross)
 *   Claim (approved): Dr expense lines (net)  Dr input VAT  Cr employee claims payable (gross)
 */
export function postingFor(type: DocType, lines: PricedLine[], sys: SystemAccounts, paidFromAccountId?: string): PostingLine[] {
  if (!posts(type)) return [];
  const { vat, gross } = documentTotals(lines);
  const sales = sideOf(type) === 'sales';
  // "normal" = invoice or bill direction; credits swap debit and credit.
  const flip = isCredit(type);
  const side = (amount: Minor, normallyDebit: boolean) => {
    const debit = normallyDebit !== flip;
    return debit ? { debit: fromMinor(amount) } : { credit: fromMinor(amount) };
  };
  const out: PostingLine[] = [];
  if (type === 'expense' && !paidFromAccountId) throw new Error('paid from');
  if (type === 'claim' && !sys.claimsPayable) throw new Error('claims payable');
  out.push({ accountId: sales ? sys.receivables : type === 'expense' ? paidFromAccountId! : type === 'claim' ? sys.claimsPayable! : sys.payables, ...side(gross, sales) });
  for (const l of lines) if (l.net > 0n) out.push({ accountId: l.accountId, costCentreId: l.costCentreId ?? null, ...side(l.net, !sales) });
  if (vat > 0n) out.push({ accountId: sales ? sys.outputVat : sys.inputVat, ...side(vat, !sales) });
  return out;
}

/**
 * The journal entry a payment posts: received Dr bank / Cr receivables; made Dr payables / Cr bank.
 * Reimbursing an employee (toEmployee) clears employee claims payable instead of payables.
 */
/** The journal for a payment. The LEDGER SIDE picks the control account, not the direction the cash moves: a refund
 *  paid out to a customer still clears receivables (money we were holding for them), never payables. The bank is
 *  debited when money comes in and credited when it goes out, whichever side it belongs to. */
/** A payment in another currency (0058): `settled` is what the control account gives up, in the company's currency,
 *  valued at the rate each DOCUMENT was booked at. The bank still gets what actually arrived or left, and the gap
 *  between the two is the realised exchange gain or loss. */
export function postingForPayment(direction: Direction, amount: Minor, bankAccountId: string, sys: SystemAccounts,
  toEmployee = false, side: 'sales' | 'purchases' = direction === 'received' ? 'sales' : 'purchases',
  fx?: { settled: Minor; accountId: string }): PostingLine[] {
  const a = fromMinor(amount);
  if (toEmployee && !sys.claimsPayable) throw new Error('claims payable');
  const control = side === 'sales' ? sys.receivables : toEmployee ? sys.claimsPayable! : sys.payables;
  if (!fx) {
    return direction === 'received'
      ? [{ accountId: bankAccountId, debit: a }, { accountId: control, credit: a }]
      : [{ accountId: control, debit: a }, { accountId: bankAccountId, credit: a }];
  }
  const s = fromMinor(fx.settled);
  // More of the company's currency than the invoice was booked at means a gain on money coming in, and a loss on
  // money going out. The entry balances either way: the exchange line is always exactly the gap.
  const gap = amount - fx.settled;
  const out: PostingLine[] = direction === 'received'
    ? [{ accountId: bankAccountId, debit: a }, { accountId: control, credit: s }]
    : [{ accountId: control, debit: s }, { accountId: bankAccountId, credit: a }];
  if (gap !== 0n) {
    const size = fromMinor(gap > 0n ? gap : -gap);
    const creditIt = (direction === 'received') === (gap > 0n);
    out.push({ accountId: fx.accountId, ...(creditIt ? { credit: size } : { debit: size }) });
  }
  return out;
}

/** Spreads a payment over open documents, oldest due first. */
export function autoAllocate(amount: Minor, open: { id: string; due: Minor }[]): { id: string; amount: Minor }[] {
  let left = amount;
  const out: { id: string; amount: Minor }[] = [];
  for (const d of open) {
    if (left <= 0n) break;
    if (d.due <= 0n) continue;
    const take = d.due < left ? d.due : left;
    out.push({ id: d.id, amount: take });
    left -= take;
  }
  return out;
}

export const AGE_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Which ageing column an amount falls in, by days past its due date. */
export function ageBucket(dueDate: string, asOf: string): AgeBucket {
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ recurring dates
export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Next date after `date`. Months keep the anchor day where the month has it (31st -> 30th/28th -> 31st). */
export function nextOccurrence(date: string, frequency: Frequency, anchorDay: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (frequency === 'weekly') {
    const x = new Date(Date.UTC(y, m - 1, d + 7));
    return x.toISOString().slice(0, 10);
  }
  const add = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  const total = (m - 1) + add;
  const ny = y + Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}


/**
 * Splits an amount that includes VAT (e.g. a bank payment) into net and VAT, with VAT = round(net x rate).
 * Some totals cannot be reached exactly (a 15% step is 1.15 halalas); then `rounding` (at most 0.01) is the
 * difference left over, booked as a separate line with no VAT.
 */
export function netFromGross(gross: Minor, companyVatRate: string, vatCode: VatCode): { net: Minor; vat: Minor; rounding: Minor } {
  const rate = vatCode === 'standard' ? companyVatRate : '0.00';
  const guess = divRoundHalfUp(gross * 10_000n, 10_000n + rateToBasisPoints(rate));
  let best: { net: Minor; vat: Minor; rounding: Minor } | null = null;
  for (const net of [guess, guess - 1n, guess + 1n, guess - 2n, guess + 2n]) {
    if (net < 0n) continue;
    const vat = vatForLine(net, rate);
    const rounding = gross - net - vat;
    if (rounding === 0n) return { net, vat, rounding };
    if (rounding > 0n && (!best || rounding < best.rounding)) best = { net, vat, rounding };
  }
  return best ?? { net: gross, vat: 0n, rounding: 0n };
}
