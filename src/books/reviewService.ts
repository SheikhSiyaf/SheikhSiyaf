// Review layer: automated checks on a month's books, queries between the firm and the client, the monthly
// checklist and period sign-off. Runs inside withUser(); db/migrations/0021_review.sql enforces who may do what.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { monthEnd } from './assets.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const monthStartOf = (pe: string) => `${pe.slice(0, 7)}-01`;
export function checkMonth(pe: unknown): string {
  const p = String(pe ?? '');
  if (!DATE.test(p) || monthEnd(p) !== p) bad('Choose the month.', 'err.date');
  return p;
}

// ------------------------------------------------------------------ automated checks
export type Severity = 'warning' | 'info';
export interface Finding { itemKey: string; date: string | null; label: string; detail: string | null; amount: string | null; link: { type: 'entry' | 'document' | 'account' | 'bank_line'; id: string; docType?: string } | null;
  explained: { note: string; by: string | null; at: string } | null }
export interface Check { key: string; severity: Severity; findings: Finding[]; open: number }
export const CHECK_KEYS = ['missing_input_vat', 'vat_without_number', 'sales_without_vat', 'duplicates', 'round_amounts', 'unreconciled', 'abnormal_balances',
  'overdue_receivables', 'drafts_left', 'payroll_missing', 'depreciation_missing'] as const;
type Row = Omit<Finding, 'explained'>;

async function company(db: Db, id: string) {
  return (await db.query(`SELECT id, country, vat_status AS "vatStatus", modules FROM companies WHERE id = $1`, [id])).rows[0] ?? notFound();
}

