// Free-trial dates and access rules: pure functions, no database. Riyadh time is a fixed UTC+3 (no daylight saving).
// A trial lasts 15 days counting the day it starts, and ends at 23:59:59.999 Riyadh time on day 15.
import { describe, it, expect } from 'vitest';
import {
  LIFECYCLE, accessOf, addDays, closingDates, daysAfterToday, daysLeft, endOfRiyadhDay, extendEnd, riyadhDate, trialWindow, type SubState,
} from '../src/books/trialRules.js';

const d = (s: string) => new Date(s);

describe('Riyadh dates', () => {
  it('the Riyadh date is three hours ahead of UTC', () => {
    expect(riyadhDate(d('2026-03-10T20:59:59.999Z'))).toBe('2026-03-10');
    expect(riyadhDate(d('2026-03-10T21:00:00.000Z'))).toBe('2026-03-11');   // midnight in Riyadh
    expect(riyadhDate(d('2026-12-31T21:30:00Z'))).toBe('2027-01-01');
  });

  it('the end of a Riyadh day is 23:59:59.999 there', () => {
    expect(endOfRiyadhDay('2026-02-14').toISOString()).toBe('2026-02-14T20:59:59.999Z');
  });

  it('adds days across month ends, year ends and a leap day', () => {
    expect(addDays('2026-01-31', 14)).toBe('2026-02-14');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(addDays('2028-02-20', 14)).toBe('2028-03-05');   // 2028 is a leap year
    expect(addDays('2027-02-20', 14)).toBe('2027-03-06');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('The trial window', () => {
  it('is 15 days counting the first day, ending at 23:59 on day 15', () => {
    const w = trialWindow(d('2026-01-31T10:00:00Z'));   // 13:00 in Riyadh on 31 January
    expect(w.lastDay).toBe('2026-02-14');
    expect(w.endsAt.toISOString()).toBe('2026-02-14T20:59:59.999Z');
    expect(LIFECYCLE.trialDays).toBe(15);
  });

  it('counts the day in Riyadh, not in UTC: 00:30 in Riyadh is still the day before in UTC', () => {
    const w = trialWindow(d('2026-03-10T21:30:00Z'));   // 00:30 on 11 March in Riyadh
    expect(w.lastDay).toBe('2026-03-25');
  });

  it('crosses a year end and a leap day correctly', () => {
    expect(trialWindow(d('2026-12-25T00:00:00Z')).lastDay).toBe('2027-01-08');
    expect(trialWindow(d('2028-02-20T08:00:00Z')).lastDay).toBe('2028-03-05');
  });

  it('keeps the data for the grace period after the last day (30 days)', () => {
    const w = trialWindow(d('2026-01-31T10:00:00Z'));
    expect(w.graceEndsAt.toISOString()).toBe('2026-03-16T20:59:59.999Z');   // 14 February + 30 days
    expect(LIFECYCLE.graceDays).toBe(30);
  });

  it('a different length (an older plan with its own trial days) uses the same rules', () => {
    expect(trialWindow(d('2026-01-01T09:00:00Z'), 14).lastDay).toBe('2026-01-14');
  });
});

describe('Days left', () => {
  const w = trialWindow(d('2026-01-10T05:00:00Z'));   // 08:00 on 10 January in Riyadh; last day 24 January
  it('counts today: 15 on the first day, 1 on the last day, 0 afterwards', () => {
    expect(daysLeft(w.endsAt, d('2026-01-10T05:00:00Z'))).toBe(15);
    expect(daysLeft(w.endsAt, d('2026-01-10T20:59:59Z'))).toBe(15);   // late the same evening
    expect(daysLeft(w.endsAt, d('2026-01-19T06:00:00Z'))).toBe(6);    // day 10
    expect(daysLeft(w.endsAt, d('2026-01-24T08:00:00Z'))).toBe(1);    // day 15, the last one
    expect(daysLeft(w.endsAt, d('2026-01-24T20:59:59.999Z'))).toBe(1);
    expect(daysLeft(w.endsAt, d('2026-01-24T21:00:00Z'))).toBe(0);    // midnight: over
  });
  it('the e-mail count (days after today) is one less, and 0 on the last day', () => {
    expect(daysAfterToday(w.endsAt, d('2026-01-19T06:00:00Z'))).toBe(5);   // day 10: five days left
    expect(daysAfterToday(w.endsAt, d('2026-01-22T06:00:00Z'))).toBe(2);   // day 13: two days left
    expect(daysAfterToday(w.endsAt, d('2026-01-23T06:00:00Z'))).toBe(1);   // day 14: ends tomorrow
    expect(daysAfterToday(w.endsAt, d('2026-01-24T06:00:00Z'))).toBe(0);
    expect(daysAfterToday(w.endsAt, d('2026-02-01T06:00:00Z'))).toBe(0);
  });
});

describe('Extending a trial', () => {
  it('moves the end by whole days and keeps it at 23:59:59.999', () => {
    const w = trialWindow(d('2026-01-31T10:00:00Z'));
    expect(extendEnd(w.endsAt, 7).toISOString()).toBe('2026-02-21T20:59:59.999Z');
    expect(riyadhDate(extendEnd(w.endsAt, 30))).toBe('2026-03-16');
  });
});

describe('Closing dates', () => {
  it('data can be exported for 60 days after closing and is deleted no earlier than 90 days after', () => {
    const c = closingDates(d('2026-03-17T05:00:00Z'));   // 08:00 on 17 March in Riyadh
    expect(riyadhDate(c.exportUntil)).toBe('2026-05-16');
    expect(c.exportUntil.toISOString()).toBe('2026-05-16T20:59:59.999Z');
    expect(riyadhDate(c.deleteNotBefore)).toBe('2026-06-15');
    expect(LIFECYCLE.exportWindowDays).toBe(60);
    expect(LIFECYCLE.deleteAfterDays).toBe(90);
  });
});

describe('Access', () => {
  const w = trialWindow(d('2026-01-31T10:00:00Z'));   // ends 14 Feb 23:59:59.999 Riyadh; grace ends 16 Mar
  const trial: SubState = { status: 'trial', trialEndsAt: w.endsAt, graceEndsAt: w.graceEndsAt, convertedAt: null, cancelledAt: null };
  const at = (iso: string) => accessOf(trial, d(iso)).level;

  it('everything is open during the trial, to the last millisecond', () => {
    expect(at('2026-01-31T10:00:00Z')).toBe('full');
    expect(at('2026-02-14T20:59:59.999Z')).toBe('full');
    expect(accessOf(trial, d('2026-02-14T20:59:59.999Z')).trialing).toBe(true);
  });

  it('locks at once after the last millisecond, even if the daily job has not run (the lock follows the clock)', () => {
    expect(at('2026-02-14T21:00:00.000Z')).toBe('locked');
    expect(accessOf(trial, d('2026-02-14T21:00:00Z')).trialing).toBe(false);
    expect(at('2026-03-16T20:59:59.999Z')).toBe('locked');
  });

  it('after the grace period only the export of the data is left, for 60 days, then nothing', () => {
    expect(at('2026-03-16T21:00:00.000Z')).toBe('export_only');
    // closed on the grace end date (16 March): export until 15 May
    expect(at('2026-05-15T20:59:59.999Z')).toBe('export_only');
    expect(at('2026-05-15T21:00:00.000Z')).toBe('closed');
  });

  it('a trial_ended row behaves the same as a trial row past its end', () => {
    const ended: SubState = { ...trial, status: 'trial_ended' };
    expect(accessOf(ended, d('2026-02-20T00:00:00Z')).level).toBe('locked');
    expect(accessOf(ended, d('2026-03-17T00:00:00Z')).level).toBe('export_only');
  });

  it('a cancelled row is export-only from the day it was cancelled, closed after the export window', () => {
    const cancelled: SubState = { ...trial, status: 'cancelled', cancelledAt: d('2026-02-01T09:00:00Z') };
    expect(accessOf(cancelled, d('2026-02-02T00:00:00Z')).level).toBe('export_only');   // cancelled in the middle of the trial
    expect(accessOf(cancelled, d('2026-04-02T20:59:59.999Z')).level).toBe('export_only');
    expect(accessOf(cancelled, d('2026-04-02T21:00:00Z')).level).toBe('closed');
  });

  it('a paying customer is never locked, and neither is one with no trial on record', () => {
    const paid: SubState = { ...trial, status: 'active', convertedAt: d('2026-02-20T00:00:00Z') };
    expect(accessOf(paid, d('2030-01-01T00:00:00Z')).level).toBe('full');
    expect(accessOf({ status: 'active', trialEndsAt: null, graceEndsAt: null, convertedAt: null, cancelledAt: null }, d('2030-01-01T00:00:00Z')).level).toBe('full');
    expect(accessOf({ status: 'past_due', trialEndsAt: null, graceEndsAt: null, convertedAt: null, cancelledAt: null }, d('2030-01-01T00:00:00Z')).level).toBe('full');
    expect(accessOf(null, d('2030-01-01T00:00:00Z')).level).toBe('full');
  });

  it('an older customer that paid and later cancelled keeps today\'s behaviour (not locked here)', () => {
    const left: SubState = { status: 'cancelled', trialEndsAt: w.endsAt, graceEndsAt: w.graceEndsAt, convertedAt: d('2026-02-01T00:00:00Z'), cancelledAt: d('2026-06-01T00:00:00Z') };
    expect(accessOf(left, d('2026-07-01T00:00:00Z')).level).toBe('full');
  });

  it('reports the dates the screens and e-mails need', () => {
    const a = accessOf(trial, d('2026-02-10T08:00:00Z'));
    expect(a.trialing).toBe(true);
    expect(a.daysLeft).toBe(5);
    expect(a.trialEndsAt?.toISOString()).toBe('2026-02-14T20:59:59.999Z');
    expect(a.graceEndsAt?.toISOString()).toBe('2026-03-16T20:59:59.999Z');
    const b = accessOf({ ...trial, status: 'cancelled', cancelledAt: d('2026-03-17T05:00:00Z') }, d('2026-03-18T00:00:00Z'));
    expect(b.exportUntil?.toISOString()).toBe('2026-05-16T20:59:59.999Z');
    expect(riyadhDate(b.deleteNotBefore!)).toBe('2026-06-15');
  });
});
