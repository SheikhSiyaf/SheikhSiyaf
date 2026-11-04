// Foreign currency in the books (db/migrations/0029_multi_currency.sql): rates, the month-end revaluation and its
// settings. Every function runs inside withUser(). The daily jobs that sync rates and revalue automatically are in fxJobs.ts.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor } from '../money.js';
import { monthEnd } from './assets.js';
import { CURRENCIES, isCurrency, parseRate, rateText, revalue, type FxBalance } from './fx.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Exchange gains and losses: unrealised (restatement) and realised (on settlement). */
export const FX_ACCOUNTS = { unrealised: '4950', realised: '4951' } as const;
/** A closing rate older than this many days before the month end is shown as a warning. */
export const STALE_DAYS = 7;

const baseOf = async (db: Db, companyId: string): Promise<string> =>
  (await db.query('SELECT currency FROM companies WHERE id = $1', [companyId])).rows[0]?.currency ?? notFound();

export async function rateFor(db: Db, companyId: string, currency: string, date: string) {
  const r = (await db.query('SELECT rate::text, rate_date::text AS "rateDate", source FROM fx_rate_for($1, $2, $3)', [companyId, currency, date])).rows[0];
  return r ? { currency, rate: rateText(parseRate(r.rate)), rateDate: r.rateDate as string, source: r.source as string } : null;
}

/** Today's rate for each currency (or the latest), the company's own rates, and the currencies its accounts use. */
export async function rates(db: Db, companyId: string, asOf: string) {
  const base = await baseOf(db, companyId);
  const inUse = (await db.query('SELECT DISTINCT currency FROM accounts WHERE company_id = $1 AND currency IS NOT NULL', [companyId])).rows.map((r) => r.currency as string);
  const list = [];
  for (const c of CURRENCIES.filter((x) => x.code !== base)) list.push({ ...c, inUse: inUse.includes(c.code), latest: await rateFor(db, companyId, c.code, asOf) });
  const own = (await db.query(`SELECT id, rate_date::text AS "rateDate", currency, rate::text, person_name(created_by) AS "createdBy" FROM exchange_rates
    WHERE company_id = $1 ORDER BY rate_date DESC, currency LIMIT 100`, [companyId])).rows.map((r) => ({ ...r, rate: rateText(parseRate(r.rate)) }));
  const lastSync = (await db.query(`SELECT max(created_at) AS at FROM exchange_rates WHERE company_id IS NULL AND base = $1`, [base])).rows[0].at;
  return { base, asOf, list: list.sort((a, b) => Number(b.inUse) - Number(a.inUse)), own, lastSync, settings: await settings(db, companyId) };
}

/** The company's own rate for a day (replaces its own rate of that day). */
export async function saveRate(db: Db, companyId: string, x: { currency?: string; date?: string; rate?: string }): Promise<void> {
  if (!isCurrency(x.currency)) bad('Choose the currency.', 'err.currency');
  if (!DATE.test(String(x.date))) bad('Enter the date.', 'err.date');
  let r: bigint;
  try { r = parseRate(String(x.rate ?? '')); } catch { return bad('A rate is a number above 0 with at most 8 decimals.', 'err.rate'); }
  // The database puts the company's currency as the base (before the duplicate check), so the same day is replaced.
  await db.query(`INSERT INTO exchange_rates (company_id, rate_date, currency, base, rate, source) VALUES ($1, $2, $3, '---', $4, 'company')
    ON CONFLICT (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), rate_date, currency, base) DO UPDATE SET rate = EXCLUDED.rate`,
  [companyId, x.date, x.currency, rateText(r)]);
}

// ------------------------------------------------------------------ settings
export async function settings(db: Db, companyId: string) {
  const r = (await db.query(`SELECT auto_revalue AS "autoRevalue", person_name(enabled_by) AS "enabledBy", enabled_at AS "enabledAt", last_run AS "lastRun", last_problem AS "lastProblem"
    FROM fx_settings WHERE company_id = $1`, [companyId])).rows[0];
  return r ?? { autoRevalue: false, enabledBy: null, enabledAt: null, lastRun: null, lastProblem: null };
}
export async function saveSettings(db: Db, companyId: string, x: { autoRevalue?: boolean }): Promise<void> {
  await db.query(`INSERT INTO fx_settings (company_id, auto_revalue) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET auto_revalue = $2`, [companyId, Boolean(x.autoRevalue)]);
}

