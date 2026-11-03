// Compliance calendar: deadlines worked out from the company (src/books/compliance.ts), the client's own deadlines,
// and which were done. Runs inside withUser(); 0024_calendar_portal.sql decides who may change what.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import * as C from './compliance.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** How far back and ahead the calendar looks by default. */
export const WINDOW = { back: 120, ahead: 365 };

async function companyFor(db: Db, companyId: string): Promise<C.ComplianceCompany> {
  const r = (await db.query(
    `SELECT country, vat_status AS "vatStatus", vat_registration_date::text AS "vatRegistrationDate", fy_end_month AS "fyEndMonth", fy_end_day AS "fyEndDay",
            cr_expiry::text AS "crExpiry", modules FROM companies WHERE id = $1`, [companyId])).rows[0];
  return r ? { ...r, modules: r.modules ?? [] } : notFound();
}

export async function getSettings(db: Db, companyId: string): Promise<C.ComplianceSettings & { saved: boolean }> {
  const co = await companyFor(db, companyId);
  const r = (await db.query(
    `SELECT vat_frequency AS "vatFrequency", vat_quarter_end_month AS "vatQuarterEndMonth", zakat, corporate_tax AS "corporateTax", payroll, social_insurance AS "socialInsurance"
     FROM compliance_settings WHERE company_id = $1`, [companyId])).rows[0];
  return r ? { ...r, saved: true } : { ...C.defaultSettings(co), saved: false };
}

export async function saveSettings(db: Db, companyId: string, s: Partial<C.ComplianceSettings>): Promise<void> {
  const cur = await getSettings(db, companyId);
  const v = { ...cur, ...s };
  if (v.vatFrequency !== 'monthly' && v.vatFrequency !== 'quarterly') bad('Choose monthly or quarterly VAT returns.', 'err.format');
  const q = Number(v.vatQuarterEndMonth);
  if (![1, 2, 3].includes(q)) bad('Choose when the VAT quarters end.', 'err.format');
  await db.query(
    `INSERT INTO compliance_settings (company_id, vat_frequency, vat_quarter_end_month, zakat, corporate_tax, payroll, social_insurance)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id) DO UPDATE SET vat_frequency = $2, vat_quarter_end_month = $3, zakat = $4, corporate_tax = $5, payroll = $6, social_insurance = $7`,
    [companyId, v.vatFrequency, q, Boolean(v.zakat), Boolean(v.corporateTax), Boolean(v.payroll), Boolean(v.socialInsurance)]);
}

