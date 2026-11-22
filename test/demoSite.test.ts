// The demo site (db/migrations/0064, src/api/demo.ts, src/demo/demoLink.ts): a separate deployment with its own database
// holding the fictional demo companies, opened from the platform owner's account by a short-lived signed link. The
// important property is what it REFUSES: any database that holds a real customer, and any link that was not made by the
// live app with the shared secret.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { signDemoToken, verifyDemoToken } from '../src/demo/demoLink.js';
import { validateConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/session.js';
import { buildServer } from '../src/api/server.js';
import { PG_ADMIN_URL, APP_PASSWORD } from './config.js';

const SECRET = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);

describe('The signed link', () => {
  it('opens within its time and for its purpose only', () => {
    const t = signDemoToken(SECRET, 'link', 900, 1_000);
    expect(verifyDemoToken(SECRET, t, 'link', 1_000 + 899_000)).toBe(true);
    expect(verifyDemoToken(SECRET, t, 'link', 1_000 + 901_000)).toBe(false);   // expired
    expect(verifyDemoToken(SECRET, t, 'pass', 1_000)).toBe(false);              // a link is not a pass
  });
  it('refuses another secret, a changed token and rubbish', () => {
    const t = signDemoToken(SECRET, 'link', 900, 1_000);
    expect(verifyDemoToken(SECRET.replace('a', 'z'), t, 'link', 1_000)).toBe(false);
    const [p, sig] = t.split('.');
    expect(verifyDemoToken(SECRET, `${p}x.${sig}`, 'link', 1_000)).toBe(false);
    expect(verifyDemoToken(SECRET, `${p}.${sig}x`, 'link', 1_000)).toBe(false);
    for (const bad of ['', '.', 'abc', 'a.b.c', '\u0000', 'e30.e30']) expect(verifyDemoToken(SECRET, bad, 'link', 1_000)).toBe(false);
    expect(() => signDemoToken('short', 'link')).toThrow();
  });
});

describe('Settings', () => {
  const prod = { NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(8) + 'k3y'.repeat(10), ENCRYPTION_KEY: 'e'.repeat(8) + 'q7z'.repeat(10), DATABASE_URL: 'postgres://nusuh_app:pw@db.example.com:5432/x',
    PUBLIC_URL: 'https://demo.example.com', COOKIE_SECURE: 'true', TRUST_PROXY: '1' };
  it('a demo site must have outside calls off, no email provider and a link secret', () => {
    const p = validateConfig({ ...prod, DEMO_SITE: 'true' });
    expect(p.join(' ')).toMatch(/OUTSIDE_CALLS/);
    expect(p.join(' ')).toMatch(/DEMO_LINK_SECRET/);
    expect(validateConfig({ ...prod, DEMO_SITE: 'true', OUTSIDE_CALLS: 'off', DEMO_LINK_SECRET: SECRET, EMAIL_PROVIDER: 'resend' }).join(' ')).toMatch(/EMAIL_PROVIDER/);
    expect(validateConfig({ ...prod, DEMO_SITE: 'true', OUTSIDE_CALLS: 'off', DEMO_LINK_SECRET: SECRET }).join(' ')).not.toMatch(/DEMO/);
  });
  it('the live app needs its demo address to be https with a secret, and cannot also be a demo site', () => {
    expect(validateConfig({ ...prod, DEMO_SITE_URL: 'http://demo.example.com', DEMO_LINK_SECRET: SECRET }).join(' ')).toMatch(/DEMO_SITE_URL/);
    expect(validateConfig({ ...prod, DEMO_SITE_URL: 'https://demo.example.com' }).join(' ')).toMatch(/DEMO_LINK_SECRET/);
    expect(validateConfig({ ...prod, DEMO_SITE_URL: 'https://demo.example.com', DEMO_LINK_SECRET: SECRET }).join(' ')).not.toMatch(/DEMO_/);
    expect(validateConfig({ ...prod, DEMO_SITE: 'true', DEMO_SITE_URL: 'https://x.example.com', OUTSIDE_CALLS: 'off', DEMO_LINK_SECRET: SECRET }).join(' ')).toMatch(/both/);
  });
  it('demo sign-in buttons stay forbidden in production', () => {
    expect(validateConfig({ ...prod, DEMO_LOGINS: 'true' }).join(' ')).toMatch(/DEMO_LOGINS/);
  });
});

