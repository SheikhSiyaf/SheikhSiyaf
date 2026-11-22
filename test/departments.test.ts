// Department job titles (db/migrations/0062): Owner, Finance, Sales and Commercial, and the reports only the owner may see.
// Each title is given to company A's client accountant in turn and the API is asked what that person may do.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
let server: FastifyInstance;
const emails: Record<string, string> = {};
const roleId: Record<string, string> = {};
let roles: { id: string; name: string; permissions: Record<string, string>; canApprove: boolean }[] = [];

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  for (const [k, id] of Object.entries({ admin: f.admin, clientA: f.a.clientAccountant })) {
    emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['2000', 'Payables', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
  const a = await signIn('admin');
  roles = (await get(a, '/api/admin/roles')).json();
  for (const r of roles) roleId[r.name] = r.id;
});
afterAll(async () => { await server.close(); });

async function signIn(who: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload });
/** Signs in as company A's client accountant holding the named job title. */
async function as(title: string): Promise<string> {
  const a = await signIn('admin');
  expect((await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: roleId[title] })).statusCode).toBe(200);
  return signIn('clientA');
}
const co = () => `/api/companies/${f.a.id}`;

describe('The job titles every customer starts with', () => {
  it('has Owner, Finance, Sales and Commercial next to the two original titles, and adding them again changes nothing', async () => {
    for (const n of ['Client accountant', 'Client management', 'Owner', 'Finance', 'Sales', 'Commercial']) expect(roleId[n], n).toBeTruthy();
    const firm = (await owner.query('SELECT firm_id FROM users WHERE id = $1', [f.a.clientAccountant])).rows[0].firm_id;
    const before = (await owner.query('SELECT count(*)::int AS n FROM client_roles WHERE firm_id = $1', [firm])).rows[0].n;
    await owner.query('SELECT add_default_client_roles($1)', [firm]);
    expect((await owner.query('SELECT count(*)::int AS n FROM client_roles WHERE firm_id = $1', [firm])).rows[0].n).toBe(before);
  });

  it('gives each title the modules its department needs, and only the Owner (and the view-only management title) the owner reports', () => {
    const p = (n: string) => roles.find((r) => r.name === n)!.permissions;
    expect(p('Sales')).toMatchObject({ Sales: 'edit', CRM: 'edit', Purchases: 'none', Bank: 'none', Journal: 'none', Ledger: 'none', HRM: 'none', Reports: 'none', Ownership: 'none', OwnerReports: 'none' });
    expect(p('Commercial')).toMatchObject({ Purchases: 'edit', Inventory: 'edit', Projects: 'edit', Sales: 'view', Bank: 'none', Journal: 'none', HRM: 'none', OwnerReports: 'none', Ownership: 'none' });
    expect(p('Finance')).toMatchObject({ Bank: 'edit', Journal: 'edit', Ledger: 'edit', Sales: 'edit', Purchases: 'edit', Expenses: 'edit', Reports: 'edit', HRM: 'view', Ownership: 'none', OwnerReports: 'none' });
    expect(p('Owner')).toMatchObject({ OwnerReports: 'view', Ownership: 'edit', Sales: 'view', Bank: 'view', HRM: 'view', Journal: 'view' });
    expect(p('Client accountant')).toMatchObject({ Journal: 'edit', OwnerReports: 'none', Ownership: 'none' });
    expect(p('Client management')).toMatchObject({ OwnerReports: 'view', Ownership: 'view' });
    expect(roles.find((r) => r.name === 'Owner')!.canApprove).toBe(true);
    expect(roles.find((r) => r.name === 'Finance')!.canApprove).toBe(true);
    expect(roles.find((r) => r.name === 'Sales')!.canApprove).toBe(false);
  });
});

describe('Sales', () => {
  it('handles customers and invoices and nothing about buying, banking, the books or the owner reports', async () => {
    const c = await as('Sales');
    expect((await get(c, `${co()}/documents?type=invoice`)).statusCode).toBe(200);
    expect((await post(c, `${co()}/contacts`, { isCustomer: true, name: 'Sales made customer' })).statusCode).toBe(200);
    for (const url of [`${co()}/documents?type=bill`, `${co()}/bank-rules`, `${co()}/reports/trial-balance`, `${co()}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`, `${co()}/entries`, `${co()}/ownership`, `${co()}/hr/employees`, `${co()}/summary`]) {
      expect((await get(c, url)).statusCode, url).toBe(403);
    }
    expect((await post(c, `${co()}/contacts`, { isSupplier: true, name: 'Not for sales' })).statusCode).toBe(403);
  });
});

