// "Company own accounts" in the owner console's Add customer: ONE customer with ONE company, created in a single save with
// its people: a separate Administrator (users, roles and permissions; never the books) and the people who use the books (an
// Owner and others). It never asks for more companies (that is the accounting firm's way), it is all-or-nothing, and the
// new people see only their own company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-123456';
let f: Fixture;
let server: FastifyInstance;
let platformEmail = '';

beforeAll(async () => {
  f = await seed();
  platformEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server?.close(); });

async function signIn(email: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const company = (name: string) => ({
  name, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(),
  address: 'King Fahd Road', city: 'Riyadh', email: 'info@example.com', phone: '+966500000000', fyEnd: '12-31', invoicePrefix: 'INV-',
});
const create = (cookie: string, body: object) => server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie }, payload: body });

describe('Add customer: Company own accounts', () => {
  let customerId = '', companyId = '', adminEmail = '', ownerEmail = '', salesEmail = '';

  it('creates exactly one company, one Administrator and two people who use the books, with the books set up', async () => {
    const s = stamp();
    adminEmail = `admin.${s}@own-books.example.com`; ownerEmail = `owner.${s}@own-books.example.com`; salesEmail = `sales.${s}@own-books.example.com`;
    const res = await create(await signIn(platformEmail), {
      company: company(`Own Books ${s}`),
      users: [
        { name: 'The Administrator', email: adminEmail, jobTitle: 'Administrator' },
        { name: 'The Owner', email: ownerEmail, jobTitle: 'Owner' },
        { name: 'The Salesperson', email: salesEmail, jobTitle: 'Sales' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    customerId = body.id; companyId = body.companyId;
    expect(body.invites).toHaveLength(3);
    expect(body.invites.every((i: { token: string }) => i.token.length > 20)).toBe(true);

    expect((await owner.query('SELECT kind FROM firms WHERE id = $1', [customerId])).rows[0].kind).toBe('company');
    expect((await owner.query('SELECT count(*)::int AS n FROM companies WHERE firm_id = $1', [customerId])).rows[0].n).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM users WHERE firm_id = $1 AND kind = 'client'`, [customerId])).rows[0].n).toBe(2);
    expect((await owner.query(`SELECT count(*)::int AS n FROM users WHERE firm_id = $1 AND kind = 'admin'`, [customerId])).rows[0].n).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM memberships WHERE company_id = $1', [companyId])).rows[0].n).toBe(2);   // the Administrator is never a books user
    expect((await owner.query('SELECT count(*)::int AS n FROM accounts WHERE company_id = $1', [companyId])).rows[0].n).toBeGreaterThan(20);
    expect((await owner.query('SELECT count(*)::int AS n FROM periods WHERE company_id = $1', [companyId])).rows[0].n).toBeGreaterThan(0);
    const titles = (await owner.query(
      `SELECT r.name FROM memberships m JOIN client_roles r ON r.id = m.client_role_id WHERE m.company_id = $1 ORDER BY r.name`, [companyId])).rows;
    expect(titles.map((t) => t.name)).toEqual(['Owner', 'Sales']);
    // the Owner is not the Administrator: the right to manage users is off on every default title
    expect((await owner.query(`SELECT count(*)::int AS n FROM client_roles WHERE firm_id = $1 AND can_manage_users`, [customerId])).rows[0].n).toBe(0);
  });

  it('keeps the Administrator and the people who use the books apart, and each in this customer only', async () => {
    for (const email of [adminEmail, ownerEmail, salesEmail]) await owner.query(`UPDATE users SET password_hash = $1 WHERE lower(email) = lower($2)`, [await hashPassword(PW), email]);
    const a = await signIn(adminEmail), o = await signIn(ownerEmail), s = await signIn(salesEmail);
    const me = async (cookie: string) => (await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();

    // the Administrator: the admin area, no books, and nothing outside this customer
    const am = await me(a);
    expect(am.user.kind).toBe('admin');
    expect(am.companies).toEqual([]);
    expect((await server.inject({ method: 'GET', url: '/api/admin/roles', headers: { cookie: a } })).statusCode).toBe(200);
    const mine = (await server.inject({ method: 'GET', url: '/api/admin/companies', headers: { cookie: a } })).json();
    expect(mine.map((c: { id: string }) => c.id)).toEqual([companyId]);
    const books = await server.inject({ method: 'GET', url: `/api/companies/${companyId}/chart`, headers: { cookie: a } });   // never the books
    expect(books.statusCode >= 400 || /^\[\s*\]$/.test(books.body.trim()) || books.json().length === 0).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS n FROM accounts WHERE company_id = $1', [companyId])).rows[0].n).toBeGreaterThan(20);   // the accounts exist; the Administrator just cannot see them

    // the Owner and the others: the books of this company only, no admin area, no managing users
    for (const cookie of [o, s]) {
      const m = await me(cookie);
      expect(m.companies.map((c: { id: string }) => c.id)).toEqual([companyId]);
      expect(m).toMatchObject({ canManageUsers: false });
      expect((await server.inject({ method: 'GET', url: '/api/admin/roles', headers: { cookie } })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/chart`, headers: { cookie } })).statusCode).toBeGreaterThanOrEqual(400);   // another customer's company
    }
    expect((await server.inject({ method: 'GET', url: `/api/companies/${companyId}/chart`, headers: { cookie: o } })).statusCode).toBe(200);
  });

  it('never lets a second company be added to a company that keeps its own books', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/admin/companies', headers: { cookie: await signIn(platformEmail), 'x-acting-tenant': customerId },
      payload: { company: company('A Second One'), firstUser: { name: 'Nobody', email: `nobody.${stamp()}@example.com` } } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ key: 'err.oneCompany' });
    expect((await owner.query('SELECT count(*)::int AS n FROM companies WHERE firm_id = $1', [customerId])).rows[0].n).toBe(1);
  });

  it('asks for an Administrator and for someone who uses the books, a job title for everyone, and different emails; nothing is created when it refuses', async () => {
    const cookie = await signIn(platformEmail);
    const s = stamp();
    const adm = (n: string) => ({ name: 'Adam', email: `adam${n}.${s}@example.com`, jobTitle: 'Administrator' });
    const own = (n: string) => ({ name: 'Olga', email: `olga${n}.${s}@example.com`, jobTitle: 'Owner' });
    expect((await create(cookie, { company: company(`Refused ${s} no admin`), users: [own('1')] })).json()).toMatchObject({ key: 'err.companyAdmin' });
    expect((await create(cookie, { company: company(`Refused ${s} only admin`), users: [adm('2')] })).json()).toMatchObject({ key: 'err.companyUsers' });
    expect((await create(cookie, { company: company(`Refused ${s} no users`), users: [] })).json()).toMatchObject({ key: 'err.companyUsers' });
    expect((await create(cookie, { company: company(`Refused ${s} no title`), users: [adm('3'), { name: 'A', email: `a.${s}@example.com`, jobTitle: 'Boss' }] })).json()).toMatchObject({ key: 'err.roleChoose' });
    expect((await create(cookie, { company: company(`Refused ${s} same email`), users: [{ ...adm('4'), email: `x.${s}@example.com` }, { ...own('4'), email: `X.${s}@example.com` }] })).json()).toMatchObject({ key: 'err.sameEmail' });
    expect((await create(cookie, { company: { ...company(`Refused ${s} no country`), country: '' }, users: [adm('5'), own('5')] })).statusCode).toBe(400);
    // only what THIS test tried is looked at: other test files add rows to the same database at the same time
    expect((await owner.query(`SELECT count(*)::int AS n FROM firms WHERE name LIKE $1`, [`Refused ${s}%`])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [`%.${s}@example.com`])).rows[0].n).toBe(0);
  });

  it('is all-or-nothing: if one person cannot be created, no customer, company or user is left behind', async () => {
    const cookie = await signIn(platformEmail);
    const s = stamp();
    // the last person's email already belongs to someone (the first test's Owner)
    const res = await create(cookie, { company: company(`Half Done ${s}`), users: [
      { name: 'Admin', email: `fresh.admin.${s}@own-books.example.com`, jobTitle: 'Administrator' },
      { name: 'Fresh', email: `fresh.${s}@own-books.example.com`, jobTitle: 'Owner' },
      { name: 'Taken', email: ownerEmail, jobTitle: 'Sales' }] });
    expect(res.statusCode).toBe(400);   // a clear refusal, not a crash
    expect((await owner.query(`SELECT count(*)::int AS n FROM firms WHERE name = $1`, [`Half Done ${s}`])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM companies WHERE name = $1`, [`Half Done ${s}`])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [`fresh%.${s}@own-books.example.com`])).rows[0].n).toBe(0);
  });

  it('is for the platform owner only', async () => {
    const s = stamp();
    const admin = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.admin])).rows[0].email;
    const res = await create(await signIn(admin), { company: company(`Not Allowed ${s}`), users: [{ name: 'A', email: `a.${s}@example.com`, jobTitle: 'Administrator' }, { name: 'B', email: `b.${s}@example.com`, jobTitle: 'Owner' }] });
    expect(res.statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/api/owner/customers/company', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
