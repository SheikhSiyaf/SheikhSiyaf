// Ledger reports (from posted journal lines) and projects.
//   * Account ledger: every line on one account, with opening balance and running balance.
//   * Cost centre ledger: every line tagged with one cost centre (a branch or a project).
//   * Contact ledgers: what a customer owes, what is owed to a supplier, what is owed to an employee
//     for their claims, built from the control account (receivables, payables, claims payable) lines
//     whose entries come from that contact's documents and payments (and their reversals).
import type { Db } from '../db/session.js';
import { fromMinor, toMinor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };

interface Row { date: string; entryId: string; memo: string | null; sourceType: string | null; sourceId: string | null; account?: string;
  accountCode?: string; accountName?: string; accountNameAr?: string | null; costCentre?: string | null; costCentreAr?: string | null; debit: string; credit: string }

/** Adds a running balance. `sign` 1 = debit balance (assets, expenses, customers); -1 = credit balance. */
function withRunning<T extends { debit: string; credit: string }>(opening: bigint, rows: T[], sign: 1n | -1n) {
  let bal = opening;
  const out = rows.map((r) => {
    bal += sign * (toMinor(r.debit) - toMinor(r.credit));
    return { ...r, balance: fromMinor(bal) };
  });
  const totals = rows.reduce((t, r) => ({ debit: t.debit + toMinor(r.debit), credit: t.credit + toMinor(r.credit) }), { debit: 0n, credit: 0n });
  return { opening: fromMinor(opening), rows: out, closing: fromMinor(bal), totalDebit: fromMinor(totals.debit), totalCredit: fromMinor(totals.credit) };
}

const LINE_COLS = `e.entry_date::text AS date, e.id AS "entryId", e.memo, e.source_type AS "sourceType", e.source_id AS "sourceId",
  a.code AS "accountCode", a.name AS "accountName", a.name_ar AS "accountNameAr", cc.name AS "costCentre", cc.name_ar AS "costCentreAr",
  l.debit::text, l.credit::text`;

export async function accountLedger(db: Db, companyId: string, accountId: string, from: string, to: string) {
  const acct = (await db.query('SELECT id, code, name, name_ar AS "nameAr", type FROM accounts WHERE id = $1 AND company_id = $2', [accountId, companyId])).rows[0] ?? notFound();
  const sign: 1n | -1n = ['asset', 'expense'].includes(acct.type) ? 1n : -1n;
  const open = (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND e.entry_date < $2`, [accountId, from])).rows[0].v;
  const { rows } = await db.query<Row>(
    `SELECT ${LINE_COLS} FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.created_at, l.debit DESC`, [accountId, from, to]);
  return { account: acct, from, to, ...withRunning(sign * toMinor(open), rows, sign) };
}

export async function costCentreLedger(db: Db, companyId: string, costCentreId: string, from: string, to: string) {
  const cc = (await db.query(`SELECT id, name, name_ar AS "nameAr", kind, budget::text FROM cost_centres WHERE id = $1 AND company_id = $2`, [costCentreId, companyId])).rows[0] ?? notFound();
  const { rows } = await db.query<Row & { accountType: string }>(
    `SELECT ${LINE_COLS}, a.type AS "accountType" FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.cost_centre_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND e.source_type IS DISTINCT FROM 'year_end_close' ORDER BY e.entry_date, e.created_at, a.code`, [costCentreId, from, to]);
  let income = 0n, expense = 0n;
  for (const r of rows) {
    if (r.accountType === 'income') income += toMinor(r.credit) - toMinor(r.debit);
    if (r.accountType === 'expense') expense += toMinor(r.debit) - toMinor(r.credit);
  }
  return { costCentre: cc, from, to, rows, income: fromMinor(income), expense: fromMinor(expense), profit: fromMinor(income - expense) };
}

/** Customer, supplier or employee ledger with running balance (what they owe us, or what we owe them). */
export async function contactLedger(db: Db, companyId: string, contactId: string, from: string, to: string) {
  const c = (await db.query(
    `SELECT id, name, name_ar AS "nameAr", is_customer AS "isCustomer", is_supplier AS "isSupplier", is_employee AS "isEmployee"
     FROM contacts WHERE id = $1 AND company_id = $2`, [contactId, companyId])).rows[0] ?? notFound();
  const code = c.isEmployee ? SYSTEM_ACCOUNTS.claimsPayable : c.isCustomer ? SYSTEM_ACCOUNTS.receivables : SYSTEM_ACCOUNTS.payables;
  const control = (await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code])).rows[0] ?? bad(`No account ${code}.`, 'err.chart');
  const sign: 1n | -1n = c.isCustomer && !c.isEmployee ? 1n : -1n;
  const sourceFilter = `(e.source_id IN (SELECT id FROM documents WHERE contact_id = $2) OR e.source_id IN (SELECT id FROM payments WHERE contact_id = $2))`;
  const open = (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND ${sourceFilter} AND e.entry_date < $3`, [control.id, contactId, from])).rows[0].v;
  const { rows } = await db.query<Row>(
    `SELECT ${LINE_COLS},
            coalesce((SELECT number FROM documents WHERE id = e.source_id), (SELECT number FROM payments WHERE id = e.source_id)) AS number
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.account_id = $1 AND ${sourceFilter} AND e.entry_date BETWEEN $3 AND $4 ORDER BY e.entry_date, e.created_at`,
    [control.id, contactId, from, to]);
  return { contact: c, from, to, ...withRunning(sign * toMinor(open), rows, sign) };
}

