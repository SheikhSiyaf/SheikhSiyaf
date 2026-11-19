// Every request runs inside one transaction with app.user_id set.
// The database derives the user's companies and roles from memberships (row-level security).
import pg from 'pg';
import { HttpError } from '../api/errors.js';

export type Db = pg.PoolClient;

/**
 * How the connection is encrypted, decided here rather than left to the connection string.
 *
 * A hosted database is reached across the public internet, and every row of it is a client's books. The driver's
 * own default is not good enough to rely on: connecting with sslmode=require to a server holding a self-signed
 * certificate succeeds without complaint, so the connection is encrypted but the server is never checked, which an
 * attacker in the middle can use. node-postgres also warns that it is changing what sslmode=require means, so a
 * connection string copied from a host today may behave differently after an upgrade.
 *
 * So: a database reached over the public internet must present a certificate signed by a real authority. Neon and
 * Supabase do, and so does Render's external address. There is deliberately no way to switch this off through the
 * connection string, because that switch would be the first thing a mistake reaches for.
 *
 * ONE EXCEPTION, which Render's own documentation requires: its internal address (a host name with no dots, such as
 * dpg-abc123-a) uses a self-signed certificate and "does not support sslmode=verify-ca or verify-full". A name with
 * no dots exists only on the host's private network and cannot be reached from the internet, so there is nobody to
 * stand in the middle. For those the connection is still encrypted, with no fall-back to plaintext, but the
 * certificate is accepted. The first version of this function demanded a verified certificate everywhere and would
 * have refused to connect to Render's own database; that was caught by reading their documentation.
 *
 * Returns undefined for a local database, where there is no network to listen on and certificates are self-signed.
 */
export function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;   // not a URL at all: a unix socket or a local development setting
  }
  const local = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (local) return undefined;
  const privateName = !host.includes('.') && !host.includes(':') && !host.startsWith('[');
  return privateName ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, ssl: sslFor(connectionString) });
  // An idle connection dropped by the database (restart, failover) must not crash the server;
  // the pool opens a new connection for the next request.
  pool.on('error', (err) => console.error('Database connection lost:', err.message));
  return pool;
}

/** actingFirm: the tenant the platform owner is working in on this request (ignored for everyone else by the database).
 *  sessionVersion: the sign-in cookie's version; the request is refused unless it is the person's current one (0053). */
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (db: Db) => Promise<T>, actingFirm?: string | null, sessionVersion?: number): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = (await client.query("SELECT set_config('app.user_id', $1, true), CASE WHEN $2::int IS NULL THEN true ELSE session_ok($1::uuid, $2::int) END AS ok",
      [userId, sessionVersion ?? null])).rows[0].ok;
    if (!ok) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    if (actingFirm) await client.query("SELECT set_config('app.acting_firm', $1, true)", [actingFirm]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The automatic jobs (db/migrations/0051, 0052): ZATCA's answers, paid online payments, recurring invoices, automatic
 *  reminders, the month-end exchange-rate revaluation and bank feed syncs. */
export type SystemJob = 'einvoice' | 'online_payment' | 'recurring' | 'reminders' | 'fx' | 'bank_feed';
/** Runs `fn` as the built-in automatic sender, for one company and one job. The database allows nothing else. */
export async function withSystem<T>(pool: pg.Pool, companyId: string, job: SystemJob, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', (SELECT system_user_id())::text, true), set_config('app.system_company', $1, true), set_config('app.system_job', $2, true)`,
      [companyId, job]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
