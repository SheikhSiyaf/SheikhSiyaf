// The ZATCA sender (src/books/einvoiceSender.ts, db/migrations/0043): simplified e-invoices are reported with no manual
// step, retried in order while ZATCA cannot be reached, never sent twice, and warnings go out at 12, 20 and 24 hours,
// on a rejection and when the login is refused, with invoice numbers only. ZATCA is a stand-in here.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/einvoiceService.js';
import * as X from '../src/einvoice/zatca/xml.js';
import { runEInvoiceSender, stageFor, JOB } from '../src/books/einvoiceSender.js';
import type { Fetch } from '../src/einvoice/zatca/api.js';

let f: Fixture;
let caDir: string, issued: string;
let mode: 'ok' | 'down' | 'login' | 'slow' = 'ok';
const reported: string[] = [];   // uuids sent to the reporting API, in order
const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
function issueFor(csrBase64: string): string {
  const csr = path.join(caDir, 'r.pem'), out = path.join(caDir, 'i.pem');
  writeFileSync(csr, Buffer.from(csrBase64, 'base64').toString('utf8'));
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(caDir, 'c.pem'), '-CAkey', path.join(caDir, 'k.pem'), '-CAcreateserial', '-days', '30', '-out', out], { stdio: 'pipe' });
  return Buffer.from(readFileSync(out, 'utf8').replace(/-----[^-]+-----|\s/g, '')).toString('base64');
}
const fakeZatca: Fetch = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : {};
  const p = new URL(url).pathname.replace('/e-invoicing/developer-portal', '');
  if (p === '/compliance') { issued = issueFor(body.csr); return reply(200, { requestID: 1, binarySecurityToken: issued, secret: 's' }); }
  if (p === '/production/csids') return reply(200, { requestID: 2, binarySecurityToken: issued, secret: 'p' });
  if (p === '/compliance/invoices') return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' });
  if (p !== '/invoices/reporting/single') return reply(404, {});
  if (mode === 'down') throw new Error('connect ETIMEDOUT');
  if (mode === 'login') return reply(401, {});
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 150));
  reported.push(body.uuid);
  if (Buffer.from(body.invoice, 'base64').toString('utf8').includes('Reject Me'))
    return reply(400, { validationResults: { status: 'ERROR', errorMessages: [{ code: 'BR-KSA-25', message: 'Buyer name not allowed' }] }, reportingStatus: 'NOT_REPORTED' });
  return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' });
};

