// Online payment of invoices (db/migrations/0037): the customer pays from the invoice link; the server asks the
// provider and records the payment once, into the account the company chose, against the invoice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as E from '../src/books/emailService.js';
import * as O from '../src/books/onlinePayService.js';
import { buildServer } from '../src/api/server.js';

let f: Fixture;
let server: FastifyInstance;
let customer: string, invoice: string, token: string, clearing: string;
// A stand-in for Moyasar: invoices it was asked to make, and what it reports.
const moyasar = new Map<string, { amount: number; currency: string; status: string }>();
const fakeFetch = (async (url: string, init?: { method?: string; body?: string }) => {
  const u = String(url);
  if (init?.method === 'POST' && u.endsWith('/invoices')) {
    const b = JSON.parse(init.body!); const id = `inv_${moyasar.size + 1}`;
    moyasar.set(id, { amount: b.amount, currency: b.currency, status: 'initiated' });
    return new Response(JSON.stringify({ id, url: `https://checkout.example/${id}`, status: 'initiated' }), { status: 201 });
  }
  const m = /\/invoices\/(.+)$/.exec(u);
  const x = m && moyasar.get(decodeURIComponent(m[1]!));
  return x ? new Response(JSON.stringify({ id: m![1], ...x })) : new Response('{"message":"not found"}', { status: 404 });
}) as typeof fetch;

