// A real installation (src/db/install.ts, README "Starting a real installation"): a new empty database, the
// migrations, the owner's account with a one-time link, then the first customer and its company from the owner
// console. No demo data anywhere; the demo seed refuses to run in production; demo sign-ins are off.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../src/db/migrate.js';
import { createOwner } from '../src/db/install.js';
import { seed as demoSeed } from '../src/db/seed.js';
import { buildServer } from '../src/api/server.js';
import { PG_ADMIN_URL, APP_PASSWORD } from './config.js';
import { testPool } from './helpers.js';

const DB = `nusuh_install_${process.pid}`;
const url = (user: string, pw: string) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${DB}`; if (user) { u.username = user; u.password = pw; } return u.toString(); };
const ownerUrl = () => url('', '');
let admin: pg.Client, pool: pg.Pool, server: FastifyInstance, link = '';
const SECRET = '7c1e93a4f0b25d68e9a1c4f7b03d52e8a6c9f1b47d20e3a5';

beforeAll(async () => {
  admin = new pg.Client({ connectionString: PG_ADMIN_URL }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`);
  await migrate(ownerUrl(), APP_PASSWORD);
  pool = testPool(url('nusuh_app', APP_PASSWORD), 3);
  server = buildServer({ pool, sessionSecret: SECRET, encryptionKey: '2e8b51d7a94c06f3b8e1d52a7c49f06b3d81e57a2c', production: true, publicUrl: 'https://books.example.com', demoLogins: true });
});
afterAll(async () => {
  await server?.close(); await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.end();
});

describe('Starting a real installation', () => {
  it('the demo seed refuses to run in production', async () => {
    await expect(demoSeed(ownerUrl(), { production: true })).rejects.toThrow(/never loaded in production/);
  });

  it('the new database holds no people or companies after the migrations, only the platform and its automatic sender', async () => {
    const c = new pg.Client({ connectionString: ownerUrl() }); await c.connect();
    expect((await c.query(`SELECT kind, count(*)::int AS n FROM users GROUP BY kind`)).rows).toEqual([{ kind: 'system', n: 1 }]);
    expect((await c.query(`SELECT count(*)::int AS n FROM companies`)).rows[0].n).toBe(0);
    expect((await c.query(`SELECT kind FROM firms`)).rows).toEqual([{ kind: 'platform' }]);
    await c.end();
  });

  it('db:install creates the owner with a one-time link (no password is set or printed)', async () => {
    await expect(createOwner(ownerUrl(), { name: 'Owner', email: 'not-an-email', publicUrl: 'https://books.example.com' })).rejects.toThrow(/email/);
    const r = await createOwner(ownerUrl(), { name: 'Real Owner', email: 'Owner@Books.example.com', publicUrl: 'https://books.example.com/' });
    expect(r.status).toBe('created');
    expect(r.link).toMatch(/^https:\/\/books\.example\.com\/invite\/[\w-]{40,}$/);
    link = r.link;
    // Asked again before the password is chosen: a new link; another owner email: refused.
    const again = await createOwner(ownerUrl(), { name: 'Real Owner', email: 'owner@books.example.com', publicUrl: 'https://books.example.com' });
    expect(again.status).toBe('new_link');
    link = again.link;
    await expect(createOwner(ownerUrl(), { name: 'Other', email: 'other@books.example.com', publicUrl: 'https://books.example.com' })).rejects.toThrow(/already exists/);
  });

  it('the owner chooses a password, signs in, and adds the first customer and its company; demo sign-ins stay off', async () => {
    const token = link.split('/invite/')[1]!;
    expect((await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: 'Owner-pass-2026-long' } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: 'Owner-pass-2026-long' } })).statusCode).toBe(404);   // works once
    expect((await server.inject({ method: 'GET', url: '/api/config' })).json().demoLogins).toBe(false);
    const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email: 'owner@books.example.com', password: 'Owner-pass-2026-long' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly/);
    const t = await server.inject({ method: 'POST', url: '/api/owner/tenants', headers: { cookie }, payload: { name: 'First Customer', kind: 'company', adminName: 'Customer Admin', adminEmail: 'admin@firstcustomer.example.com' } });
    expect(t.statusCode, t.body).toBe(200);
    const co = await server.inject({ method: 'POST', url: '/api/admin/companies', headers: { cookie, 'x-acting-tenant': t.json().id }, payload: {
      company: { name: 'First Customer Trading', country: 'SA', industry: 'trading', crNumber: '1010000001', legalForm: 'LLC', vatStatus: 'registered', vatNumber: '310000000000003',
        address: 'Olaya Street', city: 'Riyadh', fyEnd: '12-31' },
      firstUser: { name: 'Customer Accountant', email: 'accounts@firstcustomer.example.com', role: 'client_accountant' } } });
    expect(co.statusCode, co.body).toBe(200);
    const c = new pg.Client({ connectionString: ownerUrl() }); await c.connect();
    expect((await c.query(`SELECT name FROM companies`)).rows).toEqual([{ name: 'First Customer Trading' }]);
    expect((await c.query(`SELECT count(*)::int AS n FROM accounts WHERE company_id = $1`, [co.json().id])).rows[0].n).toBeGreaterThan(20);   // its chart of accounts
    await c.end();
    await expect(createOwner(ownerUrl(), { name: 'Real Owner', email: 'owner@books.example.com', publicUrl: 'https://books.example.com' })).rejects.toThrow(/already chosen a password/);
  });
});

import { ownerFrom } from '../src/db/install.js';
describe('ownerFrom: the owner named on the command line or in the host settings', () => {
  it('takes the command line first, then OWNER_NAME and OWNER_EMAIL, else empty', () => {
    expect(ownerFrom(['node', 'x', '--name', 'A B', '--email', 'a@b.co'], { OWNER_NAME: 'Z', OWNER_EMAIL: 'z@z.co' })).toEqual({ name: 'A B', email: 'a@b.co' });
    expect(ownerFrom(['node', 'x'], { OWNER_NAME: 'Z Y', OWNER_EMAIL: 'z@z.co' })).toEqual({ name: 'Z Y', email: 'z@z.co' });
    expect(ownerFrom(['node', 'x'], {})).toEqual({ name: '', email: '' });
  });
});
