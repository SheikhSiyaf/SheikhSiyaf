// Expenses: voiding, recurring expense templates, categories (expense accounts), overview and reports.
// Drafts, recording and listing reuse documentsService (an expense is a document of type 'expense').
import type { Db } from '../db/session.js';
import { reverseEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { saveDraft } from './documentsService.js';
import { nextOccurrence, priceLine, VAT_CODES, type Frequency, type LineInput } from './documents.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

/** Voids a recorded expense: posts the reversing entry and marks it voided. Nothing else changes. */
export async function voidExpense(db: Db, id: string, date: string): Promise<void> {
  const { rows } = await db.query(`SELECT type, status, journal_entry_id FROM documents WHERE id = $1 FOR UPDATE`, [id]);
  const d = rows[0] ?? notFound();
  if (d.type !== 'expense') bad('Only expenses can be voided. Use a credit note for invoices and bills.', 'err.format');
  if (d.status === 'voided') bad('This expense has already been voided.', 'err.alreadyVoided');
  if (d.status !== 'issued') bad('Only recorded expenses can be voided. Delete the draft instead.', 'err.notIssued');
  const rev = await reverseEntry(db, d.journal_entry_id, date, 'Void expense');
  await db.query(`UPDATE documents SET status = 'voided', voided_at = now(), void_entry_id = $2 WHERE id = $1`, [id, rev]);
}

// ------------------------------------------------------------------ recurring expenses
const FREQS: Frequency[] = ['weekly', 'monthly', 'quarterly', 'yearly'];
export { nextOccurrence, type Frequency };

export interface RecurringInput {
  name?: string; contactId?: string | null; payee?: string | null; paidFromAccountId?: string; frequency?: string;
  nextDate?: string; endDate?: string | null; active?: boolean; reference?: string | null; lines?: LineInput[];
}

const REC_COLS = `r.id, r.name, r.contact_id AS "contactId", coalesce(c.name, r.payee) AS "payeeName", r.payee, r.paid_from_account_id AS "paidFromAccountId",
  a.name AS "paidFromName", a.name_ar AS "paidFromNameAr", r.frequency, r.next_date::text AS "nextDate", r.end_date::text AS "endDate",
  r.active, r.lines, r.reference, (r.active AND r.next_date <= current_date AND (r.end_date IS NULL OR r.next_date <= r.end_date)) AS due`;

export async function listRecurring(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT ${REC_COLS} FROM recurring_expenses r LEFT JOIN contacts c ON c.id = r.contact_id JOIN accounts a ON a.id = r.paid_from_account_id
     WHERE r.company_id = $1 ORDER BY r.active DESC, r.next_date, r.name`, [companyId]);
  return rows.map(withTotal);
}

export async function getRecurring(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${REC_COLS}, r.company_id AS "companyId" FROM recurring_expenses r LEFT JOIN contacts c ON c.id = r.contact_id
     JOIN accounts a ON a.id = r.paid_from_account_id WHERE r.id = $1`, [id]);
  return withTotal(rows[0] ?? notFound());
}

/** Shows the template's amount (before VAT) so lists can say what will be spent. */
function withTotal<T extends { lines: { quantity: string; unitPrice: string }[] }>(r: T) {
  let net = 0n;
  for (const l of r.lines) {
    try { net += priceLine({ ...(l as LineInput), vatCode: 'out_of_scope' }, '0').net; } catch { /* checked when saved */ }
  }
  return { ...r, netAmount: fromMinor(net) };
}

