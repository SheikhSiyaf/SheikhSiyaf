// Chart of accounts and cost centres (Ledger > Chart of accounts, Ledger > Cost centres), and attachments.
// Every function runs inside withUser(); db/migrations/0014_attachments_chart.sql checks codes and attachments.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };

// ------------------------------------------------------------------ chart of accounts
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];
/** The first digit each type's codes start with. */
export const CODE_START: Record<AccountType, string[]> = { asset: ['1'], liability: ['2'], equity: ['3'], income: ['4'], expense: ['5', '6', '7', '8', '9'] };

export async function chart(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.name, a.name_ar AS "nameAr", a.type, a.cost_centre_required AS "costCentreRequired", a.is_bank AS "isBank", a.pnl_group AS "pnlGroup",
            coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS balance, count(l.id)::int AS postings
     FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
     WHERE a.company_id = $1 GROUP BY a.id ORDER BY a.code`, [companyId]);
  return rows;
}

/** The next free code for a type, e.g. 5410 after 5400. */
export async function nextCode(db: Db, companyId: string, type: AccountType): Promise<string> {
  const used = new Set((await db.query('SELECT code FROM accounts WHERE company_id = $1', [companyId])).rows.map((r) => r.code as string));
  for (const first of CODE_START[type]) {
    const codes = [...used].filter((c) => c.startsWith(first)).map(Number).sort((a, b) => a - b);
    let c = codes.length ? Math.floor(codes.at(-1)! / 10) * 10 + 10 : Number(`${first}000`);
    while (used.has(String(c)) && c < Number(`${first}999`)) c++;
    if (c <= Number(`${first}999`) && !used.has(String(c))) return String(c);
  }
  return bad('There is no free code left for this type of account.', 'err.noCode');
}

export interface AccountInput { code?: string; name?: string; nameAr?: string; type?: string; costCentreRequired?: boolean; pnlGroup?: string | null }

export async function saveAccount(db: Db, companyId: string, a: AccountInput, id?: string): Promise<string> {
  const name = String(a.name ?? '').trim();
  if (!name) bad('Enter the account name.', 'err.accountName');
  const type = ACCOUNT_TYPES.includes(a.type as AccountType) ? a.type as AccountType : bad('Choose the type of account.', 'err.accountType');
  const code = String(a.code ?? '').trim() || await nextCode(db, companyId, type);
  if (!/^[1-9]\d{3}$/.test(code) || !CODE_START[type].includes(code[0]!)) {
    bad('Account codes have 4 digits starting with 1 (assets), 2 (liabilities), 3 (equity), 4 (income) or 5-9 (expenses).', 'err.accountCode');
  }
  const taken = await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2 AND id IS DISTINCT FROM $3', [companyId, code, id ?? null]);
  if (taken.rows[0]) bad('Another account already has this code.', 'err.accountCodeTaken');
  // The P&L line; the database picks the usual one when none (or one that does not fit the type) is given.
  const group = ['revenue', 'other_income', 'cost_of_sales', 'indirect_expense'].includes(String(a.pnlGroup)) ? a.pnlGroup : null;
  const v = [code, name, a.nameAr?.trim() || null, type, Boolean(a.costCentreRequired), group];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE accounts SET code = $2, name = $3, name_ar = $4, type = $5, cost_centre_required = $6, pnl_group = $7 WHERE id = $1 AND company_id = $8`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(
    `INSERT INTO accounts (company_id, code, name, name_ar, type, cost_centre_required, pnl_group) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [companyId, ...v])).rows[0].id;
}

// ------------------------------------------------------------------ cost centres (branches and departments; projects are in Projects)
export async function costCentres(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT cc.id, cc.name, cc.name_ar AS "nameAr", cc.kind, cc.status, cc.parent_id AS "parentId", p.name AS "parentName", p.name_ar AS "parentNameAr",
            (SELECT count(*) FROM journal_lines l WHERE l.cost_centre_id = cc.id)::int AS postings
     FROM cost_centres cc LEFT JOIN cost_centres p ON p.id = cc.parent_id
     WHERE cc.company_id = $1 ORDER BY cc.kind = 'project', cc.kind, cc.name`, [companyId]);
  return rows;
}

export interface CostCentreInput { name?: string; nameAr?: string; kind?: string; parentId?: string | null; status?: 'active' | 'closed' }

