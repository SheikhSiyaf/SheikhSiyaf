// Approvals: rules per company (bills, supplier payments, customer credit notes at or above an amount), requests,
// decisions, and carrying out an approved payment. Runs inside withUser(); 0026_approvals_forecast.sql enforces it.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { toMinor, fromMinor } from '../money.js';
import { recordPayment, type PaymentInput } from './documentsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
export const KINDS = ['bill', 'payment', 'credit_note'] as const;
export type Kind = (typeof KINDS)[number];

// ------------------------------------------------------------------ rules
export async function rules(db: Db, companyId: string) {
  const rows = (await db.query(`SELECT kind, threshold::text, active, person_name(updated_by) AS "updatedBy", updated_at AS "updatedAt" FROM approval_rules WHERE company_id = $1`, [companyId])).rows;
  const canEdit = (await db.query('SELECT app_can_approve($1) AS a', [companyId])).rows[0].a as boolean;
  return { canEdit, rules: KINDS.map((k) => rows.find((r) => r.kind === k) ?? { kind: k, threshold: '0.00', active: false, updatedBy: null, updatedAt: null }) };
}
export async function saveRule(db: Db, companyId: string, b: { kind?: string; threshold?: string; active?: boolean }): Promise<void> {
  const kind = KINDS.find((k) => k === b.kind) ?? bad('Choose what needs approval.', 'err.format');
  let threshold: bigint;
  try { threshold = toMinor(String(b.threshold ?? '0').replace(/,/g, '') || '0'); } catch { return bad('Enter the amount from which approval is needed.', 'err.amount'); }
  if (threshold < 0n) bad('Enter the amount from which approval is needed.', 'err.amount');
  await db.query(
    `INSERT INTO approval_rules (company_id, kind, threshold, active) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, kind) DO UPDATE SET threshold = $3, active = $4`, [companyId, kind, fromMinor(threshold), b.active !== false]);
}
export async function needed(db: Db, companyId: string, kind: string, amount: string): Promise<boolean> {
  if (!KINDS.includes(kind as Kind)) return false;
  return (await db.query('SELECT approval_needed($1, $2, $3::numeric) AS n', [companyId, kind, amount])).rows[0].n;
}

