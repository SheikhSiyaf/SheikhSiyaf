// The website connection: Payment settings (names and prices of the plan the website sells), testimonials with their limit,
// and the one public, read-only answer the website asks for. Only the platform owner edits; the public answer holds
// nothing private. These tests use their own plan, so the shared "nusuh" plan other tests read is never changed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as W from '../src/books/websiteService.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
let server: FastifyInstance;
let planId: string;
let originalPlan: string;
let originalNames: unknown;
let cookie = '';
const PAY = 'Pw-123456';
const lines = (amounts: [string, string, string, string], names?: Partial<Record<W.LineKey, [string, string]>>): NonNullable<W.PaymentInput['lines']> =>
  (['implementation', 'cleanup', 'annualCore', 'perModule'] as const).map((key, i) => ({ key, amount: amounts[i], name: names?.[key]?.[0] ?? `Name ${key}`, nameAr: names?.[key]?.[1] ?? `اسم ${key}` }));
const ownerDo = <T>(fn: (db: Parameters<typeof as>[1] extends (db: infer D) => unknown ? D : never) => Promise<T>) => as(f.platformOwner, fn);
const get = (url: string, c = cookie) => server.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} });
const post = (url: string, payload: object, c = cookie) => server.inject({ method: 'POST', url, headers: { cookie: c }, payload });
const clearTestimonials = async () => { await owner.query('DELETE FROM website_testimonials'); await owner.query('UPDATE website_settings SET testimonial_limit = 8'); W.forgetPublicSiteData(); };
const tm = (n: number, extra: Partial<W.TestimonialInput> = {}): W.TestimonialInput => ({ name: `Person ${n}`, quote: `A real quote number ${n}.`, role: 'Finance manager', company: `Company ${n}`, consent: true, ...extra });

beforeAll(async () => {
  f = await seed();
  originalPlan = (await owner.query('SELECT plan_id FROM website_settings')).rows[0].plan_id;
  originalNames = (await owner.query('SELECT line_names FROM website_settings')).rows[0].line_names;
  planId = (await owner.query(`INSERT INTO plans (code, name, name_ar, for_kind, monthly_price, yearly_price, included_companies, included_users, annual, setup_price, implementation_price, extra_module_price, active)
    VALUES ('site_test_' || substr(md5(random()::text), 1, 8), 'Site Test', 'اختبار', 'any', 0, 1500, 100000, 100000, true, 9000, 5000, 500, false) RETURNING id`)).rows[0].id;
  await owner.query('UPDATE website_settings SET plan_id = $1', [planId]);
  await clearTestimonials();
  await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PAY), f.platformOwner]);
  const email = (await owner.query('SELECT email FROM users WHERE id = $1', [f.platformOwner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'website-secret', lockCacheMs: 0 });
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PAY } });
  expect(res.statusCode, res.body).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => {
  await clearTestimonials();
  await owner.query('UPDATE website_settings SET plan_id = $1, line_names = $2', [originalPlan, JSON.stringify(originalNames)]);
  W.forgetPublicSiteData();
  await server.close();
});

