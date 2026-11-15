// Standard (business) invoices when ZATCA cannot clear them at once (db/migrations/0051, src/books/einvoiceSender.ts),
// following ZATCA's Detailed Guidelines for E-Invoicing (version 2, May 2023, pages 45-47):
// - the sender retries clearance automatically and keeps every attempt;
// - for the first 5 minutes the invoice is not given to the buyer; after that it may be, marked "not cleared by ZATCA
//   yet"; a rejected one never;
// - ZATCA's answer 303 "Clearance switched off" sends the invoice through reporting instead;
// - Administrators are warned at 1, 4 and 24 hours.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { app, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/einvoiceService.js';
import * as Em from '../src/books/emailService.js';
import { runEInvoiceSender } from '../src/books/einvoiceSender.js';
import { buildServer } from '../src/api/server.js';
import type { Fetch } from '../src/einvoice/zatca/api.js';

let f: Fixture, server: FastifyInstance, caDir: string, issued: string, buyer: string;
let mode: 'ok' | 'down' | 'switchedOff' = 'ok';
const calls: string[] = [];
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
  if (p === '/compliance/invoices') return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED', clearanceStatus: 'CLEARED' });
  calls.push(p);
  if (mode === 'down') throw new Error('connect ETIMEDOUT');
  if (p === '/invoices/clearance/single') {
    if (mode === 'switchedOff') return reply(303, { message: 'Clearance switched off' });
    return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, clearanceStatus: 'CLEARED', clearedInvoice: body.invoice });
  }
  return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' });
};
const sale = () => as(f.partner, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: buyer, issueDate: '2026-11-03', lines: [{ description: 'Steel', quantity: '1', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' }] });
  await S.issueDocument(db, id);
  return id;
});
const einv = async (docId: string) => (await owner.query(`SELECT * FROM einvoices WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId])).rows[0];
const run = (now = new Date()) => runEInvoiceSender(app, { now, companyIds: [f.a.id], base: 'https://books.example' });
/** Moves an e-invoice back in time (the e-invoice rules forbid it, so the test turns them off for this one change). */
async function ago(docId: string, minutes: number) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`UPDATE einvoices SET created_at = now() - make_interval(mins => $2), next_attempt_at = now() - interval '1 minute' WHERE document_id = $1`, [docId, minutes]);
    await c.query('COMMIT');
  } finally { c.release(); }
}
const notices = async (like: string) => (await owner.query(`SELECT subject, body_text FROM email_outbox WHERE company_id = $1 AND kind = 'notice' AND subject LIKE $2`, [f.a.id, like])).rows;

beforeAll(async () => {
  f = await seed();
  caDir = mkdtempSync(path.join(tmpdir(), 'clear-'));
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path.join(caDir, 'k.pem')]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(caDir, 'k.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(caDir, 'c.pem')]);
  server = buildServer({ pool: app, sessionSecret: 'clear-secret', publicUrl: 'https://books.example' });
  E.configureEInvoicing({ encryptionKey: 'test-key', fetch: fakeZatca });
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']])
    await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [f.a.id, code, name, type]);
  buyer = await as(f.partner, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel Trading', email: 'ap@gulfsteel.example', country: 'SA',
    vatNumber: '300000012345673', address: 'King Fahd Road', buildingNumber: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211' }));
  await as(f.partner, (db) => E.saveSettings(db, f.a.id, { street: 'Olaya Street', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }));
  const dev = await as(f.partner, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345' }));
  expect((await as(f.partner, (db) => E.finishOnboarding(db, dev))).status).toBe('active');
});
afterAll(async () => { await server.close(); });

describe('Clearance is retried automatically', () => {
  it('a standard invoice ZATCA could not be reached for is cleared by the sender, every attempt kept', async () => {
    mode = 'down';
    const d = await sale();
    expect((await einv(d)).kind).toBe('standard');
    await run();
    expect((await einv(d))).toMatchObject({ status: 'pending', attempts: 1 });
    mode = 'ok';
    await ago(d, 10);
    await run();
    const e = await einv(d);
    expect(e).toMatchObject({ status: 'cleared', attempts: 2 });
    expect(e.cleared_xml).toBeTruthy();
    expect(calls.filter((c) => c === '/invoices/clearance/single').length).toBeGreaterThanOrEqual(2);
  });

  it('ZATCA answers 303 "Clearance switched off": the invoice is sent through reporting instead', async () => {
    mode = 'switchedOff';
    const d = await sale();
    calls.length = 0;
    await run();
    expect(calls).toEqual(['/invoices/clearance/single', '/invoices/reporting/single']);
    expect((await einv(d)).status).toBe('reported');
    mode = 'ok';
  });
});

describe('Giving the invoice to the buyer', () => {
  let d: string;
  it('not in the first 5 minutes while ZATCA has not cleared it', async () => {
    mode = 'down';
    d = await sale();
    await run();
    await expect(as(f.partner, (db) => Em.documentLink(db, d))).rejects.toThrow(/not cleared it yet/);
    await expect(as(f.partner, (db) => Em.emailDocument(db, d, {}, 'https://books.example'))).rejects.toThrow(/not cleared it yet/);
  });

  it('after 5 minutes it may be, and the invoice says it is not cleared by ZATCA yet', async () => {
    await ago(d, 6);
    const token = await as(f.partner, (db) => Em.documentLink(db, d));
    const pub = (await server.inject({ method: 'GET', url: `/api/public/documents/${token}` })).json();
    expect(pub.notCleared).toBe(true);
    expect((await as(f.partner, (db) => E.forDocument(db, d)))[0]).toMatchObject({ status: 'pending', notCleared: true });
  });

  it('once cleared, the invoice no longer says so, and the screen offers to send the cleared invoice', async () => {
    await as(f.partner, (db) => Em.emailDocument(db, d, {}, 'https://books.example'));
    mode = 'ok';
    await ago(d, 7);
    await run();
    const row = (await as(f.partner, (db) => E.forDocument(db, d)))[0];
    expect(row).toMatchObject({ status: 'cleared', notCleared: false, sentBeforeClearance: true });
  });

  it('a rejected standard invoice is never given to the buyer', async () => {
    const r = await sale();
    await owner.query(`UPDATE einvoices SET status = 'rejected' WHERE document_id = $1`, [r]);
    await ago(r, 30);
    await expect(as(f.partner, (db) => Em.documentLink(db, r))).rejects.toThrow(/rejected/);
  });
});

describe('Warnings for standard invoices not cleared', () => {
  it('at 1, 4 and 24 hours, once each, with invoice numbers only', async () => {
    mode = 'down';
    const d = await sale();
    await ago(d, 61);
    await run();
    expect(await notices('%not cleared%1 hour%')).toHaveLength(0);   // subject wording is checked below
    const after1 = await notices('ZATCA: % not cleared%');
    expect(after1.length).toBeGreaterThan(0);
    await run();
    expect(await notices('ZATCA: % not cleared%')).toHaveLength(after1.length);   // not twice
    await ago(d, 4 * 60 + 1); await run();
    await ago(d, 24 * 60 + 1); await run();
    const all = await notices('%not cleared%');
    expect(all.length).toBe(after1.length * 3);
    for (const m of all) expect(m.body_text).not.toMatch(/1,150|1150|Steel/);
    mode = 'ok';
  });
});
