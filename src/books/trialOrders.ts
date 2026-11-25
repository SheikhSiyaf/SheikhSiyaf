// Buying inside the software (db/migrations/0074_trial_orders.sql): the customer places an order and confirms its bank transfer; the platform
// owner checks the bank and marks it paid, which converts the SAME customer, makes and settles the first invoice and thanks the customer.
// The owner also sees every trial (the Trials view) and gets an e-mail when a trial starts, a payment is confirmed or a trial ends unpaid
// (these go out only when TRIAL_EMAILS=on, like the customer reminders).
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { OPTIONAL_MODULES } from './modules.js';
import { queue } from './emailService.js';
import type { Mail } from '../email/templates.js';
import { SUPPORT, buildNotice } from './trialEmails.js';
import { accessOf, currentNotice, daysLeft, riyadhDate } from './trialRules.js';
import { stateOf } from './trialService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}
const alertsOn = () => process.env.TRIAL_EMAILS === 'on';
const modulesOf = (v: unknown): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((m) => !(OPTIONAL_MODULES as readonly string[]).includes(String(m)))) bad('Choose optional modules from the list.', 'err.orderModules');
  return [...new Set((v as unknown[]).map(String))];
};

// ------------------------------------------------------------------ the customer
export interface OrderView {
  id: string; modules: string[]; cleanup: boolean; currency: string; lines: { key: string; quantity: number; amount: number }[];
  oneTime: number; yearly: number; vatRate: string; vat: string; total: string; placedAt: string; confirmed: boolean; paymentAmount: string | null; paymentDate: string | null; paymentReference: string | null;
  bank: { accountName: string; bank: string; iban: string; swift: string } | null;
}
export const myOrder = async (db: Db): Promise<OrderView | null> => (await db.query('SELECT my_trial_order() AS o')).rows[0].o ?? null;

export async function placeOrder(db: Db, x: { modules?: unknown; cleanup?: unknown }) {
  const id = (await db.query('SELECT trial_order_place($1, $2) AS id', [modulesOf(x.modules), x.cleanup === true])).rows[0].id as string;
  return { id, order: await myOrder(db) };
}

export const TYPES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
export interface PaymentInput { amount?: unknown; date?: unknown; reference?: unknown; fileName?: unknown; fileType?: unknown; fileBase64?: unknown }

/** The customer says it has paid. The proof, if sent, is checked by its first bytes (not only its name) and kept apart, for the owner. */
export async function confirmPayment(db: Db, x: PaymentInput) {
  const amount = String(x.amount ?? '').trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) bad('Enter the amount you transferred.', 'err.payAmount');
  const date = String(x.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Enter the date of the transfer.', 'err.payDate');
  const reference = String(x.reference ?? '').trim();
  if (!reference || reference.length > 80) bad('Enter the transfer reference (up to 80 letters).', 'err.payReference');
  let proof: Buffer | null = null, name: string | null = null, type: string | null = null;
  if (x.fileBase64 !== undefined && x.fileBase64 !== null && x.fileBase64 !== '') {
    if (typeof x.fileBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(x.fileBase64)) bad('The proof of payment could not be read.', 'err.payFile');
    proof = Buffer.from(x.fileBase64 as string, 'base64');
    type = String(x.fileType ?? '');
    if (proof.length === 0 || proof.length > 5 * 1024 * 1024) bad('The proof of payment must be up to 5 MB.', 'err.payFileSize');
    if (!TYPES[type] || !TYPES[type]!(proof)) bad('The proof of payment must be a PDF, PNG, JPG or WebP file.', 'err.payFileType');
    name = String(x.fileName ?? 'proof').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'proof';
  }
  await db.query('SELECT trial_order_confirm($1, $2, $3, $4, $5, $6)', [amount, date, reference, name, type, proof]);
  await ownerAlert(db, 'payment_confirmed', { amount, reference, date });
  return { order: await myOrder(db) };
}