const due = async (id: string) => (await as(f.staff, (db) => S.getDocument(db, id))).amountDue;
const pub = (method: 'GET' | 'POST', url: string, payload?: object) => server.inject({ method, url, payload });

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  clearing = (await owner.query(`INSERT INTO accounts (company_id, code, name, type, is_bank) VALUES ($1, '1050', 'Card payments clearing', 'asset', true) RETURNING id`, [f.a.id])).rows[0].id;
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', email: 'ap@gulfsteel.example' }));
  invoice = await as(f.staff, async (db) => { const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-05-01', dueDate: '2026-05-31',
    lines: [{ description: 'Steel', quantity: '1', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' }] }); await S.issueDocument(db, id); return id; });
  token = await as(f.staff, (db) => E.documentLink(db, invoice));
  server = buildServer({ pool: appPool, sessionSecret: 'pay-secret', publicUrl: 'https://books.example' });
  O.configurePayments({ fetch: fakeFetch });
});
afterAll(async () => { await server.close(); });

describe('Online payments', () => {
  it('are off until the company turns them on with an account for the money', async () => {
    expect((await pub('GET', `/api/public/documents/${token}`)).json().payOnline).toBe(false);
    expect((await pub('POST', `/api/public/documents/${token}/pay`)).statusCode).toBe(400);
    await expect(as(f.staff, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox' }))).rejects.toThrow(/account the money lands in/);
    await expect(as(f.staff, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', depositAccountId: f.a.sales }))).rejects.toThrow(/bank or cash accounts/);
    await expect(as(f.a.clientViewer, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', depositAccountId: clearing }))).rejects.toThrow();
    await as(f.staff, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'sandbox', depositAccountId: clearing }));
    expect((await pub('GET', `/api/public/documents/${token}`)).json().payOnline).toBe(true);
  });

  it('sandbox: declined leaves the invoice due; paid records the payment once, into the chosen account', async () => {
    let r = await pub('POST', `/api/public/documents/${token}/pay`);
    expect(r.statusCode, r.body).toBe(200);
    let ref = r.json().url.split('/pay/sandbox/')[1];
    expect((await pub('GET', `/api/public/payments/sandbox/${ref}`)).json().amount).toBe('1150.00');
    await pub('POST', `/api/public/payments/sandbox/${ref}`, { outcome: 'failed' });
    expect(await due(invoice)).toBe('1150.00');

    r = await pub('POST', `/api/public/documents/${token}/pay`);
    ref = r.json().url.split('/pay/sandbox/')[1];
    const back = (await pub('POST', `/api/public/payments/sandbox/${ref}`, { outcome: 'paid' })).json().returnUrl as string;
    expect(back).toMatch(new RegExp(`^https://books.example/i/${token}\\?paid=`));
    const id = back.split('paid=')[1]!;
    expect((await pub('GET', `/api/public/payments/${id}`)).json().status).toBe('paid');
    expect((await pub('GET', `/api/public/payments/${id}`)).json().status).toBe('paid');   // asked again: still one payment
    expect(await due(invoice)).toBe('0.00');
    const pays = (await owner.query(`SELECT amount::text, account_id, method FROM payments WHERE company_id = $1 AND direction = 'received'`, [f.a.id])).rows;
    expect(pays).toEqual([{ amount: '1150.00', account_id: clearing, method: 'card' }]);
    const list = await as(f.staff, (db) => O.list(db, f.a.id));
    expect(list.map((x) => x.status).sort()).toEqual(['failed', 'paid']);
    // Nothing is left to pay, so no new checkout.
    expect((await pub('GET', `/api/public/documents/${token}`)).json().payOnline).toBe(false);
    expect((await pub('POST', `/api/public/documents/${token}/pay`)).json().key).toBe('err.payNothingDue');
  });

  it('Moyasar: the secret key is kept encrypted; a webhook only makes the server ask Moyasar; a wrong amount is not recorded', async () => {
    await as(f.staff, (db) => O.saveSettings(db, f.a.id, { enabled: true, provider: 'moyasar', publishableKey: 'pk_test_1', secretKey: 'sk_test_secret', depositAccountId: clearing }));
    const st = (await owner.query('SELECT secret_enc FROM payment_settings WHERE company_id = $1', [f.a.id])).rows[0].secret_enc;
    expect(st).toMatch(/^v1\./);
    expect(st).not.toContain('sk_test_secret');
    expect((await as(f.staff, (db) => O.settings(db, f.a.id))).hasSecret).toBe(true);

    const inv2 = await as(f.staff, async (db) => { const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-05-02', dueDate: '2026-06-01',
      lines: [{ description: 'Beams', quantity: '2', unitPrice: '100.00', accountId: f.a.sales, vatCode: 'standard' }] }); await S.issueDocument(db, id); return id; });
    const t2 = await as(f.staff, (db) => E.documentLink(db, inv2));
    const r = await pub('POST', `/api/public/documents/${t2}/pay`);
    expect(r.json().url).toMatch(/^https:\/\/checkout.example\/inv_/);
    const ref = r.json().url.split('/').pop();
    expect(moyasar.get(ref)!.amount).toBe(23000);
    // A webhook saying "paid" while Moyasar still says initiated changes nothing.
    await pub('POST', '/api/public/payments/webhook/moyasar', { type: 'payment_paid', data: { invoice_id: ref, status: 'paid' } });
    expect(await due(inv2)).toBe('230.00');
    // Moyasar reports a different amount: not recorded.
    moyasar.set(ref, { amount: 100, currency: 'SAR', status: 'paid' });
    await pub('POST', '/api/public/payments/webhook/moyasar', { data: { invoice_id: ref } });
    expect(await due(inv2)).toBe('230.00');
    expect((await as(f.staff, (db) => O.list(db, f.a.id))).find((x) => x.providerRef === ref)!.status).toBe('failed');
    // A new checkout, paid in full.
    const r2 = await pub('POST', `/api/public/documents/${t2}/pay`);
    const ref2 = r2.json().url.split('/').pop();
    moyasar.set(ref2, { amount: 23000, currency: 'SAR', status: 'paid' });
    await pub('POST', '/api/public/payments/webhook/moyasar', { data: { invoice_id: ref2 } });
    expect(await due(inv2)).toBe('0.00');
  });

  it('other companies never see the settings or payments', async () => {
    const other = await seed();
    expect((await as(other.staff, (db) => db.query('SELECT * FROM online_payments'))).rows).toHaveLength(0);
    expect((await as(other.staff, (db) => db.query('SELECT * FROM payment_settings'))).rows).toHaveLength(0);
    await expect(as(f.staff, (db) => db.query('SELECT * FROM online_pay_get(NULL, NULL)'))).resolves.toBeTruthy();
    expect((await as(f.staff, (db) => db.query(`SELECT * FROM online_pay_get((SELECT id FROM online_payments LIMIT 1), NULL)`))).rows).toHaveLength(0);
  });
});
