// Ownership (db/migrations/0061): owners, partners and shareholders, their shares and percentages by date, and the money
// between them and the company. Every movement is posted through the ordinary ledger (src/ledger/ledger.ts), so periods,
// balance and the audit log work as everywhere else. A movement is never changed: a correction is a reversal.
//   contribution       Dr bank                          Cr the owner's capital account (equity)
//   drawing            Dr the owner's current account   Cr bank                      (sole owner and partners)
//   profit_allocation  Dr 3100 Retained earnings        Cr each partner's current account, by percent
//   dividend_declared  Dr 3100 Retained earnings        Cr 2170 Dividends payable     (companies with shares)
//   dividend_paid      Dr 2170 Dividends payable        Cr bank
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { postEntry, reverseEntry } from '../ledger/ledger.js';
import { retainedAccount } from './yearEndService.js';
import { fmtPercent, fmtUnits, ownershipKind, parsePercent, parseUnits, percentsFromShares, PERCENT_TOTAL, splitByPercent, type OwnershipKind } from './ownershipRules.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const today = () => new Date().toISOString().slice(0, 10);
function isoDate(v: unknown, what = 'date'): string {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) bad(`Enter a valid ${what}.`, 'err.format');
  return s;
}
function amountOf(v: unknown): bigint {
  const s = String(v ?? '').replace(/,/g, '').trim();
  try { const m = toMinor(s); if (m > 0n) return m; } catch { /* below */ }
  return bad('Enter the amount, above 0.', 'err.amount');
}
const mn = (s: string | null | undefined): bigint => toMinor(s ?? '0.00');

export type MovementKind = 'contribution' | 'drawing' | 'profit_allocation' | 'dividend_declared' | 'dividend_paid';
export interface OwnerInput { name?: string; nameAr?: string | null; idNumber?: string | null; email?: string | null; phone?: string | null; isActive?: boolean }
export interface HoldingRow { ownerId: string; shares?: string | null; percent?: string | null }
export interface HoldingsInput { effectiveFrom?: string; holdings?: HoldingRow[] }
export interface MovementInput { kind?: string; ownerId?: string; date?: string; amount?: string; accountId?: string; memo?: string | null }
export interface SplitInput { date?: string; amount?: string; memo?: string | null }
export interface SplitResult { entryId: string; parts: { id: string; ownerId: string; amount: string }[] }

