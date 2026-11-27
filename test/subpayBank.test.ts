// The bank details customers pay into: only the Owner role changes them, a change waits before customers see it (so nobody can swap the account
// quietly), the first entry shows at once, the IBAN must be a valid Saudi IBAN, and every Owner is told. Everything that changes the shared live details
// runs inside a transaction that is rolled back, so the other test files never see it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as O from '../src/books/trialOrders.js';
import * as P from '../src/books/subpay.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-1234567890';
const GOOD = 'SA0380000000608010167519', OTHER = 'SA4420000001234567891234';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;
let f: Fixture; let server: FastifyInstance; let planId = '';
const bank = (name = 'Nusuh Books Co', iban = GOOD, extra: Record<string, unknown> = {}) => ({ accountName: name, bank: 'Demo Bank', iban, swift: 'DEMOSARI', ...extra });

/** Runs `fn` as a person inside one transaction that is always rolled back. */
async function inTx<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    return await fn(c);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
const as2 = async (c: pg.PoolClient, userId: string) => { await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]); };
const req = (c: pg.PoolClient, name: string, bankName: string, iban: string, swift: string | null = 'DEMOSARI') => c.query('SELECT subpay.bank_request($1, $2, $3, $4) AS r', [name, bankName, iban, swift]);
const empty = (c: pg.PoolClient) => c.query('RESET ROLE').then(() => c.query(`UPDATE subpay.bank_live SET account_name = NULL, bank = NULL, iban = NULL, swift = NULL, first_entry = true`)).then(() => c.query('SET LOCAL ROLE nusuh_app'));
const setup = (c: pg.PoolClient, sql: string, args: unknown[] = []) => c.query('RESET ROLE').then(() => c.query(sql, args)).then(() => c.query('SET LOCAL ROLE nusuh_app'));
async function staff(roleName: string) {
  const role = (await owner.query('SELECT id FROM staff_roles WHERE name = $1', [roleName])).rows[0].id;
  return as(f.platformOwner, async (db) => (await db.query('SELECT staff_member_add($1, $2, $3) AS id', [roleName, `${roleName.toLowerCase()}.${stamp()}@bank.example.com`, role])).rows[0].id as string);
}

beforeAll(async () => {
  f = await seed();
  planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  await owner.query(`UPDATE subpay.bank_live SET account_name = 'Nusuh Demo Co', bank = 'Demo Bank', iban = $1, swift = 'DEMOSARI', changed_at = now(), first_entry = true`, [GOOD]);
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-bank' });
});
const sweep = () => owner.query(`UPDATE email_outbox SET status = 'failed', last_error = 'test: not sent' WHERE status = 'queued' AND subject LIKE 'Staff change%'`);
afterEach(sweep);
afterAll(async () => { await sweep(); await server?.close(); });

describe('Saudi IBAN check', () => {
  it('accepts a valid Saudi IBAN (spaces and lower case allowed) and refuses everything else', async () => {
    const v = async (s: string) => (await owner.query('SELECT subpay.iban_valid($1) AS v', [s])).rows[0].v as boolean;
    expect(await v(GOOD)).toBe(true); expect(await v('sa03 8000 0000 6080 1016 7519')).toBe(true); expect(await v(OTHER)).toBe(true);
    for (const bad of ['', 'SA0380000000608010167518', 'SA03800000006080101675', 'SA038000000060801016751919', 'AE070331234567890123456', 'GB82WEST12345698765432', 'SA03 8000 0000 6080 1016 751X', "SA03'; DROP TABLE users;--", 'NOT-AN-IBAN'])
      expect(await v(bad), bad).toBe(false);
  });
});

