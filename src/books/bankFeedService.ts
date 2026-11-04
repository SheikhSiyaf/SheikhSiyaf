// Direct bank feeds (db/migrations/0038): a bank account connected through an open-banking provider brings its own
// transactions in as statement lines, through the same import as a statement file (duplicates skipped), then the
// bank rules book what they recognise. Synced on connecting, by Sync now, and every six hours by the server.
import type pg from 'pg';
import { withUser, type Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { FEED_PROVIDERS } from '../bankfeeds/providers.js';
import { applyRules, getBankAccount, importStatement } from './bankService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** How far back the first sync reaches. */
export const FIRST_SYNC_DAYS = 30;

const FEED_COLS = `f.id, f.bank_account_id AS "bankAccountId", f.provider, f.status, f.external_account_id AS "externalAccountId",
  to_char(f.consent_expires_on, 'YYYY-MM-DD') AS "consentExpiresOn", f.last_sync_at AS "lastSyncAt", to_char(f.synced_to, 'YYYY-MM-DD') AS "syncedTo",
  f.last_error AS "lastError", (SELECT full_name FROM users WHERE id = f.created_by) AS "connectedBy"`;

export async function feedFor(db: Db, bankAccountId: string) {
  const feed = (await db.query(`SELECT ${FEED_COLS} FROM bank_feeds f WHERE f.bank_account_id = $1 AND f.status <> 'disconnected'`, [bankAccountId])).rows[0] ?? null;
  return { feed, providers: Object.entries(FEED_PROVIDERS).map(([key, p]) => ({ key, ready: p.ready })) };
}

export async function connect(db: Db, bankAccountId: string, provider: string, day = today()) {
  const p = FEED_PROVIDERS[provider] ?? bad('Choose the bank feed provider.', 'err.feedProvider');
  if (!p.ready) bad('This provider is not connected yet.', 'err.feedNotReady');
  const acct = await getBankAccount(db, bankAccountId);
  if (acct.kind !== 'bank' || acct.status !== 'active') bad('Connect an active bank account.', 'err.feedAccount');
  if ((await feedFor(db, bankAccountId)).feed) bad('This bank account is already connected.', 'err.feedExists');
  const c = await p.connect(acct.iban ?? acct.accountNumber ?? acct.id);
  const id = (await db.query(`INSERT INTO bank_feeds (company_id, bank_account_id, provider, external_account_id, consent_expires_on, created_by)
    VALUES ($1, $2, $3, $4, $5, app_user_id()) RETURNING id`, [acct.companyId, bankAccountId, provider, c.externalAccountId, addDays(day, c.consentDays)])).rows[0].id as string;
  return { id, ...(await sync(db, id, day)) };
}

/** Brings in the transactions since the last sync (the first time, the last 30 days) up to the day. */
export async function sync(db: Db, feedId: string, day = today()) {
  const f = (await db.query(`SELECT id, company_id, bank_account_id, provider, status, external_account_id, to_char(consent_expires_on, 'YYYY-MM-DD') AS consent,
    to_char(synced_to, 'YYYY-MM-DD') AS synced_to FROM bank_feeds WHERE id = $1 FOR UPDATE`, [feedId])).rows[0] ?? bad('Not found.', 'err.notFound');
  if (f.status === 'disconnected') bad('This bank feed is disconnected. Connect the bank again.', 'err.feedDisconnected');
  if (f.consent && f.consent < day) {
    await db.query(`UPDATE bank_feeds SET status = 'expired' WHERE id = $1`, [feedId]);
    return { imported: 0, skipped: 0, booked: 0, expired: true };
  }
  const from = f.synced_to ? addDays(f.synced_to, 1) : addDays(day, -FIRST_SYNC_DAYS);
  let imported = 0, skipped = 0, booked = 0;
  if (from <= day) {
    const openInvoices = f.provider === 'sandbox' ? (await db.query(`SELECT d.id, d.number, c.name AS customer, to_char(d.issue_date, 'YYYY-MM-DD') AS "issueDate",
        document_amount_due(d.id)::numeric(18,2)::text AS due FROM documents d JOIN contacts c ON c.id = d.contact_id
      WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND document_amount_due(d.id) > 0`, [f.company_id])).rows : [];
    const lines = await FEED_PROVIDERS[f.provider]!.transactions(f.external_account_id, from, day, { feedId, openInvoices });
    if (lines.length) {
      const r = await importStatement(db, f.bank_account_id, { fileName: `Bank feed ${from} to ${day}`, lines, feedId });
      imported = r.imported; skipped = r.skipped;
      booked = await applyRules(db, f.bank_account_id);
    }
  }
  await db.query(`UPDATE bank_feeds SET status = 'active', last_error = NULL, last_sync_at = now(), synced_to = GREATEST(coalesce(synced_to, $2::date), $2::date) WHERE id = $1`, [feedId, day]);
  return { imported, skipped, booked, expired: false };
}

export async function disconnect(db: Db, bankAccountId: string) {
  const r = await db.query(`UPDATE bank_feeds SET status = 'disconnected' WHERE bank_account_id = $1 AND status <> 'disconnected' RETURNING id`, [bankAccountId]);
  if (!r.rowCount) bad('This bank account is not connected.', 'err.feedNone');
}

/** The server's job: syncs each live feed not synced in the last six hours, as the person who connected it. */
export async function runBankFeeds(pool: pg.Pool, day = today()) {
  const due = (await pool.query('SELECT id, run_as FROM bank_feeds_due(6)')).rows as { id: string; run_as: string }[];
  const out: { id: string; imported: number; problem: string | null }[] = [];
  for (const d of due) {
    try { out.push({ id: d.id, imported: (await withUser(pool, d.run_as, (db) => sync(db, d.id, day))).imported, problem: null }); }
    catch (e) { await pool.query('SELECT bank_feed_note($1, $2)', [d.id, (e as Error).message]); out.push({ id: d.id, imported: 0, problem: (e as Error).message }); }
  }
  return out;
}
export function startBankFeedJob(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.BANK_FEED_JOBS === 'off') return () => undefined;
  const go = async () => {
    try { for (const r of await runBankFeeds(pool)) if (r.imported || r.problem) log(`Bank feed ${r.id}: ${r.problem ?? `${r.imported} new lines`}`); }
    catch (e) { log(`Bank feed job failed: ${(e as Error).message}`); }
  };
  const first = setTimeout(() => void go(), 40_000);
  const every = setInterval(() => void go(), 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