export async function saveRecurring(db: Db, companyId: string, r: RecurringInput, id?: string): Promise<string> {
  const name = String(r.name ?? '').trim();
  if (!name) bad('Give the recurring expense a name.', 'err.recurringName');
  if (!r.contactId && !String(r.payee ?? '').trim()) bad('Enter who is paid (a supplier or a payee name).', 'err.payee');
  if (!r.paidFromAccountId) bad('Choose the bank or cash account it is paid from.', 'err.bankAccount');
  if (!FREQS.includes(r.frequency as Frequency)) bad('Choose how often it repeats.', 'err.frequency');
  if (!r.nextDate || !DATE.test(r.nextDate)) bad('Enter the next date.', 'err.date');
  if (r.endDate && (!DATE.test(r.endDate) || r.endDate < r.nextDate!)) bad('The end date cannot be before the next date.', 'err.endDate');
  const lines = (r.lines ?? []).map((l, i) => {
    if (!String(l.description ?? '').trim()) bad(`Line ${i + 1}: enter a description.`, 'err.lineDescription');
    if (!l.accountId) bad(`Line ${i + 1}: choose an account.`, 'err.lineAccount');
    if (!VAT_CODES.includes(l.vatCode)) bad(`Line ${i + 1}: choose the VAT treatment.`, 'err.lineVat');
    if (!/^\d{1,10}(\.\d{1,3})?$/.test(String(l.quantity)) || Number(l.quantity) <= 0) bad(`Line ${i + 1}: check the quantity.`, 'err.lineNumbers');
    try { if (toMinor(String(l.unitPrice)) < 0n) throw new Error(); } catch { bad(`Line ${i + 1}: check the price.`, 'err.lineNumbers'); }
    return { description: String(l.description).trim(), quantity: String(l.quantity), unitPrice: String(l.unitPrice), accountId: l.accountId,
      costCentreId: l.costCentreId || null, vatCode: l.vatCode };
  });
  if (!lines.length) bad('Add at least one line.', 'err.noLines');
  const anchor = Number(r.nextDate!.slice(8, 10));
  const v = [name, r.contactId || null, r.payee?.trim() || null, r.paidFromAccountId, r.frequency, r.nextDate, anchor, r.endDate || null,
    r.active !== false, JSON.stringify(lines), r.reference?.trim() || null];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE recurring_expenses SET name=$2, contact_id=$3, payee=$4, paid_from_account_id=$5, frequency=$6, next_date=$7, anchor_day=$8,
         end_date=$9, active=$10, lines=$11, reference=$12 WHERE id = $1 AND company_id = $13`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  const { rows } = await db.query(
    `INSERT INTO recurring_expenses (company_id, name, contact_id, payee, paid_from_account_id, frequency, next_date, anchor_day, end_date, active,
       lines, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, app_user_id()) RETURNING id`, [companyId, ...v]);
  return rows[0].id;
}

/**
 * Creates the draft expenses that are due (next date on or before `upTo`) and moves each template on.
 * At most 12 per template per call, so a long-forgotten template cannot flood the books.
 */
export async function generateRecurring(db: Db, companyId: string, onlyId?: string, upTo = today()): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id, contact_id, payee, paid_from_account_id, frequency, next_date::text AS next_date, anchor_day, end_date::text AS end_date,
            lines, reference, name
     FROM recurring_expenses WHERE company_id = $1 AND active AND ($2::uuid IS NULL OR id = $2) FOR UPDATE`, [companyId, onlyId ?? null]);
  const created: string[] = [];
  for (const r of rows) {
    let next: string = r.next_date;
    let n = 0;
    // "Create now" on a template that is not yet due creates its next one.
    const limit = onlyId && next > upTo ? next : upTo;
    while (next <= limit && (!r.end_date || next <= r.end_date) && n < 12) {
      created.push(await saveDraft(db, companyId, {
        type: 'expense', contactId: r.contact_id, payee: r.payee, paidFromAccountId: r.paid_from_account_id, issueDate: next,
        reference: r.reference, notes: r.name, lines: r.lines, recurringId: r.id,
      }));
      next = nextOccurrence(next, r.frequency, r.anchor_day);
      n++;
      if (onlyId) break;
    }
    const ended = r.end_date && next > r.end_date;
    await db.query(`UPDATE recurring_expenses SET next_date = $2, active = $3 WHERE id = $1`, [r.id, next, !ended]);
  }
  return created;
}

