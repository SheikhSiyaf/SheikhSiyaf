// The warehouse counter joined to sales and purchases (db/migrations/0036): goods out make the customer's invoice
// (and payment) in the same step, goods in make the supplier's bill, from the purchase order when there is one.
// All or nothing; the link is written once and never changed.
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as I from '../src/books/inventoryService.js';
import * as S from '../src/books/documentsService.js';
import * as K from '../src/books/counterService.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

let f: Fixture;
let rice: string, oil: string, supplier: string, customer: string, storeKeeper: string, storeKeeperEmail: string;
const bal = async (code: string) => (await owner.query(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
  WHERE a.company_id = $1 AND a.code = $2`, [f.a.id, code])).rows[0].v;
const qty = async (id: string) => (await owner.query('SELECT qty_on_hand::text AS q FROM items WHERE id = $1', [id])).rows[0].q;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['1300', 'Inventory', 'asset'],
    ['2050', 'Goods received not yet billed', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  rice = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'RICE-25', name: 'Basmati rice 25 kg', unit: 'bag', salePrice: '120.00' }));
  oil = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'OIL-5', name: 'Sunflower oil 5 L' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale', paymentTermsDays: 15 }));
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Corner Grocery' }));
  // A store keeper whose role works the counter only, without Sales or Purchases.
  const firm = (await owner.query('SELECT firm_id FROM companies WHERE id = $1', [f.a.id])).rows[0].firm_id;
  const role = (await owner.query(`INSERT INTO client_roles (firm_id, name, permissions, pos_mode) VALUES ($1, 'Store keeper', $2, true) RETURNING id`,
    [firm, JSON.stringify({ Inventory: 'edit' })])).rows[0].id;
  storeKeeperEmail = `sk.${Date.now()}@example.com`;
  storeKeeper = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash) VALUES ($1, 'client', 'Store Keeper', $2, $3) RETURNING id`,
    [firm, storeKeeperEmail, await hashPassword('pw-123456')])).rows[0].id;
  await owner.query(`INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, 'client_accountant', $3)`, [storeKeeper, f.a.id, role]);
});

describe('Goods in at the counter', () => {
  it('posts the goods received and makes the draft bill on 2050 from the purchase order; issuing the bill clears 2050', async () => {
    const po = await as(f.staff, async (db) => {
      const id = await S.saveDraft(db, f.a.id, { type: 'purchase_order', contactId: supplier, issueDate: '2026-04-01',
        lines: [{ description: 'Rice and oil', quantity: '1', unitPrice: '1100.00', accountId: f.a.rent, vatCode: 'standard' }] });
      await S.setQuotationStatus(db, id, 'sent');
      return id;
    });
    const r = await as(f.staff, (db) => K.counterReceive(db, f.a.id, { date: '2026-04-05', contactId: supplier, reference: 'DN-778', purchaseOrderId: po,
      lines: [{ itemId: rice, quantity: '10', unitCost: '80.00' }, { itemId: oil, quantity: '12', unitCost: '25.00' }] }));
    expect(r.note.number).toMatch(/^GRN-/);
    expect(await qty(rice)).toBe('10.000');
    expect(await bal('2050')).toBe('-1100.00');
    const bill = await as(f.staff, (db) => S.getDocument(db, r.bill.id));
    expect(bill.status).toBe('draft');
    expect(bill.reference).toBe('DN-778');
    expect(bill.dueDate).toBe('2026-04-20');
    expect(bill.lines.map((l: { description: string; net: string; accountCode: string }) => [l.description, l.net, l.accountCode]))
      .toEqual([['Basmati rice 25 kg (RICE-25)', '800.00', '2050'], ['Sunflower oil 5 L (OIL-5)', '300.00', '2050']]);
    expect(bill.counter.number).toBe(r.note.number);
    expect((await as(f.staff, (db) => S.getDocument(db, po))).status).toBe('billed');
    expect((await as(f.staff, (db) => I.getNote(db, r.note.id))).counter.id).toBe(r.bill.id);
    await as(f.staff, (db) => S.issueDocument(db, r.bill.id));
    expect(await bal('2050')).toBe('0.00');
    expect(await bal('1200')).toBe('165.00');
  });

  it('needs the supplier; a purchase order of another supplier or already billed is refused, and nothing is recorded', async () => {
    await expect(as(f.staff, (db) => K.counterReceive(db, f.a.id, { date: '2026-04-06', lines: [{ itemId: rice, quantity: '1', unitCost: '80' }] }))).rejects.toThrow(/supplier/);
    const billedPo = (await owner.query(`SELECT id FROM documents WHERE company_id = $1 AND type = 'purchase_order'`, [f.a.id])).rows[0].id;
    await expect(as(f.staff, (db) => K.counterReceive(db, f.a.id, { date: '2026-04-06', contactId: supplier, purchaseOrderId: billedPo,
      lines: [{ itemId: rice, quantity: '1', unitCost: '80' }] }))).rejects.toThrow(/open purchase order/);
    expect(await qty(rice)).toBe('10.000');
  });
});

