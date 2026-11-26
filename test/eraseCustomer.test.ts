// Erasing a removed customer for good (migration 0085). Only a customer that NEVER used the books can be erased; everything else can only
// be removed. The erase is all-or-nothing, touches nobody else, leaves a permanent record, and cannot be reached by anyone but the owner.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, saCr, saVat, sale, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { postEntry } from '../src/ledger/ledger.js';

const PW = 'pw-123456';
let f: Fixture; let server: FastifyInstance; let platformEmail = ''; let cookie = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const n = async (sql: string, args: unknown[] = []) => Number((await owner.query(sql, args)).rows[0].n);

beforeAll(async () => {
  f = await seed();
  platformEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret-erase' });
  const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email: platformEmail, password: PW } });
  cookie = String(r.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await server?.close(); });

async function newCustomer(label: string) {
  const s = stamp();
  const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie }, payload: {
    company: { name: `${label} ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh' },
    users: [{ name: 'Admin', email: `admin.${s}@erase.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `fin.${s}@erase.example.com`, jobTitle: 'Owner' }] } });
  expect(res.statusCode, res.body).toBe(200);
  const firmId = res.json().id as string, companyId = res.json().companyId as string;
  await owner.query(`UPDATE users SET password_hash = $1 WHERE firm_id = $2`, [await hashPassword(PW), firmId]);
  await owner.query(`INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, next_bill_on) SELECT $1, id, 'monthly', 'active', current_date, current_date + 30 FROM plans LIMIT 1`, [firmId]);
  const name = (await owner.query('SELECT name FROM firms WHERE id = $1', [firmId])).rows[0].name as string;
  const userEmail = `fin.${s}@erase.example.com`;
  return { firmId, companyId, name, userEmail };
}
const remove = (id: string, removed = true) => server.inject({ method: 'POST', url: `/api/owner/tenants/${id}/remove`, headers: { cookie }, payload: { removed } });
const erase = (id: string, confirmName: unknown, c = cookie) => server.inject({ method: 'POST', url: `/api/owner/tenants/${id}/erase`, headers: { cookie: c }, payload: { confirmName } });
const listed = async (id: string) => ((await server.inject({ method: 'GET', url: '/api/owner/tenants', headers: { cookie } })).json() as { id: string; eraseBlockers: string[] | null }[]).find((x) => x.id === id);
const everything = async (firmId: string, companyId: string) => ({
  firm: await n('SELECT count(*) AS n FROM firms WHERE id = $1', [firmId]),
  companies: await n('SELECT count(*) AS n FROM companies WHERE firm_id = $1', [firmId]),
  users: await n('SELECT count(*) AS n FROM users WHERE firm_id = $1', [firmId]),
  accounts: await n('SELECT count(*) AS n FROM accounts WHERE company_id = $1', [companyId]),
  memberships: await n('SELECT count(*) AS n FROM memberships WHERE company_id = $1', [companyId]),
  subscriptions: await n('SELECT count(*) AS n FROM subscriptions WHERE firm_id = $1', [firmId]),
  roles: await n('SELECT count(*) AS n FROM client_roles WHERE firm_id = $1', [firmId]),
});