// ------------------------------------------------------------------ revaluation
/** The exchange gains and losses accounts, added to the chart when missing. */
export async function fxAccounts(db: Db, companyId: string): Promise<{ unrealised: string; realised: string }> {
  const want: [keyof typeof FX_ACCOUNTS, string, string][] = [
    ['unrealised', 'Unrealised exchange gains and losses', 'أرباح وخسائر فروقات العملة غير المحققة'],
    ['realised', 'Realised exchange gains and losses', 'أرباح وخسائر فروقات العملة المحققة'],
  ];
  const out = {} as { unrealised: string; realised: string };
  for (const [k, name, nameAr] of want) {
    const code = FX_ACCOUNTS[k];
    const r = (await db.query('SELECT id, type FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code])).rows[0];
    if (r && r.type !== 'income') bad(`Account ${code} is used for something else. Exchange gains and losses need account ${code}.`, 'err.fxAccountTaken', [code]);
    out[k] = r?.id ?? (await db.query(`INSERT INTO accounts (company_id, code, name, name_ar, type, pnl_group) VALUES ($1, $2, $3, $4, 'income', 'other_income') RETURNING id`,
      [companyId, code, name, nameAr])).rows[0].id;
  }
  return out;
}

async function balances(db: Db, companyId: string, periodEnd: string): Promise<FxBalance[]> {
  return (await db.query(
    `SELECT a.id AS "accountId", a.code, a.name, a.currency,
            coalesce(sum(CASE WHEN l.debit > 0 THEN l.fx_amount ELSE -l.fx_amount END), 0)::numeric(18,2)::text AS fx,
            coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS base
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_id = a.id AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.entry_id AND e.entry_date <= $2)
     WHERE a.company_id = $1 AND a.currency IS NOT NULL AND a.revalue
     GROUP BY a.id ORDER BY a.code`, [companyId, periodEnd])).rows
    .map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, currency: r.currency, fxBalance: toMinor(r.fx), baseBalance: toMinor(r.base) }))
    .filter((b) => b.fxBalance !== 0n || b.baseBalance !== 0n);
}

const checkMonth = (p: unknown) => (DATE.test(String(p)) && monthEnd(String(p)) === p ? String(p) : bad('Choose the month.', 'err.date'));

/** What restating the foreign balances at the month-end closing rate would post. */
export async function preview(db: Db, companyId: string, periodEnd: string) {
  checkMonth(periodEnd);
  const bs = await balances(db, companyId, periodEnd);
  const used = [...new Set(bs.map((b) => b.currency))];
  const info: Record<string, { rate: string; rateDate: string; source: string } | null> = {};
  for (const c of used) info[c] = await rateFor(db, companyId, c, periodEnd);
  const r = revalue(bs, Object.fromEntries(used.map((c) => [c, info[c] ? parseRate(info[c]!.rate) : undefined])));
  const locked = (await db.query(`SELECT 1 FROM periods WHERE company_id = $1 AND locked_at IS NOT NULL AND $2::date BETWEEN start_date AND end_date`, [companyId, periodEnd])).rows.length > 0;
  const done = (await db.query(`SELECT id FROM fx_revaluations WHERE company_id = $1 AND period_end = $2 AND status = 'posted'`, [companyId, periodEnd])).rows[0]?.id ?? null;
  const later = (await db.query(`SELECT max(period_end)::text AS p FROM fx_revaluations WHERE company_id = $1 AND status = 'posted' AND period_end > $2`, [companyId, periodEnd])).rows[0].p;
  return {
    periodEnd, base: await baseOf(db, companyId), locked, alreadyDone: done, laterDone: later,
    lines: r.lines.map((l) => ({ accountId: l.accountId, code: l.code, name: l.name, currency: l.currency, fxBalance: fromMinor(l.fxBalance), bookValue: fromMinor(l.baseBalance),
      rate: l.rate === null ? null : rateText(l.rate), rateDate: info[l.currency]?.rateDate ?? null, rateSource: info[l.currency]?.source ?? null,
      stale: Boolean(info[l.currency] && info[l.currency]!.rateDate < addDays(periodEnd, -STALE_DAYS)),
      closingValue: l.target === null ? null : fromMinor(l.target), adjustment: fromMinor(l.adjustment), kind: l.kind })),
    unrealised: fromMinor(r.unrealised), realised: fromMinor(r.realised), missing: r.missing,
  };
}

