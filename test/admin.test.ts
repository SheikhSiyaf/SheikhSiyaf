// Administrator console: suspension, invitations, staff and client management, activity log,
// settings and two-factor sign-in. Database rules first, then through the API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, sale, as, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { postEntry } from '../src/ledger/ledger.js';
import { base32Decode, totpCode } from '../src/auth/totp.js';
import { hashInviteToken } from '../src/api/auth.js';

const PW = 'right-password-1';
let f: Fixture;
let server: FastifyInstance;
const email: Record<string, string> = {};

beforeAll(async () => {
  f = await seed();
  const hash = await hashPassword(PW);
  for (const [k, id] of Object.entries({ admin: f.admin, partner: f.partner, staff: f.staff, reviewer: f.reviewer, clientA: f.a.clientAccountant })) {
    email[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
  }
  server = buildServer({ pool: appPool, sessionSecret: 'admin-test-secret' });
});
afterAll(async () => { await server.close(); });

async function signIn(e: string, password = PW): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: e, password } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object = {}) => server.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('Suspension (database)', () => {
  it('a suspended user sees nothing and cannot post; reactivating restores access', async () => {
    const { rows } = await as(f.partner, (db) => db.query('SELECT count(*)::int AS n FROM journal_entries'));
    await owner.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [f.reviewer]);
    expect((await as(f.reviewer, (db) => db.query('SELECT id FROM companies'))).rows).toEqual([]);
    expect((await as(f.reviewer, (db) => db.query('SELECT id FROM journal_entries'))).rows).toEqual([]);
    await owner.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [f.staff]);
    await expect(as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-01', '1.00')))).rejects.toThrow(/row-level security/);
    await owner.query(`UPDATE users SET status = 'active' WHERE id IN ($1, $2)`, [f.reviewer, f.staff]);
    expect((await as(f.reviewer, (db) => db.query('SELECT id FROM companies'))).rows.length).toBe(2);
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('a suspended client is hidden from everyone assigned to it, but the Administrator still lists it', async () => {
    await owner.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [f.b.id]);
    const seen = (await as(f.partner, (db) => db.query('SELECT id FROM companies'))).rows.map((r) => r.id);
    expect(seen).toEqual([f.a.id]);
    await expect(as(f.partner, (db) => postEntry(db, sale(f.b, '2026-03-01', '1.00')))).rejects.toThrow(/row-level security/);
    const adminSees = (await as(f.admin, (db) => db.query('SELECT id FROM companies'))).rows.map((r) => r.id);
    expect(adminSees.sort()).toEqual([f.a.id, f.b.id].sort());
    await owner.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [f.b.id]);
    expect((await as(f.partner, (db) => db.query('SELECT id FROM companies'))).rows.length).toBe(2);
  });
});

describe('Invitations (database)', () => {
  it('an invitation sets the password once, and an expired one is refused', async () => {
    const u = (await owner.query(
      `INSERT INTO users (firm_id, kind, full_name, email, staff_role, invite_token_hash, invite_expires_at)
       VALUES ($1, 'firm_staff', 'Invited', $2, 'reviewer', $3, now() + interval '1 day') RETURNING id`,
      [f.firmId, `invited.${Date.now()}@example.com`, hashInviteToken('tok-1')])).rows[0].id;
    expect((await appPool.query('SELECT accept_invite($1, $2) AS ok', [hashInviteToken('tok-1'), 'h1'])).rows[0].ok).toBe(true);
    expect((await appPool.query('SELECT accept_invite($1, $2) AS ok', [hashInviteToken('tok-1'), 'h2'])).rows[0].ok).toBe(false);
    expect((await owner.query('SELECT password_hash FROM users WHERE id = $1', [u])).rows[0].password_hash).toBe('h1');
    await owner.query(`UPDATE users SET invite_token_hash = $2, invite_expires_at = now() - interval '1 minute' WHERE id = $1`, [u, hashInviteToken('tok-2')]);
    expect((await appPool.query('SELECT accept_invite($1, $2) AS ok', [hashInviteToken('tok-2'), 'h3'])).rows[0].ok).toBe(false);
  });

  it('a user cannot turn their own two-factor off', async () => {
    await expect(as(f.partner, (db) => db.query(`SELECT set_own_totp('')`))).rejects.toThrow(/Administrator/);
  });
});

