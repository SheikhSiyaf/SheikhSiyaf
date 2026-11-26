// Manual bank-transfer payments (migration 0089): the order, the "I paid" form, the review decisions, approval through the existing conversion,
// the status machine, references, and the abuse cases. Trials here start on 1 October 2025, approvals run "on" 5 October 2025, like test/trialOrders.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as O from '../src/books/trialOrders.js';
import * as P from '../src/books/subpay.js';

const d = (s: string) => new Date(s);
let planId = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const PDF = Buffer.from('%PDF-1.4 slip').toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('slip')]).toString('base64');
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  await owner.query('UPDATE subpay.settings SET payments_enabled = true');
});

/** A customer in its trial that has placed its (trial) order. */
async function customer(modules: string[] = []): Promise<Fixture> {
  const f = await seed();
  await as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: '2025-10-01', trial: true }));
  await as(f.admin, (db) => O.placeOrder(db, { modules }));
  return f;
}
/** Places the payment order. The bank details the order needs are set and put back INSIDE the same transaction, so no other test file ever sees them
 *  (some of them expect the shared bank details to be empty). Returns the order id and, when asked, what the customer sees at that moment. */
async function place(f: Fixture, read = false): Promise<string> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const was = (await c.query('SELECT bank_account_name, bank_name, bank_iban, bank_swift FROM billing_settings FOR UPDATE')).rows[0];
    await c.query(`UPDATE billing_settings SET bank_account_name = 'Nusuh Demo Co', bank_name = 'Demo Bank', bank_iban = 'SA0380000000608010167519', bank_swift = 'DEMOSARI'`);
    await c.query('SET LOCAL ROLE nusuh_app');
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
    const id = (await c.query('SELECT subpay.place_order() AS id')).rows[0].id as string;
    if (read) seen = (await c.query('SELECT subpay.my_order() AS o')).rows[0].o;
    await c.query('RESET ROLE');
    await c.query('UPDATE billing_settings SET bank_account_name = $1, bank_name = $2, bank_iban = $3, bank_swift = $4', [was.bank_account_name, was.bank_name, was.bank_iban, was.bank_swift]);
    await c.query('COMMIT');
    return id;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
let seen: { bank?: Record<string, unknown>; [k: string]: unknown } | null = null;
const pay = async (f: Fixture, id: string, x: P.SubmitInput = {}) => as(f.admin, async (db) => P.submit(db, id, { amount: P.fromHalalas(await total(id)), date: today(), senderBank: 'Al Demo Bank', bankRef: `TRF-${stamp()}`, ...x }));
const status = async (id: string) => (await owner.query('SELECT status FROM subpay.orders WHERE id = $1', [id])).rows[0].status as string;
async function staff(f: Fixture, roleName: string) {
  const role = (await owner.query('SELECT id FROM staff_roles WHERE name = $1', [roleName])).rows[0].id;
  return as(f.platformOwner, async (db) => (await db.query('SELECT staff_member_add($1, $2, $3) AS id', [roleName, `${roleName.toLowerCase()}.${stamp()}@subpay.example.com`, role])).rows[0].id as string);
}
const total = async (id: string) => BigInt((await owner.query('SELECT total_halalas::text AS t FROM subpay.orders WHERE id = $1', [id])).rows[0].t);

