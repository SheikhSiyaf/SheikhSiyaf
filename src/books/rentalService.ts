// Rentals (db/migrations/0041): items rented out (cranes, vehicles, scaffolding, generators, rooms ...), contracts with
// lines that go out and come back, hours for items rented by the hour, and billing into a draft invoice on rental income.
// The database prevents double booking, billing a period twice and changing what has been billed.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { addDays as addDaysDoc } from './documents.js';
import { nextNumber, saveDraft } from './documentsService.js';
import { addDays, BASES, billRange, daysInclusive, lineState, rentalAmount, type Basis } from './rentals.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const txt = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const money = (v: unknown, what: string): string | null => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s) return null;
  try { if (toMinor(s) > 0n) return fromMinor(toMinor(s)); } catch { /* below */ }
  return bad(`Enter the ${what} as an amount above 0.`, 'err.rentalRate');
};
const date = (v: unknown, what = 'date'): string => (DATE.test(String(v ?? '')) ? String(v) : bad(`Enter the ${what}.`, 'err.date'));
const RATE_COL: Record<Basis, string> = { hour: 'hour_rate', day: 'day_rate', week: 'week_rate', month: 'month_rate' };

// ------------------------------------------------------------------ items
export interface ItemInput { code?: string; name?: string; nameAr?: string | null; category?: string | null; identifier?: string | null; units?: number | string;
  hourRate?: string | null; dayRate?: string | null; weekRate?: string | null; monthRate?: string | null; incomeAccountId?: string | null;
  fixedAssetId?: string | null; status?: 'active' | 'retired'; notes?: string | null }

export async function saveItem(db: Db, companyId: string, i: ItemInput, id?: string): Promise<string> {
  const code = txt(i.code, 40) ?? bad('Give the item a short code.', 'err.rentalCode');
  const name = txt(i.name) ?? bad('Enter the item name.', 'err.rentalName');
  const units = Number(i.units ?? 1);
  if (!Number.isInteger(units) || units < 1) bad('Units is a whole number, 1 or more.', 'err.rentalUnits');
  const rates = [money(i.hourRate, 'hourly rate'), money(i.dayRate, 'daily rate'), money(i.weekRate, 'weekly rate'), money(i.monthRate, 'monthly rate')];
  if (rates.every((r) => r === null)) bad('Give the item at least one rate (by the hour, day, week or month).', 'err.rentalNoRate');
  const income = i.incomeAccountId || (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '4100'`, [companyId])).rows[0]?.id
    || bad("This client's chart of accounts has no account 4100 Rental income.", 'err.chart');
  const vals = [code, name, txt(i.nameAr), txt(i.category, 60), txt(i.identifier, 80), units, ...rates, income, i.fixedAssetId || null, i.status === 'retired' ? 'retired' : 'active', txt(i.notes, 1000)];
  if (id) {
    const r = await db.query(`UPDATE rental_items SET code = $2, name = $3, name_ar = $4, category = $5, identifier = $6, units = $7, hour_rate = $8, day_rate = $9,
      week_rate = $10, month_rate = $11, income_account_id = $12, fixed_asset_id = $13, status = $14, notes = $15 WHERE id = $1 RETURNING id`, [id, ...vals]);
    return r.rows[0]?.id ?? notFound();
  }
  if ((await db.query('SELECT 1 FROM rental_items WHERE company_id = $1 AND lower(code) = lower($2)', [companyId, code])).rows[0]) bad('Another item has this code.', 'err.rentalCodeTaken');
  return (await db.query(`INSERT INTO rental_items (company_id, code, name, name_ar, category, identifier, units, hour_rate, day_rate, week_rate, month_rate,
    income_account_id, fixed_asset_id, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [companyId, ...vals])).rows[0].id;
}

const ITEM_COLS = `i.id, i.code, i.name, i.name_ar AS "nameAr", i.category, i.identifier, i.units, i.hour_rate::text AS "hourRate", i.day_rate::text AS "dayRate",
  i.week_rate::text AS "weekRate", i.month_rate::text AS "monthRate", i.income_account_id AS "incomeAccountId", a.code AS "incomeAccountCode",
  i.fixed_asset_id AS "fixedAssetId", fa.number AS "fixedAssetNumber", i.status, i.notes`;
