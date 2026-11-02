// Sales and purchases: database operations. Every function runs inside withUser(), so row-level
// security and the database rules (db/migrations/0005) apply on top of the checks made here.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { postEntry, reverseEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import {
  addDays, ageBucket, AGE_BUCKETS, documentTotals, formatNumber, isCredit, numberPrefix, postingFor, postingForPayment,
  priceLine, sideOf, VAT_CODES, PAYMENT_METHODS, type AgeBucket, type Direction, type DocType, type LineInput, type PricedLine,
} from './documents.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function companyInfo(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT id, vat_rate::text AS "vatRate", invoice_prefix AS "invoicePrefix", payment_terms_days AS "paymentTermsDays"
     FROM companies WHERE id = $1`, [companyId]);
  return rows[0] ?? notFound();
}

export async function systemAccounts(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT code, id FROM accounts WHERE company_id = $1', [companyId]);
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const need = (code: string) => byCode.get(code) ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
  return {
    receivables: need(SYSTEM_ACCOUNTS.receivables), payables: need(SYSTEM_ACCOUNTS.payables),
    outputVat: need(SYSTEM_ACCOUNTS.outputVat), inputVat: need(SYSTEM_ACCOUNTS.inputVat),
    claimsPayable: byCode.get(SYSTEM_ACCOUNTS.claimsPayable) as string | undefined,
  };
}

/** Next number in a gap-free sequence per company and type (rolled back with the transaction). */
export async function nextNumber(db: Db, companyId: string, seq: string, prefix: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO document_sequences (company_id, type, next_no) VALUES ($1, $2, 2)
     ON CONFLICT (company_id, type) DO UPDATE SET next_no = document_sequences.next_no + 1
     RETURNING next_no - 1 AS n`, [companyId, seq]);
  return formatNumber(prefix, rows[0].n);
}

// ------------------------------------------------------------------ contacts
export interface ContactInput {
  isCustomer?: boolean; isSupplier?: boolean; isEmployee?: boolean; employeeNo?: string; jobTitle?: string; defaultCostCentreId?: string | null;
  name?: string; nameAr?: string; vatNumber?: string; crNumber?: string;
  email?: string; phone?: string; address?: string; city?: string; country?: string; paymentTermsDays?: string | number | null;
  status?: 'active' | 'archived';
}
const CONTACT_COLS = `c.id, c.is_customer AS "isCustomer", c.is_supplier AS "isSupplier", c.name, c.name_ar AS "nameAr",
  c.vat_number AS "vatNumber", c.cr_number AS "crNumber", c.email, c.phone, c.address, c.city, c.country,
  c.payment_terms_days AS "paymentTermsDays", c.status, c.is_employee AS "isEmployee", c.employee_no AS "employeeNo",
  c.job_title AS "jobTitle", c.default_cost_centre_id AS "defaultCostCentreId"`;

function contactValues(c: ContactInput) {
  const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!t(c.name)) bad('Enter the name.', 'err.contactName');
  if (!c.isCustomer && !c.isSupplier && !c.isEmployee) bad('Choose customer, supplier or both.', 'err.contactRole');
  if (c.isEmployee && (c.isCustomer || c.isSupplier)) bad('An employee cannot also be a customer or supplier.', 'err.employeeOnly');
  const email = t(c.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email address.', 'err.email');
  const terms = c.paymentTermsDays === null || c.paymentTermsDays === undefined || c.paymentTermsDays === '' ? null : Number(c.paymentTermsDays);
  if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) bad('Payment terms are 0 to 365 days.', 'err.terms');
  const country = t(c.country)?.toUpperCase() ?? null;
  return [Boolean(c.isCustomer), Boolean(c.isSupplier), t(c.name), t(c.nameAr), t(c.vatNumber)?.replace(/\s/g, '') ?? null, t(c.crNumber),
    email, t(c.phone), t(c.address), t(c.city), country, terms, c.status === 'archived' ? 'archived' : 'active',
    Boolean(c.isEmployee), c.isEmployee ? t(c.employeeNo) : null, c.isEmployee ? t(c.jobTitle) : null, c.isEmployee ? c.defaultCostCentreId || null : null];
}