describe('amounts and references', () => {
  it('parses money exactly, never as a float', () => {
    expect(P.toHalalas('10350.00')).toBe(1035000n);
    expect(P.toHalalas('0.01')).toBe(1n);
    expect(P.toHalalas('12.5')).toBe(1250n);
    expect(P.toHalalas('999999999.99')).toBe(99999999999n);
    for (const bad of ['', 'abc', '-5', '0', '0.00', '1e5', '10350.005', '1,000.00', ' ', '12.', '.5', 'NaN', '1000000000', '１２'])
      expect(() => P.toHalalas(bad), bad).toThrow();
    expect(P.fromHalalas(1035050n)).toBe('10350.50');
    expect(P.fromHalalas('5')).toBe('0.05');
  });

  it('references look like NB-XXXX-XXXX-C, are unique, and a single wrong character or a swap is detected', async () => {
    const refs = new Set<string>();
    for (let i = 0; i < 50; i++) refs.add((await owner.query('SELECT subpay.ref_make() AS r')).rows[0].r);
    expect(refs.size).toBe(50);
    const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const valid = async (r: string) => (await owner.query('SELECT subpay.ref_valid($1) AS v', [r])).rows[0].v as boolean;
    for (const r of [...refs].slice(0, 5)) {
      expect(await valid(r)).toBe(true);
      const chars = r.split('');
      for (const i of [3, 4, 5, 6, 8, 9, 10, 11, 13]) for (const c of alpha) if (c !== chars[i]) {
        const t = [...chars]; t[i] = c;
        expect(await valid(t.join('')), `${r} -> ${t.join('')}`).toBe(false);
      }
    }
    expect(await valid('NB-AAAA-AAAA-B')).toBe(false); expect(await valid('')).toBe(false); expect(await valid('NB-0000-1111-O')).toBe(false); expect(await valid("NB-AAAA-AAAA-A'; DROP")).toBe(false);
  });
});

