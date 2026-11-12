// Tools accountants ask for (db/migrations/0032_accountant_tools.sql): recurring sales invoices, customer statements and
// payment reminders by email, budgets against actual, in-app notifications, and exporting all of a company's data.
// Every function runs inside withUser().
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { nextOccurrence, priceLine, VAT_CODES, type Frequency, type LineInput } from './documents.js';
import { issueDocument, saveDraft } from './documentsService.js';
import { contactLedger } from './ledgerService.js';
import { bilingual } from '../email/templates.js';
import * as Mail from './emailService.js';
import { zipStored } from '../export/xlsx.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FREQS: Frequency[] = ['weekly', 'monthly', 'quarterly', 'yearly'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ------------------------------------------------------------------ recurring sales invoices
export interface RecurringInvoiceInput { name?: string; contactId?: string; frequency?: string; nextDate?: string; endDate?: string | null; termsDays?: number;
  active?: boolean; mode?: string; lines?: LineInput[]; reference?: string | null; notes?: string | null }

const RI_COLS = `r.id, r.name, r.contact_id AS "contactId", c.name AS "customer", c.name_ar AS "customerAr", c.email AS "customerEmail", r.frequency, r.next_date::text AS "nextDate",
  r.end_date::text AS "endDate", r.terms_days AS "termsDays", r.active, r.mode, r.lines, r.reference, r.notes, r.last_problem AS "lastProblem",
  (r.active AND r.next_date <= current_date AND (r.end_date IS NULL OR r.next_date <= r.end_date)) AS due,
  (SELECT count(*)::int FROM documents d WHERE d.recurring_invoice_id = r.id) AS made`;

function withTotal<T extends { lines: LineInput[] }>(r: T, vatRate: string) {
  let gross = 0n;
  for (const l of r.lines) { try { const p = priceLine(l, vatRate); gross += p.net + p.vat; } catch { /* checked when saved */ } }
  return { ...r, grossAmount: fromMinor(gross) };
}
const vatRateOf = async (db: Db, companyId: string) => (await db.query('SELECT vat_rate::text AS r FROM companies WHERE id = $1', [companyId])).rows[0]?.r ?? '0';

export async function listRecurringInvoices(db: Db, companyId: string) {
  const rate = await vatRateOf(db, companyId);
  return (await db.query(`SELECT ${RI_COLS} FROM recurring_invoices r JOIN contacts c ON c.id = r.contact_id WHERE r.company_id = $1 ORDER BY r.active DESC, r.next_date, r.name`,
    [companyId])).rows.map((r) => withTotal(r, rate));
}
export async function getRecurringInvoice(db: Db, id: string) {
  const r = (await db.query(`SELECT ${RI_COLS}, r.company_id AS "companyId" FROM recurring_invoices r JOIN contacts c ON c.id = r.contact_id WHERE r.id = $1`, [id])).rows[0] ?? notFound();
  const invoices = (await db.query(`SELECT id, number, status, issue_date::text AS "issueDate", gross_total::text AS "grossTotal" FROM documents WHERE recurring_invoice_id = $1 ORDER BY issue_date DESC LIMIT 24`, [id])).rows;
  return { ...withTotal(r, await vatRateOf(db, r.companyId)), invoices };
}