async function company(db: Db, companyId: string): Promise<{ kind: OwnershipKind; legalForm: string }> {
  const r = (await db.query<{ legal_form: string }>('SELECT legal_form FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!r) return notFound();
  return { kind: ownershipKind(r.legal_form), legalForm: r.legal_form };
}

/** The first free code from lo to hi, as a string. */
async function freeCode(db: Db, companyId: string, lo: number, hi: number): Promise<string> {
  const used = new Set((await db.query<{ code: string }>('SELECT code FROM accounts WHERE company_id = $1 AND code ~ $2', [companyId, `^[0-9]{4}$`])).rows.map((r) => r.code));
  for (let c = lo; c <= hi; c++) if (!used.has(String(c))) return String(c);
  return bad(`There is no free account code left from ${lo} to ${hi}.`, 'err.noCode');
}
async function equityAccount(db: Db, companyId: string, lo: number, hi: number, name: string, nameAr: string): Promise<string> {
  const code = await freeCode(db, companyId, lo, hi);
  return (await db.query<{ id: string }>(`INSERT INTO accounts (company_id, code, name, name_ar, type) VALUES ($1, $2, $3, $4, 'equity') RETURNING id`, [companyId, code, name, nameAr])).rows[0]!.id;
}
async function payableAccount(db: Db, companyId: string): Promise<string> {
  const r = (await db.query<{ id: string; type: string }>(`SELECT id, type FROM accounts WHERE company_id = $1 AND code = '2170'`, [companyId])).rows[0];
  if (r && r.type !== 'liability') bad('Account 2170 is used for something else in this chart of accounts. Dividends payable needs it.', 'err.chart');
  return r?.id ?? (await db.query<{ id: string }>(`INSERT INTO accounts (company_id, code, name, name_ar, type) VALUES ($1, '2170', 'Dividends payable', 'توزيعات أرباح مستحقة', 'liability') RETURNING id`, [companyId])).rows[0]!.id;
}

// ------------------------------------------------------------------------------------------------ owners

export async function saveOwner(db: Db, companyId: string, x: OwnerInput, ownerId?: string): Promise<string> {
  await company(db, companyId);
  const name = String(x.name ?? '').trim();
  if (!name) bad('Enter the owner\'s name.', 'err.ownerName');
  const nameAr = x.nameAr ? String(x.nameAr).trim() || null : null;
  const clean = (v: unknown) => (v ? String(v).trim().slice(0, 200) || null : null);
  if (ownerId) {
    const o = (await db.query<{ capital_account_id: string; current_account_id: string }>('SELECT capital_account_id, current_account_id FROM owners WHERE id = $1 AND company_id = $2', [ownerId, companyId])).rows[0];
    if (!o) return notFound();
    await db.query(`UPDATE owners SET name = $3, name_ar = $4, id_number = $5, email = $6, phone = $7, is_active = coalesce($8, is_active) WHERE id = $1 AND company_id = $2`,
      [ownerId, companyId, name, nameAr, clean(x.idNumber), clean(x.email), clean(x.phone), typeof x.isActive === 'boolean' ? x.isActive : null]);
    await db.query('UPDATE accounts SET name = $2, name_ar = $3 WHERE id = $1', [o.capital_account_id, `Capital – ${name}`, `رأس المال – ${nameAr ?? name}`]);
    await db.query('UPDATE accounts SET name = $2, name_ar = $3 WHERE id = $1', [o.current_account_id, `Current account – ${name}`, `الحساب الجاري – ${nameAr ?? name}`]);
    return ownerId;
  }
  const capital = await equityAccount(db, companyId, 3200, 3299, `Capital – ${name}`, `رأس المال – ${nameAr ?? name}`);
  const current = await equityAccount(db, companyId, 3300, 3399, `Current account – ${name}`, `الحساب الجاري – ${nameAr ?? name}`);
  return (await db.query<{ id: string }>(
    `INSERT INTO owners (company_id, name, name_ar, id_number, email, phone, capital_account_id, current_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, name, nameAr, clean(x.idNumber), clean(x.email), clean(x.phone), capital, current])).rows[0]!.id;
}

/** The owners with their percentages and balances as at a date (today by default). */
export async function overview(db: Db, companyId: string, asOf?: string) {
  const co = await company(db, companyId);
  const d = asOf ? isoDate(asOf) : today();
  const rows = (await db.query<{
    id: string; name: string; nameAr: string | null; idNumber: string | null; email: string | null; phone: string | null; isActive: boolean;
    capitalAccountId: string; currentAccountId: string; shares: string | null; percent: string | null; since: string | null;
    contributions: string; drawings: string; profit: string; declared: string; paid: string;
  }>(
    `SELECT o.id, o.name, o.name_ar AS "nameAr", o.id_number AS "idNumber", o.email, o.phone, o.is_active AS "isActive",
            o.capital_account_id AS "capitalAccountId", o.current_account_id AS "currentAccountId",
            h.shares::text AS shares, h.percent::text AS percent, h.effective_from::text AS since,
            coalesce(t.contributions, 0)::numeric(18,2)::text AS contributions, coalesce(t.drawings, 0)::numeric(18,2)::text AS drawings,
            coalesce(t.profit, 0)::numeric(18,2)::text AS profit, coalesce(t.declared, 0)::numeric(18,2)::text AS declared, coalesce(t.paid, 0)::numeric(18,2)::text AS paid
     FROM owners o
     LEFT JOIN LATERAL (SELECT shares, percent, effective_from FROM ownership_holdings WHERE owner_id = o.id AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1) h ON true
     LEFT JOIN LATERAL (SELECT
        sum(CASE WHEN kind = 'contribution' THEN s END) AS contributions, sum(CASE WHEN kind = 'drawing' THEN s END) AS drawings,
        sum(CASE WHEN kind = 'profit_allocation' THEN s END) AS profit, sum(CASE WHEN kind = 'dividend_declared' THEN s END) AS declared,
        sum(CASE WHEN kind = 'dividend_paid' THEN s END) AS paid
        FROM (SELECT kind, CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END AS s FROM owner_transactions WHERE owner_id = o.id AND entry_date <= $2) x) t ON true
     WHERE o.company_id = $1 ORDER BY o.created_at, o.id`, [companyId, d])).rows;
  let pct = 0n, shares = 0n;
  const owners = rows.map((r) => {
    const p = r.percent === null ? 0n : parsePercent(r.percent), s = r.shares === null ? 0n : parseUnits(r.shares);
    pct += p; shares += s;
    return {
      id: r.id, name: r.name, nameAr: r.nameAr, idNumber: r.idNumber, email: r.email, phone: r.phone, isActive: r.isActive,
      capitalAccountId: r.capitalAccountId, currentAccountId: r.currentAccountId,
      shares: r.shares === null ? null : fmtUnits(s), percent: fmtPercent(p), since: r.since,
      capital: fromMinor(mn(r.contributions)), current: fromMinor(mn(r.profit) - mn(r.drawings)), dividendsPayable: fromMinor(mn(r.declared) - mn(r.paid)),
    };
  });
  return { kind: co.kind, legalForm: co.legalForm, asOf: d, owners, totalPercent: fmtPercent(pct), totalShares: fmtUnits(shares) };
}

/** Plain owner ids of a company (what the signed-in person is allowed to see). */
export async function listOwnersRaw(db: Db, companyId: string): Promise<{ id: string }[]> {
  return (await db.query<{ id: string }>('SELECT id FROM owners WHERE company_id = $1', [companyId])).rows;
}

// ------------------------------------------------------------------------------------------------ holdings

/** Sets everyone's shares and percentage from a date. Owners not listed are set to 0 from that date. */
export async function setHoldings(db: Db, companyId: string, x: HoldingsInput): Promise<void> {
  const co = await company(db, companyId);
  const from = isoDate(x.effectiveFrom, 'date the change applies from');
  const owners = (await db.query<{ id: string }>('SELECT id FROM owners WHERE company_id = $1 ORDER BY created_at, id', [companyId])).rows.map((r) => r.id);
  const given = new Map<string, HoldingRow>();
  for (const h of x.holdings ?? []) {
    if (!owners.includes(String(h.ownerId))) bad('Choose owners of this company.', 'err.ownerPick');
    if (given.has(h.ownerId)) bad('List each owner once.', 'err.format');
    given.set(h.ownerId, h);
  }
  if (!given.size) bad('Enter at least one owner.', 'err.ownerPick');
  const rows = [...given.values()];
  const hasPercent = rows.map((r) => r.percent !== undefined && r.percent !== null && String(r.percent).trim() !== '');
  const hasShares = rows.map((r) => r.shares !== undefined && r.shares !== null && String(r.shares).trim() !== '');
  const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { return bad(e instanceof Error ? e.message : 'Check the numbers.', 'err.format'); } };
  let percents: bigint[];
  if (hasPercent.every(Boolean)) {
    percents = wrap(() => rows.map((r) => parsePercent(r.percent)));
  } else if (hasPercent.every((p) => !p) && hasShares.every(Boolean)) {
    percents = wrap(() => percentsFromShares(rows.map((r) => parseUnits(r.shares))));
  } else return bad('Give every owner either a percentage or a number of shares, not a mix.', 'err.holdMixed');
  if (percents.reduce((a, b) => a + b, 0n) !== PERCENT_TOTAL) bad('The percentages must total exactly 100.', 'err.holdSum');
  if (co.kind === 'sole' && (percents.filter((p) => p > 0n).length !== 1)) bad('A sole establishment has one owner at 100 percent.', 'err.holdSole');
  const shareOf = (r: HoldingRow) => (hasShares[rows.indexOf(r)] ? fmtUnits(wrap(() => parseUnits(r.shares))) : null);
  await db.query('DELETE FROM ownership_holdings WHERE company_id = $1 AND effective_from = $2', [companyId, from]);
  for (const id of owners) {
    const i = rows.findIndex((r) => r.ownerId === id);
    await db.query(`INSERT INTO ownership_holdings (company_id, owner_id, effective_from, shares, percent) VALUES ($1,$2,$3,$4,$5)`,
      [companyId, id, from, i >= 0 ? shareOf(rows[i]!) : null, i >= 0 ? fmtPercent(percents[i]!) : '0']);
  }
}

/** Who holds what on a date: the owners with more than 0 percent, in a fixed order, percentages in 1/10,000 percent. */
async function holdingsAsOf(db: Db, companyId: string, date: string): Promise<{ ownerId: string; percent: bigint; currentAccountId: string }[]> {
  const rows = (await db.query<{ id: string; percent: string; ca: string }>(
    `SELECT o.id, h.percent::text AS percent, o.current_account_id AS ca FROM owners o
     JOIN LATERAL (SELECT percent FROM ownership_holdings WHERE owner_id = o.id AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1) h ON true
     WHERE o.company_id = $1 AND h.percent > 0 ORDER BY o.created_at, o.id`, [companyId, date])).rows;
  const hs = rows.map((r) => ({ ownerId: r.id, percent: parsePercent(r.percent), currentAccountId: r.ca }));
  if (!hs.length || hs.reduce((a, h) => a + h.percent, 0n) !== PERCENT_TOTAL) bad('Set the owners\' percentages (they must total 100) before sharing an amount between them.', 'err.holdNone');
  return hs;
}

// ------------------------------------------------------------------------------------------------ movements

async function ownerOf(db: Db, companyId: string, ownerId: unknown): Promise<{ id: string; isActive: boolean; capital: string; current: string; name: string }> {
  const o = (await db.query<{ id: string; is_active: boolean; capital_account_id: string; current_account_id: string; name: string }>(
    'SELECT id, is_active, capital_account_id, current_account_id, name FROM owners WHERE id = $1 AND company_id = $2 FOR UPDATE', [String(ownerId ?? ''), companyId]).catch(() => ({ rows: [] }))).rows[0];
  if (!o) return bad('Choose the owner.', 'err.ownerPick');
  return { id: o.id, isActive: o.is_active, capital: o.capital_account_id, current: o.current_account_id, name: o.name };
}
async function insertMovement(db: Db, companyId: string, p: { id: string; ownerId: string; kind: MovementKind; date: string; amount: bigint; accountId: string | null; entryId: string; memo?: string | null; reverses?: string | null }) {
  await db.query(
    `INSERT INTO owner_transactions (id, company_id, owner_id, kind, entry_date, amount, account_id, journal_entry_id, reverses_id, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, app_user_id())`,
    [p.id, companyId, p.ownerId, p.kind, p.date, fromMinor(p.amount), p.accountId, p.entryId, p.reverses ?? null, p.memo ?? null]);
}
const memoOf = (v: unknown, fallback: string) => (v ? String(v).trim().slice(0, 500) || fallback : fallback);

/** A capital contribution, a drawing or a dividend payment, between one owner and a bank or cash account. */
export async function record(db: Db, companyId: string, x: MovementInput): Promise<string> {
  const co = await company(db, companyId);
  const kind = x.kind as MovementKind;
  if (!['contribution', 'drawing', 'dividend_paid'].includes(String(kind))) bad('Choose contribution, drawing or dividend payment.', 'err.format');
  const owner = await ownerOf(db, companyId, x.ownerId);
  const amount = amountOf(x.amount), date = x.date ? isoDate(x.date) : today();
  if (!x.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  if (kind !== 'dividend_paid' && !owner.isActive) bad('This owner is no longer active.', 'err.ownerInactive');
  if (kind === 'drawing' && co.kind === 'shares') bad('Shareholders receive dividends, not drawings. Declare a dividend instead.', 'err.drawKind');
  if (kind === 'dividend_paid') {
    const owed = (await overview(db, companyId, '9999-12-31')).owners.find((o) => o.id === owner.id)!.dividendsPayable;
    if (amount > mn(owed)) bad(`That is more than the dividend still owed to ${owner.name} (${owed}).`, 'err.divTooMuch');
  }
  const a = fromMinor(amount), id = randomUUID();
  const label = { contribution: 'Capital contribution', drawing: 'Drawing', dividend_paid: 'Dividend paid' }[kind as 'contribution' | 'drawing' | 'dividend_paid'];
  const memo = memoOf(x.memo, `${label} · ${owner.name}`);
  const lines = kind === 'contribution' ? [{ accountId: x.accountId!, debit: a }, { accountId: owner.capital, credit: a }]
    : kind === 'drawing' ? [{ accountId: owner.current, debit: a }, { accountId: x.accountId!, credit: a }]
    : [{ accountId: await payableAccount(db, companyId), debit: a }, { accountId: x.accountId!, credit: a }];
  const entryId = await postEntry(db, { companyId, entryDate: date, memo, sourceType: 'ownership', sourceId: id, lines });
  await insertMovement(db, companyId, { id, ownerId: owner.id, kind, date, amount, accountId: x.accountId!, entryId, memo });
  return id;
}

async function share(db: Db, companyId: string, x: SplitInput, kind: 'profit_allocation' | 'dividend_declared'): Promise<SplitResult> {
  const co = await company(db, companyId);
  if (kind === 'profit_allocation' && co.kind === 'shares') bad('Profit of a company with shares is paid out as dividends. Declare a dividend instead.', 'err.divKind');
  if (kind === 'dividend_declared' && co.kind !== 'shares') bad('Partners and a sole owner share profit and take drawings. Dividends are for companies with shares.', 'err.divKind');
  const amount = amountOf(x.amount), date = x.date ? isoDate(x.date) : today();
  const hs = await holdingsAsOf(db, companyId, date);
  const parts = splitByPercent(amount, hs.map((h) => h.percent));
  const retained = await retainedAccount(db, companyId), payable = kind === 'dividend_declared' ? await payableAccount(db, companyId) : null;
  const pairs = hs.map((h, i) => ({ h, part: parts[i]! })).filter((p) => p.part > 0n);
  const memo = memoOf(x.memo, kind === 'profit_allocation' ? 'Profit shared between the partners' : 'Dividend declared');
  const total = fromMinor(amount);
  const lines = [{ accountId: retained, debit: total },
    ...pairs.map((p) => ({ accountId: payable ?? p.h.currentAccountId, credit: fromMinor(p.part) }))];
  const sourceId = randomUUID();
  const entryId = await postEntry(db, { companyId, entryDate: date, memo, sourceType: 'ownership', sourceId, lines });
  const out: SplitResult = { entryId, parts: [] };
  for (const p of pairs) {
    const id = randomUUID();
    await insertMovement(db, companyId, { id, ownerId: p.h.ownerId, kind, date, amount: p.part, accountId: null, entryId, memo });
    out.parts.push({ id, ownerId: p.h.ownerId, amount: fromMinor(p.part) });
  }
  return out;
}
/** Shares a profit between the partners (or the sole owner) by the percentages on that date. */
export const allocateProfit = (db: Db, companyId: string, x: SplitInput) => share(db, companyId, x, 'profit_allocation');
/** Declares a dividend, shared by the percentages on that date, into dividends payable. */
export const declareDividend = (db: Db, companyId: string, x: SplitInput) => share(db, companyId, x, 'dividend_declared');

/** Corrects a movement by reversing its whole entry (a dividend declaration or a profit split is one entry for all owners). */
export async function reverse(db: Db, transactionId: string, x: { date?: string; memo?: string | null } = {}): Promise<string> {
  const t = (await db.query<{ id: string; company_id: string; kind: MovementKind; journal_entry_id: string; reverses_id: string | null }>(
    'SELECT id, company_id, kind, journal_entry_id, reverses_id FROM owner_transactions WHERE id = $1', [transactionId]).catch(() => ({ rows: [] }))).rows[0];
  if (!t) return notFound();
  if (t.reverses_id) bad('That is already a reversal. Record the movement again instead.', 'err.ownerReversed');
  const sibs = (await db.query<{ id: string; owner_id: string; kind: MovementKind; amount: string; account_id: string | null; reversed: boolean }>(
    `SELECT t.id, t.owner_id, t.kind, t.amount::text AS amount, t.account_id,
            EXISTS (SELECT 1 FROM owner_transactions r WHERE r.reverses_id = t.id) AS reversed
     FROM owner_transactions t WHERE t.journal_entry_id = $1 AND t.reverses_id IS NULL ORDER BY t.created_at, t.id`, [t.journal_entry_id])).rows;
  if (sibs.some((s) => s.reversed)) bad('That movement has already been reversed.', 'err.ownerReversed');
  if (t.kind === 'dividend_declared') {
    await db.query('SELECT id FROM owners WHERE id = ANY($1::uuid[]) FOR UPDATE', [sibs.map((x) => x.owner_id)]);   // so a payment made at the same moment waits
    const ov = await overview(db, t.company_id, '9999-12-31');
    for (const s of sibs) {
      const owed = mn(ov.owners.find((o) => o.id === s.owner_id)?.dividendsPayable);
      if (owed < mn(s.amount)) bad('Part of this dividend has already been paid. Reverse the payments first.', 'err.ownerDivPaid');
    }
  }
  const date = x.date ? isoDate(x.date) : today();
  const entryId = await reverseEntry(db, t.journal_entry_id, date, x.memo ? String(x.memo).slice(0, 500) : undefined);
  for (const s of sibs) await insertMovement(db, t.company_id, { id: randomUUID(), ownerId: s.owner_id, kind: s.kind, date, amount: mn(s.amount), accountId: s.account_id, entryId, memo: x.memo ? String(x.memo).slice(0, 500) : 'Reversal', reverses: s.id });
  return entryId;
}

/** The movements of a company (or one owner), newest first. */
export async function movements(db: Db, companyId: string, q: { ownerId?: string; from?: string; to?: string } = {}) {
  await company(db, companyId);
  return (await db.query(
    `SELECT t.id, t.owner_id AS "ownerId", o.name AS "ownerName", o.name_ar AS "ownerNameAr", t.kind, t.entry_date::text AS date, t.amount::text AS amount, t.memo,
            t.reverses_id AS "reversesId", EXISTS (SELECT 1 FROM owner_transactions r WHERE r.reverses_id = t.id) AS reversed,
            t.account_id AS "accountId", t.journal_entry_id AS "entryId"
     FROM owner_transactions t JOIN owners o ON o.id = t.owner_id
     WHERE t.company_id = $1 AND ($2::uuid IS NULL OR t.owner_id = $2) AND ($3::date IS NULL OR t.entry_date >= $3) AND ($4::date IS NULL OR t.entry_date <= $4)
     ORDER BY t.entry_date DESC, t.created_at DESC, t.id`, [companyId, q.ownerId ? String(q.ownerId) : null, q.from ? isoDate(q.from) : null, q.to ? isoDate(q.to) : null])).rows;
}

// ------------------------------------------------------------------------------------------------ reports

/** Each owner's equity over a period: opening, contributions, profit shared, drawings, dividends declared, closing. */
export async function equityStatement(db: Db, companyId: string, from: string, to: string) {
  await company(db, companyId);
  const f = isoDate(from, 'start date'), t = isoDate(to, 'end date');
  const rows = (await db.query<{ ownerId: string; name: string; nameAr: string | null; o: string; c: string; p: string; d: string; v: string; e: string }>(
    `SELECT o.id AS "ownerId", o.name, o.name_ar AS "nameAr",
            coalesce(sum(CASE WHEN x.entry_date < $2 THEN x.eq END), 0)::numeric(18,2)::text AS o,
            coalesce(sum(CASE WHEN x.entry_date BETWEEN $2 AND $3 AND x.kind = 'contribution' THEN x.s END), 0)::numeric(18,2)::text AS c,
            coalesce(sum(CASE WHEN x.entry_date BETWEEN $2 AND $3 AND x.kind = 'profit_allocation' THEN x.s END), 0)::numeric(18,2)::text AS p,
            coalesce(sum(CASE WHEN x.entry_date BETWEEN $2 AND $3 AND x.kind = 'drawing' THEN x.s END), 0)::numeric(18,2)::text AS d,
            coalesce(sum(CASE WHEN x.entry_date BETWEEN $2 AND $3 AND x.kind = 'dividend_declared' THEN x.s END), 0)::numeric(18,2)::text AS v,
            coalesce(sum(CASE WHEN x.entry_date <= $3 THEN x.eq END), 0)::numeric(18,2)::text AS e
     FROM owners o LEFT JOIN (
        SELECT owner_id, entry_date, kind, CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END AS s,
               CASE WHEN kind IN ('contribution', 'profit_allocation') THEN 1 WHEN kind IN ('drawing', 'dividend_declared') THEN -1 ELSE 0 END
               * CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END AS eq
        FROM owner_transactions WHERE company_id = $1) x ON x.owner_id = o.id
     WHERE o.company_id = $1 GROUP BY o.id ORDER BY o.created_at, o.id`, [companyId, f, t])).rows;
  const owners = rows.map((r) => ({ ownerId: r.ownerId, name: r.name, nameAr: r.nameAr, opening: r.o, contributions: r.c, profit: r.p, drawings: r.d, dividends: r.v, closing: r.e }));
  const sum = (k: 'opening' | 'contributions' | 'profit' | 'drawings' | 'dividends' | 'closing') => fromMinor(owners.reduce((a, o) => a + mn(o[k]), 0n));
  return { from: f, to: t, owners, totals: { opening: sum('opening'), contributions: sum('contributions'), profit: sum('profit'), drawings: sum('drawings'), dividends: sum('dividends'), closing: sum('closing') } };
}

/** The net profit the books show for a period (what to share between partners), without posting anything. */
export async function profitSuggestion(db: Db, companyId: string, from: string, to: string): Promise<{ netProfit: string }> {
  await company(db, companyId);
  const r = (await db.query<{ v: string }>(
    `SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense') AND e.source_type IS DISTINCT FROM 'year_end_close'`,
    [companyId, isoDate(from, 'start date'), isoDate(to, 'end date')])).rows[0]!;
  return { netProfit: r.v };
}
