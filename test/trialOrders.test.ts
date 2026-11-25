// Buying inside the software: the order, the payment confirmation, the owner marking it paid (which converts the SAME customer and makes and settles
// the first invoice), the bank details, the owner's Trials view and the alert e-mails. Trials here start on 1 October 2025, like test/trial.test.ts.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as O from '../src/books/trialOrders.js';
import * as T from '../src/books/trialService.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const d = (s: string) => new Date(s);
let planId: string;
beforeAll(async () => { planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id; });
afterEach(() => { delete process.env.TRIAL_EMAILS; });

const trial = async (): Promise<Fixture> => {
  const f = await seed();
  await as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: '2025-10-01', trial: true }));
  return f;
};
const price = async (key: string) => Number((await owner.query(`SELECT l->>'amount' AS a FROM jsonb_array_elements(public_site_data()->'lines') l WHERE l->>'key' = $1`, [key])).rows[0].a);
const PDF = Buffer.from('%PDF-1.4 demo proof').toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('demo')]).toString('base64');
const confirm = (f: Fixture, extra: Record<string, unknown> = {}) => as(f.admin, (db) => O.confirmPayment(db, { amount: '10350.00', date: new Date().toISOString().slice(0, 10), reference: 'TRF-1001', ...extra }));
const mailsTo = async (to: string) => (await owner.query(`SELECT subject, body_text FROM email_outbox WHERE to_email = $1 ORDER BY created_at`, [to])).rows;

