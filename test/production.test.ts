// Production behaviour (src/api/hardening.ts, src/jobs/runJob.ts, src/log/redact.ts, src/log/errorReport.ts):
// one copy of each background job, /health, security headers, same-site requests, rate limits, masked logs and
// error reports that are off by default.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture, testPool } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import pg from 'pg';
import { runExclusive, releaseJobs } from '../src/jobs/runJob.js';
import { APP_URL } from './config.js';
import { redactText, redactUrl, loggerOptions } from '../src/log/redact.js';
import { configureErrorReport, reportError } from '../src/log/errorReport.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture, server: FastifyInstance, email: string;
const logs: string[] = [];
const reports: { url: string; body: Record<string, unknown> }[] = [];
const SECRET = '5f1c8e3a9b72d04e6c1f8a3b5d97e2c40a6b8d1f3e5c7a92';

beforeAll(async () => {
  f = await seed();
  email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword('Sup3r-secret-pass!'), f.partner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: SECRET, encryptionKey: 'c3a91e7f5b28d40a6e1c9f3b7d52a8e04b6d1f9c3a7e', cookieSecure: true, publicUrl: 'https://books.example.com',
    logger: loggerOptions({ level: 'info', stream: { write: (s: string) => { logs.push(s); } } }) });
  server.get('/api/test-crash', async () => { throw new Error('Insert failed for 1,150.00 SAR, password=hunter2, code 482913'); });
  configureErrorReport({ post: async (url, init) => { reports.push({ url, body: JSON.parse(init.body) }); return {}; } });
});
afterAll(async () => { delete process.env.ERROR_REPORT_URL; await releaseJobs(appPool); await server.close(); });

describe('Background jobs run in one server copy only', () => {
  it('two server copies: the first to ask owns the job and runs it every time; the other skips until the owner stops', async () => {
    const copyA = testPool(APP_URL, 3), copyB = testPool(APP_URL, 3);
    try {
      let inside = 0, most = 0;
      const work = async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 100)); inside--; return 'done'; };
      const first = await Promise.all([runExclusive(copyA, 'test_job', work), runExclusive(copyB, 'test_job', work)]);
      expect(first.map((x) => x.ran).sort()).toEqual([false, true]);
      expect(most).toBe(1);
      const owner_ = first[0]!.ran ? copyA : copyB, other = first[0]!.ran ? copyB : copyA;
      // Later runs, one after the other: still only the owner runs it.
      for (let i = 0; i < 3; i++) {
        expect((await runExclusive(owner_, 'test_job', work)).ran).toBe(true);
        expect((await runExclusive(other, 'test_job', work)).ran).toBe(false);
      }
      expect((await appPool.query(`SELECT last_ok FROM job_status() WHERE job = 'test_job'`)).rows[0].last_ok).toBe(true);
      // The owner stops: the other copy takes the job over.
      await releaseJobs(owner_);
      expect((await runExclusive(other, 'test_job', work)).ran).toBe(true);
    } finally { await releaseJobs(copyA); await releaseJobs(copyB); await copyA.end(); await copyB.end(); }
  });

  it('a failed run is recorded as failed, with the message masked', async () => {
    await expect(runExclusive(appPool, 'test_fail', async () => { throw new Error('could not post 2,300.00 for token abcdefghijklmnopqrstuvwxyz0123'); })).rejects.toThrow();
    const r = (await owner.query(`SELECT last_ok, last_error FROM job_runs WHERE job = 'test_fail'`)).rows[0];
    expect(r.last_ok).toBe(false);
    expect(r.last_error).not.toMatch(/2,300\.00|abcdefghijklmnop/);
  });
});

describe('/health', () => {
  it('reports the database and each job, without customer data', async () => {
    const r = await server.inject({ method: 'GET', url: '/health' });
    const b = r.json();
    expect(b.database).toBe('ok');
    expect(b.jobs.map((j: { job: string }) => j.job)).toEqual(expect.arrayContaining(['einvoice_sender', 'email', 'exchange_rates', 'accountant_tools', 'bank_feeds', 'billing', 'signin_purge']));
    expect(Object.keys(b.jobs[0]).sort()).toEqual(['job', 'lastRunAt', 'late', 'ok', 'on']);
    expect([200, 503]).toContain(r.statusCode);
  });
  it('a switched-on job that failed makes it 503 "degraded"', async () => {
    await owner.query(`INSERT INTO job_runs (job, last_started_at, last_finished_at, last_ok, last_error, runs) VALUES ('email', now(), now(), false, 'x', 1)
      ON CONFLICT (job) DO UPDATE SET last_finished_at = now(), last_ok = false`);
    const r = await server.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('degraded');
    expect(r.body).not.toContain('last_error');
    await owner.query(`UPDATE job_runs SET last_ok = true WHERE job = 'email'`);
  });
});