describe('Commercial', () => {
  it('handles suppliers, purchasing and stock, can look at sales prices, and cannot change sales or touch the books', async () => {
    const c = await as('Commercial');
    expect((await post(c, `${co()}/contacts`, { isSupplier: true, name: 'Commercial supplier' })).statusCode).toBe(200);
    expect((await get(c, `${co()}/documents?type=bill`)).statusCode).toBe(200);
    expect((await get(c, `${co()}/items`)).statusCode).toBe(200);
    expect((await get(c, `${co()}/documents?type=invoice`)).statusCode).toBe(200);   // view
    expect((await post(c, `${co()}/contacts`, { isCustomer: true, name: 'Commercial cannot' })).statusCode).toBe(403);
    for (const url of [`${co()}/bank-accounts`, `${co()}/reports/trial-balance`, `${co()}/entries`, `${co()}/hr/employees`, `${co()}/ownership`]) expect((await get(c, url)).statusCode, url).toBe(403);
  });
});

describe('Finance', () => {
  it('handles the money side of every department and the finance reports, and may look at the rest, but never the owner reports', async () => {
    const c = await as('Finance');
    for (const url of [`${co()}/bank-accounts`, `${co()}/reports/trial-balance`, `${co()}/reports/vat-return`, `${co()}/entries`, `${co()}/documents?type=invoice`, `${co()}/documents?type=bill`, `${co()}/hr/employees`, `${co()}/summary`]) {
      expect((await get(c, url)).statusCode, url).toBe(200);
    }
    for (const url of [`${co()}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`, `${co()}/reports/balance-sheet`, `${co()}/reports/cash-flow`, `${co()}/reports/owner-summary`, `${co()}/reports/pnl-columns`, `${co()}/ownership`, `${co()}/ownership/equity-statement`]) {
      expect((await get(c, url)).statusCode, url).toBe(403);
    }
  });

  it('the home figures do not carry the month\'s profit, income or expense', async () => {
    const c = await as('Finance');
    const s = (await get(c, `${co()}/summary`)).json();
    expect(s).toHaveProperty('cash');
    for (const k of ['monthProfit', 'monthIncome', 'monthExpense']) expect(s, k).not.toHaveProperty(k);
  });
});

describe('Owner', () => {
  it('sees the owner reports and ownership, and can look at everything else', async () => {
    const c = await as('Owner');
    for (const url of [`${co()}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`, `${co()}/reports/balance-sheet`, `${co()}/reports/cash-flow`, `${co()}/reports/owner-summary`, `${co()}/ownership`, `${co()}/ownership/equity-statement`, `${co()}/reports/trial-balance`, `${co()}/bank-accounts`, `${co()}/entries`]) {
      expect((await get(c, url)).statusCode, url).toBe(200);
    }
    const s = (await get(c, `${co()}/summary`)).json();
    for (const k of ['monthProfit', 'monthIncome', 'monthExpense']) expect(s, k).toHaveProperty(k);
  });

  it('records ownership money but does not change sales or purchases', async () => {
    const c = await as('Owner');
    expect((await post(c, `${co()}/owners`, { name: 'Dept Owner' })).statusCode).toBe(200);
    expect((await post(c, `${co()}/contacts`, { isCustomer: true, name: 'Owner cannot' })).statusCode).toBe(403);
  });
});

describe('The original titles', () => {
  it('Client accountant works as before but no longer reads the owner reports; Client management still sees them', async () => {
    const c = await as('Client accountant');
    expect((await get(c, `${co()}/reports/trial-balance`)).statusCode).toBe(200);
    expect((await get(c, `${co()}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`)).statusCode).toBe(403);
    const m = await as('Client management');
    expect((await get(m, `${co()}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`)).statusCode).toBe(200);
  });
});