/** Runs every check for the month (from its first day to its last; balances at its end). */
export async function runChecks(db: Db, companyId: string, periodEnd: string): Promise<Check[]> {
  checkMonth(periodEnd);
  const co = await company(db, companyId);
  const from = monthStartOf(periodEnd), to = periodEnd;
  const q = async (sql: string, args: unknown[] = []) => (await db.query(sql, [companyId, from, to, ...args])).rows as Row[];
  const docLink = `json_build_object('type', 'document', 'id', d.id, 'docType', d.type)`;
  const registered = co.vatStatus === 'registered';
  const raw: [string, Severity, Row[]][] = [
    // Bills and expenses from a supplier with a VAT number, but with lines that carry no VAT: input VAT may be missing.
    ['missing_input_vat', 'warning', registered ? await q(
      `SELECT d.id::text AS "itemKey", d.issue_date::text AS date, coalesce(d.number, '') || ' · ' || c.name AS label, c.vat_number AS detail, d.gross_total::text AS amount, ${docLink} AS link
       FROM documents d JOIN contacts c ON c.id = d.contact_id
       WHERE d.company_id = $1 AND d.type IN ('bill', 'expense') AND d.status = 'issued' AND d.issue_date BETWEEN $2 AND $3 AND c.vat_number IS NOT NULL
         AND EXISTS (SELECT 1 FROM document_lines l WHERE l.document_id = d.id AND l.vat_code <> 'standard')
       ORDER BY d.issue_date`) : []],
    // VAT claimed on a bill or expense whose supplier has no VAT number recorded: the claim may not be allowed.
    ['vat_without_number', 'warning', registered ? await q(
      `SELECT d.id::text AS "itemKey", d.issue_date::text AS date, coalesce(d.number, '') || ' · ' || coalesce(c.name, d.payee, '') AS label, NULL AS detail, d.vat_total::text AS amount, ${docLink} AS link
       FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.company_id = $1 AND d.type IN ('bill', 'expense') AND d.status = 'issued' AND d.issue_date BETWEEN $2 AND $3 AND d.vat_total > 0
         AND (c.id IS NULL OR c.vat_number IS NULL)
       ORDER BY d.issue_date`) : []],
    // Sales invoices with zero-rated, exempt or out-of-scope lines: check the treatment is right.
    ['sales_without_vat', 'info', registered ? await q(
      `SELECT d.id::text AS "itemKey", d.issue_date::text AS date, coalesce(d.number, '') || ' · ' || c.name AS label,
              (SELECT string_agg(DISTINCT l.vat_code, ', ') FROM document_lines l WHERE l.document_id = d.id AND l.vat_code <> 'standard') AS detail, d.gross_total::text AS amount, ${docLink} AS link
       FROM documents d JOIN contacts c ON c.id = d.contact_id
       WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND d.issue_date BETWEEN $2 AND $3
         AND EXISTS (SELECT 1 FROM document_lines l WHERE l.document_id = d.id AND l.vat_code <> 'standard')
       ORDER BY d.issue_date`) : []],
    // The same supplier (or payee) and total within 7 days, or the same supplier reference twice.
    ['duplicates', 'warning', await q(
      `SELECT least(a.id, b.id)::text || '|' || greatest(a.id, b.id)::text AS "itemKey", a.issue_date::text AS date,
              coalesce(a.number, '') || ' / ' || coalesce(b.number, '') || ' · ' || coalesce(c.name, a.payee, '') AS label,
              CASE WHEN a.reference IS NOT NULL AND a.reference = b.reference THEN a.reference END AS detail, a.gross_total::text AS amount,
              json_build_object('type', 'document', 'id', a.id, 'docType', a.type) AS link
       FROM documents a JOIN documents b ON b.company_id = a.company_id AND b.id > a.id AND b.type = a.type AND b.status = 'issued'
         AND (b.contact_id IS NOT DISTINCT FROM a.contact_id) AND coalesce(b.payee, '') = coalesce(a.payee, '')
         AND ((b.gross_total = a.gross_total AND abs(b.issue_date - a.issue_date) <= 7) OR (a.reference IS NOT NULL AND b.reference = a.reference))
       LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.company_id = $1 AND a.type IN ('bill', 'expense', 'invoice') AND a.status = 'issued'
         AND (a.issue_date BETWEEN $2 AND $3 OR b.issue_date BETWEEN $2 AND $3)
       ORDER BY a.issue_date`)],
    // Manual journal entries with large round amounts (multiples of 1,000): often estimates that need support.
    ['round_amounts', 'info', await q(
      `SELECT e.id::text AS "itemKey", e.entry_date::text AS date, coalesce(e.memo, '') AS label, NULL AS detail,
              max(greatest(l.debit, l.credit))::text AS amount, json_build_object('type', 'entry', 'id', e.id) AS link
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND e.source_type IS NULL AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
       GROUP BY e.id HAVING bool_or(greatest(l.debit, l.credit) >= 1000 AND mod(greatest(l.debit, l.credit), 1000) = 0)
       ORDER BY e.entry_date`)],
    // Bank statement lines up to the month end not yet matched or booked.
    ['unreconciled', 'warning', await q(
      `SELECT s.id::text AS "itemKey", s.txn_date::text AS date, a.name || ' · ' || s.description AS label, s.reference AS detail, s.amount::text AS amount,
              json_build_object('type', 'bank_line', 'id', s.bank_account_id) AS link
       FROM bank_statement_lines s JOIN bank_accounts b ON b.id = s.bank_account_id JOIN accounts a ON a.id = b.account_id
       WHERE s.company_id = $1 AND s.status = 'open' AND s.txn_date <= $3 AND $2::date IS NOT NULL
       ORDER BY s.txn_date`)],
    // Accounts on the wrong side at the month end: assets and expenses in credit, liabilities and income in debit.
    ['abnormal_balances', 'warning', await q(
      `SELECT a.id::text AS "itemKey", NULL AS date, a.code || ' ' || a.name AS label, a.type::text AS detail, abs(b.v)::text AS amount, json_build_object('type', 'account', 'id', a.id) AS link
       FROM accounts a JOIN LATERAL (SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                                     WHERE l.account_id = a.id AND e.entry_date <= $3) b ON true
       WHERE a.company_id = $1 AND $2::date IS NOT NULL AND a.code NOT IN ('1590', '4900', '3000')
         AND ((a.type IN ('asset', 'expense') AND b.v < 0) OR (a.type IN ('liability', 'income') AND b.v > 0))
       ORDER BY a.code`)],
    // Customer invoices more than 90 days past their due date at the month end.
    ['overdue_receivables', 'info', await q(
      `SELECT d.id::text AS "itemKey", d.due_date::text AS date, coalesce(d.number, '') || ' · ' || c.name AS label, ($3::date - d.due_date)::text AS detail,
              document_amount_due(d.id)::numeric(18,2)::text AS amount, ${docLink} AS link
       FROM documents d JOIN contacts c ON c.id = d.contact_id
       WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND d.due_date < $3::date - 90 AND $2::date IS NOT NULL AND document_amount_due(d.id) > 0
       ORDER BY d.due_date`)],
    // Drafts dated in the month: invoices, bills and expenses that were never issued.
    ['drafts_left', 'info', await q(
      `SELECT d.id::text AS "itemKey", d.issue_date::text AS date, d.type::text || ' · ' || coalesce(c.name, d.payee, '') AS label, NULL AS detail, d.gross_total::text AS amount, ${docLink} AS link
       FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
       WHERE d.company_id = $1 AND d.status = 'draft' AND d.type IN ('invoice', 'bill', 'expense', 'credit_note', 'supplier_credit') AND d.issue_date BETWEEN $2 AND $3
       ORDER BY d.issue_date`)],
    // HRM: people with HR details in the month but no posted payroll for it.
    ['payroll_missing', 'warning', (co.modules ?? []).includes('HRM') ? await q(
      `SELECT $3::date::text AS "itemKey", $3::date::text AS date, count(*)::text AS label, NULL AS detail, NULL AS amount, NULL::json AS link
       FROM employee_profiles p JOIN contacts c ON c.id = p.contact_id
       WHERE p.company_id = $1 AND c.status = 'active' AND p.join_date <= $3 AND (p.leaving_date IS NULL OR p.leaving_date >= $2)
         AND NOT EXISTS (SELECT 1 FROM payroll_runs r WHERE r.company_id = $1 AND r.period_end = $3 AND r.status <> 'draft')
       HAVING count(*) > 0`) : []],
    // Assets: depreciation due for the month but not run.
    ['depreciation_missing', 'warning', (co.modules ?? []).includes('Assets') ? await q(
      `SELECT $3::date::text AS "itemKey", $3::date::text AS date, count(*)::text AS label, NULL AS detail, sum(depreciation_due(f.id, $3::date))::numeric(18,2)::text AS amount, NULL::json AS link
       FROM fixed_assets f WHERE f.company_id = $1 AND f.status = 'active' AND $2::date IS NOT NULL AND depreciation_due(f.id, $3::date) > 0
         AND NOT EXISTS (SELECT 1 FROM depreciation_runs r WHERE r.company_id = $1 AND r.period_end = $3)
       HAVING count(*) > 0`) : []],
  ];
  const explained = new Map((await db.query(
    `SELECT check_key || '#' || item_key AS k, note, person_name(by_user) AS by, at FROM review_explained WHERE company_id = $1`, [companyId])).rows.map((r) => [r.k, r]));
  return raw.map(([key, severity, rows]) => {
    const findings = rows.map((r) => {
      const e = explained.get(`${key}#${r.itemKey}`);
      return { ...r, explained: e ? { note: e.note, by: e.by, at: e.at } : null };
    });
    return { key, severity, findings, open: findings.filter((f) => !f.explained).length };
  });
}

