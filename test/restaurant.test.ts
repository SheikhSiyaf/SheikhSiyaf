// Restaurant: industry and modules, menu items with recipes, and food sales that issue an invoice,
// use the recipe materials at average cost and record the payment, all together or not at all.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as R from '../src/books/restaurantService.js';
import * as I from '../src/books/inventoryService.js';
import * as S from '../src/books/documentsService.js';
import { DEFAULT_MODULES, cleanModules } from '../src/books/modules.js';

let f: Fixture;
let chicken: string, rice: string, coffee: string, machboos: string, cappuccino: string, regular: string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['1300', 'Inventory', 'asset'],
    ['2000', 'Payables', 'liability'], ['2050', 'Goods received not yet billed', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  chicken = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'CH', name: 'Chicken', unit: 'kg' }));
  rice = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'RI', name: 'Rice', unit: 'kg' }));
  coffee = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'CO', name: 'Coffee beans', unit: 'kg' }));
  await as(f.staff, async (db) => {
    const id = await I.saveNoteDraft(db, f.a.id, { type: 'grn', date: '2026-03-01', lines: [
      { itemId: chicken, quantity: '10', unitCost: '22.00' }, { itemId: rice, quantity: '20', unitCost: '7.50' }, { itemId: coffee, quantity: '0.1', unitCost: '80.00' }] });
    await I.postNote(db, id);
  });
  regular = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Hotel Marina' }));
});

const restaurantOn = () => owner.query(`UPDATE companies SET modules = ARRAY['Restaurant','Assets'] WHERE id = $1`, [f.a.id]);
const sell = (over: Partial<R.SaleInput> = {}) => as(f.a.clientAccountant, (db) => R.sellFood(db, f.a.id, {
  date: '2026-03-05', method: 'cash', accountId: f.a.cash, lines: [{ recipeId: machboos, quantity: 2 }, { recipeId: cappuccino, quantity: 1 }], ...over }));

describe('Industry and modules', () => {
  it('a restaurant starts with the Restaurant module and without Inventory; unknown modules are dropped', () => {
    expect(DEFAULT_MODULES.restaurant).toContain('Restaurant');
    expect(DEFAULT_MODULES.restaurant).not.toContain('Inventory');
    expect(DEFAULT_MODULES.trading).toContain('Inventory');
    expect(cleanModules(['CRM', 'Payroll', 'Inventory'])).toEqual(['Inventory', 'CRM']);
  });

  it('menu items and food sales need the Restaurant module', async () => {
    await expect(as(f.staff, (db) => R.saveRecipe(db, f.a.id, { name: 'X', salePrice: '1.00' }))).rejects.toThrow(/Restaurant module is not turned on/);
    await expect(owner.query(`UPDATE companies SET modules = ARRAY['Payroll'] WHERE id = $1`, [f.a.id])).rejects.toThrow(/modules_check/);
    await restaurantOn();
  });
});

describe('Menu items and recipes', () => {
  it('cost one portion from its materials at average cost, with food cost % and margin', async () => {
    machboos = await as(f.staff, (db) => R.saveRecipe(db, f.a.id, { name: 'Chicken machboos', category: 'Mains', salePrice: '38.00',
      lines: [{ itemId: chicken, quantity: '0.300' }, { itemId: rice, quantity: '0.200' }] }));
    cappuccino = await as(f.staff, (db) => R.saveRecipe(db, f.a.id, { name: 'Cappuccino', category: 'Drinks', salePrice: '16.00', lines: [{ itemId: coffee, quantity: '0.018' }] }));
    const m = await as(f.staff, (db) => R.getRecipe(db, machboos));
    expect(m).toMatchObject({ cost: '8.10', margin: '29.90', foodCostPct: 21.3 });   // 0.3 x 22 + 0.2 x 7.50
    await expect(as(f.staff, (db) => R.saveRecipe(db, f.a.id, { name: 'Chicken machboos', salePrice: '1.00' }))).rejects.toThrow(/recipes_company_id_name_key/);
    await expect(as(f.staff, (db) => R.saveRecipe(db, f.a.id, { name: 'Twice', salePrice: '1.00', lines: [{ itemId: rice, quantity: '1' }, { itemId: rice, quantity: '2' }] })))
      .rejects.toThrow(/appears once/);
    await expect(as(f.b.clientAccountant, (db) => R.getRecipe(db, machboos))).rejects.toThrow(/Not found/);
  });
});

