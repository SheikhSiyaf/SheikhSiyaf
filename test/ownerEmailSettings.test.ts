// The owner's Settings page and the verified change of sign-in email (db/migrations/0069_owner_email_settings.sql):
// the change happens only through a link sent to the NEW address after the password (and two-factor code), a changed
// sign-in email ends every older sign-in, a backup email counts only after its own link, the test email goes only to the
// owner's own addresses and is limited, and links are scrubbed from the stored copy once sent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { sendQueued } from '../src/email/mailer.js';
import type { Fetch } from '../src/email/transport.js';

const PW = 'pw-123456789';
let f: Fixture;
let server: FastifyInstance;
let ownerId = '', mainEmail = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

beforeAll(async () => {
  f = await seed();
  ownerId = f.platformOwner;
  mainEmail = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), ownerId])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret', publicUrl: 'https://books.example.com' });
});
const providerBefore = process.env.EMAIL_PROVIDER;
afterAll(async () => { await server?.close(); if (providerBefore === undefined) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = providerBefore; });

async function signIn(email: string): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (cookie: string, url: string) => server.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object = {}) => server.inject({ method: 'POST', url, headers: { cookie }, payload });
/** The link token inside the newest waiting email to an address. */
async function tokenSentTo(email: string): Promise<string> {
  const r = await owner.query(`SELECT body_text FROM email_outbox WHERE lower(to_email) = lower($1) AND kind = 'notice' AND body_text LIKE '%/confirm-email/%' ORDER BY created_at DESC LIMIT 1`, [email]);
  const m = /\/confirm-email\/([A-Za-z0-9_-]+)/.exec(r.rows[0]?.body_text ?? '');
  expect(m, `a confirmation link was mailed to ${email}`).toBeTruthy();
  return m![1]!;
}