// ------------------------------------------------------------------ the client's own deadlines
export interface CustomRow { id: string; title: string; titleAr: string | null; firstDue: string; repeat: C.Repeat; notes: string | null; status: string; createdBy: string | null }
export async function listCustom(db: Db, companyId: string, all = false): Promise<CustomRow[]> {
  return (await db.query(
    `SELECT id, title, title_ar AS "titleAr", first_due::text AS "firstDue", repeat, notes, status, person_name(created_by) AS "createdBy"
     FROM compliance_custom WHERE company_id = $1 AND ($2 OR status = 'active') ORDER BY status, first_due, title`, [companyId, all])).rows;
}
export interface CustomInput { title?: string; titleAr?: string; firstDue?: string; repeat?: string; notes?: string; status?: string }
export async function saveCustom(db: Db, companyId: string, b: CustomInput, id?: string): Promise<string> {
  const title = text(b.title, 120) ?? bad('Give the deadline a name.', 'err.calTitle');
  if (!isDate(b.firstDue)) bad('Choose the date it is due.', 'err.date');
  const repeat = (C.REPEATS as string[]).includes(String(b.repeat)) ? b.repeat : 'none';
  const status = b.status === 'archived' ? 'archived' : 'active';
  if (id) {
    const r = await db.query(
      `UPDATE compliance_custom SET title = $3, title_ar = $4, first_due = $5, repeat = $6, notes = $7, status = $8 WHERE id = $1 AND company_id = $2`,
      [id, companyId, title, text(b.titleAr, 120), b.firstDue, repeat, text(b.notes), status]);
    if (!r.rowCount) notFound();
    return id;
  }
  return (await db.query(
    `INSERT INTO compliance_custom (company_id, title, title_ar, first_due, repeat, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
    [companyId, title, text(b.titleAr, 120), b.firstDue, repeat, text(b.notes)])).rows[0].id;
}

// ------------------------------------------------------------------ the calendar
export interface CalendarItem extends C.Deadline {
  status: C.Status;
  done: { by: string | null; at: string; reference: string | null; note: string | null } | null;
  labelAr?: string | null;
}

async function deadlines(db: Db, companyId: string, from: string, to: string): Promise<C.Deadline[]> {
  const co = await companyFor(db, companyId);
  const s = await getSettings(db, companyId);
  const documents = co.modules.includes('HRM') ? (await db.query(
    `SELECT d.id, d.kind, c.name AS label, d.expiry_date::text AS expiry FROM employee_documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 AND d.expiry_date BETWEEN $2 AND $3`, [companyId, from, to])).rows : [];
  const custom = (await listCustom(db, companyId)).map((c) => ({ id: c.id, title: c.title, firstDue: c.firstDue, repeat: c.repeat }));
  return C.deadlinesBetween(co, s, from, to, { documents, custom });
}

export function window(today: string, from?: string, to?: string) {
  return { from: isDate(from) ? from : C.addDays(today, -WINDOW.back), to: isDate(to) ? to : C.addDays(today, WINDOW.ahead) };
}

export async function calendar(db: Db, companyId: string, today: string, range: { from?: string; to?: string } = {}): Promise<CalendarItem[]> {
  const { from, to } = window(today, range.from, range.to);
  if (from > to) bad('The start date is after the end date.', 'err.dateRange');
  const list = await deadlines(db, companyId, from, to);
  const done = new Map((await db.query(
    `SELECT key, person_name(done_by) AS by, done_at AS at, reference, note FROM compliance_done WHERE company_id = $1`, [companyId])).rows.map((r) => [r.key as string, r]));
  const ar = new Map((await db.query(`SELECT id::text, title_ar FROM compliance_custom WHERE company_id = $1`, [companyId])).rows.map((r) => [r.id as string, r.title_ar as string | null]));
  return list.map((d) => {
    const x = done.get(d.key);
    return { ...d, ...(d.kind === 'custom' ? { labelAr: ar.get(d.ref!) ?? null } : {}),
      status: C.statusOf(d.due, Boolean(x), today), done: x ? { by: x.by, at: x.at, reference: x.reference, note: x.note } : null };
  });
}

/** Marks a deadline done. The key must be one of this company's deadlines (its date is in the key). */
export async function markDone(db: Db, companyId: string, key: unknown, b: { reference?: string; note?: string } = {}): Promise<void> {
  const k = String(key ?? '');
  if (!C.KEY.test(k)) bad('That deadline is not on this calendar.', 'err.calKey');
  const date = k.slice(-10);
  // Search a wide window around the date in the key: payroll and VAT keys carry the period end, due up to a few months later.
  const list = await deadlines(db, companyId, C.addDays(date, -1), C.addDays(date, 400));
  const d = list.find((x) => x.key === k) ?? bad('That deadline is not on this calendar.', 'err.calKey');
  await db.query(
    `INSERT INTO compliance_done (company_id, key, due_date, reference, note, done_by) VALUES ($1, $2, $3, $4, $5, app_user_id())
     ON CONFLICT (company_id, key) DO UPDATE SET reference = $4, note = $5`,
    [companyId, k, d.due, text(b.reference, 80), text(b.note)]);
}
export async function undoDone(db: Db, companyId: string, key: unknown): Promise<void> {
  const r = await db.query('DELETE FROM compliance_done WHERE company_id = $1 AND key = $2', [companyId, String(key ?? '')]);
  if (!r.rowCount) notFound();
}

/** Across the companies the person sees: overdue and due within 14 days, and the next deadline (within 90 days). */
export async function myClients(db: Db, today: string) {
  const ids: string[] = (await db.query(`SELECT id FROM companies WHERE id = ANY (app_company_ids()) ORDER BY name`)).rows.map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const items = await calendar(db, id, today, { from: C.addDays(today, -WINDOW.back), to: C.addDays(today, 90) });
    const open = items.filter((i) => i.status !== 'done');
    const next = open.find((i) => i.due >= today) ?? null;
    out.push({ companyId: id, overdue: open.filter((i) => i.status === 'overdue').length, soon: open.filter((i) => i.status === 'soon').length,
      next: next && { kind: next.kind, due: next.due, label: next.label ?? null, periodEnd: next.periodEnd ?? null, docKind: next.docKind ?? null } });
  }
  return out;
}