export async function saveContact(db: Db, companyId: string, c: ContactInput, id?: string): Promise<string> {
  const v = contactValues(c);
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE contacts SET is_customer=$2, is_supplier=$3, name=$4, name_ar=$5, vat_number=$6, cr_number=$7, email=$8, phone=$9,
         address=$10, city=$11, country=$12, payment_terms_days=$13, status=$14, is_employee=$15, employee_no=$16, job_title=$17,
         default_cost_centre_id=$18 WHERE id = $1 AND company_id = $19`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  const { rows } = await db.query(
    `INSERT INTO contacts (company_id, is_customer, is_supplier, name, name_ar, vat_number, cr_number, email, phone, address, city, country,
       payment_terms_days, status, is_employee, employee_no, job_title, default_cost_centre_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [companyId, ...v]);
  return rows[0].id;
}

/** role 'payee' = anyone money can be paid to: suppliers and employees. */
export async function listContacts(db: Db, companyId: string, role: 'customer' | 'supplier' | 'employee' | 'payee', q = '') {
  const flag = { customer: 'c.is_customer', supplier: 'c.is_supplier', employee: 'c.is_employee', payee: '(c.is_supplier OR c.is_employee)' }[role];
  const types = { customer: `('invoice')`, supplier: `('bill')`, employee: `('claim')`, payee: `('bill', 'claim')` }[role];
  const { rows } = await db.query(
    `SELECT ${CONTACT_COLS},
       coalesce((SELECT sum(document_amount_due(d.id)) FROM documents d
                 WHERE d.contact_id = c.id AND d.type IN ${types} AND d.status = 'issued'), 0)::numeric(18,2)::text AS "balanceDue",
       coalesce((SELECT sum(document_amount_due(d.id)) FROM documents d
                 WHERE d.contact_id = c.id AND d.type IN ${types} AND d.status = 'issued' AND d.due_date < current_date
                   AND document_amount_due(d.id) > 0), 0)::numeric(18,2)::text AS overdue
     FROM contacts c
     WHERE c.company_id = $1 AND ${flag}
       AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR coalesce(c.name_ar, '') ILIKE '%' || $2 || '%' OR coalesce(c.vat_number, '') LIKE $2 || '%')
     ORDER BY c.status, c.name`, [companyId, q.trim()]);
  return rows;
}