/** Marks a finding as explained (it stays listed, no longer counted as open), or clears the explanation. */
export async function explain(db: Db, companyId: string, x: { check?: string; item?: string; note?: string | null }) {
  if (!CHECK_KEYS.includes(x.check as (typeof CHECK_KEYS)[number]) || !t(x.item)) bad('Choose the finding.', 'err.format');
  if (!t(x.note)) {
    await db.query('DELETE FROM review_explained WHERE company_id = $1 AND check_key = $2 AND item_key = $3', [companyId, x.check, x.item]);
    return;
  }
  await db.query(`INSERT INTO review_explained (company_id, check_key, item_key, note, by_user) VALUES ($1,$2,$3,$4, app_user_id())
    ON CONFLICT (company_id, check_key, item_key) DO UPDATE SET note = $4`, [companyId, x.check, x.item, t(x.note)]);
}

// ------------------------------------------------------------------ queries
const QUERY_COLS = `q.id, q.period_end::text AS "periodEnd", q.subject, q.about_type AS "aboutType", q.about_id AS "aboutId", q.about_label AS "aboutLabel", q.status,
  person_name(q.raised_by) AS "raisedBy", q.raised_at AS "raisedAt", person_name(q.closed_by) AS "closedBy", q.closed_at AS "closedAt",
  (SELECT count(*) FROM review_messages m WHERE m.query_id = q.id)::int AS messages,
  (SELECT m.created_at FROM review_messages m WHERE m.query_id = q.id ORDER BY m.created_at DESC LIMIT 1) AS "lastAt"`;

