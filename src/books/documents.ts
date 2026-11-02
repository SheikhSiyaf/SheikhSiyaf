// Sales and purchase documents: line maths, totals and the journal entry each one posts.
// Pure functions shared by the API (src/books/documentsService.ts) and the demo build.
// The database re-checks the same maths (db/migrations/0005_sales_purchases.sql).
import { divRoundHalfUp, fromMinor, toMinor, type Minor } from '../money.js';
import { vatForLine } from '../vat/vat.js';

export type DocType = 'quotation' | 'invoice' | 'credit_note' | 'bill' | 'supplier_credit' | 'expense' | 'claim';
export type VatCode = 'standard' | 'zero' | 'exempt' | 'out_of_scope';
export type Direction = 'received' | 'made';

export const DOC_TYPES: DocType[] = ['quotation', 'invoice', 'credit_note', 'bill', 'supplier_credit', 'expense', 'claim'];
export const VAT_CODES: VatCode[] = ['standard', 'zero', 'exempt', 'out_of_scope'];
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;

export const sideOf = (t: DocType): 'sales' | 'purchases' => (t === 'quotation' || t === 'invoice' || t === 'credit_note' ? 'sales' : 'purchases');
export const isCredit = (t: DocType) => t === 'credit_note' || t === 'supplier_credit';
export const posts = (t: DocType) => t !== 'quotation';

/** Number prefixes; invoices use the client's own invoice prefix. */
export function numberPrefix(type: DocType | 'receipt' | 'payment', invoicePrefix: string): string {
  return { invoice: invoicePrefix, quotation: 'QT-', credit_note: 'CN-', bill: 'BILL-', supplier_credit: 'SC-', expense: 'EXP-', claim: 'CLM-', receipt: 'RCPT-', payment: 'PAY-' }[type];
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

/** Net = quantity x price, VAT = net x rate; each rounded half away from zero to 2 decimals. */
export function priceLine(l: LineInput, companyVatRate: string): PricedLine {
  const qty = quantityToMilli(l.quantity);
  const price = toMinor(String(l.unitPrice).trim() || '0');
  if (price < 0n) throw new Error('price');
  const net = divRoundHalfUp(qty * price, 1000n);
  const vatRate = l.vatCode === 'standard' ? companyVatRate : '0.00';
  return { ...l, quantity: milliToString(qty), unitPrice: fromMinor(price), vatRate, net, vat: vatForLine(net, vatRate) };
}

export function documentTotals(lines: { net: Minor; vat: Minor }[]) {
  const net = lines.reduce((s, l) => s + l.net, 0n);
  const vat = lines.reduce((s, l) => s + l.vat, 0n);
  return { net, vat, gross: net + vat };
}

export interface SystemAccounts { receivables: string; payables: string; outputVat: string; inputVat: string; claimsPayable?: string }
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
export function postingForPayment(direction: Direction, amount: Minor, bankAccountId: string, sys: SystemAccounts, toEmployee = false): PostingLine[] {
  const a = fromMinor(amount);
  if (toEmployee && !sys.claimsPayable) throw new Error('claims payable');
  return direction === 'received'
    ? [{ accountId: bankAccountId, debit: a }, { accountId: sys.receivables, credit: a }]
    : [{ accountId: toEmployee ? sys.claimsPayable! : sys.payables, debit: a }, { accountId: bankAccountId, credit: a }];
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