describe('Placing an order', () => {
  it('works out the amounts from the prices in Payment settings, never from the browser', async () => {
    const f = await trial();
    const r = await as(f.admin, (db) => O.placeOrder(db, { modules: ['Inventory', 'HRM'], cleanup: true, amount: '1', lines: [{ key: 'implementation', amount: 1 }] } as never));
    const impl = await price('implementation'), clean = await price('cleanup'), yr = await price('annualCore'), per = await price('perModule');
    expect(r.order).toMatchObject({ modules: ['HRM', 'Inventory'], cleanup: true, oneTime: impl + clean, yearly: yr + per * 2 });
    expect(r.order!.lines.map((l) => l.key)).toEqual(['implementation', 'annualCore', 'cleanup', 'perModule']);
    expect(r.order!.lines.find((l) => l.key === 'perModule')).toMatchObject({ quantity: 2, amount: per * 2 });
  });

  it('a new order replaces the one still waiting, and only one waits at a time', async () => {
    const f = await trial();
    await as(f.admin, (db) => O.placeOrder(db, { modules: ['CRM'] }));
    const second = await as(f.admin, (db) => O.placeOrder(db, { modules: [] }));
    expect(second.order!.modules).toEqual([]);
    expect((await owner.query(`SELECT status FROM trial_orders WHERE firm_id = $1 ORDER BY placed_at`, [f.firmId])).rows.map((r) => r.status).sort()).toEqual(['cancelled', 'waiting']);
  });

  it('many clicks at the same moment all succeed and leave exactly one waiting order', async () => {
    const f = await trial();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => as(f.admin, (db) => O.placeOrder(db, { modules: i % 2 ? ['CRM'] : [] }))));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM trial_orders WHERE firm_id = $1 AND status = 'waiting'`, [f.firmId])).rows[0].n).toBe(1);
  });

  it('refuses a module that is not on the list, the platform owner, and a customer that has no trial', async () => {
    const f = await trial();
    await expect(as(f.admin, (db) => O.placeOrder(db, { modules: ['Warehouse'] }))).rejects.toThrow(/optional modules/);
    await expect(as(f.admin, (db) => O.placeOrder(db, { modules: 'Inventory' }))).rejects.toThrow(/optional modules/);
    await expect(as(f.platformOwner, (db) => O.placeOrder(db, {}))).rejects.toThrow();
    const none = await seed();
    await expect(as(none.admin, (db) => O.placeOrder(db, {}))).rejects.toThrow(/nothing to buy/);
  });

  it('another customer cannot see the order', async () => {
    const f = await trial(), g = await trial();
    await as(f.admin, (db) => O.placeOrder(db, { modules: ['CRM'] }));
    expect(await as(g.admin, (db) => O.myOrder(db))).toBeNull();
    expect((await as(g.admin, (db) => db.query('SELECT * FROM trial_orders'))).rows).toHaveLength(0);
  });
});

describe('Bank details', () => {
  it('are shown to the customer only when all four lines are filled, and need all four or none', async () => {
    const f = await trial();
    await as(f.platformOwner, (db) => O.saveBankDetails(db, {}));
    const placed = await as(f.admin, (db) => O.placeOrder(db, {}));
    expect(placed.order!.bank).toBeNull();
    await expect(as(f.platformOwner, (db) => O.saveBankDetails(db, { accountName: 'Nusuh Demo Co', bank: 'Demo Bank' }))).rejects.toThrow(/all four/);
    await expect(as(f.platformOwner, (db) => O.saveBankDetails(db, { accountName: 'A', bank: 'B', iban: 'NOT-AN-IBAN', swift: 'DEMOSARI' }))).rejects.toThrow(/IBAN/);
    await expect(as(f.platformOwner, (db) => O.saveBankDetails(db, { accountName: 'A', bank: 'B', iban: 'SA0380000000608010167519', swift: 'XX' }))).rejects.toThrow(/SWIFT/);
    await as(f.platformOwner, (db) => O.saveBankDetails(db, { accountName: 'Nusuh Demo Co', bank: 'Demo Bank', iban: 'sa03 8000 0000 6080 1016 7519', swift: 'demosari' }));
    expect((await as(f.admin, (db) => O.myOrder(db)))!.bank).toEqual({ accountName: 'Nusuh Demo Co', bank: 'Demo Bank', iban: 'SA0380000000608010167519', swift: 'DEMOSARI' });
    await expect(as(f.admin, (db) => O.saveBankDetails(db, {}))).rejects.toThrow(/platform owner/);
    await as(f.platformOwner, (db) => O.saveBankDetails(db, {}));   // leave the shared setting empty for the other tests
  });
});

describe('Confirming the payment', () => {
  it('needs an amount, a date and a reference, and an order to confirm', async () => {
    const f = await trial();
    await expect(confirm(f)).rejects.toThrow(/Place an order/);
    await as(f.admin, (db) => O.placeOrder(db, {}));
    await expect(confirm(f, { amount: 'abc' })).rejects.toThrow(/amount/);
    await expect(confirm(f, { amount: '0' })).rejects.toThrow(/amount/);
    await expect(confirm(f, { date: '12/10/2025' })).rejects.toThrow(/date/);
    await expect(confirm(f, { date: '2020-01-01' })).rejects.toThrow(/last 90 days/);
    await expect(confirm(f, { reference: '  ' })).rejects.toThrow(/reference/);
    const ok = await confirm(f);
    expect(ok.order).toMatchObject({ confirmed: true, paymentAmount: '10350.00', paymentReference: 'TRF-1001' });
  });

  it('keeps a proof only if its first bytes say it is a PDF, PNG, JPG or WebP up to 5 MB; only the owner can read it', async () => {
    const f = await trial();
    await as(f.admin, (db) => O.placeOrder(db, {}));
    await expect(confirm(f, { fileBase64: Buffer.from('MZ not a pdf').toString('base64'), fileType: 'application/pdf', fileName: 'x.pdf' })).rejects.toThrow(/PDF, PNG, JPG or WebP/);
    await expect(confirm(f, { fileBase64: PDF, fileType: 'text/html', fileName: 'x.html' })).rejects.toThrow(/PDF, PNG, JPG or WebP/);
    await expect(confirm(f, { fileBase64: '***', fileType: 'application/pdf' })).rejects.toThrow(/could not be read/);
    await expect(confirm(f, { fileBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 0x25).toString('base64'), fileType: 'application/pdf' })).rejects.toThrow(/5 MB/);
    await confirm(f, { fileBase64: PNG, fileType: 'image/png', fileName: '../..\\receipt.png' });
    const orderId = (await owner.query(`SELECT id FROM trial_orders WHERE firm_id = $1 AND status = 'waiting'`, [f.firmId])).rows[0].id;
    const proof = await as(f.platformOwner, (db) => O.ownerProof(db, orderId));
    expect(proof.type).toBe('image/png');
    expect(proof.name).not.toMatch(/[\\/]/);
    expect(Buffer.from(proof.bytes).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(as(f.admin, (db) => O.ownerProof(db, orderId))).rejects.toThrow(/platform owner/);
    expect((await as(f.admin, (db) => db.query('SELECT * FROM trial_order_proofs'))).rows).toHaveLength(0);
    // the proof never goes into the audit log
    expect(Number((await owner.query(`SELECT count(*) AS n FROM audit_log WHERE table_name = 'trial_order_proofs'`)).rows[0].n)).toBe(0);
  });
});

describe('The owner marks an order paid', () => {
  it('converts the same customer, switches off modules not bought, makes and settles the first invoice, and thanks the customer', async () => {
    const f = await trial();
    await owner.query(`UPDATE companies SET modules = ARRAY['Inventory','HRM','CRM'] WHERE firm_id = $1`, [f.firmId]);
    await as(f.admin, (db) => O.placeOrder(db, { modules: ['HRM'], cleanup: true }));
    await confirm(f);
    const order = (await as(f.admin, (db) => O.myOrder(db)))!;
    const r = await as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { reference: 'TRF-1001', reason: 'Bank statement checked' }, d('2025-10-20T07:00:00Z'), 'https://app.example'));
    expect(r.thanked).toBe(true);
    const s = (await owner.query(`SELECT status, implementation, converted_at FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0];
    expect(s).toMatchObject({ status: 'active', implementation: true });
    expect(s.converted_at).not.toBeNull();
    // the data stays: the same companies, with only the bought optional module left (a firm with two companies is not changed in what it runs)
    const mods = (await owner.query(`SELECT modules FROM companies WHERE firm_id = $1`, [f.firmId])).rows.map((x) => x.modules);
    for (const m of mods) expect(m).toEqual(['HRM']);
    const inv = (await owner.query(`SELECT number, status, paid_on::text, paid_ref FROM billing_invoices WHERE firm_id = $1`, [f.firmId])).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: 'paid', paid_ref: 'TRF-1001' });
    // what the customer was told to transfer is what the invoice says
    expect(r.invoice.total).toBe(order.total);
    expect(r.differs).toBe(false);
    expect((await owner.query(`SELECT status, paid_reference FROM trial_orders WHERE firm_id = $1`, [f.firmId])).rows[0]).toMatchObject({ status: 'paid', paid_reference: 'TRF-1001' });
    const kinds = (await owner.query(`SELECT kind FROM subscription_events WHERE firm_id = $1 ORDER BY occurred_at, created_at`, [f.firmId])).rows.map((x) => x.kind);
    expect(kinds).toContain('converted');
    const thanks = (await mailsTo((await owner.query('SELECT email FROM users WHERE id = $1', [f.admin])).rows[0].email)).find((m) => /payment is confirmed/.test(m.subject));
    expect(thanks!.body_text).toContain(inv[0]!.number);
    expect(thanks!.body_text).toContain('https://app.example');
    // a second try finds nothing left to do
    await expect(as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { reason: 'again' }, d('2025-10-20T08:00:00Z')))).rejects.toThrow(/already paying/);
  });

  it('works without an order too (the customer paid some other way), and needs a reason', async () => {
    const f = await trial();
    await expect(as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { modules: [] }, d('2025-10-20T07:00:00Z')))).rejects.toThrow(/Say why/);
    await as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { modules: ['CRM'], cleanup: false, reason: 'Paid by cheque' }, d('2025-10-20T07:00:00Z')));
    expect((await owner.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0].status).toBe('active');
  });

  it('tells the owner when the invoice differs from what the customer was told (a discount or another plan)', async () => {
    const f = await trial();
    await owner.query('UPDATE subscriptions SET discount_pct = 10 WHERE firm_id = $1', [f.firmId]);
    await as(f.admin, (db) => O.placeOrder(db, {}));
    const r = await as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { reason: 'Paid' }, d('2025-10-20T07:00:00Z')));
    expect(r.differs).toBe(true);
    expect(Number(r.invoice.total)).toBeLessThan(Number(r.customerWasTold));
  });

  it('a locked customer (grace period) that pays is open again with its data', async () => {
    const f = await trial();
    await as(f.platformOwner, (db) => T.advance(db, d('2025-10-16T10:00:00Z'), f.firmId));
    expect((await owner.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0].status).toBe('trial_ended');
    await as(f.admin, (db) => O.placeOrder(db, {}));
    await as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { reason: 'Paid' }, d('2025-10-20T07:00:00Z')));
    expect((await owner.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0].status).toBe('active');
  });

  it('only the platform owner can', async () => {
    const f = await trial();
    await expect(as(f.admin, (db) => O.ownerMarkPaid(db, f.firmId, { reason: 'me' }))).rejects.toThrow(/platform owner/);
    await expect(as(f.admin, (db) => O.ownerOrders(db))).rejects.toThrow(/platform owner/);
    await expect(as(f.admin, (db) => O.trialsOverview(db))).rejects.toThrow(/platform owner/);
  });
});