export async function saveRecurringInvoice(db: Db, companyId: string, r: RecurringInvoiceInput, id?: string): Promise<string> {
  const name = String(r.name ?? '').trim() || bad('Give the recurring invoice a name.', 'err.recurringName');
  if (!r.contactId) bad('Choose the customer.', 'err.contact');
  if (!FREQS.includes(r.frequency as Frequency)) bad('Choose how often it repeats.', 'err.frequency');
  if (!r.nextDate || !DATE.test(r.nextDate)) bad('Enter the next date.', 'err.date');
  if (r.endDate && (!DATE.test(r.endDate) || r.endDate < r.nextDate!)) bad('The end date cannot be before the next date.', 'err.endDate');
  const mode = ['draft', 'issue', 'issue_and_email'].includes(String(r.mode)) ? String(r.mode) : 'draft';
  const terms = Number(r.termsDays ?? 30);
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) bad('Payment terms are 0 to 365 days.', 'err.terms');
  const rate = await vatRateOf(db, companyId);
  const lines = (r.lines ?? []).map((l, i) => {
    if (!String(l.description ?? '').trim()) bad(`Line ${i + 1}: enter a description.`, 'err.lineDescription');
    if (!l.accountId) bad(`Line ${i + 1}: choose an account.`, 'err.lineAccount');
    if (!VAT_CODES.includes(l.vatCode)) bad(`Line ${i + 1}: choose the VAT treatment.`, 'err.lineVat');
    try { priceLine(l, rate); } catch { bad(`Line ${i + 1}: check the quantity and price.`, 'err.lineNumbers'); }
    return { description: String(l.description).trim(), quantity: String(l.quantity), unitPrice: String(l.unitPrice), accountId: l.accountId, costCentreId: l.costCentreId || null, vatCode: l.vatCode };
  });
  if (!lines.length) bad('Add at least one line.', 'err.noLines');
  const v = [name, r.contactId, r.frequency, r.nextDate, Number(r.nextDate!.slice(8, 10)), r.endDate || null, terms, r.active !== false, mode, JSON.stringify(lines),
    r.reference?.trim() || null, r.notes?.trim() || null];
  if (id) {
    const { rowCount } = await db.query(`UPDATE recurring_invoices SET name=$2, contact_id=$3, frequency=$4, next_date=$5, anchor_day=$6, end_date=$7, terms_days=$8, active=$9,
      mode=$10, lines=$11, reference=$12, notes=$13, last_problem = NULL WHERE id = $1 AND company_id = $14`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO recurring_invoices (company_id, name, contact_id, frequency, next_date, anchor_day, end_date, terms_days, active, mode, lines, reference, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}

/**
 * Makes the invoices that are due (at most 12 per template per run) and moves each template on. In "issue" mode they are
 * issued; in "issue and email" mode also emailed to the customer (when the customer has an email address).
 */
export async function generateRecurringInvoices(db: Db, companyId: string, o: { onlyId?: string; upTo?: string; base?: string } = {}): Promise<{ created: string[]; issued: string[]; emailed: string[] }> {
  const upTo = o.upTo ?? today();
  const rows = (await db.query(`SELECT id, name, contact_id, frequency, next_date::text AS next_date, anchor_day, end_date::text AS end_date, terms_days, mode, lines, reference, notes
    FROM recurring_invoices WHERE company_id = $1 AND active AND ($2::uuid IS NULL OR id = $2) FOR UPDATE`, [companyId, o.onlyId ?? null])).rows;
  const out = { created: [] as string[], issued: [] as string[], emailed: [] as string[] };
  for (const r of rows) {
    let next: string = r.next_date, n = 0;
    const limit = o.onlyId && next > upTo ? next : upTo;
    while (next <= limit && (!r.end_date || next <= r.end_date) && n < 12) {
      const id = await saveDraft(db, companyId, { type: 'invoice', contactId: r.contact_id, issueDate: next, dueDate: addDays(next, r.terms_days),
        reference: r.reference, notes: r.notes ?? r.name, lines: r.lines });
      await db.query('UPDATE documents SET recurring_invoice_id = $2 WHERE id = $1', [id, r.id]);
      out.created.push(id);
      if (r.mode !== 'draft') {
        await issueDocument(db, id);
        out.issued.push(id);
        if (r.mode === 'issue_and_email' && o.base) {
          const email = (await db.query('SELECT email FROM contacts WHERE id = $1', [r.contact_id])).rows[0]?.email;
          if (email) { await Mail.emailDocument(db, id, { to: email }, o.base); out.emailed.push(id); }
        }
      }
      next = nextOccurrence(next, r.frequency, r.anchor_day);
      n++;
      if (o.onlyId) break;
    }
    const ended = r.end_date && next > r.end_date;
    await db.query('UPDATE recurring_invoices SET next_date = $2, active = $3, last_problem = NULL WHERE id = $1', [r.id, next, !ended]);
  }
  return out;
}

// ------------------------------------------------------------------ statements and reminders
const BUCKETS = [['current', 0], ['1-30', 30], ['31-60', 60], ['61-90', 90], ['90+', Infinity]] as const;
export async function openInvoices(db: Db, companyId: string, contactId: string | null, asOf = today()) {
  const rows = (await db.query(
    `SELECT d.id, d.number, d.contact_id AS "contactId", c.name AS customer, c.name_ar AS "customerAr", c.email, d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate",
            d.gross_total::text AS "grossTotal", document_amount_due(d.id)::numeric(18,2)::text AS "amountDue",
            (SELECT max(sent_at) FROM reminder_log g WHERE g.document_id = d.id) AS "lastReminder",
            (SELECT coalesce(max(level_days), 0) FROM reminder_log g WHERE g.document_id = d.id) AS "lastLevel"
     FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND ($2::uuid IS NULL OR d.contact_id = $2) AND document_amount_due(d.id) > 0
     ORDER BY d.due_date NULLS LAST, d.issue_date`, [companyId, contactId])).rows;
  return rows.map((r) => {
    const overdue = r.dueDate && r.dueDate < asOf ? daysBetween(r.dueDate, asOf) : 0;
    return { ...r, daysOverdue: overdue, bucket: BUCKETS.find(([, max]) => overdue <= max)![0] };
  });
}

/** A customer's statement: every movement in the period with the running balance, the open invoices and how old they are. */
export async function statement(db: Db, companyId: string, contactId: string, from: string, to: string) {
  if (!DATE.test(from) || !DATE.test(to) || to < from) bad('Choose the dates.', 'err.date');
  const ledger = await contactLedger(db, companyId, contactId, from, to);
  const open = await openInvoices(db, companyId, contactId, to);
  const aging = Object.fromEntries(BUCKETS.map(([k]) => [k, fromMinor(open.filter((o) => o.bucket === k).reduce((t, o) => t + toMinor(o.amountDue), 0n))]));
  const co = (await db.query('SELECT name, name_ar AS "nameAr", currency, email FROM companies WHERE id = $1', [companyId])).rows[0];
  const c = (await db.query('SELECT name, name_ar AS "nameAr", email, vat_number AS "vatNumber" FROM contacts WHERE id = $1', [contactId])).rows[0];
  return { company: co, customer: c, from, to, ledger, open, aging };
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]!));
export async function emailStatement(db: Db, companyId: string, contactId: string, x: { from: string; to: string; email?: string; message?: string }) {
  const s = await statement(db, companyId, contactId, x.from, x.to);
  const to = String(x.email ?? s.customer.email ?? '').trim() || bad("Enter the customer's email address.", 'err.emailMissing');
  const l = s.ledger as unknown as { opening: string; closing: string; rows: { date: string; memo: string | null; number: string | null; debit: string; credit: string; balance: string }[] };
  const lines = l.rows.map((r) => `${r.date}  ${r.number ?? ''}  ${r.memo ?? ''}  ${r.debit !== '0.00' ? r.debit : ''}  ${r.credit !== '0.00' ? `-${r.credit}` : ''}  = ${r.balance}`);
  const mail = bilingual(`Statement of account ${x.from} – ${x.to} · كشف حساب`,
    [`Dear ${s.customer.name},`, ...(x.message ? [x.message] : []), `Your statement of account with ${s.company.name} from ${x.from} to ${x.to} (${s.company.currency}):`,
      `Opening balance: ${l.opening}`, ...lines, `Balance due: ${l.closing}`,
      ...(s.open.length ? ['Open invoices:', ...s.open.map((o) => `${o.number}  due ${o.dueDate ?? '-'}  ${o.amountDue}${o.daysOverdue ? `  (${o.daysOverdue} days overdue)` : ''}`)] : [])],
    [`السادة ${s.customer.nameAr ?? s.customer.name}،`, `كشف حسابكم لدى ${s.company.nameAr ?? s.company.name} من ${x.from} إلى ${x.to} (${s.company.currency}):`,
      `الرصيد الافتتاحي: ${l.opening}`, `الرصيد المستحق: ${l.closing}`, ...(s.open.length ? [`الفواتير المفتوحة: ${s.open.length}`] : [])], s.company.name);
  const table = `<table style="border-collapse:collapse;font-size:13px">${l.rows.map((r) => `<tr><td style="padding:2px 8px">${esc(r.date)}</td><td style="padding:2px 8px">${esc(r.number ?? '')}</td>`
    + `<td style="padding:2px 8px">${esc(r.memo ?? '')}</td><td style="padding:2px 8px;text-align:right">${r.debit !== '0.00' ? esc(r.debit) : ''}</td>`
    + `<td style="padding:2px 8px;text-align:right">${r.credit !== '0.00' ? esc(r.credit) : ''}</td><td style="padding:2px 8px;text-align:right"><b>${esc(r.balance)}</b></td></tr>`).join('')}</table>`;
  mail.html = mail.html.replace(`<p style="margin:0 0 12px">Opening balance`, `${table}<p style="margin:0 0 12px">Opening balance`);
  const csv = ['Date,Number,Description,Debit,Credit,Balance', ...l.rows.map((r) => [r.date, r.number ?? '', `"${String(r.memo ?? '').replace(/"/g, '""')}"`, r.debit, r.credit, r.balance].join(','))].join('\n');
  return Mail.queue(db, { companyId, kind: 'statement', to, toName: s.customer.name, replyTo: s.company.email, mail, contactId,
    attachments: [{ fileName: `statement-${x.to}.csv`, contentType: 'text/csv', base64: Buffer.from(`﻿${csv}`, 'utf8').toString('base64') }] });
}