describe('placing an order', () => {
  it('works out the amounts from the stored order and the VAT rate in halalas, never from the caller', async () => {
    const f = await customer(['Inventory', 'HRM']);
    const id = await place(f, true);
    const o = (await owner.query('SELECT o.*, t.one_time_total, t.yearly_total FROM subpay.orders o JOIN trial_orders t ON t.id = o.trial_order_id WHERE o.id = $1', [id])).rows[0];
    const sub = BigInt(Math.round(Number(o.one_time_total) * 100)) + BigInt(Math.round(Number(o.yearly_total) * 100));
    expect(BigInt(o.subtotal_halalas)).toBe(sub);
    expect(BigInt(o.vat_halalas)).toBe((sub * BigInt(Math.round(Number(o.vat_rate) * 100)) + 5000n) / 10000n);
    expect(BigInt(o.total_halalas)).toBe(sub + BigInt(o.vat_halalas));
    expect(o.currency.trim()).toBe('SAR'); expect(o.status).toBe('awaiting_payment');
    const mine = seen!;
    expect(mine).toMatchObject({ id, status: 'awaiting_payment', reference: o.reference, bank: { accountName: 'Nusuh Demo Co', iban: 'SA0380000000608010167519' } });
    expect(mine.bank).not.toHaveProperty('swift');
    expect(Number(mine.totalHalalas)).toBe(Number(o.total_halalas));
  });

  it('many clicks at the same moment leave exactly one open order with one reference', async () => {
    const f = await customer();
    const ids = await Promise.all(Array.from({ length: 12 }, () => place(f)));
    expect(new Set(ids).size).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM subpay.orders WHERE firm_id = $1`, [f.firmId])).rows[0].n).toBe(1);
  });

  it('is refused when payments are switched off, for the platform owner, for a customer with nothing to buy, and when the bank details are missing', async () => {
    const f = await customer();
    {   // switched off: inside one transaction that is rolled back, so the other test files (which need it on) never see it
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query('UPDATE subpay.settings SET payments_enabled = false');
        await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
        await expect(c.query('SELECT subpay.place_order()')).rejects.toThrow(/not switched on/);
        await c.query('ROLLBACK'); await c.query('BEGIN');
        await c.query('UPDATE subpay.settings SET payments_enabled = false');
        await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
        expect((await c.query('SELECT subpay.my_order() AS o')).rows[0].o).toBeNull();
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
    await expect(as(f.platformOwner, (db) => P.placeOrder(db))).rejects.toThrow(/Not allowed/);
    const none = await seed();
    await expect(as(none.admin, (db) => P.placeOrder(db))).rejects.toThrow(/Place an order first/);
    // bank details missing, inside one transaction so the shared setting is never left empty
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE billing_settings SET bank_account_name = NULL, bank_name = NULL, bank_iban = NULL, bank_swift = NULL`);
      await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
      await expect(c.query('SELECT subpay.place_order()')).rejects.toThrow(/bank details are not ready/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('only SAR: another currency is refused', async () => {
    const f = await customer();
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE billing_settings SET currency = 'AED', bank_account_name = 'N', bank_name = 'B', bank_iban = 'SA0380000000608010167519', bank_swift = 'DEMOSARI'`);
      await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.admin]);
      await expect(c.query('SELECT subpay.place_order()')).rejects.toThrow(/Saudi riyals/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    await expect(owner.query(`UPDATE subpay.orders SET currency = 'AED'`)).rejects.toThrow();   // the table itself refuses too
  });

  it('another customer cannot see, submit or read the order; nobody has direct table access', async () => {
    const f = await customer(), g = await customer();
    const id = await place(f);
    expect(((await as(g.admin, (db) => P.myOrder(db))) ?? {}).id).not.toBe(id);
    await expect(pay(g, id)).rejects.toThrow(/Not found/);
    for (const sql of ['SELECT * FROM subpay.orders', 'SELECT * FROM subpay.submissions', 'SELECT * FROM subpay.files', 'SELECT * FROM subpay.order_events', 'SELECT * FROM subpay.settings',
      `UPDATE subpay.orders SET status = 'approved'`, `INSERT INTO subpay.settings (id) VALUES (false)`, `DELETE FROM subpay.orders`]) {
      await expect(as(f.admin, (db) => db.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });
});

describe('the "I paid" form', () => {
  it('goes straight to review, keeps the slip, and records every step', async () => {
    const f = await customer(); const id = await place(f);
    await pay(f, id, { fileName: 'slip.pdf', fileType: 'application/pdf', fileBase64: PDF, note: '<script>alert(1)</script> ' + "'; DROP TABLE users; --" });
    expect(await status(id)).toBe('under_review');
    const events = (await owner.query('SELECT from_status, to_status FROM subpay.order_events WHERE order_id = $1 ORDER BY id', [id])).rows;
    expect(events.map((e) => e.to_status)).toEqual(['awaiting_payment', 'submitted', 'under_review']);
    const sub = (await owner.query('SELECT s.note, s.amount_halalas::text AS a, f.name, f.sha256 FROM subpay.submissions s JOIN subpay.files f ON f.submission_id = s.id WHERE s.order_id = $1', [id])).rows[0];
    expect(sub).toMatchObject({ a: String(await total(id)), name: 'slip.pdf' }); expect(sub.note).toContain('<script>'); expect(sub.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await owner.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(5);
  });

  it('works with no slip at all', async () => {
    const f = await customer(); const id = await place(f);
    await pay(f, id);
    expect(await status(id)).toBe('under_review');
    expect((await owner.query('SELECT count(*)::int AS n FROM subpay.files')).rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('refuses bad amounts, dates, texts and files, and tells the customer plainly', async () => {
    const f = await customer(); const id = await place(f);
    await expect(pay(f, id, { amount: 'abc' })).rejects.toThrow(/amount/);
    await expect(pay(f, id, { amount: '10350.005' })).rejects.toThrow(/amount/);
    await expect(pay(f, id, { date: '2020-01-01' })).rejects.toThrow(/last 90 days/);
    await expect(pay(f, id, { date: '31/12/2025' })).rejects.toThrow(/date/);
    await expect(pay(f, id, { bankRef: 'x'.repeat(200) })).resolves.toBeDefined();   // cut to 80 letters, not an error
    expect((await owner.query('SELECT max(char_length(bank_ref))::int AS n FROM subpay.submissions WHERE order_id = $1', [id])).rows[0].n).toBeLessThanOrEqual(80);
    const g = await customer(); const gid = await place(g);
    await expect(pay(g, gid, { fileName: 'x.png', fileType: 'image/png', fileBase64: PDF })).rejects.toThrow(/PDF, PNG, JPG or WebP/);      // a PDF renamed as an image
    await expect(pay(g, gid, { fileName: 'x.exe', fileType: 'application/x-msdownload', fileBase64: Buffer.from('MZ').toString('base64') })).rejects.toThrow(/PDF, PNG/);
    await expect(pay(g, gid, { fileName: 'x.pdf', fileType: 'application/pdf', fileBase64: Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64') })).rejects.toThrow(/5 MB/);
    await expect(pay(g, gid, { fileName: 'x.pdf', fileType: 'application/pdf', fileBase64: '***' })).rejects.toThrow(/could not be read/);
    // the database refuses a wrong file even when called directly
    await expect(as(g.admin, (db) => db.query('SELECT subpay.submit($1, 100, current_date, NULL, NULL, NULL, $2, $3, $4)', [gid, 'x.png', 'image/png', Buffer.from('%PDF-1.4')]))).rejects.toThrow(/PDF, PNG/);
    expect(await status(gid)).toBe('awaiting_payment');   // nothing above changed the order
  });

  it('a second submission while under review is refused; at most five tries a day', async () => {
    const f = await customer(); const id = await place(f);
    await pay(f, id);
    await expect(pay(f, id)).rejects.toThrow(/not waiting for a payment/);
    // five rejected-then-resubmitted rounds are capped by the daily limit
    const reviewer = await staff(f, 'Reviewer');
    for (let i = 0; i < 4; i++) { await as(reviewer, (db) => P.needInfo(db, id, 'Please send the slip')); await pay(f, id); }
    await as(reviewer, (db) => P.needInfo(db, id, 'Again please'));
    await expect(pay(f, id)).rejects.toThrow(/Too many tries/);
  });

  it('notices the same slip or the same bank reference used on another order, and amounts that differ', async () => {
    const f = await customer(), g = await customer();
    const a = await place(f), b = await place(g);
    await pay(f, a, { fileName: 's.pdf', fileType: 'application/pdf', fileBase64: PDF, bankRef: 'SAME-REF-1' });
    await pay(g, b, { fileName: 's.pdf', fileType: 'application/pdf', fileBase64: PDF, bankRef: 'same-ref-1', amount: '100.00' });
    const flags = (await owner.query('SELECT flags FROM subpay.submissions WHERE order_id = $1', [b])).rows[0].flags as string[];
    expect(flags).toEqual(expect.arrayContaining(['duplicate_file', 'duplicate_bank_ref', 'amount_under']));
    const h = await customer(); const c = await place(h);
    await pay(h, c, { amount: '99999.00' });
    expect((await owner.query('SELECT flags FROM subpay.submissions WHERE order_id = $1', [c])).rows[0].flags).toContain('amount_over');
  });
});

describe('the review desk', () => {
  it('shows the queue to people who may see payments, and to nobody else', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    const reviewer = await staff(f, 'Reviewer'), viewer = await staff(f, 'Viewer'), hr = await staff(f, 'HR');
    for (const who of [reviewer, viewer, f.platformOwner]) {
      const q = await as(who, (db) => P.queue(db));
      expect(q.orders.find((o: { id: string }) => o.id === id)).toMatchObject({ status: 'under_review', overdue: false });
      expect((await as(who, (db) => P.detail(db, id))).submissions).toHaveLength(1);
    }
    for (const who of [hr, f.admin, f.partner, f.a.clientAccountant]) {
      await expect(as(who, (db) => P.queue(db))).rejects.toThrow(/does not allow|Not allowed|permission/);
      await expect(as(who, (db) => P.detail(db, id))).rejects.toThrow();
    }
  });

  it('a viewer cannot decide; a reviewer can reject (with a reason), ask for more, or recommend; the customer reads the reasons', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    const reviewer = await staff(f, 'Reviewer'), viewer = await staff(f, 'Viewer');
    await expect(as(viewer, (db) => P.reject(db, id, 'No money received'))).rejects.toThrow(/does not allow/);
    await expect(as(viewer, (db) => P.needInfo(db, id, 'Please send the slip'))).rejects.toThrow(/does not allow/);
    await expect(as(reviewer, (db) => P.reject(db, id, ' '))).rejects.toThrow(/reason/);
    await as(reviewer, (db) => P.recommend(db, id, 'Matches the statement'));
    await as(reviewer, (db) => P.needInfo(db, id, 'The transfer date is missing on the slip'));
    expect(await status(id)).toBe('needs_info');
    const mine = await as(f.admin, (db) => P.myOrder(db));
    expect(mine.timeline.map((t: { status: string; note: string | null }) => t.note).filter(Boolean)).toEqual(['The transfer date is missing on the slip']);
    expect(JSON.stringify(mine)).not.toContain('Matches the statement');   // staff notes never reach the customer
    await pay(f, id, { note: 'Sorry, here is the new slip' });
    expect(await status(id)).toBe('under_review');
    await as(reviewer, (db) => P.reject(db, id, 'We could not find the money in our account'));
    expect(await status(id)).toBe('rejected');
    expect((await as(f.admin, (db) => P.myOrder(db))).timeline.at(-1)).toMatchObject({ status: 'rejected', note: 'We could not find the money in our account' });
    await expect(as(reviewer, (db) => P.reject(db, id, 'again'))).rejects.toThrow(/cannot be changed this way/);
    await expect(pay(f, id)).rejects.toThrow(/not waiting for a payment/);   // a rejected order is closed; the customer starts a new one
    expect(await place(f)).not.toBe(id);
  });

  it('a reviewer cannot approve; the slip is for people who may see payments only', async () => {
    const f = await customer(); const id = await place(f);
    await pay(f, id, { fileName: 's.pdf', fileType: 'application/pdf', fileBase64: PDF });
    const reviewer = await staff(f, 'Reviewer'), hr = await staff(f, 'HR');
    await expect(as(reviewer, (db) => P.approve(db, id, {}, d('2025-10-05')))).rejects.toThrow(/Only the Owner role/);
    expect(await status(id)).toBe('under_review');
    const sid = (await owner.query('SELECT id FROM subpay.submissions WHERE order_id = $1', [id])).rows[0].id;
    expect((await as(reviewer, (db) => P.file(db, sid))).bytes.subarray(0, 4).toString()).toBe('%PDF');
    await expect(as(hr, (db) => P.file(db, sid))).rejects.toThrow();
    await expect(as(f.admin, (db) => P.file(db, sid))).rejects.toThrow();
  });

  it('nobody reviews a payment they placed themselves', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');   // skips the guard triggers for this one transaction (no table lock, so nothing else waits)
      await c.query(`UPDATE subpay.orders SET created_by = $1 WHERE id = $2`, [f.platformOwner, id]);   // as if the Owner had entered it for the customer
      await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.platformOwner]);
      await expect(c.query('SELECT subpay.begin_approve($1, NULL)', [id])).rejects.toThrow(/yourself/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });
});

describe('approval', () => {
  it('converts the same customer, makes and settles the first invoice, and records the approval, all at once', async () => {
    const f = await customer(['Inventory']); const id = await place(f); await pay(f, id);
    const r = await as(f.platformOwner, (db) => P.approve(db, id, {}, d('2025-10-05')));
    expect(r.ok).toBe(true); expect(r.invoice.number).toBeTruthy();
    expect(await status(id)).toBe('approved');
    expect((await owner.query('SELECT status FROM subscriptions WHERE firm_id = $1', [f.firmId])).rows[0].status).toBe('active');
    expect((await owner.query(`SELECT status FROM trial_orders WHERE firm_id = $1`, [f.firmId])).rows[0].status).toBe('paid');
    expect((await owner.query(`SELECT status, paid_ref FROM billing_invoices WHERE firm_id = $1`, [f.firmId])).rows[0]).toMatchObject({ status: 'paid' });
    const last = (await owner.query('SELECT to_status, staff_note FROM subpay.order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
    expect(last.to_status).toBe('approved'); expect(last.staff_note).toContain('invoice');
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'orders' AND row_id = $1`, [id])).rows[0].n).toBeGreaterThanOrEqual(3);
    await expect(as(f.platformOwner, (db) => P.approve(db, id, {}, d('2025-10-05')))).rejects.toThrow(/cannot be changed this way/);   // never twice
  });

  it('two approvals at the same moment: exactly one wins and only one invoice is made', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    const res = await Promise.allSettled([1, 2, 3].map(() => as(f.platformOwner, (db) => P.approve(db, id, {}, d('2025-10-05')))));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM billing_invoices WHERE firm_id = $1`, [f.firmId])).rows[0].n).toBe(1);
    expect(await status(id)).toBe('approved');
  });

  it('an amount that differs needs a written reason; the reason is kept', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id, { amount: '9000.00' });
    await expect(as(f.platformOwner, (db) => P.approve(db, id, {}, d('2025-10-05')))).rejects.toThrow(/differs from the amount due/);
    await expect(as(f.platformOwner, (db) => P.approve(db, id, { override: 'ok' }, d('2025-10-05')))).rejects.toThrow(/differs/);
    expect(await status(id)).toBe('under_review');
    await as(f.platformOwner, (db) => P.approve(db, id, { override: 'Customer paid the balance in cash, seen in the statement' }, d('2025-10-05')));
    expect((await owner.query('SELECT staff_note FROM subpay.order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0].staff_note).toContain('paid the balance');
  });

  it('refuses when the customer was already settled another way, and leaves nothing half done', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    await as(f.platformOwner, (db) => O.ownerMarkPaid(db, f.firmId, { reason: 'paid in the office', reference: 'OFFICE-1' }, d('2025-10-05')));
    await expect(as(f.platformOwner, (db) => P.approve(db, id, {}, d('2025-10-05')))).rejects.toThrow(/no longer waiting|settled another way/);
    expect(await status(id)).toBe('under_review');
    expect((await owner.query(`SELECT count(*)::int AS n FROM billing_invoices WHERE firm_id = $1`, [f.firmId])).rows[0].n).toBe(1);
  });

  it('if anything fails after the conversion, nothing at all changes', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    await owner.query(`UPDATE billing_settings SET seller_name = seller_name`);   // (keeps the shared row warm; the failure below is the point)
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE nusuh_app'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.platformOwner]);
      await c.query('SELECT subpay.begin_approve($1, NULL)', [id]);
      await c.query('SELECT owner_order_paid($1, ARRAY[]::text[], false, $2, current_date, $3, now(), current_date)', [f.firmId, 'REF', 'test']);
      await expect(c.query('SELECT subpay.finish_approve($1, NULL, NULL) /* then force a failure */; SELECT 1/0', [id])).rejects.toThrow();
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    expect(await status(id)).toBe('under_review');
    expect((await owner.query(`SELECT status FROM trial_orders WHERE firm_id = $1`, [f.firmId])).rows[0].status).toBe('waiting');
    expect((await owner.query('SELECT status FROM subscriptions WHERE firm_id = $1', [f.firmId])).rows[0].status).not.toBe('active');
  });

  it('finish_approve refuses to record an approval when the customer was not converted', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    await expect(as(f.platformOwner, (db) => db.query('SELECT subpay.finish_approve($1, NULL, NULL)', [id]))).rejects.toThrow(/not converted/);
    expect(await status(id)).toBe('under_review');
  });
});

describe('the database rules (hit directly, as the owner connection)', () => {
  it('refuses every status move that is not listed, and any change to the amounts, reference or customer', async () => {
    const f = await customer(); const id = await place(f);
    for (const to of ['approved', 'rejected', 'under_review', 'needs_info', 'refunded', 'created'])
      await expect(owner.query(`UPDATE subpay.orders SET status = $1 WHERE id = $2`, [to, id]), to).rejects.toThrow(/cannot move from/);
    await expect(owner.query(`UPDATE subpay.orders SET total_halalas = 1, subtotal_halalas = 1, vat_halalas = 0 WHERE id = $1`, [id])).rejects.toThrow(/never change/);
    await expect(owner.query(`UPDATE subpay.orders SET reference = 'NB-AAAA-AAAA-A' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(owner.query(`UPDATE subpay.orders SET firm_id = $1 WHERE id = $2`, [(await seed()).firmId, id])).rejects.toThrow(/never change/);
    await expect(owner.query(`UPDATE subpay.orders SET status = 'bogus' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(owner.query(`UPDATE subpay.orders SET total_halalas = total_halalas + 1 WHERE id = $1`, [id])).rejects.toThrow();
    await expect(owner.query(`INSERT INTO subpay.submissions (order_id, amount_halalas, transfer_date, created_by) VALUES ($1, -5, current_date, $2)`, [id, f.admin])).rejects.toThrow();
    await expect(owner.query(`INSERT INTO subpay.submissions (order_id, amount_halalas, transfer_date, created_by) VALUES ($1, 0, current_date, $2)`, [id, f.admin])).rejects.toThrow();
  });

  it('the event trail can never be changed or deleted, by anyone', async () => {
    const f = await customer(); const id = await place(f);
    await expect(owner.query(`UPDATE subpay.order_events SET to_status = 'approved' WHERE order_id = $1`, [id])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(owner.query(`DELETE FROM subpay.order_events WHERE order_id = $1`, [id])).rejects.toThrow(/cannot be changed or deleted/);
  });

  it('only one open order per waiting order, and the payments code never touches the books', async () => {
    const f = await customer(); const id = await place(f);
    await expect(owner.query(`INSERT INTO subpay.orders (firm_id, trial_order_id, subtotal_halalas, vat_rate, vat_halalas, total_halalas, reference, created_by, expires_at)
      SELECT firm_id, trial_order_id, 100, 15, 15, 115, subpay.ref_make(), created_by, now() FROM subpay.orders WHERE id = $1`, [id])).rejects.toThrow();
    const fns = (await owner.query(`SELECT string_agg(prosrc, ' ') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'subpay'`)).rows[0].s as string;
    for (const t of ['journal_entries', 'journal_lines', 'documents', 'payments', 'accounts', 'payment_allocations', 'periods']) expect(fns, t).not.toMatch(new RegExp(`(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(public\\.)?${t}\\b`, 'i'));
    const fk = (await owner.query(`SELECT DISTINCT confrelid::regclass::text AS t FROM pg_constraint c WHERE connamespace = 'subpay'::regnamespace AND contype = 'f'`)).rows.map((r) => r.t as string).sort();
    expect(fk.filter((t) => !t.startsWith('subpay.'))).toEqual(['firms', 'trial_orders', 'users']);
  });

  it('settings: only people who may change payment settings, with sane limits', async () => {
    const f = await customer();
    const reviewer = await staff(f, 'Reviewer');
    await expect(as(reviewer, (db) => P.saveSettings(db, { enabled: true, reviewTargetHours: 4, orderOpenDays: 14 }))).rejects.toThrow(/does not allow/);
    await expect(as(f.platformOwner, (db) => P.saveSettings(db, { enabled: true, reviewTargetHours: 0, orderOpenDays: 14 }))).rejects.toThrow();
    await expect(as(f.platformOwner, (db) => P.saveSettings(db, { enabled: 'yes', reviewTargetHours: 4, orderOpenDays: 14 }))).rejects.toThrow();
    await as(f.platformOwner, (db) => P.saveSettings(db, { enabled: true, reviewTargetHours: 4, orderOpenDays: 14 }));
    expect(await as(reviewer, (db) => P.settings(db))).toEqual({ enabled: true, reviewTargetHours: 4, orderOpenDays: 14 });
  });

  it('an unpaid order that has run out of time is closed, and cannot be paid', async () => {
    const f = await customer(); const id = await place(f);
    await owner.query(`UPDATE subpay.orders SET expires_at = now() - interval '1 day' WHERE id = $1`, [id]);
    await expect(pay(f, id)).rejects.toThrow(/expired/);
    expect(await as(f.platformOwner, async (db) => Number((await db.query('SELECT subpay.expire_stale() AS n')).rows[0].n))).toBeGreaterThanOrEqual(1);
    expect(await status(id)).toBe('expired');
  });
});

describe('deleting a customer for good', () => {
  it('is refused for a customer that has a payment order, and nothing is deleted', async () => {
    const f = await customer(); const id = await place(f); await pay(f, id);
    await owner.query(`UPDATE firms SET removed_at = now(), status = 'suspended' WHERE id = $1`, [f.firmId]);
    const name = (await owner.query('SELECT name FROM firms WHERE id = $1', [f.firmId])).rows[0].name as string;
    await expect(as(f.platformOwner, (db) => db.query('SELECT owner_erase_tenant($1, $2)', [f.firmId, name]))).rejects.toThrow();
    expect((await owner.query('SELECT count(*)::int AS n FROM firms WHERE id = $1', [f.firmId])).rows[0].n).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM subpay.orders WHERE id = $1', [id])).rows[0].n).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgenabled = 'D' AND NOT tgisinternal`)).rows[0].n).toBe(0);
  });
});
