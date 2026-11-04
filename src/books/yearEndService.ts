// Year-end closing (db/migrations/0030_year_end.sql). Runs inside withUser(); the database checks the partner role,
// the order of years and the locks.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor } from '../money.js';
import { fyStart } from './reportsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const RETAINED_EARNINGS = '3100';
const today = () => new Date().toISOString().slice(0, 10);

/** Every financial year from the first posting to the current one, with its result and whether it is closed. */
export async function years(db: Db, companyId: string) {
  const first = (await db.query(`SELECT min(entry_date)::text AS d FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].d as string | null;
  const closings = (await db.query(`SELECT id, start_date::text AS "startDate", end_date::text AS "endDate", status, profit::text, person_name(closed_by) AS "closedBy", closed_at AS "closedAt",
      person_name(reopened_by) AS "reopenedBy", reopened_at AS "reopenedAt", reopen_reason AS "reopenReason", entry_id AS "entryId"
    FROM fiscal_years WHERE company_id = $1 ORDER BY end_date DESC, closed_at DESC`, [companyId])).rows;
  const out = [];
  let start = await fyStart(db, companyId, first ?? today());
  const lastStart = await fyStart(db, companyId, today());
  for (let i = 0; start <= lastStart && i < 50; i++) {
    const end = addDays(await fyStart(db, companyId, addDays(start, 370)), -1);
    const pnl = (await db.query('SELECT profit::text FROM profit_and_loss($1, $2, $3)', [companyId, start, end])).rows[0].profit as string;
    const closed = closings.find((c) => c.endDate === end && c.status === 'closed') ?? null;
    out.push({ startDate: start, endDate: end, profit: pnl, ended: end < today(), closed, history: closings.filter((c) => c.endDate === end && c.status !== 'closed') });
    start = addDays(end, 1);
  }
  out.reverse();
  // The year that can be closed next: the oldest ended year still open, with every year before it closed.
  const open = [...out].reverse().find((y) => !y.closed);
  return { years: out, nextToClose: open && open.ended ? open.endDate : null };
}

/** What closing the year would post: each income and expense balance (per cost centre) against retained earnings. */
export async function preview(db: Db, companyId: string, endDate: string) {
  if (!DATE.test(endDate)) bad('Choose the year.', 'err.date');
  const start = await fyStart(db, companyId, endDate);
  const lines = (await db.query(
    `SELECT a.id AS "accountId", a.code, a.name, a.name_ar AS "nameAr", a.type, l.cost_centre_id AS "costCentreId", cc.name AS "costCentre",
            sum(l.debit - l.credit)::numeric(18,2)::text AS balance
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense') AND e.source_type IS DISTINCT FROM 'year_end_close'
     GROUP BY a.id, l.cost_centre_id, cc.name HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code, cc.name NULLS FIRST`, [companyId, start, endDate])).rows;
  const profit = -lines.reduce<bigint>((t, l) => t + toMinor(l.balance as string), 0n);
  const openMonths = (await db.query(`SELECT count(*)::int AS n FROM periods WHERE company_id = $1 AND start_date BETWEEN $2 AND $3 AND locked_at IS NULL`, [companyId, start, endDate])).rows[0].n;
  const drafts = (await db.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND status = 'draft' AND issue_date BETWEEN $2 AND $3`, [companyId, start, endDate])).rows[0].n;
  return { startDate: start, endDate, lines, profit: fromMinor(profit), openMonths, drafts, retainedCode: RETAINED_EARNINGS };
}

async function retainedAccount(db: Db, companyId: string): Promise<string> {
  const r = (await db.query('SELECT id, type FROM accounts WHERE company_id = $1 AND code = $2', [companyId, RETAINED_EARNINGS])).rows[0];
  if (r && r.type !== 'equity') bad(`Account ${RETAINED_EARNINGS} is used for something else. Retained earnings need account ${RETAINED_EARNINGS}.`, 'err.retainedTaken');
  return r?.id ?? (await db.query(`INSERT INTO accounts (company_id, code, name, name_ar, type) VALUES ($1, $2, 'Retained earnings', 'الأرباح المبقاة', 'equity') RETURNING id`,
    [companyId, RETAINED_EARNINGS])).rows[0].id;
}

