// The payment routes (src/api/subpay.ts): who may call what, the slip download, and the whole journey over HTTP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as O from '../src/books/trialOrders.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-1234567890';
let server: FastifyInstance; let planId = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const PDF = Buffer.from('%PDF-1.4 slip').toString('base64');
const call = (c: string | undefined, method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, headers: c ? { cookie: c } : {}, payload: payload as object });
async function login(userId: string) {
  const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), userId])).rows[0].email as string;
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
}

beforeAll(async () => {
  planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  await owner.query('UPDATE subpay.settings SET payments_enabled = true');
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-subpay' });
});
afterAll(async () => {
  await server?.close();
});

describe('payment routes', () => {
  it('the whole journey over HTTP: order, "I paid", review, approval; and who may do what', async () => {
    const f: Fixture = await seed();
    await as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: new Date().toISOString().slice(0, 10), trial: true }));
    await as(f.admin, (db) => O.placeOrder(db, { modules: ['CRM'] }));
    const customer = await login(f.admin), ownerCookie = await login(f.platformOwner);
    const role = (await owner.query(`SELECT id FROM staff_roles WHERE name = 'Reviewer'`)).rows[0].id;
    const reviewerId = await as(f.platformOwner, async (db) => (await db.query('SELECT staff_member_add($1, $2, $3) AS id', ['Reviewer', `rev.${stamp()}@subpay-api.example.com`, role])).rows[0].id as string);
    const reviewer = await login(reviewerId);

    // anonymous: nothing at all
    for (const [m, u] of [['GET', '/api/pay/order'], ['POST', '/api/pay/order'], ['GET', '/api/staff/payments'], ['GET', '/api/staff/payments-settings']] as const) expect((await call(undefined, m, u)).statusCode, u).toBe(401);

    // the customer places the order. (The bank details it needs are set and put back inside one transaction, because other test files expect the shared
    // bank details to be empty. Placing over HTTP is covered below for what it refuses.)
    const placed = { statusCode: 200, body: '', json: () => ({ order: null as unknown, id: '' }) };
    {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        const was = (await c.query('SELECT bank_account_name, bank_name, bank_iban, bank_swift FROM billing_settings FOR UPDATE')).rows[0];
        await c.query(`UPDATE billing_settings SET bank_account_name = 'Nusuh Demo Co', bank_name = 'Demo Bank', bank_iban = 'SA0380000000608010167519', bank_swift = 'DEMOSARI'`);
        await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
        placed.json = () => ({ id: id0, order: o0 });
        var id0 = (await c.query('SELECT subpay.place_order() AS id')).rows[0].id as string;
        var o0 = (await c.query('SELECT subpay.my_order() AS o')).rows[0].o;
        await c.query('RESET ROLE');
        await c.query('UPDATE billing_settings SET bank_account_name = $1, bank_name = $2, bank_iban = $3, bank_swift = $4', [was.bank_account_name, was.bank_name, was.bank_iban, was.bank_swift]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }
    // whatever a customer sends about price over HTTP is ignored: the same order comes back
    const again = await call(customer, 'POST', '/api/pay/order', { total: 1, totalHalalas: 1, status: 'approved', amount: '1.00' });
    expect(again.statusCode, again.body).toBe(400);   // (no bank details are committed right now, so this refuses; it never trusts the body)
    const order = placed.json().order as { status: string; totalHalalas: number; reference: string }; const id = placed.json().id as string;
    expect(order.status).toBe('awaiting_payment'); expect(order.totalHalalas).toBeGreaterThan(100);
    expect(order.reference).toMatch(/^NB-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]$/);

    // the customer cannot reach staff routes, staff cannot place orders
    for (const u of ['/api/staff/payments', `/api/staff/payments/${id}`, '/api/staff/payments-settings']) expect((await call(customer, 'GET', u)).statusCode, u).toBeGreaterThanOrEqual(400);
    for (const a of ['recommend', 'reject', 'need-info', 'approve']) expect((await call(customer, 'POST', `/api/staff/payments/${id}/${a}`, { reason: 'x', message: 'x', note: 'x' })).statusCode, a).toBeGreaterThanOrEqual(400);
    expect((await call(reviewer, 'POST', '/api/pay/order')).statusCode).toBeGreaterThanOrEqual(400);

    // "I paid", with a slip, an odd amount first
    const bad = await call(customer, 'POST', `/api/pay/order/${id}/submit`, { amount: '12,000', date: new Date().toISOString().slice(0, 10) });
    expect(bad.statusCode).toBe(400);
    const total = (BigInt(order.totalHalalas));
    const sent = await call(customer, 'POST', `/api/pay/order/${id}/submit`, { amount: `${total / 100n}.${String(total % 100n).padStart(2, '0')}`, date: new Date().toISOString().slice(0, 10), senderBank: 'Al Demo', bankRef: `T${stamp()}`, fileName: 'slip.pdf', fileType: 'application/pdf', fileBase64: PDF });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().order.status).toBe('under_review');

    // the reviewer sees it and the slip (as a download, never shown in the page), and may recommend; the owner approves
    const q = (await call(reviewer, 'GET', '/api/staff/payments')).json();
    expect(q.orders.find((o: { id: string }) => o.id === id)).toMatchObject({ status: 'under_review', hasFile: true });
    const detail = (await call(reviewer, 'GET', `/api/staff/payments/${id}`)).json();
    const slip = await call(reviewer, 'GET', `/api/staff/payments/slip/${detail.submissions[0].id}`);
    expect(slip.statusCode).toBe(200);
    expect(slip.headers['x-content-type-options']).toBe('nosniff'); expect(String(slip.headers['content-disposition'])).toContain('attachment');
    expect(slip.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await call(customer, 'GET', `/api/staff/payments/slip/${detail.submissions[0].id}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call(reviewer, 'POST', `/api/staff/payments/${id}/recommend`, { note: 'ok' })).statusCode).toBe(200);
    expect((await call(reviewer, 'POST', `/api/staff/payments/${id}/approve`, {})).statusCode).toBeGreaterThanOrEqual(400);   // a reviewer cannot approve
    expect((await call(ownerCookie, 'POST', `/api/staff/payments/${id}/approve`, {})).statusCode).toBe(200);
    expect((await call(ownerCookie, 'POST', `/api/staff/payments/${id}/approve`, {})).statusCode).toBeGreaterThanOrEqual(400);   // never twice
    expect((await call(customer, 'GET', '/api/pay/order')).json().order.status).toBe('approved');
    expect((await owner.query('SELECT status FROM subscriptions WHERE firm_id = $1', [f.firmId])).rows[0].status).toBe('active');
  });

  it('hostile ids and bodies are refused cleanly', async () => {
    const f = await seed();
    const c = await login(f.platformOwner);
    for (const u of ['/api/staff/payments/not-a-uuid', '/api/staff/payments/slip/%27%3B%20DROP', '/api/staff/payments/00000000-0000-0000-0000-000000000000']) {
      const r = await call(c, 'GET', u);
      expect(r.statusCode, u).toBeGreaterThanOrEqual(400); expect(r.statusCode).toBeLessThan(500);
    }
    expect((await call(c, 'POST', '/api/staff/payments-settings', { enabled: 'true', reviewTargetHours: '4', orderOpenDays: 14 })).statusCode).toBe(400);
    expect((await call(c, 'POST', '/api/staff/payments-settings', null)).statusCode).toBeGreaterThanOrEqual(400);
  });
});
