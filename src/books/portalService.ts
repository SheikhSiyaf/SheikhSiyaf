// Client portal: requests for documents from the firm, documents sent by the client (or shared by the firm),
// and monthly reports with the firm's commentary. Runs inside withUser(); 0024_calendar_portal.sql decides who
// may do what. Files are attachments (src/books/setupService.ts) of a portal upload.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { monthEnd } from './assets.js';
import { ownerSummary } from './reportsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
export const CATEGORIES = ['bank_statement', 'receipts', 'sales', 'purchases', 'payroll', 'contract', 'tax', 'other'] as const;
const category = (v: unknown) => ((CATEGORIES as readonly string[]).includes(String(v)) ? String(v) : 'other');
const optMonth = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!DATE.test(s) || monthEnd(s) !== s) bad('Choose the month.', 'err.date');
  return s;
};
const optDate = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (!DATE.test(String(v))) bad('Choose a date.', 'err.date');
  return String(v);
};

export async function isFirm(db: Db, companyId: string): Promise<boolean> {
  return (await db.query('SELECT portal_is_firm($1) AS f', [companyId])).rows[0].f;
}

// ------------------------------------------------------------------ requests
export interface RequestInput { title?: string; details?: string; category?: string; periodEnd?: string; dueDate?: string }
export async function createRequest(db: Db, companyId: string, b: RequestInput): Promise<string> {
  const title = text(b.title, 160) ?? bad('Say which documents you need.', 'err.portalTitle');
  return (await db.query(
    `INSERT INTO portal_requests (company_id, title, details, category, period_end, due_date, requested_by) VALUES ($1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
    [companyId, title, text(b.details), category(b.category), optMonth(b.periodEnd), optDate(b.dueDate)])).rows[0].id;
}
export async function listRequests(db: Db, companyId: string, status?: string) {
  return (await db.query(
    `SELECT r.id, r.title, r.details, r.category, r.period_end::text AS "periodEnd", r.due_date::text AS "dueDate", r.status,
            person_name(r.requested_by) AS "requestedBy", r.requested_at AS "requestedAt", person_name(r.closed_by) AS "closedBy", r.closed_at AS "closedAt",
            (SELECT count(*) FROM portal_uploads u WHERE u.request_id = r.id)::int AS answers
     FROM portal_requests r WHERE r.company_id = $1 AND ($2::text IS NULL OR r.status = $2)
     ORDER BY CASE r.status WHEN 'answered' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, r.due_date NULLS LAST, r.requested_at DESC`, [companyId, status ?? null])).rows;
}
export async function setRequestStatus(db: Db, id: string, status: string): Promise<void> {
  if (status !== 'done' && status !== 'open') bad('Choose done or open.', 'err.format');
  const r = await db.query('UPDATE portal_requests SET status = $2 WHERE id = $1', [id, status]);
  if (!r.rowCount) { if ((await db.query('SELECT 1 FROM portal_requests WHERE id = $1', [id])).rows[0]) throw new HttpError(403, 'Only your accountant does this.', 'err.portalFirmOnly'); notFound(); }
}

// ------------------------------------------------------------------ documents sent
export interface UploadInput { requestId?: string; category?: string; periodEnd?: string; note?: string }
export async function createUpload(db: Db, companyId: string, b: UploadInput): Promise<string> {
  const requestId = b.requestId ? String(b.requestId) : null;
  if (requestId && !/^[0-9a-f-]{36}$/.test(requestId)) bad('That request was not found.', 'err.notFound');
  return (await db.query(
    `INSERT INTO portal_uploads (company_id, request_id, category, period_end, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, app_user_id()) RETURNING id`,
    [companyId, requestId, category(b.category), optMonth(b.periodEnd), text(b.note)])).rows[0].id;
}
export async function listUploads(db: Db, companyId: string, f: { status?: string; requestId?: string } = {}) {
  const rows = (await db.query(
    `SELECT u.id, u.request_id AS "requestId", r.title AS "requestTitle", u.category, u.period_end::text AS "periodEnd", u.note, u.from_firm AS "fromFirm", u.status,
            person_name(u.uploaded_by) AS "uploadedBy", u.uploaded_by = app_user_id() AS mine, u.uploaded_at AS "uploadedAt",
            person_name(u.processed_by) AS "processedBy", u.processed_at AS "processedAt"
     FROM portal_uploads u LEFT JOIN portal_requests r ON r.id = u.request_id
     WHERE u.company_id = $1 AND ($2::text IS NULL OR u.status = $2) AND ($3::uuid IS NULL OR u.request_id = $3)
     ORDER BY u.uploaded_at DESC`, [companyId, f.status ?? null, f.requestId ?? null])).rows;
  const files = (await db.query(
    `SELECT a.id, a.portal_upload_id AS "uploadId", a.file_name AS "fileName", a.content_type AS "contentType", a.size_bytes AS size
     FROM attachments a WHERE a.company_id = $1 AND a.portal_upload_id IS NOT NULL ORDER BY a.uploaded_at`, [companyId])).rows;
  return rows.map((u) => ({ ...u, files: files.filter((x) => x.uploadId === u.id).map(({ uploadId: _, ...x }) => x) }));
}
export async function setUploadStatus(db: Db, id: string, status: string): Promise<void> {
  if (status !== 'processed' && status !== 'new') bad('Choose dealt with or not yet.', 'err.format');
  const r = await db.query('UPDATE portal_uploads SET status = $2 WHERE id = $1 AND NOT from_firm', [id, status]);
  if (!r.rowCount) { if ((await db.query('SELECT 1 FROM portal_uploads WHERE id = $1', [id])).rows[0]) throw new HttpError(403, 'Only your accountant does this.', 'err.portalFirmOnly'); notFound(); }
}
export async function removeUpload(db: Db, id: string): Promise<void> {
  const r = await db.query('DELETE FROM portal_uploads WHERE id = $1', [id]);
  if (!r.rowCount) { if ((await db.query('SELECT 1 FROM portal_uploads WHERE id = $1', [id])).rows[0]) throw new HttpError(403, 'Only the person who sent these can remove them.', 'err.portalNotYours'); notFound(); }
}

// ------------------------------------------------------------------ monthly reports
export interface LetterFigures { revenue: string; grossProfit: string; netProfit: string; ytdNetProfit: string; cash: string; receivables: string; payables: string; vatDue: string }
export async function publishLetter(db: Db, companyId: string, b: { periodEnd?: string; commentary?: string }): Promise<string> {
  const pe = optMonth(b.periodEnd) ?? bad('Choose the month.', 'err.date');
  const commentary = text(b.commentary, 8000) ?? bad('Write your comments for the client.', 'err.portalCommentary');
  const s = await ownerSummary(db, companyId, pe);
  const figures: LetterFigures = { revenue: s.month.revenue, grossProfit: s.month.grossProfit, netProfit: s.month.netProfit, ytdNetProfit: s.yearToDate.netProfit,
    cash: s.position.cash, receivables: s.position.receivables, payables: s.position.payables, vatDue: s.position.vatDue };
  return (await db.query(
    `INSERT INTO portal_letters (company_id, period_end, commentary, figures, published_by) VALUES ($1, $2, $3, $4, app_user_id()) RETURNING id`,
    [companyId, pe, commentary, JSON.stringify(figures)])).rows[0].id;
}
export async function listLetters(db: Db, companyId: string) {
  return (await db.query(
    `SELECT id, period_end::text AS "periodEnd", commentary, figures, person_name(published_by) AS "publishedBy", published_at AS "publishedAt",
            person_name(read_by) AS "readBy", read_at AS "readAt"
     FROM portal_letters WHERE company_id = $1 ORDER BY period_end DESC, published_at DESC`, [companyId])).rows;
}
/** The client opens a report: the first time marks it read (the firm opening it changes nothing). */
export async function markLetterRead(db: Db, id: string): Promise<void> {
  const r = (await db.query('SELECT company_id, read_at FROM portal_letters WHERE id = $1', [id])).rows[0] ?? notFound();
  if (r.read_at || (await isFirm(db, r.company_id))) return;
  await db.query('UPDATE portal_letters SET read_at = now() WHERE id = $1', [id]);
}

// ------------------------------------------------------------------ overview
export async function overview(db: Db, companyId: string) {
  const c = (await db.query(
    `SELECT (SELECT count(*) FROM portal_requests WHERE company_id = $1 AND status = 'open')::int AS "openRequests",
            (SELECT count(*) FROM portal_requests WHERE company_id = $1 AND status = 'answered')::int AS "answeredRequests",
            (SELECT count(*) FROM portal_uploads WHERE company_id = $1 AND status = 'new')::int AS "newUploads",
            (SELECT count(*) FROM portal_uploads WHERE company_id = $1 AND from_firm)::int AS "shared",
            (SELECT count(*) FROM portal_letters WHERE company_id = $1 AND read_at IS NULL)::int AS "unreadLetters"`, [companyId])).rows[0];
  const latest = (await db.query(
    `SELECT id, period_end::text AS "periodEnd", published_at AS "publishedAt", read_at AS "readAt" FROM portal_letters WHERE company_id = $1 ORDER BY period_end DESC, published_at DESC LIMIT 1`,
    [companyId])).rows[0] ?? null;
  return { ...c, firm: await isFirm(db, companyId), latestLetter: latest, requests: (await listRequests(db, companyId)).filter((r) => r.status !== 'done').slice(0, 8) };
}
