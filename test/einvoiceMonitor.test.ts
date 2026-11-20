// The ZATCA monitor against a real database (src/books/einvoiceMonitor.ts, GET /api/companies/:id/einvoicing/monitor):
// what it reports from recorded facts, that it never calls ZATCA, and that one company cannot read another's.
// ZATCA is a stand-in here; the monitor must not touch it at all, and a counter proves that.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { app, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/einvoiceService.js';
import { monitor } from '../src/books/einvoiceMonitor.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import type { Fetch } from '../src/einvoice/zatca/api.js';

let f: Fixture, caDir: string, issued: string, zatcaCalls = 0, server: FastifyInstance;
const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
function issueFor(csrBase64: string): string {
  const csr = path.join(caDir, 'r.pem'), out = path.join(caDir, 'i.pem');
  writeFileSync(csr, Buffer.from(csrBase64, 'base64').toString('utf8'));
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(caDir, 'c.pem'), '-CAkey', path.join(caDir, 'k.pem'), '-CAcreateserial', '-days', '400', '-out', out], { stdio: 'pipe' });
  return Buffer.from(readFileSync(out, 'utf8').replace(/-----[^-]+-----|\s/g, '')).toString('base64');
}
const fakeZatca: Fetch = async (url, init) => {
  zatcaCalls++;
  const body = init.body ? JSON.parse(init.body) : {};
  const p = new URL(url).pathname.replace('/e-invoicing/developer-portal', '');
  if (p === '/compliance') { issued = issueFor(body.csr); return reply(200, { requestID: 1, binarySecurityToken: issued, secret: 's' }); }
  if (p === '/production/csids') return reply(200, { requestID: 2, binarySecurityToken: issued, secret: 'p' });
  if (p === '/compliance/invoices') return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' });
  return reply(404, {});
};

let walkIn: string;
const sale = () => as(f.staff, async (db) => {
  const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: walkIn, issueDate: '2026-11-03', lines: [{ description: 'Room night', quantity: '1', unitPrice: '500.00', accountId: f.a.sales, vatCode: 'standard' }] });
  await S.issueDocument(db, id);
  return id;
});
const einvoiceOf = async (docId: string) => (await owner.query(`SELECT * FROM einvoices WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`, [docId])).rows[0];
const look = (at?: Date) => as(f.staff, (db) => monitor(db, f.a.id, at));
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