// ------------------------------------------------------------------ requests
export async function requestDocument(db: Db, documentId: string, note?: string): Promise<string> {
  const d = (await db.query('SELECT company_id, type, contact_id FROM documents WHERE id = $1', [documentId])).rows[0] ?? notFound();
  if (!['bill', 'credit_note'].includes(d.type)) bad('Only bills and credit notes are sent for approval.', 'err.format');
  if (!(await db.query(`SELECT 1 FROM document_lines WHERE document_id = $1`, [documentId])).rows[0]) bad('Add at least one line.', 'err.noLines');
  if ((await db.query(`SELECT 1 FROM approval_requests WHERE document_id = $1 AND status IN ('pending', 'approved')`, [documentId])).rows[0]) bad('This is already waiting for approval.', 'err.waitingApproval');
  // What would stop it being issued once approved is caught now, so nobody approves something that cannot be issued.
  if ((await db.query(`SELECT 1 FROM document_lines l JOIN accounts a ON a.id = l.account_id WHERE l.document_id = $1 AND a.cost_centre_required AND l.cost_centre_id IS NULL`, [documentId])).rows[0]) {
    bad('A cost centre is required for one of the accounts used.', 'err.costCentreRequired');
  }
  if ((await db.query(`SELECT 1 FROM documents d JOIN periods p ON p.company_id = d.company_id AND d.issue_date BETWEEN p.start_date AND p.end_date WHERE d.id = $1 AND p.locked_at IS NOT NULL`, [documentId])).rows[0]) {
    bad('This period is locked.', 'err.periodLocked');
  }
  return (await db.query(
    `INSERT INTO approval_requests (company_id, kind, document_id, contact_id, amount, note, requested_by) VALUES ($1, $2, $3, $4, 1, $5, app_user_id()) RETURNING id`,
    [d.company_id, d.type, documentId, d.contact_id, text(note)])).rows[0].id;
}
/** A supplier payment to be approved before it is made: what will be recorded is kept with the request. */
export async function requestPayment(db: Db, companyId: string, p: PaymentInput & { note?: string }): Promise<string> {
  if (!p.contactId) bad('Choose the supplier.', 'err.contact');
  if (!p.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  let amount: bigint;
  try { amount = toMinor(String(p.amount ?? '').replace(/,/g, '')); } catch { return bad('Enter the amount.', 'err.amount'); }
  if (amount <= 0n) bad('Enter the amount.', 'err.amount');
  const payment = { direction: 'made', contactId: p.contactId, date: p.date, amount: fromMinor(amount), accountId: p.accountId, method: p.method, reference: p.reference,
    allocations: (p.allocations ?? []).filter((a) => a.amount && String(a.amount).trim() !== '' && String(a.amount).trim() !== '0') };
  return (await db.query(
    `INSERT INTO approval_requests (company_id, kind, payment, contact_id, amount, note, requested_by) VALUES ($1, 'payment', $2, $3, $4, $5, app_user_id()) RETURNING id`,
    [companyId, JSON.stringify(payment), p.contactId, fromMinor(amount), text(p.note)])).rows[0].id;
}
async function request(db: Db, id: string) {
  return (await db.query('SELECT * FROM approval_requests WHERE id = $1', [id])).rows[0] ?? notFound();
}
export async function decide(db: Db, id: string, decision: string, reason?: string): Promise<void> {
  if (decision !== 'approved' && decision !== 'rejected') bad('Approve or reject.', 'err.format');
  const r = await request(db, id);
  if (r.status !== 'pending') bad('This is no longer waiting for approval.', 'err.approvalClosed');
  if (decision === 'rejected' && !text(reason)) bad('Give a reason for rejecting.', 'err.rejectReason');
  const can = (await db.query('SELECT app_can_approve($1) AS a', [r.company_id])).rows[0].a;
  if (!can) throw new HttpError(403, 'Your role does not allow approving.', 'err.roleNoApprove');
  await db.query('UPDATE approval_requests SET status = $2, reason = $3 WHERE id = $1', [id, decision, text(reason)]);
}
export async function withdraw(db: Db, id: string): Promise<void> {
  const r = await request(db, id);
  if (!['pending', 'approved'].includes(r.status)) bad('This is no longer open.', 'err.approvalClosed');
  const u = await db.query(`UPDATE approval_requests SET status = 'withdrawn' WHERE id = $1`, [id]);
  if (!u.rowCount) throw new HttpError(403, 'Only the person who sent it, or an approver, withdraws it.', 'err.forbidden');
}
/** Records an approved supplier payment exactly as it was approved (the date can be today's). */
export async function payApproved(db: Db, id: string, date?: string): Promise<string> {
  const r = await request(db, id);
  if (r.kind !== 'payment') bad('Only payments are recorded from here.', 'err.format');
  if (r.status !== 'approved') bad('This payment is not approved.', 'err.approvalNotApproved');
  const p = r.payment as PaymentInput;
  return recordPayment(db, r.company_id, { ...p, date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : p.date, approvalRequestId: id });
}

// ------------------------------------------------------------------ lists
const COLS = `r.id, r.kind, r.status, r.amount::text, r.note, r.reason, r.document_id AS "documentId", d.number AS "docNumber", d.type AS "docType", d.issue_date::text AS "docDate",
  r.payment, r.payment_id AS "paymentId", p.number AS "paymentNumber", c.name AS contact, c.name_ar AS "contactAr",
  person_name(r.requested_by) AS "requestedBy", r.requested_at AS "requestedAt", person_name(r.decided_by) AS "decidedBy", r.decided_at AS "decidedAt", r.done_at AS "doneAt",
  r.requested_by = app_user_id() AS mine, (r.requested_by <> app_user_id() AND app_can_approve(r.company_id)) AS "canDecide"`;
const FROM = `FROM approval_requests r JOIN contacts c ON c.id = r.contact_id LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN payments p ON p.id = r.payment_id`;
export async function list(db: Db, companyId: string, status?: string) {
  const open = status === 'open';
  return (await db.query(`SELECT ${COLS} ${FROM} WHERE r.company_id = $1 AND ($2::text IS NULL OR ($3 AND r.status IN ('pending', 'approved')) OR r.status = $2)
    ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.requested_at DESC LIMIT 300`, [companyId, status ?? null, open])).rows;
}
export async function forDocument(db: Db, documentId: string) {
  return (await db.query(`SELECT ${COLS} ${FROM} WHERE r.document_id = $1 ORDER BY r.requested_at DESC LIMIT 1`, [documentId])).rows[0] ?? null;
}
/** What waits for this person: requests they can decide, and employee claims (their own approval flow). */
export async function waiting(db: Db, companyId: string) {
  const canApprove = (await db.query('SELECT app_can_approve($1) AS a', [companyId])).rows[0].a as boolean;
  const requests = (await db.query(`SELECT count(*)::int AS n FROM approval_requests WHERE company_id = $1 AND status = 'pending' AND requested_by <> app_user_id()`, [companyId])).rows[0].n;
  const claims = (await db.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = 'claim' AND status = 'submitted' AND submitted_by IS DISTINCT FROM app_user_id()`, [companyId])).rows[0].n;
  const approved = (await db.query(`SELECT count(*)::int AS n FROM approval_requests WHERE company_id = $1 AND status = 'approved'`, [companyId])).rows[0].n;
  return { canApprove, toDecide: canApprove ? requests : 0, claims, approvedToAction: approved };
}