export async function reminderSettings(db: Db, companyId: string) {
  return (await db.query(`SELECT auto, days, message, person_name(enabled_by) AS "enabledBy" FROM reminder_settings WHERE company_id = $1`, [companyId])).rows[0]
    ?? { auto: false, days: [7, 14, 30], message: null, enabledBy: null };
}
export async function saveReminderSettings(db: Db, companyId: string, x: { auto?: boolean; days?: number[]; message?: string | null }) {
  const days = [...new Set((x.days ?? [7, 14, 30]).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 365))].sort((a, b) => a - b).slice(0, 6);
  if (!days.length) bad('Choose when reminders go out.', 'err.reminderDays');
  await db.query(`INSERT INTO reminder_settings (company_id, auto, days, message) VALUES ($1,$2,$3,$4)
    ON CONFLICT (company_id) DO UPDATE SET auto = $2, days = $3, message = $4`, [companyId, Boolean(x.auto), days, x.message?.trim() || null]);
}

/** One polite reminder for an overdue invoice, with its view link. levelDays 0 = sent by hand. */
export async function sendReminder(db: Db, documentId: string, base: string, levelDays = 0): Promise<string | null> {
  const d = (await db.query(`SELECT d.company_id, d.number, d.due_date::text AS due, document_amount_due(d.id)::numeric(18,2)::text AS "amountDue", c.name, c.email, co.name AS company,
      co.currency, co.email AS "companyEmail", s.message FROM documents d JOIN contacts c ON c.id = d.contact_id JOIN companies co ON co.id = d.company_id
      LEFT JOIN reminder_settings s ON s.company_id = d.company_id WHERE d.id = $1 AND d.type = 'invoice' AND d.status = 'issued'`, [documentId])).rows[0] ?? notFound();
  if (toMinor(d.amountDue) <= 0n) bad('This invoice is paid.', 'err.invoicePaid');
  if (!d.email) bad("The customer has no email address. Add it on the customer's page.", 'err.emailMissing');
  const link = `${base}/i/${await Mail.documentLink(db, documentId)}`;
  const mail = bilingual(`Reminder: invoice ${d.number} is due · تذكير بالفاتورة ${d.number}`,
    [`Dear ${d.name},`, d.message || `This is a friendly reminder that invoice ${d.number} for ${d.currency} ${d.amountDue} was due on ${d.due}. If you have already paid, thank you, and please ignore this email.`,
      `View the invoice: ${link}`],
    [`السادة ${d.name}،`, `نذكّركم بلطف بأن الفاتورة ${d.number} بمبلغ ${d.amountDue} ${d.currency} استحقت بتاريخ ${d.due}. إن كنتم قد سددتم فشكراً لكم ونرجو تجاهل هذه الرسالة.`, `عرض الفاتورة: ${link}`], d.company);
  const emailId = await Mail.queue(db, { companyId: d.company_id, kind: 'reminder', to: d.email, toName: d.name, replyTo: d.companyEmail, mail, documentId });
  await db.query(`INSERT INTO reminder_log (company_id, document_id, level_days, email_id, sent_by) VALUES ($1,$2,$3,$4, app_user_id())`, [d.company_id, documentId, levelDays, emailId]);
  return emailId;
}