beforeAll(async () => {
  f = await seed();
  caDir = mkdtempSync(path.join(tmpdir(), 'monitor-'));
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path.join(caDir, 'k.pem')]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(caDir, 'k.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(caDir, 'c.pem')]);
  E.configureEInvoicing({ encryptionKey: 'test-key', fetch: fakeZatca, allowProduction: false });
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']])
    await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [f.a.id, code, name, type]);
  walkIn = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Walk-in guest' }));
  const hash = await hashPassword('pw-123456');
  await owner.query('UPDATE users SET password_hash = $1 WHERE id = ANY ($2)', [hash, [f.staff, f.b.clientAccountant]]);
  server = buildServer({ pool: app, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server.close(); });

describe('the monitor before and after a company connects', () => {
  it('is off, with one reason, before e-invoicing is turned on', async () => {
    const m = await look();
    expect(m).toMatchObject({ state: 'off', country: 'SA', enabled: false });
    expect(m.findings.map((x) => x.code)).toEqual(['not_enabled']);
  });

  it('shows test mode, not a green tick, once a sandbox device is active', async () => {
    await as(f.staff, (db) => E.saveSettings(db, f.a.id, { street: 'Olaya Street', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }));
    const dev = await as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345' }));
    expect((await as(f.staff, (db) => E.finishOnboarding(db, dev))).status).toBe('active');
    const m = await look();
    expect(m.state).toBe('test');
    expect(m.findings.find((x) => x.code === 'test_mode')?.params.environment).toBe('sandbox');
    expect(m.devices).toHaveLength(1);
    expect(m.devices[0]).toMatchObject({ environment: 'sandbox', status: 'active' });
    expect(m.devices[0].certDaysLeft).toBeGreaterThan(0);
  });
});

describe('invoices waiting for ZATCA', () => {
  it('counts them, lists the oldest, and warns as the 24 hours run down (12h warning, 24h critical)', async () => {
    const d1 = await sale(), d2 = await sale();
    const m = await look();
    expect(m.waiting.simplified.count).toBe(2);
    expect(m.waitingList).toHaveLength(2);
    expect(m.findings.find((x) => x.code === 'late_simplified')).toBeUndefined();   // just issued
    const at13 = await look(hoursFromNow(13));
    expect(at13.findings.find((x) => x.code === 'late_simplified')).toMatchObject({ severity: 'warning', params: { count: 2, hours: 13 } });
    expect(at13.state).toBe('attention');
    const at25 = await look(hoursFromNow(25));
    expect(at25.findings.find((x) => x.code === 'late_simplified')?.severity).toBe('critical');
    expect(at25.state).toBe('critical');
    expect([d1, d2].every(Boolean)).toBe(true);
  });

  it('a rejection is listed with ZATCA\'s own words, and clears from the list when the invoice is sent again', async () => {
    const doc = await sale();
    const e = await einvoiceOf(doc);
    await owner.query(`UPDATE einvoices SET status = 'rejected', http_status = 400, attempts = 1,
      errors = '[{"code":"BR-KSA-25","message":"Buyer name not allowed"}]'::jsonb WHERE id = $1`, [e.id]);
    const m = await look();
    expect(m.rejected).toHaveLength(1);
    expect(JSON.stringify(m.rejected[0].errors)).toContain('Buyer name not allowed');
    expect(m.findings.find((x) => x.code === 'rejected')).toMatchObject({ severity: 'critical', params: { count: 1 }, action: 'review_rejected' });

    await as(f.staff, (db) => E.prepareAgain(db, doc));
    const after = await look();
    expect(after.rejected).toHaveLength(0);
    expect(after.findings.find((x) => x.code === 'rejected')).toBeUndefined();
    expect(after.waiting.simplified.count).toBe(3);   // the replacement now waits
  });

  it('a refused login on waiting invoices is critical and points at renewal', async () => {
    const [e] = (await owner.query(`SELECT id FROM einvoices WHERE company_id = $1 AND status = 'pending' LIMIT 1`, [f.a.id])).rows;
    await owner.query(`UPDATE einvoices SET http_status = 401 WHERE id = $1`, [e.id]);
    expect((await look()).findings.find((x) => x.code === 'login_refused')).toMatchObject({ severity: 'critical', action: 'renew' });
  });
});

describe('the monitor is only a reader', () => {
  it('never calls ZATCA, however often it is looked at', async () => {
    const before = zatcaCalls;
    for (let i = 0; i < 5; i++) await look();
    await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/einvoicing/monitor`, headers: { cookie: await signIn(f.staff) } });
    expect(zatcaCalls).toBe(before);
  });

  it('changes nothing: the same facts before and after looking', async () => {
    const snap = async () => JSON.stringify((await owner.query(`SELECT id, status, attempts, http_status FROM einvoices WHERE company_id = $1 ORDER BY id`, [f.a.id])).rows);
    const before = await snap();
    await look(); await look(hoursFromNow(30));
    expect(await snap()).toBe(before);
  });
});

async function signIn(userId: string): Promise<string> {
  const email = (await owner.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email;
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-123456' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

describe('through the API: who may see it', () => {
  it('the company\'s own staff can; another company\'s user is told the company does not exist; a signed-out request is refused', async () => {
    const own = await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/einvoicing/monitor`, headers: { cookie: await signIn(f.staff) } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ country: 'SA', state: expect.any(String) });

    const other = await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/einvoicing/monitor`, headers: { cookie: await signIn(f.b.clientAccountant) } });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain('Walk-in');

    expect((await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/einvoicing/monitor` })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/companies/not-a-uuid/einvoicing/monitor', headers: { cookie: await signIn(f.staff) } })).statusCode).toBeLessThan(500);
  });
});