export async function getContact(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${CONTACT_COLS}, c.company_id AS "companyId" FROM contacts c WHERE c.id = $1`, [id]);
  return rows[0] ?? notFound();
}

// ------------------------------------------------------------------ documents
export interface DocumentInput {
  type?: DocType; contactId?: string | null; issueDate?: string; dueDate?: string | null; reference?: string | null; notes?: string | null;
  originalId?: string | null; lines?: LineInput[];
  /** Expenses only: who was paid when there is no supplier record, and the bank or cash account it came from. */
  payee?: string | null; paidFromAccountId?: string | null; recurringId?: string | null;
}

function priceAll(lines: LineInput[] | undefined, vatRate: string): PricedLine[] {
  return (lines ?? []).map((l, i) => {
    if (!String(l.description ?? '').trim()) bad(`Line ${i + 1}: enter a description.`, 'err.lineDescription');
    if (!l.accountId) bad(`Line ${i + 1}: choose an account.`, 'err.lineAccount');
    if (!VAT_CODES.includes(l.vatCode)) bad(`Line ${i + 1}: choose the VAT treatment.`, 'err.lineVat');
    try {
      return priceLine({ ...l, description: String(l.description).trim() }, vatRate);
    } catch {
      return bad(`Line ${i + 1}: quantity must be more than 0 and the price a number with up to 2 decimals.`, 'err.lineNumbers');
    }
  });
}

/** Creates a draft (no id) or replaces a draft's header and lines. */
export async function saveDraft(db: Db, companyId: string, d: DocumentInput, id?: string): Promise<string> {
  const company = await companyInfo(db, companyId);
  const type = id ? (await db.query('SELECT type FROM documents WHERE id = $1', [id])).rows[0]?.type : d.type;
  const isExpense = type === 'expense';
  if (!d.contactId && !isExpense) bad('Choose the customer or supplier.', 'err.contact');
  if (!d.issueDate || !DATE.test(d.issueDate)) bad('Enter the date.', 'err.date');
  if (d.dueDate && !DATE.test(d.dueDate)) bad('Some values are not in the right format.', 'err.format');
  if (d.dueDate && d.dueDate < d.issueDate!) bad('The due date cannot be before the document date.', 'err.dueDate');
  const lines = priceAll(d.lines, company.vatRate);
  const totals = documentTotals(lines);
  const head = [d.contactId || null, d.issueDate, isExpense ? null : d.dueDate || null, d.reference?.trim() || null, d.notes?.trim() || null,
    fromMinor(totals.net), fromMinor(totals.vat), fromMinor(totals.gross),
    isExpense ? d.payee?.trim() || null : null, isExpense ? d.paidFromAccountId || null : null];
  let docId = id;
  if (docId) {
    const { rowCount } = await db.query(
      `UPDATE documents SET contact_id=$2, issue_date=$3, due_date=$4, reference=$5, notes=$6, net_total=$7, vat_total=$8, gross_total=$9,
         payee=$10, paid_from_account_id=$11
       WHERE id = $1 AND company_id = $12 AND status = 'draft'`, [docId, ...head, companyId]);
    if (!rowCount) bad('Only drafts can be changed.', 'err.notDraft');
    await db.query('DELETE FROM document_lines WHERE document_id = $1', [docId]);
  } else {
    if (!d.type || !['quotation', 'invoice', 'credit_note', 'bill', 'supplier_credit', 'expense', 'claim'].includes(d.type)) bad('Choose the document type.', 'err.format');
    const { rows } = await db.query(
      `INSERT INTO documents (company_id, type, contact_id, issue_date, due_date, reference, notes, net_total, vat_total, gross_total,
         payee, paid_from_account_id, original_id, recurring_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, app_user_id()) RETURNING id`,
      [companyId, d.type, ...head, d.originalId || null, isExpense ? d.recurringId || null : null]);
    docId = rows[0].id as string;
  }
  let n = 1;
  for (const l of lines) {
    await db.query(
      `INSERT INTO document_lines (document_id, line_no, description, quantity, unit_price, account_id, cost_centre_id, vat_code, vat_rate,
         net_amount, vat_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [docId, n++, l.description, l.quantity, l.unitPrice, l.accountId, l.costCentreId || null, l.vatCode, l.vatRate, fromMinor(l.net), fromMinor(l.vat)]);
  }
  return docId!;
}

