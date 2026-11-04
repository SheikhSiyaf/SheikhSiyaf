// Sending email (db/migrations/0031_email.sql, src/email, src/books/emailService.ts): providers, the outbox and its
// sender job, invoices to customers with a view link, invitations, password resets and approvers told.
import { describe, it, expect, beforeAll } from 'vitest';
import { app, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/emailService.js';
import { sendEmail, type Fetch } from '../src/email/transport.js';
import { sendQueued } from '../src/email/mailer.js';
import { documentMail } from '../src/email/templates.js';
import { newInvite } from '../src/api/admin.js';

let f: Fixture;
let customer: string, invoice: string;
const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
const fake = (status = 200, answer = '{"id":"msg_1"}'): Fetch => async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: status < 300, status, text: async () => answer }; };
const mail = { to: 'buyer@example.com', toName: 'Buyer', subject: 'Invoice INV-0001', text: 'Hello', html: '<p>Hello</p>', attachments: [{ fileName: 'a.xml', contentType: 'application/xml', base64: 'PGEvPg==' }] };

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', email: 'ap@gulfsteel.example' }));
  invoice = await as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-10', dueDate: '2026-04-09',
      lines: [{ description: 'Steel beams', quantity: '2', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' }] });
    await S.issueDocument(db, id);
    return id;
  });
});

describe('Email providers', () => {
  it('no provider: the email waits; log: counts as sent', async () => {
    expect(await sendEmail(mail, { provider: 'none', from: 'x@y.z' })).toMatchObject({ ok: false, hold: true });
    expect(await sendEmail(mail, { provider: 'log', from: 'x@y.z' })).toEqual({ ok: true, providerId: 'log' });
    expect(await sendEmail(mail, { provider: 'resend', from: 'x@y.z' }, fake())).toMatchObject({ ok: false, hold: true });   // no key
  });
  it('resend, sendgrid and postmark get the email in their own shape', async () => {
    calls.length = 0;
    expect(await sendEmail(mail, { provider: 'resend', from: 'Books <no-reply@b.example>', key: 'k1' }, fake())).toEqual({ ok: true, providerId: 'msg_1' });
    expect(calls[0]).toMatchObject({ url: 'https://api.resend.com/emails', headers: { authorization: 'Bearer k1' },
      body: { to: ['Buyer <buyer@example.com>'], subject: 'Invoice INV-0001', attachments: [{ filename: 'a.xml', content: 'PGEvPg==' }] } });
    await sendEmail(mail, { provider: 'sendgrid', from: 'Books <no-reply@b.example>', key: 'k2' }, fake(202, ''));
    expect(calls[1]!.body).toMatchObject({ from: { email: 'no-reply@b.example', name: 'Books' }, personalizations: [{ to: [{ email: 'buyer@example.com' }] }] });
    await sendEmail(mail, { provider: 'postmark', from: 'no-reply@b.example', key: 'k3' }, fake(200, '{"MessageID":"pm-9"}'));
    expect(calls[2]).toMatchObject({ headers: { 'x-postmark-server-token': 'k3' }, body: { To: 'buyer@example.com', Attachments: [{ Name: 'a.xml' }] } });
    expect(await sendEmail(mail, { provider: 'resend', from: 'x@y.z', key: 'k' }, fake(422, 'bad from'))).toMatchObject({ ok: false, hold: false, error: expect.stringContaining('422') });
  });
  it('emails carry English and Arabic', () => {
    const m = documentMail({ kind: 'invoice', number: 'INV-0001', customer: 'Gulf Steel', company: 'Al Noor', total: '2300.00', currency: 'SAR', dueDate: '2026-04-09', amountDue: '2300.00', link: 'https://b.example/i/x' });
    expect(m.subject).toContain('INV-0001');
    expect(m.text).toContain('فاتورة');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('<a href="https://b.example/i/x">');
  });
});

describe('Invoices to customers', () => {
  let token: string;
  it('queues the email to the customer with a link; the e-invoice XML would be attached when there is one', async () => {
    const r = await as(f.staff, (db) => E.emailDocument(db, invoice, { message: 'Thank you for your order.' }, 'https://books.example'));
    expect(r.to).toBe('ap@gulfsteel.example');
    const row = (await owner.query('SELECT kind, to_email, subject, body_text, status, document_id FROM email_outbox WHERE id = $1', [r.id])).rows[0];
    expect(row).toMatchObject({ kind: 'document', to_email: 'ap@gulfsteel.example', status: 'queued', document_id: invoice });
    token = /\/i\/([\w-]+)/.exec(row.body_text)![1]!;
    expect(row.body_text).toContain('Thank you for your order.');
  });
  it('the link opens the invoice without signing in; revoked, it no longer works', async () => {
    const d = (await app.query('SELECT document_public($1) AS d', [E.hashLinkToken(token)])).rows[0].d;
    expect(d).toMatchObject({ type: 'invoice', grossTotal: '2300.00', amountDue: '2300.00', buyer: { name: 'Gulf Steel' }, lines: [{ description: 'Steel beams' }] });
    expect((await app.query('SELECT document_public($1) AS d', [E.hashLinkToken('wrong')])).rows[0].d).toBeNull();
    await as(f.staff, (db) => E.revokeLinks(db, invoice));
    expect((await app.query('SELECT document_public($1) AS d', [E.hashLinkToken(token)])).rows[0].d).toBeNull();
  });
  it('drafts are not sent; other companies cannot queue or see', async () => {
    const draft = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-03-11', lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: f.a.sales, vatCode: 'standard' }] }));
    await expect(as(f.staff, (db) => E.emailDocument(db, draft, {}, 'https://b'))).rejects.toThrow(/Issue the document/);
    await expect(as(f.b.clientAccountant, (db) => db.query(`SELECT queue_email($1)`, [JSON.stringify({ company_id: f.a.id, kind: 'notice', to_email: 'a@b.cd', subject: 's', body_text: 't' })]))).rejects.toThrow(/Not allowed/);
    expect(await as(f.b.clientAccountant, (db) => E.list(db, f.a.id))).toEqual([]);
  });
});

