// HTTP API: sign-in, sessions, and that every rule still holds through the API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, sale, as, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { postEntry } from '../src/ledger/ledger.js';
import { signSession } from '../src/auth/session.js';
import { saCr, saVat } from './helpers.js';

const SECRET = 'test-secret';
let f: Fixture;
let server: FastifyInstance;
const emails: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  for (const [k, id] of Object.entries({ admin: f.admin, partner: f.partner, staff: f.staff, clientA: f.a.clientAccountant, viewerA: f.a.clientViewer })) {
    const { rows } = await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id]);
    emails[k] = rows[0].email;
  }
  await as(f.partner, (db) => postEntry(db, sale(f.b, '2026-03-01', '500.00')));
  server = buildServer({ pool: appPool, sessionSecret: SECRET });
});
afterAll(async () => { await server.close(); });

async function signIn(who: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('API', () => {
  it('rejects a wrong password, and requests without a session', async () => {
    const bad = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails.clientA, password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    expect((await server.inject({ url: '/api/me' })).statusCode).toBe(401);
    expect((await get('nb_session=forged.9999999999.sig', '/api/me')).statusCode).toBe(401);
  });

  it('a tampered session token is rejected', async () => {
    const token = signSession(SECRET, f.a.clientAccountant);
    const [, exp, sig] = token.split('.');
    expect((await get(`nb_session=${f.partner}.${exp}.${sig}`, '/api/me')).statusCode).toBe(401);
  });

  it('a client user only sees their own company, even by asking for another one directly', async () => {
    const c = await signIn('clientA');
    const me = (await get(c, '/api/me')).json();
    expect(me.companies.map((x: { id: string }) => x.id)).toEqual([f.a.id]);
    expect((await get(c, `/api/companies/${f.b.id}`)).statusCode).toBe(404);
    expect((await get(c, `/api/companies/${f.b.id}/entries`)).statusCode).toBe(404);
    const tb = await get(c, `/api/companies/${f.b.id}/reports/trial-balance`);
    expect(tb.statusCode).toBe(404);
  });

  it('posts a balanced entry, and explains an unbalanced one in plain language', async () => {
    const c = await signIn('clientA');
    const ok = await post(c, `/api/companies/${f.a.id}/entries`, {
      entryDate: '2026-03-02', memo: 'API sale', lines: [{ accountId: f.a.cash, debit: '20.00' }, { accountId: f.a.sales, credit: '20.00' }] });
    expect(ok.statusCode).toBe(200);
    const bad = await post(c, `/api/companies/${f.a.id}/entries`, {
      entryDate: '2026-03-02', lines: [{ accountId: f.a.cash, debit: '20.00' }, { accountId: f.a.sales, credit: '19.00' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/does not balance/);
    const cc = await post(c, `/api/companies/${f.a.id}/entries`, {
      entryDate: '2026-03-02', lines: [{ accountId: f.a.branchCosts, debit: '5.00' }, { accountId: f.a.cash, credit: '5.00' }] });
    expect(cc.json()).toMatchObject({ key: 'err.costCentreRequired' });
  });

  it('view-only users and other companies cannot post through the API', async () => {
    const v = await signIn('viewerA');
    const r = await post(v, `/api/companies/${f.a.id}/entries`, {
      entryDate: '2026-03-02', lines: [{ accountId: f.a.cash, debit: '1.00' }, { accountId: f.a.sales, credit: '1.00' }] });
    expect(r.statusCode).toBe(403);
    const s = await signIn('staff');
    const r2 = await post(s, `/api/companies/${f.b.id}/entries`, {
      entryDate: '2026-03-02', lines: [{ accountId: f.b.cash, debit: '1.00' }, { accountId: f.b.sales, credit: '1.00' }] });
    expect(r2.statusCode).toBe(403);
  });

  it('only the Administrator reaches the admin console, and never the books', async () => {
    const p = await signIn('partner');
    expect((await get(p, '/api/admin/companies')).statusCode).toBe(403);
    const a = await signIn('admin');
    const list = (await get(a, '/api/admin/companies')).json();
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual([f.a.id, f.b.id].sort());
    expect((await get(a, `/api/companies/${f.a.id}/entries`)).statusCode).toBe(404);
  });

  it('the Administrator registers a client with its first user, staff and books in one step', async () => {
    const a = await signIn('admin');
    const res = await post(a, '/api/admin/companies', {
      company: { name: 'API Client', country: 'SA', crNumber: saCr(), legalForm: 'LLC', vatStatus: 'registered', vatNumber: saVat(), address: 'Street', city: 'Riyadh' },
      firstUser: { name: 'First User', email: `first.${Date.now()}@example.com` },
      staffIds: [f.partner],
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id;
    const p = await signIn('partner');
    const books = (await get(p, `/api/companies/${id}`)).json();
    expect(books.role).toBe('partner');
    expect(books.accounts.length).toBeGreaterThan(5);
    expect(books.periods).toHaveLength(12);
    const bad = await post(a, '/api/admin/companies', {
      company: { name: 'Bad', country: 'SA', crNumber: '123', legalForm: 'LLC', vatStatus: 'registered', vatNumber: saVat(), address: 'S', city: 'R' },
      firstUser: { name: 'X', email: `x.${Date.now()}@example.com` } });
    expect(bad.json()).toMatchObject({ key: 'err.saCr' });
  });

  it('only the partner locks periods through the API', async () => {
    await owner.query(`INSERT INTO periods (company_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`, [f.a.id]);
    const c = await signIn('clientA');
    expect((await post(c, `/api/companies/${f.a.id}/periods/2026-09-01/lock`, { locked: true })).statusCode).toBe(403);
    const p = await signIn('partner');
    expect((await post(p, `/api/companies/${f.a.id}/periods/2026-09-01/lock`, { locked: true })).statusCode).toBe(200);
    const r = await post(c, `/api/companies/${f.a.id}/entries`, {
      entryDate: '2026-09-10', lines: [{ accountId: f.a.cash, debit: '1.00' }, { accountId: f.a.sales, credit: '1.00' }] });
    expect(r.json()).toMatchObject({ key: 'err.periodLocked' });
  });
});
