// What the public website shows from the software: Payment settings (names and prices of the plan the website sells) and
// testimonials. The platform owner edits; the website reads one public, read-only answer (publicSiteData).
// Prices are the plan's own prices in `plans`, the same ones the billing run bills, so the website and the invoices cannot
// disagree (db/migrations/0071_website_connection.sql lists which plan column feeds which website line).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}

/** The four price lines of the website, and the plan column each one is. */
export const LINES = [
  { key: 'implementation', column: 'setup_price' },
  { key: 'cleanup', column: 'implementation_price' },
  { key: 'annualCore', column: 'yearly_price' },
  { key: 'perModule', column: 'extra_module_price' },
] as const;
export type LineKey = (typeof LINES)[number]['key'];

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const MAX_PRICE = 1_000_000;

export interface Line { key: LineKey; name: string; nameAr: string; amount: string }
export interface PaymentSettings {
  planId: string; planName: string; planNameAr: string; currency: string; vatRate: string;
  lines: Line[]; customers: number;
  history: { at: string; by: string | null; reason: string; before: Record<string, string>; after: Record<string, string>; customersAffected: number }[];
}

async function websitePlan(db: Db) {
  const r = (await db.query(`SELECT w.plan_id AS "planId", w.line_names AS "names", p.name, p.name_ar AS "nameAr", p.setup_price::text, p.implementation_price::text,
      p.yearly_price::text, p.extra_module_price::text FROM website_settings w JOIN plans p ON p.id = w.plan_id`)).rows[0];
  if (!r) throw new HttpError(404, 'The website plan is not set up.', 'err.notFound');
  return r as Record<string, any>;
}

const flat = (r: Record<string, any>): Record<string, string> => ({
  planName: r.name, planNameAr: r.nameAr ?? '',
  ...Object.fromEntries(LINES.flatMap((l) => [[`${l.key}.amount`, r[l.column]], [`${l.key}.name`, r.names[l.key].en], [`${l.key}.nameAr`, r.names[l.key].ar ?? '']])),
});

