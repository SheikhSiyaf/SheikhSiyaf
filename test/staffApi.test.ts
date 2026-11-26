// The Internal users routes (src/api/staff.ts): adding a person sends an invitation, the other Owners are e-mailed about every change,
// and a staff person without the Owner role is refused everywhere in the owner console.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-1234567890';
let f: Fixture; let server: FastifyInstance; let cookie = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const post = (c: string, url: string, payload: unknown = {}) => server.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as object });
const get = (c: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie: c } });
async function login(email: string) {
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
}
const roleId = async (name: string) => (await owner.query('SELECT id FROM staff_roles WHERE name = $1', [name])).rows[0].id as string;

beforeAll(async () => {
  f = await seed();
  const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email as string;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-staff' });
  cookie = await login(email);
});
// The shared test database holds one platform owner per test file, so a staff change here queues an e-mail for each of them (two in real life).
// Remove what this file queued, so the other files' e-mail checks never wait behind it.
// (The outbox is never deleted from, so they are marked as not to be sent.)
const sweep = () => owner.query(`UPDATE email_outbox SET status = 'failed', last_error = 'test: not sent' WHERE status = 'queued' AND (subject LIKE 'Staff change%' OR to_email LIKE '%@staff-api.example.com')`);
afterEach(sweep);
afterAll(async () => { await sweep(); await server?.close(); });

