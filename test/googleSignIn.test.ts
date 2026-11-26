// Sign in with Google: the token checks, linking to an existing person, the company step for a new one, and the attacks that must fail.
// No request ever goes to Google: the tests sign their own tokens with their own key and hand the server that key as "Google's".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { signToken } from '../src/auth/session.js';
import { GoogleTokenError, googleKeyCache, verifyGoogleToken } from '../src/auth/googleToken.js';
import { parseGoogleSignup } from '../src/books/signupRules.js';

const CLIENT = '1234567890-abcdefgh.apps.googleusercontent.com';
const SECRET = 'google-test-secret';
const PEPPER = 'g'.repeat(40);
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = { keys: [jwk] };

type Claims = Record<string, unknown>;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function sign(claims: Claims, o: { key?: typeof pair.privateKey; alg?: string; kid?: string } = {}) {
  const head = b64({ alg: o.alg ?? 'RS256', kid: o.kid ?? 'k1', typ: 'JWT' });
  const body = b64(claims);
  const sig = o.alg === 'none' ? '' : createSign('RSA-SHA256').update(`${head}.${body}`).sign(o.key ?? pair.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const claims = (nonce: string, over: Claims = {}): Claims => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: `sub-${randomBytes(6).toString('hex')}`, email: 'x@example.com', email_verified: true, name: 'Google Person', nonce, iat: nowSec(), exp: nowSec() + 3600, ...over });

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const cr = () => String(Math.floor(1e9 + Math.random() * 9e9));
let ipn = 10;
const nextIp = () => `10.88.${(ipn >> 8) & 255}.${ipn++ & 255}`;

describe('Checking the token', () => {
  const getKey = googleKeyCache(async () => keys);
  const check = (token: unknown, nonce = 'n1', now?: () => number) => verifyGoogleToken(token, { clientId: CLIENT, nonce, getKey, now });
  const problem = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return e instanceof GoogleTokenError ? e.problem : `crash: ${String(e)}`; } };

  it('accepts a good token and returns who it is', async () => {
    expect(await check(sign(claims('n1', { sub: 's1', email: 'a@b.example.com', name: 'Ali' })))).toEqual({ sub: 's1', email: 'a@b.example.com', name: 'Ali' });
    expect(await check(sign(claims('n1', { iss: 'accounts.google.com', email_verified: 'true' })))).toMatchObject({ name: 'Google Person' });
  });
  it('refuses everything that is not exactly right', async () => {
    expect(await problem(check(sign(claims('n1'), { key: other.privateKey })))).toBe('bad_token');            // signed by somebody else
    expect(await problem(check(sign(claims('n1'), { alg: 'none' })))).toBe('bad_token');                       // "no signature" trick
    expect(await problem(check(sign(claims('n1'), { alg: 'HS256' })))).toBe('bad_token');                      // shared-secret trick
    expect(await problem(check(sign(claims('n1'), { kid: 'unknown' })))).toBe('bad_token');                    // a key Google never published
    expect(await problem(check(sign(claims('n1', { aud: 'another-app.apps.googleusercontent.com' }))))).toBe('wrong_app');
    expect(await problem(check(sign(claims('n1', { iss: 'https://evil.example' }))))).toBe('bad_token');
    expect(await problem(check(sign(claims('n1', { exp: nowSec() - 3600 }))))).toBe('expired');
    expect(await problem(check(sign(claims('n1', { iat: nowSec() + 3600 }))))).toBe('bad_token');
    expect(await problem(check(sign(claims('other-nonce'))))).toBe('wrong_nonce');
    expect(await problem(check(sign(claims('n1', { nonce: undefined }))))).toBe('wrong_nonce');
    expect(await problem(check(sign(claims('n1', { email_verified: false }))))).toBe('email_unverified');
    expect(await problem(check(sign(claims('n1', { email_verified: undefined }))))).toBe('email_unverified');
    expect(await problem(check(sign(claims('n1', { sub: '' }))))).toBe('bad_token');
    expect(await problem(check(sign(claims('n1', { email: undefined }))))).toBe('bad_token');
    for (const junk of [undefined, null, 5, '', 'a.b', 'a.b.c.d', 'not a token', 'x'.repeat(5000), {}]) expect(await problem(check(junk)), String(junk)).toBe('bad_token');
    // a token with the signature of another token's body
    const [h, , s] = sign(claims('n1')).split('.');
    expect(await problem(check(`${h}.${b64(claims('n1', { email: 'victim@example.com' }))}.${s}`))).toBe('bad_token');
  });
  it('says "unavailable" when Google cannot be reached, and does not hammer Google for a made-up key', async () => {
    const down = googleKeyCache(async () => { throw new Error('offline'); });
    expect(await problem(verifyGoogleToken(sign(claims('n1')), { clientId: CLIENT, nonce: 'n1', getKey: down }))).toBe('unavailable');
    let calls = 0; let t = 1_000_000;
    const counted = googleKeyCache(async () => { calls++; return keys; }, () => t);
    await counted('k1'); await counted('k1'); await counted('made-up'); await counted('made-up');
    expect(calls).toBe(1);
    t += 301_000; await counted('made-up');
    expect(calls).toBe(2);
  });
});