async function lockDoc(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT d.*, d.issue_date::text AS issue_day, coalesce(c.name, d.payee) AS contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = $1 FOR UPDATE OF d`, [id]);
  return rows[0] ?? notFound();
}

async function storedLines(db: Db, docId: string): Promise<PricedLine[]> {
  const { rows } = await db.query(
    `SELECT description, quantity::text, unit_price::text AS "unitPrice", account_id AS "accountId", cost_centre_id AS "costCentreId",
            vat_code AS "vatCode", vat_rate::text AS "vatRate", net_amount::text AS net, vat_amount::text AS vat
     FROM document_lines WHERE document_id = $1 ORDER BY line_no`, [docId]);
  return rows.map((r) => ({ ...r, net: toMinor(r.net), vat: toMinor(r.vat) }));
}

/** Gives the document its number, posts its journal entry and marks it issued. Never changes afterwards. */
export async function issueDocument(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.status !== 'draft') bad('This document has already been issued.', 'err.alreadyIssued');
  if (d.type === 'quotation') bad('Quotations are sent, not issued.', 'err.format');
  if (d.type === 'claim') bad('Claims are submitted and approved, not issued.', 'err.format');
  const lines = await storedLines(db, id);
  if (!lines.length) bad('Add at least one line.', 'err.noLines');
  if (d.type === 'expense' && !d.paid_from_account_id) bad('Choose the bank or cash account the expense was paid from.', 'err.bankAccount');
  if (d.type === 'expense' && !d.contact_id && !String(d.payee ?? '').trim()) bad('Enter who was paid (a supplier or a payee name).', 'err.payee');
  const company = await companyInfo(db, d.company_id);
  const number = await nextNumber(db, d.company_id, d.type, numberPrefix(d.type, company.invoicePrefix));
  const entryId = await postEntry(db, {
    companyId: d.company_id, entryDate: d.issue_day,
    memo: `${number} · ${d.contact_name}`, sourceType: d.type, sourceId: d.id,
    lines: postingFor(d.type, lines, await systemAccounts(db, d.company_id), d.paid_from_account_id ?? undefined),
  });
  await db.query(`UPDATE documents SET status = 'issued', number = $2, journal_entry_id = $3 WHERE id = $1`, [id, number, entryId]);
}

export async function setQuotationStatus(db: Db, id: string, status: 'sent' | 'accepted' | 'declined'): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'quotation') bad('Only quotations have this status.', 'err.format');
  let number = d.number;
  if (!number) {
    const company = await companyInfo(db, d.company_id);
    number = await nextNumber(db, d.company_id, 'quotation', numberPrefix('quotation', company.invoicePrefix));
    await db.query(`UPDATE documents SET status = $2, number = $3 WHERE id = $1`, [id, status, number]);
    return;
  }
  await db.query(`UPDATE documents SET status = $2 WHERE id = $1`, [id, status]);
}

/** Quotation -> new draft invoice with the same lines. */
export async function convertQuotation(db: Db, id: string): Promise<string> {
  const q = await lockDoc(db, id);
  if (q.type !== 'quotation' || !['sent', 'accepted'].includes(q.status)) bad('Send or accept the quotation first.', 'err.quoteNotSent');
  const company = await companyInfo(db, q.company_id);
  const terms = (await getContact(db, q.contact_id)).paymentTermsDays ?? company.paymentTermsDays;
  const lines = (await storedLines(db, id)).map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) =>
    ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
  const newId = await saveDraft(db, q.company_id, {
    type: 'invoice', contactId: q.contact_id, issueDate: today(), dueDate: addDays(today(), terms), reference: q.number, notes: q.notes,
    originalId: q.id, lines,
  });
  await db.query(`UPDATE documents SET status = 'invoiced' WHERE id = $1`, [id]);
  return newId;
}

/** Issued invoice (or bill) -> new draft credit note with the same lines, to be reduced as needed. */
export async function createCredit(db: Db, id: string): Promise<string> {
  const o = await lockDoc(db, id);
  if (!['invoice', 'bill'].includes(o.type) || o.status !== 'issued') bad('Only issued invoices and bills can be credited.', 'err.notIssued');
  const lines = (await storedLines(db, id)).map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) =>
    ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
  return saveDraft(db, o.company_id, {
    type: o.type === 'invoice' ? 'credit_note' : 'supplier_credit', contactId: o.contact_id, issueDate: today(), dueDate: null,
    reference: o.number, originalId: o.id, lines,
  });
}

export async function deleteDraft(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query(`DELETE FROM documents WHERE id = $1 AND status = 'draft'`, [id]);
  if (!rowCount) bad('Only drafts can be deleted.', 'err.notDraft');
}

const DOC_COLS = `d.id, d.company_id AS "companyId", d.type, d.status, d.number, d.contact_id AS "contactId", coalesce(c.name, d.payee) AS "contactName",
  c.name_ar AS "contactNameAr", d.payee, d.paid_from_account_id AS "paidFromAccountId", pa.name AS "paidFromName", pa.name_ar AS "paidFromNameAr",
  d.recurring_id AS "recurringId", d.voided_at AS "voidedAt", d.submitted_by AS "submittedBy", d.submitted_at AS "submittedAt",
  d.decided_by AS "decidedBy", d.decided_at AS "decidedAt", d.rejection_reason AS "rejectionReason",
  (SELECT full_name FROM users WHERE id = d.submitted_by) AS "submittedByName", (SELECT full_name FROM users WHERE id = d.decided_by) AS "decidedByName", d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate", d.reference, d.notes,
  d.original_id AS "originalId", d.journal_entry_id AS "journalEntryId",
  d.net_total::text AS "netTotal", d.vat_total::text AS "vatTotal", d.gross_total::text AS "grossTotal",
  document_amount_due(d.id)::numeric(18,2)::text AS "amountDue", d.created_at AS "createdAt", d.issued_at AS "issuedAt"`;

export async function listDocuments(db: Db, companyId: string, type: DocType, f: { status?: string; q?: string; contactId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${DOC_COLS} FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id
     WHERE d.company_id = $1 AND d.type = $2
       AND ($3 = '' OR coalesce(c.name, d.payee, '') ILIKE '%' || $3 || '%' OR coalesce(d.number, '') ILIKE '%' || $3 || '%' OR coalesce(d.reference, '') ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR d.contact_id = $4)
     ORDER BY (d.status = 'draft') DESC, d.issue_date DESC, d.created_at DESC LIMIT 500`,
    [companyId, type, (f.q ?? '').trim(), f.contactId || null]);
  const t = today();
  return rows.map((r) => ({ ...r, state: stateOf(r, t) })).filter((r) => !f.status || f.status === 'all' || r.state === f.status
    || (f.status === 'unpaid' && ['unpaid', 'partly_paid', 'overdue'].includes(r.state)));
}

