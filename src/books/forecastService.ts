// Cash flow forecast from the books: today's cash and bank, what customers owe and what is owed to suppliers by due
// date, approved and waiting payments, employee claims to pay back, recurring expenses, payroll and social
// insurance, VAT returns due, and the items people add. Placed in weeks or months by src/books/forecast.ts.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { toMinor, fromMinor } from '../money.js';
import { priceLine, type LineInput } from './documents.js';
import * as F from './forecast.js';
import { calendar } from './calendarService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const text = (v: unknown, max = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Options { grain?: string; count?: number; delayDays?: number }

async function flowsFromBooks(db: Db, companyId: string, today: string, to: string): Promise<F.Flow[]> {
  const flows: F.Flow[] = [];
  const co = (await db.query('SELECT vat_rate::text AS rate, modules FROM companies WHERE id = $1', [companyId])).rows[0] ?? notFound();
  // Open invoices and bills, by due date (overdue ones fall in the first period).
  for (const d of (await db.query(
    `SELECT d.id, d.type, d.number, coalesce(d.due_date, d.issue_date)::text AS due, document_amount_due(d.id)::text AS left, c.name
     FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 AND d.status = 'issued' AND d.type IN ('invoice', 'bill', 'claim') AND document_amount_due(d.id) > 0`, [companyId])).rows) {
    flows.push({ date: d.type === 'claim' ? today : d.due, amount: toMinor(d.left), direction: d.type === 'invoice' ? 'in' : 'out',
      category: d.type === 'invoice' ? 'receivables' : d.type === 'bill' ? 'payables' : 'claims', label: `${d.number} · ${d.name}`, ref: { type: 'document', id: d.id } });
  }
  // Bills waiting for approval (by due date) and approved supplier payments not yet made (today).
  for (const r of (await db.query(
    `SELECT r.id, r.kind, r.amount::text, r.payment->>'date' AS pay_date, coalesce(d.due_date, d.issue_date)::text AS due, c.name, d.id AS doc
     FROM approval_requests r JOIN contacts c ON c.id = r.contact_id LEFT JOIN documents d ON d.id = r.document_id
     WHERE r.company_id = $1 AND r.status IN ('pending', 'approved') AND r.kind IN ('bill', 'payment')`, [companyId])).rows) {
    flows.push({ date: r.kind === 'bill' ? r.due : (r.pay_date && r.pay_date > today ? r.pay_date : today), amount: toMinor(r.amount), direction: 'out', category: 'approvals',
      label: r.name, ref: r.doc ? { type: 'document', id: r.doc } : { type: 'approval', id: r.id } });
  }
  // Recurring expenses.
  for (const r of (await db.query(
    `SELECT id, name, frequency, next_date::text AS next, end_date::text AS end, lines FROM recurring_expenses WHERE company_id = $1 AND active`, [companyId])).rows) {
    const gross = (r.lines as LineInput[]).reduce((t, l) => { try { const p = priceLine(l, co.rate); return t + p.net + p.vat; } catch { return t; } }, 0n);
    if (gross <= 0n) continue;
    for (const date of F.repeatDates(r.next, r.frequency, today, to, r.end)) flows.push({ date, amount: gross, direction: 'out', category: 'recurring', label: r.name, ref: { type: 'recurring', id: r.id } });
  }
  // Payroll: the last month's pay repeats at each month end (net pay), social insurance on the deadline in the calendar.
  if ((co.modules ?? []).includes('HRM')) {
    const run = (await db.query(
      `SELECT r.period_end::text AS pe, r.status, r.total_net::text AS net, (r.total_employer + coalesce((SELECT sum(insurance_employee) FROM payroll_lines l WHERE l.run_id = r.id), 0))::numeric(18,2)::text AS si
       FROM payroll_runs r WHERE r.company_id = $1 AND r.status IN ('posted', 'paid') ORDER BY r.period_end DESC LIMIT 1`, [companyId])).rows[0];
    if (run && toMinor(run.net) > 0n) {
      const paidUpTo = run.status === 'paid' ? run.pe : F.addDays(run.pe, -1);
      for (const pe of F.repeatDates(run.pe, 'monthly', today, F.addDays(to, 0), null)) if (pe > paidUpTo) flows.push({ date: pe, amount: toMinor(run.net), direction: 'out', category: 'payroll', label: 'Salaries (as last month)' });
      if (run.status !== 'paid' && run.pe < today) flows.push({ date: today, amount: toMinor(run.net), direction: 'out', category: 'payroll', label: 'Salaries not yet paid' });
      for (const d of (await calendar(db, companyId, today, { from: today, to })).filter((x) => x.kind === 'social_insurance' && x.status !== 'done')) {
        if (toMinor(run.si) > 0n) flows.push({ date: d.due, amount: toMinor(run.si), direction: 'out', category: 'social_insurance', label: 'Social insurance (as last month)' });
      }
    }
  }
  // VAT returns due in the horizon: the VAT payable for each period, from the books (so far, for a period still running).
  for (const d of (await calendar(db, companyId, today, { from: F.addDays(today, -1), to })).filter((x) => x.kind === 'vat_return' && x.status !== 'done' && x.due >= today)) {
    const v = (await db.query(
      `SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS due FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE a.company_id = $1 AND a.code IN ('2100', '1200') AND e.entry_date BETWEEN $2 AND $3`, [companyId, d.periodStart, d.periodEnd])).rows[0].due;
    if (toMinor(v) > 0n) flows.push({ date: d.due, amount: toMinor(v), direction: 'out', category: 'vat', label: `VAT ${d.periodStart} – ${d.periodEnd}` });
  }
  // Items people add.
  for (const i of (await db.query(
    `SELECT id, description, direction, amount::text, first_date::text AS first, repeat, end_date::text AS end FROM forecast_items WHERE company_id = $1 AND status = 'active'`, [companyId])).rows) {
    for (const date of F.repeatDates(i.first, i.repeat, today, to, i.end)) {
      flows.push({ date, amount: toMinor(i.amount), direction: i.direction, category: i.direction === 'in' ? 'other_in' : 'other_out', label: i.description, ref: { type: 'item', id: i.id } });
    }
  }
  return flows;
}