/** The automatic run: each overdue invoice gets the highest reminder level it has reached and not had yet. */
export async function runReminders(db: Db, companyId: string, base: string, asOf = today()) {
  const s = await reminderSettings(db, companyId);
  const sent: string[] = [];
  for (const o of await openInvoices(db, companyId, null, asOf)) {
    const level = [...s.days].reverse().find((d: number) => o.daysOverdue >= d);
    if (!level || level <= o.lastLevel || !o.email) continue;
    await sendReminder(db, o.id, base, level);
    sent.push(o.id);
  }
  return sent;
}

// ------------------------------------------------------------------ budgets
export interface BudgetInput { name?: string; startDate?: string; status?: string; lines?: { accountId: string; costCentreId?: string | null; months: (string | number)[] }[] }
export async function listBudgets(db: Db, companyId: string) {
  return (await db.query(`SELECT b.id, b.name, b.start_date::text AS "startDate", b.status, coalesce(sum(l.amount), 0)::numeric(18,2)::text AS total
    FROM budgets b LEFT JOIN budget_lines l ON l.budget_id = b.id WHERE b.company_id = $1 GROUP BY b.id ORDER BY b.status, b.start_date DESC`, [companyId])).rows;
}
export async function saveBudget(db: Db, companyId: string, x: BudgetInput, id?: string): Promise<string> {
  const name = String(x.name ?? '').trim() || bad('Give the budget a name.', 'err.budgetName');
  if (!x.startDate || !/^\d{4}-\d{2}-01$/.test(x.startDate)) bad('The budget starts on the first day of a month.', 'err.budgetStart');
  const lines = (x.lines ?? []).map((l) => {
    if (!l.accountId) bad('Choose the account on each line.', 'err.lineAccount');
    const months = Array.from({ length: 12 }, (_, i) => { const v = String(l.months?.[i] ?? '').replace(/,/g, '').trim(); try { return v ? toMinor(v) : 0n; } catch { return bad('Amounts have at most 2 decimals.', 'err.amountFormat'); } });
    if (months.some((m) => m < 0n)) bad('Budget amounts are not negative.', 'err.amount');
    return { accountId: l.accountId, costCentreId: l.costCentreId || null, months };
  });
  if (id) {
    const r = await db.query(`UPDATE budgets SET name = $2, start_date = $3, status = $4 WHERE id = $1 AND company_id = $5`, [id, name, x.startDate, x.status === 'archived' ? 'archived' : 'active', companyId]);
    if (!r.rowCount) notFound();
    await db.query('DELETE FROM budget_lines WHERE budget_id = $1', [id]);
  } else {
    id = (await db.query(`INSERT INTO budgets (company_id, name, start_date, created_by) VALUES ($1,$2,$3, app_user_id()) RETURNING id`, [companyId, name, x.startDate])).rows[0].id as string;
  }
  for (const l of lines) for (const [i, m] of l.months.entries()) if (m > 0n) {
    await db.query(`INSERT INTO budget_lines (budget_id, company_id, account_id, cost_centre_id, month, amount) VALUES ($1,$2,$3,$4,$5,$6)`, [id, companyId, l.accountId, l.costCentreId, i + 1, fromMinor(m)]);
  }
  return id!;
}

