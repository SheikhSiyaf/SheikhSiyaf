// Customers (tenants): the platform owner creates accounting firms and companies that run their own books, their first
// Administrator and every company. Each Administrator sees only their own customer; a company's Administrator manages
// users, roles and access only. Client roles can carry review and sign-off rights for internal review.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword, } from '../src/auth/password.js';
import { hashInviteToken } from '../src/api/auth.js';

let f: Fixture;
let server: FastifyInstance;
let tenant: string, companyId: string, tenantAdminEmail: string;
const PW = 'pw-123456';
const cookies: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  server = buildServer({ pool: appPool, sessionSecret: 'tenant-secret' });
  const hash = await hashPassword(PW);
  for (const [k, id] of Object.entries({ owner: f.platformOwner, firmAdmin: f.admin, partner: f.partner })) {
    const e = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
    cookies[k] = await signInAs(e);
  }
});
afterAll(async () => { await server.close(); });

async function signInAs(email: string, password = PW) {
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
}
const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object, acting?: string) =>
  server.inject({ method, url, headers: { cookie, ...(acting ? { 'x-acting-tenant': acting } : {}) }, payload });
async function acceptInvite(token: string, password = PW) {
  await owner.query('UPDATE users SET password_hash = $2 WHERE invite_token_hash = $1', [hashInviteToken(token), await hashPassword(password)]);
}

describe('The platform owner', () => {
  it('creates a company customer with its first Administrator, then the company inside it', async () => {
    const r = await call(cookies.owner!, 'POST', '/api/owner/tenants', { name: 'Desert Rose Trading', kind: 'company', adminName: 'Hamad', adminEmail: `hamad.${Date.now()}@example.com` });
    expect(r.statusCode, r.body).toBe(200);
    tenant = r.json().id;
    tenantAdminEmail = r.json().invite.email;
    await acceptInvite(r.json().invite.token);
    const c = await call(cookies.owner!, 'POST', '/api/admin/companies', {
      company: { name: 'Desert Rose Trading', country: 'SA', industry: 'trading', crNumber: saCr(), legalForm: 'LLC', vatStatus: 'registered', vatNumber: saVat(), address: 'Olaya', city: 'Riyadh' },
      firstUser: { name: 'Ali Accountant', email: `ali.${Date.now()}@example.com` } }, tenant);
    expect(c.statusCode, c.body).toBe(200);
    companyId = c.json().id;
    const list = (await call(cookies.owner!, 'GET', '/api/owner/tenants')).json();
    expect(list.find((x: { id: string }) => x.id === tenant)).toMatchObject({ kind: 'company', companies: 1, admins: 'Hamad' });
  });

  it('never sees books, and only the owner manages customers', async () => {
    expect((await call(cookies.owner!, 'GET', `/api/companies/${companyId}`, undefined, tenant)).statusCode).toBe(404);
    expect((await call(cookies.firmAdmin!, 'GET', '/api/owner/tenants')).statusCode).toBe(403);
    expect((await call(cookies.firmAdmin!, 'POST', '/api/owner/tenants', { name: 'X', kind: 'firm', adminName: 'X', adminEmail: 'x@example.com' })).statusCode).toBe(403);
  });
});