describe('Payment settings', () => {
  it('shows the plan the website sells, with its four lines in the website\'s order', async () => {
    const p = await ownerDo((db) => W.paymentSettings(db));
    expect(p.planName).toBe('Site Test');
    expect(p.lines.map((l) => [l.key, l.amount])).toEqual([['implementation', '9000.00'], ['cleanup', '5000.00'], ['annualCore', '1500.00'], ['perModule', '500.00']]);
    expect(p.currency).toBe('SAR');
  });

  it('only the platform owner can read or change them', async () => {
    await expect(as(f.admin, (db) => W.paymentSettings(db))).rejects.toMatchObject({ key: 'err.ownerOnly' });
    await expect(as(f.partner, (db) => W.savePaymentSettings(db, { lines: lines(['1', '1', '1', '1']), reason: 'x' }))).rejects.toMatchObject({ key: 'err.ownerOnly' });
    await expect(as(f.admin, (db) => db.query(`UPDATE plans SET setup_price = 1 WHERE id = $1`, [planId]))).resolves.toMatchObject({ rowCount: 0 });   // row-level security: not even visible
    expect((await get('/api/owner/payment-settings', '')).statusCode).toBe(401);
  });

  it('refuses prices that are not money, too big, or negative, and unknown or repeated lines', async () => {
    for (const bad of ['abc', '-5', '1000000.01', '1,000', '12.345', '', ' ']) {
      await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines([bad, '5000', '1500', '500']), reason: 'x' }))).rejects.toMatchObject({ key: 'err.priceFormat' });
    }
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: [...lines(['1', '1', '1', '1']).slice(0, 3), { key: 'bogus', amount: '1', name: 'x' }], reason: 'x' }))).rejects.toMatchObject({ key: 'err.format' });
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['1', '1', '1', '1']).slice(0, 3), reason: 'x' }))).rejects.toMatchObject({ key: 'err.format' });
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['1', '1', '1', '1']).map((l, i) => (i === 3 ? { ...l, key: 'implementation' } : l)), reason: 'x' }))).rejects.toMatchObject({ key: 'err.format' });
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['1', '1', '1', '1'], { cleanup: ['', 'x'] }), reason: 'x' }))).rejects.toMatchObject({ key: 'err.lineName' });
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['1', '1', '1', '1'], { cleanup: ['n'.repeat(61), ''] }), reason: 'x' }))).rejects.toMatchObject({ key: 'err.nameLong' });
    await expect(owner.query('UPDATE plans SET setup_price = 1000001 WHERE id = $1', [planId])).rejects.toThrow(/plans_prices_sane/);   // the database says no too
  });

  it('a change needs a reason; nothing changed writes nothing', async () => {
    const same = lines(['9000', '5000', '1500', '500'], { implementation: ['Implementation', 'التنفيذ'], cleanup: ['Accounts clean-up and setup', 'تنظيف الحسابات وإعدادها'], annualCore: ['Annual fee', 'الرسوم السنوية'], perModule: ['Extra module', 'وحدة إضافية'] });
    const unchanged = await ownerDo((db) => W.savePaymentSettings(db, { planName: 'Site Test', planNameAr: 'اختبار', lines: same }));
    expect(unchanged).toEqual({ changed: false, customersAffected: 0 });
    await expect(ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['9500', '5000', '1500', '500']), reason: '   ' }))).rejects.toMatchObject({ key: 'err.priceReason' });
    expect((await ownerDo((db) => W.paymentSettings(db))).lines[0]!.amount).toBe('9000.00');
  });

  it('saves prices and names, keeps what changed, who and why, and the public answer follows at once', async () => {
    // two customers on this plan: one paying, one on a trial (a trial does not pay)
    const g = await seed(), h = await seed();
    await owner.query(`INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, next_bill_on) VALUES ($1, $3, 'yearly', 'active', current_date, current_date + 365), ($2, $3, 'yearly', 'past_due', current_date, current_date + 365)`, [g.firmId, h.firmId, planId]);
    const r = await ownerDo((db) => W.savePaymentSettings(db, { planName: 'Nusuh Books 2027', lines: lines(['9500', '5000', '1800.50', '500'], { annualCore: ['Yearly fee', 'الرسوم السنوية الجديدة'] }), reason: 'New 2027 price list' }));
    expect(r).toEqual({ changed: true, customersAffected: 2 });
    const p = await ownerDo((db) => W.paymentSettings(db));
    expect([p.planName, ...p.lines.map((l) => l.amount)]).toEqual(['Nusuh Books 2027', '9500.00', '5000.00', '1800.50', '500.00']);
    expect(p.lines.find((l) => l.key === 'annualCore')).toMatchObject({ name: 'Yearly fee', nameAr: 'الرسوم السنوية الجديدة' });
    const h1 = p.history[0]!;
    expect(h1).toMatchObject({ reason: 'New 2027 price list', customersAffected: 2 });
    expect(h1.before['implementation.amount']).toBe('9000.00');
    expect(h1.after['implementation.amount']).toBe('9500.00');
    expect(Object.keys(h1.after)).not.toContain('perModule.amount');   // only what changed is kept
    await expect(owner.query('UPDATE plan_price_changes SET reason = $1', ['x'])).rejects.toThrow(/cannot be changed or deleted/);
    const audit = (await owner.query(`SELECT action, user_id FROM audit_log WHERE table_name = 'plans' AND row_id = $1 ORDER BY id DESC LIMIT 1`, [planId])).rows[0];
    expect(audit).toMatchObject({ action: 'update', user_id: f.platformOwner });
    const pub = JSON.parse((await W.publicSiteData(appPool, Date.now() + 60_000)).body);
    expect(pub.lines.map((l: { amount: string }) => Number(l.amount))).toEqual([9500, 5000, 1800.5, 500]);
  });

  it('issued invoices are never changed by a price change (billing keeps its own record)', async () => {
    const snapshot = async () => (await owner.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(id::text || subtotal::text || total::text || lines::text, ',' ORDER BY id)), '') AS h FROM billing_invoices`)).rows[0];
    const before = await snapshot();
    await ownerDo((db) => W.savePaymentSettings(db, { lines: lines(['9600', '5000', '1800.50', '500']), reason: 'Another change' }));
    expect(await snapshot()).toEqual(before);
  });
});

describe('Testimonials and their limit', () => {
  it('start empty; the public answer then has none', async () => {
    await clearTestimonials();
    const pub = JSON.parse((await W.publicSiteData(appPool, Date.now() + 120_000)).body);
    expect(pub.testimonials).toEqual({ limit: 8, items: [] });
  });

  it('adds, edits, hides, orders and deletes; the website sees only visible ones, in order', async () => {
    await clearTestimonials();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await ownerDo((db) => W.addTestimonial(db, tm(n)))).id);
    await ownerDo((db) => W.saveTestimonial(db, ids[1]!, tm(2, { name: 'Amal', nameAr: 'أمل', quote: 'Edited quote.', visible: false })));
    await ownerDo((db) => W.orderTestimonials(db, [ids[2], ids[0], ids[1]]));
    const edits = await ownerDo((db) => W.websiteEdits(db));
    expect(edits.items.map((i) => i.name)).toEqual(['Person 3', 'Person 1', 'Amal']);
    expect(edits).toMatchObject({ limit: 8, minLimit: 5, maxLimit: 10, loopAbove: 4 });
    const pub = JSON.parse((await W.publicSiteData(appPool, Date.now() + 180_000)).body);
    expect(pub.testimonials.items.map((i: { name: string }) => i.name)).toEqual(['Person 3', 'Person 1']);   // the hidden one is not public
    expect(Object.keys(pub.testimonials.items[0]).sort()).toEqual(['company', 'companyAr', 'name', 'nameAr', 'quote', 'quoteAr', 'role', 'roleAr']);
    await ownerDo((db) => W.deleteTestimonial(db, ids[0]!));
    expect((await ownerDo((db) => W.websiteEdits(db))).items).toHaveLength(2);
    await expect(ownerDo((db) => W.deleteTestimonial(db, ids[0]!))).rejects.toMatchObject({ status: 404 });
    const audit = (await owner.query(`SELECT action FROM audit_log WHERE table_name = 'website_testimonials' AND row_id = $1 ORDER BY id`, [ids[0]])).rows.map((r) => r.action);
    expect(audit).toEqual(['insert', 'update', 'delete']);
  });

  it('refuses a testimonial without the customer\'s permission, without a name or quote, or that is too long', async () => {
    await clearTestimonials();
    await expect(ownerDo((db) => W.addTestimonial(db, tm(1, { consent: false })))).rejects.toMatchObject({ key: 'err.tmConsent' });
    await expect(ownerDo((db) => W.addTestimonial(db, tm(1, { consent: undefined })))).rejects.toMatchObject({ key: 'err.tmConsent' });
    await expect(ownerDo((db) => W.addTestimonial(db, tm(1, { name: '  ' })))).rejects.toMatchObject({ key: 'err.tmName' });
    await expect(ownerDo((db) => W.addTestimonial(db, tm(1, { quote: '' })))).rejects.toMatchObject({ key: 'err.tmQuote' });
    await expect(ownerDo((db) => W.addTestimonial(db, tm(1, { quote: 'q'.repeat(301) })))).rejects.toMatchObject({ key: 'err.tmLong' });
    await expect(owner.query(`INSERT INTO website_testimonials (name, quote, consent) VALUES ('A', 'B', false)`)).rejects.toThrow();   // and the database refuses it too
    expect((await ownerDo((db) => W.websiteEdits(db))).items).toHaveLength(0);
  });

  it('keeps text as text: markup in a quote is returned unchanged, to be shown as plain text', async () => {
    await clearTestimonials();
    await ownerDo((db) => W.addTestimonial(db, tm(1, { quote: '<img src=x onerror=alert(1)> "quoted" & done' })));
    const pub = JSON.parse((await W.publicSiteData(appPool, Date.now() + 240_000)).body);
    expect(pub.testimonials.items[0].quote).toBe('<img src=x onerror=alert(1)> "quoted" & done');
  });

  it('the limit is 5 to 10 (8 to start); one more than the limit is refused, even by two adds at once', async () => {
    await clearTestimonials();
    for (const bad of [4, 11, 7.5, 'x', null]) await expect(ownerDo((db) => W.setTestimonialLimit(db, bad))).rejects.toMatchObject({ key: 'err.tmLimit' });
    await ownerDo((db) => W.setTestimonialLimit(db, 5));
    for (const n of [1, 2, 3, 4]) await ownerDo((db) => W.addTestimonial(db, tm(n)));
    const both = await Promise.allSettled([ownerDo((db) => W.addTestimonial(db, tm(5))), ownerDo((db) => W.addTestimonial(db, tm(6)))]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason?.message)).toMatch(/at most 5 testimonials/);
    expect((await ownerDo((db) => W.websiteEdits(db))).items).toHaveLength(5);
    await ownerDo((db) => W.setTestimonialLimit(db, 10));
    await ownerDo((db) => W.addTestimonial(db, tm(7)));
    expect((await ownerDo((db) => W.websiteEdits(db))).items).toHaveLength(6);
  });

  it('a lower limit than the number saved is refused with how many to remove', async () => {
    await clearTestimonials();
    await ownerDo((db) => W.setTestimonialLimit(db, 10));
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await ownerDo((db) => W.addTestimonial(db, tm(n)));
    await expect(ownerDo((db) => W.setTestimonialLimit(db, 5))).rejects.toThrow(/Delete 2 first to set the limit to 5/);
    await ownerDo((db) => W.setTestimonialLimit(db, 7));
    expect((await ownerDo((db) => W.websiteEdits(db))).limit).toBe(7);
  });

  it('the order must list every saved testimonial once', async () => {
    await clearTestimonials();
    const a = (await ownerDo((db) => W.addTestimonial(db, tm(1)))).id, b = (await ownerDo((db) => W.addTestimonial(db, tm(2)))).id;
    for (const bad of [[a], [a, a], [a, b, 'x'], 'nope', undefined]) await expect(ownerDo((db) => W.orderTestimonials(db, bad))).rejects.toMatchObject({ key: 'err.format' });
  });

  it('only the owner edits testimonials, over the API too', async () => {
    await clearTestimonials();
    await expect(as(f.admin, (db) => W.addTestimonial(db, tm(1)))).rejects.toMatchObject({ key: 'err.ownerOnly' });
    await expect(as(f.admin, (db) => db.query(`INSERT INTO website_testimonials (name, quote, consent) VALUES ('A', 'B', true)`))).rejects.toThrow(/row-level security/);
    expect((await get('/api/owner/website', '')).statusCode).toBe(401);
    const ok = await post('/api/owner/website/testimonials', tm(1));
    expect(ok.statusCode, ok.body).toBe(200);
    const id = ok.json().id as string;
    expect((await post(`/api/owner/website/testimonials/${id}`, tm(1, { name: 'Changed' }))).statusCode).toBe(200);
    expect((await post('/api/owner/website/testimonials/not-an-id', tm(1))).statusCode).toBe(404);
    expect((await post('/api/owner/website/settings', { limit: 3 })).json()).toMatchObject({ key: 'err.tmLimit' });
    expect((await post(`/api/owner/website/testimonials/${id}/delete`, {})).statusCode).toBe(200);
  });
});

describe('The public answer', () => {
  it('needs no sign-in, holds nothing private, and carries a version the website can compare', async () => {
    await clearTestimonials();
    await ownerDo((db) => W.addTestimonial(db, tm(1)));
    const res = await server.inject({ method: 'GET', url: '/api/public/site-data' });   // no cookie
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public, max-age=60/);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const d = res.json();
    expect(Object.keys(d).sort()).toEqual(['currency', 'lines', 'planName', 'planNameAr', 'testimonials', 'vatRate', 'version']);
    expect(d.lines.map((l: { key: string }) => l.key)).toEqual(['implementation', 'cleanup', 'annualCore', 'perModule']);
    expect(JSON.stringify(d)).not.toMatch(/password|email|@|firm_id|user_id|iban|swift/i);
  });

  it('answers 304 when the website already has the current version', async () => {
    const first = await server.inject({ method: 'GET', url: '/api/public/site-data' });
    const etag = String(first.headers.etag);
    const again = await server.inject({ method: 'GET', url: '/api/public/site-data', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    await post('/api/owner/website/testimonials', tm(9, { name: 'Brand new' }));
    const changed = await server.inject({ method: 'GET', url: '/api/public/site-data', headers: { 'if-none-match': etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().version).not.toBe(first.json().version);
  });

  it('is read-only and gives nothing more than GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      expect((await server.inject({ method, url: '/api/public/site-data', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});