/** Budget against actual, per account (and cost centre) and month, up to a month end. Income counts credits, expenses debits. */
export async function budgetVsActual(db: Db, id: string) {
  const b = (await db.query(`SELECT id, company_id AS "companyId", name, start_date::text AS "startDate", status FROM budgets WHERE id = $1`, [id])).rows[0] ?? notFound();
  const end = new Date(Date.UTC(+b.startDate.slice(0, 4), +b.startDate.slice(5, 7) + 11, 0)).toISOString().slice(0, 10);
  const lines = (await db.query(`SELECT l.account_id AS "accountId", a.code, a.name, a.name_ar AS "nameAr", a.type, l.cost_centre_id AS "costCentreId", cc.name AS "costCentre",
      l.month, l.amount::text FROM budget_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id WHERE l.budget_id = $1`, [id])).rows;
  const actual = (await db.query(`SELECT l.account_id AS "accountId", l.cost_centre_id AS "costCentreId",
      (extract(year FROM age(date_trunc('month', e.entry_date), $2::date)) * 12 + extract(month FROM age(date_trunc('month', e.entry_date), $2::date)))::int + 1 AS month,
      sum(CASE WHEN a.type = 'income' THEN l.credit - l.debit ELSE l.debit - l.credit END)::numeric(18,2)::text AS amount
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense') AND e.source_type IS DISTINCT FROM 'year_end_close'
      AND a.id IN (SELECT account_id FROM budget_lines WHERE budget_id = $4)
    GROUP BY 1, 2, 3`, [b.companyId, b.startDate, end, id])).rows;
  const key = (a: string, c: string | null) => `${a}|${c ?? ''}`;
  const rows = new Map<string, { accountId: string; code: string; name: string; nameAr: string | null; type: string; costCentreId: string | null; costCentre: string | null; budget: bigint[]; actual: bigint[] }>();
  for (const l of lines) {
    const k = key(l.accountId, l.costCentreId);
    const r = rows.get(k) ?? { ...l, budget: Array(12).fill(0n), actual: Array(12).fill(0n) };
    r.budget[l.month - 1] = r.budget[l.month - 1]! + toMinor(l.amount); rows.set(k, r);
  }
  // Actual by cost centre where the budget is by cost centre; otherwise all cost centres together.
  for (const a of actual) {
    const exact = rows.get(key(a.accountId, a.costCentreId));
    const whole = rows.get(key(a.accountId, null));
    const r = exact ?? whole;
    if (r && a.month >= 1 && a.month <= 12) r.actual[a.month - 1] = r.actual[a.month - 1]! + toMinor(a.amount);
  }
  const out = [...rows.values()].sort((x, y) => x.code.localeCompare(y.code)).map((r) => {
    const tb = r.budget.reduce((t, v) => t + v, 0n), ta = r.actual.reduce((t, v) => t + v, 0n);
    const variance = r.type === 'income' ? ta - tb : tb - ta;   // positive = better than budget
    return { ...r, budget: r.budget.map(fromMinor), actual: r.actual.map(fromMinor), totalBudget: fromMinor(tb), totalActual: fromMinor(ta), variance: fromMinor(variance),
      usedPct: tb === 0n ? null : Number((ta * 1000n) / tb) / 10 };
  });
  return { ...b, endDate: end, lines: out };
}