// ------------------------------------------------------------------ e-mails
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function plain(subject: string, paragraphs: string[]): Mail {
  const text = [...paragraphs, `Questions? Reply to this e-mail, or write to ${SUPPORT.email} or call ${SUPPORT.phone} (${SUPPORT.hours}, Saudi time).`, '', '— Nusuh Books'].join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#14213d;line-height:1.55;max-width:600px">${paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}<p style="color:#5b6b7b">— Nusuh Books</p></body></html>`;
  return { subject, text, html };
}
const money = (cur: string, v: number | string) => `${cur} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** To the customer, once its payment is confirmed by the owner: what it bought and the invoice, already settled. */
export const thankYouMail = (name: string, firm: string, inv: { number: string; total: string; currency: string; periodStart: string; periodEnd: string; paidOn: string; reference: string | null }, appUrl: string): Mail =>
  plain('Thank you: your Nusuh Books payment is confirmed', [`Hello ${name},`,
    `We received your bank transfer and your company ${firm} is open again, with all your data exactly as you left it.`,
    `Invoice ${inv.number}: ${money(inv.currency, inv.total)} including VAT, for ${inv.periodStart} to ${inv.periodEnd}. Paid on ${inv.paidOn}${inv.reference ? `, reference ${inv.reference}` : ''}.`,
    `You can see your invoices in Admin > Billing. Your yearly term runs from today.`, `Open Nusuh Books: ${appUrl}`]);

export async function ownerAlert(db: { query: Db['query'] }, kind: 'trial_started' | 'payment_confirmed' | 'trial_ended_unpaid', d: Record<string, string>): Promise<boolean> {
  if (!alertsOn()) return false;
  const firmId = d.firmId ?? ((await db.query('SELECT app_firm_id() AS f')).rows[0].f as string | null);
  const name = (firmId ? ((await db.query('SELECT firm_name_of($1) AS n', [firmId])).rows[0].n as string | null) : null) ?? 'A customer';
  const what = {
    trial_started: [`Trial started: ${name}`, `${name} has started a free trial.${d.endsOn ? ` It ends on ${d.endsOn}.` : ''}`],
    payment_confirmed: [`Payment confirmed by the customer: ${name}`, `${name} says it has paid ${d.amount} on ${d.date}, reference ${d.reference}. Check the bank, then open Owner > Trials and mark it paid.`],
    trial_ended_unpaid: [`Trial ended unpaid: ${name}`, `The free trial of ${name} has ended without a purchase. It is locked, and its data is kept for the grace period.`],
  }[kind];
  await queue(db, { firmId, kind: 'trial', to: SUPPORT.email, mail: plain(what[0]!, [what[1]!]) });
  return true;
}

// ------------------------------------------------------------------ the owner
export const ownerOrders = async (db: Db, firmId?: string) => { await requireOwner(db); return (await db.query('SELECT * FROM owner_trial_orders($1)', [firmId ?? null])).rows; };
export async function ownerProof(db: Db, orderId: string) {
  await requireOwner(db);
  const r = (await db.query('SELECT * FROM owner_order_proof($1)', [orderId])).rows[0] as { name: string; type: string; bytes: Buffer } | undefined;
  if (!r) throw new HttpError(404, 'No proof of payment was sent with this order.', 'err.notFound');
  return r;
}

export interface MarkPaidInput { modules?: unknown; cleanup?: unknown; reference?: unknown; paidOn?: unknown; reason?: unknown }
/** The owner checked the bank. In ONE transaction: the same customer becomes a paying one, the optional modules not bought switch off, the first
 *  invoice is made and marked paid, and the customer is thanked. Anything wrong and nothing at all changes. */
export async function ownerMarkPaid(db: Db, firmId: string, x: MarkPaidInput, now: Date = new Date(), appUrl = 'https://app.nusuhbooks.com') {
  await requireOwner(db);
  const reason = String(x.reason ?? '').trim();
  if (!reason) bad('Say why the trial is changed.', 'err.trialReason');
  const paidOn = x.paidOn === undefined || x.paidOn === '' ? riyadhDate(now) : String(x.paidOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) bad('Enter the date of the payment.', 'err.payDate');
  const reference = x.reference === undefined ? null : String(x.reference).trim().slice(0, 80) || null;
  const orderId = (await db.query('SELECT owner_order_paid($1, $2, $3, $4, $5, $6, $7, $8) AS id', [firmId, modulesOf(x.modules), x.cleanup === true, reference, paidOn, reason, now, riyadhDate(now)])).rows[0].id as string;
  // the first invoice: the billing run bills everything that is due (as it does every six hours); this customer is due today
  await db.query('SELECT * FROM billing_run($1)', [riyadhDate(now)]);
  const inv = (await db.query(`SELECT id, number, total::text AS total, currency, to_char(period_start, 'YYYY-MM-DD') AS "periodStart", to_char(period_end, 'YYYY-MM-DD') AS "periodEnd"
    FROM billing_invoices WHERE firm_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [firmId])).rows[0] as { id: string; number: string; total: string; currency: string; periodStart: string; periodEnd: string } | undefined;
  if (!inv) throw new HttpError(500, 'The first invoice could not be made. Nothing was changed.', 'err.server');
  await db.query('SELECT billing_mark_paid($1, $2, $3)', [inv.id, paidOn, reference]);
  const who = (await db.query('SELECT firm_name, admin_name, admin_email FROM owner_trials_overview() WHERE firm_id = $1', [firmId])).rows[0] as { firm_name: string; admin_name: string | null; admin_email: string | null } | undefined;
  const admin = who?.admin_email ? { name: who.admin_name ?? 'there', email: who.admin_email } : null;
  if (admin) await queue(db, { firmId, kind: 'trial', to: admin.email, toName: admin.name, replyTo: SUPPORT.email,
    mail: thankYouMail(admin.name, who!.firm_name, { ...inv, paidOn, reference }, appUrl) });
  // What the customer was told to transfer is worked out from the prices in Payment settings; the invoice follows the customer's own plan, discount
  // and usage (Owner > Billing). When they differ the owner is told, so a wrong amount is never a surprise.
  const o = (await db.query('SELECT one_time_total::text AS one, yearly_total::text AS yearly FROM trial_orders WHERE id = $1', [orderId])).rows[0] as { one: string; yearly: string };
  const rate = Number((await db.query('SELECT vat_rate::text AS r FROM billing_settings')).rows[0].r);
  const sub = Math.round(Number(o.one) * 100) + Math.round(Number(o.yearly) * 100);
  const told = (sub + Math.round(sub * rate / 100)) / 100;
  const differs = Math.round(Number(inv.total) * 100) !== Math.round(told * 100);
  return { orderId, invoice: { number: inv.number, total: inv.total, currency: inv.currency }, thanked: Boolean(admin), customerWasTold: told.toFixed(2), differs };
}