/** Posts the restatement on the month end: one entry, foreign accounts against the exchange gains and losses accounts. */
export async function post(db: Db, companyId: string, periodEnd: string, o: { automatic?: boolean } = {}): Promise<{ id: string; entryId: string | null }> {
  const p = await preview(db, companyId, periodEnd);
  if (p.locked) bad('This month is locked.', 'err.periodLocked');
  if (p.alreadyDone) bad('This month is already revalued. Reverse it first to do it again.', 'err.fxDone');
  if (p.laterDone) bad('A later month is already revalued. Reverse it first.', 'err.fxLater');
  if (p.missing.length) bad(`There is no rate for ${p.missing.join(', ')} on or before ${periodEnd}. Enter one under Currencies and rates.`, 'err.fxNoRate', p.missing);
  const id = randomUUID();
  const moves = p.lines.filter((l) => toMinor(l.adjustment) !== 0n);
  let entryId: string | null = null;
  if (moves.length) {
    const acc = await fxAccounts(db, companyId);
    const side = (accountId: string, v: bigint) => (v > 0n ? { accountId, debit: fromMinor(v) } : { accountId, credit: fromMinor(-v) });
    const unrealised = toMinor(p.unrealised), realised = toMinor(p.realised);
    entryId = await postEntry(db, {
      companyId, entryDate: periodEnd, memo: `Exchange rate revaluation ${periodEnd.slice(0, 7)} (IAS 21)`, sourceType: 'fx_revaluation', sourceId: id,
      lines: [...moves.map((l) => side(l.accountId, toMinor(l.adjustment))),
        ...(unrealised !== 0n ? [side(acc.unrealised, -unrealised)] : []), ...(realised !== 0n ? [side(acc.realised, -realised)] : [])],
    });
  }
  await db.query(`INSERT INTO fx_revaluations (id, company_id, period_end, entry_id, automatic, lines, unrealised, realised, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, app_user_id())`,
    [id, companyId, periodEnd, entryId, Boolean(o.automatic), JSON.stringify(p.lines), p.unrealised, p.realised]);
  return { id, entryId };
}

/** Reverses a revaluation on its own date (the month must be open). */
export async function reverse(db: Db, id: string): Promise<void> {
  const r = (await db.query(`SELECT company_id, period_end::text AS pe, entry_id, status FROM fx_revaluations WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? notFound();
  if (r.status !== 'posted') bad('This revaluation is already reversed.', 'err.fxReversed');
  const later = (await db.query(`SELECT 1 FROM fx_revaluations WHERE company_id = $1 AND status = 'posted' AND period_end > $2`, [r.company_id, r.pe])).rows[0];
  if (later) bad('A later month is already revalued. Reverse it first.', 'err.fxLater');
  const rev = r.entry_id ? (await db.query('SELECT reverse_entry($1, $2, $3) AS id', [r.entry_id, r.pe, `Reversal of exchange rate revaluation ${r.pe.slice(0, 7)}`])).rows[0].id : null;
  await db.query(`UPDATE fx_revaluations SET status = 'reversed', reversal_entry_id = $2 WHERE id = $1`, [id, rev]);
}

export async function list(db: Db, companyId: string) {
  return (await db.query(`SELECT id, period_end::text AS "periodEnd", entry_id AS "entryId", status, automatic, unrealised::text, realised::text, person_name(created_by) AS "createdBy",
      created_at AS "createdAt", reversal_entry_id AS "reversalEntryId" FROM fx_revaluations WHERE company_id = $1 ORDER BY period_end DESC, created_at DESC`, [companyId])).rows;
}
