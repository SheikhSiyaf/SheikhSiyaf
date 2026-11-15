// The automatic sender (db/migrations/0050, 0051): the ZATCA sender and the online-payment confirmation run as the
// built-in system account, so they keep working when the person who connected the device or switched payments on is
// suspended or leaves. The account cannot sign in, acts for one company and one job at a time, and every write it
// makes is audited under it; who set things up is still recorded.
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
import * as O from '../src/books/onlinePayService.js';
import { runEInvoiceSender } from '../src/books/einvoiceSender.js';
import { withSystem } from '../src/db/session.js';
import { postEntry } from '../src/ledger/ledger.js';
import { buildServer } from '../src/api/server.js';
import type { Fetch } from '../src/einvoice/zatca/api.js';

let f: Fixture, server: FastifyInstance, caDir: string, issued: string, walkIn: string, clearing: string, device: string;
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
  return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED', clearanceStatus: 'CLEARED' });
};
const moyasar = new Map<string, { amount: number; currency: string; status: string }>();
const sale = () => as(f.partner, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: walkIn, issueDate: '2026-11-03', lines: [{ description: 'Room night', quantity: '1', unitPrice: '500.00', accountId: f.a.sales, vatCode: 'standard' }] });
  await S.issueDocument(db, id);
  return id;
});
const systemId = async () => (await owner.query(`SELECT id FROM users WHERE kind = 'system'`)).rows[0].id as string;

beforeAll(async () => {
  f = await seed();
  caDir = mkdtempSync(path.join(tmpdir(), 'system-'));
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path.join(caDir, 'k.pem')]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(caDir, 'k.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(caDir, 'c.pem')]);
  server = buildServer({ pool: app, sessionSecret: 'system-secret', publicUrl: 'https://books.example' });
  E.configureEInvoicing({ encryptionKey: 'test-key', fetch: fakeZatca });
  O.configurePayments({ fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch });
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']])
    await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [f.a.id, code, name, type]);
  clearing = (await owner.query(`INSERT INTO accounts (company_id, code, name, type, is_bank) VALUES ($1, '1050', 'Card clearing', 'asset', true) RETURNING id`, [f.a.id])).rows[0].id;
  walkIn = await as(f.partner, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Walk-in guest', email: 'guest@walkin.example' }));
  // The staff accountant connects the device and switches online payments on.
  await as(f.staff, (db) => E.saveSettings(db, f.a.id, { street: 'Olaya Street', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }));
  device = await as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345' }));
  expect((await as(f.staff, (db) => E.finishOnboarding(db, device))).status).toBe('active');
  await as(f.staff, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', depositAccountId: clearing }));
  void moyasar;
});
afterAll(async () => {
  await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [f.staff]);
  await server.close();
});

describe('The person who set things up is suspended', () => {
  it('pending e-invoices are still sent, by the automatic sender; the device still shows who connected it', async () => {
    const docs = [await sale(), await sale()];
    await owner.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [f.staff]);
    const r = await runEInvoiceSender(app, { companyIds: [f.a.id] });
    expect(r.reported).toBe(2);
    const sys = await systemId();
    for (const d of docs) {
      const e = (await owner.query(`SELECT id, status FROM einvoices WHERE document_id = $1`, [d])).rows[0];
      expect(e.status).toBe('reported');
      const who = (await owner.query(`SELECT user_id FROM audit_log WHERE table_name = 'einvoices' AND row_id = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`, [e.id])).rows[0].user_id;
      expect(who).toBe(sys);
    }
    expect((await owner.query('SELECT created_by FROM einvoice_devices WHERE id = $1', [device])).rows[0].created_by).toBe(f.staff);
  });

  it('a paid online payment is still recorded, by the automatic sender, into the chosen account', async () => {
    const inv = await sale();
    const token = await as(f.partner, (db) => Em.documentLink(db, inv));
    const r = await server.inject({ method: 'POST', url: `/api/public/documents/${token}/pay` });
    expect(r.statusCode, r.body).toBe(200);
    const ref = r.json().url.split('/pay/sandbox/')[1];
    const res = await server.inject({ method: 'POST', url: `/api/public/payments/sandbox/${ref}`, payload: { outcome: 'paid' } });
    const back = res.json().returnUrl as string;
    expect(res.statusCode, res.body).toBe(200);
    expect(back, JSON.stringify(back)).toContain('paid=');
    const p = (await owner.query(`SELECT p.account_id, p.created_by, document_amount_due($1)::text AS due FROM payments p
      JOIN payment_allocations a ON a.payment_id = p.id WHERE a.document_id = $1`, [inv])).rows[0];
    expect(p).toMatchObject({ account_id: clearing, created_by: await systemId(), due: '0.00' });
    expect((await owner.query('SELECT enabled_by FROM payment_settings WHERE company_id = $1', [f.a.id])).rows[0].enabled_by).toBe(f.staff);
  });
});

describe('The automatic sender is kept narrow', () => {
  it('cannot sign in, and nobody can give it a password', async () => {
    const email = (await owner.query(`SELECT email FROM users WHERE kind = 'system'`)).rows[0].email;
    const r = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'anything-123' } });
    expect(r.statusCode).toBe(401);
    await expect(owner.query(`UPDATE users SET password_hash = 'x' WHERE kind = 'system'`)).rejects.toThrow(/automatic sender/);
  });

  it('in the e-invoice job it posts nothing and sees no other company', async () => {
    await expect(withSystem(app, f.a.id, 'einvoice', (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-11-03', memo: 'x',
      lines: [{ accountId: f.a.cash, debit: '1.00' }, { accountId: f.a.sales, credit: '1.00' }] }))).rejects.toThrow(/automatic sender/);
    const seen = await withSystem(app, f.a.id, 'einvoice', async (db) => (await db.query('SELECT DISTINCT company_id FROM einvoices')).rows.map((x) => x.company_id));
    expect(seen).toEqual([f.a.id]);
    expect(await withSystem(app, f.b.id, 'einvoice', async (db) => (await db.query('SELECT count(*)::int AS n FROM einvoices')).rows[0].n)).toBe(0);
  });

  it('in the payment job it posts only payment receipts, and only while online payments are on', async () => {
    await expect(withSystem(app, f.a.id, 'online_payment', (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-11-03', memo: 'x',
      lines: [{ accountId: f.a.cash, debit: '1.00' }, { accountId: f.a.sales, credit: '1.00' }] }))).rejects.toThrow(/automatic sender/);
    await owner.query('UPDATE payment_settings SET enabled = false WHERE company_id = $1', [f.a.id]);
    expect(await withSystem(app, f.a.id, 'online_payment', async (db) => (await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n)).toBe(0);
    await owner.query('UPDATE payment_settings SET enabled = true WHERE company_id = $1', [f.a.id]);
  });

  it('a suspended client company is not sent for', async () => {
    const d = await sale();
    await owner.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [f.a.id]);
    try {
      expect((await runEInvoiceSender(app, { companyIds: [f.a.id] })).reported).toBe(0);
      expect((await owner.query(`SELECT status FROM einvoices WHERE document_id = $1`, [d])).rows[0].status).toBe('pending');
    } finally { await owner.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [f.a.id]); }
  });
});