export async function listQueries(db: Db, companyId: string, f: { status?: string; periodEnd?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${QUERY_COLS} FROM review_queries q WHERE q.company_id = $1
       AND ($2 = '' OR ($2 = 'unresolved' AND q.status <> 'closed') OR q.status = $2) AND ($3::date IS NULL OR q.period_end = $3)
     ORDER BY q.status = 'closed', coalesce((SELECT max(m.created_at) FROM review_messages m WHERE m.query_id = q.id), q.raised_at) DESC`,
    [companyId, f.status ?? '', f.periodEnd && DATE.test(f.periodEnd) ? f.periodEnd : null]);
  return rows;
}
export async function getQuery(db: Db, id: string) {
  const q = (await db.query(`SELECT ${QUERY_COLS}, q.company_id AS "companyId" FROM review_queries q WHERE q.id = $1`, [id])).rows[0] ?? notFound();
  const messages = (await db.query(
    `SELECT m.id, m.body, m.created_at AS "createdAt", person_name(m.author) AS author, m.author = app_user_id() AS mine,
            review_from_firm(m.company_id, m.author) AS "fromFirm"
     FROM review_messages m WHERE m.query_id = $1 ORDER BY m.created_at`, [id])).rows;
  return { ...q, messages };
}
export async function raiseQuery(db: Db, companyId: string, x: { periodEnd?: string; subject?: string; body?: string; aboutType?: string; aboutId?: string; aboutLabel?: string }): Promise<string> {
  const pe = checkMonth(x.periodEnd);
  const subject = t(x.subject) ?? bad('Enter what the question is about.', 'err.querySubject');
  const body = t(x.body) ?? bad('Write the question.', 'err.queryBody');
  const aboutType = ['entry', 'document', 'account', 'bank_line', 'check'].includes(String(x.aboutType)) ? x.aboutType : null;
  const id = (await db.query(`INSERT INTO review_queries (company_id, period_end, subject, about_type, about_id, about_label, raised_by) VALUES ($1,$2,$3,$4,$5,$6, app_user_id()) RETURNING id`,
    [companyId, pe, subject, aboutType, aboutType ? t(x.aboutId) : null, aboutType ? t(x.aboutLabel) : null])).rows[0].id;
  await db.query('INSERT INTO review_messages (company_id, query_id, author, body) VALUES ($1, $2, app_user_id(), $3)', [companyId, id, body]);
  return id;
}
export async function reply(db: Db, id: string, body: unknown) {
  const q = await getQuery(db, id);
  const text = t(body) ?? bad('Write the reply.', 'err.queryBody');
  if (q.status === 'closed') bad('This query is closed. Reopen it to reply.', 'err.queryClosed');
  await db.query('INSERT INTO review_messages (company_id, query_id, author, body) VALUES ($1, $2, app_user_id(), $3)', [q.companyId, id, text]);
}
export async function setQueryStatus(db: Db, id: string, status: string) {
  if (status !== 'closed' && status !== 'open') bad('Choose close or reopen.', 'err.format');
  const { rowCount } = await db.query('UPDATE review_queries SET status = $2 WHERE id = $1', [id, status]);
  if (!rowCount) bad('Only the accounting firm closes or reopens a query.', 'err.queryFirmOnly');
}

// ------------------------------------------------------------------ checklist
export const CHECKLIST = ['bank_reconciled', 'sales_complete', 'purchases_complete', 'drafts_cleared', 'vat_reviewed', 'payroll_posted', 'depreciation_run',
  'stock_counted', 'receivables_reviewed', 'payables_reviewed', 'accruals', 'queries_closed'] as const;
type Item = (typeof CHECKLIST)[number];

/** The month's checklist: items the books can answer are ticked automatically; the rest are ticked by the firm. */
export async function checklist(db: Db, companyId: string, periodEnd: string) {
  checkMonth(periodEnd);
  const co = await company(db, companyId);
  const mods: string[] = co.modules ?? [];
  const from = monthStartOf(periodEnd);
  const one = async (sql: string) => (await db.query(sql, [companyId, from, periodEnd])).rows[0].v as boolean;
  const auto: Partial<Record<Item, boolean>> = {
    bank_reconciled: await one(`SELECT NOT EXISTS (SELECT 1 FROM bank_statement_lines WHERE company_id = $1 AND status = 'open' AND txn_date <= $3 AND $2::date IS NOT NULL) AS v`),
    drafts_cleared: await one(`SELECT NOT EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND status = 'draft' AND type IN ('invoice', 'bill', 'expense', 'credit_note', 'supplier_credit') AND issue_date BETWEEN $2 AND $3) AS v`),
    queries_closed: await one(`SELECT NOT EXISTS (SELECT 1 FROM review_queries WHERE company_id = $1 AND period_end = $3 AND status <> 'closed' AND $2::date IS NOT NULL) AS v`),
    ...(mods.includes('HRM') ? { payroll_posted: await one(`SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE company_id = $1 AND period_end = $3 AND status <> 'draft' AND $2::date IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM employee_profiles WHERE company_id = $1 AND join_date <= $3) AS v`) } : {}),
    ...(mods.includes('Assets') ? { depreciation_run: await one(`SELECT EXISTS (SELECT 1 FROM depreciation_runs WHERE company_id = $1 AND period_end = $3 AND $2::date IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM fixed_assets WHERE company_id = $1 AND status = 'active') AS v`) } : {}),
  };
  const applies = (i: Item) => (i === 'payroll_posted' ? mods.includes('HRM') : i === 'depreciation_run' ? mods.includes('Assets')
    : i === 'stock_counted' ? mods.includes('Inventory') || mods.includes('Restaurant') : i === 'vat_reviewed' ? co.vatStatus === 'registered' : true);
  const ticks = new Map((await db.query(`SELECT item, done, note, person_name(done_by) AS by, done_at AS at FROM review_checklist WHERE company_id = $1 AND period_end = $2`,
    [companyId, periodEnd])).rows.map((r) => [r.item, r]));
  const items = CHECKLIST.filter(applies).map((item) => {
    const tick = ticks.get(item);
    const automatic = auto[item];
    return { item, auto: automatic ?? null, ticked: tick?.done ?? false, note: tick?.note ?? null, by: tick?.done ? tick.by : null, at: tick?.done ? tick.at : null,
      done: Boolean(automatic) || Boolean(tick?.done) };
  });
  return { periodEnd, items, done: items.filter((i) => i.done).length, total: items.length };
}
export async function tick(db: Db, companyId: string, periodEnd: string, item: string, done: boolean, note?: string | null) {
  checkMonth(periodEnd);
  if (!CHECKLIST.includes(item as Item)) bad('Choose the checklist item.', 'err.format');
  await db.query(`INSERT INTO review_checklist (company_id, period_end, item, done, note, done_by) VALUES ($1,$2,$3,$4,$5, app_user_id())
    ON CONFLICT (company_id, period_end, item) DO UPDATE SET done = $4, note = $5`, [companyId, periodEnd, item, done, t(note)]);
}

// ------------------------------------------------------------------ sign-off
/** The last 12 months with their review state. */
export async function months(db: Db, companyId: string, upTo: string) {
  const out = [];
  let pe = checkMonth(upTo);
  for (let i = 0; i < 12; i++) {
    const s = (await db.query(
      `SELECT s.id, s.note, person_name(s.signed_by) AS "signedBy", s.signed_at AS "signedAt",
              (SELECT count(*) FROM journal_entries e WHERE e.company_id = s.company_id AND e.entry_date <= s.period_end AND e.entry_date >= $3 AND e.created_at > s.signed_at)::int AS "changedAfter"
       FROM review_signoffs s WHERE s.company_id = $1 AND s.period_end = $2 AND s.withdrawn_at IS NULL`, [companyId, pe, monthStartOf(pe)])).rows[0] ?? null;
    const withdrawn = (await db.query(
      `SELECT person_name(withdrawn_by) AS by, withdrawn_at AS at, withdraw_reason AS reason FROM review_signoffs WHERE company_id = $1 AND period_end = $2 AND withdrawn_at IS NOT NULL
       ORDER BY withdrawn_at DESC LIMIT 1`, [companyId, pe])).rows[0] ?? null;
    const queries = (await db.query(`SELECT count(*) FILTER (WHERE status <> 'closed')::int AS open, count(*)::int AS total FROM review_queries WHERE company_id = $1 AND period_end = $2`, [companyId, pe])).rows[0];
    out.push({ periodEnd: pe, signoff: s, lastWithdrawn: withdrawn, openQueries: queries.open, queries: queries.total });
    pe = new Date(Date.UTC(+pe.slice(0, 4), +pe.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
  }
  return out;
}

export async function signOff(db: Db, companyId: string, periodEnd: string, note?: string | null): Promise<string> {
  checkMonth(periodEnd);
  const cl = await checklist(db, companyId, periodEnd);
  const missing = cl.items.filter((i) => !i.done).map((i) => i.item);
  if (missing.length) bad('Finish the checklist before signing off.', 'err.checklistOpen', missing);
  const open = (await db.query(`SELECT count(*)::int AS n FROM review_queries WHERE company_id = $1 AND period_end = $2 AND status <> 'closed'`, [companyId, periodEnd])).rows[0].n;
  if (open) bad('Close this month\'s queries before signing it off.', 'err.queriesOpen');
  return (await db.query(`INSERT INTO review_signoffs (company_id, period_end, note, signed_by) VALUES ($1,$2,$3, app_user_id()) RETURNING id`, [companyId, periodEnd, t(note)])).rows[0].id;
}
export async function withdraw(db: Db, id: string, reason: unknown) {
  const r = t(reason) ?? bad('Say why the sign-off is withdrawn.', 'err.withdrawReason');
  const { rowCount } = await db.query('UPDATE review_signoffs SET withdraw_reason = $2, withdrawn_by = app_user_id(), withdrawn_at = now() WHERE id = $1 AND withdrawn_at IS NULL', [id, r]);
  if (!rowCount) bad('Only a partner or reviewer withdraws a sign-off.', 'err.signoffRole');
}
export const reviewedUpTo = async (db: Db, companyId: string) =>
  (await db.query(`SELECT period_end::text AS "periodEnd", signed_by AS "signedBy", signed_at AS "signedAt" FROM reviewed_up_to($1)`, [companyId])).rows[0] ?? null;

/** One month at a glance: checks with open findings, checklist progress, queries and sign-off. */
export async function overview(db: Db, companyId: string, periodEnd: string) {
  const checks = await runChecks(db, companyId, periodEnd);
  const cl = await checklist(db, companyId, periodEnd);
  const [m] = await months(db, companyId, periodEnd);
  return { periodEnd, checks: checks.map((c) => ({ key: c.key, severity: c.severity, open: c.open, total: c.findings.length })),
    openFindings: checks.reduce((s, c) => s + c.open, 0), checklist: { done: cl.done, total: cl.total }, ...m, reviewedUpTo: await reviewedUpTo(db, companyId) };
}