export async function paymentSettings(db: Db): Promise<PaymentSettings> {
  await requireOwner(db);
  const r = await websitePlan(db);
  const st = (await db.query('SELECT currency, vat_rate::text AS "vatRate" FROM billing_settings')).rows[0];
  const customers = (await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE plan_id = $1 AND status IN ('active', 'past_due')`, [r.planId])).rows[0].n as number;
  const history = (await db.query(`SELECT to_char(c.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, u.full_name AS by, c.reason, c.before, c.after, c.customers_affected AS "customersAffected"
    FROM plan_price_changes c LEFT JOIN users u ON u.id = c.changed_by WHERE c.plan_id = $1 ORDER BY c.at DESC, c.id LIMIT 20`, [r.planId])).rows;
  return {
    planId: r.planId, planName: r.name, planNameAr: r.nameAr ?? '', currency: st.currency, vatRate: st.vatRate, customers, history,
    lines: LINES.map((l) => ({ key: l.key, name: r.names[l.key].en, nameAr: r.names[l.key].ar ?? '', amount: r[l.column] })),
  };
}

export interface PaymentInput { planName?: string; planNameAr?: string; lines?: { key?: string; name?: string; nameAr?: string; amount?: string }[]; reason?: string }

/** Saves the plan's names and prices. Needs a reason; writes nothing if nothing changed; keeps the before and after. Issued invoices are never changed. */
export async function savePaymentSettings(db: Db, x: PaymentInput): Promise<{ changed: boolean; customersAffected: number }> {
  await requireOwner(db);
  const cur = await websitePlan(db);
  const text = (v: unknown, what: string, key: string, required: boolean) => {
    const s = String(v ?? '').trim();
    if (required && !s) bad(`Enter ${what}.`, key);
    if (s.length > 60) bad(`${what[0]!.toUpperCase()}${what.slice(1)} is too long (60 letters at most).`, 'err.nameLong');
    return s;
  };
  const planName = text(x.planName ?? cur.name, 'the plan name', 'err.planName', true);
  const planNameAr = text(x.planNameAr ?? cur.nameAr ?? '', 'the Arabic plan name', 'err.planName', false);
  const lines = Array.isArray(x.lines) ? x.lines : bad('Send the four price lines.', 'err.format');
  const next: Record<string, string> = { planName, planNameAr };
  const names: Record<string, { en: string; ar: string }> = {};
  const seen = new Set<string>();
  for (const l of lines) {
    const def = LINES.find((d) => d.key === l?.key) ?? bad('Unknown price line.', 'err.format');
    if (seen.has(def.key)) bad('A price line is sent twice.', 'err.format');
    seen.add(def.key);
    const amount = String(l.amount ?? '').trim();
    if (!MONEY.test(amount) || Number(amount) > MAX_PRICE) bad('Enter each price as a number from 0 to 1,000,000, with up to 2 decimals.', 'err.priceFormat');
    const name = text(l.name, 'the line name', 'err.lineName', true), nameAr = text(l.nameAr, 'the Arabic line name', 'err.lineName', false);
    names[def.key] = { en: name, ar: nameAr };
    next[`${def.key}.amount`] = Number(amount).toFixed(2); next[`${def.key}.name`] = name; next[`${def.key}.nameAr`] = nameAr;
  }
  if (seen.size !== LINES.length) bad('Send all four price lines.', 'err.format');
  const before = flat(cur);
  const diff = Object.keys(next).filter((k) => before[k] !== next[k]);
  if (diff.length === 0) return { changed: false, customersAffected: 0 };
  const reason = String(x.reason ?? '').trim();
  if (!reason) bad('Say why the prices or names are changed.', 'err.priceReason');
  if (reason.length > 300) bad('The reason is too long (300 letters at most).', 'err.reasonLong');
  const affected = (await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE plan_id = $1 AND status IN ('active', 'past_due')`, [cur.planId])).rows[0].n as number;
  const a = (k: LineKey) => next[`${k}.amount`];
  await db.query(`UPDATE plans SET name = $2, name_ar = nullif($3, ''), setup_price = $4, implementation_price = $5, yearly_price = $6, extra_module_price = $7 WHERE id = $1`,
    [cur.planId, planName, planNameAr, a('implementation'), a('cleanup'), a('annualCore'), a('perModule')]);
  await db.query('UPDATE website_settings SET line_names = $1', [JSON.stringify(Object.fromEntries(Object.entries(names).map(([k, v]) => [k, { en: v.en, ar: v.ar }])))]);
  await db.query(`INSERT INTO plan_price_changes (plan_id, changed_by, reason, before, after, customers_affected) VALUES ($1, app_user_id(), $2, $3, $4, $5)`,
    [cur.planId, reason, JSON.stringify(Object.fromEntries(diff.map((k) => [k, before[k]]))), JSON.stringify(Object.fromEntries(diff.map((k) => [k, next[k]]))), affected]);
  return { changed: true, customersAffected: affected };
}

// ------------------------------------------------------------------ Testimonials
export interface Testimonial {
  id: string; name: string; nameAr: string; role: string; roleAr: string; company: string; companyAr: string; quote: string; quoteAr: string;
  consent: boolean; consentNote: string; visible: boolean; sortOrder: number;
}
const COLS = `id, name, coalesce(name_ar, '') AS "nameAr", coalesce(role, '') AS role, coalesce(role_ar, '') AS "roleAr", coalesce(company, '') AS company,
  coalesce(company_ar, '') AS "companyAr", quote, coalesce(quote_ar, '') AS "quoteAr", consent, coalesce(consent_note, '') AS "consentNote", visible, sort_order AS "sortOrder"`;

export async function websiteEdits(db: Db) {
  await requireOwner(db);
  const limit = (await db.query('SELECT testimonial_limit AS n FROM website_settings')).rows[0].n as number;
  const items = (await db.query(`SELECT ${COLS} FROM website_testimonials ORDER BY sort_order, created_at`)).rows as Testimonial[];
  return { limit, minLimit: 5, maxLimit: 10, loopAbove: 4, items };
}

export type TestimonialInput = Partial<Record<'name' | 'nameAr' | 'role' | 'roleAr' | 'company' | 'companyAr' | 'quote' | 'quoteAr' | 'consentNote', string>> & { consent?: boolean; visible?: boolean };