describe('Owner settings', () => {
  it('shows the owner their sign-in email, an empty backup email and the email service without its key; nobody else may see it', async () => {
    const c = await signIn(mainEmail);
    const r = await get(c, '/api/owner/settings');
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ email: mainEmail, backupEmail: null, backupVerified: false });
    expect(JSON.stringify(s)).not.toMatch(/re_[A-Za-z0-9]{6}/);
    expect(s.service).toHaveProperty('keySet');
    expect(s.service).not.toHaveProperty('key');
    // a client user and an unsigned visitor are refused
    const clientEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [f.a.clientAccountant])).rows[0].email;
    await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), f.a.clientAccountant]);
    const cc = await signIn(clientEmail);
    expect((await get(cc, '/api/owner/settings')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(cc, '/api/owner/settings/test-email')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await server.inject({ method: 'GET', url: '/api/owner/settings' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('changes the backup email only through a link sent to it, and the owner is told', async () => {
    const c = await signIn(mainEmail);
    const backup = `backup.${stamp()}@example.org`;
    expect((await post(c, '/api/me/email-change', { purpose: 'backup', newEmail: backup, password: 'wrong-password-1' })).statusCode).toBe(401);
    const asked = await post(c, '/api/me/email-change', { purpose: 'backup', newEmail: backup, password: PW });
    expect(asked.statusCode, asked.body).toBe(200);
    // not counted yet
    expect((await get(c, '/api/owner/settings')).json()).toMatchObject({ backupEmail: null, backupVerified: false });
    const token = await tokenSentTo(backup);
    expect((await server.inject({ method: 'GET', url: `/api/email-change/${token}` })).json()).toMatchObject({ purpose: 'backup', newEmail: backup });
    // opening the link changes nothing; pressing the button does
    expect((await get(c, '/api/owner/settings')).json().backupVerified).toBe(false);
    const done = await server.inject({ method: 'POST', url: `/api/email-change/${token}` });
    expect(done.statusCode, done.body).toBe(200);
    expect((await get(c, '/api/owner/settings')).json()).toMatchObject({ backupEmail: backup, backupVerified: true });
    // the same link cannot be used again
    expect((await server.inject({ method: 'POST', url: `/api/email-change/${token}` })).statusCode).toBe(404);
    // the main email was told
    const told = await owner.query(`SELECT 1 FROM email_outbox WHERE lower(to_email) = lower($1) AND subject LIKE '%backup email was added%'`, [mainEmail]);
    expect(told.rowCount).toBeGreaterThan(0);
  });

  it('sends a test email only to the owner\'s own addresses, now, through the real queue; says plainly when no email service is set; limits how often', async () => {
    const c = await signIn(mainEmail);
    const backup = (await get(c, '/api/owner/settings')).json().backupEmail as string;
    const mine = new Set([mainEmail.toLowerCase(), backup.toLowerCase()]);
    const age = () => owner.query(`UPDATE email_tests SET created_at = created_at - interval '1 minute' WHERE user_id = $1`, [ownerId]);

    // 1. no email service set: the test waits and the page can say why (nothing is lost)
    delete process.env.EMAIL_PROVIDER;
    const held = await post(c, '/api/owner/settings/test-email');
    expect(held.statusCode, held.body).toBe(200);
    const heldTests = (held.json().tests as { to: string; status: string; lastError: string | null }[]).slice(0, 2);
    expect(heldTests.every((t) => mine.has(t.to) && t.status === 'queued' && /No email provider/.test(t.lastError ?? ''))).toBe(true);
    expect((await post(c, '/api/owner/settings/test-email')).json().key).toBe('err.testWait');   // pressed again straight away
    await age();

    // 2. an email service is set: the test goes out at once, only to the owner's addresses
    process.env.EMAIL_PROVIDER = 'log';
    const press = await post(c, '/api/owner/settings/test-email');
    expect(press.statusCode, press.body).toBe(200);
    const newest = (press.json().tests as { to: string; status: string }[]).slice(0, 2);
    expect(newest.length).toBe(2);
    expect(newest.every((t) => mine.has(t.to) && t.status === 'sent')).toBe(true);
    const everyone = await owner.query(`SELECT DISTINCT lower(to_email) AS a FROM email_tests WHERE user_id = $1`, [ownerId]);
    expect(everyone.rows.every((r) => mine.has(r.a))).toBe(true);
    await age();

    // 3. five presses a day, then no more
    let stopped = false;
    for (let i = 0; i < 6 && !stopped; i++) {
      const r = await post(c, '/api/owner/settings/test-email');
      await age();
      if (r.statusCode !== 200) { expect(r.json().key).toBe('err.testLimit'); stopped = true; }
    }
    expect(stopped).toBe(true);
  });

  it('changes the sign-in email only through a link to the new address, ends every older sign-in, tells the old address, and refuses addresses in use', async () => {
    const c = await signIn(mainEmail);
    const fresh = `newmain.${stamp()}@example.org`;
    // wrong password, same address, and an address another account uses are all refused (the last one without saying why)
    expect((await post(c, '/api/me/email-change', { purpose: 'main', newEmail: fresh, password: 'nope-nope-1' })).statusCode).toBe(401);
    expect((await post(c, '/api/me/email-change', { purpose: 'main', newEmail: mainEmail, password: PW })).statusCode).toBe(400);
    const used = (await owner.query('SELECT email FROM users WHERE id = $1', [f.a.clientAccountant])).rows[0].email;
    const taken = await post(c, '/api/me/email-change', { purpose: 'main', newEmail: used, password: PW });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().key).toBe('err.emailChangeTaken');

    expect((await post(c, '/api/me/email-change', { purpose: 'main', newEmail: fresh, password: PW })).statusCode).toBe(200);
    // still the old address until the link is used
    expect((await get(c, '/api/me')).json().user.email).toBe(mainEmail);
    const token = await tokenSentTo(fresh);
    // an expired link does nothing
    await owner.query(`UPDATE email_change_requests SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]);
    expect((await server.inject({ method: 'POST', url: `/api/email-change/${token}` })).statusCode).toBe(404);
    // a fresh request works
    expect((await post(c, '/api/me/email-change', { purpose: 'main', newEmail: fresh, password: PW })).statusCode).toBe(200);
    const token2 = await tokenSentTo(fresh);
    const done = await server.inject({ method: 'POST', url: `/api/email-change/${token2}` });
    expect(done.statusCode, done.body).toBe(200);
    // the old cookie no longer works; the new address signs in; the old one does not
    expect((await get(c, '/api/me')).statusCode).toBe(401);
    const c2 = await signIn(fresh);
    expect((await get(c2, '/api/me')).json().user.email).toBe(fresh);
    expect((await server.inject({ method: 'POST', url: '/api/login', payload: { email: mainEmail, password: PW } })).statusCode).toBe(401);
    // the old address (and the verified backup) were told
    const told = await owner.query(`SELECT to_email FROM email_outbox WHERE subject LIKE '%sign-in email was changed%' AND body_text LIKE $1`, [`%${fresh}%`]);
    expect(told.rows.map((r) => String(r.to_email).toLowerCase())).toContain(mainEmail.toLowerCase());
    mainEmail = fresh;
  });

  it('keeps the link out of the stored copy of an email once it has been sent', async () => {
    const c = await signIn(mainEmail);
    const target = `scrub.${stamp()}@example.org`;
    await post(c, '/api/me/email-change', { purpose: 'backup', newEmail: target, password: PW });
    const fake: Fetch = async () => ({ ok: true, status: 200, text: async () => '{"id":"msg_scrub"}' });
    await sendQueued(appPool, { limit: 50, cfg: { provider: 'resend', from: 'Nusuh Books <no-reply@send.example.com>', key: 're_test' }, fetchFn: fake });
    const row = (await owner.query(`SELECT body_text, body_html, status FROM email_outbox WHERE lower(to_email) = lower($1) ORDER BY created_at DESC LIMIT 1`, [target])).rows[0];
    expect(row.status).toBe('sent');
    expect(row.body_text).not.toMatch(/confirm-email\/[A-Za-z0-9_-]{20,}/);
    expect(row.body_html).not.toMatch(/confirm-email\/[A-Za-z0-9_-]{20,}/);
  });

  it('gives a client user no backup email, but the same verified way to change their own sign-in email', async () => {
    const clientEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [f.a.clientAccountant])).rows[0].email;
    const c = await signIn(clientEmail);
    const s = (await get(c, '/api/me/email-settings')).json();
    expect(s).toMatchObject({ email: clientEmail, backupEmail: null, backupVerified: false });
    const refused = await post(c, '/api/me/email-change', { purpose: 'backup', newEmail: `x.${stamp()}@example.org`, password: PW });
    expect(refused.statusCode).toBe(403);
    expect((await get(c, '/api/owner/settings')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(c, '/api/me/email-change', { purpose: 'main', newEmail: `client.new.${stamp()}@example.org`, password: PW })).statusCode).toBe(200);
  });
});
