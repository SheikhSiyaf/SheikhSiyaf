// Advance payments (db/migrations/0046): the advance-payment invoice (ZATCA type 386, lines on 2160 Customer advances,
// with VAT) and its deduction on the final invoice. Amounts asked for are with VAT, as the customer pays them.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { vatForLine } from '../vat/vat.js';
import { issueDocument, recordPayment, saveDraft } from './documentsService.js';
import { netFromGross } from './rooms.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const amountOf = (v: unknown): bigint => {
  try { const m = toMinor(String(v ?? '').replace(/,/g, '').trim()); if (m > 0n) return m; } catch { /* below */ }
  return bad('Enter the amount, above 0.', 'err.amount');
};

export interface AdvanceInput { contactId?: string; amount?: string; date?: string; description?: string; payment?: { accountId?: string; method?: string; reference?: string } | null }

/** Issues an advance-payment invoice for an amount with VAT (one line on 2160) and, when the money came in, records
 *  the receipt against it. Returns the invoice. */
export async function createAdvance(db: Db, companyId: string, x: AdvanceInput): Promise<string> {
  if (!x.contactId) bad('Choose the customer.', 'err.contact');
  const gross = amountOf(x.amount);
  const day = x.date && DATE.test(x.date) ? x.date : today();
  const co = (await db.query(`SELECT vat_rate::text AS rate, (SELECT id FROM accounts WHERE company_id = c.id AND code = '2160') AS adv FROM companies c WHERE c.id = $1`,
    [companyId])).rows[0] ?? notFound();
  if (!co.adv) bad("This client's chart of accounts has no account 2160 Customer advances.", 'err.chart');
  // The price before VAT worked back; if its VAT rounds the total a halala over what was paid, a halala less (the
  // advance invoice is never more than the money received: 1,000.00 at 15% gives 869.56 + 130.43 = 999.99).
  let net = netFromGross(gross, co.rate);
  while (net > 0n && net + vatForLine(net, co.rate) > gross) net -= 1n;
  const id = await saveDraft(db, companyId, { type: 'invoice', contactId: x.contactId, issueDate: day, dueDate: day,
    notes: 'Advance payment invoice: it is deducted from the final invoice.',
    lines: [{ description: String(x.description ?? '').trim() || 'Advance payment', quantity: '1', unitPrice: fromMinor(net), accountId: co.adv, vatCode: 'standard' }] });
  await db.query('UPDATE documents SET is_advance = true WHERE id = $1', [id]);
  await issueDocument(db, id);
  if (x.payment?.accountId) {
    const due = (await db.query('SELECT gross_total::text AS g FROM documents WHERE id = $1', [id])).rows[0].g;
    await recordPayment(db, companyId, { direction: 'received', contactId: x.contactId, date: day, amount: due, accountId: x.payment.accountId,
      method: x.payment.method, reference: x.payment.reference, allocations: [{ documentId: id, amount: due }] });
  }
  return id;
}

/** Takes an advance (or part of it) off a draft final invoice of the same customer. Without an amount, all that is
 *  left of the advance, but no more than the invoice. The VAT deducted is the deducted net x the advance's rate. */
export async function deduct(db: Db, invoiceId: string, advanceId: string, amountWithVat?: string): Promise<void> {
  const f = (await db.query(`SELECT company_id, gross_total::text AS gross, (SELECT coalesce(sum(net_amount + vat_amount), 0)::text FROM advance_deductions WHERE document_id = $1) AS taken
    FROM documents WHERE id = $1`, [invoiceId])).rows[0] ?? notFound();
  const a = (await db.query(`SELECT l.vat_code, l.vat_rate::text AS rate, x.net::text AS net, x.vat::text AS vat FROM advance_left($1) x
    JOIN document_lines l ON l.document_id = $1 LIMIT 1`, [advanceId])).rows[0] ?? notFound();
  const leftNet = toMinor(a.net);
  if (leftNet <= 0n) bad('Nothing is left of this advance to deduct.', 'err.advanceUsed');
  const room = toMinor(f.gross) - toMinor(f.taken);   // what the invoice can still take, with VAT
  let want = amountWithVat ? amountOf(amountWithVat) : leftNet + toMinor(a.vat);
  if (want > room) want = room;
  if (want <= 0n) bad('The invoice is already covered by advances.', 'err.advanceTooMuch');
  let net = want >= leftNet + toMinor(a.vat) ? leftNet : netFromGross(want, a.rate);
  if (net > leftNet) net = leftNet;
  let vat = vatForLine(net, a.rate);
  // Rounding can put net + VAT a halala over what the invoice can take: take a halala less.
  while (net > 0n && net + vat > room) { net -= 1n; vat = vatForLine(net, a.rate); }
  await db.query(`INSERT INTO advance_deductions (company_id, document_id, advance_id, net_amount, vat_amount, vat_code, vat_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [f.company_id, invoiceId, advanceId, fromMinor(net), fromMinor(vat), a.vat_code, a.rate]);
}
export async function removeDeduction(db: Db, invoiceId: string, advanceId: string) {
  await db.query('DELETE FROM advance_deductions WHERE document_id = $1 AND advance_id = $2', [invoiceId, advanceId]);
}

/** The advances deducted on an invoice, with each advance invoice's number and date. */
export async function deductionsOf(db: Db, invoiceId: string) {
  return (await db.query(`SELECT x.advance_id AS "advanceId", a.number, a.issue_date::text AS "issueDate", x.net_amount::text AS net, x.vat_amount::text AS vat,
      (x.net_amount + x.vat_amount)::text AS total FROM advance_deductions x JOIN documents a ON a.id = x.advance_id WHERE x.document_id = $1 ORDER BY a.issue_date, a.number`,
    [invoiceId])).rows as { advanceId: string; number: string; issueDate: string; net: string; vat: string; total: string }[];
}

/** A customer's paid advances with something left to deduct. */
export async function available(db: Db, companyId: string, contactId: string) {
  return (await db.query(`SELECT a.id, a.number, a.issue_date::text AS "issueDate", a.gross_total::text AS total, l.net::text AS "leftNet", l.vat::text AS "leftVat"
    FROM documents a CROSS JOIN LATERAL advance_left(a.id) l
    WHERE a.company_id = $1 AND a.contact_id = $2 AND a.is_advance AND a.status = 'issued' AND document_amount_due(a.id) = 0 AND l.net > 0
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.original_id = a.id AND c.type = 'credit_note' AND c.status = 'issued')
    ORDER BY a.issue_date, a.number`, [companyId, contactId])).rows as { id: string; number: string; issueDate: string; total: string; leftNet: string; leftVat: string }[];
}
