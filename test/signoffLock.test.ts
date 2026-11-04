// A signed-off month is locked (db/migrations/0039): signing off locks the month in the same transaction, nobody can
// unlock it while the sign-off stands, and withdrawing the sign-off (with a reason) reopens it unless year-end
// closing keeps it locked. Postings, reversals and imported entries dated in it are refused.
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, sale, addPeriod, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, setPeriodLock } from '../src/ledger/ledger.js';
import * as R from '../src/books/reviewService.js';
import * as Y from '../src/books/yearEndService.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
const lockedAt = async (companyId: string, start: string) =>
  (await owner.query('SELECT locked_at FROM periods WHERE company_id = $1 AND start_date = $2', [companyId, start])).rows[0]?.locked_at ?? null;
/** Signs a month off straight in the database, as the person (the checklist is the service's job, not tested here). */
const signOff = (userId: string, companyId: string, periodEnd: string) =>
  as(userId, async (db) => (await db.query('INSERT INTO review_signoffs (company_id, period_end, signed_by) VALUES ($1, $2, app_user_id()) RETURNING id', [companyId, periodEnd])).rows[0].id as string);

beforeAll(async () => {
  f = await seed();
  for (let m = 1; m <= 12; m++) {
    const s = `2024-${String(m).padStart(2, '0')}-01`;
    await addPeriod(f.a.id, s, new Date(Date.UTC(2024, m, 0)).toISOString().slice(0, 10));
  }
  await addPeriod(f.a.id, '2026-02-01', '2026-02-28');
  await addPeriod(f.b.id, '2026-02-01', '2026-02-28');
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2024-05-10', '1000.00')));
});

describe('Signing off a month', () => {
  it('locks it in the same step, also when the reviewer cannot lock periods', async () => {
    // A reviewer cannot lock a period directly...
    await as(f.reviewer, (db) => db.query(`UPDATE periods SET locked_at = now() WHERE company_id = $1 AND start_date = '2026-02-01'`, [f.a.id]));
    expect(await lockedAt(f.a.id, '2026-02-01')).toBeNull();
    // ...but signing off locks it.
    await signOff(f.reviewer, f.a.id, '2026-02-28');
    expect(await lockedAt(f.a.id, '2026-02-01')).not.toBeNull();
  });

  it('creates the month locked when it has no period yet', async () => {
    expect(await lockedAt(f.a.id, '2026-01-01')).toBeNull();
    await signOff(f.reviewer, f.a.id, '2026-01-31');
    const p = (await owner.query(`SELECT end_date::text AS e, locked_at FROM periods WHERE company_id = $1 AND start_date = '2026-01-01'`, [f.a.id])).rows[0];
    expect(p.e).toBe('2026-01-31');
    expect(p.locked_at).not.toBeNull();
  });

  it('refuses postings in it for the partner, the staff accountant and the client accountant', async () => {
    for (const who of [f.partner, f.staff, f.a.clientAccountant]) {
      await expect(as(who, (db) => postEntry(db, sale(f.a, '2026-02-15', '10.00')))).rejects.toThrow(/This period is locked/);
      await expect(as(who, (db) => postEntry(db, sale(f.a, '2026-01-15', '10.00')))).rejects.toThrow(/This period is locked/);
    }
  });

  it('refuses a reversal dated in it', async () => {
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-05', '10.00')));
    await expect(as(f.staff, (db) => reverseEntry(db, id, '2026-02-20'))).rejects.toThrow(/This period is locked/);
  });

  it('cannot be unlocked, not even by the partner, while the sign-off stands', async () => {
    await expect(as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-02-01', false))).rejects.toThrow(/signed off/);
    await expect(owner.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND start_date = '2026-02-01'`, [f.a.id])).rejects.toThrow(/signed off/);
    expect(await lockedAt(f.a.id, '2026-02-01')).not.toBeNull();
  });

  it("leaves another company's months alone", async () => {
    expect(await lockedAt(f.b.id, '2026-02-01')).toBeNull();
    await as(f.partner, (db) => postEntry(db, sale(f.b, '2026-02-15', '10.00')));
  });

  it('answers the API with the usual locked-period message and translation key', async () => {
    const server: FastifyInstance = buildServer({ pool: appPool, sessionSecret: 'signoff-lock-secret' });
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword('pw-123456'), f.partner])).rows[0].email;
    const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-123456' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const r = await server.inject({ method: 'POST', url: `/api/companies/${f.a.id}/entries`, headers: { cookie }, payload: sale(f.a, '2026-02-16', '10.00') });
    expect(r.statusCode).toBe(400);
    expect(r.json().key).toBe('err.periodLocked');
    await server.close();
  });
});

describe('Withdrawing the sign-off', () => {
  it('reopens the month, so it can be corrected', async () => {
    const id = (await owner.query(`SELECT id FROM review_signoffs WHERE company_id = $1 AND period_end = '2026-02-28' AND withdrawn_at IS NULL`, [f.a.id])).rows[0].id;
    await as(f.reviewer, (db) => R.withdraw(db, id, 'Late supplier bill to add'));
    expect(await lockedAt(f.a.id, '2026-02-01')).toBeNull();
    await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-02-15', '10.00')));
    // January is still signed off and still locked.
    expect(await lockedAt(f.a.id, '2026-01-01')).not.toBeNull();
  });

  it('does not reopen a month that year-end closing keeps locked', async () => {
    await as(f.partner, (db) => Y.close(db, f.a.id, '2024-12-31'));
    const id = await signOff(f.reviewer, f.a.id, '2024-05-31');
    await as(f.reviewer, (db) => R.withdraw(db, id, 'Wrong month'));
    expect(await lockedAt(f.a.id, '2024-05-01')).not.toBeNull();
  });
});
