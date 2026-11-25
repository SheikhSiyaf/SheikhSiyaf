// Background jobs in a hosted installation: each run takes a database lock first, so when two server copies run (a
// restart overlapping, two instances behind a load balancer) only one of them does the work; the other skips that
// run. Each run is recorded (job_runs: started, finished, ok) for /health and the owner console.
import { reportError } from '../log/errorReport.js';
import type pg from 'pg';
import { redactText } from '../log/redact.js';

/** How often each job runs, in minutes, and the setting that turns it off (for /health). */
export const JOBS: Record<string, { everyMinutes: number; off: string }> = {
  einvoice_sender: { everyMinutes: 2, off: 'EINVOICE_JOBS' },
  email: { everyMinutes: 1, off: 'EMAIL_JOBS' },
  exchange_rates: { everyMinutes: 60, off: 'FX_JOBS' },
  accountant_tools: { everyMinutes: 60, off: 'TOOL_JOBS' },
  bank_feeds: { everyMinutes: 60, off: 'BANK_FEED_JOBS' },
  billing: { everyMinutes: 360, off: 'BILLING_JOBS' },
  lifecycle: { everyMinutes: 60, off: 'LIFECYCLE_JOBS' },
  signin_purge: { everyMinutes: 60, off: 'AUTH_PURGE_JOBS' },
};

interface Held { client: pg.PoolClient; running: boolean }
const held = new WeakMap<pg.Pool, Map<string, Held>>();

/** Runs fn only in the server copy that owns this job. The first copy to ask takes a database lock and keeps it for as
 *  long as it runs (on its own connection), so the other copies skip every run; if the owner stops or loses its
 *  connection, the lock is freed and the next copy to ask takes the job over. A run still going when the next one is
 *  due is skipped too. record=false when fn records the run itself. */
export async function runExclusive<T>(pool: pg.Pool, job: string, fn: () => Promise<T>, o: { record?: boolean } = {}): Promise<{ ran: false } | { ran: true; result: T }> {
  const mine = held.get(pool) ?? new Map<string, Held>();
  held.set(pool, mine);
  let h = mine.get(job);
  if (h && h.running) return { ran: false };
  if (h) {
    try { await h.client.query('SELECT 1'); } catch { mine.delete(job); try { h.client.release(true); } catch { /* gone */ } h = undefined; }
  }
  if (!h) {
    const client = await pool.connect();
    let ok = false;
    try { ok = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`nusuh-job:${job}`])).rows[0].ok; } catch { ok = false; }
    if (!ok) { client.release(); return { ran: false }; }
    client.on?.('error', () => { mine.delete(job); });
    h = { client, running: false };
    mine.set(job, h);
  }
  h.running = true;
  try {
    if (o.record === false) return { ran: true, result: await fn() };
    await pool.query('SELECT job_started($1)', [job]);
    try {
      const result = await fn();
      await pool.query('SELECT job_finished($1, NULL)', [job]);
      return { ran: true, result };
    } catch (e) {
      await pool.query('SELECT job_finished($1, $2)', [job, redactText((e as Error).message ?? String(e))]).catch(() => undefined);
      void reportError({ where: `job ${job}`, message: (e as Error).message ?? String(e), stack: (e as Error).stack });
      throw e;
    }
  } finally {
    h.running = false;
  }
}

/** Gives up every job this server copy owns (when it stops), so another copy can take them over at once. */
export async function releaseJobs(pool: pg.Pool): Promise<void> {
  const mine = held.get(pool);
  if (!mine) return;
  for (const [job, h] of mine) {
    await h.client.query('SELECT pg_advisory_unlock(hashtext($1))', [`nusuh-job:${job}`]).catch(() => undefined);
    try { h.client.release(); } catch { /* already gone */ }
  }
  mine.clear();
}
