// E-invoicing in the database: settings, ZATCA onboarding, the e-invoice made on issue, the hash chain, sending
// (cleared, reported, rejected, unreachable), UAE PINT AE, roles and separation. ZATCA is a stand-in here (the
// real sandbox is reached from the server; see docs/DECISIONS.md).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { as, owner, seed, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/einvoiceService.js';
import * as X from '../src/einvoice/zatca/xml.js';
import type { Fetch } from '../src/einvoice/zatca/api.js';

let f: Fixture;
let token: string;
const calls: { url: string; headers: Record<string, string>; body: Record<string, string> }[] = [];
let mode: 'ok' | 'down' | 'otherKey' = 'ok';
let caDir: string, issued: string;
/** Like ZATCA: the certificate is issued for the key in the CSR (signed by the stand-in CA). */
function issueFor(csrBase64: string): string {
  const csr = path.join(caDir, 'r.pem'), out = path.join(caDir, 'i.pem');
  writeFileSync(csr, Buffer.from(csrBase64, 'base64').toString('utf8'));
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(caDir, 'c.pem'), '-CAkey', path.join(caDir, 'k.pem'), '-CAcreateserial', '-days', '30', '-out', out], { stdio: 'pipe' });
  return Buffer.from(readFileSync(out, 'utf8').replace(/-----[^-]+-----|\s/g, '')).toString('base64');
}
const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
const fakeZatca: Fetch = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ url, headers: init.headers, body });
  if (mode === 'down') throw new Error('connect ETIMEDOUT');
  const p = new URL(url).pathname.replace('/e-invoicing/developer-portal', '');
  if (p === '/compliance') {
    if (init.headers.OTP !== '123345') return reply(400, { errors: ['Invalid-OTP'] });
    issued = issueFor(body.csr);
    return reply(200, { requestID: 1234567890, binarySecurityToken: issued, secret: 'compliance-secret' });
  }
  // 'otherKey': a certificate for some other key (what ZATCA's sandbox hands out at this step).
  if (p === '/production/csids') return reply(200, { requestID: 30368, binarySecurityToken: mode === 'otherKey' ? token : issued, secret: 'production-secret' });
  const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
  const hash = X.invoiceHash(xml).base64;
  if (hash !== body.invoiceHash) return reply(400, { validationResults: { status: 'ERROR', errorMessages: [{ code: 'invalid-invoice-hash', message: 'hash mismatch' }] } });
  if (xml.includes('Reject Me')) return reply(400, { validationResults: { status: 'ERROR', errorMessages: [{ code: 'BR-KSA-63', message: 'buyer address' }] }, clearanceStatus: 'NOT_CLEARED' });
  if (p === '/compliance/invoices') return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' });
  if (p === '/invoices/clearance/single') return reply(200, { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, clearanceStatus: 'CLEARED', clearedInvoice: body.invoice });
  if (p === '/invoices/reporting/single') return reply(202, { validationResults: { status: 'WARNING', warningMessages: [{ code: 'BR-KSA-08', message: 'check' }], errorMessages: [] }, reportingStatus: 'REPORTED' });
  return reply(404, {});
};

async function acct(co: Company, code: string, name: string, type: string) {
  const r = await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [co.id, code]);
  return r.rows[0]?.id ?? (await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) RETURNING id', [co.id, code, name, type])).rows[0].id;
}
const invoice = (co: Company, contactId: string, opts: { type?: 'invoice' | 'credit_note'; originalId?: string; amount?: string; notes?: string } = {}) => as(co === f.a ? f.staff : f.partner, async (db) => {
  const id = await S.saveDraft(db, co.id, { type: opts.type ?? 'invoice', contactId, issueDate: '2026-11-03', originalId: opts.originalId, notes: opts.notes,
    lines: [{ description: 'Steel beams', quantity: '1', unitPrice: opts.amount ?? '1000.00', accountId: co.sales, vatCode: 'standard' }] });
  await S.issueDocument(db, id);
  return id;
});
const einvoiceOf = async (docId: string) => (await owner.query(`SELECT * FROM einvoices WHERE document_id = $1 ORDER BY created_at DESC`, [docId])).rows[0];