describe('Erase a removed customer that never used the books', () => {
  it('only after it is removed, only with its exact name, and then everything of it is gone and nothing of anyone else', async () => {
    const a = await newCustomer('Erasable'), keep = await newCustomer('Keeper');
    const before = await everything(a.firmId, a.companyId);
    expect(before).toMatchObject({ firm: 1, companies: 1, users: 2 });
    expect(before.accounts).toBeGreaterThan(10);
    const keepBefore = await everything(keep.firmId, keep.companyId);
    await remove(keep.firmId);   // a second removed customer that must survive

    // not removed yet: refused, and the list does not offer it
    expect((await listed(a.firmId))!.eraseBlockers).toBeNull();
    const early = await erase(a.firmId, a.name);
    expect(early.statusCode).toBe(400);
    expect(early.json().key).toBe('err.eraseNotRemoved');
    await remove(a.firmId);
    expect((await listed(a.firmId))!.eraseBlockers).toEqual([]);
    // the name must be exact
    for (const bad of [undefined, '', 'erasable', `${a.name} `.toUpperCase(), 42, a.name.slice(0, -1)]) {
      const r = await erase(a.firmId, bad);
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().key).toBe('err.eraseName');
    }
    expect(await everything(a.firmId, a.companyId)).toEqual(before);   // all those refusals changed nothing

    const ok = await erase(a.firmId, a.name);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, name: a.name, companies: 1, users: 2 });
    expect(await everything(a.firmId, a.companyId)).toEqual({ firm: 0, companies: 0, users: 0, accounts: 0, memberships: 0, subscriptions: 0, roles: 0 });
    expect(await listed(a.firmId)).toBeUndefined();
    // nobody can sign in, and it cannot be restored or erased again
    expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email: a.userEmail, password: PW } })).statusCode).toBe(401);
    expect((await remove(a.firmId, false)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await erase(a.firmId, a.name)).statusCode).toBe(404);
    // the other customer is exactly as it was
    expect(await everything(keep.firmId, keep.companyId)).toEqual({ ...keepBefore });
    // a permanent record, in two places
    const log = (await owner.query('SELECT * FROM erasure_log WHERE firm_id = $1', [a.firmId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ firm_name: a.name, firm_kind: 'company', companies: 1, users: 2, erased_by: f.platformOwner });
    expect(Number(log[0].rows_deleted)).toBeGreaterThan(20);
    expect(await n(`SELECT count(*) AS n FROM audit_log WHERE table_name = 'firms' AND action = 'erase' AND row_id = $1`, [a.firmId])).toBe(1);
    // the rules that protect posted records are switched back on afterwards
    expect(await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgenabled = 'D' AND NOT tgisinternal`)).toBe(0);
    await expect(owner.query(`UPDATE erasure_log SET firm_name = 'x'`)).rejects.toThrow(/cannot be changed|Posted records/);
  });

  it('keeps the record that the mailbox and company number had a free trial, so they cannot start another', async () => {
    const s = stamp();
    const email = `trial.${s}@erase.example.com`, crNumber = saCr();
    const on = buildServer({ pool: appPool, sessionSecret: 'erase-signup-secret', trustProxy: 1, publicUrl: 'https://app.example', signup: { enabled: true, pepper: 'e'.repeat(40) } });
    try {
      const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const body = { fullName: 'Trial Person', email, password: 'Correct-Horse-9', companyName: `Trial Co ${s}`, country: 'SA', crNumber, city: 'Riyadh', acceptTerms: true };
      expect((await on.inject({ method: 'POST', url: '/api/signup', payload: body, headers: { 'x-forwarded-for': ip } })).statusCode).toBe(200);
      const token = /\/verify\/([A-Za-z0-9_-]{43})/.exec(String((await owner.query(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'signup'`, [email])).rows[0].body_text))![1];
      expect((await on.inject({ method: 'POST', url: '/api/signup/verify', payload: { token }, headers: { 'x-forwarded-for': ip } })).statusCode).toBe(200);
      const firmId = (await owner.query(`SELECT firm_id FROM users WHERE lower(email) = $1`, [email])).rows[0].firm_id as string;
      expect((await remove(firmId)).statusCode).toBe(200);
      expect((await erase(firmId, `Trial Co ${s}`)).statusCode).toBe(200);   // the sign-up path leaves a pending-free, never-used customer
      expect(await n('SELECT count(*) AS n FROM users WHERE lower(email) = $1', [email])).toBe(0);
      expect(await n('SELECT count(*) AS n FROM trial_fingerprints WHERE firm_id = $1', [firmId])).toBe(1);
      const again = await on.inject({ method: 'POST', url: '/api/signup', payload: { ...body, companyName: `Trial Co again ${s}` }, headers: { 'x-forwarded-for': ip } });
      expect(again.statusCode).toBe(200);   // the screen says the same as always...
      const verify2 = await owner.query(`SELECT count(*)::int AS n FROM signup_requests WHERE email = $1 AND status = 'pending'`, [email]);
      expect(verify2.rows[0].n).toBe(0);    // ...but no new request was made: this mailbox already had its trial
    } finally { await on.close(); }
  });
});