// ------------------------------------------------------------------ notifications
export interface Notice { key: string; kind: string; count?: number; params: Record<string, string | number>; module: string; sub?: string; item?: string; at: string | null; read?: boolean }
/** What needs the person's attention in a company, worked out now; each item can be marked seen. */
export async function notifications(db: Db, companyId: string): Promise<Notice[]> {
  const out: Notice[] = [];
  const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, [companyId, ...args])).rows[0];
  const canApprove = (await one('SELECT app_can_approve($1) AS a')).a as boolean;
  if (canApprove) {
    const a = await one(`SELECT count(*)::int AS n, max(requested_at) AS at FROM approval_requests WHERE company_id = $1 AND status = 'pending' AND requested_by <> app_user_id()`);
    if (a.n) out.push({ key: `approvals:${a.at?.toISOString?.() ?? a.at}`, kind: 'approvals', count: a.n, params: { n: a.n }, module: 'Approvals', sub: 'waiting', at: a.at });
    const k = await one(`SELECT count(*)::int AS n, max(created_at) AS at FROM hr_attendance_corrections WHERE company_id = $1 AND status = 'requested' AND created_by <> app_user_id()`);
    if (k.n) out.push({ key: `corrections:${k.at?.toISOString?.() ?? k.at}`, kind: 'corrections', count: k.n, params: { n: k.n }, module: 'HRM', sub: 'attendance', at: k.at });
    const c = await one(`SELECT count(*)::int AS n, max(submitted_at) AS at FROM documents WHERE company_id = $1 AND type = 'claim' AND status = 'submitted' AND submitted_by IS DISTINCT FROM app_user_id()`);
    if (c.n) out.push({ key: `claims:${c.at?.toISOString?.() ?? c.at}`, kind: 'claims', count: c.n, params: { n: c.n }, module: 'Expenses', sub: 'approvals', at: c.at });
  }
  const ok = await one(`SELECT count(*)::int AS n, max(decided_at) AS at FROM approval_requests WHERE company_id = $1 AND status = 'approved' AND requested_by = app_user_id()`);
  if (ok.n) out.push({ key: `approved:${ok.at?.toISOString?.() ?? ok.at}`, kind: 'approved', count: ok.n, params: { n: ok.n }, module: 'Approvals', sub: 'waiting', at: ok.at });
  const f = await one(`SELECT count(*)::int AS n, max(created_at) AS at FROM email_outbox WHERE company_id = $1 AND status = 'failed'`);
  if (f.n) out.push({ key: `emails:${f.at?.toISOString?.() ?? f.at}`, kind: 'emailsFailed', count: f.n, params: { n: f.n }, module: 'Sales', sub: 'emails', at: f.at });
  const ej = await one(`SELECT count(*)::int AS n, max(created_at) AS at FROM einvoices WHERE company_id = $1 AND status = 'rejected'`);
  if (ej.n) out.push({ key: `einv:${ej.at?.toISOString?.() ?? ej.at}`, kind: 'einvoiceRejected', count: ej.n, params: { n: ej.n }, module: 'Sales', sub: 'e-invoicing', at: ej.at });
  const late = await one(`SELECT count(*)::int AS n, min(created_at) AS at FROM einvoices WHERE company_id = $1 AND scheme = 'zatca' AND kind = 'simplified' AND status = 'pending' AND created_at <= now() - interval '12 hours'`);
  if (late.n) out.push({ key: `einvLate:${today()}:${late.n}`, kind: 'einvoiceLate', count: late.n, params: { n: late.n, hours: Math.floor((Date.now() - new Date(late.at).getTime()) / 3_600_000) }, module: 'Sales', sub: 'e-invoicing', at: late.at });
  const od = (await openInvoices(db, companyId, null)).filter((o) => o.daysOverdue > 0);
  if (od.length) out.push({ key: `overdue:${today()}:${od.length}`, kind: 'overdue', count: od.length, params: { n: od.length, amount: fromMinor(od.reduce((t, o) => t + toMinor(o.amountDue), 0n)) }, module: 'Sales', sub: 'reminders', at: null });
  const ri = await one(`SELECT count(*)::int AS n FROM recurring_invoices WHERE company_id = $1 AND active AND next_date <= current_date AND mode = 'draft'`);
  if (ri.n) out.push({ key: `recurring:${today()}`, kind: 'recurringDue', count: ri.n, params: { n: ri.n }, module: 'Sales', sub: 'recurring-invoices', at: null });
  const low = await one(`SELECT count(*)::int AS n FROM items WHERE company_id = $1 AND status = 'active' AND reorder_level IS NOT NULL AND qty_on_hand <= reorder_level`);
  if (low.n) out.push({ key: `low:${today()}:${low.n}`, kind: 'lowStock', count: low.n, params: { n: low.n }, module: 'Inventory', sub: 'items', at: null });
  const pr = await one(`SELECT count(*)::int AS n, max(requested_at) AS at FROM portal_requests WHERE company_id = $1 AND status = 'answered'`);
  if (pr.n) out.push({ key: `portal:${pr.at?.toISOString?.() ?? pr.at}`, kind: 'portalAnswered', count: pr.n, params: { n: pr.n }, module: 'Portal', sub: 'requests', at: pr.at ?? null });
  const reads = new Set((await db.query('SELECT key FROM notification_reads WHERE user_id = app_user_id()')).rows.map((r) => r.key as string));
  return out.map((n) => ({ ...n, read: reads.has(`${companyId}:${n.key}`) }));
}
export async function markRead(db: Db, companyId: string, keys: string[]) {
  for (const k of keys.slice(0, 50)) await db.query(`INSERT INTO notification_reads (user_id, key) VALUES (app_user_id(), $1) ON CONFLICT DO NOTHING`, [`${companyId}:${k}`]);
}