/** Sends the reminder that is current for this customer again (with a reason), without touching the once-only log. */
export async function resendReminder(db: Db, firmId: string, reason: unknown, now: Date = new Date(), appUrl = 'https://app.nusuhbooks.com') {
  await requireOwner(db);
  const why = String(reason ?? '').trim();
  if (!why) bad('Say why the trial is changed.', 'err.trialReason');
  const t = (await db.query('SELECT * FROM trial_mail_targets() WHERE firm_id = $1', [firmId])).rows[0];
  if (!t) bad('This customer is not in an unpaid trial.', 'err.trialNotOpen');
  if (!t.admin_email) bad('This customer has no active Administrator to write to.', 'err.noAdmin');
  const n = currentNotice(stateOf(t), now);
  if (!n) bad('There is no reminder to send right now (the next one goes out at 09:00 Riyadh time).', 'err.noReminder');
  const prices = (await db.query('SELECT public_site_data() AS d')).rows[0].d;
  const mail = buildNotice(n!, { name: t.admin_name ?? 'there', firm: t.firm_name, appUrl, prices, modules: t.modules });
  await queue(db, { firmId, kind: 'trial', to: t.admin_email, toName: t.admin_name, replyTo: SUPPORT.email, mail });
  await db.query('SELECT owner_reminder_resent($1, $2, $3, $4)', [firmId, why, n!.key, now]);
  return { template: n!.key, to: t.admin_email as string };
}