describe('A customer that used the books can only be removed', () => {
  it('is refused, with the reasons, and not a single row goes', async () => {
    const used = await newCustomer('Used');
    const acc = async (code: string) => (await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [used.companyId, code])).rows[0].id as string;
    const finance = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [used.userEmail])).rows[0].id as string;
    await owner.query(`INSERT INTO periods (company_id, start_date, end_date) VALUES ($1, '2026-01-01', '2026-12-31') ON CONFLICT DO NOTHING`, [used.companyId]);
    const cash = await acc('1000'), sales = await acc('4000');
    await as(finance, (db) => postEntry(db, sale({ id: used.companyId, cash, sales } as never, '2026-03-01', '5.00')));
    expect(await n('SELECT count(*) AS n FROM journal_entries WHERE company_id = $1', [used.companyId])).toBe(1);
    expect((await remove(used.firmId)).statusCode).toBe(200);
    const row = (await listed(used.firmId))!;
    expect(row.eraseBlockers).toContain('entries');
    const before = await everything(used.firmId, used.companyId);
    const r = await erase(used.firmId, used.name);
    expect(r.statusCode).toBe(409);
    expect(r.json().key).toBe('err.eraseUsed');
    expect(r.json().details).toContain('entries');
    expect(await everything(used.firmId, used.companyId)).toEqual(before);
    expect(await n('SELECT count(*) AS n FROM journal_entries WHERE company_id = $1', [used.companyId])).toBe(1);
    // even the owner's own database function refuses it, whatever the screen did
    await expect(as(f.platformOwner, (db) => db.query('SELECT owner_erase_tenant($1, $2)', [used.firmId, used.name]))).rejects.toThrow(/used the books/);
    expect(await everything(used.firmId, used.companyId)).toEqual(before);
    expect(await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgenabled = 'D' AND NOT tgisinternal`)).toBe(0);
  });

  it('names each kind of use that blocks it, and a draft or a plain contact does not', async () => {
    const x = await newCustomer('Blockers');
    const blockers = async () => (await owner.query('SELECT erase_blockers($1) AS b', [x.firmId])).rows[0].b as string[];
    expect(await blockers()).toEqual([]);
    // a Nusuh invoice to the customer
    await owner.query(`INSERT INTO billing_invoices (firm_id, number, customer_name, plan_name, cycle, period_start, period_end, issued_on, due_on, currency, lines, subtotal, vat_rate, vat, total)
      VALUES ($1, $2, 'X', 'Nusuh', 'monthly', '2026-01-01', '2026-01-31', '2026-01-01', '2026-01-15', 'SAR', '[]', 100, 15, 15, 115)`, [x.firmId, `ERASE-${stamp()}`]);
    expect(await blockers()).toEqual(['billing']);
    // a paid order
    await owner.query(`INSERT INTO trial_orders (firm_id, status, currency, lines, one_time_total, yearly_total) VALUES ($1, 'paid', 'SAR', '[]', 0, 0)`, [x.firmId]);
    expect(await blockers()).toEqual(['billing', 'paid']);
    // an unpaid, waiting order does not block
    const y = await newCustomer('Waiting');
    await owner.query(`INSERT INTO trial_orders (firm_id, status, currency, lines, one_time_total, yearly_total) VALUES ($1, 'waiting', 'SAR', '[]', 0, 0)`, [y.firmId]);
    expect((await owner.query('SELECT erase_blockers($1) AS b', [y.firmId])).rows[0].b).toEqual([]);
    expect((await remove(y.firmId)).statusCode).toBe(200);
    expect((await erase(y.firmId, y.name)).statusCode).toBe(200);   // the waiting order went with it
    expect(await n('SELECT count(*) AS n FROM trial_orders WHERE firm_id = $1', [y.firmId])).toBe(0);
  });
});

describe('A customer that something else still points at', () => {
  it('is refused cleanly and nothing is deleted, however far the erase had got', async () => {
    const h = await newCustomer('Hooked'), host = await newCustomer('Host');
    const hookUser = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [h.userEmail])).rows[0].id as string;
    // a tick in ANOTHER customer's checklist, made by one of this customer's people
    const c = await owner.connect();
    try { await c.query(`SELECT set_config('app.user_id', $1, false)`, [hookUser]); await c.query(`INSERT INTO checklist_ticks (company_id, item_key, done_by) VALUES ($1, 'hook', $2)`, [host.companyId, hookUser]); } finally { await c.query(`SELECT set_config('app.user_id', '', false)`).catch(() => undefined); c.release(); }
    await remove(h.firmId);
    const before = await everything(h.firmId, h.companyId);
    const r = await erase(h.firmId, h.name);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().key).toBe('err.eraseTied');
    expect(await everything(h.firmId, h.companyId)).toEqual(before);
    expect(await n(`SELECT count(*) AS n FROM checklist_ticks WHERE company_id = $1`, [host.companyId])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgenabled = 'D' AND NOT tgisinternal`)).toBe(0);
  });
  it('a support notice a person of the customer wrote to the platform owner goes with them', async () => {
    const x = await newCustomer('Notices');
    const u = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [x.userEmail])).rows[0].id as string;
    const platformFirm = (await owner.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0].id as string;
    await owner.query(`INSERT INTO email_outbox (firm_id, kind, to_email, subject, body_text, body_html, created_by) VALUES ($1, 'notice', 'owner@nusuh.example.com', 'Support', 'hello', '<p>hello</p>', $2)`, [platformFirm, u]);
    await remove(x.firmId);
    expect((await erase(x.firmId, x.name)).statusCode).toBe(200);
    expect(await n(`SELECT count(*) AS n FROM email_outbox WHERE created_by = $1`, [u])).toBe(0);
  });
});