let b2b: string, b2c: string, firstInvoice: string;
beforeAll(async () => {
  f = await seed();
  const dir = caDir = mkdtempSync(path.join(tmpdir(), 'csid-'));
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path.join(dir, 'k.pem')]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(dir, 'k.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(dir, 'c.pem')]);
  token = Buffer.from(readFileSync(path.join(dir, 'c.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, '')).toString('base64');
  E.configureEInvoicing({ encryptionKey: 'test-key', fetch: fakeZatca, now: () => new Date('2026-11-03T11:40:40Z') });
  for (const co of [f.a, f.b]) { await acct(co, '1100', 'Receivables', 'asset'); await acct(co, '1200', 'Input VAT', 'asset'); await acct(co, '2000', 'Payables', 'liability'); }
  b2b = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', vatNumber: '300075588700003' }));
  b2c = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Walk-in customer' }));
});

describe('Settings and onboarding', () => {
  it('e-invoicing cannot be turned on before a device is connected; the national address is checked', async () => {
    await expect(as(f.staff, (db) => E.saveSettings(db, f.a.id, { enabled: true, street: 'Olaya', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }))).rejects.toThrow(/Connect a device/);
    await expect(as(f.staff, (db) => E.saveSettings(db, f.a.id, { buildingNumber: '12' }))).rejects.toThrow(/4 digits/);
    await as(f.staff, (db) => E.saveSettings(db, f.a.id, { street: 'Olaya Street', buildingNumber: '1234', district: 'Al Olaya', postalCode: '12345' }));
    await expect(as(f.a.clientViewer, (db) => E.saveSettings(db, f.a.id, { district: 'X' }))).rejects.toThrow();
  });

  it('a production certificate for a different key is refused: the device is not switched on', async () => {
    const id = await as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345', name: 'EGS-Mismatch' }));
    mode = 'otherKey';
    try {
      await expect(as(f.staff, (db) => E.finishOnboarding(db, id))).rejects.toThrow(/certificate ZATCA sent does not belong to this device/);
    } finally { mode = 'ok'; }
    const d = (await owner.query('SELECT status, production_token FROM einvoice_devices WHERE id = $1', [id])).rows[0];
    expect(d.status).not.toBe('active');
    expect(d.production_token).toBeNull();
    expect((await as(f.staff, (db) => E.getSettings(db, f.a.id))).enabled).toBe(false);
  });

  it('a wrong one-time password is refused; the right one gives a device with an encrypted key', async () => {
    await expect(as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '111111' }))).rejects.toThrow(/did not accept/);
    await expect(as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '12' }))).rejects.toThrow(/6 digits/);
    const id = await as(f.staff, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345', name: 'EGS-Riyadh-1', branch: 'Riyadh' }));
    const d = (await owner.query('SELECT * FROM einvoice_devices WHERE id = $1', [id])).rows[0];
    expect(d).toMatchObject({ status: 'compliance', compliance_request_id: '1234567890', icv: '0', last_hash: X.FIRST_PIH });
    expect(d.private_key_enc).toMatch(/^v1\./);
    expect(d.private_key_enc).not.toContain('PRIVATE KEY');
    expect(d.csr).toContain('BEGIN CERTIFICATE REQUEST');
    const r = await as(f.staff, (db) => E.finishOnboarding(db, id));
    expect(r.status).toBe('active');
    expect(r.checks.map((c) => c.type)).toEqual(['standard:invoice', 'standard:credit_note', 'standard:debit_note', 'simplified:invoice', 'simplified:credit_note', 'simplified:debit_note']);
    expect(r.checks.every((c) => c.outcome === 'accepted')).toBe(true);
    expect((await as(f.staff, (db) => E.getSettings(db, f.a.id))).enabled).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/compliance/invoices')).at(-1)!.headers.Authorization).toBe(`Basic ${Buffer.from(`${issued}:compliance-secret`).toString('base64')}`);
  });
});