/** draft | issued | paid | partly_paid | unpaid | overdue | credit, or a quotation's own status */
function stateOf(r: { type: DocType; status: string; amountDue: string; grossTotal: string; dueDate: string | null }, t: string): string {
  if (r.type === 'quotation' || r.type === 'expense' || r.status === 'draft' || isCredit(r.type)) return r.status;
  if (r.type === 'claim') return r.status !== 'issued' ? r.status : toMinor(r.amountDue) > 0n ? 'approved' : 'reimbursed';
  const due = toMinor(r.amountDue);
  if (due < 0n) return 'credit';
  if (due === 0n) return 'paid';
  if (r.dueDate && r.dueDate < t) return 'overdue';
  return due < toMinor(r.grossTotal) ? 'partly_paid' : 'unpaid';
}

export async function getDocument(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${DOC_COLS} FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id WHERE d.id = $1`, [id]);
  const d = rows[0] ?? notFound();
  const lines = await db.query(
    `SELECT l.id, l.line_no AS "lineNo", l.description, l.quantity::text, l.unit_price::text AS "unitPrice", l.account_id AS "accountId",
            a.code AS "accountCode", a.name AS "accountName", a.name_ar AS "accountNameAr", l.cost_centre_id AS "costCentreId",
            cc.name AS "costCentre", cc.name_ar AS "costCentreAr", l.vat_code AS "vatCode", l.vat_rate::text AS "vatRate",
            l.net_amount::text AS net, l.vat_amount::text AS vat
     FROM document_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.document_id = $1 ORDER BY l.line_no`, [id]);
  const payments = await db.query(
    `SELECT p.id, p.number, p.payment_date::text AS date, a.amount::text, p.method, p.voided_at AS "voidedAt"
     FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = $1 ORDER BY p.payment_date`, [id]);
  const related = await db.query(
    `SELECT d.id, d.type, d.status, d.number, d.issue_date::text AS "issueDate", d.gross_total::text AS "grossTotal"
     FROM documents d WHERE (d.original_id = $1 OR d.id = $2) AND d.id <> $1 ORDER BY d.created_at`, [id, d.originalId]);
  const contact = d.contactId ? await getContact(db, d.contactId) : null;
  const seller = await db.query(
    `SELECT name, name_ar AS "nameAr", vat_number AS "vatNumber", cr_number AS "crNumber", address, city, country, currency
     FROM companies WHERE id = $1`, [d.companyId]);
  return { ...d, state: stateOf(d, today()), lines: lines.rows, payments: payments.rows, related: related.rows, contact, seller: seller.rows[0] };
}

// ------------------------------------------------------------------ employee claims
/** Sends a draft claim for approval; it gets its number now and can no longer be edited. */
export async function submitClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim') bad('Only claims are submitted for approval.', 'err.format');
  if (d.status !== 'draft') bad('Only draft claims can be submitted.', 'err.notDraft');
  if (!(await storedLines(db, id)).length) bad('Add at least one line.', 'err.noLines');
  const number = d.number ?? await nextNumber(db, d.company_id, 'claim', numberPrefix('claim', ''));
  await db.query(`UPDATE documents SET status = 'submitted', number = $2 WHERE id = $1`, [id, number]);
}

/** Back to draft: a submitted claim withdrawn, or a rejected one to be corrected. */
export async function reopenClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || !['submitted', 'rejected'].includes(d.status)) bad('Only submitted or rejected claims go back to draft.', 'err.format');
  await db.query(`UPDATE documents SET status = 'draft' WHERE id = $1`, [id]);
}

/** Approves a submitted claim and posts it: Dr expenses, Dr input VAT, Cr employee claims payable. */
export async function approveClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || d.status !== 'submitted') bad('Only submitted claims can be approved.', 'err.claimNotSubmitted');
  const sys = await systemAccounts(db, d.company_id);
  if (!sys.claimsPayable) bad('This client\'s chart of accounts has no employee claims payable account (2200).', 'err.chart');
  const entryId = await postEntry(db, {
    companyId: d.company_id, entryDate: d.issue_day, memo: `${d.number} · ${d.contact_name}`, sourceType: 'claim', sourceId: d.id,
    lines: postingFor('claim', await storedLines(db, id), sys),
  });
  await db.query(`UPDATE documents SET status = 'issued', journal_entry_id = $2 WHERE id = $1`, [id, entryId]);
}

export async function rejectClaim(db: Db, id: string, reason: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || d.status !== 'submitted') bad('Only submitted claims can be rejected.', 'err.claimNotSubmitted');
  if (!reason.trim()) bad('Give a reason for rejecting the claim.', 'err.rejectReason');
  await db.query(`UPDATE documents SET status = 'rejected', rejection_reason = $2 WHERE id = $1`, [id, reason.trim().slice(0, 500)]);
}

// ------------------------------------------------------------------ payments
export interface PaymentInput {
  direction?: Direction; contactId?: string; date?: string; amount?: string; accountId?: string; method?: string; reference?: string;
  allocations?: { documentId: string; amount: string }[];
}

export async function recordPayment(db: Db, companyId: string, p: PaymentInput): Promise<string> {
  const direction = p.direction === 'made' ? 'made' : p.direction === 'received' ? 'received' : bad('Choose received or paid.', 'err.format');
  if (!p.contactId) bad('Choose the customer or supplier.', 'err.contact');
  if (!p.date || !DATE.test(p.date)) bad('Enter the date.', 'err.date');
  if (!p.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const method = PAYMENT_METHODS.includes(p.method as never) ? p.method! : 'bank_transfer';
  let amount: bigint;
  let allocs: { documentId: string; amount: bigint }[];
  try {
    amount = toMinor(String(p.amount ?? '').replace(/,/g, ''));
    allocs = (p.allocations ?? []).filter((a) => a.amount && String(a.amount).trim() !== '' && String(a.amount).trim() !== '0')
      .map((a) => ({ documentId: a.documentId, amount: toMinor(String(a.amount).replace(/,/g, '')) }));
  } catch {
    return bad('Amounts must be numbers with at most 2 decimals.', 'err.amountFormat');
  }
  if (amount <= 0n) bad('Enter the amount.', 'err.amount');
  if (allocs.some((a) => a.amount <= 0n)) bad('Amounts must be more than 0.', 'err.amount');
  if (allocs.reduce((s, a) => s + a.amount, 0n) > amount) bad('The amounts settled are more than the payment.', 'err.overAllocated');

  const id = randomUUID();
  const number = await nextNumber(db, companyId, direction === 'received' ? 'receipt' : 'payment', numberPrefix(direction === 'received' ? 'receipt' : 'payment', ''));
  const contact = await getContact(db, p.contactId!);
  const entryId = await postEntry(db, {
    companyId, entryDate: p.date!, memo: `${number} · ${contact.name}`, sourceType: direction === 'received' ? 'payment_received' : 'payment_made', sourceId: id,
    lines: postingForPayment(direction, amount, p.accountId!, await systemAccounts(db, companyId), Boolean(contact.isEmployee)),
  });
  await db.query(
    `INSERT INTO payments (id, company_id, direction, number, contact_id, payment_date, amount, account_id, method, reference, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_user_id())`,
    [id, companyId, direction, number, p.contactId, p.date, fromMinor(amount), p.accountId, method, p.reference?.trim() || null, entryId]);
  for (const a of allocs) {
    await db.query('INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES ($1, $2, $3)', [id, a.documentId, fromMinor(a.amount)]);
  }
  return id;
}

/** Voids a payment: posts the reversal and frees the documents it settled. */
export async function voidPayment(db: Db, id: string, date: string): Promise<void> {
  const { rows } = await db.query('SELECT journal_entry_id, voided_at FROM payments WHERE id = $1 FOR UPDATE', [id]);
  const p = rows[0] ?? notFound();
  if (p.voided_at) bad('This payment has already been voided.', 'err.alreadyVoided');
  const rev = await reverseEntry(db, p.journal_entry_id, date, 'Void payment');
  await db.query('UPDATE payments SET voided_at = now(), void_entry_id = $2 WHERE id = $1', [id, rev]);
}

const PAY_COLS = `p.id, p.direction, p.number, p.contact_id AS "contactId", c.name AS "contactName", p.payment_date::text AS date,
  p.amount::text, p.account_id AS "accountId", a.name AS "accountName", a.name_ar AS "accountNameAr", p.method, p.reference,
  p.voided_at AS "voidedAt", p.created_at AS "createdAt",
  (p.amount - coalesce((SELECT sum(x.amount) FROM payment_allocations x WHERE x.payment_id = p.id), 0))::numeric(18,2)::text AS unallocated`;

export async function listPayments(db: Db, companyId: string, direction: Direction, f: { q?: string; contactId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${PAY_COLS} FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id
     WHERE p.company_id = $1 AND p.direction = $2
       AND ($3 = '' OR c.name ILIKE '%' || $3 || '%' OR p.number ILIKE '%' || $3 || '%' OR coalesce(p.reference, '') ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR p.contact_id = $4)
     ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 500`, [companyId, direction, (f.q ?? '').trim(), f.contactId || null]);
  return rows;
}

