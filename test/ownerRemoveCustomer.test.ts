// Removing a customer (platform owner only): it disappears from the owner's list and nobody in it can sign in, its subscription
// is cancelled, and everything stays on file (posted entries and the audit log are never deleted). It can be restored.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-123456';
let f: Fixture;
let server: FastifyInstance;
let platformEmail = '';
let customerId = '', companyId = '', userEmail = '';

beforeAll(async () => {
  f = await seed();
  platformEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server?.close(); });

const login = (email: string, password = PW) => server.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
async function signIn(email: string): Promise<string> {
  const res = await login(email);
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('Remove a customer', () => {
  it('sets a customer up with a company, people and a subscription', async () => {
    const s = stamp();
    userEmail = `owner.${s}@removable.example.com`;
    const cookie = await signIn(platformEmail);
    const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie }, payload: {
      company: { name: `Removable ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh' },
      users: [{ name: 'Admin', email: `admin.${s}@removable.example.com`, jobTitle: 'Administrator' }, { name: 'Owner', email: userEmail, jobTitle: 'Owner' }] } });
    expect(res.statusCode, res.body).toBe(200);
    customerId = res.json().id; companyId = res.json().companyId;
    await owner.query(`UPDATE users SET password_hash = $1 WHERE firm_id = $2`, [await hashPassword(PW), customerId]);
    await owner.query(`INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, next_bill_on) SELECT $1, id, 'monthly', 'active', current_date, current_date + 30 FROM plans LIMIT 1`, [customerId]);
    expect((await login(userEmail)).statusCode).toBe(200);
  });

  it('removes it: nobody there can sign in, it is marked removed, the subscription is cancelled, and every book stays', async () => {
    const cookie = await signIn(platformEmail);
    const accountsBefore = (await owner.query('SELECT count(*)::int AS n FROM accounts WHERE company_id = $1', [companyId])).rows[0].n;
    const res = await server.inject({ method: 'POST', url: `/api/owner/tenants/${customerId}/remove`, headers: { cookie }, payload: { removed: true } });
    expect(res.statusCode, res.body).toBe(200);

    const list = (await server.inject({ method: 'GET', url: '/api/owner/tenants', headers: { cookie } })).json() as { id: string; status: string; removedAt: string | null }[];
    const row = list.find((x) => x.id === customerId)!;
    expect(row.removedAt).toBeTruthy();
    expect(row.status).toBe('suspended');

    const blocked = await login(userEmail);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ key: 'err.tenantSuspended' });
    expect((await owner.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [customerId])).rows[0].status).toBe('cancelled');
    // nothing is deleted
    expect((await owner.query('SELECT count(*)::int AS n FROM companies WHERE firm_id = $1', [customerId])).rows[0].n).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM accounts WHERE company_id = $1', [companyId])).rows[0].n).toBe(accountsBefore);
    expect((await owner.query(`SELECT count(*)::int AS n FROM users WHERE firm_id = $1`, [customerId])).rows[0].n).toBe(2);
  });

  it('restores it: people can sign in again and it is back in the list', async () => {
    const cookie = await signIn(platformEmail);
    expect((await server.inject({ method: 'POST', url: `/api/owner/tenants/${customerId}/remove`, headers: { cookie }, payload: { removed: false } })).statusCode).toBe(200);
    const row = ((await server.inject({ method: 'GET', url: '/api/owner/tenants', headers: { cookie } })).json() as { id: string; status: string; removedAt: string | null }[]).find((x) => x.id === customerId)!;
    expect(row.removedAt).toBeNull();
    expect(row.status).toBe('active');
    expect((await login(userEmail)).statusCode).toBe(200);
  });

  it('is for the platform owner only, and never touches the platform itself', async () => {
    const admin = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.admin])).rows[0].email;
    const a = await signIn(admin);
    expect((await server.inject({ method: 'POST', url: `/api/owner/tenants/${customerId}/remove`, headers: { cookie: a }, payload: { removed: true } })).statusCode).toBe(403);
    const platformFirm = (await owner.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0].id;
    const res = await server.inject({ method: 'POST', url: `/api/owner/tenants/${platformFirm}/remove`, headers: { cookie: await signIn(platformEmail) }, payload: { removed: true } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.query(`SELECT status, removed_at FROM firms WHERE id = $1`, [platformFirm])).rows[0]).toMatchObject({ status: 'active', removed_at: null });
    expect((await server.inject({ method: 'POST', url: `/api/owner/tenants/${customerId}/remove`, payload: { removed: true } })).statusCode).toBeGreaterThanOrEqual(400);   // signed out
  });
});
