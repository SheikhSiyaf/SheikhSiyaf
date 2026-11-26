// Billing and subscriptions: what each customer pays for Nusuh Books. The platform owner sets plans and each
// customer's subscription, runs billing (or the daily job does) and marks invoices paid; a customer's Administrator
// sees its own plan, usage and invoices. Amounts are NUMERIC in the database and strings here.
import { runExclusive } from '../jobs/runJob.js';
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { bilingual, type Mail } from '../email/templates.js';
import { queue } from './emailService.js';
import { LIFECYCLE } from './trialRules.js';
import { cancelTrial, startTrial } from './trialService.js';
import { ownerAlert } from './trialOrders.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}

// ------------------------------------------------------------------ Plans
const PLAN_COLS = `id, code, name, name_ar AS "nameAr", for_kind AS "forKind", monthly_price AS "monthlyPrice", yearly_price AS "yearlyPrice",
  included_companies AS "includedCompanies", included_users AS "includedUsers", extra_company_price AS "extraCompanyPrice",
  extra_user_price AS "extraUserPrice", trial_days AS "trialDays", active,
  setup_price AS "setupPrice", implementation_price AS "implementationPrice", extra_module_price AS "extraModulePrice", annual`;
export async function listPlans(db: Db) {
  return (await db.query(`SELECT ${PLAN_COLS}, (SELECT count(*) FROM subscriptions s WHERE s.plan_id = plans.id AND s.status <> 'cancelled')::int AS customers
    FROM plans ORDER BY active DESC, monthly_price`)).rows;
}

export interface PlanInput { code?: string; name?: string; nameAr?: string | null; forKind?: string; monthlyPrice?: string; yearlyPrice?: string;
  includedCompanies?: number; includedUsers?: number; extraCompanyPrice?: string; extraUserPrice?: string; trialDays?: number; active?: boolean;
  setupPrice?: string; implementationPrice?: string; extraModulePrice?: string; annual?: boolean }