/** Closes the year: posts the closing entry on the year end and locks every month of the year. */
export async function close(db: Db, companyId: string, endDate: string): Promise<{ id: string; entryId: string | null }> {
  const { years: ys, nextToClose } = await years(db, companyId);
  if (!ys.some((y) => y.endDate === endDate)) bad('Choose the year.', 'err.date');
  if (ys.find((y) => y.endDate === endDate)!.closed) bad('This year is already closed.', 'err.yearClosed');
  if (endDate >= today()) bad('A year is closed after it has ended.', 'err.yearNotEnded');
  if (nextToClose !== endDate) bad('Close the earlier years first.', 'err.yearOrder');
  const role = (await db.query(`SELECT app_has_role($1, ARRAY['partner']::user_role[]) AS ok`, [companyId])).rows[0].ok;
  if (!role) throw new HttpError(403, 'Only the Firm partner closes or reopens a year.', 'err.yearPartner');
  const p = await preview(db, companyId, endDate);
  const id = randomUUID();
  // The year-end month is opened for the closing entry, then every month of the year is locked.
  await db.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date AND locked_at IS NOT NULL`, [companyId, endDate]);
  let entryId: string | null = null;
  if (p.lines.length) {
    const re = await retainedAccount(db, companyId);
    const profit = toMinor(p.profit);
    entryId = await postEntry(db, {
      companyId, entryDate: endDate, memo: `Year-end closing ${p.startDate} – ${endDate}`, sourceType: 'year_end_close', sourceId: id,
      lines: [
        ...p.lines.map((l) => { const b = toMinor(l.balance); return b > 0n ? { accountId: l.accountId, costCentreId: l.costCentreId, credit: fromMinor(b) } : { accountId: l.accountId, costCentreId: l.costCentreId, debit: fromMinor(-b) }; }),
        profit >= 0n ? { accountId: re, credit: fromMinor(profit) } : { accountId: re, debit: fromMinor(-profit) },
      ].filter((l) => (l as { debit?: string }).debit !== '0.00' && (l as { credit?: string }).credit !== '0.00'),
    });
  }
  await db.query(`INSERT INTO fiscal_years (id, company_id, start_date, end_date, profit, entry_id, closed_by) VALUES ($1,$2,$3,$4,$5,$6, app_user_id())`,
    [id, companyId, p.startDate, endDate, p.profit, entryId]);
  await db.query(`UPDATE periods SET locked_at = now() WHERE company_id = $1 AND start_date BETWEEN $2 AND $3 AND locked_at IS NULL`, [companyId, p.startDate, endDate]);
  return { id, entryId };
}

/** Reopens a closed year (the latest closed one): its closing entry is reversed on the year end. Months stay locked until unlocked. */
export async function reopen(db: Db, id: string, reason: string): Promise<void> {
  const y = (await db.query(`SELECT company_id, end_date::text AS e, entry_id, status FROM fiscal_years WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? notFound();
  if (y.status !== 'closed') bad('This year is not closed.', 'err.yearNotClosed');
  if (!String(reason ?? '').trim()) bad('Say why the year is reopened.', 'err.reopenReason');
  await db.query(`UPDATE fiscal_years SET status = 'reopened', reopen_reason = $2 WHERE id = $1`, [id, reason.trim()]);
  if (y.entry_id) {
    await db.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`, [y.company_id, y.e]);
    const rev = (await db.query('SELECT reverse_entry($1, $2, $3) AS id', [y.entry_id, y.e, `Reopening: reversal of year-end closing ${y.e}`])).rows[0].id;
    await db.query(`UPDATE periods SET locked_at = now() WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`, [y.company_id, y.e]);
    await db.query(`UPDATE fiscal_years SET reopen_entry_id = $2 WHERE id = $1`, [id, rev]);
  }
}
