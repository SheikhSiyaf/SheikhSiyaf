// Client roles (Administrator > Roles and permissions), access per module through the API,
// and the profit and loss statement format.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, sale, as, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { postEntry } from '../src/ledger/ledger.js';
import { profitAndLoss } from '../src/books/reportsService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let server: FastifyInstance;
const emails: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  for (const [k, id] of Object.entries({ admin: f.admin, partner: f.partner, clientA: f.a.clientAccountant, viewerA: f.a.clientViewer })) {
    emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['4900', 'Gain on sale of assets', 'income'], ['5400', 'Office', 'expense'], ['5050', 'Depreciation', 'expense']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server.close(); });

async function signIn(who: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('Profit and loss statement', () => {
  it('sales - cost of sales = gross profit; - indirect expenses + indirect income = net profit', async () => {
    const acct = async (code: string) => (await owner.query('SELECT id, pnl_group FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0];
    expect((await acct('4000')).pnl_group).toBe('revenue');
    expect((await acct('4900')).pnl_group).toBe('other_income');
    expect((await acct('5100')).pnl_group).toBe('indirect_expense');
    // The fixture's 5000 is used as cost of sales here.
    expect((await acct('5000')).pnl_group).toBe('cost_of_sales');
    const post2 = (lines: { accountId: string; debit?: string; credit?: string; costCentreId?: string }[]) =>
      as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-10', lines }));
    await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-10', '1000.00')));                              // sales 1000
    await post2([{ accountId: f.a.rent, debit: '400.00' }, { accountId: f.a.cash, credit: '400.00' }]);           // cost of sales 400
    await post2([{ accountId: (await acct('5400')).id, debit: '150.00' }, { accountId: f.a.cash, credit: '150.00' }]);   // indirect 150
    await post2([{ accountId: f.a.cash, debit: '50.00' }, { accountId: (await acct('4900')).id, credit: '50.00' }]);    // indirect income 50
    const p = await as(f.partner, (db) => profitAndLoss(db, f.a.id, '2026-03-01', '2026-03-31'));
    expect(p).toMatchObject({ revenue: '1000.00', costOfSales: '400.00', grossProfit: '600.00', indirectExpenses: '150.00', otherIncome: '50.00', netProfit: '500.00' });
    const total = (await owner.query(`SELECT profit::text FROM profit_and_loss($1, '2026-03-01', '2026-03-31')`, [f.a.id])).rows[0].profit;
    expect(total).toBe(p.netProfit);   // the statement agrees with the ledger's profit
  });

  it('an account can be moved to another line of the statement, within its type', async () => {
    await owner.query(`UPDATE accounts SET pnl_group = 'cost_of_sales' WHERE company_id = $1 AND code = '5400'`, [f.a.id]);
    expect((await owner.query(`SELECT pnl_group FROM accounts WHERE company_id = $1 AND code = '5400'`, [f.a.id])).rows[0].pnl_group).toBe('cost_of_sales');
    await owner.query(`UPDATE accounts SET pnl_group = 'revenue' WHERE company_id = $1 AND code = '5400'`, [f.a.id]);   // not for an expense: back to its usual line
    expect((await owner.query(`SELECT pnl_group FROM accounts WHERE company_id = $1 AND code = '5400'`, [f.a.id])).rows[0].pnl_group).toBe('indirect_expense');
  });
});

describe('Roles and permissions', () => {
  let cashier: string;

  it('only the Administrator makes roles; titles are unique; modules and levels are checked', async () => {
    const a = await signIn('admin');
    const r = await post(a, '/api/admin/roles', { name: 'Cashier', nameAr: 'أمين الصندوق', permissions: { Sales: 'edit', Reports: 'view', Unknown: 'edit' } });
    expect(r.statusCode).toBe(200);
    cashier = r.json().id;
    expect((await post(a, '/api/admin/roles', { name: 'Cashier' })).json()).toMatchObject({ key: 'err.roleTaken' });
    const roles = (await get(a, '/api/admin/roles')).json();
    expect(roles.find((x: { id: string }) => x.id === cashier).permissions).toEqual({ Sales: 'edit', Reports: 'view' });
    const p = await signIn('partner');
    expect((await post(p, '/api/admin/roles', { name: 'Sneaky' })).statusCode).toBe(403);
    expect((await post(a, '/api/admin/roles', { name: ' cashier ' })).json()).toMatchObject({ key: 'err.roleTaken' });
    await expect(owner.query(`INSERT INTO client_roles (firm_id, name, permissions) VALUES ($1, 'Bad', '{"Sales":"owner"}')`, [f.firmId])).rejects.toThrow(/Unknown module or access level/);
  });

  it('a client user with a role only uses the modules it allows: view to read, edit to change', async () => {
    const a = await signIn('admin');
    expect((await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: cashier })).statusCode).toBe(200);
    const c = await signIn('clientA');
    const books = (await get(c, `/api/companies/${f.a.id}`)).json();
    expect(books.access).toMatchObject({ name: 'Cashier', permissions: { Sales: 'edit', Reports: 'view' }, canApprove: false });
    expect(books.role).toBe('client_accountant');
    // Sales: may read and write.
    const supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd' }));
    const customer = (await post(c, `/api/companies/${f.a.id}/contacts`, { isCustomer: true, name: 'Gulf Steel' })).json().id;
    expect(customer).toBeTruthy();
    expect((await get(c, `/api/companies/${f.a.id}/documents?type=invoice`)).statusCode).toBe(200);
    // Purchases and Journal: no access at all.
    expect((await get(c, `/api/companies/${f.a.id}/documents?type=bill`)).json()).toMatchObject({ key: 'err.roleNoAccess' });
    expect((await post(c, `/api/companies/${f.a.id}/documents`, { type: 'bill', contactId: supplier, issueDate: '2026-03-10', lines: [] })).statusCode).toBe(403);
    expect((await get(c, `/api/companies/${f.a.id}/entries`)).statusCode).toBe(403);
    // Reports: read only.
    expect((await get(c, `/api/companies/${f.a.id}/reports/trial-balance`)).statusCode).toBe(200);
  });

  it('changing the role changes the access at once; a view-only role cannot write anywhere, even in the database', async () => {
    const a = await signIn('admin');
    await post(a, `/api/admin/roles/${cashier}`, { name: 'Cashier', permissions: { Sales: 'view', Reports: 'view' } });
    expect((await owner.query('SELECT role FROM memberships WHERE user_id = $1 AND company_id = $2', [f.a.clientAccountant, f.a.id])).rows[0].role).toBe('client_viewer');
    const c = await signIn('clientA');
    expect((await post(c, `/api/companies/${f.a.id}/contacts`, { isCustomer: true, name: 'Another' })).statusCode).toBe(403);
    await expect(as(f.a.clientAccountant, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Direct' }))).rejects.toThrow();
  });

  it('approving claims needs the approve right; the built-in roles keep full access', async () => {
    const a = await signIn('admin');
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '2200', 'Employee claims payable', 'liability')`, [f.a.id]);
    const emp = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Yusuf Karim' }));
    const claim = await as(f.staff, async (db) => {
      const id = await S.saveDraft(db, f.a.id, { type: 'claim', contactId: emp, issueDate: '2026-03-12',
        lines: [{ description: 'Fuel', quantity: '1', unitPrice: '50.00', accountId: f.a.rent, vatCode: 'zero' }] });
      await S.submitClaim(db, id); return id;
    });
    await post(a, `/api/admin/roles/${cashier}`, { name: 'Cashier', permissions: { Expenses: 'edit' }, canApprove: false });
    const c = await signIn('clientA');
    expect((await post(c, `/api/documents/${claim}/approve`, {})).json()).toMatchObject({ key: 'err.roleNoApprove' });
    await post(a, `/api/admin/roles/${cashier}`, { name: 'Cashier', permissions: { Expenses: 'edit' }, canApprove: true });
    expect((await post(c, `/api/documents/${claim}/approve`, {})).statusCode).toBe(200);
    const viewer = await signIn('viewerA');
    expect((await get(viewer, `/api/companies/${f.a.id}/entries`)).statusCode).toBe(200);   // Client management reads everything
  });

  it('Client accountant and Client management are ordinary roles: every client user has one and they can be changed', async () => {
    const a = await signIn('admin');
    const roles = (await get(a, '/api/admin/roles')).json() as { id: string; name: string; permissions: Record<string, string>; canApprove: boolean }[];
    const accountant = roles.find((r) => r.name === 'Client accountant')!, management = roles.find((r) => r.name === 'Client management')!;
    expect(accountant.permissions.Journal).toBe('edit');
    expect(management).toMatchObject({ canApprove: false, permissions: { Sales: 'view', Reports: 'view' } });
    expect((await get(await signIn('viewerA'), `/api/companies/${f.a.id}`)).json().access).toMatchObject({ name: 'Client management' });
    // A new client user without a role named gets one; asking for no role is refused.
    const nu = (await post(a, `/api/admin/companies/${f.a.id}/users`, { name: 'New Person', email: `np.${Date.now()}@example.com`, role: 'client_viewer' })).json();
    expect((await owner.query('SELECT r.name FROM memberships m JOIN client_roles r ON r.id = m.client_role_id WHERE m.user_id = $1', [nu.invite.userId])).rows[0].name).toBe('Client management');
    expect((await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: null })).json()).toMatchObject({ key: 'err.roleChoose' });
    // Change the default accountant role: no Journal any more.
    await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: accountant.id });
    await post(a, `/api/admin/roles/${accountant.id}`, { name: 'Client accountant', permissions: { ...accountant.permissions, Journal: 'none' }, canApprove: true });
    const c = await signIn('clientA');
    expect((await get(c, `/api/companies/${f.a.id}/entries`)).json()).toMatchObject({ key: 'err.roleNoAccess' });
    expect((await get(c, `/api/companies/${f.a.id}/documents?type=invoice`)).statusCode).toBe(200);
  });

  it('roles in use cannot be archived; the activity page shows role changes', async () => {
    const a = await signIn('admin');
    await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientViewer}/role`, { clientRoleId: cashier });
    expect((await post(a, `/api/admin/roles/${cashier}`, { name: 'Cashier', status: 'archived' })).json()).toMatchObject({ key: 'err.roleInUse' });
    const activity = (await get(a, '/api/admin/activity')).json();
    expect(activity.some((x: { key: string; params: { role?: string } }) => x.key === 'act.roleAdded' && x.params.role === 'Cashier')).toBe(true);
    expect(activity.some((x: { key: string }) => x.key === 'act.roleAssigned')).toBe(true);
  });
});
