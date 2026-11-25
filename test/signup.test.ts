// Self-service sign-up: the rules, the e-mailed link, one trial per person and per company, and the attacks that must fail.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { comparisonForm, isDisposable, normalizeEmail, parseSignup, passwordProblem } from '../src/books/signupRules.js';

const PEPPER = 'p'.repeat(40);
const GOOD = 'Correct-Horse-9';
let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const cr = () => String(Math.floor(1e9 + Math.random() * 9e9));
let ipn = 10;
const nextIp = () => `10.77.${(ipn >> 8) & 255}.${ipn++ & 255}`;

describe('The rules', () => {
  it('cleans an address and refuses nonsense', () => {
    expect(normalizeEmail('  Ali.Hassan@Example.COM ')).toBe('ali.hassan@example.com');
    for (const bad of ['', 'a', 'no-at.com', 'a@b', 'a b@c.com', 'a@@c.com', '<x>@c.com', 'a@c.com,b@d.com', 'a@-c.com', '.a@c.com', 'a..b@c.com', 'x'.repeat(70) + '@c.com', 123, null, undefined, { a: 1 }])
      expect(normalizeEmail(bad as never), String(bad)).toBeNull();
    expect(normalizeEmail('user@münchen.de')).toBe('user@xn--mnchen-3ya.de');
  });
  it('treats Gmail dots, +tags and googlemail as the same mailbox, and +tags elsewhere', () => {
    const same = ['a.b.c@gmail.com', 'abc@gmail.com', 'a.b.c+trial2@gmail.com', 'abc@googlemail.com'].map((e) => comparisonForm(e));
    expect(new Set(same).size).toBe(1);
    expect(comparisonForm('sam+x@company.com')).toBe(comparisonForm('sam@company.com'));
    expect(comparisonForm('s.am@company.com')).not.toBe(comparisonForm('sam@company.com'));   // dots matter outside Gmail
  });
  it('spots throwaway mailboxes, also on subdomains', () => {
    expect(isDisposable('x@mailinator.com')).toBe(true);
    expect(isDisposable('x@eu.mailinator.com')).toBe(true);
    expect(isDisposable('x@mycompany.com')).toBe(false);
    expect(isDisposable('x@notmailinator.com')).toBe(false);
  });
  it('wants a real password', () => {
    for (const bad of ['short1!', 'password123', 'aaaaaaaaaaaa', '1234567890', 'onlyletters', 'x'.repeat(201) + '1', 12345678901, null]) expect(passwordProblem(bad), String(bad)).toBe(true);
    expect(passwordProblem('ali.hassan-2026!', 'ali.hassan@x.com')).toBe(true);   // contains the e-mail name
    expect(passwordProblem(GOOD)).toBe(false);
    expect(passwordProblem('كلمة-سر-قوية-2026')).toBe(false);
  });
  it('checks every field of a request, including the registration number format', () => {
    const base = { fullName: 'Ali Hassan', email: 'ali@firm.example.com', password: GOOD, companyName: 'Hassan Trading', country: 'SA', crNumber: '1010101010', city: 'Riyadh', acceptTerms: true };
    expect(parseSignup(base)).toMatchObject({ ok: true });
    const bad = (patch: Record<string, unknown>) => (parseSignup({ ...base, ...patch }) as { problem?: string }).problem;
    expect(bad({ fullName: 'A' })).toBe('err.signupName');
    expect(bad({ fullName: ['Ali'] })).toBe('err.signupName');
    expect(bad({ companyName: '<script>' })).toBe('err.signupCompany');
    expect(bad({ email: 'nope' })).toBe('err.signupEmail');
    expect(bad({ email: 'x@mailinator.com' })).toBe('err.signupDisposable');
    expect(bad({ country: 'OM' })).toBe('err.signupCountry');
    expect(bad({ crNumber: '12345' })).toBe('err.signupCr');
    expect(bad({ crNumber: '10101010AB' })).toBe('err.signupCr');
    expect(bad({ country: 'AE', crNumber: '12-3' })).toBe('err.signupCr');
    expect(parseSignup({ ...base, country: 'AE', crNumber: 'CN-1234567' })).toMatchObject({ ok: true });
    expect(bad({ city: '' })).toBe('err.signupCity');
    expect(bad({ password: 'weak' })).toBe('err.signupPassword');
    expect(bad({ acceptTerms: 'yes' })).toBe('err.signupTerms');
    expect((parseSignup({ ...base, crNumber: '1010 1010-10' }) as { value: { crNumber: string } }).value.crNumber).toBe('1010101010');
  });
});