describe('The demo endpoints on a demo database', () => {
  const DB = 'nusuh_demo_site_test';
  const urlOf = (user?: string, pw?: string) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${DB}`; if (user) { u.username = user; u.password = pw ?? ''; } return u.toString(); };
  let admin: pg.Client, db: pg.Client, pool: pg.Pool, server: FastifyInstance, other: FastifyInstance | undefined;
  let ownerUser = '', partnerUser = '', company = '';

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_ADMIN_URL }); await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
    await migrate(urlOf(), APP_PASSWORD);
    db = new pg.Client({ connectionString: urlOf() }); await db.connect();
    await db.query('BEGIN');
    const firm = (await db.query(`INSERT INTO firms (name) VALUES ('Demo Firm') RETURNING id`)).rows[0].id;
    partnerUser = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email, staff_role) VALUES ($1, 'firm_staff', 'Demo Partner', 'partner@demo.example', 'partner') RETURNING id`, [firm])).rows[0].id;
    ownerUser = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'client', 'Demo Owner', 'owner@demo.example') RETURNING id`, [firm])).rows[0].id;
    company = (await db.query(`INSERT INTO companies (firm_id, name, country, currency, cr_number, legal_form, vat_status, vat_number, vat_rate, address, city, fy_end_month, fy_end_day, invoice_prefix, industry, modules)
      VALUES ($1, 'Demo Hotel', 'SA', 'SAR', '1010000001', 'LLC', 'registered', '300000000000003', '15.00', 'Demo', 'Jeddah', 12, 31, 'DH-', 'hospitality', ARRAY['Rooms']) RETURNING id`, [firm])).rows[0].id;
    await db.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, 'client_accountant')`, [ownerUser, company]);
    await db.query(`INSERT INTO demo_marker (firm_id) VALUES ($1)`, [firm]);
    await db.query(`INSERT INTO demo_entries (key, title, title_ar, industry, blurb, user_id, company_id, sort) VALUES ('hospitality', 'Hotel and resort', 'فندق ومنتجع', 'hospitality', 'Rooms, restaurant', $1, $2, 1), ('firm', 'Accounting firm', 'مكتب محاسبة', NULL, 'Many clients', $3, NULL, 9)`, [ownerUser, company, partnerUser]);
    await db.query('COMMIT');
    pool = createPool(urlOf('nusuh_app', APP_PASSWORD));
    server = buildServer({ pool, sessionSecret: 'test-secret', cookieSecure: false, demoSite: { linkSecret: SECRET } });
  });
  afterAll(async () => { await server?.close(); await other?.close(); await pool?.end(); await db?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin?.end(); });

  const inject = (s: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: object, cookie?: string) => s.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
  const pass = async (s: FastifyInstance) => {
    const r = await inject(s, 'POST', '/api/demo/open', { token: signDemoToken(SECRET, 'link', 900) });
    expect(r.statusCode).toBe(200);
    return String(r.headers['set-cookie']).split(';')[0]!;
  };

  it('the database is recognised as a demo database', async () => {
    expect((await pool.query('SELECT demo_database_ok() AS ok')).rows[0].ok).toBe(true);
    expect((await inject(server, 'GET', '/api/config')).json()).toMatchObject({ demoSite: true });
  });

  it('a signed link opens the picker; the list shows the client types and nothing else about the database', async () => {
    const c = await pass(server);
    const list = (await inject(server, 'GET', '/api/demo/entries', undefined, c)).json();
    expect(list.map((x: { key: string }) => x.key)).toEqual(['hospitality', 'firm']);
    expect(Object.keys(list[0]).sort()).toEqual(['blurb', 'blurbAr', 'industry', 'key', 'sort', 'title', 'titleAr']);
  });

  it('without a valid link or pass, nothing opens', async () => {
    expect((await inject(server, 'POST', '/api/demo/open', { token: 'rubbish' })).statusCode).toBe(403);
    expect((await inject(server, 'POST', '/api/demo/open', { token: signDemoToken('z'.repeat(40), 'link', 900) })).statusCode).toBe(403);
    expect((await inject(server, 'POST', '/api/demo/open', { token: signDemoToken(SECRET, 'pass', 900) })).statusCode).toBe(403);   // a pass is not a link
    expect((await inject(server, 'GET', '/api/demo/entries')).statusCode).toBe(403);
    expect((await inject(server, 'POST', '/api/demo/enter', { key: 'hospitality' })).statusCode).toBe(403);
  });

  it('choosing a client type signs in as that company\'s demo owner and says where to go', async () => {
    const c = await pass(server);
    const r = await inject(server, 'POST', '/api/demo/enter', { key: 'hospitality' }, c);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ path: `/c/${company}/Home` });
    const session = String(r.headers['set-cookie']).split(';')[0]!;
    const me = (await inject(server, 'GET', '/api/me', undefined, session)).json();
    expect(me.user).toMatchObject({ name: 'Demo Owner', kind: 'client' });
    const firm = await inject(server, 'POST', '/api/demo/enter', { key: 'firm' }, c);
    expect(firm.json()).toEqual({ path: '/' });
    expect((await inject(server, 'POST', '/api/demo/enter', { key: 'nope' }, c)).statusCode).toBe(404);
    expect((await inject(server, 'POST', '/api/demo/enter', { key: { $ne: 1 } }, c)).statusCode).toBe(400);
  });

  it('an ordinary (live) server has no demo endpoints at all, and the entry list is unreadable without the demo checks', async () => {
    other = buildServer({ pool, sessionSecret: 'test-secret', cookieSecure: false });
    expect((await inject(other, 'POST', '/api/demo/open', { token: signDemoToken(SECRET, 'link', 900) })).statusCode).toBe(404);
    expect((await inject(other, 'GET', '/api/demo/entries')).statusCode).toBe(404);
    await expect(pool.query('SELECT * FROM demo_entries')).rejects.toThrow();   // the app role cannot read the tables directly
    await expect(pool.query('SELECT * FROM demo_marker')).rejects.toThrow();
  });
  // Last on purpose: the database keeps the real customer afterwards (the audit log never lets a record go), and is dropped at the end.
  it('the moment a real customer exists in the database, the demo site refuses everything', async () => {
    const c = await pass(server);
    await db.query(`INSERT INTO firms (name, kind) VALUES ('A Real Customer', 'company')`);
    {
      expect((await pool.query('SELECT demo_database_ok() AS ok')).rows[0].ok).toBe(false);
      expect((await inject(server, 'GET', '/api/demo/entries', undefined, c)).statusCode).toBe(403);
      expect((await inject(server, 'POST', '/api/demo/enter', { key: 'hospitality' }, c)).statusCode).toBe(403);
      expect((await inject(server, 'POST', '/api/demo/open', { token: signDemoToken(SECRET, 'link', 900) })).statusCode).toBe(403);
    }
  });

});