export async function savePlan(db: Db, id: string | null, p: PlanInput) {
  await requireOwner(db);
  const name = String(p.name ?? '').trim();
  const code = String(p.code ?? '').trim().toLowerCase();
  if (!name) bad('Enter the plan name.', 'err.planName');
  if (!/^[a-z0-9_-]{2,30}$/.test(code)) bad('Give the plan a short code (letters, numbers, dashes).', 'err.planCode');
  if (!['firm', 'company', 'any'].includes(String(p.forKind))) bad('Choose who the plan is for.', 'err.planKind');
  const money = [p.monthlyPrice, p.yearlyPrice, p.extraCompanyPrice ?? '0', p.extraUserPrice ?? '0', p.setupPrice ?? '0', p.implementationPrice ?? '0', p.extraModulePrice ?? '0'].map((x) => String(x ?? '').trim());
  if (money.some((x) => !MONEY.test(x))) bad('Enter the prices as amounts, for example 199 or 199.50.', 'err.planPrice');
  const ints = [p.includedCompanies, p.includedUsers, p.trialDays ?? 14].map(Number);
  if (ints.some((x) => !Number.isInteger(x) || x < 0) || ints[2]! > 90) bad('Enter whole numbers for what is included (trial up to 90 days).', 'err.planNumbers');
  const vals = [code, name, p.nameAr?.trim() || null, p.forKind, ...money, ints[0], ints[1], ints[2], p.active !== false, p.annual === true];
  if (id) {
    const r = await db.query(`UPDATE plans SET code = $2, name = $3, name_ar = $4, for_kind = $5, monthly_price = $6, yearly_price = $7, extra_company_price = $8,
      extra_user_price = $9, setup_price = $10, implementation_price = $11, extra_module_price = $12, included_companies = $13, included_users = $14, trial_days = $15,
      active = $16, annual = $17 WHERE id = $1 RETURNING id`, [id, ...vals]);
    if (!r.rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
    return { id };
  }
  const dup = (await db.query('SELECT 1 FROM plans WHERE code = $1', [code])).rows[0];
  if (dup) bad('Another plan has this code.', 'err.planCodeTaken');
  return { id: (await db.query(`INSERT INTO plans (code, name, name_ar, for_kind, monthly_price, yearly_price, extra_company_price, extra_user_price,
    setup_price, implementation_price, extra_module_price, included_companies, included_users, trial_days, active, annual)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, vals)).rows[0].id as string };
}

// ------------------------------------------------------------------ Settings
export async function settings(db: Db) {
  return (await db.query(`SELECT seller_name AS "sellerName", seller_name_ar AS "sellerNameAr", seller_vat AS "sellerVat", seller_cr AS "sellerCr", seller_address AS "sellerAddress",
    seller_address_ar AS "sellerAddressAr", currency, vat_rate AS "vatRate", terms_days AS "termsDays" FROM billing_settings`)).rows[0];
}
export async function saveSettings(db: Db, s: { sellerName?: string; sellerNameAr?: string | null; sellerVat?: string | null; sellerCr?: string | null; sellerAddress?: string | null; sellerAddressAr?: string | null; currency?: string; vatRate?: string; termsDays?: number }) {
  await requireOwner(db);
  const name = String(s.sellerName ?? '').trim();
  if (!name) bad('Enter the seller name shown on invoices.', 'err.sellerName');
  if (name.length > 120) bad('That text is too long.', 'err.sellerText');
  if (!/^[A-Z]{3}$/.test(String(s.currency ?? ''))) bad('Choose the currency.', 'err.currency');
  const rate = String(s.vatRate ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(rate) || Number(rate) > 100) bad('Enter the VAT rate, for example 15.', 'err.vatRate');
  const terms = Number(s.termsDays);
  if (!Number.isInteger(terms) || terms < 0 || terms > 90) bad('Payment terms are 0 to 90 days.', 'err.termsDays');
  const vat = s.sellerVat?.trim() || null;
  if (vat && !/^[0-9]{15}$/.test(vat)) bad('A VAT number has 15 digits.', 'err.sellerVat');
  const cr = s.sellerCr?.trim() || null;
  if (cr && !/^[0-9A-Za-z-]{5,30}$/.test(cr)) bad('Enter the commercial registration number (letters, digits and hyphens).', 'err.sellerCr');
  const text = (v: string | null | undefined, max: number) => { const x = v?.trim() || null; if (x && x.length > max) bad('That text is too long.', 'err.sellerText'); return x; };
  await db.query(`UPDATE billing_settings SET seller_name = $1, seller_vat = $2, seller_address = $3, currency = $4, vat_rate = $5, terms_days = $6,
    seller_name_ar = $7, seller_address_ar = $8, seller_cr = $9`,
    [name, vat, text(s.sellerAddress, 300), s.currency, rate, terms, text(s.sellerNameAr, 100), text(s.sellerAddressAr, 300), cr]);
}

// ------------------------------------------------------------------ Subscriptions
const SUB_COLS = `s.id, s.firm_id AS "firmId", s.plan_id AS "planId", p.name AS "planName", s.cycle, s.status, to_char(s.started_on, 'YYYY-MM-DD') AS "startedOn",
  to_char(s.trial_ends, 'YYYY-MM-DD') AS "trialEnds", to_char(s.next_bill_on, 'YYYY-MM-DD') AS "nextBillOn", s.discount_pct AS "discountPct",
  s.cancel_at_period_end AS "cancelAtPeriodEnd", s.notes, s.implementation, s.setup_billed AS "setupBilled"`;

/** Every customer with its subscription, usage and what it owes (the owner's Billing page). */
export async function overview(db: Db) {
  await requireOwner(db);
  return (await db.query(`SELECT f.id AS "firmId", f.name, f.kind, f.status AS "tenantStatus", u.companies, u.users, u.modules, f.admins,
      CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id', s.id, 'planId', s.plan_id, 'planName', p.name, 'cycle', s.cycle, 'status', s.status,
        'startedOn', s.started_on, 'trialEnds', s.trial_ends, 'nextBillOn', s.next_bill_on, 'discountPct', s.discount_pct::text,
        'cancelAtPeriodEnd', s.cancel_at_period_end, 'notes', s.notes, 'includedCompanies', p.included_companies, 'includedUsers', p.included_users,
        'price', (CASE s.cycle WHEN 'yearly' THEN p.yearly_price ELSE p.monthly_price END)::text) END AS subscription,
      coalesce((SELECT sum(b.total) FROM billing_invoices b WHERE b.firm_id = f.id AND b.status = 'open'), 0)::text AS owed,
      coalesce((SELECT sum(b.total) FROM billing_invoices b WHERE b.firm_id = f.id AND b.status = 'open' AND b.due_on < current_date), 0)::text AS overdue
    FROM owner_tenants() f CROSS JOIN LATERAL billing_usage(f.id) u
    LEFT JOIN subscriptions s ON s.firm_id = f.id LEFT JOIN plans p ON p.id = s.plan_id
    ORDER BY f.name`)).rows;
}

export interface SubscriptionInput { planId?: string; cycle?: string; startOn?: string; trial?: boolean; discountPct?: string; notes?: string | null; implementation?: boolean }
/** Starts or changes a customer's subscription. A change of plan, cycle or discount applies from the next bill. */
export async function saveSubscription(db: Db, firmId: string, x: SubscriptionInput) {
  await requireOwner(db);
  const firm = (await db.query('SELECT kind FROM owner_tenants() WHERE id = $1', [firmId])).rows[0];
  if (!firm) throw new HttpError(404, 'Not found.', 'err.notFound');
  const plan = (await db.query('SELECT id, for_kind, trial_days, active, annual FROM plans WHERE id = $1', [x.planId])).rows[0];
  if (!plan || !plan.active) bad('Choose a plan.', 'err.pickPlan');
  if (plan.for_kind !== 'any' && plan.for_kind !== firm.kind) bad('This plan is for another kind of customer.', 'err.planWrongKind');
  if (plan.annual) x = { ...x, cycle: 'yearly' };   // the annual plan is billed yearly only
  if (x.cycle !== 'monthly' && x.cycle !== 'yearly') bad('Choose monthly or yearly.', 'err.cycle');
  const implementation = x.implementation === true;   // the optional implementation (accounts fixation) service
  const disc = String(x.discountPct ?? '0').trim() || '0';
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(disc) || Number(disc) > 100) bad('The discount is 0 to 100 percent.', 'err.discount');
  const notes = x.notes?.trim() || null;
  const cur = (await db.query('SELECT id, status FROM subscriptions WHERE firm_id = $1', [firmId])).rows[0];
  if (cur && cur.status !== 'cancelled') {
    await db.query('UPDATE subscriptions SET plan_id = $2, cycle = $3, discount_pct = $4, notes = $5, implementation = CASE WHEN setup_billed THEN implementation ELSE $6 END WHERE id = $1', [cur.id, plan.id, x.cycle, disc, notes, implementation]);
    return { id: cur.id as string };
  }
  const start = String(x.startOn ?? '');
  if (!DATE.test(start)) bad('Choose the start date.', 'err.startDate');
  // A free trial: its dates come from the one schedule in trialRules.ts (the annual plan's 15 days, or an older plan's own days).
  // It is not billed; the customer is locked when it ends unless the owner converts it (src/books/trialService.ts).
  const trialDays = x.trial ? (plan.annual ? LIFECYCLE.trialDays : Number(plan.trial_days)) : 0;
  if (trialDays > 0) {
    const id = await startTrial(db, firmId, { planId: plan.id, cycle: x.cycle as 'monthly' | 'yearly', startOn: start, days: trialDays, implementation, discountPct: disc, notes });
    await ownerAlert(db, 'trial_started', { firmId });   // to hello@, only when TRIAL_EMAILS=on
    return { id };
  }
  // Bills fall on the same day each month, so they start on day 1 to 28.
  if (Number(start.slice(8)) > 28) bad('Start on day 1 to 28, so the bill date is the same every month.', 'err.startDay');
  const trialEnds: string | null = null;
  const vals = [plan.id, x.cycle, trialEnds ? 'trial' : 'active', start, trialEnds, trialEnds ?? start, disc, notes, implementation];
  if (cur) {   // a cancelled customer starts again
    await db.query(`UPDATE subscriptions SET plan_id = $2, cycle = $3, status = $4, started_on = $5, trial_ends = $6, next_bill_on = $7, discount_pct = $8,
      notes = $9, implementation = $10, setup_billed = false, cancel_at_period_end = false,
      trial_started_at = NULL, trial_ends_at = NULL, grace_ends_at = NULL, converted_at = NULL, cancelled_at = NULL WHERE id = $1`, [cur.id, ...vals]);
    return { id: cur.id as string };
  }
  return { id: (await db.query(`INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, trial_ends, next_bill_on, discount_pct, notes, implementation)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [firmId, ...vals])).rows[0].id as string };
}