describe('E-invoices from the books', () => {
  it('a tax invoice to a business needs the buyer\'s national address; without it nothing is issued', async () => {
    await expect(invoice(f.a, b2b)).rejects.toThrow(/national address/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM documents WHERE contact_id = $1 AND status = 'issued'`, [b2b])).rows[0].n).toBe(0);
    await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', vatNumber: '300075588700003', address: 'King Fahd Road',
      buildingNumber: '1111', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211' }, b2b));
  });

  it('issuing makes a standard e-invoice, first in the chain; sending it clears it', async () => {
    firstInvoice = await invoice(f.a, b2b);
    const e = await einvoiceOf(firstInvoice);
    expect(e).toMatchObject({ scheme: 'zatca', kind: 'standard', status: 'pending', icv: '1', pih: X.FIRST_PIH });
    expect(X.invoiceHash(e.xml).base64).toBe(e.invoice_hash);
    const r = await as(f.staff, (db) => E.submit(db, e.id));
    expect(r.status).toBe('cleared');
    expect((await einvoiceOf(firstInvoice))).toMatchObject({ status: 'cleared', attempts: 1, http_status: 200 });
    expect(calls.at(-1)!.headers['Clearance-Status']).toBe('1');
    expect(E.qrFromXml((await einvoiceOf(firstInvoice)).cleared_xml)).toBe(e.qr);
  });

  it('a sale to a consumer is simplified, chained to the one before, and reported (with warnings kept)', async () => {
    const id = await invoice(f.a, b2c, { amount: '200.00' });
    const e = await einvoiceOf(id);
    const first = await einvoiceOf(firstInvoice);
    expect(e).toMatchObject({ kind: 'simplified', icv: '2', pih: first.invoice_hash });
    expect(X.readQr(e.qr)[9]).toBeDefined();
    const r = await as(f.staff, (db) => E.submit(db, e.id));
    expect(r).toMatchObject({ status: 'reported', warnings: ['BR-KSA-08: check'] });
  });

  it('a credit note refers to its invoice and carries the reason', async () => {
    const id = await invoice(f.a, b2b, { type: 'credit_note', originalId: firstInvoice, amount: '100.00', notes: 'Two beams returned' });
    const e = await einvoiceOf(id);
    expect(e.xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(e.xml).toContain('<cbc:InstructionNote>Two beams returned</cbc:InstructionNote>');
    expect(e.xml).toMatch(/<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>[^<]+<\/cbc:ID>/);
  });

  it('when ZATCA cannot be reached the e-invoice stays pending and is sent later', async () => {
    mode = 'down';
    const id = await invoice(f.a, b2c, { amount: '50.00' });
    const e = await einvoiceOf(id);
    expect((await as(f.staff, (db) => E.submit(db, e.id))).status).toBe('pending');
    expect(await einvoiceOf(id)).toMatchObject({ status: 'pending', attempts: 1 });
    mode = 'ok';
    const sent = await as(f.staff, (db) => E.submitPending(db, f.a.id));
    // Everything still pending goes, in chain order: the credit note from before (cleared) and this sale (reported).
    expect(sent.map((x) => x.status)).toEqual(['cleared', 'reported']);
    expect(sent.at(-1)!.id).toBe(e.id);
    expect((await einvoiceOf(id)).status).toBe('reported');
  });

  it('a rejected invoice is kept as rejected; after the fix it is prepared again further down the chain', async () => {
    const bad = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Reject Me Co', country: 'SA', vatNumber: '300011122200003', address: 'X', buildingNumber: '2222',
      district: 'D', city: 'Jeddah', postalCode: '22222' }));
    const id = await invoice(f.a, bad);
    const e = await einvoiceOf(id);
    expect((await as(f.staff, (db) => E.submit(db, e.id))).status).toBe('rejected');
    await expect(as(f.staff, (db) => E.submit(db, e.id))).resolves.toMatchObject({ status: 'rejected', errors: ['BR-KSA-63: buyer address'] });
    await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Fixed Co', country: 'SA', vatNumber: '300011122200003', address: 'X', buildingNumber: '2222',
      district: 'D', city: 'Jeddah', postalCode: '22222' }, bad));
    const again = await as(f.staff, (db) => E.prepareAgain(db, id));
    const e2 = (await owner.query('SELECT * FROM einvoices WHERE id = $1', [again])).rows[0];
    expect(Number(e2.icv)).toBe(Number(e.icv) + 1);
    expect(e2.pih).toBe(e.invoice_hash);
    expect((await as(f.staff, (db) => E.submit(db, again!))).status).toBe('cleared');
    await expect(as(f.staff, (db) => E.prepareAgain(db, id))).rejects.toThrow(/not rejected/);
  });
});

describe('The chain and the record are protected', () => {
  it('no skipping or reusing a counter, no direct counter change, no edits after the answer, no deletes', async () => {
    const e = await einvoiceOf(firstInvoice);
    const dev = (await owner.query('SELECT id, icv FROM einvoice_devices WHERE company_id = $1 AND status = $2', [f.a.id, 'active'])).rows[0];
    const docId = await as(f.staff, async (db) => { const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: b2c, issueDate: '2026-11-03',
      lines: [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: f.a.sales, vatCode: 'standard' }] }); return id; });
    await expect(as(f.staff, (db) => db.query(`INSERT INTO einvoices (company_id, document_id, scheme, device_id, kind, uuid, icv, pih, invoice_hash, xml, status, created_by)
      VALUES ($1, $2, 'zatca', $3, 'simplified', gen_random_uuid(), 1, $4, 'x', '<x/>', 'pending', app_user_id())`, [f.a.id, firstInvoice, dev.id, X.FIRST_PIH]))).rejects.toThrow();
    await expect(as(f.staff, (db) => db.query(`INSERT INTO einvoices (company_id, document_id, scheme, device_id, kind, uuid, icv, pih, invoice_hash, xml, status, created_by)
      VALUES ($1, $2, 'zatca', $3, 'simplified', gen_random_uuid(), $4, 'wrong', 'x', '<x/>', 'pending', app_user_id())`, [f.a.id, docId, dev.id, Number(dev.icv) + 1]))).rejects.toThrow(/issued|chain/);
    await expect(as(f.staff, (db) => db.query('UPDATE einvoice_devices SET icv = 99 WHERE id = $1', [dev.id]))).rejects.toThrow(/counter/);
    await expect(owner.query(`UPDATE einvoices SET xml = '<changed/>' WHERE id = $1`, [e.id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`UPDATE einvoices SET status = 'pending' WHERE id = $1`, [e.id])).rejects.toThrow(/final/);
    await expect(owner.query(`DELETE FROM einvoices WHERE id = $1`, [e.id])).rejects.toThrow();
    await expect(owner.query(`DELETE FROM einvoice_devices WHERE id = $1`, [dev.id])).rejects.toThrow();
  });

  it('view-only people cannot send or set up; other companies see nothing', async () => {
    const pending = await as(f.staff, async (db) => {
      const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: b2c, issueDate: '2026-11-03', lines: [{ description: 'y', quantity: '1', unitPrice: '5.00', accountId: f.a.sales, vatCode: 'standard' }] });
      await S.issueDocument(db, id); return id;
    });
    const e = await einvoiceOf(pending);
    await expect(as(f.a.clientViewer, (db) => E.submit(db, e.id))).rejects.toThrow();
    await expect(as(f.a.clientViewer, (db) => E.onboard(db, f.a.id, { environment: 'sandbox', otp: '123345' }))).rejects.toThrow();
    for (const t of ['einvoices', 'einvoice_devices', 'einvoice_settings']) expect((await as(f.b.clientAccountant, (db) => db.query(`SELECT * FROM ${t}`))).rows).toEqual([]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'einvoices'`)).rows[0].n).toBeGreaterThan(0);
  });
});

describe('UAE: PINT AE for the accredited service provider', () => {
  it('a business buyer gets the PINT AE XML ready; a consumer sale does not', async () => {
    await as(f.partner, (db) => E.saveSettings(db, f.b.id, { enabled: true }));
    const trn = await as(f.partner, (db) => S.saveContact(db, f.b.id, { isCustomer: true, name: 'Jumeirah Hotels', country: 'AE', vatNumber: '100998877600003', city: 'Dubai' }));
    const walk = await as(f.partner, (db) => S.saveContact(db, f.b.id, { isCustomer: true, name: 'Walk-in' }));
    const id = await invoice(f.b, trn);
    const e = await einvoiceOf(id);
    expect(e).toMatchObject({ scheme: 'pint_ae', status: 'ready', device_id: null });
    expect(e.xml).toContain('urn:peppol:pint:billing-1@ae-1');
    expect(await einvoiceOf(await invoice(f.b, walk))).toBeUndefined();
    expect((await as(f.partner, (db) => E.xmlOf(db, e.id))).fileName).toMatch(/-pint-ae\.xml$/);
  });
});
