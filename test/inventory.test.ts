// Inventory: goods received (GRN) and delivered (GDN) at weighted average cost, and the books agree.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, addPeriod, type Fixture } from './helpers.js';
import * as I from '../src/books/inventoryService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let inv: string, grni: string, steel: string, bolts: string, supplier: string, customer: string;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1200', 'Input VAT', 'asset'], ['1300', 'Inventory', 'asset'], ['2000', 'Payables', 'liability'],
    ['2050', 'Goods received not yet billed', 'liability'], ['3000', 'Owner', 'equity'], ['1100', 'Receivables', 'asset']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  const acct = async (code: string) => (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = $2`, [f.a.id, code])).rows[0].id;
  inv = await acct('1300'); grni = await acct('2050');
  steel = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'ST-12', name: 'Steel beam 12m', unit: 'pcs', salePrice: '650.00', reorderLevel: '5' }));
  bolts = await as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'BL-10', name: 'Bolts M10 (box)', unit: 'box' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
});

const item = async (id: string) => as(f.staff, (db) => I.getItem(db, id));
const grn = (date: string, lines: I.NoteLineInput[], over: Partial<I.NoteInput> = {}) =>
  as(f.a.clientAccountant, async (db) => { const id = await I.saveNoteDraft(db, f.a.id, { type: 'grn', date, contactId: supplier, lines, ...over }); await I.postNote(db, id); return id; });
const gdn = (date: string, lines: I.NoteLineInput[]) =>
  as(f.a.clientAccountant, async (db) => { const id = await I.saveNoteDraft(db, f.a.id, { type: 'gdn', date, contactId: customer, lines }); await I.postNote(db, id); return id; });
const entry = async (noteId: string) => (await owner.query(
  `SELECT a.code, l.debit::text, l.credit::text FROM stock_notes n JOIN journal_lines l ON l.entry_id = n.journal_entry_id JOIN accounts a ON a.id = l.account_id
   WHERE n.id = $1 ORDER BY a.code`, [noteId])).rows.map((r) => [r.code, r.debit, r.credit]);

describe('Items', () => {
  it('start with no stock; stock never changes except through goods notes; codes are unique', async () => {
    expect(await item(steel)).toMatchObject({ qtyOnHand: '0.000', valueOnHand: '0.00' });
    await expect(owner.query(`UPDATE items SET qty_on_hand = 10 WHERE id = $1`, [steel])).rejects.toThrow(/only through goods/);
    await expect(as(f.staff, (db) => I.saveItem(db, f.a.id, { sku: 'ST-12', name: 'Copy' }))).rejects.toThrow(/items_company_id_sku_key/);
  });
});

describe('Goods received (GRN)', () => {
  it('adds stock at cost and posts Dr 1300 Inventory / Cr 2050 Goods received not yet billed', async () => {
    const id = await grn('2026-03-01', [{ itemId: steel, quantity: '10', unitCost: '400.00' }, { itemId: bolts, quantity: '3', unitCost: '33.33' }]);
    expect(await entry(id)).toEqual([['1300', '4099.99', '0.00'], ['2050', '0.00', '4099.99']]);
    expect(await item(steel)).toMatchObject({ qtyOnHand: '10.000', valueOnHand: '4000.00', averageCost: '400.00' });
    expect((await owner.query('SELECT number FROM stock_notes WHERE id = $1', [id])).rows[0].number).toBe('GRN-0001');
  });

  it('a second delivery at a different price changes the average cost', async () => {
    await grn('2026-03-05', [{ itemId: steel, quantity: '5', unitCost: '430.00' }]);
    expect(await item(steel)).toMatchObject({ qtyOnHand: '15.000', valueOnHand: '6150.00', averageCost: '410.00' });
  });

  it('opening stock can be credited to equity; only liability or equity accounts are allowed', async () => {
    const owners = (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '3000'`, [f.a.id])).rows[0].id;
    await expect(grn('2026-03-01', [{ itemId: bolts, quantity: '1', unitCost: '1.00' }], { otherAccountId: f.a.sales })).rejects.toThrow(/liability or equity/);
    const id = await grn('2026-03-01', [{ itemId: bolts, quantity: '2', unitCost: '30.00' }], { otherAccountId: owners, contactId: null });
    expect(await entry(id)).toEqual([['1300', '60.00', '0.00'], ['3000', '0.00', '60.00']]);
  });

  it('the supplier\'s bill can use 2050, which clears it', async () => {
    await as(f.staff, async (db) => {
      const d = await S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-06',
        lines: [{ description: 'Steel beams', quantity: '10', unitPrice: '400.00', accountId: grni, vatCode: 'standard' }] });
      await S.issueDocument(db, d);
    });
    const v = (await owner.query(`SELECT sum(credit - debit)::text AS v FROM journal_lines WHERE account_id = $1`, [grni])).rows[0].v;
    expect(v).toBe('2249.99');   // 4099.99 + 2150.00 received - 4000.00 billed
  });
});