/** Cancel at the end of the period already billed (or now, for a trial), or take that back. */
export async function setCancel(db: Db, firmId: string, cancel: boolean) {
  await requireOwner(db);
  const s = (await db.query('SELECT id, status FROM subscriptions WHERE firm_id = $1', [firmId])).rows[0];
  if (!s || s.status === 'cancelled') bad('This customer has no subscription to change.', 'err.noSubscription');
  if (cancel && (s.status === 'trial' || s.status === 'trial_ended')) await cancelTrial(db, firmId, 'Cancelled from the billing screen');
  else await db.query('UPDATE subscriptions SET cancel_at_period_end = $2 WHERE id = $1', [s.id, cancel]);
}

// ------------------------------------------------------------------ Invoices
const INV_COLS = `b.id, b.firm_id AS "firmId", b.customer_name AS "customer", b.number, b.plan_name AS "planName", b.cycle,
  to_char(b.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(b.period_end, 'YYYY-MM-DD') AS "periodEnd", to_char(b.issued_on, 'YYYY-MM-DD') AS "issuedOn",
  to_char(b.due_on, 'YYYY-MM-DD') AS "dueOn", b.currency, b.lines, b.subtotal::text, b.discount::text, b.vat_rate::text AS "vatRate", b.vat::text, b.total::text,
  CASE WHEN b.status = 'open' AND b.due_on < current_date THEN 'overdue' ELSE b.status END AS status, to_char(b.paid_on, 'YYYY-MM-DD') AS "paidOn",
  b.paid_ref AS "paidRef", b.void_reason AS "voidReason", to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
  b.buyer_name_ar AS "buyerNameAr", b.buyer_vat AS "buyerVat", b.buyer_cr AS "buyerCr", b.buyer_address AS "buyerAddress"`;