/** Balances for every customer, supplier or employee, as of a date (for the ledger lists). */
export async function contactBalances(db: Db, companyId: string, role: 'customer' | 'supplier' | 'employee', asOf: string) {
  const code = role === 'employee' ? SYSTEM_ACCOUNTS.claimsPayable : role === 'customer' ? SYSTEM_ACCOUNTS.receivables : SYSTEM_ACCOUNTS.payables;
  const flag = { customer: 'is_customer', supplier: 'is_supplier', employee: 'is_employee' }[role];
  const sign = role === 'customer' ? '' : '-';
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.name_ar AS "nameAr", c.employee_no AS "employeeNo", c.status,
       (${sign}coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id AND a.code = $3
        WHERE e.company_id = $1 AND e.entry_date <= $2
          AND (e.source_id IN (SELECT id FROM documents WHERE contact_id = c.id) OR e.source_id IN (SELECT id FROM payments WHERE contact_id = c.id))), 0))::numeric(18,2)::text AS balance
     FROM contacts c WHERE c.company_id = $1 AND c.${flag} ORDER BY c.status, c.name`, [companyId, asOf, code]);
  return rows;
}

// ------------------------------------------------------------------ projects (cost centres of kind 'project')
export interface ProjectInput {
  name?: string; nameAr?: string; contactId?: string | null; budget?: string | null; startDate?: string | null; endDate?: string | null;
  status?: 'active' | 'closed'; description?: string | null;
}

export async function listProjects(db: Db, companyId: string, from?: string, to?: string) {
  const { rows } = await db.query(
    `SELECT cc.id, cc.name, cc.name_ar AS "nameAr", cc.status, cc.budget::text, cc.start_date::text AS "startDate", cc.end_date::text AS "endDate",
            cc.contact_id AS "contactId", c.name AS "customerName", c.name_ar AS "customerNameAr",
            coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0)::numeric(18,2)::text AS income,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)::numeric(18,2)::text AS expense
     FROM cost_centres cc LEFT JOIN contacts c ON c.id = cc.contact_id
     LEFT JOIN journal_lines l ON l.cost_centre_id = cc.id
     LEFT JOIN journal_entries e ON e.id = l.entry_id
     LEFT JOIN accounts a ON a.id = l.account_id
     WHERE cc.company_id = $1 AND cc.kind = 'project' AND (l.id IS NULL OR (e.entry_date >= coalesce($2::date, '-infinity') AND e.entry_date <= coalesce($3::date, 'infinity') AND e.source_type IS DISTINCT FROM 'year_end_close'))
     GROUP BY cc.id, c.name, c.name_ar ORDER BY cc.status, cc.name`, [companyId, from ?? null, to ?? null]);
  return rows.map((r) => ({ ...r, profit: fromMinor(toMinor(r.income) - toMinor(r.expense)),
    budgetUsed: r.budget && toMinor(r.budget) > 0n ? Number((toMinor(r.expense) * 1000n) / toMinor(r.budget)) / 10 : null }));
}

export async function getProject(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT cc.id, cc.company_id AS "companyId", cc.name, cc.name_ar AS "nameAr", cc.status, cc.budget::text, cc.start_date::text AS "startDate",
            cc.end_date::text AS "endDate", cc.contact_id AS "contactId", cc.description, c.name AS "customerName"
     FROM cost_centres cc LEFT JOIN contacts c ON c.id = cc.contact_id WHERE cc.id = $1 AND cc.kind = 'project'`, [id]);
  return rows[0] ?? notFound();
}

export async function saveProject(db: Db, companyId: string, p: ProjectInput, id?: string): Promise<string> {
  const name = String(p.name ?? '').trim();
  if (!name) bad('Enter the project name.', 'err.projectName');
  let budget: string | null = null;
  if (p.budget !== undefined && p.budget !== null && String(p.budget).trim() !== '') {
    try { budget = fromMinor(toMinor(String(p.budget).replace(/,/g, '').trim())); } catch { bad('The budget must be a number with up to 2 decimals.', 'err.amountFormat'); }
    if (toMinor(budget!) < 0n) bad('The budget cannot be negative.', 'err.amountFormat');
  }
  if (p.startDate && p.endDate && p.endDate < p.startDate) bad('The end date cannot be before the start date.', 'err.endDate');
  const v = [name, p.nameAr?.trim() || null, p.contactId || null, budget, p.startDate || null, p.endDate || null,
    p.status === 'closed' ? 'closed' : 'active', p.description?.trim() || null];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE cost_centres SET name=$2, name_ar=$3, contact_id=$4, budget=$5, start_date=$6, end_date=$7, status=$8, description=$9
       WHERE id = $1 AND company_id = $10 AND kind = 'project'`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  const { rows } = await db.query(
    `INSERT INTO cost_centres (company_id, kind, name, name_ar, contact_id, budget, start_date, end_date, status, description)
     VALUES ($1, 'project', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [companyId, ...v]);
  return rows[0].id;
}