describe('Security headers, cookies and requests', () => {
  it('every answer carries the security headers; API answers are never cached; HTTPS is enforced', async () => {
    const r = await server.inject({ method: 'GET', url: '/api/config' });
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('the sign-in cookie is HttpOnly, Secure and SameSite', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Sup3r-secret-pass!' } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(r.headers['set-cookie'])).toMatch(/Secure/);
    expect(String(r.headers['set-cookie'])).toMatch(/SameSite=Lax/);
  });
  it('a change sent with the cookie from another site is refused; from this site it goes through', async () => {
    const cookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Sup3r-secret-pass!' } })).headers['set-cookie']).split(';')[0]!;
    const bad = await server.inject({ method: 'POST', url: '/api/logout', headers: { cookie, origin: 'https://evil.example', host: 'books.example.com' } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().key).toBe('err.crossSite');
    const good = await server.inject({ method: 'POST', url: '/api/logout', headers: { cookie, origin: 'https://books.example.com', host: 'books.example.com' } });
    expect(good.statusCode).toBe(200);
  });
  it('requests larger than the limit are refused', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'x'.repeat(1_100_000) } });
    expect(r.statusCode).toBe(413);
  });
  it('links that work without signing in are rate limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await server.inject({ method: 'GET', url: '/api/public/documents/not-a-real-token', remoteAddress: '203.0.113.7' })).statusCode;
    expect(last).toBe(429);
    expect((await server.inject({ method: 'GET', url: '/api/public/documents/not-a-real-token', remoteAddress: '203.0.113.8' })).statusCode).not.toBe(429);
  });
});

describe('Logs and error reports', () => {
  it('masking: passwords, keys, tokens, one-time codes and amounts', () => {
    expect(redactText('password=hunter2 otp: 123456 total 1,150.00 and 75.5 key="abc"')).toBe('password=[hidden] otp: [hidden] total [amount] and [amount] key=[hidden]');
    expect(redactText('the code is 482913')).toBe('the code is [code]');
    expect(redactText('Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('Bearer [hidden]');
    expect(redactText('-----BEGIN EC PRIVATE KEY-----\nMHQCAQ\n-----END EC PRIVATE KEY-----')).toBe('[key]');
    expect(redactText('company 3f2b1c9e-8a7d-4c6b-9e5f-1a2b3c4d5e6f')).toContain('3f2b1c9e-8a7d-4c6b-9e5f-1a2b3c4d5e6f');   // record ids stay, for tracing
    expect(redactUrl('/api/invite/Abc_DEF-123456789012345678901234567890')).toBe('/api/invite/[hidden]');
    expect(redactUrl('/i/tok3n?paid=9')).toBe('/i/[hidden]?paid=[hidden]');
  });
  it('the server log has no password, invitation token, amount or one-time code', async () => {
    await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Sup3r-secret-pass!' } });
    await server.inject({ method: 'GET', url: '/api/invite/Abc_DEF-123456789012345678901234567890' });
    await server.inject({ method: 'GET', url: '/api/test-crash' });
    const all = logs.join('\n');
    expect(all).toContain('/api/invite/[hidden]');
    for (const secret of ['Sup3r-secret-pass!', 'Abc_DEF-1234567890', '1,150.00', 'hunter2', '482913']) expect(all).not.toContain(secret);
  });
  it('error reports are off by default; one setting turns them on; they are masked too', async () => {
    reports.length = 0;
    await server.inject({ method: 'GET', url: '/api/test-crash' });
    expect(reports).toHaveLength(0);
    process.env.ERROR_REPORT_URL = 'https://errors.example.com/hook';
    await server.inject({ method: 'GET', url: '/api/test-crash' });
    await new Promise((r) => setTimeout(r, 50));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.url).toBe('https://errors.example.com/hook');
    expect(reports[0]!.body).toMatchObject({ app: 'nusuh-books', where: 'request', method: 'GET', url: '/api/test-crash', status: 500 });
    expect(JSON.stringify(reports[0]!.body)).not.toMatch(/1,150\.00|hunter2|482913/);
    expect(await reportError({ where: 'x', message: 'y' })).toBe(true);
    delete process.env.ERROR_REPORT_URL;
  });
});
