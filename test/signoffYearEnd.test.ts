// Sign-offs, partner locks and year-end closing together (db/migrations/0048):
// - a year closes and reopens when its last month is signed off (the closing entry and its reversal are the only
//   postings allowed in a signed-off month, and only by the partner closing or reopening that year);
// - withdrawing a sign-off unlocks only what the sign-off locked, never a month the partner had locked.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, sale, addPeriod, type Fixture } from './helpers.js';
import { postEntry, setPeriodLock } from '../src/ledger/ledger.js';
import * as R from '../src/books/reviewService.js';
import * as Y from '../src/books/yearEndService.js';

let f: Fixture;
const lockedAt = async (start: string) =>
  (await owner.query('SELECT locked_at FROM periods WHERE company_id = $1 AND start_date = $2', [f.a.id, start])).rows[0]?.locked_at ?? null;
const signOff = (periodEnd: string) =>
  as(f.reviewer, async (db) => (await db.query('INSERT INTO review_signoffs (company_id, period_end, signed_by) VALUES ($1, $2, app_user_id()) RETURNING id', [f.a.id, periodEnd])).rows[0].id as string);

beforeAll(async () => {
  f = await seed();
  for (let m = 1; m <= 12; m++) {
    const s = `2023-${String(m).padStart(2, '0')}-01`;
    await addPeriod(f.a.id, s, new Date(Date.UTC(2023, m, 0)).toISOString().slice(0, 10));
  }
  for (const m of ['03', '04', '05']) await addPeriod(f.a.id, `2026-${m}-01`, new Date(Date.UTC(2026, Number(m), 0)).toISOString().slice(0, 10));
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2023-06-10', '800.00')));
});

describe('A year whose last month is signed off', () => {
  it('closes: the closing entry is posted on the year end and every month is locked', async () => {
    await signOff('2023-12-31');
    const r = await as(f.partner, (db) => Y.close(db, f.a.id, '2023-12-31'));
    expect(r.entryId).not.toBeNull();
    const e = (await owner.query('SELECT entry_date::text AS d, source_type FROM journal_entries WHERE id = $1', [r.entryId])).rows[0];
    expect(e).toEqual({ d: '2023-12-31', source_type: 'year_end_close' });
    for (const m of ['01', '06', '12']) expect(await lockedAt(`2023-${m}-01`)).not.toBeNull();
  });

  it('still refuses every other posting in the signed-off month, also one dressed up as a closing entry', async () => {
    await expect(as(f.partner, (db) => postEntry(db, sale(f.a, '2023-12-20', '5.00')))).rejects.toThrow(/locked|closed/);
    await expect(as(f.partner, (db) => postEntry(db, { ...sale(f.a, '2023-12-31', '5.00'), sourceType: 'year_end_close', sourceId: f.a.id } as never))).rejects.toThrow(/locked|closed/);
  });

  it('reopens: the closing entry is reversed on the year end; the month stays locked and signed off', async () => {
    const y = (await owner.query(`SELECT id FROM fiscal_years WHERE company_id = $1 AND end_date = '2023-12-31' AND status = 'closed'`, [f.a.id])).rows[0].id;
    await as(f.partner, (db) => Y.reopen(db, y, 'Audit adjustment'));
    const fy = (await owner.query('SELECT status, reopen_entry_id FROM fiscal_years WHERE id = $1', [y])).rows[0];
    expect(fy.status).toBe('reopened');
    expect(fy.reopen_entry_id).not.toBeNull();
    expect((await owner.query('SELECT entry_date::text AS d FROM journal_entries WHERE id = $1', [fy.reopen_entry_id])).rows[0].d).toBe('2023-12-31');
    expect(await lockedAt('2023-12-01')).not.toBeNull();
    expect((await owner.query(`SELECT count(*)::int AS n FROM review_signoffs WHERE company_id = $1 AND period_end = '2023-12-31' AND withdrawn_at IS NULL`, [f.a.id])).rows[0].n).toBe(1);
  });

  it('closes again after reopening', async () => {
    const r = await as(f.partner, (db) => Y.close(db, f.a.id, '2023-12-31'));
    expect(r.entryId).not.toBeNull();
  });
});

describe('Withdrawing a sign-off', () => {
  it('keeps a month the partner locked before the sign-off locked', async () => {
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-03-01', true));
    const id = await signOff('2026-03-31');
    await as(f.reviewer, (db) => R.withdraw(db, id, 'Wrong month'));
    expect(await lockedAt('2026-03-01')).not.toBeNull();
  });

  it('unlocks a month only the sign-off locked, and other months keep their own locks', async () => {
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-05-01', true));
    const id = await signOff('2026-04-30');
    expect(await lockedAt('2026-04-01')).not.toBeNull();
    await as(f.reviewer, (db) => R.withdraw(db, id, 'Missing bill'));
    expect(await lockedAt('2026-04-01')).toBeNull();
    expect(await lockedAt('2026-03-01')).not.toBeNull();
    expect(await lockedAt('2026-05-01')).not.toBeNull();
  });

  it('nobody marks a lock as a sign-off lock by hand', async () => {
    await expect(as(f.partner, (db) => db.query(`UPDATE periods SET signoff_lock = true WHERE company_id = $1 AND start_date = '2026-03-01'`, [f.a.id]))).rejects.toThrow();
  });
});
