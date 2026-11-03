// Fixed asset register: assets, monthly depreciation runs and disposals.
// Every function runs inside withUser(); db/migrations/0012_fixed_assets.sql recomputes every amount.
import type { Db } from '../db/session.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { depreciationDue, disposalResult, monthEnd, monthStart, nextMonthEnd, previousMonthEnd, type AssetTerms } from './assets.js';
import { nextNumber } from './documentsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

async function accountByCode(db: Db, companyId: string, code: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code]);
  return rows[0]?.id ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
}

const ASSET_COLS = `f.id, f.company_id AS "companyId", f.number, f.name, f.name_ar AS "nameAr", f.asset_account_id AS "assetAccountId",
  a.code AS "assetAccountCode", a.name AS "assetAccountName", a.name_ar AS "assetAccountNameAr", f.expense_account_id AS "expenseAccountId",
  f.cost_centre_id AS "costCentreId", cc.name AS "costCentre", cc.name_ar AS "costCentreAr", f.contact_id AS "contactId", c.name AS "supplierName",
  f.purchase_date::text AS "purchaseDate", f.depreciation_start::text AS "depreciationStart", f.cost::text, f.residual_value::text AS "residualValue",
  f.useful_life_months AS "usefulLifeMonths", f.opening_depreciation::text AS "openingDepreciation", f.serial_no AS "serialNo", f.location,
  f.reference, f.notes, f.status, f.disposed_on::text AS "disposedOn", f.disposal_proceeds::text AS "disposalProceeds",
  f.disposal_entry_id AS "disposalEntryId",
  (f.opening_depreciation + coalesce((SELECT sum(l.amount) FROM depreciation_lines l WHERE l.asset_id = f.id), 0))::numeric(18,2)::text AS accumulated`;
const FROM = `FROM fixed_assets f JOIN accounts a ON a.id = f.asset_account_id LEFT JOIN cost_centres cc ON cc.id = f.cost_centre_id LEFT JOIN contacts c ON c.id = f.contact_id`;
const withBookValue = <T extends { cost: string; accumulated: string; status: string }>(r: T) =>
  ({ ...r, bookValue: r.status === 'disposed' ? '0.00' : fromMinor(toMinor(r.cost) - toMinor(r.accumulated)) });

export async function listAssets(db: Db, companyId: string, q = '') {
  const { rows } = await db.query(
    `SELECT ${ASSET_COLS} ${FROM} WHERE f.company_id = $1
       AND ($2 = '' OR f.name ILIKE '%' || $2 || '%' OR f.number ILIKE '%' || $2 || '%' OR coalesce(f.serial_no, '') ILIKE '%' || $2 || '%')
     ORDER BY f.status, f.number`, [companyId, q.trim()]);
  return rows.map(withBookValue);
}

