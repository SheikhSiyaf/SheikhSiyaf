// The free-trial lifecycle: starting, the hourly job, the owner's actions, billing, and the lock in the API.
// Trials here start in October 2025 so that no other test's data is touched: the job and the billing run are asked
// about one customer or about days before any other test's subscription falls due.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, sale, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as T from '../src/books/trialService.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { postEntry } from '../src/ledger/ledger.js';

const START = '2025-10-01';   // day 1; the last day is 15 October; the grace period ends on 14 November
const ENDS = '2025-10-15T20:59:59.999Z';
const GRACE = '2025-11-14T20:59:59.999Z';
const d = (s: string) => new Date(s);
let planId: string;

beforeAll(async () => { planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id; });

const startTrial = (f: Fixture, on = START) => as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: on, trial: true }));
const row = async (f: Fixture) => (await owner.query(
  `SELECT status, trial_started_at, trial_ends_at, grace_ends_at, converted_at, cancelled_at, to_char(trial_ends, 'YYYY-MM-DD') AS trial_ends,
          to_char(next_bill_on, 'YYYY-MM-DD') AS next_bill_on FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0];
const events = async (f: Fixture) => (await owner.query(
  `SELECT kind, from_status, to_status, reason, actor_user_id, occurred_at, details FROM subscription_events WHERE firm_id = $1 ORDER BY occurred_at, created_at`, [f.firmId])).rows;
/** The hourly job, nobody signed in, for one customer. */
async function job(f: Fixture, now: string) {
  const c = await appPool.connect();
  try { await c.query('BEGIN'); const r = await T.advance(c, d(now), f.firmId); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
/** The billing run (nobody signed in) on a day before any other test's bills fall due. */
async function billingRun(day: string) {
  const c = await appPool.connect();
  try { await c.query('BEGIN'); const r = await B.run(c, day); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

describe('Starting a trial', () => {
  it('writes the trial dates in Riyadh time and records the start', async () => {
    const f = await seed();
    await startTrial(f);
    const r = await row(f);
    expect(r.status).toBe('trial');
    expect(r.trial_started_at.toISOString()).toBe('2025-09-30T21:00:00.000Z');   // midnight on 1 October in Riyadh
    expect(r.trial_ends_at.toISOString()).toBe(ENDS);
    expect(r.grace_ends_at.toISOString()).toBe(GRACE);
    expect([r.trial_ends, r.next_bill_on]).toEqual(['2025-10-16', '2025-10-16']);
    const ev = await events(f);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'trial_started', to_status: 'trial', actor_user_id: f.platformOwner });
  });

  it('only the owner starts one, and a customer cannot start a second while it has one', async () => {
    const f = await seed();
    await expect(as(f.admin, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: START, trial: true }))).rejects.toThrow(/Only the platform owner/);
    await startTrial(f);
    // a second request changes the plan details (the old behaviour) and does not restart the clock
    await startTrial(f, '2025-10-20');
    expect((await row(f)).trial_ends_at.toISOString()).toBe(ENDS);
    expect(await events(f)).toHaveLength(1);
  });

  it('a trial that is not a free trial (no trial flag) has no trial dates and is never locked', async () => {
    const f = await seed();
    await as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: START }));
    const r = await row(f);
    expect([r.status, r.trial_ends_at, r.grace_ends_at]).toEqual(['active', null, null]);
  });
});

describe('The hourly job', () => {
  it('changes nothing while the trial is open, to the last millisecond', async () => {
    const f = await seed(); await startTrial(f);
    expect(await job(f, '2025-10-15T20:59:59.999Z')).toEqual([]);
    expect((await row(f)).status).toBe('trial');
  });

  it('ends the trial once, then closes it once the grace period is over; running again does nothing', async () => {
    const f = await seed(); await startTrial(f);
    expect(await job(f, '2025-10-15T21:00:00.000Z')).toEqual([{ firmId: f.firmId, from: 'trial', to: 'trial_ended' }]);
    expect(await job(f, '2025-10-16T06:00:00Z')).toEqual([]);                        // again: nothing
    expect(await job(f, '2025-11-14T20:59:59.999Z')).toEqual([]);                   // last moment of the grace period
    expect(await job(f, '2025-11-14T21:00:00.000Z')).toEqual([{ firmId: f.firmId, from: 'trial_ended', to: 'cancelled' }]);
    expect(await job(f, '2025-11-15T06:00:00Z')).toEqual([]);
    const r = await row(f);
    expect(r.status).toBe('cancelled');
    expect(r.cancelled_at.toISOString()).toBe(GRACE);   // the day the grace period ended, not the day the job ran
    const ev = await events(f);
    expect(ev.map((e) => e.kind)).toEqual(['trial_started', 'trial_ended', 'cancelled']);
    expect(ev[1]).toMatchObject({ actor_user_id: null, details: { by: 'system' } });
    expect(ev[2]).toMatchObject({ actor_user_id: null, details: { by: 'system' } });
  });

  it('catches up after missed days: a job that did not run for two months moves the customer all the way, with the right dates', async () => {
    const f = await seed(); await startTrial(f);
    const moved = await job(f, '2026-01-05T06:00:00Z');   // before another test's trial ends, but long after this one's grace period
    expect(moved.map((m) => m.to)).toEqual(['trial_ended', 'cancelled']);
    const r = await row(f);
    expect(r.cancelled_at.toISOString()).toBe(GRACE);
    expect((await events(f)).map((e) => e.kind)).toEqual(['trial_started', 'trial_ended', 'cancelled']);
  });

  it('only the owner or the server runs it', async () => {
    const f = await seed(); await startTrial(f);
    await expect(as(f.admin, (db) => T.advance(db, d('2025-12-01T00:00:00Z'), f.firmId))).rejects.toThrow(/Only the platform owner/);
  });
});

describe('Billing and trials', () => {
  it('the billing run does not invoice a trial or turn it into a paying customer, even long after it ends', async () => {
    const f = await seed(); await startTrial(f);
    const made = (await billingRun('2025-12-01')).filter((x) => x.firmId === f.firmId);   // the trial ended on 15 October
    expect(made).toEqual([]);
    expect((await row(f)).status).toBe('trial');
    await job(f, '2025-10-20T00:00:00Z');
    expect((await billingRun('2025-12-01')).filter((x) => x.firmId === f.firmId)).toEqual([]);
    expect((await row(f)).status).toBe('trial_ended');
  });

  it('buying converts the same customer: the next billing run makes the first invoice (software, membership, extra modules)', async () => {
    const f = await seed(); await startTrial(f);
    await job(f, '2025-10-20T00:00:00Z');
    await as(f.platformOwner, (db) => T.convertTrial(db, f.firmId, 'Bank transfer received, ref 123', d('2025-10-22T07:00:00Z')));
    const r = await row(f);
    expect(r.status).toBe('active');
    expect(r.converted_at.toISOString()).toBe('2025-10-22T07:00:00.000Z');
    expect(r.next_bill_on).toBe('2025-10-22');
    const made = (await billingRun('2025-10-22')).filter((x) => x.firmId === f.firmId);
    expect(made).toHaveLength(1);
    const inv = await as(f.platformOwner, (db) => B.invoice(db, made[0]!.id));
    // The test firm's companies have five optional modules switched on (Inventory, Assets, Projects, HRM, CRM): 5 x 500.
    // By hand: 9,000 + 1,500 + 2,500 = 13,000; VAT 15% = 1,950; total 14,950.
    expect(inv.lines.map((l: { key: string; amount: number }) => [l.key, l.amount])).toEqual([['software', 9000], ['membership', 1500], ['extraModules', 2500]]);
    expect([inv.subtotal, inv.vat, inv.total]).toEqual(['13000.00', '1950.00', '14950.00']);
  });
});

describe('The owner\'s actions', () => {
  it('extending needs a reason and 1 to 90 days, moves the end and the grace period, and reopens a locked customer', async () => {
    const f = await seed(); await startTrial(f);
    await expect(as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, 7, ' ', d('2025-10-10T00:00:00Z')))).rejects.toMatchObject({ key: 'err.trialReason' });
    for (const days of [0, 91, 1.5, NaN]) {
      await expect(as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, days, 'why', d('2025-10-10T00:00:00Z')))).rejects.toMatchObject({ key: 'err.trialDays' });
    }
    await expect(as(f.admin, (db) => T.extendTrial(db, f.firmId, 7, 'why', d('2025-10-10T00:00:00Z')))).rejects.toMatchObject({ key: 'err.ownerOnly' });
    await job(f, '2025-10-20T00:00:00Z');   // ended, locked
    await as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, 14, 'Customer asked, waiting for their bank', d('2025-10-20T00:00:00Z')));
    const r = await row(f);
    expect(r.status).toBe('trial');   // open again: 15 October + 14 days is 29 October
    expect(r.trial_ends_at.toISOString()).toBe('2025-10-29T20:59:59.999Z');
    expect(r.grace_ends_at.toISOString()).toBe('2025-11-28T20:59:59.999Z');
    expect(r.trial_ends).toBe('2025-10-30');
    const ev = await events(f);
    expect(ev.at(-1)).toMatchObject({ kind: 'trial_extended', from_status: 'trial_ended', to_status: 'trial', reason: 'Customer asked, waiting for their bank', actor_user_id: f.platformOwner });
  });

  it('an extension that is still in the past leaves the customer locked', async () => {
    const f = await seed(); await startTrial(f);
    await job(f, '2025-11-01T00:00:00Z');
    await as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, 2, 'Two more days', d('2025-11-01T00:00:00Z')));
    expect((await row(f)).status).toBe('trial_ended');
  });

  it('only a trial can be extended, only a trial can be closed this way, and a paying customer cannot be converted again', async () => {
    const f = await seed(); await startTrial(f);
    await as(f.platformOwner, (db) => T.convertTrial(db, f.firmId, 'Paid', d('2025-10-05T00:00:00Z')));
    await expect(as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, 3, 'x', d('2025-10-06T00:00:00Z')))).rejects.toThrow(/Only a trial can be extended/);
    await expect(as(f.platformOwner, (db) => T.cancelTrial(db, f.firmId, 'x', d('2025-10-06T00:00:00Z')))).rejects.toThrow(/Only a trial can be closed/);
    await expect(as(f.platformOwner, (db) => T.convertTrial(db, f.firmId, 'again', d('2025-10-06T00:00:00Z')))).rejects.toThrow(/already paying/);
  });

  it('closing now needs a reason, records when, and the export window counts from that moment', async () => {
    const f = await seed(); await startTrial(f);
    await expect(as(f.platformOwner, (db) => T.cancelTrial(db, f.firmId, '', d('2025-10-05T10:00:00Z')))).rejects.toMatchObject({ key: 'err.trialReason' });
    await as(f.platformOwner, (db) => T.cancelTrial(db, f.firmId, 'Customer told us they do not need it', d('2025-10-05T10:00:00Z')));
    const r = await row(f);
    expect(r.status).toBe('cancelled');
    expect(r.cancelled_at.toISOString()).toBe('2025-10-05T10:00:00.000Z');
    expect((await events(f)).at(-1)).toMatchObject({ kind: 'cancelled', reason: 'Customer told us they do not need it', actor_user_id: f.platformOwner });
  });

  it('a closed customer that buys before deletion is reactivated with the same data', async () => {
    const f = await seed(); await startTrial(f);
    await as(f.partner, (db) => postEntry(db, sale(f.a, '2025-10-05', '300.00')));
    const count = async () => Number((await owner.query('SELECT count(*) AS n FROM journal_entries WHERE company_id = $1', [f.a.id])).rows[0].n);
    const before = await count();
    await job(f, '2025-12-01T00:00:00Z');   // closed
    expect((await row(f)).status).toBe('cancelled');
    await as(f.platformOwner, (db) => T.convertTrial(db, f.firmId, 'Paid late, ref 77', d('2025-12-05T09:00:00Z')));
    const r = await row(f);
    expect([r.status, r.cancelled_at]).toEqual(['active', null]);
    expect(await count()).toBe(before);   // nothing was changed or deleted by locking, closing or buying
    expect((await events(f)).at(-1)).toMatchObject({ kind: 'reactivated', from_status: 'cancelled', to_status: 'active' });
  });

  it('every change is in the audit log and in the events, and the events can be read only by the owner and never changed', async () => {
    const f = await seed(); await startTrial(f);
    await as(f.platformOwner, (db) => T.extendTrial(db, f.firmId, 3, 'Holiday', d('2025-10-10T00:00:00Z')));
    const id = (await owner.query('SELECT id FROM subscriptions WHERE firm_id = $1', [f.firmId])).rows[0].id;
    const actions = (await owner.query(`SELECT action, user_id FROM audit_log WHERE table_name = 'subscriptions' AND row_id = $1 ORDER BY id`, [id])).rows;
    expect(actions.map((a) => a.action)).toEqual(['insert', 'update']);
    expect(actions[1].user_id).toBe(f.platformOwner);
    expect(await as(f.admin, (db) => db.query('SELECT 1 FROM subscription_events WHERE firm_id = $1', [f.firmId]).then((r) => r.rowCount))).toBe(0);
    expect(await as(f.platformOwner, (db) => db.query('SELECT 1 FROM subscription_events WHERE firm_id = $1', [f.firmId]).then((r) => r.rowCount))).toBe(2);
    await expect(owner.query('UPDATE subscription_events SET reason = $1 WHERE firm_id = $2', ['changed', f.firmId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(owner.query('DELETE FROM subscription_events WHERE firm_id = $1', [f.firmId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(as(f.admin, (db) => db.query(`INSERT INTO subscription_events (firm_id, kind, to_status, occurred_at) VALUES ($1, 'converted', 'active', now())`, [f.firmId]))).rejects.toThrow();
  });
});

describe('The lock in the API', () => {
  let server: FastifyInstance;
  let clock = d('2025-10-05T07:00:00Z');
  let f: Fixture; let other: Fixture;
  const cookies: Record<string, string> = {};
  const emails: Record<string, string> = {};

  async function signIn(who: string) {
    return server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  }
  const as$ = (who: string) => ({ cookie: cookies[who]! });
  const get = (who: string, url: string) => server.inject({ method: 'GET', url, headers: as$(who) });
  const post = (who: string, url: string, payload: object = {}) => server.inject({ method: 'POST', url, headers: as$(who), payload });

  beforeAll(async () => {
    f = await seed(); other = await seed();
    await startTrial(f);
    const hash = await hashPassword('pw-123456');
    const people = { owner: f.platformOwner, admin: f.admin, partner: f.partner, client: f.a.clientAccountant, otherPartner: other.partner };
    for (const [k, id] of Object.entries(people)) emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'trial-secret', now: () => clock, lockCacheMs: 0 });
    for (const k of Object.keys(people)) {
      const res = await signIn(k);
      expect(res.statusCode, `${k}: ${res.body}`).toBe(200);
      cookies[k] = String(res.headers['set-cookie']).split(';')[0]!;
    }
  });
  afterAll(async () => { await server.close(); });

  const summary = (who: string) => get(who, `/api/companies/${f.a.id}/summary`);
  const tryPost = (who: string) => post(who, `/api/companies/${f.a.id}/entries`, { date: '2025-10-05', memo: 'x', lines: [] });

  it('during the trial everything works, and the app header can read the days left', async () => {
    clock = d('2025-10-05T07:00:00Z');   // day 5
    expect((await summary('partner')).statusCode).toBe(200);
    const t = (await get('client', '/api/trial')).json();
    expect(t).toMatchObject({ level: 'full', trialing: true, daysLeft: 11, trialEndsAt: ENDS, graceEndsAt: GRACE });
  });

  it('the trial clock is a test-only option: no request can change it', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/trial?now=2030-01-01T00:00:00Z', headers: { ...as$('partner'), 'x-now': '2030-01-01T00:00:00Z' } });
    expect(res.json().daysLeft).toBe(11);
  });

  it('day 16 is a soft last day: everything works, and the trial screen says so', async () => {
    clock = d('2025-10-15T21:00:00.000Z');
    expect((await summary('partner')).statusCode).toBe(200);
    expect((await get('client', '/api/trial')).json()).toMatchObject({ level: 'full', trialing: true, softDay: true, daysLeft: 0 });
  });

  it('the moment the soft day ends the customer is locked, even though the job has not run (the status column still says trial)', async () => {
    clock = d('2025-10-16T21:00:00.000Z');
    expect((await row(f)).status).toBe('trial');
    for (const who of ['partner', 'client', 'admin']) {
      const r = await (who === 'admin' ? get(who, '/api/admin/billing') : summary(who));
      if (who === 'admin') expect(r.statusCode).toBe(200);   // its own billing stays open
      else expect(r.json()).toMatchObject({ key: 'err.trialEnded' });
    }
    const post1 = await tryPost('partner');
    expect(post1.statusCode).toBe(403);
    expect(post1.json()).toMatchObject({ key: 'err.trialEnded' });
    expect((await get('partner', `/api/companies/${f.a.id}/entries`)).json()).toMatchObject({ key: 'err.trialEnded' });
    expect((await get('partner', `/api/companies/${f.a.id}/reports/trial-balance`)).json()).toMatchObject({ key: 'err.trialEnded' });
    expect((await post('partner', `/api/companies/${f.a.id}/contacts`, { name: 'X' })).json()).toMatchObject({ key: 'err.trialEnded' });
  });

  it('a locked customer can still read who they are, see the trial screen, contact support, see their billing and export their data', async () => {
    expect((await get('partner', '/api/me')).statusCode).toBe(200);
    expect((await get('partner', '/api/trial')).json()).toMatchObject({ level: 'locked', trialing: false, daysLeft: null });
    expect((await get('client', '/api/support/threads')).statusCode).not.toBe(403);
    const ex = await get('partner', `/api/companies/${f.a.id}/export`);
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-type']).toBe('application/zip');
    // signing out stays possible (it ends that person's sessions, so it is tried last and with another person)
    expect((await server.inject({ method: 'POST', url: '/api/logout', headers: as$('client') })).statusCode).toBeLessThan(400);
  });

  it('the trial screen gets what it shows: the optional modules switched on, the prices as set in Payment settings, and how to reach us', async () => {
    const on = (await owner.query(`SELECT array_agg(DISTINCT m ORDER BY m) AS a FROM companies c, unnest(c.modules) m WHERE c.firm_id = $1 AND m IN ('Inventory','Restaurant','Rooms','Assets','Rentals','Projects','HRM','CRM')`, [f.firmId])).rows[0].a as string[];
    const t = (await get('partner', '/api/trial')).json();
    expect([...t.modules].sort()).toEqual(on);
    expect(t.prices.currency).toBe('SAR');
    expect(t.prices.lines.map((l: { key: string }) => l.key)).toEqual(['implementation', 'cleanup', 'annualCore', 'perModule']);
    expect(t.support).toMatchObject({ email: 'hello@nusuhbooks.com', phone: '+966 546958273' });
    expect(t.buyUrl).toBe('https://nusuhbooks.com/order/');
    expect(Array.isArray(t.testimonials) && t.testimonials.length <= 3).toBe(true);   // the owner's real quotes only, at most three
    // a customer with no trial gets only the plain summary, and a customer cannot see another's modules
    const other$ = (await get('otherPartner', '/api/trial')).json();
    expect(other$).toMatchObject({ level: 'full', trialing: false });
    expect(other$.modules).toBeUndefined();
  });

  it('it also follows a correct route even when the address is written in capitals or encoded', async () => {
    const r = await get('partner', `/api/companies/${f.a.id.toUpperCase()}/summary`);
    expect(r.json()).toMatchObject({ key: 'err.trialEnded' });
    expect((await get('partner', `/api/%63ompanies/${f.a.id}/summary`)).json()).toMatchObject({ key: 'err.trialEnded' });
  });

  it('nobody else is affected: another customer and the platform owner work as always', async () => {
    expect((await get('otherPartner', `/api/companies/${other.a.id}/summary`)).statusCode).toBe(200);
    expect((await get('owner', '/api/owner/billing')).statusCode).toBe(200);
    expect((await get('owner', '/api/trial')).json()).toMatchObject({ level: 'full' });
  });

  it('after the grace period only the export is left; after the export window nobody signs in', async () => {
    clock = d('2025-11-14T21:00:00.000Z');
    expect((await summary('partner')).json()).toMatchObject({ key: 'err.accountClosed' });
    expect((await get('admin', '/api/admin/billing')).json()).toMatchObject({ key: 'err.accountClosed' });
    expect((await get('partner', '/api/trial')).json()).toMatchObject({ level: 'export_only' });
    expect((await get('partner', `/api/companies/${f.a.id}/export`)).statusCode).toBe(200);
    expect((await signIn('client')).statusCode).toBe(200);   // may sign in, to export
    // closed on 14 November: the export window ends at the end of 13 January 2026
    clock = d('2026-01-13T20:59:59.999Z');
    expect((await get('partner', `/api/companies/${f.a.id}/export`)).statusCode).toBe(200);
    clock = d('2026-01-13T21:00:00.000Z');
    expect((await get('partner', `/api/companies/${f.a.id}/export`)).json()).toMatchObject({ key: 'err.accountClosed' });
    expect((await get('partner', '/api/me')).json()).toMatchObject({ key: 'err.accountClosed' });
    const login = await signIn('partner');
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ key: 'err.accountClosed' });
    expect((await signIn('owner')).statusCode).toBe(200);
  });

  it('the owner converts it: the very next request works again, with the same data', async () => {
    clock = d('2025-12-20T08:00:00Z');
    expect((await summary('partner')).statusCode).toBe(403);
    const res = await post('owner', `/api/owner/tenants/${f.firmId}/trial/convert`, { reason: 'Transfer received' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await summary('partner')).statusCode).toBe(200);
    expect((await get('partner', '/api/trial')).json()).toMatchObject({ level: 'full', trialing: false });
    expect((await row(f)).status).toBe('active');
  });

  it('the owner\'s actions over the API need a reason and the owner', async () => {
    const g = await seed(); await startTrial(g);
    expect((await post('owner', `/api/owner/tenants/${g.firmId}/trial/extend`, { days: 5 })).json()).toMatchObject({ key: 'err.trialReason' });
    expect((await post('owner', `/api/owner/tenants/${g.firmId}/trial/extend`, { days: 5, reason: 'Public holiday' })).statusCode).toBe(200);
    expect((await post('admin', `/api/owner/tenants/${g.firmId}/trial/extend`, { days: 5, reason: 'x' })).statusCode).toBe(403);
    expect((await post('owner', `/api/owner/tenants/not-an-id/trial/cancel`, { reason: 'x' })).statusCode).toBe(404);
    const run = await post('owner', '/api/owner/trials/advance');
    expect(run.statusCode).toBe(200);
    expect((await post('admin', '/api/owner/trials/advance')).statusCode).toBe(403);
  });
});
