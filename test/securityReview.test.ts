// Security review, step 2: each fix is tested here through the API (and in config.test.ts for TRUST_PROXY).
//  1 the role check matches the route actually reached (capitals or %-encoded letters in the address change nothing);
//  2 signing out, a new password and a new two-factor secret end older sign-ins (db/migrations/0053);
//  3 replacing an authenticator in use needs a code from it;  10 a two-factor code works once;
//  4 the test checkout is refused on the live site;  9 CSV cells never run as formulas;
// 11 password resets are limited per sender's address.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { base32Decode, totpCode } from '../src/auth/totp.js';
import { encryptSecret } from '../src/auth/secretBox.js';
import { DEV_ENCRYPTION_KEY } from '../src/config.js';
import { csvCell } from '../src/books/toolsService.js';
import { configurePayments, saveSettings } from '../src/books/onlinePayService.js';
import { as } from './helpers.js';

let f: Fixture;
let server: FastifyInstance;
const emails: Record<string, string> = {};
const PW = 'pw-123456';

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword(PW);
  for (const [k, id] of Object.entries({ admin: f.admin, partner: f.partner, reviewer: f.reviewer, clientA: f.a.clientAccountant })) {
    emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-for-the-security-review' });
});
afterAll(async () => { await server.close(); configurePayments({ production: false }); });