// ------------------------------------------------------------------ categories (expense accounts)
export async function categories(db: Db, companyId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.name, a.name_ar AS "nameAr", a.cost_centre_required AS "costCentreRequired",
            coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date BETWEEN $2 AND $3), 0)::numeric(18,2)::text AS spent
     FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id LEFT JOIN journal_entries e ON e.id = l.entry_id
     WHERE a.company_id = $1 AND a.type = 'expense' GROUP BY a.id ORDER BY a.code`, [companyId, from, to]);
  return rows;
}

export async function addCategory(db: Db, companyId: string, c: { name?: string; nameAr?: string; costCentreRequired?: boolean }): Promise<string> {
  const name = String(c.name ?? '').trim();
  if (!name) bad('Enter the category name.', 'err.categoryName');
  const { rows } = await db.query(
    `SELECT code FROM accounts WHERE company_id = $1 AND code ~ '^5[0-9]{3}$' ORDER BY code DESC LIMIT 1`, [companyId]);
  const last = rows[0] ? Number(rows[0].code) : 5000;
  const code = last + 100 <= 5999 ? Math.floor(last / 100) * 100 + 100 : last + 1;
  if (code > 5999) bad('There is no free expense account code left (5000-5999).', 'err.noCode');
  const r = await db.query(
    `INSERT INTO accounts (company_id, code, name, name_ar, type, cost_centre_required) VALUES ($1, $2, $3, $4, 'expense', $5) RETURNING id`,
    [companyId, String(code), name, c.nameAr?.trim() || null, Boolean(c.costCentreRequired)]);
  return r.rows[0].id;
}

// ------------------------------------------------------------------ overview and reports
export async function expenseOverview(db: Db, companyId: string) {
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const prev = new Date(`${monthStart}T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevStart = prev.toISOString().slice(0, 10);
  const prevEnd = new Date(Date.parse(`${monthStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const byCat = await categories(db, companyId, monthStart, t);
  const last = await categories(db, companyId, prevStart, prevEnd);
  const sum = (xs: { spent: string }[]) => fromMinor(xs.reduce((s, x) => s + toMinor(x.spent), 0n));
  const counts = await db.query(
    `SELECT count(*) FILTER (WHERE type = 'expense' AND status = 'draft')::int AS drafts,
            (SELECT count(*) FROM recurring_expenses r WHERE r.company_id = $1 AND r.active AND r.next_date <= current_date
               AND (r.end_date IS NULL OR r.next_date <= r.end_date))::int AS "recurringDue",
            (SELECT count(*) FROM recurring_expenses r WHERE r.company_id = $1 AND r.active)::int AS "recurringActive"
     FROM documents WHERE company_id = $1`, [companyId]);
  return {
    spentThisMonth: sum(byCat), spentLastMonth: sum(last), ...counts.rows[0],
    topCategories: byCat.filter((c) => toMinor(c.spent) > 0n).sort((a, b) => (toMinor(b.spent) > toMinor(a.spent) ? 1 : -1)).slice(0, 6),
  };
}

/** Spending per expense account, from the ledger (expenses, bills and journal entries alike). */
export async function expensesByCategory(db: Db, companyId: string, from: string, to: string) {
  const rows = (await categories(db, companyId, from, to)).filter((r) => toMinor(r.spent) !== 0n);
  return { from, to, rows, total: fromMinor(rows.reduce((s, r) => s + toMinor(r.spent), 0n)) };
}

/** Spending per supplier or payee, from bills and expenses (less supplier credits). */
export async function expensesByPayee(db: Db, companyId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT coalesce(c.name, d.payee) AS name, c.name_ar AS "nameAr", d.contact_id AS "contactId",
            count(*) FILTER (WHERE d.type <> 'supplier_credit')::int AS documents,
            sum(CASE WHEN d.type = 'supplier_credit' THEN -d.net_total ELSE d.net_total END)::numeric(18,2)::text AS net,
            sum(CASE WHEN d.type = 'supplier_credit' THEN -d.vat_total ELSE d.vat_total END)::numeric(18,2)::text AS vat,
            sum(CASE WHEN d.type = 'supplier_credit' THEN -d.gross_total ELSE d.gross_total END)::numeric(18,2)::text AS gross
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 AND d.type IN ('bill', 'expense', 'supplier_credit') AND d.status = 'issued' AND d.issue_date BETWEEN $2 AND $3
     GROUP BY coalesce(c.name, d.payee), c.name_ar, d.contact_id
     ORDER BY sum(CASE WHEN d.type = 'supplier_credit' THEN -d.net_total ELSE d.net_total END) DESC`, [companyId, from, to]);
  const total = (k: 'net' | 'vat' | 'gross') => fromMinor(rows.reduce((s, r) => s + toMinor(r[k]), 0n));
  return { from, to, rows, total: { net: total('net'), vat: total('vat'), gross: total('gross') } };
}