/** Every item with how many units are out on the day and whether any are booked from a later day. */
export async function listItems(db: Db, companyId: string, day = today()) {
  return (await db.query(`SELECT ${ITEM_COLS},
      coalesce((SELECT sum(l.units) FROM rental_lines l JOIN rental_contracts k ON k.id = l.contract_id AND k.status <> 'cancelled'
                WHERE l.item_id = i.id AND l.out_date <= $2 AND (l.return_date IS NULL OR l.return_date >= $2)), 0)::int AS out,
      (SELECT min(l.out_date)::text FROM rental_lines l JOIN rental_contracts k ON k.id = l.contract_id AND k.status <> 'cancelled'
                WHERE l.item_id = i.id AND l.out_date > $2) AS "nextBooking"
    FROM rental_items i JOIN accounts a ON a.id = i.income_account_id LEFT JOIN fixed_assets fa ON fa.id = i.fixed_asset_id
    WHERE i.company_id = $1 ORDER BY i.status, i.category NULLS LAST, i.code`, [companyId, day])).rows;
}
export async function getItem(db: Db, id: string) {
  return (await db.query(`SELECT ${ITEM_COLS}, i.company_id AS "companyId" FROM rental_items i JOIN accounts a ON a.id = i.income_account_id
    LEFT JOIN fixed_assets fa ON fa.id = i.fixed_asset_id WHERE i.id = $1`, [id])).rows[0] ?? notFound();
}

// ------------------------------------------------------------------ contracts
export interface ContractInput { contactId?: string; costCentreId?: string | null; site?: string | null; reference?: string | null; notes?: string | null }
export async function saveContract(db: Db, companyId: string, c: ContractInput, id?: string): Promise<string> {
  if (!c.contactId) bad('Choose the customer.', 'err.contact');
  const vals = [c.contactId, c.costCentreId || null, txt(c.site), txt(c.reference, 80), txt(c.notes, 1000)];
  if (id) {
    const r = await db.query(`UPDATE rental_contracts SET contact_id = $2, cost_centre_id = $3, site = $4, reference = $5, notes = $6 WHERE id = $1 RETURNING id`, [id, ...vals]);
    return r.rows[0]?.id ?? notFound();
  }
  const number = await nextNumber(db, companyId, 'rental', 'RNT-');
  return (await db.query(`INSERT INTO rental_contracts (company_id, number, contact_id, cost_centre_id, site, reference, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, app_user_id()) RETURNING id`, [companyId, number, ...vals])).rows[0].id;
}

const billedTo = `(SELECT max(b.to_date) FROM rental_bill_lines b WHERE b.line_id = l.id)`;
export async function listContracts(db: Db, companyId: string, status?: string) {
  return (await db.query(`SELECT k.id, k.number, k.status, k.site, k.reference, k.contact_id AS "contactId", c.name AS customer, c.name_ar AS "customerAr",
      (SELECT min(l.out_date)::text FROM rental_lines l WHERE l.contract_id = k.id) AS "from",
      (SELECT count(*)::int FROM rental_lines l WHERE l.contract_id = k.id) AS lines,
      (SELECT count(*)::int FROM rental_lines l WHERE l.contract_id = k.id AND l.out_date <= current_date AND l.return_date IS NULL) AS "onHire",
      (SELECT string_agg(i.name, ', ' ORDER BY i.name) FROM rental_lines l JOIN rental_items i ON i.id = l.item_id WHERE l.contract_id = k.id) AS items,
      (SELECT max(b.period_to)::text FROM rental_bills b WHERE b.contract_id = k.id) AS "billedTo"
    FROM rental_contracts k JOIN contacts c ON c.id = k.contact_id
    WHERE k.company_id = $1 AND ($2::text IS NULL OR k.status = $2) ORDER BY (k.status = 'open') DESC, k.number DESC`, [companyId, status || null])).rows;
}