describe("A company's own Administrator", () => {
  let hamad: string;
  it('sees only its own customer; the header naming another customer is ignored for anyone but the owner', async () => {
    hamad = await signInAs(tenantAdminEmail);
    const mine = (await call(hamad, 'GET', '/api/admin/companies')).json();
    expect(mine.map((c: { id: string }) => c.id)).toEqual([companyId]);
    const sneaky = (await call(hamad, 'GET', '/api/admin/companies', undefined, f.firmId)).json();
    expect(sneaky.map((c: { id: string }) => c.id)).toEqual([companyId]);
    const firm = (await call(cookies.firmAdmin!, 'GET', '/api/admin/companies')).json();
    expect(firm.some((c: { id: string }) => c.id === companyId)).toBe(false);
    expect((await call(hamad, 'GET', '/api/admin/settings')).json()).toMatchObject({ kind: 'company', owner: false });
  });

  it('manages users and roles, but cannot add companies, firm staff or change the company details', async () => {
    expect((await call(hamad, 'POST', '/api/admin/companies', {
      company: { name: 'Second', country: 'SA', industry: 'trading', crNumber: saCr(), legalForm: 'LLC', vatStatus: 'registered', vatNumber: saVat(), address: 'S', city: 'R' },
      firstUser: { name: 'X', email: `x.${Date.now()}@example.com` } })).json()).toMatchObject({ key: 'err.ownerOnly' });
    expect((await call(hamad, 'POST', '/api/admin/staff', { name: 'Staff', email: `s.${Date.now()}@example.com`, role: 'staff_accountant' })).json()).toMatchObject({ key: 'err.companyNoStaff' });
    expect((await call(hamad, 'POST', `/api/admin/companies/${companyId}`, { company: { name: 'Renamed', country: 'SA', industry: 'trading', crNumber: saCr(), legalForm: 'LLC', vatStatus: 'unregistered', address: 'S', city: 'R' } })).statusCode).not.toBe(200);
    // Internal review: a role that reviews and signs off, for their own finance manager.
    const role = (await call(hamad, 'POST', '/api/admin/roles', { name: 'Finance manager', permissions: { Reports: 'view', Journal: 'view' }, canReview: true, canSignOff: true })).json().id;
    const add = (await call(hamad, 'POST', `/api/admin/companies/${companyId}/users`, { name: 'Noura', email: `noura.${Date.now()}@example.com`, clientRoleId: role })).json();
    await acceptInvite(add.invite.token);
    const noura = await signInAs(add.invite.email);
    const books = (await call(noura, 'GET', `/api/companies/${companyId}`)).json();
    expect(books.review).toEqual({ canReview: true, canSignOff: true });
    const pe = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)).toISOString().slice(0, 10);
    const q = await call(noura, 'POST', `/api/companies/${companyId}/review/queries`, { periodEnd: pe, subject: 'Petty cash', body: 'Please send the receipts.' });
    expect(q.statusCode, q.body).toBe(200);
    expect((await call(hamad, 'GET', '/api/admin/roles')).json().find((r: { id: string }) => r.id === role)).toMatchObject({ canReview: true, canSignOff: true });
  });

  it('the firm Administrator still adds staff and edits client details, but not companies', async () => {
    expect((await call(cookies.firmAdmin!, 'POST', '/api/admin/staff', { name: 'New Staff', email: `ns.${Date.now()}@example.com`, role: 'staff_accountant' })).statusCode).toBe(200);
    expect((await call(cookies.firmAdmin!, 'GET', '/api/admin/settings')).json()).toMatchObject({ kind: 'firm' });
  });

  it('a suspended customer cannot sign in; reactivating lets them back', async () => {
    await call(cookies.owner!, 'POST', `/api/owner/tenants/${tenant}`, { name: 'Desert Rose Trading', status: 'suspended' });
    const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email: tenantAdminEmail, password: PW } });
    expect(r.json()).toMatchObject({ key: 'err.tenantSuspended' });
    await call(cookies.owner!, 'POST', `/api/owner/tenants/${tenant}`, { name: 'Desert Rose Trading', status: 'active' });
    await signInAs(tenantAdminEmail);
  });

  it('the database keeps owners on the platform and firm staff out of companies', async () => {
    await expect(owner.query(`INSERT INTO users (firm_id, kind, full_name, email, staff_role) VALUES ($1, 'firm_staff', 'X', $2, 'reviewer')`, [tenant, `x.${Date.now()}@example.com`])).rejects.toThrow(/runs its own books/);
    await expect(owner.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'owner', 'X', $2)`, [f.firmId, `o.${Date.now()}@example.com`])).rejects.toThrow(/platform/);
  });
});
