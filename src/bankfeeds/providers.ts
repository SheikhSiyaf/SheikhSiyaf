// Bank feed providers (open banking). An adapter connects a bank account with the customer's consent and returns
// its transactions for a date range, money in positive and money out negative, as a statement file would.
//
//  sandbox  built in: a pretend bank that shows what a feed does. Its transactions are made up but steady (the same
//           day always gives the same lines): card settlements, bank charges, and customers paying some open invoices
//           by transfer, so matching can be tried.
//  lean / tarabut  open-banking providers licensed by SAMA and the UAE Central Bank. Their adapters are written once
//           there is an agreement with keys and their API specification; until then they cannot be connected.
import { createHash } from 'node:crypto';
import type { StatementRow } from '../bank/statement.js';

export interface FeedContext {
  feedId: string;
  /** Open customer invoices (for the sandbox only, to make realistic transfers). */
  openInvoices?: { id: string; number: string; customer: string; issueDate: string; due: string }[];
}
export interface FeedProvider {
  ready: boolean;
  connect(accountRef: string): Promise<{ externalAccountId: string; consentDays: number }>;
  transactions(externalAccountId: string, from: string, to: string, ctx: FeedContext): Promise<StatementRow[]>;
}

const hash = (s: string) => createHash('sha256').update(s).digest();
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const sandbox: FeedProvider = {
  ready: true,
  async connect(accountRef) { return { externalAccountId: `sbx-${accountRef.slice(-4) || '0000'}`, consentDays: 90 }; },
  async transactions(ext, from, to, ctx) {
    const rows: StatementRow[] = [];
    for (const d of days(from, to)) {
      const h = hash(`${ext}|${d}`);
      const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (weekday !== 5 && h[0]! % 3 !== 0) {   // most working days: the card terminal pays out yesterday's sales
        const amount = (200 + (h.readUInt16BE(1) % 4800)) + (h[3]! % 100) / 100;
        rows.push({ date: d, description: 'POS SETTLEMENT MADA', reference: `STL${h.readUInt32BE(4) % 1_000_000}`, amount: amount.toFixed(2), balance: null });
      }
      if (Number(d.slice(8)) === 1) rows.push({ date: d, description: 'MONTHLY ACCOUNT FEE', reference: null, amount: '-25.00', balance: null });
    }
    // Some customers pay an open invoice by transfer a week after it was issued, for exactly what is due.
    for (const inv of ctx.openInvoices ?? []) {
      if (hash(`${ext}|${inv.id}`)[0]! % 2 !== 0) continue;
      const on = addDays(inv.issueDate, 7);
      if (on < from || on > to) continue;
      rows.push({ date: on, description: `IBAN TRANSFER ${inv.customer.toUpperCase()} ${inv.number}`, reference: inv.number, amount: inv.due, balance: null });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  },
};
const notYet = (name: string): FeedProvider => ({
  ready: false,
  async connect() { throw new Error(`${name} is not connected yet: it needs an agreement and keys from ${name}.`); },
  async transactions() { throw new Error(`${name} is not connected yet.`); },
});

export const FEED_PROVIDERS: Record<string, FeedProvider> = { sandbox, lean: notYet('Lean'), tarabut: notYet('Tarabut') };