export async function getContract(db: Db, id: string, day = today()) {
  const k = (await db.query(`SELECT k.id, k.company_id AS "companyId", k.number, k.status, k.contact_id AS "contactId", c.name AS customer, c.name_ar AS "customerAr",
      k.cost_centre_id AS "costCentreId", cc.name AS "costCentre", k.site, k.reference, k.notes, k.created_at AS "createdAt"
    FROM rental_contracts k JOIN contacts c ON c.id = k.contact_id LEFT JOIN cost_centres cc ON cc.id = k.cost_centre_id WHERE k.id = $1`, [id])).rows[0] ?? notFound();
  const lines = (await db.query(`SELECT l.id, l.item_id AS "itemId", i.code, i.name, i.name_ar AS "nameAr", i.identifier, i.units AS "itemUnits", l.units, l.basis,
      l.rate::text AS rate, l.out_date::text AS "outDate", l.return_date::text AS "returnDate", ${billedTo}::text AS "billedTo",
      (SELECT coalesce(sum(u.hours), 0)::text FROM rental_usage u WHERE u.line_id = l.id) AS hours
    FROM rental_lines l JOIN rental_items i ON i.id = l.item_id WHERE l.contract_id = $1 ORDER BY l.out_date, l.created_at`, [id])).rows;
  const usage = (await db.query(`SELECT u.line_id AS "lineId", u.work_date::text AS date, u.hours::text AS hours, u.note,
      EXISTS (SELECT 1 FROM rental_bill_lines b WHERE b.line_id = u.line_id AND u.work_date BETWEEN b.from_date AND b.to_date) AS billed
    FROM rental_usage u JOIN rental_lines l ON l.id = u.line_id WHERE l.contract_id = $1 ORDER BY u.work_date`, [id])).rows;
  const bills = (await db.query(`SELECT b.id, b.document_id AS "documentId", b.period_to::text AS "periodTo", d.number, d.status, d.gross_total::text AS total
    FROM rental_bills b JOIN documents d ON d.id = b.document_id WHERE b.contract_id = $1 ORDER BY b.period_to`, [id])).rows;
  const preview = await charges(db, id, day);
  return { ...k, lines: lines.map((l) => ({ ...l, state: lineState(l, day) })), usage, bills, unbilledToday: fromMinor(preview.reduce((s, x) => s + x.amount, 0n)) };
}