export async function forecast(db: Db, companyId: string, today: string, o: Options = {}) {
  const grain: F.Grain = o.grain === 'month' ? 'month' : 'week';
  const count = Math.min(Math.max(Number(o.count) || (grain === 'week' ? 13 : 6), 1), grain === 'week' ? 26 : 12);
  const delay = [0, 7, 14, 30, 60].includes(Number(o.delayDays)) ? Number(o.delayDays) : 0;
  const ps = F.periods(today, grain, count);
  const to = ps.at(-1)!.end;
  const opening = toMinor((await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.is_bank AND e.entry_date <= $2`, [companyId, today])).rows[0].v);
  const minimum = toMinor((await db.query('SELECT minimum_cash::text AS m FROM forecast_settings WHERE company_id = $1', [companyId])).rows[0]?.m ?? '0');
  const flows = F.delayReceivables(await flowsFromBooks(db, companyId, today, to), delay, today);
  const r = F.forecast(opening, flows, ps, { minimumCash: minimum });
  const m = (v: bigint) => fromMinor(v);
  const map = (x: Record<string, bigint>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, m(v)]));
  return {
    grain, delayDays: delay, today, opening: m(opening), minimumCash: m(minimum),
    rows: r.rows.map((x) => ({ start: x.start, end: x.end, opening: m(x.opening), inflows: map(x.inflows), outflows: map(x.outflows), totalIn: m(x.totalIn), totalOut: m(x.totalOut),
      net: m(x.net), closing: m(x.closing), belowMinimum: x.belowMinimum })),
    lowest: { amount: m(r.lowest.amount), period: r.lowest.period },
    flows: r.flows.filter((f) => f.period !== null).map((f) => ({ date: f.date, amount: m(f.amount), direction: f.direction, category: f.category, label: f.label, ref: f.ref ?? null, period: f.period, overdue: f.overdue })),
  };
}

// ------------------------------------------------------------------ items and settings
export interface ItemInput { description?: string; direction?: string; amount?: string; firstDate?: string; repeat?: string; endDate?: string | null; status?: string }
export async function items(db: Db, companyId: string) {
  return (await db.query(
    `SELECT id, description, direction, amount::text, first_date::text AS "firstDate", repeat, end_date::text AS "endDate", status, person_name(created_by) AS "createdBy"
     FROM forecast_items WHERE company_id = $1 ORDER BY status, first_date`, [companyId])).rows;
}
export async function saveItem(db: Db, companyId: string, b: ItemInput, id?: string): Promise<string> {
  const description = text(b.description) ?? bad('Say what the money is for.', 'err.forecastItem');
  const direction = b.direction === 'in' ? 'in' : b.direction === 'out' ? 'out' : bad('Choose money in or money out.', 'err.format');
  let amount: bigint;
  try { amount = toMinor(String(b.amount ?? '').replace(/,/g, '')); } catch { return bad('Enter the amount.', 'err.amount'); }
  if (amount <= 0n) bad('Enter the amount.', 'err.amount');
  if (!b.firstDate || !DATE.test(b.firstDate)) bad('Choose the date.', 'err.date');
  const repeat = ['none', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(String(b.repeat)) ? b.repeat : 'none';
  const end = b.endDate && DATE.test(b.endDate) ? b.endDate : null;
  if (end && end < b.firstDate!) bad('The end date is before the first date.', 'err.dateRange');
  const v = [description, direction, fromMinor(amount), b.firstDate, repeat, end, b.status === 'archived' ? 'archived' : 'active'];
  if (id) {
    const r = await db.query(`UPDATE forecast_items SET description = $3, direction = $4, amount = $5, first_date = $6, repeat = $7, end_date = $8, status = $9 WHERE id = $1 AND company_id = $2`, [id, companyId, ...v]);
    if (!r.rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO forecast_items (company_id, description, direction, amount, first_date, repeat, end_date, status, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}
export async function saveSettings(db: Db, companyId: string, minimumCash: unknown): Promise<void> {
  let m: bigint;
  try { m = toMinor(String(minimumCash ?? '0').replace(/,/g, '') || '0'); } catch { return bad('Enter the amount.', 'err.amount'); }
  if (m < 0n) bad('Enter the amount.', 'err.amount');
  await db.query(`INSERT INTO forecast_settings (company_id, minimum_cash) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET minimum_cash = $2`, [companyId, fromMinor(m)]);
}