export async function invoices(db: Db, firmId?: string) {
  return (await db.query(`SELECT ${INV_COLS} FROM billing_invoices b WHERE ($1::uuid IS NULL OR b.firm_id = $1)
    ORDER BY b.issued_on DESC, b.number DESC LIMIT 500`, [firmId ?? null])).rows;
}
export async function invoice(db: Db, id: string) {
  const r = (await db.query(`SELECT ${INV_COLS} FROM billing_invoices b WHERE b.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
  return { ...r, seller: await settings(db), bank: await invoiceBank(db) };
}
/** Where to pay, for an invoice that is still open: the owner's bank details from Payment settings (all four lines or none). */
async function invoiceBank(db: Db) {
  const b = (await db.query(`SELECT coalesce(bank_account_name, '') AS "accountName", coalesce(bank_name, '') AS bank, coalesce(bank_iban, '') AS iban, coalesce(bank_swift, '') AS swift FROM billing_settings`)).rows[0];
  return b.accountName && b.bank && b.iban && b.swift ? b : null;
}
export async function markPaid(db: Db, id: string, x: { paidOn?: string; reference?: string }) {
  await requireOwner(db);
  const on = x.paidOn && DATE.test(x.paidOn) ? x.paidOn : null;
  await db.query('SELECT billing_mark_paid($1, $2, $3)', [id, on, x.reference ?? null]);
}
export async function voidInvoice(db: Db, id: string, reason?: string) {
  await requireOwner(db);
  if (!reason?.trim()) bad('Say why the invoice is voided.', 'err.voidReason');
  await db.query('SELECT billing_void($1, $2)', [id, reason]);
}

// ------------------------------------------------------------------ The customer's own view
/** Admin > Billing: the customer's plan, usage against what is included, the next bill and its invoices. */
export async function mine(db: Db) {
  const firmId = (await db.query('SELECT app_firm_id() AS f')).rows[0].f as string;
  const sub = (await db.query(`SELECT ${SUB_COLS}, p.included_companies AS "includedCompanies", p.included_users AS "includedUsers",
      p.extra_company_price AS "extraCompanyPrice", p.extra_user_price AS "extraUserPrice", p.annual,
      p.setup_price AS "setupPrice", p.implementation_price AS "implementationPrice", p.extra_module_price AS "extraModulePrice"
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.firm_id = $1`, [firmId])).rows[0] ?? null;
  const usage = (await db.query('SELECT companies, users, modules FROM billing_usage($1)', [firmId])).rows[0];
  const next = sub && sub.status !== 'cancelled' && !sub.cancelAtPeriodEnd
    ? (await db.query('SELECT billing_quote($1, $2::date) AS q', [firmId, sub.nextBillOn])).rows[0].q : null;
  return { subscription: sub, usage, next, invoices: await invoices(db, firmId), seller: await settings(db) };
}

// ------------------------------------------------------------------ Billing run
export function billingMail(x: { customer: string; name: string; number: string; total: string; currency: string; dueOn: string; periodStart: string; periodEnd: string; link: string }): Mail {
  return bilingual(`Nusuh Books invoice ${x.number} · فاتورة نُصح ${x.number}`,
    [`Hello ${x.name},`, `Your Nusuh Books invoice ${x.number} for ${x.customer} is ready: ${x.currency} ${x.total} for ${x.periodStart} to ${x.periodEnd}, due by ${x.dueOn}.`,
      'See it and print it in Admin > Billing:', x.link],
    [`مرحباً ${x.name}،`, `فاتورة نُصح رقم ${x.number} لـ ${x.customer} جاهزة: ${x.total} ${x.currency} عن الفترة ${x.periodStart} إلى ${x.periodEnd}، مستحقة بتاريخ ${x.dueOn}.`,
      'اطلع عليها واطبعها من الإدارة > الفوترة:', x.link], 'Nusuh Books');
}

/** Bills what is due on the day and emails each new invoice to the customer's Administrators (when base is known). */
export async function run(db: { query: Db['query'] }, day: string, base?: string) {
  const made = (await db.query(`SELECT invoice_id AS id, firm_id AS "firmId", number, customer_name AS customer, total::text AS total, currency,
    to_char(due_on, 'YYYY-MM-DD') AS "dueOn", to_char(period_start, 'YYYY-MM-DD') AS "periodStart", to_char(period_end, 'YYYY-MM-DD') AS "periodEnd"
    FROM billing_run($1)`, [day])).rows as { id: string; firmId: string; number: string; customer: string; total: string; currency: string; dueOn: string; periodStart: string; periodEnd: string }[];
  if (base) {
    for (const b of made) {
      for (const r of (await db.query('SELECT name, email FROM billing_recipients($1)', [b.firmId])).rows) {
        await queue(db, { firmId: b.firmId, kind: 'billing', to: r.email, toName: r.name, mail: billingMail({ ...b, name: r.name, link: `${base}/admin/billing` }) });
      }
    }
  }
  return made.map((x) => ({ id: x.id, firmId: x.firmId, number: x.number }));
}

export async function runAsOwner(db: Db, day: string, base?: string) { await requireOwner(db); return run(db, day, base); }

/** Daily job, nobody signed in. */
export function startBillingJob(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.BILLING_JOBS === 'off') return () => undefined;
  const go = async () => {
    await runExclusive(pool, 'billing', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const made = await run(c, new Date().toISOString().slice(0, 10), (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '') || undefined);
        await c.query('COMMIT');
        if (made.length) log(`Billing: ${made.length} invoice(s) made`);
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }).catch((e) => log(`Billing job failed: ${(e as Error).message}`));
  };
  const first = setTimeout(() => void go(), 30_000);
  const every = setInterval(() => void go(), 6 * 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