describe('Goods out at the counter', () => {
  it('posts the delivery and issues the invoice at the sale price; paid at the counter, nothing is left to pay', async () => {
    const before = await bal('1100');
    const r = await as(f.staff, (db) => K.counterSale(db, f.a.id, { date: '2026-04-07', contactId: customer, paidToAccountId: f.a.cash, method: 'card',
      lines: [{ itemId: rice, quantity: '2' }, { itemId: oil, quantity: '3', unitPrice: '32.50' }] }));
    expect(r.note.number).toMatch(/^GDN-/);
    expect(await qty(rice)).toBe('8.000');
    const inv = await as(f.staff, (db) => S.getDocument(db, r.invoice.id));
    expect(inv.status).toBe('issued');
    expect([inv.netTotal, inv.vatTotal, inv.grossTotal, inv.amountDue]).toEqual(['337.50', '50.63', '388.13', '0.00']);
    expect(inv.counter.number).toBe(r.note.number);
    expect(r.paymentId).toBeTruthy();
    expect(await bal('1100')).toBe(before);
    expect(await bal('5000')).toBe('235.00');   // cost of the goods out: 2 × 80 + 3 × 25
  });

  it('on account: due by the payment terms; an item without a sale price needs one; out of stock rolls everything back', async () => {
    const r = await as(f.staff, (db) => K.counterSale(db, f.a.id, { date: '2026-04-08', contactId: customer, lines: [{ itemId: rice, quantity: '1' }] }));
    const inv = await as(f.staff, (db) => S.getDocument(db, r.invoice.id));
    expect([inv.amountDue, inv.dueDate]).toEqual(['138.00', '2026-05-08']);
    await expect(as(f.staff, (db) => K.counterSale(db, f.a.id, { date: '2026-04-08', contactId: customer, lines: [{ itemId: oil, quantity: '1' }] }))).rejects.toThrow(/selling price/);
    const invoices = async () => (await owner.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = 'invoice'`, [f.a.id])).rows[0].n;
    const n = await invoices();
    await expect(as(f.staff, (db) => K.counterSale(db, f.a.id, { date: '2026-04-08', contactId: customer, lines: [{ itemId: rice, quantity: '500' }] }))).rejects.toThrow(/Not enough stock/);
    expect(await invoices()).toBe(n);
    expect(await qty(rice)).toBe('7.000');
  });

  it('the link is never changed or deleted', async () => {
    await expect(owner.query(`DELETE FROM counter_links WHERE company_id = $1`, [f.a.id])).rejects.toThrow();
  });
});

describe('Access', () => {
  let server: FastifyInstance;
  beforeAll(() => { server = buildServer({ pool: appPool, sessionSecret: 'counter-secret' }); });
  it('a counter role without Sales or Purchases records goods only; the invoice and the bill need those modules', async () => {
    const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email: storeKeeperEmail, password: 'pw-123456' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const sale = await server.inject({ method: 'POST', url: `/api/companies/${f.a.id}/counter/sale`, headers: { cookie },
      payload: { date: '2026-04-09', contactId: customer, lines: [{ itemId: rice, quantity: '1' }] } });
    expect(sale.statusCode).toBe(403);
    const receive = await server.inject({ method: 'POST', url: `/api/companies/${f.a.id}/counter/receive`, headers: { cookie },
      payload: { date: '2026-04-09', contactId: supplier, lines: [{ itemId: rice, quantity: '1', unitCost: '80' }] } });
    expect(receive.statusCode).toBe(403);
    const goods = await server.inject({ method: 'POST', url: `/api/companies/${f.a.id}/stock-notes/quick`, headers: { cookie },
      payload: { type: 'gdn', date: '2026-04-09', lines: [{ itemId: rice, quantity: '1' }] } });
    expect(goods.statusCode, goods.body).toBe(200);
    await server.close();
  });
});
