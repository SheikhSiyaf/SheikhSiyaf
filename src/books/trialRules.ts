// The free-trial schedule and who may do what at each point of it. Pure functions: no database, no clock of their own.
// Every number of the schedule is written here once and handed to the database and the screens from here.
//
// Customer states: trial (open) -> trial_ended (locked, grace period) -> cancelled (export only, then closed).
// Trial or trial_ended -> active when the customer buys. The lock follows the CLOCK (accessOf), not the daily job,
// so a missed job day can never leave an unpaid customer with open access.

export const LIFECYCLE = {
  timezone: 'Asia/Riyadh',
  /** Saudi Arabia has no daylight saving time, so Riyadh is always three hours ahead of UTC. */
  utcOffsetHours: 3,
  /** Days of free use, counting the day the trial starts. It ends at 23:59:59.999 on the last day. */
  trialDays: 15,
  /** Days after the last trial day that the customer's data waits locked, so buying restores everything. */
  graceDays: 30,
  /** Days after closing (cancelled) that the customer's own users can still export their data. */
  exportWindowDays: 60,
  /** Days after closing before a closed trial's data may be deleted. Never earlier. */
  deleteAfterDays: 90,
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date in Riyadh of an instant, as YYYY-MM-DD. */
export function riyadhDate(at: Date): string {
  return new Date(at.getTime() + LIFECYCLE.utcOffsetHours * HOUR).toISOString().slice(0, 10);
}

/** The last millisecond (23:59:59.999) of a Riyadh calendar date. */
export function endOfRiyadhDay(date: string): Date {
  if (!DATE.test(date)) throw new Error(`Not a date: ${date}`);
  return new Date(Date.parse(`${date}T23:59:59.999Z`) - LIFECYCLE.utcOffsetHours * HOUR);
}

/** A calendar date plus a number of days (negative goes back). Month ends, year ends and leap days are handled by the calendar. */
export function addDays(date: string, days: number): string {
  if (!DATE.test(date)) throw new Error(`Not a date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export interface TrialWindow { startedAt: Date; lastDay: string; endsAt: Date; graceEndsAt: Date }

/** When a trial that starts at the given moment ends, and when its grace period ends. */
export function trialWindow(startedAt: Date, days: number = LIFECYCLE.trialDays, graceDays: number = LIFECYCLE.graceDays): TrialWindow {
  if (!Number.isInteger(days) || days < 1) throw new Error('A trial lasts at least one day.');
  const lastDay = addDays(riyadhDate(startedAt), days - 1);
  return { startedAt, lastDay, endsAt: endOfRiyadhDay(lastDay), graceEndsAt: endOfRiyadhDay(addDays(lastDay, graceDays)) };
}

/** The app header's count: today counts, so a trial shows 15 on its first day and 1 on its last. 0 once it is over. */
export function daysLeft(endsAt: Date, now: Date): number {
  if (now.getTime() > endsAt.getTime()) return 0;
  return daysBetween(riyadhDate(now), riyadhDate(endsAt)) + 1;
}

/** The count e-mails use: whole days still to come after today ("five days left" on day 10, 0 on the last day). */
export function daysAfterToday(endsAt: Date, now: Date): number {
  return Math.max(0, daysLeft(endsAt, now) - 1);
}

/** The end of a trial moved by whole days (it stays at 23:59:59.999 Riyadh time). */
export function extendEnd(endsAt: Date, days: number): Date {
  if (!Number.isInteger(days)) throw new Error('Days must be a whole number.');
  return new Date(endsAt.getTime() + days * DAY);
}

/** What the customer can still do after closing, and the earliest day its data may be deleted. */
export function closingDates(closedAt: Date): { exportUntil: Date; deleteNotBefore: Date } {
  const day = riyadhDate(closedAt);
  return {
    exportUntil: endOfRiyadhDay(addDays(day, LIFECYCLE.exportWindowDays)),
    deleteNotBefore: endOfRiyadhDay(addDays(day, LIFECYCLE.deleteAfterDays)),
  };
}

/** The subscription facts that decide access (as stored: dates are instants). */
export interface SubState {
  status: string;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  convertedAt: Date | null;
  cancelledAt: Date | null;
}

/**  full         everything works (trialing, paying, or no trial on record)
 *   locked       trial over, inside the grace period: only the "trial has ended" screen, buying, contact and export
 *   export_only  closed (cancelled): the customer's own users may only export their data, for the export window
 *   closed       after the export window: nobody signs in; the data waits for deletion */
export type Level = 'full' | 'locked' | 'export_only' | 'closed';

export interface Access {
  level: Level;
  /** Inside the free trial right now. */
  trialing: boolean;
  /** The header's count while trialing, otherwise null. */
  daysLeft: number | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  exportUntil: Date | null;
  deleteNotBefore: Date | null;
}

const none = { trialing: false, daysLeft: null, trialEndsAt: null, graceEndsAt: null, exportUntil: null, deleteNotBefore: null };

export function accessOf(s: SubState | null, now: Date): Access {
  // No subscription, or one that never had a trial (billed the usual way): nothing here changes what it could do before.
  if (!s || !s.trialEndsAt) return { level: 'full', ...none };
  const ends = s.trialEndsAt;
  const grace = s.graceEndsAt ?? endOfRiyadhDay(addDays(riyadhDate(ends), LIFECYCLE.graceDays));
  const dates = { trialEndsAt: ends, graceEndsAt: grace };
  // Someone who bought is never locked by the trial clock. (An older paying customer who later cancelled is not
  // locked either: that is how cancelling has always worked; the owner decides whether to change it.)
  if (s.convertedAt || s.status === 'active' || s.status === 'past_due') return { level: 'full', ...none, ...dates };

  const t = now.getTime();
  const closedAt = s.status === 'cancelled' ? (s.cancelledAt ?? grace) : t > grace.getTime() ? grace : null;
  if (closedAt) {
    const c = closingDates(closedAt);
    return { level: t <= c.exportUntil.getTime() ? 'export_only' : 'closed', ...none, ...dates, ...c };
  }
  if (t > ends.getTime()) return { level: 'locked', ...none, ...dates };
  return { level: 'full', ...none, ...dates, trialing: true, daysLeft: daysLeft(ends, now) };
}