export async function getPayment(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${PAY_COLS}, p.company_id AS "companyId" FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`, [id]);
  const p = rows[0] ?? notFound();
  const allocations = await db.query(
    `SELECT d.id AS "documentId", d.number, d.type, d.issue_date::text AS "issueDate", d.gross_total::text AS "grossTotal", x.amount::text
     FROM payment_allocations x JOIN documents d ON d.id = x.document_id WHERE x.payment_id = $1 ORDER BY d.issue_date`, [id]);
  return { ...p, allocations: allocations.rows };
}

/** Issued invoices (or bills) of a contact that still have something due, oldest due first. */
export async function openDocuments(db: Db, companyId: string, contactId: string, direction: Direction) {
  const { rows } = await db.query(
    `SELECT d.id, d.number, d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate", d.gross_total::text AS "grossTotal",
            document_amount_due(d.id)::numeric(18,2)::text AS "amountDue"
     FROM documents d WHERE d.company_id = $1 AND d.contact_id = $2 AND d.type = $3 AND d.status = 'issued'
       AND document_amount_due(d.id) > 0
     ORDER BY coalesce(d.due_date, d.issue_date), d.issue_date`, [companyId, contactId, direction === 'received' ? 'invoice' : (await getContact(db, contactId)).isEmployee ? 'claim' : 'bill']);
  return rows;
}

// ------------------------------------------------------------------ overview and ageing
export async function overview(db: Db, companyId: string, side: 'sales' | 'purchases') {
  const main = side === 'sales' ? 'invoice' : 'bill';
  const credit = side === 'sales' ? 'credit_note' : 'supplier_credit';
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const open = await listDocuments(db, companyId, main, { status: 'unpaid' });
  const sum = (xs: { amountDue: string }[]) => fromMinor(xs.reduce((s, x) => s + toMinor(x.amountDue), 0n));
  const month = await db.query(
    `SELECT coalesce(sum(CASE WHEN type = $2 THEN net_total ELSE -net_total END), 0)::numeric(18,2)::text AS net
     FROM documents WHERE company_id = $1 AND type IN ($2, $3) AND status = 'issued' AND issue_date >= $4`, [companyId, main, credit, monthStart]);
  const drafts = await db.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = $2 AND status = 'draft'`, [companyId, main]);
  const paid = await db.query(
    `SELECT coalesce(sum(amount), 0)::numeric(18,2)::text AS total FROM payments
     WHERE company_id = $1 AND direction = $2 AND voided_at IS NULL AND payment_date >= $3`, [companyId, side === 'sales' ? 'received' : 'made', monthStart]);
  const overdue = open.filter((d) => d.state === 'overdue');
  return {
    outstanding: sum(open), outstandingCount: open.length,
    overdue: sum(overdue), overdueCount: overdue.length,
    thisMonthNet: month.rows[0].net, paidThisMonth: paid.rows[0].total, drafts: drafts.rows[0].n,
    oldestOverdue: overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, 6),
  };
}