describe('Signing up', () => {
  let f: Fixture; let on: FastifyInstance; let off: FastifyInstance; let ownerCookie = '';
  beforeAll(async () => {
    f = await seed();
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword('pw-123456'), f.platformOwner])).rows[0].email;
    on = buildServer({ pool: appPool, sessionSecret: 'signup-secret', trustProxy: 1, publicUrl: 'https://app.example', signup: { enabled: true, pepper: PEPPER } });
    off = buildServer({ pool: appPool, sessionSecret: 'signup-secret-2' });
    ownerCookie = String((await on.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-123456' }, headers: { 'x-forwarded-for': nextIp() } })).headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await on?.close(); await off?.close(); });

  const form = (o: Record<string, unknown> = {}) => { const s = uniq(); return { fullName: 'Test Person', email: `p.${s}@throwaway-test.example.com`, password: GOOD, companyName: `Test Co ${s}`, country: 'SA', crNumber: cr(), city: 'Riyadh', acceptTerms: true, lang: 'en', ...o }; };
  const post = (body: unknown, ip = nextIp(), server = on) => server.inject({ method: 'POST', url: '/api/signup', payload: body as never, headers: { 'x-forwarded-for': ip } });
  const verify = (token: string, ip = nextIp()) => on.inject({ method: 'POST', url: '/api/signup/verify', payload: { token }, headers: { 'x-forwarded-for': ip } });
  const mails = async (to: string) => (await owner.query(`SELECT subject, body_text FROM email_outbox WHERE to_email = $1 AND kind = 'signup' ORDER BY created_at`, [to])).rows;
  const tokenOf = async (to: string) => /\/verify\/([A-Za-z0-9_-]{43})/.exec((await mails(to)).map((m) => m.body_text).join('\n'))?.[1] ?? '';
  const firmsNamed = async (name: string) => Number((await owner.query(`SELECT count(*) AS n FROM firms WHERE name = $1`, [name])).rows[0].n);

  it('is closed unless switched on, and says what is open', async () => {
    expect((await on.inject({ method: 'GET', url: '/api/signup/config' })).json()).toEqual({ enabled: true, google: false });
    expect((await off.inject({ method: 'GET', url: '/api/signup/config' })).json()).toEqual({ enabled: false, google: false });
    const r = await post(form(), nextIp(), off);
    expect(r.statusCode).toBe(403);
    expect(r.json().key).toBe('err.signupOff');
  });

  it('creates nothing until the link is opened, then makes the company, its only user and a 15-day trial in one go', async () => {
    const b = form();
    const r = await post(b);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ status: 'sent' });
    expect(await firmsNamed(b.companyName)).toBe(0);
    expect(Number((await owner.query('SELECT count(*) AS n FROM users WHERE lower(email) = $1', [b.email])).rows[0].n)).toBe(0);
    const m = await mails(b.email);
    expect(m).toHaveLength(1);
    expect(m[0]!.body_text).toContain('https://app.example/verify/');
    const v = await verify(await tokenOf(b.email));
    expect(v.statusCode, v.body).toBe(200);
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^[^=]+=.+/);
    const me = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.user.email.toLowerCase()).toBe(b.email);
    expect(me.canManageUsers).toBe(true);
    expect(me.companies).toHaveLength(1);
    const firm = (await owner.query(`SELECT id, kind FROM firms WHERE name = $1`, [b.companyName])).rows[0];
    expect(firm.kind).toBe('company');
    const sub = (await owner.query(`SELECT status, cycle, notes, trial_ends_at, trial_started_at FROM subscriptions WHERE firm_id = $1`, [firm.id])).rows[0];
    expect(sub).toMatchObject({ status: 'trial', cycle: 'yearly', notes: 'Self-service sign-up' });
    expect(Math.round((sub.trial_ends_at - sub.trial_started_at) / 864e5)).toBe(15);
    const co = (await owner.query(`SELECT cr_number, country, currency, modules, vat_status, city FROM companies WHERE firm_id = $1`, [firm.id])).rows[0];
    expect(co).toMatchObject({ cr_number: b.crNumber, country: 'SA', currency: 'SAR', modules: [], vat_status: 'unregistered', city: 'Riyadh' });
    expect(Number((await owner.query('SELECT count(*) AS n FROM accounts a JOIN companies c ON c.id = a.company_id WHERE c.firm_id = $1', [firm.id])).rows[0].n)).toBeGreaterThan(20);   // its chart of accounts
    // the person signs in with the password they chose, and can use the books and manage users
    const login = await on.inject({ method: 'POST', url: '/api/login', payload: { email: b.email, password: b.password }, headers: { 'x-forwarded-for': nextIp() } });
    expect(login.statusCode).toBe(200);
    const trial = (await on.inject({ method: 'GET', url: '/api/trial', headers: { cookie } })).json();
    expect(trial).toMatchObject({ level: 'full', trialing: true });
    expect(trial.daysLeft).toBeGreaterThanOrEqual(15);
    expect((await on.inject({ method: 'GET', url: '/api/setup', headers: { cookie } })).json().setup).toMatchObject({ inTrial: true, show: true });
    const perms = (await owner.query(`SELECT r.permissions, r.can_approve FROM memberships m JOIN client_roles r ON r.id = m.client_role_id JOIN users u ON u.id = m.user_id WHERE lower(u.email) = $1`, [b.email])).rows[0];
    expect(Object.values(perms.permissions).every((x) => x === 'edit')).toBe(true);
    // other customers' Owner titles are untouched
    expect(Number((await owner.query(`SELECT count(*) AS n FROM client_roles WHERE name = 'Owner' AND firm_id <> $1 AND permissions = $2::jsonb`, [firm.id, perms.permissions])).rows[0].n)).toBeLessThan(Number((await owner.query(`SELECT count(*) AS n FROM client_roles WHERE name = 'Owner'`)).rows[0].n));
  });

  it('answers the same whether or not the address is already a customer, and tells only the mailbox owner', async () => {
    const a = form(); await post(a); await verify(await tokenOf(a.email));
    const again = await post(form({ email: a.email }));   // a new company with the same address
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'sent' });
    const m = await mails(a.email);
    expect(m).toHaveLength(2);
    expect(m[1]!.subject).toBe('You already have a Nusuh Books account');
    expect(m[1]!.body_text).not.toContain('/verify/');
    const fresh = form(); const r = await post(fresh);
    expect(r.json()).toEqual(again.json());
  });

  it('counts "a.b+trial@gmail.com" and "ab@gmail.com" as the same person, even for the same address in another case', async () => {
    const s = uniq().replace(/[^a-z0-9]/g, '').slice(0, 10);
    const first = form({ email: `${s.slice(0, 4)}.${s.slice(4)}@gmail.com` });
    await post(first); await verify(await tokenOf(first.email.toLowerCase()));
    for (const variant of [`${s}@gmail.com`, `${s}+second@gmail.com`, `${s.slice(0, 2)}.${s.slice(2)}@GoogleMail.com`, first.email.toUpperCase()]) {
      const to = normalizeEmail(variant)!;
      const linksBefore = (await mails(to)).filter((m) => m.body_text.includes('/verify/')).length;
      const r = await post(form({ email: variant }));
      expect(r.statusCode, variant).toBe(200);
      expect((await mails(to)).filter((m) => m.body_text.includes('/verify/')).length, variant).toBe(linksBefore);   // no new confirmation link
      expect(Number((await owner.query(`SELECT count(*) AS n FROM signup_requests WHERE status = 'pending' AND company_name LIKE 'Test Co %' AND email = $1`, [to])).rows[0].n), variant).toBe(0);
    }
  });

  it('allows one trial per company registration number, also when the number is typed with spaces or dashes', async () => {
    const number = cr();
    const a = form({ crNumber: number }); await post(a); await verify(await tokenOf(a.email));
    for (const typed of [number, `${number.slice(0, 4)} ${number.slice(4, 7)}-${number.slice(7)}`]) {
      const r = await post(form({ crNumber: typed }));
      expect(r.statusCode, typed).toBe(409);
      expect(r.json().key).toBe('err.signupOrgUsed');
    }
    // a company the owner created by hand with that number counts too
    const hand = cr();
    const made = await on.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name: `By hand ${uniq()}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: hand, vatStatus: 'unregistered', address: 'Road', city: 'Riyadh', modules: [] },
      users: [{ name: 'Admin', email: `a.${uniq()}@hand.example.com`, jobTitle: 'Administrator' }, { name: 'Owner', email: `o.${uniq()}@hand.example.com`, jobTitle: 'Owner' }] } });
    expect(made.statusCode, made.body).toBe(200);
    expect((await post(form({ crNumber: hand }))).statusCode).toBe(409);
  });

  it('a link works once, only in the right form, and only for 24 hours', async () => {
    const b = form(); await post(b);
    const token = await tokenOf(b.email);
    for (const bad of ['', 'abc', 'x'.repeat(43), 'x'.repeat(44), "'; DROP TABLE users;--", token.slice(0, 42) + (token.endsWith('A') ? 'B' : 'A')]) {
      const r = await verify(bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().key).toBe('err.signupBadLink');
    }
    expect((await verify(token)).statusCode).toBe(200);
    const second = await verify(token);
    expect(second.statusCode).toBe(400);
    expect(await firmsNamed(b.companyName)).toBe(1);
    const c = form(); await post(c);
    await owner.query(`UPDATE signup_requests SET expires_at = now() - interval '1 minute' WHERE email = $1`, [c.email]);
    const late = await verify(await tokenOf(c.email));
    expect(late.json().key).toBe('err.signupExpired');
    expect(await firmsNamed(c.companyName)).toBe(0);
  });

  it('ten people opening the same link at the same moment make exactly one customer', async () => {
    const b = form(); await post(b);
    const token = await tokenOf(b.email);
    const results = await Promise.all(Array.from({ length: 10 }, () => verify(token)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await firmsNamed(b.companyName)).toBe(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM users WHERE lower(email) = $1', [b.email])).rows[0].n)).toBe(1);
  });

  it('ten requests for the same address at once leave one pending request and one e-mail', async () => {
    const e = `race.${uniq()}@throwaway-test.example.com`;
    await Promise.all(Array.from({ length: 10 }, () => post(form({ email: e }))));
    expect(Number((await owner.query(`SELECT count(*) AS n FROM signup_requests WHERE email = $1 AND status = 'pending'`, [e])).rows[0].n)).toBe(1);
    expect((await mails(e)).length).toBe(1);
  });

  it('a hidden robot field, a throwaway address, a weak password and a missing tick are all refused, and hostile input never crashes', async () => {
    const bot = form({ website: 'http://spam.example' });
    expect((await post(bot)).json()).toEqual({ status: 'sent' });
    expect(await mails(bot.email)).toHaveLength(0);
    expect(Number((await owner.query(`SELECT count(*) AS n FROM signup_requests WHERE email = $1`, [bot.email])).rows[0].n)).toBe(0);
    const keys = async (patch: Record<string, unknown>) => (await post(form(patch))).json().key;
    expect(await keys({ email: 'x@mailinator.com' })).toBe('err.signupDisposable');
    expect(await keys({ password: 'password123' })).toBe('err.signupPassword');
    expect(await keys({ acceptTerms: false })).toBe('err.signupTerms');
    for (const body of ['text', 42, null, [], { fullName: { $ne: 1 }, email: ['a@b.co'] }, { ...form(), companyName: "x'); DROP TABLE users;--" + 'y'.repeat(50), country: ['SA'] }, { ...form(), crNumber: { a: 1 } }]) {
      const r = await post(body);
      expect(r.statusCode, JSON.stringify(body)).toBeLessThan(500);
    }
    expect((await post({ ...form(), companyName: 'Quote\'s "Co" & <Sons> ' + uniq() })).statusCode).toBe(400);   // angle brackets are refused, never stored
    const huge = await on.inject({ method: 'POST', url: '/api/signup', payload: { ...form(), fullName: 'x'.repeat(2_000_000) } as never, headers: { 'x-forwarded-for': nextIp() } });
    expect(huge.statusCode).toBe(413);
  });

  it('stops one address from sending more than six requests an hour', async () => {
    const ip = nextIp();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(form(), ip)).statusCode);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
  });

  it('a link made earlier cannot create a second company once the number or address has been used since', async () => {
    const first = form(); await post(first);
    const sameCr = form({ crNumber: first.crNumber });   // refused at once, so make the second pending request by hand instead
    await owner.query(`INSERT INTO signup_requests (email, email_key, cr_key, full_name, company_name, country, cr_number, password_hash, token_hash, ip_key, expires_at)
      SELECT 'second.${uniq()}@x.example.com', 'ek-' || gen_random_uuid(), cr_key, 'Second', 'Second Co', 'SA', cr_number, password_hash, 'h-' || encode(gen_random_bytes(20), 'hex'), 'ip', now() + interval '1 day'
      FROM signup_requests WHERE email = $1`, [first.email]).catch(() => undefined);
    expect(sameCr.crNumber).toBe(first.crNumber);
    const t = await tokenOf(first.email);
    expect((await verify(t)).statusCode).toBe(200);
    expect(await firmsNamed(first.companyName)).toBe(1);
  });

  it('keeps the sign-up tables out of reach: no direct reads or writes by customers, no server-only functions for them', async () => {
    const b = form(); await post(b); await verify(await tokenOf(b.email));
    const uid = (await owner.query('SELECT id FROM users WHERE lower(email) = $1', [b.email])).rows[0].id;
    for (const sql of ['SELECT * FROM signup_requests', 'SELECT * FROM trial_fingerprints', 'DELETE FROM trial_fingerprints', 'INSERT INTO signup_events (kind) VALUES (\'started\')', 'UPDATE signup_events SET kind = \'started\'', 'DELETE FROM signup_events'])
      await expect(as(uid, (db) => db.query(sql)), sql).rejects.toThrow(/permission denied|Only/);
    await expect(as(uid, (db) => db.query("SELECT signup_begin('a@b.co', 'k', 'c', 'n', 'c', 'SA', '1', 'h', 't', 'i', 'en', 'Riyadh')"))).rejects.toThrow(/Only the server/);
    await expect(as(uid, (db) => db.query('SELECT signup_platform_owner()'))).rejects.toThrow(/Only the server/);
    await expect(as(uid, (db) => db.query("SELECT * FROM signup_take('x')"))).rejects.toThrow(/Only the server/);
    expect((await as(uid, (db) => db.query('SELECT * FROM signup_events'))).rows).toHaveLength(0);
  });

  it('shows the owner every attempt, allowed or refused, without passwords, tokens or full e-mails of refused tries', async () => {
    const b = form(); await post(b); await verify(await tokenOf(b.email));
    await post(form({ email: b.email }));
    const r = await on.inject({ method: 'GET', url: '/api/owner/signups', headers: { cookie: ownerCookie } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.enabled).toBe(true);
    const kinds = new Set(j.events.map((e: { kind: string }) => e.kind));
    for (const k of ['started', 'verified', 'blocked_email_used']) expect(kinds.has(k), k).toBe(true);
    const text = JSON.stringify(j);
    expect(text).not.toContain(b.password);
    expect(text).not.toContain(b.email);
    expect(text).not.toMatch(/"token"|token_hash|password_hash|scrypt\$/);
    const mine = j.events.find((e: { kind: string; company: string }) => e.kind === 'verified' && e.company === b.companyName);
    expect(mine).toMatchObject({ country: 'SA', emailDomain: 'throwaway-test.example.com' });
    expect(mine.firmId).toBeTruthy();
    const trials = (await on.inject({ method: 'GET', url: '/api/owner/trials', headers: { cookie: ownerCookie } })).json().trials as { firmName: string; source: string; setup: unknown }[];
    expect(trials.find((t) => t.firmName === b.companyName)).toMatchObject({ source: 'self' });
    const login = await on.inject({ method: 'POST', url: '/api/login', payload: { email: b.email, password: b.password }, headers: { 'x-forwarded-for': nextIp() } });
    const customerCookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await on.inject({ method: 'GET', url: '/api/owner/signups', headers: { cookie: customerCookie } })).statusCode).toBe(403);
    expect((await on.inject({ method: 'GET', url: '/api/owner/signups' })).statusCode).toBe(401);
  });

  it('a new company starts without its address and VAT details, is asked for them first, and can fill them in itself', async () => {
    const b = form(); await post(b);
    const v = await verify(await tokenOf(b.email));
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;
    const company = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().companies[0].id as string;
    const status = async () => (await on.inject({ method: 'GET', url: `/api/companies/${company}/checklist`, headers: { cookie } })).json() as { items: { key: string; done: boolean }[] };
    expect((await status()).items.find((x) => x.key === 'company')).toMatchObject({ key: 'company', done: false });   // the Owner is also the Administrator, so the company items reach them
    const edit = await on.inject({ method: 'POST', url: `/api/admin/companies/${company}`, headers: { cookie }, payload: { company: { name: b.companyName, crNumber: b.crNumber, legalForm: 'LLC', vatStatus: 'registered', vatNumber: `3${String(Math.floor(1e12 + Math.random() * 9e12)).slice(0, 13)}3`.slice(0, 15), address: 'King Fahd Road 1', city: 'Riyadh', industry: 'other' } } });
    expect(edit.statusCode, edit.body).toBe(200);
    expect((await status()).items.find((x) => x.key === 'company')!.done).toBe(true);   // it ticks itself once the address is real
    expect((await status()).items.find((x) => x.key === 'registration')!.done).toBe(true);
  });

  it('a self-service company can change only its address and VAT details: name, registration number and country stay locked, and other customers are out of reach', async () => {
    const a = form(), c = form(); await post(a); await post(c);
    const ca = String((await verify(await tokenOf(a.email))).headers['set-cookie']).split(';')[0]!;
    const cc = String((await verify(await tokenOf(c.email))).headers['set-cookie']).split(';')[0]!;
    const mine = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie: ca } })).json().companies[0].id as string;
    const theirs = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie: cc } })).json().companies[0].id as string;
    const save = (cookie: string, id: string, company: Record<string, unknown>) => on.inject({ method: 'POST', url: `/api/admin/companies/${id}`, headers: { cookie }, payload: { company } as never });
    const base = { legalForm: 'LLC', vatStatus: 'unregistered', address: 'Street 5', city: 'Jeddah', industry: 'other' };
    const r = await save(ca, mine, { ...base, name: 'RENAMED', crNumber: '9999999999', country: 'AE' });
    expect(r.statusCode, r.body).toBe(200);
    const row = (await owner.query('SELECT name, cr_number, country, address, city, vat_status, vat_rate::text AS vat_rate, vat_number FROM companies WHERE id = $1', [mine])).rows[0];
    expect(row).toMatchObject({ name: a.companyName, cr_number: a.crNumber, country: 'SA', address: 'Street 5', city: 'Jeddah', vat_status: 'unregistered', vat_rate: '0.00', vat_number: null });
    const reg = await save(ca, mine, { ...base, vatStatus: 'registered', vatNumber: '300012345600003' });
    expect(reg.statusCode, reg.body).toBe(200);
    expect((await owner.query('SELECT vat_status, vat_number, vat_rate::text AS r FROM companies WHERE id = $1', [mine])).rows[0]).toEqual({ vat_status: 'registered', vat_number: '300012345600003', r: '15.00' });
    // wrong things are explained, never a crash
    for (const bad of [{ ...base, vatStatus: 'registered', vatNumber: '12345' }, { ...base, vatStatus: 'registered' }, { ...base, address: '' }]) {
      const x = await save(ca, mine, bad); expect(x.statusCode, JSON.stringify(bad)).toBe(400);
    }
    // another customer's company, and a customer the owner made by hand, are refused
    expect((await save(ca, theirs, base)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await owner.query('SELECT address FROM companies WHERE id = $1', [theirs])).rows[0].address).toBe('To be completed in company settings');
    const made = await on.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name: `Hand ${uniq()}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: cr(), vatStatus: 'unregistered', address: 'Original road', city: 'Riyadh', modules: [] },
      users: [{ name: 'Admin', email: `a.${uniq()}@hand.example.com`, jobTitle: 'Administrator' }, { name: 'Owner', email: `o.${uniq()}@hand.example.com`, jobTitle: 'Owner' }] } });
    const handFirm = made.json().id as string;
    const adminEmail = (await owner.query(`SELECT email FROM users WHERE firm_id = $1 AND kind = 'admin'`, [handFirm])).rows[0].email;
    await owner.query('UPDATE users SET password_hash = $1, password_set_at = now() WHERE firm_id = $2', [await hashPassword('pw-123456'), handFirm]);
    const hc = String((await on.inject({ method: 'POST', url: '/api/login', payload: { email: adminEmail, password: 'pw-123456' }, headers: { 'x-forwarded-for': nextIp() } })).headers['set-cookie']).split(';')[0]!;
    const handCompany = (await owner.query('SELECT id FROM companies WHERE firm_id = $1', [handFirm])).rows[0].id as string;
    const refused = await save(hc, handCompany, { ...base, address: 'Changed' });
    expect(refused.statusCode).toBe(403);
    expect((await owner.query('SELECT address FROM companies WHERE id = $1', [handCompany])).rows[0].address).toBe('Original road');
    // the database function itself refuses everybody it should
    await expect(as(f.partner, (db) => db.query("SELECT self_company_update($1, 'LLC', 'x', 'y', 'unregistered', NULL, NULL, NULL, NULL)", [mine]))).rejects.toThrow(/Not allowed/);
  });

  it('shows the owner what became of each confirmation e-mail: waiting, sent, or failed with the e-mail service\'s own words', async () => {
    const b = form(); await post(b);
    const find = async () => ((await on.inject({ method: 'GET', url: '/api/owner/signups', headers: { cookie: ownerCookie } })).json().events as { kind: string; company: string; mail: { status: string; error: string | null } | null }[]).find((e) => e.kind === 'started' && e.company === b.companyName);
    expect((await find())!.mail).toMatchObject({ status: 'queued', error: null });
    await owner.query(`UPDATE email_outbox SET status = 'failed', last_error = 'The domain nusuhbooks.com is not verified', attempts = 3 WHERE to_email = $1 AND kind = 'signup'`, [b.email]);
    expect((await find())!.mail).toMatchObject({ status: 'failed', error: 'The domain nusuhbooks.com is not verified' });
    await owner.query(`UPDATE email_outbox SET status = 'sent', last_error = NULL WHERE to_email = $1 AND kind = 'signup'`, [b.email]);
    expect((await find())!.mail).toMatchObject({ status: 'sent' });
  });

  it('the new customer is separated from every other customer', async () => {
    const a = form(), b = form();
    await post(a); await post(b);
    const va = await verify(await tokenOf(a.email)); const vb = await verify(await tokenOf(b.email));
    const ca = String(va.headers['set-cookie']).split(';')[0]!, cb = String(vb.headers['set-cookie']).split(';')[0]!;
    const companyA = (await on.inject({ method: 'GET', url: '/api/me', headers: { cookie: ca } })).json().companies[0].id;
    expect((await on.inject({ method: 'GET', url: `/api/companies/${companyA}`, headers: { cookie: cb } })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await on.inject({ method: 'GET', url: '/api/owner/tenants', headers: { cookie: cb } })).statusCode).toBe(403);
    expect((await on.inject({ method: 'POST', url: `/api/owner/tenants/${(await owner.query('SELECT id FROM firms WHERE name = $1', [a.companyName])).rows[0].id}/trial/extend`, payload: { days: 30, reason: 'x' }, headers: { cookie: cb } })).statusCode).toBe(403);
  });
});
