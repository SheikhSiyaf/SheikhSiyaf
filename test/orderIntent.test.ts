// The website's Order button hands a visitor to the software with only a module selection (migration 0092). The selection is kept on the server
// under a secret token, follows the person through sign-up (e-mail link included) or sign-in, and is never a price. The attacks must fail.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { createHash } from 'node:crypto';
import { hashPassword } from '../src/auth/password.js';
import { TERMS_VERSION } from '../src/books/orderIntent.js';

const sha = (v: string) => createHash('sha256').update(v).digest('base64url');
const PEPPER = 'p'.repeat(40);
const PW = 'pw-1234567890';
const GOOD = 'Correct-Horse-9';
let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const cr = () => String(Math.floor(1e9 + Math.random() * 9e9));
let ipn = 40;
const nextIp = () => `10.88.${(ipn >> 8) & 255}.${ipn++ & 255}`;
let server: FastifyInstance; let f: Fixture; let f2: Fixture;

const login = async (userId: string) => {
  const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), userId])).rows[0].email as string;
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW }, headers: { 'x-forwarded-for': nextIp() } });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
};
const intent = (payload: unknown, ip = nextIp()) => server.inject({ method: 'POST', url: '/api/public/order-intent', payload: payload as never, headers: { 'x-forwarded-for': ip } });
const peek = (t: string) => server.inject({ method: 'GET', url: `/api/public/order-intent/${t}`, headers: { 'x-forwarded-for': nextIp() } });
const claim = (cookie: string | undefined, token: unknown) => server.inject({ method: 'POST', url: '/api/pay/intent/claim', headers: cookie ? { cookie } : {}, payload: { token } as never });
const mkToken = async (payload: unknown = { modules: ['HRM', 'CRM'], cleanup: true }) => (await intent(payload)).json().token as string;

beforeAll(async () => {
  f = await seed(); f2 = await seed();
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-intent', trustProxy: 1, publicUrl: 'https://app.example', signup: { enabled: true, pepper: PEPPER } });
});
afterAll(async () => { await server?.close(); });

describe('the hand-over from the website', () => {
  it('keeps only listed modules, once each, and never reads a price, amount, plan, status or user', async () => {
    const r = await intent({ modules: ['HRM', 'HRM', 'CRM', 'Hacking', '<script>', 42, null], cleanup: true, price: 1, amount: '0.01', total: 1, plan: 'free', planId: 'x', discount: 100, status: 'approved', userId: 'someone', role: 'owner', currency: 'USD' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ modules: ['HRM', 'CRM'], cleanup: true });
    expect(Object.keys(r.json()).sort()).toEqual(['cleanup', 'modules', 'token']);
    expect(r.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await owner.query('SELECT modules, cleanup FROM order_intents WHERE token_hash = $1', [sha(r.json().token)])).rows;
    expect(stored).toEqual([{ modules: ['HRM', 'CRM'], cleanup: true }]);
    const p = await peek(r.json().token);
    expect(p.json()).toEqual({ modules: ['HRM', 'CRM'], cleanup: true });
  });

  it('takes a comma list from the address, a missing or odd body, and 500 junk entries, without failing or keeping anything unlisted', async () => {
    expect((await intent({ modules: 'Inventory, Rooms ,Nope' })).json()).toMatchObject({ modules: ['Inventory', 'Rooms'], cleanup: false });
    expect((await intent({})).json()).toMatchObject({ modules: [], cleanup: false });
    expect((await intent(undefined)).statusCode).toBeLessThan(500);
    expect((await intent({ modules: Array.from({ length: 500 }, (_, i) => `m${i}`).concat(['CRM']) })).json().modules).toEqual([]);   // only the first 40 entries are looked at
    expect((await intent({ modules: { $gt: '' }, cleanup: { x: 1 } })).json()).toMatchObject({ modules: [], cleanup: false });
  });

  it('an unknown, malformed, injected or expired token is a plain 404, all alike; the token is never stored as such', async () => {
    const t = await mkToken();
    expect((await peek(t)).statusCode).toBe(200);
    for (const bad of ['x'.repeat(43), 'short', "'; DROP TABLE order_intents;--", t.slice(0, 42) + (t.endsWith('A') ? 'B' : 'A'), '%00', 'a'.repeat(300)]) {
      const r = await peek(encodeURIComponent(bad));
      expect(r.statusCode, bad).toBe(404);
    }
    expect((await owner.query('SELECT count(*)::int AS n FROM order_intents WHERE token_hash = $1', [t])).rows[0].n).toBe(0);   // only its hash is kept
    const dead = await mkToken();
    await owner.query(`UPDATE order_intents SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha(dead)]);
    expect((await peek(dead)).statusCode).toBe(404);
  });

  it('is limited: 20 an hour from one address, then "too many"', async () => {
    const ip = '10.99.1.1';
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await intent({ modules: ['CRM'] }, ip)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
  });

  it('only the server can read or change the tables: the app role has no access, and the terms record cannot be edited by anyone', async () => {
    await expect(appPool.query('SELECT * FROM order_intents')).rejects.toThrow(/permission denied/);
    await expect(appPool.query('SELECT * FROM terms_acceptances')).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`UPDATE order_intents SET claimed_firm_id = NULL`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`INSERT INTO terms_acceptances (firm_id, user_id, version, accepted_at, source) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', now(), 'signup')`)).rejects.toThrow(/permission denied/);
  });
});

describe('claiming it as a signed-in customer', () => {
  it('claims once, a second time says the same, another customer gets the same answer as for a stranger, and staff and strangers cannot claim', async () => {
    const t = await mkToken({ modules: ['Projects'], cleanup: false });
    const a = await login(f.admin), b = await login(f2.admin), ownerCookie = await login(f.platformOwner);
    expect((await claim(undefined, t)).statusCode).toBe(401);
    expect((await claim(ownerCookie, t)).statusCode).toBeGreaterThanOrEqual(400);
    const first = await claim(a, t);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ modules: ['Projects'], cleanup: false, fresh: true });
    expect((await claim(a, t)).json()).toEqual({ modules: ['Projects'], cleanup: false, fresh: false });
    const other = await claim(b, t);
    const stranger = await claim(b, 'x'.repeat(43));
    expect(other.statusCode).toBe(404);
    expect(stranger.statusCode).toBe(404);
    expect(other.json().key).toBe(stranger.json().key);
    for (const bad of [undefined, null, 5, {}, [], "'; --", 'x'.repeat(44)]) expect((await claim(a, bad)).statusCode, JSON.stringify(bad)).toBe(404);
    const mine = await as(f.admin, async (db) => (await db.query('SELECT my_order_intent() AS r')).rows[0].r);
    expect(mine).toEqual({ modules: ['Projects'], cleanup: false });
    expect(await as(f2.admin, async (db) => (await db.query('SELECT my_order_intent() AS r')).rows[0].r)).toBeNull();   // the other customer never sees it
  });
});

