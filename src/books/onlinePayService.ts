// Online payment of invoices (db/migrations/0037). The company turns it on (Sales > Online payments) with its provider
// and the account the money lands in. The customer presses Pay online on the invoice link; once the provider confirms
// (asked by the server itself, after its webhook or when the customer comes back), the payment is recorded against
// the invoice as the person who turned online payments on, in the same transaction that marks it paid.
import type pg from 'pg';
import { withUser, type Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../auth/secretBox.js';
import { fromMinor, toMinor } from '../money.js';
import { PROVIDERS, PROVIDER_NAMES, type Fetch } from '../payments/providers.js';
import { recordPayment } from './documentsService.js';
import { hashLinkToken } from './emailService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
let encryptionKey = config.encryptionKey || config.sessionSecret;
let fetchFn: Fetch = (...a) => fetch(...a);
/** Set by the server (encryption key) and by tests (a stand-in for the provider). */
export function configurePayments(o: { encryptionKey?: string; fetch?: Fetch }) {
  if (o.encryptionKey) encryptionKey = o.encryptionKey;
  if (o.fetch) fetchFn = o.fetch;
}
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ settings (signed in)
export async function settings(db: Db, companyId: string) {
  const r = (await db.query(`SELECT enabled, provider, publishable_key AS "publishableKey", secret_enc IS NOT NULL AS "hasSecret", deposit_account_id AS "depositAccountId",
      (SELECT full_name FROM users WHERE id = enabled_by) AS "enabledBy" FROM payment_settings WHERE company_id = $1`, [companyId])).rows[0];
  return r ?? { enabled: false, provider: 'sandbox', publishableKey: null, hasSecret: false, depositAccountId: null, enabledBy: null };
}
export interface SettingsInput { enabled?: boolean; provider?: string; publishableKey?: string | null; secretKey?: string | null; depositAccountId?: string | null }
export async function saveSettings(db: Db, companyId: string, x: SettingsInput) {
  const provider = String(x.provider ?? 'sandbox');
  if (!PROVIDER_NAMES.includes(provider)) bad('Choose the payment provider.', 'err.payProvider');
  const secret = x.secretKey?.trim() ? encryptSecret(encryptionKey, x.secretKey.trim()) : null;
  await db.query(`INSERT INTO payment_settings (company_id, enabled, provider, publishable_key, secret_enc, deposit_account_id) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (company_id) DO UPDATE SET enabled = $2, provider = $3, publishable_key = $4, secret_enc = coalesce($5, payment_settings.secret_enc), deposit_account_id = $6`,
    [companyId, Boolean(x.enabled), provider, x.publishableKey?.trim() || null, secret, x.depositAccountId || null]);
}
export async function list(db: Db, companyId: string) {
  return (await db.query(`SELECT o.id, o.document_id AS "documentId", d.number, c.name AS customer, o.amount::text, o.currency, o.provider, o.provider_ref AS "providerRef",
      o.status, o.last_error AS "lastError", o.created_at AS "createdAt", o.paid_at AS "paidAt", p.number AS "paymentNumber"
    FROM online_payments o JOIN documents d ON d.id = o.document_id JOIN contacts c ON c.id = d.contact_id LEFT JOIN payments p ON p.id = o.payment_id
    WHERE o.company_id = $1 ORDER BY o.created_at DESC LIMIT 200`, [companyId])).rows;
}

// ------------------------------------------------------------------ the customer (nobody signed in)
/** Pay online from an invoice link: makes the provider's checkout for what is due and returns where to go. */
export async function start(pool: pg.Pool, token: string, base: string): Promise<{ url: string }> {
  const r = (await pool.query('SELECT online_pay_start($1) AS r', [hashLinkToken(token)])).rows[0].r as
    { id: string; amount: string; currency: string; provider: string; secretEnc: string | null; number: string; seller: string };
  const p = PROVIDERS[r.provider]!;
  const out = await p.create({ id: r.id, amountMinor: toMinor(r.amount), currency: r.currency, description: `Invoice ${r.number} · ${r.seller}`,
    returnUrl: `${base}/i/${token}?paid=${r.id}`, webhookUrl: `${base}/api/public/payments/webhook/${r.provider}`, base },
  r.secretEnc ? decryptSecret(encryptionKey, r.secretEnc) : '', fetchFn);
  await pool.query('SELECT online_pay_checkout($1, $2, $3)', [r.id, out.ref, out.url]);
  return { url: out.url };
}

/** Asks the provider and, when paid, records the payment (once). Returns created (still waiting), paid or failed. */
export async function confirm(pool: pg.Pool, by: { id?: string; ref?: string }): Promise<'created' | 'paid' | 'failed' | 'unknown'> {
  const g = (await pool.query('SELECT * FROM online_pay_get($1, $2)', [by.id ?? null, by.ref ?? null])).rows[0];
  if (!g) return 'unknown';
  if (g.status !== 'created' || !g.provider_ref) return g.status;
  const c = await PROVIDERS[g.provider]!.check(g.provider_ref, g.secret_enc ? decryptSecret(encryptionKey, g.secret_enc) : '', fetchFn);
  if (c.status === 'pending') return 'created';
  if (c.status === 'failed') { await pool.query('SELECT online_pay_failed($1, $2)', [g.id, c.detail ?? 'Declined']); return 'failed'; }
  if (c.amountMinor !== toMinor(g.amount) || c.currency !== g.currency) {
    await pool.query('SELECT online_pay_failed($1, $2)', [g.id, `The provider reports ${c.currency} ${fromMinor(c.amountMinor)}, not ${g.currency} ${g.amount}.`]);
    return 'failed';
  }
  if (!g.run_as || !g.deposit_account_id) throw new Error(`Online payment ${g.id} is paid but online payments are turned off: record it by hand.`);
  try {
    await withUser(pool, g.run_as, async (db) => {
      // Settle what is still due (the invoice may have been paid some other way meanwhile); any rest stays on the customer's account.
      const due = toMinor((await db.query('SELECT document_amount_due($1)::numeric(18,2)::text AS d', [g.document_id])).rows[0].d);
      const amount = toMinor(g.amount);
      const settle = due < amount ? due : amount;
      const paymentId = await recordPayment(db, g.company_id, { direction: 'received', contactId: g.contact_id, date: today(), amount: g.amount, accountId: g.deposit_account_id,
        method: 'card', reference: `Online ${g.provider_ref}`, allocations: settle > 0n ? [{ documentId: g.document_id, amount: fromMinor(settle) }] : [] });
      await db.query('SELECT online_pay_done($1, $2)', [g.id, paymentId]);
    });
  } catch (e) {
    if (/already settled/.test((e as Error).message)) return 'paid';   // recorded by the other confirmation at the same moment
    throw e;
  }
  return 'paid';
}
