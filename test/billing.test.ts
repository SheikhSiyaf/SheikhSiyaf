// Billing and subscriptions: the platform owner bills each customer for its plan, in advance, with extra companies and
// users charged on top; invoices are never changed, only paid or voided; overdue invoices mark the customer past due.
// A customer's Administrator sees only its own billing; nobody else can change it.
import { describe, it, expect, beforeAll } from 'vitest';
import { app as appPool, as, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';

let f: Fixture;
let other: Fixture;
let planId: string;
const plan = (code: string) => as(f.platformOwner, async (db) => (await db.query('SELECT id FROM plans WHERE code = $1', [code])).rows[0].id as string);
/** The billing job: nobody signed in. */
async function job(day: string) {
  const c = await appPool.connect();
  try { await c.query('BEGIN'); const r = await B.run(c, day, 'https://books.example'); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  f = await seed();
  other = await seed();
  planId = await plan('firm');
});

describe('Plans and subscriptions', () => {
  it('only the owner adds plans and subscriptions', async () => {
    await expect(as(f.admin, (db) => B.savePlan(db, null, { code: 'x1', name: 'X', forKind: 'any', monthlyPrice: '1', yearlyPrice: '10', includedCompanies: 1, includedUsers: 1 })))
      .rejects.toThrow(/Only the platform owner/);
    await expect(as(f.admin, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'monthly', startOn: '2026-01-01' }))).rejects.toThrow(/Only the platform owner/);
    await expect(as(f.admin, (db) => db.query(`INSERT INTO plans (code, name, monthly_price, yearly_price, included_companies, included_users) VALUES ('hack', 'H', 0, 0, 9, 9)`)))
      .rejects.toThrow(/row-level security/);
  });

  it('a company plan cannot be given to an accounting firm, and bills start on day 1 to 28', async () => {
    const starter = await plan('starter');
    await expect(as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId: starter, cycle: 'monthly', startOn: '2026-01-01' }))).rejects.toThrow(/another kind/);
    await expect(as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'monthly', startOn: '2026-01-30' }))).rejects.toThrow(/day 1 to 28/);
  });

  it('a trial is not billed until it ends, then bills the plan with extra users, discount and VAT', async () => {
    const id = await as(f.platformOwner, async (db) => {
      await db.query(`UPDATE plans SET trial_days = 14 WHERE id = $1`, [planId]);
      return (await B.saveSubscription(db, f.firmId, { planId, cycle: 'monthly', startOn: '2026-01-01', trial: true, discountPct: '10' })).id;
    });
    expect(id).toBeTruthy();
    expect((await job('2026-01-10')).filter((x) => x.firmId === f.firmId)).toHaveLength(0);
    const made = (await job('2026-01-15')).filter((x) => x.firmId === f.firmId);
    expect(made).toHaveLength(1);
    const inv = await as(f.platformOwner, (db) => B.invoice(db, made[0]!.id));
    // The firm plan: 799 a month, 10 companies and 5 users included; the fixture has 2 companies and 7 people (3 staff, 4 client users).
    expect(inv.lines).toEqual([
      { key: 'plan', name: 'Firm', quantity: 1, unitPrice: 799, amount: 799 },
      { key: 'extraUsers', quantity: 2, months: 1, unitPrice: 39, amount: 78 },
    ]);
    expect([inv.subtotal, inv.discount, inv.vat, inv.total]).toEqual(['877.00', '87.70', '118.40', '907.70']);
    expect([inv.periodStart, inv.periodEnd, inv.dueOn]).toEqual(['2026-01-15', '2026-02-14', '2026-01-29']);
    expect(inv.number).toMatch(/^NB-2026-\d{4}$/);
    const sub = await as(f.platformOwner, async (db) => (await db.query(`SELECT status, to_char(next_bill_on, 'YYYY-MM-DD') AS n FROM subscriptions WHERE firm_id = $1`, [f.firmId])).rows[0]);
    expect(sub).toEqual({ status: 'active', n: '2026-02-15' });
    // Emailed to the customer's Administrator.
    const mail = await as(f.admin, async (db) => (await db.query(`SELECT subject, body_text FROM email_outbox WHERE firm_id = $1 AND kind = 'billing'`, [f.firmId])).rows);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toContain(inv.number);
    expect(mail[0].body_text).toContain('https://books.example/admin/billing');
  });

  it('a missed run catches up each period, and overdue invoices make the customer past due until paid', async () => {
    const made = (await job('2026-03-20')).filter((x) => x.firmId === f.firmId);
    expect(made).toHaveLength(2);   // 15 Feb and 15 Mar
    const st = async () => (await as(f.platformOwner, (db) => db.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [f.firmId]))).rows[0].status;
    expect(await st()).toBe('past_due');
    const open = await as(f.platformOwner, (db) => B.invoices(db, f.firmId));
    expect(open).toHaveLength(3);
    for (const x of open) await as(f.platformOwner, (db) => B.markPaid(db, x.id, { paidOn: '2026-03-21', reference: 'Bank transfer' }));
    expect(await st()).toBe('active');
    await expect(as(f.platformOwner, (db) => B.markPaid(db, open[0]!.id, {}))).rejects.toThrow(/Only an open invoice/);
  });

  it('issued invoices are never changed or deleted', async () => {
    const x = (await as(f.platformOwner, (db) => B.invoices(db, f.firmId)))[0]!;
    await expect(as(f.platformOwner, (db) => db.query(`UPDATE billing_invoices SET total = 1, subtotal = 1, vat = 0, discount = 0 WHERE id = $1`, [x.id]))).rejects.toThrow(/not changed/);
    await expect(as(f.platformOwner, (db) => db.query(`DELETE FROM billing_invoices WHERE id = $1`, [x.id]))).rejects.toThrow();
  });

  it('a yearly plan bills twelve months of extras; a voided invoice says why', async () => {
    const id = await as(f.platformOwner, async (db) => {
      await B.saveSubscription(db, other.firmId, { planId, cycle: 'yearly', startOn: '2026-02-01' });
      return (await db.query(`SELECT id FROM subscriptions WHERE firm_id = $1`, [other.firmId])).rows[0].id;
    });
    expect(id).toBeTruthy();
    const made = (await job('2026-02-01')).filter((x) => x.firmId === other.firmId);
    const inv = await as(f.platformOwner, (db) => B.invoice(db, made[0]!.id));
    expect(inv.lines[1]).toEqual({ key: 'extraUsers', quantity: 2, months: 12, unitPrice: 39, amount: 936 });
    expect([inv.subtotal, inv.total, inv.periodEnd]).toEqual(['8926.00', '10264.90', '2027-01-31']);
    await expect(as(f.platformOwner, (db) => B.voidInvoice(db, inv.id, ''))).rejects.toThrow(/Say why/);
    await as(f.platformOwner, (db) => B.voidInvoice(db, inv.id, 'Agreed a different price'));
    expect((await as(f.platformOwner, (db) => B.invoice(db, inv.id))).status).toBe('void');
  });

  it('each Administrator sees only its own billing', async () => {
    const mine = await as(f.admin, (db) => B.mine(db));
    expect(mine.subscription?.planName).toBe('Firm');
    expect(mine.usage).toEqual({ companies: 2, users: 7 });
    expect(mine.invoices.every((x: { firmId: string }) => x.firmId === f.firmId)).toBe(true);
    expect(mine.next.total).toBe(907.7);
    const theirs = (await as(other.admin, (db) => B.invoices(db))).map((x) => x.firmId);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((x) => x === other.firmId)).toBe(true);
    await expect(as(other.admin, (db) => B.invoice(db, mine.invoices[0].id))).rejects.toThrow(/Not found/);
    await expect(as(f.partner, (db) => db.query('SELECT billing_quote($1, current_date)', [f.firmId]))).rejects.toThrow(/Not allowed/);
    expect((await as(f.partner, (db) => db.query('SELECT * FROM billing_invoices'))).rows).toHaveLength(0);
  });

  it('cancelling stops billing at the end of the period already billed', async () => {
    await as(f.platformOwner, (db) => B.setCancel(db, f.firmId, true));
    expect((await job('2026-04-20')).filter((x) => x.firmId === f.firmId)).toHaveLength(0);
    expect((await as(f.platformOwner, (db) => db.query(`SELECT status FROM subscriptions WHERE firm_id = $1`, [f.firmId]))).rows[0].status).toBe('cancelled');
    expect((await as(f.admin, (db) => B.mine(db))).next).toBeNull();
  });
});
