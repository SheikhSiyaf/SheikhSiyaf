// Sign-in throttling in the database (db/migrations/0040): per account (normalised email), per IP address and per
// person for two-factor codes. Counts survive restarts and are shared by every server instance; unknown emails are
// treated exactly like known ones; locking an account is written to the audit log.
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { encryptSecret } from '../src/auth/secretBox.js';
import { base32Decode, newTotpSecret, totpCode } from '../src/auth/totp.js';
import { Throttle, LOGIN_LIMITS, purgeAttempts } from '../src/auth/throttle.js';

const PW = 'pw-123456-right';
const SECRET = 'throttle-test-secret';
let f: Fixture;
const email: Record<string, string> = {};
let n = 0;
/** Each test signs in from its own address, so the per-IP count of one test never reaches another. */
const ipFor = () => `10.77.${Math.floor(++n / 250)}.${n % 250 + 1}`;
const server = (o: { trustProxy?: boolean } = {}): FastifyInstance => buildServer({ pool: appPool, sessionSecret: SECRET, ...o });
const login = (s: FastifyInstance, e: string, password: string, ip: string, headers: Record<string, string> = {}) =>
  s.inject({ method: 'POST', url: '/api/login', payload: { email: e, password }, remoteAddress: ip, headers });

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword(PW);
  for (const [k, id] of Object.entries({ a: f.staff, b: f.reviewer, c: f.partner, d: f.a.clientAccountant, e: f.a.clientViewer, mfa: f.b.clientAccountant })) {
    email[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
});

