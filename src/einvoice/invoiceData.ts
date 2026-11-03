// The invoice data layout shared by every country's e-invoicing adapter (CLAUDE.md: same layout for all
// countries; each country's e-invoicing is a separate adapter). Amounts are decimal strings with 2 places.

export type VatCode = 'standard' | 'zero' | 'exempt' | 'out_of_scope';
export interface EParty {
  name: string; nameAr?: string | null;
  vatNumber?: string | null; crNumber?: string | null;
  street?: string | null; building?: string | null; district?: string | null; city?: string | null; postalCode?: string | null; country: string;
  email?: string | null;
}
export interface ELine { no: number; description: string; quantity: string; unitPrice: string; net: string; vat: string; vatCode: VatCode; vatRate: string }
export interface EInvoiceData {
  number: string;
  uuid: string;
  type: 'invoice' | 'credit_note' | 'debit_note';
  issueDate: string;
  /** Local time of issue, HH:mm:ss. */
  issueTime: string;
  /** When the goods or services were supplied (the issue date when not known). */
  supplyDate: string;
  dueDate?: string | null;
  currency: string;
  seller: EParty;
  buyer: EParty | null;
  lines: ELine[];
  netTotal: string; vatTotal: string; grossTotal: string;
  /** Credit and debit notes: the invoice they correct, and why. */
  original?: { number: string; issueDate: string } | null;
  reason?: string | null;
  /** UN/ECE 4461: 10 cash, 30 credit transfer, 42 bank account, 48 card, 1 not defined. */
  paymentMeans: string;
  /** Why a line has no VAT (ZATCA exemption reason codes VATEX-SA-...). */
  exemption: Record<Exclude<VatCode, 'standard'>, { code: string; text: string }>;
}

/** Adds decimal strings with 2 places exactly (no floating point). */
export function addMoney(...v: string[]): string {
  return fromCents(v.reduce((t, x) => t + toCents(x), 0n));
}
export function toCents(v: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) throw new Error(`Not an amount: ${v}`);
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -c : c;
}
export function fromCents(c: bigint): string {
  const neg = c < 0n; const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
