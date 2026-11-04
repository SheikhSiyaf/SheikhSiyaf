// Warehouse counter: every item has a barcode (its own or one Nusuh makes), a scan finds it, and goods in or out
// are recorded and posted in one step, all or nothing. Counter roles (POS users) are known to the books.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture } from './helpers.js';
import * as I from '../src/books/inventoryService.js';
import * as S from '../src/books/documentsService.js';
import { badCheckDigit } from '../src/books/barcode.js';

let f: Fixture;
let rice: string, oil: string, supplier: string, storeKeeper: string;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1300', 'Inventory', 'asset'], ['2050', 'Goods received not yet billed', 'liability'], ['5000', 'Cost of sales', 'expense']]) {
    if ((await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) continue;
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  rice = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'RICE-25', name: 'Basmati rice 25 kg', unit: 'bag' }));
  oil = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'OIL-5', name: 'Sunflower oil 5 L', barcode: '4006381333931' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
  // A store keeper whose role works the counter only.
  const firm = (await owner.query('SELECT firm_id FROM companies WHERE id = $1', [f.a.id])).rows[0].firm_id;
  const role = (await owner.query(`INSERT INTO client_roles (firm_id, name, permissions, pos_mode) VALUES ($1, 'Store keeper', $2, true) RETURNING id`,
    [firm, JSON.stringify({ Inventory: 'edit' })])).rows[0].id;
  storeKeeper = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash) VALUES ($1, 'client', 'Store Keeper', $2, 'x') RETURNING id`,
    [firm, `sk.${Date.now()}@example.com`])).rows[0].id;
  await owner.query(`INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, 'client_accountant', $3)`, [storeKeeper, f.a.id, role]);
});

const item = (id: string) => as(f.staff, (db) => I.getItem(db, id));

describe('Barcodes', () => {
  it('an item without a code gets one: 13 digits, starting with 2, with a correct check digit', async () => {
    const r = await item(rice);
    expect(r.barcode).toMatch(/^2\d{12}$/);
    expect(badCheckDigit(r.barcode)).toBe(false);
  });

  it("keeps the supplier's code; editing without a code keeps it; clearing it makes a new one", async () => {
    expect((await item(oil)).barcode).toBe('4006381333931');
    await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'OIL-5', name: 'Sunflower oil 5 litres' }, oil));
    expect((await item(oil)).barcode).toBe('4006381333931');
    const temp = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'TMP', name: 'Temp', barcode: 'TMP-01' }));
    await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'TMP', name: 'Temp', barcode: '' }, temp));
    expect((await item(temp)).barcode).toMatch(/^2\d{12}$/);
  });

  it('refuses a mistyped retail code and a code another item has', async () => {
    await expect(as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'X1', name: 'X', barcode: '4006381333932' }))).rejects.toThrow(/last digit/);
    await expect(as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'X2', name: 'X', barcode: '4006381333931' }))).rejects.toThrow(/items_company_barcode_key/);
    await expect(owner.query(`UPDATE items SET barcode = 'has space' WHERE id = $1`, [rice])).resolves.toBeTruthy();   // spaces are taken out
    expect((await item(rice)).barcode).toBe('hasspace');
  });

  it('a scan finds the item by barcode or item code, only in this company', async () => {
    expect((await as(f.staff, (db) => I.findByCode(db, f.a.id, ' 4006381333931 ')))?.id).toBe(oil);
    expect((await as(f.staff, (db) => I.findByCode(db, f.a.id, 'rice-25')))?.id).toBe(rice);
    expect(await as(f.staff, (db) => I.findByCode(db, f.a.id, 'nothing'))).toBeNull();
    expect(await as(f.b.clientAccountant, (db) => I.findByCode(db, f.a.id, '4006381333931'))).toBeNull();
  });
});

describe('Counter: goods in and out in one step', () => {
  it('goods in are numbered and posted straight away (Dr 1300 / Cr 2050)', async () => {
    const r = await as(storeKeeper, (db) => I.quickNote(db, f.a.id, { type: 'grn', date: '2026-03-02', contactId: supplier,
      lines: [{ itemId: oil, quantity: '20', unitCost: '18.50' }, { itemId: rice, quantity: '4', unitCost: '95.00' }] }));
    expect(r).toMatchObject({ number: 'GRN-0001', totalValue: '750.00' });
    expect((await item(oil)).qtyOnHand).toBe('20.000');
    const lines = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM stock_notes n JOIN journal_lines l ON l.entry_id = n.journal_entry_id
      JOIN accounts a ON a.id = l.account_id WHERE n.id = $1 ORDER BY a.code`, [r.id])).rows.map((x) => [x.code, x.debit, x.credit]);
    expect(lines).toEqual([['1300', '750.00', '0.00'], ['2050', '0.00', '750.00']]);
  });

  it('goods out at average cost; asking for more than in stock leaves nothing behind', async () => {
    const before = (await owner.query(`SELECT count(*)::int AS n FROM stock_notes WHERE company_id = $1`, [f.a.id])).rows[0].n;
    await expect(as(storeKeeper, (db) => I.quickNote(db, f.a.id, { type: 'gdn', date: '2026-03-03', lines: [{ itemId: oil, quantity: '5' }, { itemId: rice, quantity: '9' }] })))
      .rejects.toThrow(/Not enough stock/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM stock_notes WHERE company_id = $1`, [f.a.id])).rows[0].n).toBe(before);
    const r = await as(storeKeeper, (db) => I.quickNote(db, f.a.id, { type: 'gdn', date: '2026-03-03', lines: [{ itemId: oil, quantity: '5' }] }));
    expect(r).toMatchObject({ number: 'GDN-0001', totalValue: '92.50' });
    expect((await item(oil)).qtyOnHand).toBe('15.000');
  });

  it('a locked month refuses the counter too', async () => {
    await addPeriod(f.a.id, '2026-01-01', '2026-01-31', true);
    await expect(as(storeKeeper, (db) => I.quickNote(db, f.a.id, { type: 'grn', date: '2026-01-15', lines: [{ itemId: oil, quantity: '1', unitCost: '1.00' }] })))
      .rejects.toThrow(/locked/i);
  });

  it('the books know a counter role', async () => {
    const r = (await as(storeKeeper, (db) => db.query('SELECT pos_mode FROM app_client_role($1)', [f.a.id]))).rows[0];
    expect(r.pos_mode).toBe(true);
    expect((await as(f.a.clientAccountant, (db) => db.query('SELECT pos_mode FROM app_client_role($1)', [f.a.id]))).rows[0]?.pos_mode ?? false).toBe(false);
  });
});
