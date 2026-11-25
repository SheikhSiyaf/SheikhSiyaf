// The free-trial lifecycle (see src/books/trialRules.ts for the schedule and db/migrations/0070_trial_lifecycle.sql for the
// rules the database keeps). The owner starts, extends, converts and closes trials; the daily job moves unpaid trials on;
// the API asks myAccess() on every request to decide whether the signed-in person may still work.
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { runExclusive } from '../jobs/runJob.js';
import { LIFECYCLE, accessOf, addDays, riyadhDate, trialWindow, type Access, type SubState } from './trialRules.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };

async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}

interface StateRow { status: string; trial_started_at: Date | null; trial_ends_at: Date | null; grace_ends_at: Date | null; converted_at: Date | null; cancelled_at: Date | null }
export const stateOf = (r: StateRow | undefined): SubState | null => r ? {
  status: r.status, trialEndsAt: r.trial_ends_at, graceEndsAt: r.grace_ends_at, convertedAt: r.converted_at, cancelledAt: r.cancelled_at,
} : null;

/** What the signed-in person may do right now, from their own customer's trial facts and the clock. The platform owner is never locked. */
export async function myAccess(db: Db, now: Date = new Date()): Promise<Access> {
  const r = (await db.query('SELECT * FROM my_access_state()')).rows[0] as StateRow | undefined;
  return accessOf(stateOf(r), now);
}

/** The same at sign-in, before there is a session. */
export async function accessForUser(pool: pg.Pool, userId: string, now: Date = new Date()): Promise<Access> {
  const r = (await pool.query('SELECT * FROM access_state_for_user($1)', [userId])).rows[0] as StateRow | undefined;
  return accessOf(stateOf(r), now);
}

export interface StartTrialInput {
  planId: string;
  cycle: 'monthly' | 'yearly';
  /** The first day of the trial (a Riyadh date). */
  startOn: string;
  /** Trial length; the schedule's 15 days unless an older plan sets its own. */
  days?: number;
  implementation?: boolean;
  discountPct?: string;
  notes?: string | null;
}

/** Starts a trial for a customer (or starts it again for a cancelled one). Allowed for the owner, and for the server when a customer signs up on its own. */
export async function startTrial(db: Db, firmId: string, x: StartTrialInput): Promise<string> {
  const w = trialWindow(new Date(`${x.startOn}T00:00:00+03:00`), x.days ?? LIFECYCLE.trialDays);
  const r = await db.query('SELECT trial_begin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS id', [
    firmId, x.planId, x.cycle, x.implementation === true, x.discountPct ?? '0', x.notes?.trim() || null,
    x.startOn, addDays(w.lastDay, 1), w.startedAt, w.endsAt, w.graceEndsAt]);
  return r.rows[0].id as string;
}

const reasonOf = (reason?: string): string => (reason?.trim() ? reason.trim() : bad('Say why the trial is changed.', 'err.trialReason'));

/** Owner: give a trial more days (1 to 90). A locked customer whose trial is open again works at once. */
export async function extendTrial(db: Db, firmId: string, days: number, reason: string | undefined, now: Date = new Date()) {
  await requireOwner(db);
  if (!Number.isInteger(days) || days < 1 || days > 90) bad('Extend a trial by 1 to 90 days.', 'err.trialDays');
  await db.query('SELECT trial_extend($1, $2, $3, $4, $5)', [firmId, days, reasonOf(reason), now, LIFECYCLE.graceDays]);
}

/** Owner: the customer bought. Unlocks the same customer with all its data; the first bill follows with the next billing run. */
export async function convertTrial(db: Db, firmId: string, reason: string | undefined, now: Date = new Date()) {
  await requireOwner(db);
  await db.query('SELECT trial_convert($1, $2, $3, $4)', [firmId, reasonOf(reason), now, riyadhDate(now)]);
}

/** Owner: close a trial now. */
export async function cancelTrial(db: Db, firmId: string, reason: string | undefined, now: Date = new Date()) {
  await requireOwner(db);
  await db.query('SELECT trial_cancel($1, $2, $3)', [firmId, reasonOf(reason), now]);
}

export interface Moved { firmId: string; from: string; to: string }
/** Moves unpaid trials on (open -> ended -> closed) as far as the clock says. Safe to run again and to catch up after missed days. */
export async function advance(db: { query: Db['query'] }, now: Date = new Date(), firmId?: string): Promise<Moved[]> {
  const r = await db.query('SELECT r_firm, r_from, r_to FROM lifecycle_advance($1, $2, $3)', [now, LIFECYCLE.graceDays, firmId ?? null]);
  return r.rows.map((x: { r_firm: string; r_from: string; r_to: string }) => ({ firmId: x.r_firm, from: x.r_from, to: x.r_to }));
}

/** The daily job, nobody signed in (LIFECYCLE_JOBS=off turns it off). It runs hourly: the lock itself follows the clock, so a late run changes nothing for customers. */
export function startLifecycleJob(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.LIFECYCLE_JOBS === 'off') return () => undefined;
  const go = async () => {
    await runExclusive(pool, 'lifecycle', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const moved = await advance(c);
        await c.query('COMMIT');
        if (moved.length) log(`Trials: ${moved.length} moved on`);
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }).catch((e) => log(`Trial job failed: ${(e as Error).message}`));
  };
  const first = setTimeout(() => void go(), 45_000);
  const every = setInterval(() => void go(), 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
