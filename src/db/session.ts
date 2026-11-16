// Every request runs inside one transaction with app.user_id set.
// The database derives the user's companies and roles from memberships (row-level security).
import pg from 'pg';
import { HttpError } from '../api/errors.js';

export type Db = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
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