describe('Goods delivered (GDN)', () => {
  it('takes stock out at the average cost and posts Dr 5000 Cost of sales / Cr 1300 Inventory', async () => {
    const id = await gdn('2026-03-10', [{ itemId: steel, quantity: '4' }]);
    expect(await entry(id)).toEqual([['1300', '0.00', '1640.00'], ['5000', '1640.00', '0.00']]);
    expect(await item(steel)).toMatchObject({ qtyOnHand: '11.000', valueOnHand: '4510.00' });
  });

  it('never goes below zero, and the last units take all the remaining value', async () => {
    await expect(gdn('2026-03-11', [{ itemId: steel, quantity: '12' }])).rejects.toThrow(/Not enough stock/);
    await gdn('2026-03-12', [{ itemId: bolts, quantity: '1' }]);   // 5 boxes worth 159.99 -> 32.00
    await gdn('2026-03-12', [{ itemId: bolts, quantity: '4' }]);
    expect(await item(bolts)).toMatchObject({ qtyOnHand: '0.000', valueOnHand: '0.00' });
  });

  it('the database checks the average cost itself', async () => {
    const id = await as(f.a.clientAccountant, (db) => I.saveNoteDraft(db, f.a.id, { type: 'gdn', date: '2026-03-13', lines: [{ itemId: steel, quantity: '1' }] }));
    await owner.query(`UPDATE stock_note_lines SET value = 1 WHERE note_id = $1`, [id]);
    await expect(owner.query(`UPDATE stock_notes SET status = 'posted', number = 'X', total_value = 1 WHERE id = $1`, [id])).rejects.toThrow(/average cost/);
  });
});

describe('Posted notes, locked periods, roles and separation', () => {
  it('posted notes never change; locked periods refuse them; view-only users and other companies cannot post', async () => {
    const id = (await owner.query(`SELECT id FROM stock_notes WHERE company_id = $1 AND status = 'posted' LIMIT 1`, [f.a.id])).rows[0].id;
    await expect(owner.query(`UPDATE stock_notes SET notes = 'x' WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(owner.query(`DELETE FROM stock_note_lines WHERE note_id = $1`, [id])).rejects.toThrow(/never changed/);
    await addPeriod(f.a.id, '2026-01-01', '2026-01-31', true);
    await expect(grn('2026-01-15', [{ itemId: steel, quantity: '1', unitCost: '1.00' }])).rejects.toThrow(/locked/);
    await expect(as(f.a.clientViewer, (db) => I.saveItem(db, f.a.id, { sku: 'X', name: 'X' }))).rejects.toThrow();
    expect(await as(f.b.clientAccountant, (db) => I.listItems(db, f.a.id))).toEqual([]);
  });

  it('stock value equals 1300 Inventory in the books', async () => {
    const r = await as(f.partner, (db) => I.stockValue(db, f.a.id));
    expect(r.difference).toBe('0.00');
    const v = (await owner.query(`SELECT sum(debit - credit)::text AS v FROM journal_lines WHERE account_id = $1`, [inv])).rows[0].v;
    expect(r.total).toBe(v);
  });
});
