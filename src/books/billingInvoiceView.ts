// The invoice Nusuh Books sends to its customers, laid out as a ZATCA standard tax invoice: one row per line with the discount, the taxable
// amount, the VAT rate, the VAT and the line total, and a QR code in the ZATCA TLV format. Pure functions (no database) so the maths is tested
// on its own: the rows always add up, to the cent, to the totals stored on the invoice.
// The invoice stores a discount and a VAT amount for the whole invoice; here they are shared out over the lines (largest remainder) so that every
// column adds up exactly to the stored figure and no line carries a rounding difference of its own.
import { fromMinor, toMinor } from '../money.js';
import { zatcaQrPayload, zatcaTimestamp } from '../einvoice/zatcaQr.js';

export interface InvoiceLineIn { key: string; quantity: number | string; unitPrice: number | string; amount: number | string; name?: string; months?: number }
export interface InvoiceIn { lines: InvoiceLineIn[]; subtotal: string; discount: string; vatRate: string; vat: string; total: string }

export interface InvoiceRow {
  index: number; line: InvoiceLineIn;
  quantity: string; unitPrice: string; gross: string; discount: string; taxable: string; vatRate: string; vat: string; total: string;
}
export interface InvoiceTotals { gross: string; discount: string; taxable: string; vat: string; total: string }

/** Money that came out of the database as a number or a string, as exact minor units. Two decimals at most. */
const minorOf = (x: number | string): bigint => {
  const s = typeof x === 'number' ? x.toFixed(2) : String(x).trim();
  return toMinor(/^-?\d+$/.test(s) ? `${s}.00` : s);
};

/** Shares `total` over `weights` in proportion, in whole minor units, so the parts add up to the total exactly (largest remainder, earlier line first on a tie). */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0n));
  const sign = total < 0n ? -1n : 1n, abs = total * sign;
  const parts = weights.map((w) => (abs * w) / sum);
  let left = abs - parts.reduce((s, p) => s + p, 0n);
  const order = weights.map((w, i) => ({ i, r: (abs * w) % sum })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) { if (left <= 0n) break; parts[i]! += 1n; left -= 1n; }
  return parts.map((p) => p * sign);
}

export function layoutInvoice(inv: InvoiceIn): { rows: InvoiceRow[]; totals: InvoiceTotals; adds: boolean } {
  const gross = inv.lines.map((l) => minorOf(l.amount));
  const discount = allocate(minorOf(inv.discount), gross);
  const taxable = gross.map((g, i) => g - discount[i]!);
  const vat = allocate(minorOf(inv.vat), taxable);
  const rate = String(Number(inv.vatRate));
  const rows: InvoiceRow[] = inv.lines.map((line, i) => ({
    index: i + 1, line, quantity: String(line.quantity), unitPrice: fromMinor(minorOf(line.unitPrice)), gross: fromMinor(gross[i]!), discount: fromMinor(discount[i]!),
    taxable: fromMinor(taxable[i]!), vatRate: rate, vat: fromMinor(vat[i]!), total: fromMinor(taxable[i]! + vat[i]!),
  }));
  const sum = (a: bigint[]) => a.reduce((s, x) => s + x, 0n);
  const totals: InvoiceTotals = { gross: fromMinor(sum(gross)), discount: fromMinor(sum(discount)), taxable: fromMinor(sum(taxable)), vat: fromMinor(sum(vat)), total: fromMinor(sum(taxable) + sum(vat)) };
  // the invoice's own stored figures are the truth; the rows must agree with them
  const adds = totals.gross === fromMinor(minorOf(inv.subtotal)) && totals.discount === fromMinor(minorOf(inv.discount)) && totals.vat === fromMinor(minorOf(inv.vat)) && totals.total === fromMinor(minorOf(inv.total));
  return { rows, totals, adds };
}

/** A Saudi VAT number: 15 digits (the QR code needs it, so without a valid one no code is made). */
export const validSellerVat = (v: string | null | undefined): v is string => !!v && /^[0-9]{15}$/.test(v);

/** The QR code holds each field in at most 255 bytes (Arabic letters take two): a longer name is cut at a whole letter. */
export function fitBytes(s: string, max = 255): string {
  const enc = new TextEncoder();
  let out = '';
  for (const ch of s) { if (enc.encode(out + ch).length > max) break; out += ch; }
  return out;
}

export interface QrInput { sellerNameAr: string | null; sellerName: string; sellerVat: string | null; createdAt: string | null; issuedOn: string; total: string; vat: string }
/** The ZATCA QR text (base64 TLV: seller, VAT number, time stamp, total with VAT, VAT) or null when the seller's VAT number is not set. */
export function invoiceQr(i: QrInput): string | null {
  if (!validSellerVat(i.sellerVat)) return null;
  return zatcaQrPayload({ sellerName: fitBytes(i.sellerNameAr?.trim() || i.sellerName), vatNumber: i.sellerVat, timestamp: zatcaTimestamp(i.createdAt, i.issuedOn), total: i.total, vatTotal: i.vat });
}