describe('Per account', () => {
  it('five wrong passwords lock the sixth attempt, even with the right password; the lock is audited without password data', async () => {
    const s = server(); const ip = ipFor();
    for (let i = 0; i < 5; i++) expect((await login(s, email.a!, 'wrong', ip)).statusCode).toBe(401);
    const r = await login(s, `  ${email.a!.toUpperCase()} `, PW, ip);   // the same account, however it is typed
    expect(r.statusCode).toBe(429);
    expect(r.json().key).toBe('err.tooMany');
    const audit = (await owner.query(`SELECT action, row_id, detail FROM audit_log WHERE action = 'lockout' AND row_id = $1`, [email.a])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ kind: 'account', attempts: 5 });
    expect(JSON.stringify(audit)).not.toMatch(/password|wrong|pw-/);
    await s.close();
  });

  it('the count survives a new server instance (and is shared by several)', async () => {
    const one = server(), two = server(); const ip = ipFor();
    for (let i = 0; i < 3; i++) await login(one, email.b!, 'wrong', ip);
    for (let i = 0; i < 2; i++) await login(two, email.b!, 'wrong', ip);
    await one.close(); await two.close();
    const three = server();
    expect((await login(three, email.b!, PW, ip)).statusCode).toBe(429);
    await three.close();
  });

  it('a lock ends after 15 minutes', async () => {
    let now = new Date('2030-01-01T10:00:00Z');
    const t = new Throttle(appPool, { ...LOGIN_LIMITS.account, now: () => now });
    const key = `clock-${randomUUID()}@example.com`;
    for (let i = 0; i < 5; i++) await t.fail(key);
    await expect(t.check(key)).rejects.toMatchObject({ status: 429 });
    now = new Date('2030-01-01T10:14:59Z');
    await expect(t.check(key)).rejects.toMatchObject({ status: 429 });
    now = new Date('2030-01-01T10:15:01Z');
    await expect(t.check(key)).resolves.toBeUndefined();
    // A new Throttle (a restarted server) sees the same count.
    const again = new Throttle(appPool, { ...LOGIN_LIMITS.account, now: () => new Date('2030-01-01T10:05:00Z') });
    await expect(again.check(key)).rejects.toMatchObject({ status: 429 });
  });

  it('a successful sign-in clears the account count but not the IP count', async () => {
    const s = server(); const ip = ipFor();
    for (let i = 0; i < 4; i++) await login(s, email.c!, 'wrong', ip);
    expect((await login(s, email.c!, PW, ip)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await login(s, email.c!, 'wrong', ip);
    expect((await login(s, email.c!, PW, ip)).statusCode).toBe(200);   // 4 + 4 failures, but cleared in between
    const ipCount = (await owner.query(`SELECT count(*)::int AS n FROM auth_attempts WHERE kind = 'ip' AND key = $1`, [ip])).rows[0].n;
    expect(ipCount).toBe(8);
    await s.close();
  });
});

describe('Unknown emails', () => {
  it('are counted like known ones, with the same answer and a similar response time', async () => {
    const s = server(); const ip = ipFor();
    const unknown = `nobody-${randomUUID()}@example.com`;
    const known = await login(s, email.d!, 'wrong', ip);
    const missing = await login(s, unknown, 'wrong', ip);
    expect([missing.statusCode, missing.body]).toEqual([known.statusCode, known.body]);
    for (let i = 0; i < 4; i++) await login(s, unknown, 'wrong', ip);
    const blocked = await login(s, unknown, 'wrong', ip);
    expect([blocked.statusCode, blocked.json().key]).toEqual([429, 'err.tooMany']);
    // The password check costs the same either way (a dummy hash is checked when the email does not exist).
    const time = async (e: string) => { const t0 = process.hrtime.bigint(); await login(s, e, 'wrong', ipFor()); return Number(process.hrtime.bigint() - t0); };
    let k = 0, u = 0;
    for (let i = 0; i < 3; i++) { k += await time(email.e!); u += await time(`nobody-${randomUUID()}@example.com`); }
    expect(u / k).toBeGreaterThan(0.5);
    expect(u / k).toBeLessThan(2);
    await s.close();
  });
});

describe('Per IP address', () => {
  it('30 failures from one address, across any accounts, block that address; other addresses are not affected', async () => {
    const s = server(); const ip = ipFor();
    for (let i = 0; i < 30; i++) expect((await login(s, `spray-${i}-${randomUUID()}@example.com`, 'wrong', ip)).statusCode).toBe(401);
    expect((await login(s, email.e!, PW, ip)).statusCode).toBe(429);
    expect((await login(s, email.e!, PW, ipFor())).statusCode).toBe(200);
    await s.close();
  });

  it('uses the real client address only when TRUST_PROXY is on', async () => {
    const forwarded = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const off = server(); const direct = ipFor();
    await login(off, `x-${randomUUID()}@example.com`, 'wrong', direct, { 'x-forwarded-for': forwarded });
    const on = server({ trustProxy: true });
    await login(on, `x-${randomUUID()}@example.com`, 'wrong', '127.0.0.1', { 'x-forwarded-for': forwarded });
    const keys = (await owner.query(`SELECT key FROM auth_attempts WHERE kind = 'ip' AND key IN ($1, $2)`, [direct, forwarded])).rows.map((r) => r.key).sort();
    expect(keys).toEqual([direct, forwarded].sort());
    await off.close(); await on.close();
  });
});

describe('Two-factor codes', () => {
  it('are limited per person: five wrong codes block the right one', async () => {
    const secret = newTotpSecret();
    await owner.query('UPDATE users SET totp_secret_enc = $1, totp_enabled_at = now() WHERE id = $2', [encryptSecret(SECRET, secret), f.b.clientAccountant]);
    const s = server();
    // A new ticket from another address each time, so only the per-person count can block.
    const ticket = async () => (await login(s, email.mfa!, PW, ipFor())).json().ticket as string;
    for (let i = 0; i < 5; i++) {
      const r = await s.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: await ticket(), code: '000000' }, remoteAddress: ipFor() });
      expect(r.statusCode).toBe(401);
    }
    const code = totpCode(base32Decode(secret), Math.floor(Date.now() / 1000));
    const r = await s.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: await ticket(), code }, remoteAddress: ipFor() });
    expect([r.statusCode, r.json().key]).toEqual([429, 'err.tooMany']);
    await s.close();
  });
});

describe('Old attempts', () => {
  it('are purged after 24 hours', async () => {
    const key = `old-${randomUUID()}`;
    await owner.query(`INSERT INTO auth_attempts (kind, key, at) VALUES ('account', $1, now() - interval '25 hours'), ('account', $1, now() - interval '1 hour')`, [key]);
    await purgeAttempts(appPool);
    expect((await owner.query(`SELECT count(*)::int AS n FROM auth_attempts WHERE key = $1`, [key])).rows[0].n).toBe(1);
  });
  it('are not readable or writable by the app role directly', async () => {
    await expect(appPool.query('SELECT * FROM auth_attempts LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`INSERT INTO auth_attempts (kind, key) VALUES ('account', 'x')`)).rejects.toThrow(/permission denied/);
  });
});

describe('TRUST_PROXY', () => {
  it('is off unless set: true, a hop count, or proxy addresses', async () => {
    const { parseTrustProxy } = await import('../src/config.js');
    expect([undefined, '', 'false', '0'].map(parseTrustProxy)).toEqual([false, false, false, false]);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