describe('The sender job', () => {
  it('sends what is queued; with no provider it waits; failures are retried and end as failed', async () => {
    await owner.query(`UPDATE email_outbox SET next_try_at = now() - interval '1 second' WHERE status = 'queued'`);
    const held = await sendQueued(app, { cfg: { provider: 'none', from: 'x@y.z' } });
    expect(held.length).toBeGreaterThan(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE status = 'queued' AND attempts = 0`)).rows[0].n).toBeGreaterThan(0);
    await owner.query(`UPDATE email_outbox SET next_try_at = now() - interval '1 second' WHERE status = 'queued'`);
    const sent = await sendQueued(app, { cfg: { provider: 'resend', from: 'x@y.z', key: 'k' }, fetchFn: fake() });
    expect(sent.every((x) => x.ok)).toBe(true);
    expect((await owner.query(`SELECT status, provider_id FROM email_outbox WHERE document_id = $1`, [invoice])).rows[0]).toEqual({ status: 'sent', provider_id: 'msg_1' });
    // A provider that keeps refusing: 6 tries, then failed; a person can try again.
    const id = await as(f.staff, (db) => E.queue(db, { companyId: f.a.id, kind: 'notice', to: 'x@example.com', mail: { subject: 's', text: 't', html: '' } }));
    for (let i = 0; i < 6; i++) {
      await owner.query(`UPDATE email_outbox SET next_try_at = now() - interval '1 second' WHERE id = $1`, [id]);
      await sendQueued(app, { cfg: { provider: 'resend', from: 'x@y.z', key: 'k' }, fetchFn: fake(500, 'down') });
    }
    expect((await owner.query(`SELECT status, attempts FROM email_outbox WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'failed', attempts: 6 });
    await as(f.staff, (db) => E.retry(db, id));
    expect((await owner.query(`SELECT status, attempts FROM email_outbox WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'queued', attempts: 0 });
    await expect(as(f.staff, (db) => db.query('SELECT * FROM email_take(5)'))).rejects.toThrow(/Only the server/);
  });
});

describe('People emails', () => {
  it('an invitation is emailed with its link; a password reset only for active people with a password', async () => {
    const u = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'client', 'New Person', $2) RETURNING id`, [f.firmId, `new.${Date.now()}@example.com`])).rows[0].id;
    const token = await as(f.admin, (db) => newInvite(db, u, 'https://books.example'));
    const row = (await owner.query(`SELECT kind, body_text, firm_id FROM email_outbox WHERE kind = 'invitation' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(row.body_text).toContain(`https://books.example/invite/${token}`);
    expect(row.firm_id).toBe(f.firmId);
    expect((await app.query(`SELECT * FROM start_password_reset($1, 'h1')`, ['nobody@example.com'])).rows).toEqual([]);
    const staffEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [f.staff])).rows[0].email;
    await owner.query(`UPDATE users SET password_hash = 'x' WHERE id = $1`, [f.staff]);
    expect((await app.query(`SELECT user_id FROM start_password_reset($1, 'h2')`, [staffEmail.toUpperCase()])).rows[0].user_id).toBe(f.staff);
    await expect(as(f.staff, (db) => db.query(`SELECT * FROM start_password_reset($1, 'h3')`, [staffEmail]))).rejects.toThrow(/Sign out/);
  });
  it('approvers are told something waits (not the asker)', async () => {
    const n = await as(f.staff, (db) => E.notifyApprovers(db, f.a.id, 'a supplier bill', 'https://books.example'));
    expect(n).toBe(3);   // partner, reviewer and the client accountant, whose role may approve
    const to = (await owner.query(`SELECT to_email FROM email_outbox WHERE kind = 'approval' ORDER BY created_at DESC LIMIT 3`)).rows.map((r) => r.to_email);
    const partnerEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [f.partner])).rows[0].email;
    expect(to).toContain(partnerEmail);
    const staffEmail = (await owner.query('SELECT email FROM users WHERE id = $1', [f.staff])).rows[0].email;
    expect(to).not.toContain(staffEmail);
  });
});