function clean(x: TestimonialInput) {
  const f = (v: unknown, max: number, what: string, required = false) => {
    const s = String(v ?? '').trim();
    if (required && !s) bad(`Enter ${what}.`, what === 'the name' ? 'err.tmName' : 'err.tmQuote');
    if (s.length > max) bad(`${what[0]!.toUpperCase()}${what.slice(1)} is too long (${max} letters at most).`, 'err.tmLong');
    return s;
  };
  if (x.consent !== true) bad('Tick that the customer allowed us to publish this.', 'err.tmConsent');
  return {
    name: f(x.name, 80, 'the name', true), nameAr: f(x.nameAr, 80, 'the Arabic name'), role: f(x.role, 80, 'the job title'), roleAr: f(x.roleAr, 80, 'the Arabic job title'),
    company: f(x.company, 80, 'the company'), companyAr: f(x.companyAr, 80, 'the Arabic company'), quote: f(x.quote, 300, 'the quote', true), quoteAr: f(x.quoteAr, 300, 'the Arabic quote'),
    consentNote: f(x.consentNote, 200, 'the permission note'), visible: x.visible !== false,
  };
}

export async function addTestimonial(db: Db, x: TestimonialInput): Promise<{ id: string }> {
  await requireOwner(db);
  const c = clean(x);
  const next = (await db.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM website_testimonials')).rows[0].n as number;
  return { id: (await db.query(`INSERT INTO website_testimonials (name, name_ar, role, role_ar, company, company_ar, quote, quote_ar, consent, consent_note, visible, sort_order)
    VALUES ($1, nullif($2,''), nullif($3,''), nullif($4,''), nullif($5,''), nullif($6,''), $7, nullif($8,''), true, nullif($9,''), $10, $11) RETURNING id`,
    [c.name, c.nameAr, c.role, c.roleAr, c.company, c.companyAr, c.quote, c.quoteAr, c.consentNote, c.visible, next])).rows[0].id as string };
}

export async function saveTestimonial(db: Db, id: string, x: TestimonialInput) {
  await requireOwner(db);
  const c = clean(x);
  const r = await db.query(`UPDATE website_testimonials SET name = $2, name_ar = nullif($3,''), role = nullif($4,''), role_ar = nullif($5,''), company = nullif($6,''), company_ar = nullif($7,''),
    quote = $8, quote_ar = nullif($9,''), consent = true, consent_note = nullif($10,''), visible = $11 WHERE id = $1`,
    [id, c.name, c.nameAr, c.role, c.roleAr, c.company, c.companyAr, c.quote, c.quoteAr, c.consentNote, c.visible]);
  if (!r.rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export async function deleteTestimonial(db: Db, id: string) {
  await requireOwner(db);
  if (!(await db.query('DELETE FROM website_testimonials WHERE id = $1', [id])).rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
}

/** The order of all saved testimonials: exactly the saved ones, each once. */
export async function orderTestimonials(db: Db, ids: unknown) {
  await requireOwner(db);
  const list = Array.isArray(ids) ? ids.map(String) : bad('Send the order.', 'err.format');
  const saved = (await db.query('SELECT id FROM website_testimonials')).rows.map((r) => r.id as string).sort();
  if (list.length !== saved.length || [...list].sort().join() !== saved.join()) bad('The order must list every saved testimonial once.', 'err.format');
  for (let i = 0; i < list.length; i++) await db.query('UPDATE website_testimonials SET sort_order = $2 WHERE id = $1', [list[i], i + 1]);
}

/** The most testimonials that may be saved: 5 to 10. The database refuses a limit below the number saved. */
export async function setTestimonialLimit(db: Db, n: unknown) {
  await requireOwner(db);
  const v = Number(n);
  if (!Number.isInteger(v) || v < 5 || v > 10) bad('The limit is a whole number from 5 to 10.', 'err.tmLimit');
  await db.query('UPDATE website_settings SET testimonial_limit = $1', [v]);
}

// ------------------------------------------------------------------ The public answer
let cached: { at: number; body: string; version: string } | null = null;

/** What the public website reads. Nothing private. Kept for 10 seconds in memory, so a crowd of readers asks the database once. */
export async function publicSiteData(pool: pg.Pool, now = Date.now()) {
  if (cached && now - cached.at < 10_000) return { body: cached.body, version: cached.version };
  const d = (await pool.query('SELECT public_site_data() AS d')).rows[0].d as Record<string, unknown>;
  const body = JSON.stringify(d);
  const version = createHash('sha1').update(body).digest('hex').slice(0, 16);
  cached = { at: now, body: JSON.stringify({ version, ...d }), version };
  return { body: cached.body, version };
}
/** Forget the kept answer (after the owner saves a change). */
export function forgetPublicSiteData() { cached = null; }