describe('internal users routes', () => {
  it('adds a person with an invitation, lists them, and e-mails the other owners', async () => {
    const email = `rev.${stamp()}@staff-api.example.com`;
    const before = Number((await owner.query(`SELECT count(*) AS n FROM email_outbox WHERE subject LIKE 'Staff change%'`)).rows[0].n);
    const add = await post(cookie, '/api/owner/staff', { name: 'Rita Reviewer', email, roleId: await roleId('Reviewer') });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json().invite.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const list = (await get(cookie, '/api/owner/staff')).json();
    const me = list.people.find((p: { email: string }) => p.email === email);
    expect(me).toMatchObject({ roleName: 'Reviewer', status: 'active', full: false });
    expect(list.roles.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['Owner', 'Accountant', 'Reviewer', 'HR', 'Support', 'Viewer']));
    const otherOwners = Number((await owner.query(`SELECT count(*) AS n FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE r.is_full AND u.status = 'active' AND u.id <> $1`, [f.platformOwner])).rows[0].n);
    const after = Number((await owner.query(`SELECT count(*) AS n FROM email_outbox WHERE subject LIKE 'Staff change%'`)).rows[0].n);
    expect(after - before).toBeGreaterThanOrEqual(otherOwners > 0 ? 1 : 0);
    expect(await owner.query(`SELECT 1 FROM email_outbox WHERE to_email = $1 AND kind = 'invitation'`, [email])).toHaveProperty('rowCount', 1);
  });

  it('a person added here sets a password through the invitation and then sees only their own access', async () => {
    const email = `acct.${stamp()}@staff-api.example.com`;
    const add = await post(cookie, '/api/owner/staff', { name: 'Ann Accountant', email, roleId: await roleId('Accountant') });
    const token = add.json().invite.token as string;
    const set = await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: PW } });
    expect(set.statusCode, set.body).toBeLessThan(300);
    const c = await login(email);
    const me = (await get(c, '/api/me')).json();
    expect(me.user.kind).toBe('owner');
    expect(me.access.full).toBe(false); expect(me.access.role).toBe('Accountant'); expect(me.access.permissions).toContain('payments.review');
    expect(me.access.permissions).not.toContain('payments.settings');
    // the owner console is closed to them: customers, settings, staff, tenants, billing and the rest
    for (const url of ['/api/owner/staff', '/api/owner/tenants', '/api/owner/settings', '/api/owner/billing', '/api/owner/trial-orders', '/api/owner/bank-details']) {
      expect((await get(c, url)).statusCode, url).toBeGreaterThanOrEqual(400);
    }
    for (const [url, body] of [['/api/owner/staff', { name: 'X', email: `x.${stamp()}@e.example.com`, roleId: await roleId('Owner') }], ['/api/owner/staff-roles', { name: 'Evil', permissions: ['payments.settings'] }],
      ['/api/owner/tenants', { name: 'X', kind: 'firm', adminName: 'A', adminEmail: `a.${stamp()}@e.example.com` }]] as const) {
      const r = await post(c, url, body);
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    const mine = (await owner.query('SELECT staff_role_id FROM users WHERE lower(email) = lower($1)', [email])).rows[0].staff_role_id;
    expect(mine).toBe(await roleId('Accountant'));   // and they could not promote themselves
  });

  it('refuses bad input plainly, and never lets an Owner lock the platform out of itself', async () => {
    expect((await post(cookie, '/api/owner/staff', { name: '', email: 'bad', roleId: await roleId('Viewer') })).statusCode).toBe(400);
    expect((await post(cookie, '/api/owner/staff', { name: 'Z', email: `z.${stamp()}@e.example.com`, roleId: 'not-a-uuid' })).statusCode).toBeGreaterThanOrEqual(400);
    const email = `dup.${stamp()}@staff-api.example.com`;
    expect((await post(cookie, '/api/owner/staff', { name: 'D', email, roleId: await roleId('Viewer') })).statusCode).toBe(200);
    const dup = await post(cookie, '/api/owner/staff', { name: 'D2', email: email.toUpperCase(), roleId: await roleId('Viewer') });
    expect(dup.statusCode).toBe(400);
    const own = await post(cookie, `/api/owner/staff/${f.platformOwner}/role`, { roleId: await roleId('Viewer') });
    expect(own.statusCode).toBe(400); expect(own.json().key ?? own.json().error?.key ?? own.body).toContain('staffSelf');
    expect((await post(cookie, `/api/owner/staff/${f.platformOwner}/status`, { status: 'suspended' })).statusCode).toBe(400);
    expect((await post(cookie, `/api/owner/staff/${f.admin}`, { name: 'Hijack', email: `h.${stamp()}@e.example.com` })).statusCode).toBeGreaterThanOrEqual(400);   // a customer's admin is not staff
  });

  it('roles: create, change, refuse unsafe sets, remove only when empty; hostile text is stored as text', async () => {
    const name = `<script>alert(1)</script> ${stamp()}`;
    const made = await post(cookie, '/api/owner/staff-roles', { name, description: "'; DROP TABLE users; --", permissions: ['billing.view', 'payments.view'] });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    const listed = (await get(cookie, '/api/owner/staff')).json().roles.find((r: { id: string }) => r.id === id);
    expect(listed.name).toBe(name); expect(listed.description).toContain('DROP TABLE');
    expect((await post(cookie, `/api/owner/staff-roles/${id}`, { name, permissions: ['billing.manage'] })).statusCode).toBe(400);   // changes without seeing
    expect((await post(cookie, `/api/owner/staff-roles/${id}`, { name, permissions: ['all.the.things'] })).statusCode).toBe(400);
    expect((await post(cookie, `/api/owner/staff-roles/${await roleId('Reviewer')}`, { name: 'Reviewer', permissions: ['payments.settings', 'payments.view'] })).statusCode).toBe(400);   // built in
    expect((await post(cookie, `/api/owner/staff-roles/${id}/archive`)).statusCode).toBe(200);
    expect(Number((await owner.query('SELECT count(*) AS n FROM users')).rows[0].n)).toBeGreaterThan(5);   // the injection did nothing
  });

  it('suspending a person ends their session at once', async () => {
    const email = `sus.${stamp()}@staff-api.example.com`;
    const add = await post(cookie, '/api/owner/staff', { name: 'Sam Support', email, roleId: await roleId('Support') });
    await server.inject({ method: 'POST', url: `/api/invite/${add.json().invite.token}`, payload: { password: PW } });
    const c = await login(email);
    expect((await get(c, '/api/me')).statusCode).toBe(200);
    expect((await post(cookie, `/api/owner/staff/${add.json().id}/status`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await get(c, '/api/me')).statusCode).toBe(401);
    const again = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(cookie, `/api/owner/staff/${add.json().id}/status`, { status: 'active' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).statusCode).toBe(200);
  });
});