describe('The owner\'s Trials view', () => {
  it('shows every trial with where it stands, the last sign-in, the e-mails, and the counters', async () => {
    const f = await trial();
    await appPool.query('SELECT record_login($1)', [f.admin]);   // the server records a sign-in, nobody signed in
    await as(f.admin, (db) => O.placeOrder(db, {}));
    const v = await as(f.platformOwner, (db) => O.trialsOverview(db, d('2025-10-14T07:00:00Z')));
    const mine = v.trials.find((t) => t.firmId === f.firmId)!;
    expect(mine).toMatchObject({ label: 'ending_soon', level: 'full', daysLeft: 2, orderConfirmed: false });
    expect(mine.orderId).not.toBeNull();
    expect(mine.lastLoginAt).not.toBeNull();
    expect(mine.adminEmail).toContain('@');
    expect(v.counters.started).toBe(v.trials.length);
    const later = await as(f.platformOwner, (db) => O.trialsOverview(db, d('2025-10-20T07:00:00Z')));
    expect(later.trials.find((t) => t.firmId === f.firmId)).toMatchObject({ label: 'in_grace', level: 'locked' });
    const closed = await as(f.platformOwner, (db) => O.trialsOverview(db, d('2025-12-20T07:00:00Z')));
    expect(closed.trials.find((t) => t.firmId === f.firmId)!.label).toBe('closed');
  });

  it('resends the reminder that is current, with a reason, and records it; a second send is allowed but the once-only log is untouched', async () => {
    const f = await trial();
    await expect(as(f.platformOwner, (db) => O.resendReminder(db, f.firmId, '', d('2025-10-14T07:00:00Z')))).rejects.toThrow(/Say why/);
    const r = await as(f.platformOwner, (db) => O.resendReminder(db, f.firmId, 'Customer asked again', d('2025-10-14T07:00:00Z'), 'https://app.example'));
    expect(r.template).toBe('last_notice');
    await as(f.platformOwner, (db) => O.resendReminder(db, f.firmId, 'Again', d('2025-10-14T07:00:00Z')));
    expect((await owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE firm_id = $1 AND kind = 'trial'`, [f.firmId])).rows[0].n).toBe(2);
    expect((await owner.query(`SELECT count(*)::int AS n FROM trial_email_log WHERE firm_id = $1`, [f.firmId])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM subscription_events WHERE firm_id = $1 AND kind = 'reminder_resent'`, [f.firmId])).rows[0].n).toBe(2);
    await expect(as(f.admin, (db) => O.resendReminder(db, f.firmId, 'x'))).rejects.toThrow(/platform owner/);
  });
});

