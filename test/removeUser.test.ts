// Removing a person (an Administrator removes their own people; Nusuh Books can also remove an Administrator): they cannot sign
// in and disappear from the lists, their name stays on everything they did, and they can be restored. Nobody can remove
// themselves, another customer's people, or the last Administrator.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-123456';
let f: Fixture;
let server: FastifyInstance;
let platformEmail = '', otherAdminEmail = '';
let customerId = '', companyId = '';
const email: Record<string, string> = {};
const id: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword(PW);
  platformEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, f.platformOwner])).rows[0].email;
  otherAdminEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, f.admin])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
  const s = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: await signIn(platformEmail) }, payload: {
    company: { name: `Removable People ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh' },
    users: [
      { name: 'Admin A', email: `a.${s}@people.example.com`, jobTitle: 'Administrator' },
      { name: 'Admin B', email: `b.${s}@people.example.com`, jobTitle: 'Administrator' },
      { name: 'The Owner', email: `o.${s}@people.example.com`, jobTitle: 'Owner' },
      { name: 'The Seller', email: `s.${s}@people.example.com`, jobTitle: 'Sales' }] } });
  expect(res.statusCode, res.body).toBe(200);
  customerId = res.json().id; companyId = res.json().companyId;
  for (const [k, e] of [['adminA', `a.${s}`], ['adminB', `b.${s}`], ['owner', `o.${s}`], ['seller', `s.${s}`]] as const) {
    email[k] = `${e}@people.example.com`;
    id[k] = (await owner.query(`UPDATE users SET password_hash = $1 WHERE lower(email) = lower($2) RETURNING id`, [hash, email[k]])).rows[0].id;
  }
});
afterAll(async () => { await server?.close(); });

const login = (e: string) => server.inject({ method: 'POST', url: '/api/login', payload: { email: e, password: PW } });
async function signIn(e: string): Promise<string> {
  const res = await login(e);
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const remove = (cookie: string, userId: string, removed: boolean, extra: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url: `/api/admin/users/${userId}/remove`, headers: { cookie, ...extra }, payload: { removed } });
const users = async (cookie: string) => (await server.inject({ method: 'GET', url: `/api/admin/companies/${companyId}`, headers: { cookie } })).json().users as { id: string; removed: boolean; status: string }[];

describe('Remove a person', () => {
  it('the Administrator removes a person: they cannot sign in, they are marked removed, and their name stays', async () => {
    const a = await signIn(email.adminA!);
    const res = await remove(a, id.seller!, true);
    expect(res.statusCode, res.body).toBe(200);
    expect((await login(email.seller!)).statusCode).toBe(403);
    const row = (await users(a)).find((u) => u.id === id.seller)!;
    expect(row).toMatchObject({ removed: true, status: 'suspended' });
    const kept = (await owner.query('SELECT full_name, removed_at IS NOT NULL AS removed FROM users WHERE id = $1', [id.seller])).rows[0];   // never deleted
    expect(kept).toEqual({ full_name: 'The Seller', removed: true });
  });

  it('restores them: they can sign in again', async () => {
    const a = await signIn(email.adminA!);
    expect((await remove(a, id.seller!, false)).statusCode).toBe(200);
    expect((await users(a)).find((u) => u.id === id.seller)).toMatchObject({ removed: false, status: 'active' });
    expect((await login(email.seller!)).statusCode).toBe(200);
  });

  it('never lets anyone remove themselves, an Administrator (unless Nusuh Books), another customer\'s person, or the last Administrator', async () => {
    const a = await signIn(email.adminA!);
    expect((await remove(a, id.adminA!, true)).json()).toMatchObject({ key: 'err.selfRemove' });
    expect((await remove(a, id.adminB!, true)).statusCode).toBeGreaterThanOrEqual(400);   // only Nusuh Books removes an Administrator
    expect((await owner.query('SELECT removed_at FROM users WHERE id = $1', [id.adminB])).rows[0].removed_at).toBeNull();
    // another customer's Administrator cannot reach this customer's people
    const other = await signIn(otherAdminEmail);
    expect((await remove(other, id.owner!, true)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await owner.query('SELECT removed_at FROM users WHERE id = $1', [id.owner])).rows[0].removed_at).toBeNull();
  });

  it('Nusuh Books can remove an Administrator but never the last one', async () => {
    const p = await signIn(platformEmail);
    const acting = { 'x-acting-tenant': customerId };
    expect((await remove(p, id.adminB!, true, acting)).statusCode).toBe(200);
    expect((await login(email.adminB!)).statusCode).toBe(403);
    expect((await remove(p, id.adminA!, true, acting)).statusCode).toBeGreaterThanOrEqual(400);   // the last Administrator stays
    expect((await owner.query('SELECT removed_at FROM users WHERE id = $1', [id.adminA])).rows[0].removed_at).toBeNull();
    expect((await remove(p, id.adminB!, false, acting)).statusCode).toBe(200);
    expect((await login(email.adminB!)).statusCode).toBe(200);
  });

  it('a removed person\'s unused sign-in link stops working', async () => {
    await owner.query(`UPDATE users SET invite_token_hash = 'x', invite_expires_at = now() + interval '3 days' WHERE id = $1`, [id.seller]);
    const a = await signIn(email.adminA!);
    expect((await remove(a, id.seller!, true)).statusCode).toBe(200);
    expect((await owner.query('SELECT invite_token_hash, invite_expires_at FROM users WHERE id = $1', [id.seller])).rows[0]).toEqual({ invite_token_hash: null, invite_expires_at: null });
  });
});
