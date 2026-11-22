// A company that runs its own books (a customer of kind "company"): its Owner is one person with one login who sees the
// books AND manages the company's users and job titles. The same right does nothing in an accounting firm, never lets
// anyone add a company, and never reaches another customer. (db/migrations/0063_owner_manages_users.sql)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
let server: FastifyInstance;
let soloFirm = '', soloCompany = '', soloOwner = '', soloSales = '';
const emails: Record<string, string> = {};
const soloRole: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  soloFirm = (await owner.query(`INSERT INTO firms (name, kind) VALUES ('Solo Trading', 'company') RETURNING id`)).rows[0].id;
  await owner.query('SELECT add_default_client_roles($1)', [soloFirm]);
  for (const r of (await owner.query('SELECT id, name FROM client_roles WHERE firm_id = $1', [soloFirm])).rows) soloRole[r.name] = r.id;
  const c = await owner.connect();   // a company and its first client user are created together (a deferred database rule)
  try {
    await c.query('BEGIN');
    soloCompany = (await c.query(
      `INSERT INTO companies (firm_id, name, country, currency, cr_number, legal_form, vat_status, vat_number, vat_rate, address, city, fy_end_month, fy_end_day, invoice_prefix, industry, modules)
       VALUES ($1, 'Solo Trading', 'SA', 'SAR', $2, 'LLC', 'registered', $3, '15.00', 'Demo address', 'Riyadh', 12, 31, 'ST-', 'trading', ARRAY['Inventory']) RETURNING id`, [soloFirm, saCr(), saVat()])).rows[0].id;
    const mk = async (name: string, email: string) => (await c.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash, password_set_at) VALUES ($1, 'client', $2, $3, $4, now()) RETURNING id`, [soloFirm, name, email, hash])).rows[0].id as string;
    soloOwner = await mk('Solo Owner', `owner.${Date.now()}@solo.example`);
    soloSales = await mk('Solo Sales', `sales.${Date.now()}@solo.example`);
    await c.query('INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, $3, $4)', [soloOwner, soloCompany, 'client_accountant', soloRole.Owner]);
    await c.query('INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, $3, $4)', [soloSales, soloCompany, 'client_accountant', soloRole.Sales]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  for (const [k, id] of Object.entries({ soloOwner, soloSales, admin: f.admin, clientA: f.a.clientAccountant })) {
    emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server?.close(); });

async function signIn(who: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('The Owner of a company that runs its own books', () => {
  it('has the right on the Owner title and it is reported to the screens', async () => {
    expect((await owner.query('SELECT can_manage_users FROM client_roles WHERE id = $1', [soloRole.Owner])).rows[0].can_manage_users).toBe(true);
    for (const n of ['Sales', 'Finance', 'Commercial', 'Client accountant', 'Client management']) {
      expect((await owner.query('SELECT can_manage_users FROM client_roles WHERE id = $1', [soloRole[n]])).rows[0].can_manage_users, n).toBe(false);
    }
    const c = await signIn('soloOwner');
    expect((await get(c, '/api/me')).json()).toMatchObject({ canManageUsers: true, user: { kind: 'client', firmKind: 'company' } });
    expect((await get(await signIn('soloSales'), '/api/me')).json()).toMatchObject({ canManageUsers: false });
  });

  it('manages the company\'s users and job titles from the same login', async () => {
    const c = await signIn('soloOwner');
    expect((await get(c, '/api/admin/settings')).json()).toMatchObject({ kind: 'company' });
    const role = await post(c, '/api/admin/roles', { name: 'Cashier', permissions: { Sales: 'edit' } });
    expect(role.statusCode).toBe(200);
    const nu = await post(c, `/api/admin/companies/${soloCompany}/users`, { name: 'New Cashier', email: `cashier.${Date.now()}@solo.example`, role: 'client_accountant', clientRoleId: role.json().id });
    expect(nu.statusCode).toBe(200);
    expect(nu.json().invite.token).toBeTruthy();
    expect((await post(c, `/api/admin/companies/${soloCompany}/users/${soloSales}/role`, { clientRoleId: soloRole.Finance })).statusCode).toBe(200);
    expect((await get(c, '/api/admin/roles')).json().map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['Owner', 'Finance', 'Cashier']));
    expect((await get(c, `/api/companies/${soloCompany}`)).statusCode).toBe(200);   // and still reads its own books
    await post(c, `/api/admin/companies/${soloCompany}/users/${soloSales}/role`, { clientRoleId: soloRole.Sales });
  });

  it('can give the right to another job title, and take it away', async () => {
    const c = await signIn('soloOwner');
    const made = await post(c, '/api/admin/roles', { name: 'Office manager', permissions: { Sales: 'edit' }, canManageUsers: true });
    expect(made.statusCode).toBe(200);
    expect((await get(c, '/api/admin/roles')).json().find((r: { id: string }) => r.id === made.json().id)).toMatchObject({ canManageUsers: true });
    await post(c, `/api/admin/roles/${made.json().id}`, { name: 'Office manager', permissions: { Sales: 'edit' }, canManageUsers: false });
    expect((await get(c, '/api/admin/roles')).json().find((r: { id: string }) => r.id === made.json().id)).toMatchObject({ canManageUsers: false });
  });

  it('can never add a company, and stays inside its own customer', async () => {
    const c = await signIn('soloOwner');
    expect((await post(c, '/api/admin/companies', { company: { name: 'Another', country: 'SA', industry: 'trading' }, firstUser: { name: 'X', email: 'x@example.com' } })).statusCode).toBe(403);
    const mine = (await get(c, '/api/admin/companies')).json() as { id: string }[];
    expect(mine.map((x) => x.id)).toEqual([soloCompany]);
    expect((await get(c, `/api/admin/companies/${f.a.id}`)).statusCode).toBe(404);
    expect((await post(c, `/api/admin/companies/${f.a.id}/users/${f.a.clientViewer}/role`, { clientRoleId: soloRole.Owner })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(c, `/api/admin/users/${f.a.clientViewer}/status`, { active: false })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.query('SELECT status FROM users WHERE id = $1', [f.a.clientViewer])).rows[0].status).toBe('active');
  });

  it('stops working the moment the customer is suspended', async () => {
    const c = await signIn('soloOwner');
    await owner.query(`UPDATE firms SET status = 'suspended' WHERE id = $1`, [soloFirm]);
    try { expect((await get(c, '/api/admin/roles')).statusCode).toBeGreaterThanOrEqual(400); }
    finally { await owner.query(`UPDATE firms SET status = 'active' WHERE id = $1`, [soloFirm]); }
  });
});

describe('Everyone else', () => {
  it('a Sales user in the same company cannot open the user and job title screens', async () => {
    const c = await signIn('soloSales');
    expect((await get(c, '/api/admin/roles')).json()).toMatchObject({ key: 'err.adminOnly' });
    expect((await post(c, '/api/admin/roles', { name: 'Sneaky', permissions: {} })).statusCode).toBe(403);
  });

  it('in an accounting firm the right is ignored: a client user with it still cannot manage users', async () => {
    await owner.query(`UPDATE client_roles SET can_manage_users = true WHERE firm_id = (SELECT firm_id FROM users WHERE id = $1)`, [f.a.clientAccountant]);
    const c = await signIn('clientA');
    expect((await get(c, '/api/me')).json()).toMatchObject({ canManageUsers: false });
    expect((await get(c, '/api/admin/roles')).statusCode).toBe(403);
  });

  it('the firm\'s Administrator is unchanged: still cannot be a books user', async () => {
    await expect(owner.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, 'client_accountant')`, [f.admin, f.a.id])).rejects.toThrow(/Administrators cannot be assigned/);
  });
});