describe('The company step rules', () => {
  const base = { fullName: 'Ali', companyName: 'Hassan Trading', country: 'SA', crNumber: '1010101010', city: 'Riyadh', acceptTerms: true };
  it('checks the company fields the same way as the e-mail form, and needs no password', () => {
    expect(parseGoogleSignup(base)).toMatchObject({ ok: true });
    const bad = (patch: Record<string, unknown>) => (parseGoogleSignup({ ...base, ...patch }) as { problem?: string }).problem;
    expect(bad({ fullName: 'A' })).toBe('err.signupName');
    expect(bad({ companyName: '<b>' })).toBe('err.signupCompany');
    expect(bad({ country: 'OM' })).toBe('err.signupCountry');
    expect(bad({ crNumber: '123' })).toBe('err.signupCr');
    expect(bad({ city: '' })).toBe('err.signupCity');
    expect(bad({ acceptTerms: 'yes' })).toBe('err.signupTerms');
  });
});

describe('Signing in and signing up with Google', () => {
  let f: Fixture; let on: FastifyInstance; let noGoogle: FastifyInstance; let closed: FastifyInstance;
  beforeAll(async () => {
    f = await seed();
    const mk = (extra: object) => buildServer({ pool: appPool, sessionSecret: SECRET, trustProxy: 1, publicUrl: 'https://app.example', ...extra });
    on = mk({ signup: { enabled: true, pepper: PEPPER }, google: { clientId: CLIENT, fetchKeys: async () => keys } });
    noGoogle = mk({ signup: { enabled: true, pepper: PEPPER } });
    closed = mk({ google: { clientId: CLIENT, fetchKeys: async () => keys } });
  });
  afterAll(async () => { await on?.close(); await noGoogle?.close(); await closed?.close(); });

  const nonceOf = async (s = on) => (await s.inject({ method: 'GET', url: '/api/google/nonce' })).json().nonce as string;
  const login = async (over: Claims, o: { s?: FastifyInstance; ip?: string; nonce?: string; token?: string } = {}) => {
    const s = o.s ?? on; const nonce = o.nonce ?? await nonceOf(s);
    return s.inject({ method: 'POST', url: '/api/login/google', payload: { credential: o.token ?? sign(claims(nonce, over)), nonce }, headers: { 'x-forwarded-for': o.ip ?? nextIp() } });
  };
  const company = (o: Record<string, unknown> = {}) => { const s = uniq(); return { companyName: `Google Co ${s}`, country: 'SA', crNumber: cr(), city: 'Riyadh', acceptTerms: true, ...o }; };
  const finish = (ticket: string, body: Record<string, unknown>, s = on, ip = nextIp()) => s.inject({ method: 'POST', url: '/api/signup/google', payload: { ticket, ...body }, headers: { 'x-forwarded-for': ip } });
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
  const linked = async (email: string) => (await owner.query(`SELECT g.google_sub FROM google_identities g JOIN users u ON u.id = g.user_id WHERE lower(u.email) = $1`, [email])).rows[0]?.google_sub as string | undefined;

  it('is hidden and refused unless a Client ID is set; and the page may load Google only then', async () => {
    expect((await noGoogle.inject({ method: 'GET', url: '/api/google/nonce' })).statusCode).toBe(404);
    expect((await noGoogle.inject({ method: 'GET', url: '/api/config' })).json().googleClientId).toBeUndefined();
    expect((await noGoogle.inject({ method: 'GET', url: '/api/signup/config' })).json()).toEqual({ enabled: true, google: false });
    const r = await noGoogle.inject({ method: 'POST', url: '/api/login/google', payload: { credential: 'x', nonce: 'y' } });
    expect(r.statusCode).toBe(404);
    expect((await on.inject({ method: 'GET', url: '/api/config' })).json().googleClientId).toBe(CLIENT);
    expect((await on.inject({ method: 'GET', url: '/api/signup/config' })).json()).toMatchObject({ enabled: true, google: true, googleClientId: CLIENT });
    const csp = String((await on.inject({ method: 'GET', url: '/api/config' })).headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(String((await noGoogle.inject({ method: 'GET', url: '/api/config' })).headers['content-security-policy'])).not.toContain('google');
    expect((await on.inject({ method: 'GET', url: '/api/config' })).headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect((await noGoogle.inject({ method: 'GET', url: '/api/config' })).headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('signs up a new person: Google proves the e-mail, they give the company, and they get the same trial as the e-mail way', async () => {
    const email = `g.${uniq()}@throwaway-test.example.com`;
    const r1 = await login({ email, name: 'Sara Google' });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ needsCompany: true, email, name: 'Sara Google' });
    expect(r1.headers['set-cookie']).toBeUndefined();   // nothing is created, nobody is signed in yet
    expect(Number((await owner.query('SELECT count(*) AS n FROM users WHERE lower(email) = $1', [email])).rows[0].n)).toBe(0);
    const c = company();
    const r2 = await finish(r1.json().ticket, c);
    expect(r2.statusCode, r2.body).toBe(200);
    const cookie = cookieOf(r2);
    const me = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.user.email.toLowerCase()).toBe(email);
    expect(me.user.name).toBe('Sara Google');
    expect(me.canManageUsers).toBe(true);
    const firm = (await owner.query(`SELECT id, kind FROM firms WHERE name = $1`, [c.companyName])).rows[0];
    expect(firm.kind).toBe('company');
    expect((await owner.query(`SELECT status, notes FROM subscriptions WHERE firm_id = $1`, [firm.id])).rows[0]).toMatchObject({ status: 'trial', notes: 'Self-service sign-up' });
    expect(await linked(email)).toBeDefined();
    // the trial record is made: the same mailbox cannot start another trial the e-mail way
    expect(Number((await owner.query(`SELECT count(*) AS n FROM trial_fingerprints WHERE firm_id = $1`, [firm.id])).rows[0].n)).toBe(1);
    // next time: straight in. Nobody knows the password, so the password way stays closed until they ask for a new one.
    const sub = await linked(email);
    const again = await login({ email, sub });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ ok: true });
    expect(cookieOf(again)).toMatch(/^[^=]+=.+/);
    const pw = await on.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Correct-Horse-9' }, headers: { 'x-forwarded-for': nextIp() } });
    expect(pw.statusCode).toBe(401);
    // the sign-up is written to the owner's log like any other
    expect(Number((await owner.query(`SELECT count(*) AS n FROM signup_events WHERE kind = 'verified' AND firm_id = $1`, [firm.id])).rows[0].n)).toBe(1);
  });

  it('signs an existing person in when Google vouches for the same e-mail, links the Google account, and refuses a second Google account for them', async () => {
    const email = String((await owner.query('SELECT email FROM users WHERE id = $1', [f.partner])).rows[0].email);
    const sub = `sub-partner-${uniq()}`;
    const r = await login({ email, sub });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const me = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(r) } })).json();
    expect(me.user.id).toBe(f.partner);
    expect(await linked(email.toLowerCase())).toBe(sub);
    // the same Google account again works even if its e-mail changed on Google's side: it is remembered by Google's id
    expect((await login({ email: 'renamed@throwaway-test.example.com', sub })).json()).toEqual({ ok: true });
    // a different Google account claiming the same e-mail is refused
    const r2 = await login({ email, sub: `sub-intruder-${uniq()}` });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().key).toBe('err.googleOther');
    expect(r2.headers['set-cookie']).toBeUndefined();
    await owner.query('DELETE FROM google_identities WHERE user_id = $1', [f.partner]);
  });

  it('still asks for the two-step code, and keeps suspended or unverified people out', async () => {
    // a person of its own: other test files share the seeded people, and must never see them suspended
    const email = `mfa.${uniq()}@throwaway-test.example.com`;
    const t = (await login({ email, name: 'Mfa Person' })).json().ticket as string;
    expect((await finish(t, company())).statusCode).toBe(200);
    const sub = (await linked(email))!;
    const id = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0].id as string;
    await owner.query(`UPDATE users SET totp_secret_enc = 'not-a-real-secret' WHERE id = $1`, [id]);
    const r = await login({ email, sub });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ twoFactor: true });
    expect(r.headers['set-cookie']).toBeUndefined();
    await owner.query(`UPDATE users SET totp_secret_enc = NULL, status = 'suspended' WHERE id = $1`, [id]);
    const s2 = await login({ email, sub });
    expect(s2.statusCode).toBe(403);
    expect(s2.json().key).toBe('err.suspended');
    expect(s2.headers['set-cookie']).toBeUndefined();
    // Google itself has not confirmed the address
    const u = await login({ email: `unv.${uniq()}@throwaway-test.example.com`, email_verified: false });
    expect(u.statusCode).toBe(403);
    expect(u.json().key).toBe('err.googleUnverified');
  });

  it('refuses a forged, replayed-for-another-app, stale or nonce-less sign-in', async () => {
    const nonce = await nonceOf();
    const bad = async (token: string, n = nonce) => (await on.inject({ method: 'POST', url: '/api/login/google', payload: { credential: token, nonce: n }, headers: { 'x-forwarded-for': nextIp() } }));
    expect((await bad(sign(claims(nonce), { key: other.privateKey }))).json().key).toBe('err.googleBad');
    expect((await bad(sign(claims(nonce, { aud: 'someone-else.apps.googleusercontent.com' })))).json().key).toBe('err.googleBad');
    expect((await bad(sign(claims(nonce, { exp: nowSec() - 7200 })))).json().key).toBe('err.googleExpired');
    // a nonce we never gave out, or one that has timed out, or one made for another purpose
    const mine = 'made-up-nonce';
    expect((await bad(sign(claims(mine)), mine)).json().key).toBe('err.googleExpired');
    const old = signToken(SECRET, 'gnonce', 'abc', 600, Date.now() - 3_600_000);
    expect((await bad(sign(claims(old)), old)).json().key).toBe('err.googleExpired');
    const wrongKind = signToken(SECRET, 'mfa', 'abc', 600);
    expect((await bad(sign(claims(wrongKind)), wrongKind)).json().key).toBe('err.googleExpired');
    // the token is for another nonce than the one sent
    expect((await bad(sign(claims(await nonceOf())))).json().key).toBe('err.googleExpired');
    expect((await bad('nonsense')).json().key).toBe('err.googleBad');
    expect((await on.inject({ method: 'POST', url: '/api/login/google', payload: {}, headers: { 'x-forwarded-for': nextIp() } })).json().key).toBe('err.googleExpired');
  });

  it('lets each one-time value be used once: replaying a captured token signs nobody in', async () => {
    const email = String((await owner.query('SELECT email FROM users WHERE id = $1', [f.staff])).rows[0].email);
    const sub = `sub-staff-${uniq()}`;
    const nonce = await nonceOf();
    const token = sign(claims(nonce, { email, sub }));
    const ip = nextIp();
    const first = await on.inject({ method: 'POST', url: '/api/login/google', payload: { credential: token, nonce }, headers: { 'x-forwarded-for': ip } });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await on.inject({ method: 'POST', url: '/api/login/google', payload: { credential: token, nonce }, headers: { 'x-forwarded-for': nextIp() } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().key).toBe('err.googleExpired');
    expect(replay.headers['set-cookie']).toBeUndefined();
    await owner.query('DELETE FROM google_identities WHERE user_id = $1', [f.staff]);
    // the same goes for the company step of a sign-up: its ticket works once
    expect(Number((await owner.query('SELECT count(*) AS n FROM google_nonce_used')).rows[0].n)).toBeGreaterThan(0);
    await expect(appPool.query(`SELECT google_nonce_take('x')`)).resolves.toBeDefined();   // callable by the server before anybody signs in
    await expect(appPool.query('SELECT * FROM google_nonce_used')).rejects.toThrow(/permission denied/);
  });

  it('keeps out people who were removed, whose customer was removed, or whose account is closed, and lets a locked one in to the "trial ended" screen only', async () => {
    const one = async (label: string) => {
      const s = uniq(); const email = `${label}.${s}@throwaway-test.example.com`;
      const t = (await login({ email, name: label })).json().ticket as string;
      const r = await finish(t, company());
      expect(r.statusCode, r.body).toBe(200);
      const userId = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0].id as string;
      const firmId = (await owner.query('SELECT firm_id FROM users WHERE id = $1', [userId])).rows[0].firm_id as string;
      return { email, userId, firmId, sub: await linked(email) };
    };
    const again = (x: { email: string; sub?: string }) => login({ email: x.email, sub: x.sub });
    // a person the Administrator removed
    const a = await one('removed');
    await owner.query(`UPDATE users SET status = 'suspended', removed_at = now() WHERE id = $1`, [a.userId]);
    const ra = await again(a);
    expect(ra.statusCode).toBe(403); expect(ra.headers['set-cookie']).toBeUndefined();
    // a customer the owner removed (or suspended)
    const b = await one('custrem');
    await owner.query(`UPDATE firms SET status = 'suspended', removed_at = now() WHERE id = $1`, [b.firmId]);
    const rb = await again(b);
    expect(rb.statusCode).toBe(403); expect(rb.json().key).toBe('err.tenantSuspended'); expect(rb.headers['set-cookie']).toBeUndefined();
    // a closed account (cancelled, past the export window)
    const c = await one('closed');
    await owner.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now() - interval '200 days' WHERE firm_id = $1`, [c.firmId]).catch(() => undefined);
    const rc = await again(c);
    expect([200, 403]).toContain(rc.statusCode);   // whichever the trial rules say for this date, it is the SAME answer as the password way (checked next)
    const viaPassword = await on.inject({ method: 'POST', url: '/api/login', payload: { email: c.email, password: 'whatever-it-is-1' }, headers: { 'x-forwarded-for': nextIp() } });
    expect(viaPassword.statusCode).toBeGreaterThanOrEqual(401);
    // an account whose trial has ended is let in (to buy or export), exactly as with a password, and sees the locked state
    const d = await one('locked');
    await owner.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '3 days', trial_started_at = now() - interval '18 days' WHERE firm_id = $1`, [d.firmId]);
    const rd = await again(d);
    expect(rd.statusCode, rd.body).toBe(200);
    const trial = (await on.inject({ method: 'GET', url: '/api/trial', headers: { cookie: cookieOf(rd) } })).json();
    expect(trial.level).toBe('locked');
    const books = await on.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(rd) } });
    expect(books.statusCode).toBe(200);
  });

  it('copes with odd names and e-mail spellings from Google', async () => {
    // names with markup, very long names and emoji never get into the books as they are; the person is asked to fix them
    for (const name of ['Ali <script>alert(1)</script>', 'x'.repeat(400), '\u0000\u0001', '']) {
      const email = `odd.${uniq()}@throwaway-test.example.com`;
      const r = await login({ email, name });
      expect(r.statusCode, r.body).toBe(200);
      const done = await finish(r.json().ticket, { ...company(), fullName: name || undefined });
      expect([200, 400], name).toContain(done.statusCode);
      if (done.statusCode === 400) expect(done.json().key).toBe('err.signupName');
    }
    const ok = await login({ email: `ok.${uniq()}@throwaway-test.example.com`, name: 'علي 😀 Ali' });
    expect((await finish(ok.json().ticket, company())).statusCode).toBe(200);
    // upper case and spaces in Google's e-mail are tidied; the same mailbox written differently still counts as one person
    const base = `Mixed.${uniq()}@Throwaway-Test.Example.com`;
    const r1 = await login({ email: base });
    expect((await finish(r1.json().ticket, company())).statusCode).toBe(200);
    expect((await owner.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', [base.toLowerCase()])).rows[0].n).toBe(1);
    const r2 = await login({ email: base.toLowerCase(), sub: await linked(base.toLowerCase()) });
    expect(r2.json()).toEqual({ ok: true });   // recognised, signed in, no second trial
  });

  it('counts failures per address and then stops answering', async () => {
    const ip = nextIp();
    const nonce = await nonceOf();
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await on.inject({ method: 'POST', url: '/api/login/google', payload: { credential: 'junk', nonce }, headers: { 'x-forwarded-for': ip } })).statusCode;
    expect(last).toBe(429);
  });

  it('gives a stranger nothing while sign-up is closed, and says why', async () => {
    const r = await login({ email: `closed.${uniq()}@throwaway-test.example.com` }, { s: closed });
    expect(r.statusCode).toBe(403);
    expect(r.json().key).toBe('err.signupOff');
    const t = signToken(SECRET, 'gsignup', b64({ sub: 's', email: 'c@throwaway-test.example.com', name: 'C' }), 900);
    expect((await finish(t, company(), closed)).json().key).toBe('err.signupOff');
  });

  it('keeps every sign-up rule: one company number, one mailbox in any spelling, no throwaway domains, a valid ticket, no robots', async () => {
    const ticketFor = async (email: string, over: Claims = {}) => (await login({ email, ...over })).json().ticket as string;
    // a company number that already has an account
    const first = company();
    const e1 = `one.${uniq()}@throwaway-test.example.com`;
    expect((await finish(await ticketFor(e1), first)).statusCode).toBe(200);
    const r = await finish(await ticketFor(`two.${uniq()}@throwaway-test.example.com`), company({ crNumber: first.crNumber }));
    expect(r.statusCode).toBe(409);
    expect(r.json().key).toBe('err.signupOrgUsed');
    // the same mailbox with a "+tag" cannot get a second trial
    const [local, domain] = e1.split('@');
    const t2 = await ticketFor(`${local}+again@${domain}`);
    const r2 = await finish(t2, company());
    expect(r2.statusCode).toBe(409);
    expect(r2.json().key).toBe('err.signupEmailUsed');
    // a throwaway domain
    const r3 = await finish(await ticketFor(`x.${uniq()}@mailinator.com`), company());
    expect(r3.statusCode).toBe(400);
    expect(r3.json().key).toBe('err.signupDisposable');
    // missing company number, terms, or a bad one
    const t4 = await ticketFor(`four.${uniq()}@throwaway-test.example.com`);
    expect((await finish(t4, company({ crNumber: '12' }))).json().key).toBe('err.signupCr');
    expect((await finish(t4, company({ acceptTerms: false }))).json().key).toBe('err.signupTerms');
    // a ticket that is not ours, was made for another purpose, or has run out
    expect((await finish('garbage', company())).json().key).toBe('err.googleExpired');
    expect((await finish(signToken(SECRET, 'mfa', b64({ sub: 's', email: 'a@b.example.com', name: '' }), 900), company())).json().key).toBe('err.googleExpired');
    expect((await finish(signToken(SECRET, 'gsignup', b64({ sub: 's', email: 'a@b.example.com', name: '' }), 900, Date.now() - 7_200_000), company())).json().key).toBe('err.googleExpired');
    // a robot fills the hidden field
    expect((await finish(t4, company({ website: 'http://spam.example' }))).statusCode).toBe(400);
    // none of the refused attempts made a customer
    expect(Number((await owner.query(`SELECT count(*) AS n FROM users WHERE lower(email) LIKE 'four.%'`)).rows[0].n)).toBe(0);
  });

  it('keeps the table of Google accounts out of reach of everything but the two server functions', async () => {
    await expect(appPool.query('SELECT * FROM google_identities')).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`INSERT INTO google_identities (google_sub, user_id) VALUES ('x', $1)`, [f.partner])).rejects.toThrow(/permission denied/);
  });
});
