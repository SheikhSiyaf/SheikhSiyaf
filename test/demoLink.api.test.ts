// The live app's side of the demo: only the platform owner gets a link, and only when the demo site is set up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { verifyDemoToken } from '../src/demo/demoLink.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'q'.repeat(20) + 'r'.repeat(20);
let f: Fixture;
let withDemo: FastifyInstance, without: FastifyInstance;
const emails: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword('pw-123456');
  for (const [k, id] of Object.entries({ platform: f.platformOwner, partner: f.partner, admin: f.admin })) emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  withDemo = buildServer({ pool: appPool, sessionSecret: 'test-secret', demoLink: { url: 'https://demo.example.com/', secret: SECRET } });
  without = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await withDemo?.close(); await without?.close(); });

const login = async (s: FastifyInstance, who: string) => {
  const r = await s.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } });
  expect(r.statusCode).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0]!;
};

describe('Demo mode in the owner console', () => {
  it('gives the platform owner a signed link to the demo site that lasts 15 minutes', async () => {
    const c = await login(withDemo, 'platform');
    const r = await withDemo.inject({ method: 'GET', url: '/api/owner/demo-link', headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
    const { url, minutes } = r.json();
    expect(minutes).toBe(15);
    expect(url).toMatch(/^https:\/\/demo\.example\.com\/demo\?t=/);
    const token = new URL(url).searchParams.get('t')!;
    expect(verifyDemoToken(SECRET, token, 'link')).toBe(true);
    expect(verifyDemoToken(SECRET, token, 'link', Date.now() + 16 * 60_000)).toBe(false);
  });

  it('is for the platform owner only: a firm partner and an Administrator are refused', async () => {
    for (const who of ['partner', 'admin']) {
      const r = await withDemo.inject({ method: 'GET', url: '/api/owner/demo-link', headers: { cookie: await login(withDemo, who) } });
      expect(r.statusCode, who).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain('demo.example.com');
    }
    expect((await withDemo.inject({ method: 'GET', url: '/api/owner/demo-link' })).statusCode).toBeGreaterThanOrEqual(400);   // signed out
  });

  it('says plainly that the demo site is not set up when it is not', async () => {
    const r = await without.inject({ method: 'GET', url: '/api/owner/demo-link', headers: { cookie: await login(without, 'platform') } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ key: 'err.demoNotSet' });
  });

  it('opens the built-in preview (sample data in the browser, no database) when there is no demo site but the build has it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nb-web-'));
    mkdirSync(join(dir, 'preview'));
    writeFileSync(join(dir, 'preview', 'index.html'), '<p>preview</p>');
    writeFileSync(join(dir, 'index.html'), '<p>app</p>');
    const withPreview = buildServer({ pool: appPool, sessionSecret: 'test-secret', staticDir: dir });
    try {
      const r = await withPreview.inject({ method: 'GET', url: '/api/owner/demo-link', headers: { cookie: await login(withPreview, 'platform') } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ url: '/preview/index.html' });
      expect((await withPreview.inject({ method: 'GET', url: '/preview/index.html' })).body).toContain('preview');
      expect((await withPreview.inject({ method: 'GET', url: '/api/owner/demo-link', headers: { cookie: await login(withPreview, 'partner') } })).statusCode).toBe(403);   // only the platform owner
    } finally { await withPreview.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