let walkIn: string, rejectMe: string;
const sale = (contactId: string, amount = '777.00') => as(f.staff, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId, issueDate: '2026-11-03', lines: [{ description: 'Room night', quantity: '1', unitPrice: amount, accountId: f.a.sales, vatCode: 'standard' }] });
  await S.issueDocument(db, id);
  return id;
});
const einvoiceOf = async (docId: string) => (await owner.query(`SELECT * FROM einvoices WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId])).rows[0];
const run = (o: { now?: Date; all?: boolean } = {}) => runEInvoiceSender(app, { ...o, companyIds: [f.a.id], base: 'https://books.example' });
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const notices = async (like: string) => (await owner.query(
  `SELECT to_email, subject, body_text FROM email_outbox WHERE company_id = $1 AND kind = 'notice' AND subject LIKE $2 ORDER BY created_at`, [f.a.id, like])).rows;
const email = async (id: string) => (await owner.query('SELECT email FROM users WHERE id = $1', [id])).rows[0].email as string;

beforeAll(async () => {
  f = await seed();
  caDir = mkdtempSync(path.join(tmpdir(), 'sender-'));
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path.join(caDir, 'k.pem')]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(caDir, 'k.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(caDir, 'c.pem')]);
  E.configureEInvoicing({ encryptionKey: 'test-key', fetch: fakeZatca });
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']])
    await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [f.a.id, code, name, type]);
  walkIn = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Walk-in guest' }));
  rejectMe = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Reject Me Guest' }));
  await as(f.staff, (db) => E.saveSettings(db, f.a.id, { street: 'Olaya Street', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }));
  const dev = await as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345' }));
  expect((await as(f.staff, (db) => E.finishOnboarding(db, dev))).status).toBe('active');
});

describe('Reporting with no manual step', () => {
  it('three simplified invoices are reported by the sender, in order, and the run is recorded', async () => {
    const docs = [await sale(walkIn), await sale(walkIn), await sale(walkIn)];
    const es = await Promise.all(docs.map(einvoiceOf));
    expect(es.map((e) => [e.kind, e.status])).toEqual([['simplified', 'pending'], ['simplified', 'pending'], ['simplified', 'pending']]);
    const r = await run();
    expect(r).toMatchObject({ reported: 3, rejected: 0, waiting: 0 });
    expect((await Promise.all(docs.map(einvoiceOf))).map((e) => e.status)).toEqual(['reported', 'reported', 'reported']);
    expect(reported).toEqual(es.map((e) => e.uuid));   // sent in invoice-counter order
    const job = (await app.query('SELECT * FROM job_status() WHERE job = $1', [JOB])).rows[0];
    expect(job.last_ok).toBe(true);
    expect(Date.now() - new Date(job.last_finished_at).getTime()).toBeLessThan(60_000);
  });
});

describe('When ZATCA cannot be reached', () => {
  it('the first waiting invoice is retried after 2, then 5 minutes, the next waits behind it; nothing is lost or changed', async () => {
    reported.length = 0;
    mode = 'down';
    const [d1, d2] = [await sale(walkIn), await sale(walkIn)];
    const [a, b] = [await einvoiceOf(d1), await einvoiceOf(d2)];
    expect(await run()).toMatchObject({ reported: 0, waiting: 2 });
    let e1 = await einvoiceOf(d1), e2 = await einvoiceOf(d2);
    expect([e1.status, e1.attempts, e2.attempts]).toEqual(['pending', 1, 0]);   // the second was not tried: order is kept
    expect((new Date(e1.next_attempt_at).getTime() - new Date(e1.last_attempt_at).getTime()) / 60_000).toBeCloseTo(2, 5);
    await run();                                                               // not due yet: no attempt
    expect((await einvoiceOf(d1)).attempts).toBe(1);
    await run({ now: later(3) });                                              // due, still down
    e1 = await einvoiceOf(d1);
    expect(e1.attempts).toBe(2);
    expect((new Date(e1.next_attempt_at).getTime() - new Date(e1.last_attempt_at).getTime()) / 60_000).toBeCloseTo(5, 5);
    mode = 'ok';
    expect(await run({ now: later(10) })).toMatchObject({ reported: 2 });
    expect(reported).toEqual([a.uuid, b.uuid]);
    e1 = await einvoiceOf(d1); e2 = await einvoiceOf(d2);
    expect([e1.status, e2.status]).toEqual(['reported', 'reported']);
    expect([e1.xml, e1.invoice_hash, e2.xml, e2.invoice_hash]).toEqual([a.xml, a.invoice_hash, b.xml, b.invoice_hash]);   // the e-invoices never changed
    expect(e1.next_attempt_at).toBeNull();
  });

  it('when the server starts again, everything waiting is sent at once, oldest first', async () => {
    reported.length = 0;
    mode = 'down';
    const docs = [await sale(walkIn), await sale(walkIn)];
    await run();
    mode = 'ok';
    expect(await run()).toMatchObject({ reported: 0 });                       // an ordinary run waits for the retry time
    expect(await run({ all: true })).toMatchObject({ reported: 2 });           // the start-up run does not
    expect(reported).toEqual((await Promise.all(docs.map(einvoiceOf))).map((e) => e.uuid));
  });

  it('two senders at the same time never send the same invoice twice', async () => {
    reported.length = 0;
    mode = 'slow';
    const docs = [await sale(walkIn), await sale(walkIn), await sale(walkIn)];
    const [r1, r2] = await Promise.all([run(), run()]);
    mode = 'ok';
    expect(r1.reported + r2.reported).toBe(3);
    expect(r1.skippedDevices + r2.skippedDevices).toBe(1);
    expect(new Set(reported).size).toBe(reported.length);
    expect(reported).toHaveLength(3);
    expect((await Promise.all(docs.map(einvoiceOf))).every((e) => e.status === 'reported' && e.attempts === 1)).toBe(true);
  });
});

describe('Rejections and preparing again', () => {
  let rejectedDoc: string;
  it('a rejection warns at once (numbers only, to the Administrators and sales people) and does not hold back the next invoice', async () => {
    reported.length = 0;
    rejectedDoc = await sale(rejectMe, '4321.00');
    const next = await sale(walkIn);
    expect(await run()).toMatchObject({ reported: 1, rejected: 1 });
    expect((await einvoiceOf(rejectedDoc)).status).toBe('rejected');
    expect((await einvoiceOf(next)).status).toBe('reported');
    const number = (await owner.query('SELECT number FROM documents WHERE id = $1', [rejectedDoc])).rows[0].number;
    const mail = await notices('ZATCA rejected%');
    const to = mail.map((m) => m.to_email);
    expect(to).toEqual(expect.arrayContaining([await email(f.admin), await email(f.staff), await email(f.partner)]));
    expect(to).not.toContain(await email(f.reviewer));
    expect(to).not.toContain(await email(f.a.clientViewer));
    for (const m of mail) {
      expect(m.body_text).toContain(number);
      expect(m.body_text).not.toMatch(/4321|4,321|4970|Reject Me/);           // no amounts, no customer
    }
    await run();
    expect(await notices('ZATCA rejected%')).toHaveLength(mail.length);       // warned once
  });

  it('after the rejected invoice is prepared again, it and the following invoices go through and the chain stays whole', async () => {
    reported.length = 0;
    await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Fixed Guest' }, rejectMe));
    const again = await as(f.staff, (db) => E.prepareAgain(db, rejectedDoc));
    const after = await sale(walkIn);
    expect(await run()).toMatchObject({ reported: 2, rejected: 0 });
    expect(reported).toEqual([(await owner.query('SELECT uuid FROM einvoices WHERE id = $1', [again])).rows[0].uuid, (await einvoiceOf(after)).uuid]);
    const chain = (await owner.query(`SELECT icv::int, pih, invoice_hash, status FROM einvoices WHERE company_id = $1 ORDER BY icv`, [f.a.id])).rows;
    chain.forEach((e, i) => {
      expect(e.icv).toBe(i + 1);
      expect(e.pih).toBe(i === 0 ? X.FIRST_PIH : chain[i - 1].invoice_hash);
    });
    expect(chain.filter((e) => e.status === 'pending')).toEqual([]);
  });
});

describe('Warnings and the Administrator\'s list', () => {
  it('stages: 12 hours, then 20, then 24; each once; skipped stages are not sent late', () => {
    const at = new Date('2026-11-03T00:00:00Z');
    const h = (n: number) => new Date(at.getTime() + n * 3_600_000);
    const e = { created_at: at, status: 'pending', http_status: null, warned: [] as ('h12' | 'h20' | 'h24' | 'rejected' | 'login')[] };
    expect(stageFor(e, h(11))).toBeNull();
    expect(stageFor(e, h(12))).toEqual({ stage: 'h12', mark: ['h12'] });
    expect(stageFor({ ...e, warned: ['h12'] }, h(19))).toBeNull();
    expect(stageFor({ ...e, warned: ['h12'] }, h(20))).toEqual({ stage: 'h20', mark: ['h12', 'h20'] });
    expect(stageFor(e, h(30))).toEqual({ stage: 'h24', mark: ['h12', 'h20', 'h24'] });
    expect(stageFor({ ...e, http_status: 401 }, h(1))).toEqual({ stage: 'login', mark: ['login'] });
  });

  it('an invoice still waiting warns at 12, 20 and 24 hours, and the Administrator sees it in the list without amounts or customers', async () => {
    mode = 'down';
    const d = await sale(walkIn, '888.00');
    await run();
    const number = (await owner.query('SELECT number FROM documents WHERE id = $1', [d])).rows[0].number;
    const list = (await as(f.admin, (db) => db.query('SELECT * FROM admin_einvoices_unsent()'))).rows;
    const row = list.find((r) => r.number === number)!;
    expect(Object.keys(row).sort()).toEqual(['attempts', 'company', 'hours_waiting', 'id', 'issued_at', 'last_error', 'next_attempt_at', 'number', 'status'].sort());
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, last_error: 'connect ETIMEDOUT' });
    expect(JSON.stringify(list)).not.toMatch(/888|Walk-in/);
    await expect(as(f.staff, (db) => db.query('SELECT * FROM admin_einvoices_unsent()'))).rejects.toThrow(/Only the Administrator/);

    expect(await notices('ZATCA: % not yet reported%')).toHaveLength(0);
    await run({ now: later(13 * 60) });
    const h12 = await notices('ZATCA: % not yet reported%');
    expect(h12.map((m) => m.to_email)).toContain(await email(f.admin));
    expect(h12[0]!.body_text).toContain(number);
    expect(h12[0]!.body_text).toContain('ZATCA allows 24 hours');
    expect(h12[0]!.body_text).toContain('لم تُبلَّغ الهيئة');
    await run({ now: later(14 * 60) });
    expect(await notices('ZATCA: % not yet reported%')).toHaveLength(h12.length);   // not repeated
    await run({ now: later(21 * 60) });
    expect((await notices('Urgent:%')).length).toBe(h12.length);
    await run({ now: later(25 * 60) });
    const over = await notices('Overdue:%');
    expect(over.length).toBe(h12.length);
    expect(over[0]!.body_text).toContain('notify them through the form on its website');
    for (const m of [...h12, ...over]) expect(m.body_text).not.toMatch(/888|Walk-in/);
    mode = 'ok';
    await run({ all: true });
    expect((await einvoiceOf(d)).status).toBe('reported');
    expect((await as(f.admin, (db) => db.query('SELECT * FROM admin_einvoices_unsent()'))).rows.filter((r) => r.number === number)).toEqual([]);
  });

  it('when ZATCA refuses the login, the invoice keeps waiting and a warning goes at once', async () => {
    mode = 'login';
    const d = await sale(walkIn);
    await run();
    expect(await einvoiceOf(d)).toMatchObject({ status: 'pending', http_status: 401 });
    const mail = await notices('ZATCA refused%');
    expect(mail.length).toBeGreaterThan(0);
    expect(mail[0]!.body_text).toContain((await owner.query('SELECT number FROM documents WHERE id = $1', [d])).rows[0].number);
    mode = 'ok';
    await run({ all: true });
    expect((await einvoiceOf(d)).status).toBe('reported');
  });
});