// ------------------------------------------------------------------ export everything
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Everything the company keeps, one CSV per table (UTF-8 with BOM, opens in Excel), in a ZIP. Read with the person's rights. */
export async function exportAll(db: Db, companyId: string): Promise<{ fileName: string; bytes: Uint8Array }> {
  const co = (await db.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0] ?? notFound();
  const q = (sql: string) => db.query(sql, [companyId]);
  const tables: [string, string][] = [
    ['accounts', 'SELECT code, name, name_ar, type, currency, cost_centre_required, is_bank FROM accounts WHERE company_id = $1 ORDER BY code'],
    ['cost_centres', 'SELECT name, name_ar, kind, status FROM cost_centres WHERE company_id = $1 ORDER BY name'],
    ['journal', `SELECT e.entry_date, e.memo, e.source_type, a.code AS account, a.name AS account_name, cc.name AS cost_centre, l.debit, l.credit, l.fx_amount, l.fx_rate, e.id AS entry_id
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
      WHERE e.company_id = $1 ORDER BY e.entry_date, e.created_at`],
    ['contacts', 'SELECT name, name_ar, is_customer, is_supplier, is_employee, vat_number, cr_number, email, phone, address, city, country, payment_terms_days, status FROM contacts WHERE company_id = $1 ORDER BY name'],
    ['documents', `SELECT d.type, d.number, d.status, c.name AS contact, d.issue_date, d.due_date, d.reference, d.net_total, d.vat_total, d.gross_total, document_amount_due(d.id) AS amount_due, d.id
      FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.company_id = $1 ORDER BY d.type, d.issue_date`],
    ['document_lines', `SELECT d.number, l.line_no, l.description, l.quantity, l.unit_price, a.code AS account, l.vat_code, l.vat_rate, l.net_amount, l.vat_amount
      FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN accounts a ON a.id = l.account_id WHERE d.company_id = $1 ORDER BY d.number, l.line_no`],
    ['payments', 'SELECT p.* FROM payments p WHERE p.company_id = $1 ORDER BY p.payment_date'],
    ['items', 'SELECT sku, barcode, name, name_ar, unit, sale_price, qty_on_hand, value_on_hand, status FROM items WHERE company_id = $1 ORDER BY sku'],
    ['fixed_assets', 'SELECT * FROM fixed_assets WHERE company_id = $1'],
    ['employees', `SELECT c.name, c.employee_no, p.nationality, p.join_date, p.basic, p.housing, p.transport, p.other_allowance, p.leaving_date
      FROM contacts c JOIN employee_profiles p ON p.contact_id = c.id WHERE c.company_id = $1 ORDER BY c.name`],
    ['payroll', `SELECT r.period_end, c.name, l.gross, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id JOIN contacts c ON c.id = l.contact_id WHERE r.company_id = $1 ORDER BY r.period_end, c.name`],
    ['audit_log', 'SELECT at, table_name, action, detail FROM audit_log WHERE company_id = $1 ORDER BY id'],
  ];
  const enc = new TextEncoder();
  const files: [string, Uint8Array][] = [];
  for (const [name, sql] of tables) {
    // A table this person may not read is left out (a savepoint keeps the rest of the export going).
    await db.query('SAVEPOINT export_table');
    const r = await q(sql).then(async (x) => { await db.query('RELEASE SAVEPOINT export_table'); return x; }, async () => { await db.query('ROLLBACK TO SAVEPOINT export_table'); return null; });
    if (!r) continue;
    const head = r.fields.map((f) => f.name);
    files.push([`${name}.csv`, enc.encode(`﻿${[head.join(','), ...r.rows.map((row) => head.map((h) => csvCell(row[h])).join(','))].join('\n')}`)]);
  }
  files.push(['README.txt', enc.encode(`Export of ${co.name} from Nusuh Books, ${new Date().toISOString()}.\nOne CSV file per kind of record. Amounts are in the company's currency unless a column says otherwise.\n`)]);
  return { fileName: `${co.name.replace(/[^\w-]+/g, '-')}-export-${today()}.zip`, bytes: zipStored(files) };
}