const login = async (who: string, password = PW) => {
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password } });
  return { r, cookie: String(r.headers['set-cookie'] ?? '').split(';')[0]! };
};
const signIn = async (who: string) => { const { r, cookie } = await login(who); expect(r.statusCode).toBe(200); return cookie; };
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object = {}) => server.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('1. A client role cannot be stepped around by how the address is written', () => {
  it('capitals and %-encoded letters meet the same rule as the plain address', async () => {
    const a = await signIn('admin');
    const role = (await post(a, '/api/admin/roles', { name: 'Sales viewer', permissions: { Sales: 'view' } })).json().id;
    expect((await post(a, `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, { clientRoleId: role })).statusCode).toBe(200);
    const c = await signIn('clientA');
    const up = f.a.id.toUpperCase();
    for (const url of [`/api/companies/${f.a.id}/hr/employees`, `/api/companies/${up}/hr/employees`, `/api/companies/${f.a.id}/h%72/employees`,
      `/api/companies/${up}/payroll`, `/api/companies/${up}/entries`, `/api/companies/${up}/reports/balance-sheet`, `/api/companies/%${f.a.id.charCodeAt(0).toString(16)}${f.a.id.slice(1)}/payroll`]) {
      expect((await get(c, url)).statusCode, url).toBe(403);
    }
    expect((await get(c, `/api/companies/${up}/overview`)).statusCode).toBe(200);   // what the role allows still works
  });
});

describe('2. Older sign-ins end', () => {
  it('signing out ends the cookie everywhere; signing in again works', async () => {
    const p1 = await signIn('reviewer');
    const p2 = await signIn('reviewer');   // a second device
    expect((await post(p1, '/api/logout')).statusCode).toBe(200);
    expect((await get(p1, '/api/me')).statusCode).toBe(401);
    expect((await get(p2, '/api/me')).statusCode).toBe(401);
    expect((await get(await signIn('reviewer'), '/api/me')).statusCode).toBe(200);
  });

  it('a new password (reset, invitation or set by anyone) ends older sign-ins', async () => {
    const p = await signIn('partner');
    await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword('another-pw-123'), f.partner]);
    expect((await get(p, '/api/me')).statusCode).toBe(401);
    await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), f.partner]);
  });

  it('the version only goes up: an old cookie cannot be brought back', async () => {
    const p = await signIn('partner');
    const v = (await owner.query('SELECT session_version FROM users WHERE id = $1', [f.partner])).rows[0].session_version;
    await as(f.partner, (db) => db.query('UPDATE users SET session_version = 1 WHERE id = app_user_id()')).catch(() => undefined);
    expect((await owner.query('SELECT session_version FROM users WHERE id = $1', [f.partner])).rows[0].session_version).toBe(v);
    expect((await get(p, '/api/me')).statusCode).toBe(200);
  });
});

describe('3 and 10. Two-factor', () => {
  const now = () => Math.floor(Date.now() / 1000);
  it('a code is accepted once; replacing the authenticator needs a code from it', async () => {
    // Turn two-factor on for the partner with a known secret.
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await owner.query('UPDATE users SET totp_secret_enc = $1, totp_enabled_at = now() WHERE id = $2', [encryptSecret(DEV_ENCRYPTION_KEY, secret), f.partner]);
    const first = await login('partner');
    const code = totpCode(base32Decode(secret), now());
    const ok = await server.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: first.r.json().ticket, code } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    // 10: the same code again is refused, even with a fresh ticket.
    const again = await login('partner');
    expect((await server.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: again.r.json().ticket, code } })).json()).toMatchObject({ key: 'err.code' });
    // 3: a session alone cannot swap the authenticator.
    const start = (await post(cookie, '/api/me/two-factor/start')).json();
    const newCode = totpCode(base32Decode(start.secret), now());
    expect((await post(cookie, '/api/me/two-factor/confirm', { ticket: start.ticket, code: newCode })).json()).toMatchObject({ key: 'err.currentCode' });
    expect((await post(cookie, '/api/me/two-factor/confirm', { ticket: start.ticket, code: newCode, currentCode: code })).json()).toMatchObject({ key: 'err.currentCode' });   // used already
    const enc = (await owner.query('SELECT totp_secret_enc FROM users WHERE id = $1', [f.partner])).rows[0].totp_secret_enc;
    const before = enc;
    // With a fresh code from the current authenticator (next step), the swap goes through and gives this browser a new cookie.
    const next = totpCode(base32Decode(secret), now() + 30);
    const swap = await post(cookie, '/api/me/two-factor/confirm', { ticket: start.ticket, code: newCode, currentCode: next });
    expect(swap.statusCode).toBe(200);
    expect((await owner.query('SELECT totp_secret_enc FROM users WHERE id = $1', [f.partner])).rows[0].totp_secret_enc).not.toBe(before);
    expect((await get(cookie, '/api/me')).statusCode).toBe(401);   // the old cookie ended with the old secret
    expect((await get(String(swap.headers['set-cookie']).split(';')[0]!, '/api/me')).statusCode).toBe(200);
    await owner.query('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1', [f.partner]);
  });
});

describe('4. The test checkout on the live site', () => {
  it('cannot be switched on, and its pages are gone', async () => {
    const bank = (await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1 RETURNING id`, [f.a.cash])).rows[0].id;
    configurePayments({ production: true });
    await expect(as(f.partner, (db) => saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', secretKey: 'anything', depositAccountId: bank })))
      .rejects.toThrow(/live site/);
    configurePayments({ production: false });
    await as(f.partner, (db) => saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', secretKey: 'anything', depositAccountId: bank }));   // fine off the live site
    const live = buildServer({ pool: appPool, sessionSecret: 'test-secret-for-the-security-review', encryptionKey: DEV_ENCRYPTION_KEY, production: true, publicUrl: 'https://books.example.com' });
    expect((await live.inject({ method: 'GET', url: '/api/public/payments/sandbox/abc' })).statusCode).toBe(404);
    expect((await live.inject({ method: 'POST', url: '/api/public/payments/sandbox/abc', payload: { outcome: 'paid' } })).statusCode).toBe(404);
    await live.close();
    configurePayments({ production: false });
  });
});

describe('9. CSV cells', () => {
  it('formula-like text is kept as text; amounts stay numbers', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+966 50')).toBe(`'+966 50`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('-cmd')).toBe(`'-cmd`);
    expect(csvCell('-125.50')).toBe('-125.50');
    expect(csvCell('Gulf Steel')).toBe('Gulf Steel');
  });
});

describe('11. Password resets', () => {
  it('are limited per sender\'s address, whatever email is asked for', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await server.inject({ method: 'POST', url: '/api/password-reset', remoteAddress: '203.0.113.9', payload: { email: `nobody${i}@example.com` } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