describe('Alert e-mails to the owner', () => {
  const alerts = async (f: Fixture) => (await owner.query(`SELECT subject FROM email_outbox WHERE firm_id = $1 AND kind = 'trial' AND to_email = 'hello@nusuhbooks.com' ORDER BY created_at`, [f.firmId])).rows.map((r) => r.subject as string);

  it('go out when a trial starts, a payment is confirmed and a trial ends unpaid, but only when e-mails are switched on', async () => {
    const off = await trial();
    expect(await alerts(off)).toEqual([]);
    process.env.TRIAL_EMAILS = 'on';
    const f = await trial();
    expect((await alerts(f))[0]).toMatch(/^Trial started: /);
    await as(f.admin, (db) => O.placeOrder(db, {}));
    await confirm(f);
    expect((await alerts(f))[1]).toMatch(/^Payment confirmed by the customer: /);
    const c = await owner.connect();
    try { await c.query('BEGIN'); await O.ownerAlert(c, 'trial_ended_unpaid', { firmId: f.firmId }); await c.query('COMMIT'); } finally { c.release(); }
    expect((await alerts(f))[2]).toMatch(/^Trial ended unpaid: /);
  });
});

describe('Through the API: the lock lets a customer buy, but nothing else', () => {
  let clock = d('2025-10-20T07:00:00Z');
  let server: ReturnType<typeof buildServer>;
  let f: Fixture; const cookies: Record<string, string> = {};
  beforeAll(async () => {
    f = await trial();
    const hash = await hashPassword('pw-123456');
    const emails: Record<string, string> = {};
    for (const [k, id] of Object.entries({ admin: f.admin, owner: f.platformOwner })) emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'orders-secret', now: () => clock, lockCacheMs: 0 });
    for (const k of Object.keys(emails)) {
      const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[k], password: 'pw-123456' } });
      expect(res.statusCode, res.body).toBe(200);
      cookies[k] = String(res.headers['set-cookie']).split(';')[0]!;
    }
  });
  afterAll(async () => { await server.close(); });
  const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });

  it('after the trial ended (locked) the customer can place an order and confirm its payment, but cannot post', async () => {
    expect((await call('admin', 'POST', `/api/companies/${f.a.id}/entries`, { date: '2025-10-05', memo: 'x', lines: [] })).statusCode).toBe(403);
    const placed = await call('admin', 'POST', '/api/trial/order', { modules: ['CRM'], cleanup: false });
    expect(placed.statusCode, placed.body).toBe(200);
    expect(placed.json().order.modules).toEqual(['CRM']);
    expect((await call('admin', 'GET', '/api/trial/order')).json().order.modules).toEqual(['CRM']);
    const paid = await call('admin', 'POST', '/api/trial/order/payment', { amount: '5750', date: new Date().toISOString().slice(0, 10), reference: 'API-1', fileBase64: PDF, fileType: 'application/pdf', fileName: 'p.pdf' });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().order.confirmed).toBe(true);
  });

  it('the customer cannot reach the owner\'s routes; the owner downloads the proof as a file', async () => {
    for (const [m, u] of [['GET', '/api/owner/trials'], ['GET', '/api/owner/trial-orders'], ['GET', '/api/owner/bank-details']] as const) expect((await call('admin', m, u)).statusCode, u).toBe(403);
    const id = (await owner.query(`SELECT id FROM trial_orders WHERE firm_id = $1 AND status = 'waiting'`, [f.firmId])).rows[0].id;
    const proof = await call('owner', 'GET', `/api/owner/trial-orders/${id}/proof`);
    expect(proof.statusCode).toBe(200);
    expect(proof.headers['content-type']).toContain('application/pdf');
    expect(proof.headers['content-disposition']).toContain('attachment');
    expect(proof.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await call('admin', 'GET', `/api/owner/trial-orders/${id}/proof`)).statusCode).toBe(403);
  });

  it('the owner marks it paid through the API and the customer works again at once', async () => {
    const done = await call('owner', 'POST', `/api/owner/tenants/${f.firmId}/trial/mark-paid`, { reference: 'API-1', reason: 'Bank checked' });
    expect(done.statusCode, done.body).toBe(200);
    expect((await call('admin', 'GET', '/api/trial')).json()).toMatchObject({ level: 'full', trialing: false });
    expect((await call('admin', 'POST', `/api/companies/${f.a.id}/entries`, { date: '2025-10-05', memo: 'x', lines: [] })).statusCode).not.toBe(403);   // no longer stopped by the lock
  });

  it('a closed account cannot place an order (it can only export)', async () => {
    const g = await trial();
    const hash = await hashPassword('pw-123456');
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, g.admin])).rows[0].email;
    const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-123456' } });
    const ck = String(login.headers['set-cookie']).split(';')[0]!;
    clock = d('2025-12-20T07:00:00Z');   // after the grace period
    const res = await server.inject({ method: 'POST', url: '/api/trial/order', payload: { modules: [] }, headers: { cookie: ck } });
    expect(res.statusCode).toBe(403);
    clock = d('2025-10-20T07:00:00Z');
  });
});