describe('through sign-up and the e-mailed link', () => {
  const form = (o: Record<string, unknown> = {}) => { const s = uniq(); return { fullName: 'Test Person', email: `p.${s}@throwaway-test.example.com`, password: GOOD, companyName: `Intent Co ${s}`, country: 'SA', crNumber: cr(), city: 'Riyadh', acceptTerms: true, ...o }; };
  const begin = (body: unknown) => server.inject({ method: 'POST', url: '/api/signup', payload: body as never, headers: { 'x-forwarded-for': nextIp() } });
  const tokenOf = async (to: string) => /\/verify\/([A-Za-z0-9_-]{43})/.exec((await owner.query(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'signup' ORDER BY created_at`, [to])).rows.map((m) => m.body_text).join('\n'))?.[1] ?? '';
  const verify = (token: string) => server.inject({ method: 'POST', url: '/api/signup/verify', payload: { token }, headers: { 'x-forwarded-for': nextIp() } });

  it('the selection and the accepted terms version survive the e-mail link, and show on the new customer\'s buy screen data', async () => {
    const t = await mkToken({ modules: ['HRM', 'Rooms'], cleanup: true });
    const b = form({ intent: t });
    expect((await begin(b)).statusCode).toBe(200);
    const v = await verify(await tokenOf(b.email));
    expect(v.statusCode, v.body).toBe(200);
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;
    const trial = await server.inject({ method: 'GET', url: '/api/trial', headers: { cookie } });
    expect(trial.json().intent).toEqual({ modules: ['Rooms', 'HRM'], cleanup: true });   // in the software's own order
    const firm = (await owner.query('SELECT id FROM firms WHERE name = $1', [b.companyName])).rows[0].id as string;
    const acc = (await owner.query('SELECT version, source FROM terms_acceptances WHERE firm_id = $1', [firm])).rows;
    expect(acc).toEqual([{ version: TERMS_VERSION, source: 'signup' }]);
    // the same browser then signs in and claims it again: fine, and it is no longer "fresh" (a new sign-up does not jump to the buy screen)
    expect((await claim(cookie, t)).json().fresh).toBe(false);
  });

  it('a sign-up with no selection, a junk one, or one already used by someone else still works, and does not steal the selection', async () => {
    const t = await mkToken({ modules: ['CRM'], cleanup: false });
    const a = form({ intent: t }); await begin(a); await verify(await tokenOf(a.email));
    const firstFirm = (await owner.query('SELECT claimed_firm_id FROM order_intents ORDER BY claimed_at DESC NULLS LAST LIMIT 1')).rows[0].claimed_firm_id;
    for (const intentValue of [undefined, 'junk', 'x'.repeat(43), 12345, { a: 1 }, t]) {
      const b = form({ intent: intentValue });
      expect((await begin(b)).statusCode, JSON.stringify(intentValue)).toBe(200);
      const v = await verify(await tokenOf(b.email));
      expect(v.statusCode, JSON.stringify(intentValue)).toBe(200);
      const cookie = String(v.headers['set-cookie']).split(';')[0]!;
      expect((await server.inject({ method: 'GET', url: '/api/trial', headers: { cookie } })).json().intent).toBeNull();
    }
    expect((await owner.query('SELECT claimed_firm_id FROM order_intents WHERE claimed_firm_id IS NOT NULL ORDER BY claimed_at LIMIT 1')).rows.length).toBe(1);
    expect(firstFirm).toBeTruthy();
  });

  it('a person who signs up without ticking the terms is refused, and nothing is recorded', async () => {
    const t = await mkToken();
    const b = form({ intent: t, acceptTerms: false });
    expect((await begin(b)).statusCode).toBe(400);
    expect((await owner.query(`SELECT count(*)::int AS n FROM signup_requests WHERE email = $1`, [b.email])).rows[0].n).toBe(0);
  });

  it('two people confirming with the same selection: the first sign-up gets it, the second does not', async () => {
    const t = await mkToken({ modules: ['Assets'], cleanup: false });
    const a = form({ intent: t }), b = form({ intent: t });
    await begin(a); await begin(b);
    const [va, vb] = await Promise.all([verify(await tokenOf(a.email)), verify(await tokenOf(b.email))]);
    expect(va.statusCode).toBe(200); expect(vb.statusCode).toBe(200);
    const have = await Promise.all([va, vb].map(async (v) => (await server.inject({ method: 'GET', url: '/api/trial', headers: { cookie: String(v.headers['set-cookie']).split(';')[0]! } })).json().intent));
    expect(have.filter(Boolean).length).toBe(1);
  });
});