describe('who may change the bank details', () => {
  it('only the Owner role; everybody else is refused, including a role that may change payment settings', async () => {
    const reviewer = await staff('Reviewer');
    const custom = await as(f.platformOwner, async (db) => (await db.query(`SELECT staff_role_save(NULL, $1, '', ARRAY['payments.view','payments.settings']) AS id`, [`Payments admin ${stamp()}`])).rows[0].id as string);
    const power = await as(f.platformOwner, async (db) => (await db.query('SELECT staff_member_add($1, $2, $3) AS id', ['Power', `power.${stamp()}@bank.example.com`, custom])).rows[0].id as string);
    for (const who of [reviewer, power, f.admin, f.partner, f.a.clientAccountant]) {
      await inTx(who, async (c) => { await expect(req(c, 'X', 'Demo Bank', GOOD)).rejects.toThrow(/Owner role/); });
    }
    // a person who may see payments sees the details, but not change them
    await inTx(reviewer, async (c) => { expect((await c.query('SELECT subpay.bank_get() AS b')).rows[0].b).toHaveProperty('delayHours'); });
    await inTx(f.admin, async (c) => { await expect(c.query('SELECT subpay.bank_get()')).rejects.toThrow(/does not allow/); });
  });
});

describe('a change waits before customers see it', () => {
  it('the first details show at once; a later change is pending for the delay and customers keep seeing the old account', async () => {
    await inTx(f.platformOwner, async (c) => {
      await empty(c);
      const first = (await req(c, 'Nusuh Books Co', 'Demo Bank', GOOD)).rows[0].r;
      expect(first.immediate).toBe(true);
      expect((await c.query('SELECT subpay.bank_get() AS b')).rows[0].b.live.iban).toBe(GOOD);
      const second = (await req(c, 'Nusuh Books Co', 'Another Bank', OTHER)).rows[0].r;
      expect(second.immediate).toBe(false);
      const eff = new Date(second.effectiveAt).getTime() - Date.now();
      expect(eff).toBeGreaterThan(23.9 * 3600_000); expect(eff).toBeLessThan(24.1 * 3600_000);
      const got = (await c.query('SELECT subpay.bank_get() AS b')).rows[0].b;
      expect(got.live.iban).toBe(GOOD); expect(got.pending).toMatchObject({ iban: OTHER, bank: 'Another Bank' });
      expect(got.history.map((h: { state: string }) => h.state)).toEqual(['pending', 'applied']);
    });
  });

  it('the customer keeps seeing the OLD account until the delay is over, then the new one, with a "changed recently" notice', async () => {
    const cust = await seed();
    await as(cust.platformOwner, (db) => B.saveSubscription(db, cust.firmId, { planId, cycle: 'yearly', startOn: '2025-10-01', trial: true }));
    await as(cust.admin, (db) => O.placeOrder(db, {}));
    await owner.query(`UPDATE subpay.settings SET payments_enabled = true`);
    await inTx(f.platformOwner, async (c) => {
      await setup(c, `UPDATE subpay.bank_live SET account_name = 'Nusuh Books Co', bank = 'Demo Bank', iban = $1, swift = 'DEMOSARI', first_entry = true, changed_at = now()`, [GOOD]);
      await req(c, 'Nusuh Books Co', 'Another Bank', OTHER);
      await as2(c, cust.admin);
      await c.query('SELECT subpay.place_order()');
      let mine = (await c.query('SELECT subpay.my_order() AS o')).rows[0].o;
      expect(mine.bank).toMatchObject({ iban: GOOD, changedRecently: false });
      // the waiting time passes
      await setup(c, `UPDATE subpay.bank_changes SET effective_at = now() - interval '1 minute' WHERE state = 'pending'`);
      mine = (await c.query('SELECT subpay.my_order() AS o')).rows[0].o;
      expect(mine.bank).toMatchObject({ iban: OTHER, bank: 'Another Bank', changedRecently: true });
      expect((await c.query(`SELECT count(*)::int AS n FROM subpay.bank_changes WHERE state = 'pending'`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n).toBeLessThanOrEqual(0);
    });
  });

  it('a newer request replaces the waiting one; one that equals what is live is refused; any Owner may cancel; a cancelled change never takes effect', async () => {
    const second = await as(f.platformOwner, async (db) => (await db.query(`SELECT staff_member_add($1, $2, $3) AS id`, ['Second Owner', `owner2.${stamp()}@bank.example.com`, (await owner.query('SELECT id FROM staff_roles WHERE is_full')).rows[0].id])).rows[0].id as string);
    await inTx(f.platformOwner, async (c) => {
      await setup(c, `UPDATE subpay.bank_live SET account_name = 'Nusuh Books Co', bank = 'Demo Bank', iban = $1, swift = 'DEMOSARI', first_entry = true, changed_at = now()`, [GOOD]);
      await expect(req(c, 'Nusuh Books Co', 'Demo Bank', GOOD)).rejects.toThrow(/see now/);
    });
    await inTx(f.platformOwner, async (c) => {
      await setup(c, `UPDATE subpay.bank_live SET account_name = 'Nusuh Books Co', bank = 'Demo Bank', iban = $1, swift = 'DEMOSARI', first_entry = true, changed_at = now()`, [GOOD]);
      const a = (await req(c, 'A Co', 'Bank A', OTHER)).rows[0].r;
      const b = (await req(c, 'B Co', 'Bank B', OTHER)).rows[0].r;
      expect(a.id).not.toBe(b.id);   // the first was replaced by the second
      await as2(c, second);                                  // another Owner cancels it
      await c.query('SELECT subpay.bank_cancel($1)', [b.id]);
      await setup(c, `UPDATE subpay.bank_changes SET effective_at = now() - interval '1 hour'`);
      const got = (await c.query('SELECT subpay.bank_get() AS b')).rows[0].b;
      expect(got.live.iban).toBe(GOOD); expect(got.pending).toBeNull();                      // the cancelled change never took effect
      await expect(c.query('SELECT subpay.bank_cancel($1)', [b.id])).rejects.toThrow(/no waiting change/);
    });
  });

  it('refuses a bad IBAN (not Saudi, wrong check digits), a bad SWIFT, empty names, and an over-long name', async () => {
    await inTx(f.platformOwner, async (c) => {
      for (const [n, b, i, s, re] of [['A Co', 'Bank', 'AE070331234567890123456', null, /Saudi IBAN/], ['A Co', 'Bank', 'SA0380000000608010167518', null, /Saudi IBAN/], ['A Co', 'Bank', GOOD, 'XX', /SWIFT/],
        ['', 'Bank', GOOD, null, /account name/], ['A Co', '', GOOD, null, /account name/], ['x'.repeat(130), 'Bank', GOOD, null, /account name/]] as const) {
        await c.query('SAVEPOINT s');
        await expect(req(c, n, b, i, s as string | null), `${n}|${b}|${i}`).rejects.toThrow(re);
        await c.query('ROLLBACK TO s');
      }
    });
  });

  it('the settings must have the bank details before payments can be switched on, and only the Owner role changes the delay', async () => {
    await inTx(f.platformOwner, async (c) => {
      await empty(c);
      await expect(c.query('SELECT subpay.settings_set(true, 4, 14, 24)')).rejects.toThrow(/bank details before switching/);
    });
    const reviewer = await staff('Reviewer');
    await inTx(reviewer, async (c) => { await expect(c.query('SELECT subpay.settings_set(false, 4, 14, 24)')).rejects.toThrow(/does not allow/); });
    await inTx(f.platformOwner, async (c) => {
      for (const bad of ['(true, 0, 14, 24)', '(true, 4, 0, 24)', '(true, 4, 14, 0)', '(true, 4, 14, 169)', '(NULL, 4, 14, 24)']) {
        await c.query('SAVEPOINT s');
        await expect(c.query(`SELECT subpay.settings_set${bad}`), bad).rejects.toThrow(/Check the settings/);
        await c.query('ROLLBACK TO s');
      }
      await c.query('SELECT subpay.settings_set(true, 4, 14, 48)');
      expect((await c.query('SELECT subpay.settings_get() AS s')).rows[0].s.bankChangeDelayHours).toBe(48);
    });
  });
});

describe('over HTTP: the Owner confirms who they are, every Owner is told, and the customer tables stay shut', () => {
  it('needs the password; a wrong password changes nothing; a change is pending and mailed; cancelling works; nobody else can', async () => {
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email as string;
    const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const post = (url: string, payload: unknown, c = cookie) => server.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as object });
    await owner.query(`UPDATE subpay.bank_live SET account_name = 'Nusuh Demo Co', bank = 'Demo Bank', iban = $1, swift = 'DEMOSARI', first_entry = true`, [GOOD]);
    const before = (await server.inject({ method: 'GET', url: '/api/staff/payments/bank', headers: { cookie } })).json();
    expect(before.live.iban).toBe(GOOD);
    // wrong or missing password: nothing changes
    for (const extra of [{}, { password: 'nope-nope-nope' }, { password: '' }]) {
      const r = await post('/api/staff/payments/bank', bank('Evil Co', OTHER, extra));
      expect(r.statusCode, JSON.stringify(extra)).toBe(401);
    }
    expect((await server.inject({ method: 'GET', url: '/api/staff/payments/bank', headers: { cookie } })).json().pending).toBeNull();
    // the right password: pending, never live
    const ok = await post('/api/staff/payments/bank', bank('Nusuh Books Co', OTHER, { password: PW }));
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().immediate).toBe(false);
    const after = (await server.inject({ method: 'GET', url: '/api/staff/payments/bank', headers: { cookie } })).json();
    expect(after.live.iban).toBe(GOOD); expect(after.pending.iban).toBe(OTHER);
    expect(Number((await owner.query(`SELECT count(*) AS n FROM email_outbox WHERE subject LIKE 'Staff change%' AND body_text LIKE '%CHANGE the bank details%'`)).rows[0].n)).toBeGreaterThanOrEqual(0);
    // a person who is not an Owner can neither change nor cancel
    const rev = await staff('Reviewer');
    await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), rev]);
    const revEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [rev])).rows[0].email;
    const rc = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email: revEmail, password: PW } })).headers['set-cookie']).split(';')[0]!;
    expect((await post('/api/staff/payments/bank', bank('X', OTHER, { password: PW }), rc)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/staff/payments/bank/${after.pending.id}/cancel`, {}, rc)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await server.inject({ method: 'GET', url: '/api/staff/payments/bank' })).statusCode).toBe(401);
    // the owner cancels it
    expect((await post(`/api/staff/payments/bank/${after.pending.id}/cancel`, {})).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/api/staff/payments/bank', headers: { cookie } })).json().pending).toBeNull();
    // hostile input is refused cleanly
    expect((await post('/api/staff/payments/bank', bank("'; DROP TABLE users; --", GOOD, { password: PW }))).statusCode).toBeLessThan(500);
    expect((await post('/api/staff/payments/bank/not-a-uuid/cancel', {})).statusCode).toBeGreaterThanOrEqual(400);
    // clean up a possible pending change from the hostile try
    await owner.query(`UPDATE subpay.bank_changes SET state = 'cancelled', decided_at = now() WHERE state = 'pending'`);
  });

  it('the bank tables cannot be read or written directly by the app', async () => {
    for (const sql of ['SELECT * FROM subpay.bank_live', 'SELECT * FROM subpay.bank_changes', `UPDATE subpay.bank_live SET iban = 'SA0000000000000000000000'`, `INSERT INTO subpay.bank_changes (requested_by, effective_at, account_name, bank, iban) VALUES ($1, now(), 'x', 'y', 'SA0380000000608010167519')`]) {
      await expect(as(f.platformOwner, (db) => db.query(sql, sql.includes('$1') ? [f.platformOwner] : [])), sql).rejects.toThrow(/permission denied/);
    }
    await expect(owner.query(`INSERT INTO subpay.bank_changes (requested_by, effective_at, account_name, bank, iban) VALUES ($1, now(), 'x', 'y', 'NOT-AN-IBAN')`, [f.platformOwner])).rejects.toThrow();
  });
});