describe('Administrator console (API)', () => {
  it('only the Administrator reaches every admin route', async () => {
    const p = await signIn(email.partner!);
    for (const url of ['/api/admin/companies', '/api/admin/staff', '/api/admin/activity', '/api/admin/settings', `/api/admin/companies/${f.a.id}`]) {
      expect((await get(p, url)).statusCode, url).toBe(403);
    }
    expect((await post(p, '/api/admin/staff', { name: 'X', email: 'x@example.com', role: 'reviewer' })).statusCode).toBe(403);
    expect((await post(p, `/api/admin/users/${f.staff}/status`, { active: false })).statusCode).toBe(403);
  });

  it('adds a staff member with clients; the invitation sets their password once; they see only those clients', async () => {
    const a = await signIn(email.admin!);
    const newEmail = `new.staff.${Date.now()}@example.com`;
    const res = await post(a, '/api/admin/staff', { name: 'New Staff', email: newEmail, role: 'staff_accountant', clientIds: [f.b.id] });
    expect(res.statusCode, res.body).toBe(200);
    const { token } = res.json().invite;
    expect(token.length).toBeGreaterThan(30);

    expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email: newEmail, password: PW } })).statusCode).toBe(401);
    expect((await server.inject({ url: `/api/invite/${token}` })).json()).toMatchObject({ name: 'New Staff', email: newEmail });
    const short = await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: 'short' } });
    expect(short.json()).toMatchObject({ key: 'err.passwordShort' });
    expect((await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: PW } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { password: PW } })).json()).toMatchObject({ key: 'err.inviteInvalid' });

    const s = await signIn(newEmail);
    const me = (await get(s, '/api/me')).json();
    expect(me.companies.map((c: { id: string }) => c.id)).toEqual([f.b.id]);
    expect(me.companies[0].role).toBe('staff_accountant');

    // The token itself is never stored or logged.
    const leaked = await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE detail::text LIKE $1`, [`%${token}%`]);
    expect(leaked.rows[0].n).toBe(0);
  });

  it('assigns and unassigns staff from a client page', async () => {
    const a = await signIn(email.admin!);
    const r = await signIn(email.reviewer!);
    expect((await post(a, `/api/admin/companies/${f.a.id}/staff`, { userId: f.reviewer, assigned: false })).statusCode).toBe(200);
    expect((await get(r, '/api/me')).json().companies.map((c: { id: string }) => c.id)).toEqual([f.b.id]);
    const detail = (await get(a, `/api/admin/companies/${f.a.id}`)).json();
    expect(detail.staff.find((x: { id: string }) => x.id === f.reviewer).assigned).toBe(false);
    expect((await post(a, `/api/admin/companies/${f.a.id}/staff`, { userId: f.reviewer, assigned: true })).statusCode).toBe(200);
    expect((await get(r, '/api/me')).json().companies.length).toBe(2);
  });

  it('edits client details with the same checks as registration; the country cannot change', async () => {
    const a = await signIn(email.admin!);
    const { company } = (await get(a, `/api/admin/companies/${f.a.id}`)).json();
    const bad = await post(a, `/api/admin/companies/${f.a.id}`, { company: { ...company, vatNumber: '123' } });
    expect(bad.json()).toMatchObject({ key: 'err.saVat' });
    const ok = await post(a, `/api/admin/companies/${f.a.id}`, { company: { ...company, name: 'Renamed Co', country: 'AE', invoicePrefix: 'RC-', paymentTermsDays: '45' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = (await get(a, `/api/admin/companies/${f.a.id}`)).json().company;
    expect(after).toMatchObject({ name: 'Renamed Co', country: 'SA', invoicePrefix: 'RC-', paymentTermsDays: '45' });
  });

  it('registers a client and adds another client user, each with an invitation', async () => {
    const a = await signIn(email.admin!);
    const res = await post(a, '/api/admin/companies', {
      company: { name: 'Invite Co', country: 'SA', crNumber: saCr(), legalForm: 'LLC', vatStatus: 'registered', vatNumber: saVat(), address: 'S', city: 'R' },
      firstUser: { name: 'First', email: `first.${Date.now()}@example.com` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().invite.token).toBeTruthy();
    const add = await post(a, `/api/admin/companies/${res.json().id}/users`, { name: 'Second', email: `second.${Date.now()}@example.com`, role: 'client_viewer' });
    expect(add.statusCode, add.body).toBe(200);
    const users = (await get(a, `/api/admin/companies/${res.json().id}`)).json().users;
    expect(users.map((u: { role: string; invitePending: boolean }) => [u.role, u.invitePending]).sort()).toEqual([['client_accountant', true], ['client_viewer', true]]);
  });

  it('suspending a user blocks sign-in and ends their session; the Administrator cannot suspend themselves', async () => {
    const a = await signIn(email.admin!);
    const c = await signIn(email.clientA!);
    expect((await post(a, `/api/admin/users/${f.a.clientAccountant}/status`, { active: false })).statusCode).toBe(200);
    expect((await get(c, '/api/me')).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email: email.clientA, password: PW } })).json()).toMatchObject({ key: 'err.suspended' });
    expect((await post(a, `/api/admin/users/${f.a.clientAccountant}/status`, { active: true })).statusCode).toBe(200);
    expect((await get(c, '/api/me')).statusCode).toBe(200);
    expect((await post(a, `/api/admin/users/${f.admin}/status`, { active: false })).json()).toMatchObject({ key: 'err.selfSuspend' });
  });

  it('suspending a client hides it from its staff and users until reactivated', async () => {
    const a = await signIn(email.admin!);
    const p = await signIn(email.partner!);
    await post(a, `/api/admin/companies/${f.b.id}/status`, { active: false });
    expect((await get(p, '/api/me')).json().companies.map((c: { id: string }) => c.id)).not.toContain(f.b.id);
    expect((await get(p, `/api/companies/${f.b.id}`)).statusCode).toBe(404);
    expect((await get(a, '/api/admin/companies')).json().find((c: { id: string }) => c.id === f.b.id).status).toBe('suspended');
    await post(a, `/api/admin/companies/${f.b.id}/status`, { active: true });
    expect((await get(p, `/api/companies/${f.b.id}`)).statusCode).toBe(200);
  });

  it('the activity log shows client, user and access changes in plain terms, never ledger rows or secrets', async () => {
    const a = await signIn(email.admin!);
    const log = (await get(a, '/api/admin/activity')).json();
    const keys = new Set(log.map((r: { key: string }) => r.key));
    for (const k of ['act.userAdded', 'act.accessGiven', 'act.accessRemoved', 'act.clientUpdated', 'act.userSuspended', 'act.userReactivated', 'act.clientSuspended', 'act.inviteSent', 'act.passwordSet']) {
      expect(keys.has(k), k).toBe(true);
    }
    expect(JSON.stringify(log)).not.toMatch(/password_hash|invite_token_hash|totp_secret|journal/);
    const other = await seed();
    await owner.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(PW), other.admin]);
    const otherEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [other.admin])).rows[0].email;
    const o = await signIn(otherEmail);
    const otherLog = (await get(o, '/api/admin/activity')).json();
    expect(JSON.stringify(otherLog)).not.toContain('Renamed Co');
  });

  it('renames the firm and reports sign-in security', async () => {
    const a = await signIn(email.admin!);
    expect((await post(a, '/api/admin/settings', { firmName: '' })).json()).toMatchObject({ key: 'err.firmName' });
    expect((await post(a, '/api/admin/settings', { firmName: 'Renamed Firm' })).statusCode).toBe(200);
    const s = (await get(a, '/api/admin/settings')).json();
    expect(s.firmName).toBe('Renamed Firm');
    expect(s.users.total).toBeGreaterThan(5);
    expect(s.users.invitesPending).toBeGreaterThan(0);
  });
});

describe('Two-factor sign-in', () => {
  it('matches the RFC 6238 test vector', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpCode(secret, 59, 8)).toBe('94287082');
    expect(totpCode(secret, 1111111109, 8)).toBe('07081804');
  });

  it('set up, then sign-in needs the code; a wrong code is refused; the Administrator can reset it', async () => {
    const c = await signIn(email.partner!);
    const start = (await post(c, '/api/me/two-factor/start')).json();
    expect(start.uri).toMatch(/^otpauth:\/\/totp\//);
    const code = () => totpCode(base32Decode(start.secret), Math.floor(Date.now() / 1000));
    expect((await post(c, '/api/me/two-factor/confirm', { ticket: start.ticket, code: '000000' === code() ? '111111' : '000000' })).json()).toMatchObject({ key: 'err.code' });
    expect((await post(c, '/api/me/two-factor/confirm', { ticket: start.ticket, code: code() })).statusCode).toBe(200);
    expect((await get(c, '/api/me')).json().user.twoFactor).toBe(true);

    const step1 = await server.inject({ method: 'POST', url: '/api/login', payload: { email: email.partner, password: PW } });
    expect(step1.json()).toMatchObject({ twoFactor: true });
    expect(step1.headers['set-cookie']).toBeUndefined();
    const wrong = await server.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: step1.json().ticket, code: '000000' === code() ? '111111' : '000000' } });
    expect(wrong.statusCode).toBe(401);
    const right = await server.inject({ method: 'POST', url: '/api/login/two-factor', payload: { ticket: step1.json().ticket, code: code() } });
    expect(right.statusCode).toBe(200);
    expect(String(right.headers['set-cookie'])).toMatch(/nb_session=/);

    const stored = (await owner.query('SELECT totp_secret_enc FROM users WHERE id = $1', [f.partner])).rows[0].totp_secret_enc;
    expect(stored).not.toContain(start.secret);

    const a = await signIn(email.admin!);
    expect((await post(a, `/api/admin/users/${f.partner}/reset-two-factor`)).statusCode).toBe(200);
    const again = await server.inject({ method: 'POST', url: '/api/login', payload: { email: email.partner, password: PW } });
    expect(again.json()).toMatchObject({ ok: true });
  });

  it('five wrong passwords lock sign-in for that account for 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email: email.reviewer, password: 'wrong' } })).statusCode).toBe(401);
    }
    const blocked = await server.inject({ method: 'POST', url: '/api/login', payload: { email: email.reviewer, password: PW } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ key: 'err.tooMany' });
  });
});
