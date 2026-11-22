// Ownership through the API: the module permission "Ownership" (none, view, edit) and the routes' bad input.
// Company A's own client accountant is given job titles with different access to Ownership.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
let server: FastifyInstance;
const emails: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  for (const [k, id] of Object.entries({ admin: f.admin, clientA: f.a.clientAccountant, partner: f.partner })) {
    emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.a.cash]);
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

describe('Ownership routes', () => {
  let ownerId = '';
  it('a person with full access can add an owner, set 100 percent and record capital', async () => {
    const p = await signIn('partner');
    const r = await post(p, `/api/companies/${f.a.id}/owners`, { name: 'Api Owner', nameAr: 'مالك' });
    expect(r.statusCode).toBe(200);
    ownerId = r.json().id;
    expect((await post(p, `/api/companies/${f.a.id}/ownership/holdings`, { effectiveFrom: '2027-01-01', holdings: [{ ownerId, shares: '100' }] })).statusCode).toBe(200);
    const m = await post(p, `/api/companies/${f.a.id}/ownership/movements`, { kind: 'contribution', ownerId, date: '2027-02-01', amount: '250.00', accountId: f.a.cash });
    expect(m.statusCode).toBe(200);
    const ov = (await get(p, `/api/companies/${f.a.id}/ownership?asOf=2027-12-31`)).json();
    expect(ov.owners[0]).toMatchObject({ name: 'Api Owner', percent: '100.0000', capital: '250.00' });
  });

  it('bad input is refused with a plain message, not a crash', async () => {
    const p = await signIn('partner');
    expect((await post(p, `/api/companies/${f.a.id}/owners`, { name: '  ' })).json()).toMatchObject({ key: 'err.ownerName' });
    expect((await post(p, `/api/companies/${f.a.id}/ownership/holdings`, { effectiveFrom: 'not a date', holdings: [{ ownerId, percent: '100' }] })).statusCode).toBe(400);
    expect((await post(p, `/api/companies/${f.a.id}/ownership/holdings`, { effectiveFrom: '2027-03-01', holdings: [{ ownerId, percent: '99' }] })).json()).toMatchObject({ key: 'err.holdSum' });
    expect((await post(p, `/api/companies/${f.a.id}/ownership/movements`, { kind: 'contribution', ownerId, amount: '-5', accountId: f.a.cash })).statusCode).toBe(400);
    expect((await post(p, `/api/companies/${f.a.id}/ownership/movements`, { kind: 'nonsense', ownerId, amount: '5', accountId: f.a.cash })).statusCode).toBe(400);
    expect((await get(p, `/api/companies/not-a-uuid/ownership`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(p, `/api/ownership-movements/00000000-0000-4000-8000-000000000000/reverse`, {})).statusCode).toBe(404);
  });

  it('a job title without Ownership gets nothing; with view it can read but not write', async () => {
    const a = await signIn('admin');
    const none = (await post(a, '/api/admin/roles', { name: 'No ownership', permissions: { Sales: 'edit' } })).json().id;
    const view = (await post(a, '/api/admin/roles', { name: 'See ownership', permissions: { Ownership: 'view', Sales: 'edit' } })).json().id;
    await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: none });
    const c1 = await signIn('clientA');
    expect((await get(c1, `/api/companies/${f.a.id}/ownership`)).statusCode).toBe(403);
    expect((await get(c1, `/api/companies/${f.a.id}/ownership/movements`)).statusCode).toBe(403);
    expect((await post(c1, `/api/owners/${ownerId}`, { name: 'Changed' })).statusCode).toBe(403);
    await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: view });
    const c2 = await signIn('clientA');
    expect((await get(c2, `/api/companies/${f.a.id}/ownership`)).statusCode).toBe(200);
    expect((await post(c2, `/api/companies/${f.a.id}/ownership/movements`, { kind: 'contribution', ownerId, amount: '5.00', accountId: f.a.cash })).statusCode).toBe(403);
    expect((await post(c2, `/api/companies/${f.a.id}/owners`, { name: 'Viewer made' })).statusCode).toBe(403);
  });

  it('a person from another company cannot reach this company\'s ownership by changing the id', async () => {
    const c = await signIn('clientA');   // a client user belongs to company A only
    expect((await get(c, `/api/companies/${f.b.id}/ownership`)).statusCode).toBe(404);
    expect((await post(c, `/api/companies/${f.b.id}/owners`, { name: 'Intruder' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.query('SELECT count(*)::int AS n FROM owners WHERE company_id = $1', [f.b.id])).rows[0].n).toBe(0);
  });
});