/** Amounts still due, per contact, by days past the due date. */
export async function aged(db: Db, companyId: string, side: 'sales' | 'purchases', asOf: string) {
  const { rows } = await db.query(
    `SELECT d.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", coalesce(d.due_date, d.issue_date)::text AS due,
            document_amount_due(d.id)::numeric(18,2)::text AS amount
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id
     WHERE d.company_id = $1 AND d.type = $2 AND d.status = 'issued' AND d.issue_date <= $3`,
    [companyId, side === 'sales' ? 'invoice' : 'bill', asOf]);
  const byContact = new Map<string, { contactId: string; name: string; nameAr: string | null; buckets: Record<AgeBucket, bigint> }>();
  for (const r of rows) {
    const amt = toMinor(r.amount);
    if (amt === 0n) continue;
    const row = byContact.get(r.contactId) ?? { contactId: r.contactId, name: r.name, nameAr: r.nameAr,
      buckets: Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0n])) as Record<AgeBucket, bigint> };
    row.buckets[ageBucket(r.due, asOf)] += amt;
    byContact.set(r.contactId, row);
  }
  const out = [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({
    contactId: r.contactId, name: r.name, nameAr: r.nameAr,
    ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, fromMinor(r.buckets[b])])),
    total: fromMinor(AGE_BUCKETS.reduce((s, b) => s + r.buckets[b], 0n)),
  }));
  return { asOf, rows: out };
}

export { sideOf };