export interface TrialRow {
  firmId: string; firmName: string; kind: string; status: string; level: string; label: 'trialing' | 'ending_soon' | 'ended' | 'in_grace' | 'closed' | 'paid';
  startedAt: string | null; endsAt: string | null; graceEndsAt: string | null; daysLeft: number | null; companies: string[]; adminName: string | null; adminEmail: string | null;
  lastLoginAt: string | null; emailsSent: number; emailsFailed: number; orderId: string | null; orderConfirmed: boolean;
  /** How the customer began: signed up by itself, or created by the owner; and anything the sign-up checks flagged. */
  source: 'self' | 'owner'; flags: string[];
  /** What the customer did in the guided setup, as counts only (never the books' contents). */
  setup: { step: string; businessType: string | null; goals: string[]; dataChoice: string | null; skipped: boolean; completed: boolean; tourPages: number; extractUsed: number;
    companies: number; contacts: number; documents: number; people: number; updatedAt: string } | null;
}
/** The owner's Trials view: every trial with where it stands now, and the counters that show conversion. */
export async function trialsOverview(db: Db, now: Date = new Date()) {
  await requireOwner(db);
  const rows = (await db.query('SELECT * FROM owner_trials_overview()')).rows;
  const selfMade = new Map((await db.query(`SELECT firm_id, flags FROM signup_events WHERE kind = 'verified' AND firm_id IS NOT NULL`)).rows.map((x) => [x.firm_id as string, x.flags as string[]]));
  const setups = new Map((await db.query('SELECT * FROM owner_setup_overview()')).rows.map((x) => [x.firm_id as string, x]));
  const trials: TrialRow[] = rows.map((r) => {
    const a = accessOf(stateOf(r), now);
    const paid = Boolean(r.converted_at);
    const left = a.trialing && r.trial_ends_at ? daysLeft(r.trial_ends_at, now) : null;
    const label: TrialRow['label'] = paid ? 'paid' : a.level === 'full' ? (left !== null && left <= 3 ? 'ending_soon' : 'trialing') : a.level === 'locked' ? 'in_grace' : 'closed';
    return {
      firmId: r.firm_id, firmName: r.firm_name, kind: r.kind, status: r.status, level: a.level, label,
      startedAt: r.trial_started_at?.toISOString() ?? null, endsAt: r.trial_ends_at?.toISOString() ?? null, graceEndsAt: r.grace_ends_at?.toISOString() ?? null,
      daysLeft: left, companies: r.companies, adminName: r.admin_name, adminEmail: r.admin_email, lastLoginAt: r.last_login_at?.toISOString() ?? null,
      emailsSent: r.emails_sent, emailsFailed: r.emails_failed, orderId: r.order_id, orderConfirmed: r.order_confirmed,
      source: selfMade.has(r.firm_id) ? 'self' : 'owner', flags: selfMade.get(r.firm_id) ?? [],
      setup: ((x) => x ? { step: x.step, businessType: x.business_type, goals: x.goals, dataChoice: x.data_choice, skipped: x.skipped, completed: x.completed, tourPages: x.tour_pages,
        extractUsed: x.extract_used, companies: x.companies, contacts: x.contacts, documents: x.documents, people: x.people, updatedAt: x.updated_at.toISOString() } : null)(setups.get(r.firm_id)),
    };
  });
  const counters = {
    started: trials.length,
    converted: trials.filter((t) => t.label === 'paid').length,
    ended: trials.filter((t) => t.label === 'in_grace' || t.label === 'closed').length,
    open: trials.filter((t) => t.label === 'trialing' || t.label === 'ending_soon').length,
    waitingOrders: trials.filter((t) => t.orderId).length,
    emailFailures: trials.reduce((n, t) => n + t.emailsFailed, 0),
  };
  return { counters, trials };
}

// ------------------------------------------------------------------ bank details (Payment settings)
export interface BankInput { accountName?: unknown; bank?: unknown; iban?: unknown; swift?: unknown }
export async function bankDetails(db: Db) {
  await requireOwner(db);
  return (await db.query(`SELECT coalesce(bank_account_name, '') AS "accountName", coalesce(bank_name, '') AS bank, coalesce(bank_iban, '') AS iban, coalesce(bank_swift, '') AS swift FROM billing_settings`)).rows[0];
}
/** The four bank lines shown to a customer who is buying. All empty clears them; otherwise all four are needed (a half-filled set would send people to a wrong account). */
export async function saveBankDetails(db: Db, x: BankInput) {
  await requireOwner(db);
  const t = (v: unknown) => String(v ?? '').trim();
  const accountName = t(x.accountName), bank = t(x.bank), iban = t(x.iban).replace(/\s+/g, '').toUpperCase(), swift = t(x.swift).replace(/\s+/g, '').toUpperCase();
  const filled = [accountName, bank, iban, swift].filter(Boolean).length;
  if (filled !== 0 && filled !== 4) bad('Fill in all four bank lines, or leave all four empty.', 'err.bankAll');
  if (accountName.length > 120 || bank.length > 120) bad('The account name and bank name are up to 120 letters.', 'err.bankLong');
  if (iban && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) bad('The IBAN looks wrong. Check it and try again.', 'err.iban');
  if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) bad('The SWIFT code looks wrong. It is 8 or 11 letters and digits.', 'err.swift');
  await db.query('UPDATE billing_settings SET bank_account_name = $1, bank_name = $2, bank_iban = $3, bank_swift = $4', [accountName || null, bank || null, iban || null, swift || null]);
}
