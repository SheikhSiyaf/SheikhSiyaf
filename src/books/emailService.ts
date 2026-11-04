// Emails from a company (db/migrations/0031_email.sql): sending an invoice, credit note or quotation to the customer
// with a link to view it (no sign-in), telling approvers something waits, and the list of emails sent.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { approvalMail, documentMail, type Mail } from '../email/templates.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const hashLinkToken = (t: string) => createHash('sha256').update(`doc-link:${t}`).digest('hex');

export interface QueueInput { companyId?: string | null; firmId?: string | null; kind: string; to: string; toName?: string | null; replyTo?: string | null; mail: Mail;
  attachments?: { fileName: string; contentType: string; base64: string }[]; documentId?: string | null; contactId?: string | null }
export async function queue(db: { query: Db['query'] }, q: QueueInput): Promise<string> {
  if (!EMAIL.test(q.to.trim())) bad('Enter a valid email address.', 'err.email');
  return (await db.query('SELECT queue_email($1) AS id', [JSON.stringify({ company_id: q.companyId ?? null, firm_id: q.firmId ?? null, kind: q.kind, to_email: q.to, to_name: q.toName ?? null,
    reply_to: q.replyTo ?? null, subject: q.mail.subject, body_text: q.mail.text, body_html: q.mail.html, attachments: q.attachments ?? [], document_id: q.documentId ?? null,
    contact_id: q.contactId ?? null })])).rows[0].id;
}

/** A new link to view a document without signing in. The token is returned once; only its hash is kept. */
export async function documentLink(db: Db, documentId: string): Promise<string> {
  const d = (await db.query(`SELECT company_id, status, type FROM documents WHERE id = $1`, [documentId])).rows[0] ?? notFound();
  if (d.status === 'draft') bad('Issue the document first.', 'err.docDraft');
  if (!['invoice', 'credit_note', 'quotation'].includes(d.type)) bad('Only sales documents are sent to customers.', 'err.docKind');
  const token = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO document_links (token_hash, company_id, document_id, created_by) VALUES ($1, $2, $3, app_user_id())`, [hashLinkToken(token), d.company_id, documentId]);
  return token;
}

/** Emails an issued sales document to the customer: a two-language message with the link, and the e-invoice XML when there is one. */
export async function emailDocument(db: Db, documentId: string, x: { to?: string; message?: string }, base: string): Promise<{ id: string; to: string }> {
  const d = (await db.query(
    `SELECT d.id, d.company_id, d.type, d.status, d.number, d.gross_total::text AS total, d.due_date::text AS due, document_amount_due(d.id)::numeric(18,2)::text AS "amountDue",
            c.id AS contact_id, c.name AS customer, c.email AS "contactEmail", co.name AS company, co.currency, co.email AS "companyEmail"
     FROM documents d JOIN contacts c ON c.id = d.contact_id JOIN companies co ON co.id = d.company_id WHERE d.id = $1`, [documentId])).rows[0] ?? notFound();
  const to = String(x.to ?? d.contactEmail ?? '').trim();
  if (!to) bad('Enter the customer\'s email address.', 'err.emailMissing');
  const token = await documentLink(db, documentId);
  const mail = documentMail({ kind: d.type, number: d.number, customer: d.customer, company: d.company, total: d.total, currency: d.currency, dueDate: d.due, amountDue: d.amountDue,
    link: `${base}/i/${token}`, message: String(x.message ?? '').trim() || null });
  const xml = (await db.query(`SELECT coalesce(cleared_xml, xml) AS xml, uuid FROM einvoices WHERE document_id = $1 AND status <> 'rejected' ORDER BY created_at DESC LIMIT 1`, [documentId])).rows[0];
  const id = await queue(db, { companyId: d.company_id, kind: 'document', to, toName: d.customer, replyTo: d.companyEmail, mail, documentId, contactId: d.contact_id,
    attachments: xml ? [{ fileName: `${d.number}.xml`, contentType: 'application/xml', base64: Buffer.from(xml.xml, 'utf8').toString('base64') }] : [] });
  return { id, to };
}

/** Tells everyone who may approve in the company (except the asker) that something waits. Quietly skips people without an email. */
export async function notifyApprovers(db: Db, companyId: string, what: string, base: string): Promise<number> {
  const people = (await db.query('SELECT name, email FROM company_approvers($1)', [companyId])).rows;
  const co = (await db.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0]?.name ?? '';
  const by = (await db.query('SELECT person_name(app_user_id()) AS n')).rows[0].n ?? '';
  let n = 0;
  for (const p of people) if (EMAIL.test(p.email)) { await queue(db, { companyId, kind: 'approval', to: p.email, toName: p.name, mail: approvalMail(p.name, what, co, by, `${base}/c/${companyId}/Approvals`) }); n++; }
  return n;
}

export async function list(db: Db, companyId: string, documentId?: string) {
  return (await db.query(`SELECT id, kind, to_email AS "to", to_name AS "toName", subject, status, attempts, last_error AS "lastError", document_id AS "documentId",
      jsonb_array_length(attachments) AS attachments, person_name(created_by) AS "createdBy", created_at AS "createdAt", sent_at AS "sentAt"
    FROM email_outbox WHERE company_id = $1 AND ($2::uuid IS NULL OR document_id = $2) ORDER BY created_at DESC LIMIT 200`, [companyId, documentId ?? null])).rows;
}
export async function retry(db: Db, id: string): Promise<void> { await db.query('SELECT email_retry($1)', [id]); }

/** Links to a document: when made and last opened; revoking stops them working. */
export async function links(db: Db, documentId: string) {
  return (await db.query(`SELECT token_hash AS id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
    FROM document_links WHERE document_id = $1 ORDER BY created_at DESC`, [documentId])).rows;
}
export async function revokeLinks(db: Db, documentId: string): Promise<void> {
  await db.query(`UPDATE document_links SET revoked_at = now() WHERE document_id = $1 AND revoked_at IS NULL`, [documentId]);
}
