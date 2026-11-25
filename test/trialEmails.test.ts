// The free-trial reminder e-mails: the right one at the right time, once only, to the right person; nothing for customers who
// bought or were closed; a failure for one customer never stops the others; the owner can see what became of each.
// Trials here start on 1 October 2025 (last day 15 October, grace period to 14 November), like test/trial.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/billingService.js';
import * as T from '../src/books/trialService.js';
import { buildNotice, sendTrialEmails, SUPPORT, type Ctx } from '../src/books/trialEmails.js';
import { currentNotice, trialWindow } from '../src/books/trialRules.js';

const d = (s: string) => new Date(s);
const APP = 'https://app.example';
let planId: string;
beforeAll(async () => { planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id; });

const trial = async (): Promise<Fixture> => {
  const f = await seed();
  await as(f.platformOwner, (db) => B.saveSubscription(db, f.firmId, { planId, cycle: 'yearly', startOn: '2025-10-01', trial: true }));
  return f;
};
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
/** The daily job's e-mail work, nobody signed in, in one transaction, for one customer. */
async function run(f: Fixture, now: string, o: { enabled?: boolean; wrap?: (c: Q) => Q } = {}) {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    const db = o.wrap ? o.wrap(c as unknown as Q) : (c as unknown as Q);
    const r = await sendTrialEmails(db as never, d(now), { enabled: o.enabled ?? true, appUrl: APP, copyTo: SUPPORT.email, firmId: f.firmId });
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const mails = async (f: Fixture) => (await owner.query(`SELECT subject, to_email, to_name, reply_to, body_text, body_html FROM email_outbox WHERE firm_id = $1 AND kind = 'trial' ORDER BY created_at, (to_email = $2), id`, [f.firmId, SUPPORT.email])).rows;   // a copy to hello@ follows its original
const adminEmail = async (f: Fixture) => (await owner.query('SELECT email FROM users WHERE id = $1', [f.admin])).rows[0].email as string;

describe('When each reminder goes out', () => {
  it('the welcome goes at once, to the first Administrator, with the details a customer needs', async () => {
    const f = await trial();
    const r = await run(f, '2025-10-01T05:30:00Z');   // 08:30 in Riyadh on day 1
    expect(r.sent).toEqual([{ firmId: f.firmId, template: 'welcome', to: await adminEmail(f), copied: false }]);
    const [m] = await mails(f);
    expect(m!.to_email).toBe(await adminEmail(f));
    expect(m!.reply_to).toBe(SUPPORT.email);
    expect(m!.subject).toBe('Welcome to Nusuh Books: your 15-day free trial has started');
    for (const piece of ['Hello Admin,', '23:59 Saudi time on Wednesday, 15 October 2025', APP, SUPPORT.email, SUPPORT.phone, `${SUPPORT.website}/how-to-pay/`, `${SUPPORT.website}/pricing/`, 'No payment card is needed', 'Prices (before VAT, in SAR):'])
      expect(m!.body_text, piece).toContain(piece);
    expect(m!.body_html).toContain(`href="${APP}"`);
  });

  it('says nothing that is not true or not allowed: no ZATCA claim, no Arabic yet, no pressure words', async () => {
    const f = await trial();
    for (const at of ['2025-10-01T06:00:00Z', '2025-10-10T06:00:00Z', '2025-10-13T06:00:00Z', '2025-10-14T06:00:00Z', '2025-10-16T06:00:00Z', '2025-10-23T06:00:00Z', '2025-11-12T06:00:00Z']) await run(f, at);
    const all = await mails(f);
    expect(all).toHaveLength(7 + 2);   // seven reminders, and the copies of the last two
    for (const m of all) {
      expect(m.body_text + m.subject).not.toMatch(/ZATCA|Fatoora/i);
      expect(m.body_text + m.subject).not.toMatch(/[؀-ۿ]/);
      expect(m.body_text + m.subject).not.toMatch(/hurry|act now|limited time|don't miss|last chance|only \d+ left/i);
    }
  });

  it('each reminder goes once only, however often the job runs', async () => {
    const f = await trial();
    for (let i = 0; i < 5; i++) await run(f, `2025-10-01T0${5 + (i % 3)}:00:00Z`);
    expect(await mails(f)).toHaveLength(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM trial_email_log WHERE firm_id = $1', [f.firmId])).rows[0].n)).toBe(1);
    // two jobs at once cannot both send it either
    const g = await trial();
    await Promise.all([run(g, '2025-10-01T06:00:00Z'), run(g, '2025-10-01T06:00:00Z')].map((p) => p.catch(() => undefined)));
    expect((await mails(g)).length).toBeLessThanOrEqual(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM trial_email_log WHERE firm_id = $1', [g.firmId])).rows[0].n)).toBe(1);
  });

  it('the others go from 09:00 Riyadh time, with the true number of days', async () => {
    const f = await trial();
    await run(f, '2025-10-01T06:00:00Z');                                  // welcome
    expect((await run(f, '2025-10-10T05:59:00Z')).sent).toEqual([]);       // day 10, 08:59: not yet
    expect((await run(f, '2025-10-10T06:00:00Z')).sent.map((s) => s.template)).toEqual(['five_days']);
    expect((await run(f, '2025-10-13T06:00:00Z')).sent.map((s) => s.template)).toEqual(['two_days']);
    expect((await run(f, '2025-10-14T06:00:00Z')).sent.map((s) => s.template)).toEqual(['last_notice']);
    const subjects = (await mails(f)).map((m) => m.subject);
    expect(subjects).toEqual(['Welcome to Nusuh Books: your 15-day free trial has started', 'Your Nusuh Books trial ends in 5 days', 'Your Nusuh Books trial ends in 2 days', 'Your Nusuh Books trial ends tomorrow']);
  });

  it('a missed day never sends an out-of-date reminder: if the job only runs on day 14, only the last notice goes', async () => {
    const f = await trial();
    const r = await run(f, '2025-10-14T06:00:00Z');
    expect(r.sent.map((s) => s.template)).toEqual(['last_notice']);
    expect(await run(f, '2025-10-15T06:00:00Z')).toMatchObject({ sent: [] });   // day 15: that one was sent; nothing more
    const g = await trial();
    expect((await run(g, '2025-10-15T06:00:00Z')).sent.map((s) => s.template)).toEqual(['last_notice']);
    expect((await mails(g))[0]!.subject).toBe('Your Nusuh Books trial ends today');
  });

  it('after the trial: ended, then the grace week, then the closing notice, with dates that are true', async () => {
    const f = await trial();
    expect((await run(f, '2025-10-15T21:30:00Z')).sent).toEqual([]);        // just after midnight in Riyadh: not in the night
    expect((await run(f, '2025-10-16T06:00:00Z')).sent.map((s) => s.template)).toEqual(['trial_ended']);
    expect((await run(f, '2025-10-22T06:00:00Z')).sent).toEqual([{ firmId: f.firmId, template: 'grace_week', to: await adminEmail(f), copied: true }]);
    const closing = await run(f, '2025-11-11T06:00:00Z');
    expect(closing.sent.map((s) => [s.template, s.copied])).toEqual([['closing_soon', true]]);
    const all = await mails(f);
    const [ended, grace, graceCopy, close, closeCopy] = all;
    expect(ended!.subject).toBe('Your Nusuh Books trial has ended');
    expect(ended!.body_text).toContain('your data is kept until Friday, 14 November 2025');
    expect(grace!.subject).toBe('Your Nusuh Books data is kept until Friday, 14 November 2025');
    // the last two are copied to hello@, marked as copies
    expect([graceCopy!.to_email, closeCopy!.to_email]).toEqual([SUPPORT.email, SUPPORT.email]);
    expect(graceCopy!.subject.startsWith('Copy to Nusuh Books: ')).toBe(true);
    expect(close!.body_text).toContain('export your data until Tuesday, 13 January 2026');
    expect(close!.body_text).toContain('deleted 90 days after closing, from Thursday, 12 February 2026');
    expect(all.map((m) => m.to_email).filter((e) => e === SUPPORT.email)).toHaveLength(2);
    expect((await run(f, '2025-11-15T06:00:00Z')).sent).toEqual([]);        // closed: nothing more
  });

  it('modules: the day-13 and last reminders say which optional modules stay on only if bought', async () => {
    const f = await trial();
    await run(f, '2025-10-13T06:00:00Z');
    const [m] = await mails(f);
    const on = (await owner.query(`SELECT array_agg(DISTINCT m ORDER BY m) AS a FROM companies c, unnest(c.modules) m WHERE c.firm_id = $1 AND m IN ('Inventory','Restaurant','Rooms','Assets','Rentals','Projects','HRM','CRM')`, [f.firmId])).rows[0].a as string[];
    expect(on.length).toBeGreaterThan(0);
    expect(m!.body_text).toContain(`The optional modules switched on in your trial are: ${on.join(', ')}.`);
    expect(m!.body_text).toContain('The six core modules stay on when you buy');
    expect(m!.body_text).toContain('the others are switched off');
  });
});

describe('Who gets nothing', () => {
  it('a customer that bought, one that was closed, one without a trial, and a switched-off job', async () => {
    const bought = await trial();
    await as(bought.platformOwner, (db) => T.convertTrial(db, bought.firmId, 'Paid', d('2025-10-05T09:00:00Z')));
    expect((await run(bought, '2025-10-10T06:00:00Z')).sent).toEqual([]);
    const closed = await trial();
    await as(closed.platformOwner, (db) => T.cancelTrial(db, closed.firmId, 'Not needed', d('2025-10-05T09:00:00Z')));
    expect((await run(closed, '2025-10-10T06:00:00Z')).sent).toEqual([]);
    const none = await seed();
    expect((await run(none, '2025-10-10T06:00:00Z')).sent).toEqual([]);
    const off = await trial();
    const r = await run(off, '2025-10-01T06:00:00Z', { enabled: false });
    expect(r).toMatchObject({ enabled: false, sent: [], failed: [] });
    expect(await mails(off)).toHaveLength(0);
    expect(Number((await owner.query('SELECT count(*) AS n FROM trial_email_log WHERE firm_id = $1', [off.firmId])).rows[0].n)).toBe(0);
  });

  it('a customer with no active Administrator is skipped and said so, without stopping anything', async () => {
    const f = await trial();
    await owner.query(`UPDATE users SET status = 'suspended' WHERE firm_id = $1 AND kind = 'admin'`, [f.firmId]);
    const r = await run(f, '2025-10-01T06:00:00Z');
    expect(r.sent).toEqual([]);
    expect(r.skipped).toEqual([{ firmId: f.firmId, reason: 'no active Administrator to write to' }]);
  });

  it('a suspended customer is not written to', async () => {
    const f = await trial();
    await owner.query(`UPDATE firms SET status = 'suspended' WHERE id = $1`, [f.firmId]);
    expect((await run(f, '2025-10-01T06:00:00Z')).sent).toEqual([]);
  });
});

describe('When something goes wrong', () => {
  it('a failure for one customer does not stop the others, and that reminder is tried again next time', async () => {
    const bad = await trial(), good = await trial();
    const c = await appPool.connect();
    let r;
    try {
      await c.query('BEGIN');
      const wrapped = { query: async (sql: string, params?: unknown[]) => {
        if (/queue_email/.test(sql) && JSON.parse(String(params?.[0])).firm_id === bad.firmId) throw new Error('the outbox is full');
        return c.query(sql, params as never);
      } };
      r = await sendTrialEmails(wrapped as never, d('2025-10-01T06:00:00Z'), { enabled: true, appUrl: APP, copyTo: SUPPORT.email });
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(r.failed.map((x) => x.firmId)).toContain(bad.firmId);
    expect(r.failed.find((x) => x.firmId === bad.firmId)!.error).toBe('the outbox is full');
    expect(r.sent.map((x) => x.firmId)).toContain(good.firmId);
    expect(await mails(bad)).toHaveLength(0);
    expect(Number((await owner.query('SELECT count(*) AS n FROM trial_email_log WHERE firm_id = $1', [bad.firmId])).rows[0].n)).toBe(0);   // not marked as sent
    expect((await run(bad, '2025-10-01T07:00:00Z')).sent.map((s) => s.template)).toEqual(['welcome']);   // next run: it goes
    expect(await mails(good)).toHaveLength(1);
  });

  it('the owner sees every reminder, what became of it, and any delivery failure; nobody else can', async () => {
    const f = await trial();
    await run(f, '2025-10-01T06:00:00Z');
    const rows = async () => (await as(f.platformOwner, (db) => db.query('SELECT * FROM owner_trial_emails($1)', [f.firmId]))).rows;
    expect(await rows()).toMatchObject([{ template: 'welcome', status: 'queued', attempts: 0, last_error: null }]);
    await owner.query(`UPDATE email_outbox SET status = 'failed', attempts = 3, last_error = 'Mailbox does not exist' WHERE firm_id = $1 AND kind = 'trial'`, [f.firmId]);
    expect(await rows()).toMatchObject([{ template: 'welcome', status: 'failed', attempts: 3, last_error: 'Mailbox does not exist' }]);
    await expect(as(f.admin, (db) => db.query('SELECT * FROM owner_trial_emails($1)', [f.firmId]))).rejects.toThrow(/Only the platform owner/);
    expect((await as(f.admin, (db) => db.query('SELECT 1 FROM trial_email_log WHERE firm_id = $1', [f.firmId]))).rowCount).toBe(0);   // row-level security
  });

  it('the log cannot be changed or deleted, and only the server can claim a reminder', async () => {
    const f = await trial();
    await run(f, '2025-10-01T06:00:00Z');
    await expect(owner.query(`UPDATE trial_email_log SET template = 'two_days' WHERE firm_id = $1`, [f.firmId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(owner.query(`DELETE FROM trial_email_log WHERE firm_id = $1`, [f.firmId])).rejects.toThrow(/cannot be changed or deleted/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT trial_email_claim($1, 'two_days', 'x@example.com')`, [f.firmId]))).rejects.toThrow(/Only the server/);
  });
});

describe('The texts', () => {
  const ctx: Ctx = { name: 'Amal', firm: 'Gulf Trading', appUrl: APP, modules: ['HRM', 'Inventory'],
    prices: { currency: 'SAR', lines: [{ key: 'implementation', name: 'Implementation', amount: 9500 }, { key: 'cleanup', name: 'Clean-up', amount: 5000 },
      { key: 'annualCore', name: 'Annual fee', amount: '1800.50' }, { key: 'perModule', name: 'Extra module', amount: 600 }] } };
  const w = trialWindow(d('2026-01-10T05:00:00Z'));
  const notice = (iso: string) => currentNotice({ status: 'trial', trialEndsAt: w.endsAt, graceEndsAt: w.graceEndsAt, convertedAt: null, cancelledAt: null }, d(iso))!;

  it('use the prices and names as set in Payment settings, exactly, with halalas where there are some', () => {
    const m = buildNotice(notice('2026-01-19T06:00:00Z'), ctx);
    expect(m.text).toContain('Prices (before VAT, in SAR): Implementation SAR 9,500 once; Annual fee SAR 1,800.50 each year; Extra module SAR 600 each year.');
    expect(m.subject).toBe('Your Nusuh Books trial ends in 5 days');
    expect(m.text).toContain('Saturday, 24 January 2026');
    expect(m.text).toContain('until Monday, 23 February 2026');
  });

  it('the html is the same message with a button, and it escapes what is written into it', () => {
    const m = buildNotice(notice('2026-01-19T06:00:00Z'), { ...ctx, firm: 'A & B <Trading>', name: 'Am"al' });
    expect(m.html).toContain('A &amp; B &lt;Trading&gt;');
    expect(m.html).toContain('Am&quot;al');
    expect(m.html).not.toContain('<Trading>');
    expect(m.html).toContain(`<a href="${APP}"`);
  });
});