export async function getAsset(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${ASSET_COLS} ${FROM} WHERE f.id = $1`, [id]);
  const asset = rows[0] ?? notFound();
  const history = (await db.query(
    `SELECT r.period_end::text AS "periodEnd", l.amount::text, r.journal_entry_id AS "journalEntryId"
     FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id WHERE l.asset_id = $1 ORDER BY r.period_end`, [id])).rows;
  return { ...withBookValue(asset), history };
}

export interface AssetInput {
  name?: string; nameAr?: string; assetAccountId?: string; expenseAccountId?: string | null; costCentreId?: string | null; contactId?: string | null;
  purchaseDate?: string; depreciationStart?: string | null; cost?: string; residualValue?: string | null; usefulLifeMonths?: number | string;
  openingDepreciation?: string | null; serialNo?: string; location?: string; reference?: string; notes?: string;
}

export async function saveAsset(db: Db, companyId: string, a: AssetInput, id?: string): Promise<string> {
  const name = String(a.name ?? '').trim();
  if (!name) bad('Enter the asset name.', 'err.assetName');
  if (!a.assetAccountId) bad('Choose the fixed asset account the asset was bought into (for example 1500 Equipment).', 'err.assetAccount');
  if (!a.purchaseDate || !DATE.test(a.purchaseDate)) bad('Enter the purchase date.', 'err.date');
  const money = (v: string | null | undefined, zeroOk = true) => {
    const s = String(v ?? '').replace(/,/g, '').trim();
    if (!s) return zeroOk ? 0n : bad('Enter the cost.', 'err.assetCost');
    try { return toMinor(s); } catch { return bad('Amounts have at most 2 decimals.', 'err.amountFormat'); }
  };
  const cost = money(a.cost, false), residual = money(a.residualValue), opening = money(a.openingDepreciation);
  if (cost <= 0n) bad('Enter the cost.', 'err.assetCost');
  if (residual < 0n || residual >= cost) bad('The value at the end of its life must be less than the cost.', 'err.assetResidual');
  if (opening < 0n || opening > cost - residual) bad('Depreciation before Nusuh Books cannot be more than cost minus end-of-life value.', 'err.assetOpening');
  const life = Number(a.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 1200) bad('Enter the useful life in months (1 to 1200).', 'err.assetLife');
  const start = monthStart(a.depreciationStart && DATE.test(a.depreciationStart) ? a.depreciationStart : a.purchaseDate!);
  if (start < monthStart(a.purchaseDate!)) bad('Depreciation cannot start before the month the asset was bought.', 'err.assetStart');
  const expense = a.expenseAccountId || await accountByCode(db, companyId, SYSTEM_ACCOUNTS.depreciation);
  const v = [name, a.nameAr?.trim() || null, a.assetAccountId, expense, a.costCentreId || null, a.contactId || null, a.purchaseDate, start,
    fromMinor(cost), fromMinor(residual), life, fromMinor(opening), a.serialNo?.trim() || null, a.location?.trim() || null, a.reference?.trim() || null, a.notes?.trim() || null];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE fixed_assets SET name=$2, name_ar=$3, asset_account_id=$4, expense_account_id=$5, cost_centre_id=$6, contact_id=$7, purchase_date=$8,
         depreciation_start=$9, cost=$10, residual_value=$11, useful_life_months=$12, opening_depreciation=$13, serial_no=$14, location=$15, reference=$16, notes=$17
       WHERE id = $1`, [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  const number = await nextNumber(db, companyId, 'asset', 'FA-');
  return (await db.query(
    `INSERT INTO fixed_assets (company_id, number, name, name_ar, asset_account_id, expense_account_id, cost_centre_id, contact_id, purchase_date,
       depreciation_start, cost, residual_value, useful_life_months, opening_depreciation, serial_no, location, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, app_user_id()) RETURNING id`, [companyId, number, ...v])).rows[0].id;
}

// ------------------------------------------------------------------ depreciation
async function lastRun(db: Db, companyId: string): Promise<string | null> {
  return (await db.query('SELECT max(period_end)::text AS d FROM depreciation_runs WHERE company_id = $1', [companyId])).rows[0].d;
}

/** The month to run next: the month after the last run, or (first time) last month. */
export async function nextRunMonth(db: Db, companyId: string): Promise<{ periodEnd: string; first: boolean }> {
  const last = await lastRun(db, companyId);
  return last ? { periodEnd: nextMonthEnd(last), first: false } : { periodEnd: previousMonthEnd(today()), first: true };
}

/** What a run for that month would book, asset by asset. */
export async function previewRun(db: Db, companyId: string, periodEnd: string) {
  if (!DATE.test(periodEnd) || monthEnd(periodEnd) !== periodEnd) bad('Choose the month.', 'err.date');
  const assets = (await db.query(
    `SELECT f.id, f.number, f.name, f.name_ar AS "nameAr", f.cost::text, f.residual_value::text AS residual, f.useful_life_months AS life,
            f.depreciation_start::text AS start, f.opening_depreciation::text AS opening, f.disposed_on::text AS "disposedOn",
            f.expense_account_id AS "expenseAccountId", f.cost_centre_id AS "costCentreId",
            coalesce((SELECT sum(l.amount) FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
                      WHERE l.asset_id = f.id AND r.period_end < $2), 0)::text AS booked
     FROM fixed_assets f WHERE f.company_id = $1 ORDER BY f.number`, [companyId, periodEnd])).rows;
  const lines = assets.map((x) => {
    const t: AssetTerms = { cost: toMinor(x.cost), residual: toMinor(x.residual), lifeMonths: x.life, start: x.start, opening: toMinor(x.opening), disposedOn: x.disposedOn };
    return { assetId: x.id, number: x.number, name: x.name, nameAr: x.nameAr, expenseAccountId: x.expenseAccountId, costCentreId: x.costCentreId,
      amount: depreciationDue(t, periodEnd, toMinor(x.booked)) };
  }).filter((l) => l.amount > 0n);
  return { periodEnd, lines: lines.map((l) => ({ ...l, amount: fromMinor(l.amount) })), total: fromMinor(lines.reduce((s, l) => s + l.amount, 0n)) };
}

/** Books one month's depreciation for every asset, as one journal entry. Months run in order. */
export async function runDepreciation(db: Db, companyId: string, periodEnd: string): Promise<{ runId: string; total: string }> {
  const next = await nextRunMonth(db, companyId);
  if (!next.first && periodEnd !== next.periodEnd) bad(`Depreciation runs one month at a time. The next month to run ends on ${next.periodEnd}.`, 'err.depNextMonth');
  if (periodEnd > monthEnd(today())) bad('Depreciation cannot be run for a future month.', 'err.depFuture');
  const preview = await previewRun(db, companyId, periodEnd);
  const runId = (await db.query(`INSERT INTO depreciation_runs (company_id, period_end, run_by) VALUES ($1, $2, app_user_id()) RETURNING id`, [companyId, periodEnd])).rows[0].id;
  for (const l of preview.lines) {
    await db.query('INSERT INTO depreciation_lines (company_id, run_id, asset_id, amount) VALUES ($1, $2, $3, $4)', [companyId, runId, l.assetId, l.amount]);
  }
  if (toMinor(preview.total) > 0n) {
    const group = new Map<string, { accountId: string; costCentreId: string | null; amount: Minor }>();
    for (const l of preview.lines) {
      const k = `${l.expenseAccountId}|${l.costCentreId ?? ''}`;
      const g = group.get(k) ?? { accountId: l.expenseAccountId, costCentreId: l.costCentreId, amount: 0n };
      g.amount += toMinor(l.amount); group.set(k, g);
    }
    const entryId = await postEntry(db, { companyId, entryDate: periodEnd, memo: `Depreciation ${periodEnd.slice(0, 7)}`, sourceType: 'depreciation', sourceId: runId,
      lines: [...[...group.values()].map((g) => ({ accountId: g.accountId, costCentreId: g.costCentreId, debit: fromMinor(g.amount) })),
        { accountId: await accountByCode(db, companyId, SYSTEM_ACCOUNTS.accumulatedDepreciation), credit: preview.total }] });
    await db.query('UPDATE depreciation_runs SET total = $2, journal_entry_id = $3 WHERE id = $1', [runId, preview.total, entryId]);
  }
  return { runId, total: preview.total };
}

export async function listRuns(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT r.id, r.period_end::text AS "periodEnd", r.total::text, r.journal_entry_id AS "journalEntryId", r.run_at AS "runAt", person_name(r.run_by) AS "runBy",
            (SELECT count(*) FROM depreciation_lines l WHERE l.run_id = r.id)::int AS assets
     FROM depreciation_runs r WHERE r.company_id = $1 ORDER BY r.period_end DESC`, [companyId]);
  return rows;
}

// ------------------------------------------------------------------ disposal
export interface DisposalInput { date?: string; proceeds?: string; bankAccountId?: string | null }

/** Sells or scraps an asset: removes its cost and accumulated depreciation; the difference to the proceeds is the gain or loss. */
export async function disposeAsset(db: Db, id: string, d: DisposalInput): Promise<string> {
  const a = await getAsset(db, id);
  if (a.status !== 'active') bad('This asset has already been disposed of.', 'err.assetDisposed');
  const date = d.date && DATE.test(d.date) ? d.date : bad('Enter the date.', 'err.date');
  if (date < a.purchaseDate) bad('An asset cannot be disposed of before it was bought.', 'err.assetDisposeDate');
  let proceeds: Minor;
  try { proceeds = toMinor(String(d.proceeds ?? '0').replace(/,/g, '').trim() || '0'); } catch { return bad('Amounts have at most 2 decimals.', 'err.amountFormat'); }
  if (proceeds < 0n) bad('Amounts cannot be negative.', 'err.amount');
  if (proceeds > 0n && !d.bankAccountId) bad('Choose the bank or cash account the money went into.', 'err.bankAccount');
  if (proceeds > 0n && !(await db.query('SELECT 1 FROM accounts WHERE id = $1 AND company_id = $2 AND is_bank', [d.bankAccountId, a.companyId])).rows[0])
    bad('Choose the bank or cash account the money went into.', 'err.bankAccount');
  const prev = previousMonthEnd(date);
  const due = (await db.query('SELECT depreciation_due($1, $2, true)::text AS v', [id, prev])).rows[0].v;
  if (toMinor(due) > 0n) bad(`Run depreciation up to ${prev} before disposing of this asset.`, 'err.depBeforeDisposal');
  const cost = toMinor(a.cost), acc = toMinor(a.accumulated);
  const result = disposalResult(cost, acc, proceeds);
  const accDep = await accountByCode(db, a.companyId, SYSTEM_ACCOUNTS.accumulatedDepreciation);
  const gainLoss = await accountByCode(db, a.companyId, SYSTEM_ACCOUNTS.disposalGainLoss);
  const lines = [
    ...(acc > 0n ? [{ accountId: accDep, debit: fromMinor(acc) }] : []),
    ...(proceeds > 0n ? [{ accountId: d.bankAccountId!, debit: fromMinor(proceeds) }] : []),
    { accountId: a.assetAccountId, credit: fromMinor(cost) },
    ...(result > 0n ? [{ accountId: gainLoss, costCentreId: a.costCentreId, credit: fromMinor(result) }]
      : result < 0n ? [{ accountId: gainLoss, costCentreId: a.costCentreId, debit: fromMinor(-result) }] : []),
  ];
  const entryId = await postEntry(db, { companyId: a.companyId, entryDate: date, memo: `Disposal of ${a.number} · ${a.name}`, sourceType: 'asset_disposal', sourceId: id, lines });
  await db.query(`UPDATE fixed_assets SET status = 'disposed', disposed_on = $2, disposal_proceeds = $3, disposal_entry_id = $4 WHERE id = $1`,
    [id, date, fromMinor(proceeds), entryId]);
  return entryId;
}

// ------------------------------------------------------------------ register summary
/** Register totals by asset account, next to the balances in the books. */
export async function registerSummary(db: Db, companyId: string) {
  const assets = await listAssets(db, companyId);
  const active = assets.filter((x) => x.status === 'active');
  const byAccount = new Map<string, { accountId: string; code: string; name: string; nameAr: string | null; cost: Minor }>();
  for (const x of active) {
    const g = byAccount.get(x.assetAccountId) ?? { accountId: x.assetAccountId, code: x.assetAccountCode, name: x.assetAccountName, nameAr: x.assetAccountNameAr, cost: 0n };
    g.cost += toMinor(x.cost); byAccount.set(x.assetAccountId, g);
  }
  const bal = async (accountId: string) => toMinor((await db.query(
    'SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS v FROM journal_lines WHERE account_id = $1', [accountId])).rows[0].v);
  const accounts = [];
  for (const g of byAccount.values()) accounts.push({ ...g, cost: fromMinor(g.cost), books: fromMinor(await bal(g.accountId)) });
  const accDep = await accountByCode(db, companyId, SYSTEM_ACCOUNTS.accumulatedDepreciation);
  const sum = (f: (x: (typeof active)[number]) => string) => active.reduce((s, x) => s + toMinor(f(x)), 0n);
  return {
    cost: fromMinor(sum((x) => x.cost)), accumulated: fromMinor(sum((x) => x.accumulated)), bookValue: fromMinor(sum((x) => x.bookValue)),
    accumulatedInBooks: fromMinor(-(await bal(accDep))), accounts, nextRun: await nextRunMonth(db, companyId),
  };
}