describe('Food sales', () => {
  it('one sale issues the tax invoice, uses the materials at average cost and records the payment', async () => {
    const r = await sell();
    const doc = await as(f.staff, (db) => S.getDocument(db, r.invoiceId));
    expect(doc).toMatchObject({ type: 'invoice', status: 'issued', state: 'paid', netTotal: '92.00', vatTotal: '13.80', grossTotal: '105.80', contactName: 'Walk-in customer' });
    expect(doc.lines.map((l: { description: string; quantity: string }) => [l.description, l.quantity])).toEqual([['Chicken machboos', '2.000'], ['Cappuccino', '1.000']]);
    // Materials used: 0.6 kg chicken (13.20), 0.4 kg rice (3.00), 0.018 kg coffee (1.44): Dr 5000 / Cr 1300.
    const sale = (await owner.query('SELECT stock_note_id, payment_id FROM restaurant_sales WHERE document_id = $1', [r.invoiceId])).rows[0];
    const cost = (await owner.query(`SELECT a.code, sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM stock_notes n JOIN journal_lines l ON l.entry_id = n.journal_entry_id
      JOIN accounts a ON a.id = l.account_id WHERE n.id = $1 GROUP BY a.code ORDER BY a.code`, [sale.stock_note_id])).rows.map((x) => [x.code, x.d, x.c]);
    expect(cost).toEqual([['1300', '0.00', '17.64'], ['5000', '17.64', '0.00']]);
    expect((await as(f.staff, (db) => I.getItem(db, chicken))).qtyOnHand).toBe('9.400');
    expect(sale.payment_id).not.toBeNull();
    const list = await as(f.partner, (db) => R.listSales(db, f.a.id, '2026-03-01', '2026-03-31'));
    expect(list).toMatchObject({ count: 1, netTotal: '92.00', foodCost: '17.64' });
  });

  it('a sale on account needs a named customer and leaves the invoice to be paid', async () => {
    await expect(sell({ method: 'on_account', accountId: null })).rejects.toThrow(/customer the sale is charged to/);
    const r = await sell({ method: 'on_account', accountId: null, contactId: regular, lines: [{ recipeId: machboos, quantity: 1 }] });
    const d = await as(f.staff, (db) => S.getDocument(db, r.invoiceId));
    expect(d.amountDue).toBe(d.grossTotal);   // nothing paid yet (overdue, as it was due on the day of the sale)
  });

  it('when a material runs out nothing is recorded: no invoice, no stock movement, no payment', async () => {
    const before = (await owner.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = 'invoice'`, [f.a.id])).rows[0].n;
    await expect(sell({ lines: [{ recipeId: cappuccino, quantity: 10 }] })).rejects.toThrow(/Not enough stock of Coffee beans/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = 'invoice'`, [f.a.id])).rows[0].n).toBe(before);
  });

  it('archived menu items cannot be sold; sales never change; view-only users cannot sell', async () => {
    await as(f.staff, async (db) => R.saveRecipe(db, f.a.id, { ...(await R.getRecipe(db, cappuccino)), status: 'archived' }, cappuccino));
    await expect(sell({ lines: [{ recipeId: cappuccino, quantity: 1 }] })).rejects.toThrow(/no longer on the menu/);
    await expect(owner.query(`UPDATE restaurant_sales SET method = 'card' WHERE company_id = $1`, [f.a.id])).rejects.toThrow();
    await expect(as(f.a.clientViewer, (db) => R.sellFood(db, f.a.id, { date: '2026-03-05', method: 'cash', accountId: f.a.cash, lines: [{ recipeId: machboos, quantity: 1 }] }))).rejects.toThrow();
  });

  it('food sales leave out of the manual goods delivery list (waste)', async () => {
    const all = await as(f.staff, (db) => I.listNotes(db, f.a.id, 'gdn'));
    const manual = await as(f.staff, (db) => I.listNotes(db, f.a.id, 'gdn', '', true));
    expect(all.length).toBeGreaterThan(0);
    expect(manual).toEqual([]);
  });
});