export async function saveCostCentre(db: Db, companyId: string, c: CostCentreInput, id?: string): Promise<string> {
  const name = String(c.name ?? '').trim();
  if (!name) bad('Enter the cost centre name.', 'err.costCentreName');
  const kind = c.kind === 'department' ? 'department' : 'branch';
  if (c.parentId && (c.parentId === id || !(await db.query(`SELECT 1 FROM cost_centres WHERE id = $1 AND company_id = $2 AND kind <> 'project'`, [c.parentId, companyId])).rows[0])) {
    bad('Choose a branch or department of this client as the parent.', 'err.costCentreParent');
  }
  const dup = await db.query(`SELECT 1 FROM cost_centres WHERE company_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3`, [companyId, name, id ?? null]);
  if (dup.rows[0]) bad('Another cost centre already has this name.', 'err.costCentreTaken');
  const v = [name, c.nameAr?.trim() || null, kind, c.parentId || null, c.status === 'closed' ? 'closed' : 'active'];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE cost_centres SET name = $2, name_ar = $3, kind = $4, parent_id = $5, status = $6 WHERE id = $1 AND company_id = $7 AND kind <> 'project'`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(
    `INSERT INTO cost_centres (company_id, name, name_ar, kind, parent_id, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [companyId, ...v])).rows[0].id;
}

// ------------------------------------------------------------------ attachments
export const ATTACHMENT_TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const MAX_ATTACHMENT = 10 * 1024 * 1024;

export interface AttachmentInput { fileName?: string; contentType?: string; data?: string }   // data: base64

export async function listAttachments(db: Db, owner: { documentId?: string; stockNoteId?: string; employeeDocumentId?: string }) {
  const { rows } = await db.query(
    `SELECT a.id, a.file_name AS "fileName", a.content_type AS "contentType", a.size_bytes AS "size", a.uploaded_at AS "uploadedAt", person_name(a.uploaded_by) AS "uploadedBy"
     FROM attachments a
     WHERE (a.document_id = $1 OR a.stock_note_id = $2 OR a.employee_document_id = $3) ORDER BY a.uploaded_at`, [owner.documentId ?? null, owner.stockNoteId ?? null, owner.employeeDocumentId ?? null]);
  return rows;
}

export async function addAttachment(db: Db, owner: { documentId?: string; stockNoteId?: string; employeeDocumentId?: string }, f: AttachmentInput): Promise<string> {
  const table = owner.documentId ? 'documents' : owner.stockNoteId ? 'stock_notes' : 'employee_documents';
  const ownerId = owner.documentId ?? owner.stockNoteId ?? owner.employeeDocumentId;
  const company = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [ownerId])).rows[0]?.company_id ?? notFound();
  const fileName = String(f.fileName ?? '').trim().slice(-200);
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const type = ATTACHMENT_TYPES[ext];
  if (!type || (f.contentType && f.contentType !== type && !(type === 'image/jpeg' && f.contentType === 'image/jpg'))) {
    bad('Attach a PDF or a picture (PNG, JPG or WEBP).', 'err.attachmentType');
  }
  const data = Buffer.from(String(f.data ?? ''), 'base64');
  if (!data.length) bad('The file is empty.', 'err.attachmentEmpty');
  if (data.length > MAX_ATTACHMENT) bad('Files can be up to 10 MB.', 'err.attachmentSize');
  // The file must really be what its name says (first bytes), so nothing else is stored under a PDF or picture name.
  const magic = data.subarray(0, 12);
  const ok = type === 'application/pdf' ? magic.subarray(0, 5).toString('latin1') === '%PDF-'
    : type === 'image/png' ? magic[0] === 0x89 && magic.subarray(1, 4).toString('latin1') === 'PNG'
    : type === 'image/jpeg' ? magic[0] === 0xff && magic[1] === 0xd8
    : magic.subarray(0, 4).toString('latin1') === 'RIFF' && magic.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!ok) bad('This file is not a real PDF or picture.', 'err.attachmentType');
  const id = (await db.query(
    `INSERT INTO attachments (company_id, document_id, stock_note_id, employee_document_id, file_name, content_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7, app_user_id()) RETURNING id`,
    [company, owner.documentId ?? null, owner.stockNoteId ?? null, owner.employeeDocumentId ?? null, fileName, type, data.length])).rows[0].id;
  await db.query('INSERT INTO attachment_files (attachment_id, company_id, data) VALUES ($1, $2, $3)', [id, company, data]);
  return id;
}

export async function getAttachment(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT a.file_name AS "fileName", a.content_type AS "contentType", f.data FROM attachments a JOIN attachment_files f ON f.attachment_id = a.id WHERE a.id = $1`, [id]);
  return rows[0] ?? notFound();
}

export async function removeAttachment(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM attachments WHERE id = $1', [id]);
  if (!rowCount) notFound();
}
