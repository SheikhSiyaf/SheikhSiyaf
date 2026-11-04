// Start-up checks (src/config.ts validateConfig): in production the server refuses to start with unsafe settings;
// elsewhere the same list is printed as warnings. Links in emails use only PUBLIC_URL in production.
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { validateConfig } from '../src/config.js';
import { baseUrl } from '../src/api/context.js';
import { app as appPool, owner, seed } from './helpers.js';
import { buildServer } from '../src/api/server.js';

const S32 = 'a'.repeat(40), E32 = 'b'.repeat(40);
const good = {
  NODE_ENV: 'production', SESSION_SECRET: S32, ENCRYPTION_KEY: E32,
  DATABASE_URL: 'postgres://nusuh_app:Str0ng-and-long@db.internal:5432/nusuh', DATABASE_ADMIN_URL: 'postgres://postgres:other@db.internal:5432/nusuh',
  COOKIE_SECURE: 'true', PUBLIC_URL: 'https://books.example.com', DEMO_LOGINS: 'false',
};
const problems = (over: Record<string, string | undefined>) => validateConfig({ ...good, ...over });
const has = (list: string[], re: RegExp) => list.some((p) => re.test(p));

describe('validateConfig', () => {
  it('accepts a safe production set-up', () => {
    expect(validateConfig(good)).toEqual([]);
  });
  it('SESSION_SECRET: set and at least 32 characters', () => {
    expect(has(problems({ SESSION_SECRET: undefined }), /SESSION_SECRET/)).toBe(true);
    expect(has(problems({ SESSION_SECRET: 'short-secret' }), /SESSION_SECRET.*32/)).toBe(true);
  });
  it('ENCRYPTION_KEY: set, at least 32 characters, not the same as SESSION_SECRET', () => {
    expect(has(problems({ ENCRYPTION_KEY: undefined }), /ENCRYPTION_KEY/)).toBe(true);
    expect(has(problems({ ENCRYPTION_KEY: 'short' }), /ENCRYPTION_KEY.*32/)).toBe(true);
    expect(has(problems({ ENCRYPTION_KEY: S32 }), /ENCRYPTION_KEY.*SESSION_SECRET/)).toBe(true);
  });
  it('DATABASE_URL: set, the nusuh_app role, not the default password', () => {
    expect(has(problems({ DATABASE_URL: undefined }), /DATABASE_URL is not set/)).toBe(true);
    expect(has(problems({ DATABASE_URL: 'postgres://postgres:secret-pass@db:5432/nusuh' }), /nusuh_app/)).toBe(true);
    expect(has(problems({ DATABASE_URL: 'postgres://nusuh_app:change-me@db:5432/nusuh' }), /change-me/)).toBe(true);
    expect(has(problems({ DATABASE_URL: 'not a url' }), /DATABASE_URL/)).toBe(true);
  });
  it('DATABASE_URL must not be the owner connection', () => {
    expect(has(problems({ DATABASE_ADMIN_URL: good.DATABASE_URL }), /DATABASE_ADMIN_URL/)).toBe(true);
  });
  it('COOKIE_SECURE=true, PUBLIC_URL on https, DEMO_LOGINS off', () => {
    expect(has(problems({ COOKIE_SECURE: undefined }), /COOKIE_SECURE/)).toBe(true);
    expect(has(problems({ PUBLIC_URL: undefined }), /PUBLIC_URL/)).toBe(true);
    expect(has(problems({ PUBLIC_URL: 'http://books.example.com' }), /PUBLIC_URL.*https/)).toBe(true);
    expect(has(problems({ DEMO_LOGINS: 'true' }), /DEMO_LOGINS/)).toBe(true);
  });
  it('lists every problem at once', () => {
    const all = validateConfig({ NODE_ENV: 'production' });
    expect(all).toHaveLength(5);
    for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL', 'COOKIE_SECURE', 'PUBLIC_URL']) expect(has(all, new RegExp(name)), name).toBe(true);
  });
  it('outside production gives the same list (printed as warnings by the server)', () => {
    expect(validateConfig({ ...good, NODE_ENV: 'development', COOKIE_SECURE: 'false' })).toEqual(problems({ COOKIE_SECURE: 'false' }));
  });
});

describe('baseUrl', () => {
  const req = (headers: Record<string, string>) => ({ headers, protocol: 'http' }) as unknown as FastifyRequest;
  it('in production uses only PUBLIC_URL, whatever the Host and X-Forwarded-Host say', () => {
    const opts = { production: true, publicUrl: 'https://books.example.com/' };
    expect(baseUrl(req({ host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }), opts)).toBe('https://books.example.com');
  });
  it('in development falls back to the request address', () => {
    expect(baseUrl(req({ host: 'localhost:5173' }), {})).toBe('http://localhost:5173');
  });
  it('a password reset email in production links to PUBLIC_URL even with a forged Host', async () => {
    const f = await seed();
    const email = (await owner.query(`UPDATE users SET password_hash = 'x' WHERE id = $1 RETURNING email`, [f.staff])).rows[0].email;
    const s = buildServer({ pool: appPool, sessionSecret: S32, encryptionKey: E32, production: true, publicUrl: 'https://books.example.com' });
    const r = await s.inject({ method: 'POST', url: '/api/password-reset', payload: { email }, headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(r.statusCode).toBe(200);
    const body = (await owner.query(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'password_reset'`, [email])).rows[0].body_text as string;
    expect(body).toContain('https://books.example.com/invite/');
    expect(body).not.toContain('evil.example');
    await s.close();
  });
  it('in production the demo sign-in list and demo fields stay off', async () => {
    const s = buildServer({ pool: appPool, sessionSecret: S32, encryptionKey: E32, production: true, publicUrl: 'https://books.example.com', demoLogins: true });
    expect((await s.inject({ method: 'GET', url: '/api/demo-users' })).statusCode).toBe(404);
    expect((await s.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ demoLogins: false });
    expect((await s.inject({ method: 'GET', url: '/api/config' })).json().demoPassword).toBeUndefined();
    await s.close();
  });
});