// ------------------------------------------------------------------ lines
export interface LineInput { itemId?: string; units?: number | string; basis?: string; rate?: string | null; outDate?: string; returnDate?: string | null }
async function contractOfLine(db: Db, lineId: string) {
  return (await db.query('SELECT contract_id AS "contractId", company_id AS "companyId" FROM rental_lines WHERE id = $1', [lineId])).rows[0] ?? notFound();
}
export async function addLine(db: Db, contractId: string, x: LineInput): Promise<string> {
  const k = (await db.query('SELECT company_id FROM rental_contracts WHERE id = $1', [contractId])).rows[0] ?? notFound();
  const basis = (BASES.includes(x.basis as Basis) ? x.basis : bad('Choose how it is charged: by the hour, day, week or month.', 'err.rentalBasis')) as Basis;
  const item = (await db.query(`SELECT ${RATE_COL[basis]}::text AS rate FROM rental_items WHERE id = $1 AND company_id = $2`, [x.itemId, k.company_id])).rows[0] ?? bad('Choose the item.', 'err.rentalItem');
  const rate = money(x.rate, 'rate') ?? item.rate ?? bad('This item has no rate for that period: enter one.', 'err.rentalRate');
  const units = Number(x.units ?? 1);
  if (!Number.isInteger(units) || units < 1) bad('Units is a whole number, 1 or more.', 'err.rentalUnits');
  const out = date(x.outDate, 'date it goes out');
  const back = x.returnDate ? date(x.returnDate, 'return date') : null;
  if (back && back < out) bad('The return date cannot be before the date it went out.', 'err.rentalReturnEarly');
  return (await db.query(`INSERT INTO rental_lines (company_id, contract_id, item_id, units, basis, rate, out_date, return_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [k.company_id, contractId, x.itemId, units, basis, rate, out, back])).rows[0].id;
}
export async function updateLine(db: Db, lineId: string, x: LineInput) {
  const cur = (await db.query(`SELECT item_id, units, basis, rate::text, out_date::text, return_date::text FROM rental_lines WHERE id = $1`, [lineId])).rows[0] ?? notFound();
  const basis = (x.basis ?? cur.basis) as Basis;
  if (!BASES.includes(basis)) bad('Choose how it is charged: by the hour, day, week or month.', 'err.rentalBasis');
  await db.query(`UPDATE rental_lines SET item_id = $2, units = $3, basis = $4, rate = $5, out_date = $6, return_date = $7 WHERE id = $1`,
    [lineId, x.itemId ?? cur.item_id, x.units !== undefined ? Number(x.units) : cur.units, basis, money(x.rate, 'rate') ?? cur.rate,
      x.outDate ? date(x.outDate) : cur.out_date, x.returnDate === undefined ? cur.return_date : x.returnDate ? date(x.returnDate) : null]);
}
export async function deleteLine(db: Db, lineId: string) {
  await contractOfLine(db, lineId);
  await db.query('DELETE FROM rental_lines WHERE id = $1', [lineId]);
}
/** The item came back on this day (the last day charged). */
export async function returnLine(db: Db, lineId: string, day: string) {
  await contractOfLine(db, lineId);
  await updateLine(db, lineId, { returnDate: date(day, 'return date') });
}
/** Hours worked on a day for an item rented by the hour; empty or 0 removes the day. */
export async function recordHours(db: Db, lineId: string, day: string, hours: string | number, note?: string | null) {
  const l = await contractOfLine(db, lineId);
  const d = date(day);
  const h = String(hours ?? '').trim();
  if (!h || Number(h) === 0) { await db.query('DELETE FROM rental_usage WHERE line_id = $1 AND work_date = $2', [lineId, d]); return; }
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(h) || Number(h) > 24) bad('Enter the hours worked that day, up to 24 (for example 8 or 9.5).', 'err.rentalHours');
  await db.query(`INSERT INTO rental_usage (line_id, company_id, work_date, hours, note) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (line_id, work_date) DO UPDATE SET hours = $4, note = $5`, [lineId, l.companyId, d, h, txt(note)]);
}

// ------------------------------------------------------------------ billing
interface Charge { lineId: string; from: string; to: string; quantity: string; amount: bigint; basis: Basis; units: number; rate: string; name: string; code: string;
  identifier: string | null; accountId: string; days: number; hours: bigint }
/** What each line would bill up to the day, worked out exactly (nothing is saved). */
async function charges(db: Db, contractId: string, upTo: string): Promise<Charge[]> {
  const lines = (await db.query(`SELECT l.id, l.units, l.basis, l.rate::text AS rate, l.out_date::text AS "outDate", l.return_date::text AS "returnDate",
      ${billedTo}::text AS "billedTo", i.name, i.code, i.identifier, i.income_account_id AS "accountId"
    FROM rental_lines l JOIN rental_items i ON i.id = l.item_id WHERE l.contract_id = $1 ORDER BY l.out_date, l.created_at`, [contractId])).rows;
  const out: Charge[] = [];
  for (const l of lines) {
    const r = billRange(l, l.billedTo, upTo);
    if (!r) continue;
    const days = daysInclusive(r.from, r.to);
    const hrs = l.basis === 'hour' ? toMinor((await db.query(`SELECT coalesce(sum(hours), 0)::numeric(10,2)::text AS h FROM rental_usage WHERE line_id = $1 AND work_date BETWEEN $2 AND $3`,
      [l.id, r.from, r.to])).rows[0].h) : 0n;
    const amount = rentalAmount(l.basis, toMinor(l.rate), l.units, { days, hoursHundredths: Number(hrs) });
    const quantity = l.basis === 'hour' ? fromMinor(hrs) : String(days);
    out.push({ lineId: l.id, ...r, quantity, amount, basis: l.basis, units: l.units, rate: l.rate, name: l.name, code: l.code, identifier: l.identifier, accountId: l.accountId, days, hours: hrs });
  }
  return out;
}

const PER: Record<Basis, string> = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month' };
/** Bills every line up to the day into one draft invoice on the items' income accounts. Returns the invoice. */
export async function bill(db: Db, contractId: string, upTo: string, issueDate?: string): Promise<string> {
  const day = date(upTo, 'date to bill up to');
  const k = (await db.query(`SELECT k.company_id, k.contact_id, k.cost_centre_id, k.status, k.number, k.reference, k.site,
      coalesce(c.payment_terms_days, co.payment_terms_days) AS terms FROM rental_contracts k JOIN contacts c ON c.id = k.contact_id JOIN companies co ON co.id = k.company_id
    WHERE k.id = $1`, [contractId])).rows[0] ?? notFound();
  if (k.status !== 'open') bad('This rental contract is closed.', 'err.rentalClosed');
  const all = await charges(db, contractId, day);
  const billable = all.filter((c) => c.amount > 0n);
  if (!billable.length) bad('Nothing to bill up to this day.', 'err.rentalNothing');
  const issued = issueDate ? date(issueDate) : day;
  const lines = billable.map((c) => {
    const what = `${c.name} (${c.code}${c.identifier ? `, ${c.identifier}` : ''})${c.units > 1 ? ` x ${c.units}` : ''}`;
    const period = `${c.from} to ${c.to}`;
    // By the day or hour, quantity x rate on the invoice; by the week or month, one exact amount for the period.
    if (c.basis === 'day') return { description: `${what}, ${period}`, quantity: String(c.days * c.units), unitPrice: c.rate, accountId: c.accountId, costCentreId: k.cost_centre_id, vatCode: 'standard' as const };
    if (c.basis === 'hour') return { description: `${what}, ${fromMinor(c.hours)} hours, ${period}`, quantity: fromMinor(c.hours * BigInt(c.units)), unitPrice: c.rate, accountId: c.accountId, costCentreId: k.cost_centre_id, vatCode: 'standard' as const };
    return { description: `${what}, ${c.days} days at ${c.rate} ${PER[c.basis]}, ${period}`, quantity: '1', unitPrice: fromMinor(c.amount), accountId: c.accountId, costCentreId: k.cost_centre_id, vatCode: 'standard' as const };
  });
  const documentId = await saveDraft(db, k.company_id, {
    type: 'invoice', contactId: k.contact_id, issueDate: issued, dueDate: addDaysDoc(issued, Number(k.terms)), reference: k.reference || k.number,
    notes: `Rental ${k.number}${k.site ? `, ${k.site}` : ''}, up to ${day}`, lines,
  });
  const billId = (await db.query(`INSERT INTO rental_bills (company_id, contract_id, document_id, period_to) VALUES ($1, $2, $3, $4) RETURNING id`,
    [k.company_id, contractId, documentId, day])).rows[0].id;
  // Lines with nothing to charge (no hours that period) are marked billed too, so the period is not offered again.
  for (const c of all) {
    await db.query(`INSERT INTO rental_bill_lines (bill_id, line_id, company_id, from_date, to_date, quantity, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [billId, c.lineId, k.company_id, c.from, c.to, c.quantity, fromMinor(c.amount)]);
  }
  return documentId;
}

export async function closeContract(db: Db, id: string) {
  const r = await db.query(`UPDATE rental_contracts SET status = 'closed' WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
  if (!r.rowCount) bad('This rental contract is already closed.', 'err.rentalClosed');
}
export async function cancelContract(db: Db, id: string) {
  const r = await db.query(`UPDATE rental_contracts SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
  if (!r.rowCount) bad('This rental contract is already closed.', 'err.rentalClosed');
}

/** At a glance on a day: what is out, booked, idle, and not yet billed. */
export async function board(db: Db, companyId: string, day = today()) {
  const items = await listItems(db, companyId, day);
  const open = (await db.query(`SELECT id FROM rental_contracts WHERE company_id = $1 AND status = 'open'`, [companyId])).rows;
  let unbilled = 0n;
  const perContract: { id: string; amount: string }[] = [];
  for (const k of open) {
    const a = (await charges(db, k.id, day)).reduce((s, c) => s + c.amount, 0n);
    unbilled += a;
    if (a > 0n) perContract.push({ id: k.id, amount: fromMinor(a) });
  }
  const lines = (await db.query(`SELECT l.out_date::text AS "outDate", l.return_date::text AS "returnDate" FROM rental_lines l JOIN rental_contracts k ON k.id = l.contract_id
    WHERE k.company_id = $1 AND k.status = 'open'`, [companyId])).rows;
  const active = items.filter((i) => i.status === 'active');
  return {
    day, onHire: lines.filter((l) => lineState(l, day) === 'on_hire').length, booked: lines.filter((l) => lineState(l, day) === 'booked').length,
    startingThisWeek: lines.filter((l) => l.outDate > day && l.outDate <= addDays(day, 7)).length,
    idle: active.filter((i) => i.out === 0).length, items: active.length,
    utilisation: active.length ? Math.round((active.reduce((s, i) => s + Math.min(i.out, i.units) / i.units, 0) / active.length) * 100) : 0,
    unbilled: fromMinor(unbilled), unbilledByContract: perContract, openContracts: open.length,
  };
}