describe('Nobody but the owner', () => {
  it('cannot erase, list the blockers or call the engine', async () => {
    const x = await newCustomer('Guarded');
    await remove(x.firmId);
    const admin = (await server.inject({ method: 'POST', url: '/api/login', payload: { email: x.userEmail.replace('fin.', 'admin.'), password: PW } }));
    // the customer is removed so its people cannot sign in at all; use a person of another customer instead
    expect(admin.statusCode).toBe(403);
    const other = await newCustomer('Bystander');
    const c = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email: other.userEmail, password: PW } })).headers['set-cookie']).split(';')[0]!;
    expect((await erase(x.firmId, x.name, c)).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: `/api/owner/tenants/${x.firmId}/erase`, payload: { confirmName: x.name } })).statusCode).toBe(401);
    await expect(as(f.partner, (db) => db.query('SELECT owner_erase_tenant($1, $2)', [x.firmId, x.name]))).rejects.toThrow(/platform owner/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT erase_firm_data($1)`, [x.firmId]))).rejects.toThrow(/permission denied/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT erase_rows('firms'::regclass, 'true', ARRAY[]::oid[], $1)`, [x.firmId]))).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`INSERT INTO erasure_log (firm_id, firm_name, firm_kind, companies, users, rows_deleted) VALUES ($1, 'x', 'company', 0, 0, 0)`, [x.firmId])).rejects.toThrow(/permission denied/);
    expect(await n('SELECT count(*) AS n FROM firms WHERE id = $1', [x.firmId])).toBe(1);
  });
});
