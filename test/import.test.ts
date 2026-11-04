// Bulk import against the database: new rows added, existing ones left alone, problem rows left out, opening
// balances all together and balanced, roles and separation.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as Imp from '../src/books/importService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
beforeAll(async () => {
  f = await seed();
  await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '1100', 'Receivables', 'asset'), ($1, '3000', 'Owner''s equity', 'equity')`, [f.a.id]);
  await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel Trading', country: 'SA', vatNumber: '300000000000003' }));
});

describe('Customers', () => {
  const rows = [
    ['Name', 'VAT number', 'City', 'Building number'],
    ['Gulf Steel Trading', '300000000000003', 'Riyadh', ''],      // already there
    ['Najran Builders', '311111111100003', 'Najran', '1234'],     // new
    ['Al Faisal', '123', 'Jeddah', ''],                           // bad VAT number
    ['Najran Builders', '', '', ''],                              // repeated in the file
    ['مؤسسة النور', '', 'الرياض', '١٢٣٤'],                         // new, Arabic digits
  ];
  it('the preview says what will happen to each row and why', async () => {
    const p = await as(f.a.clientAccountant, (db) => Imp.preview(db, f.a.id, 'customers', rows));
    expect(p.rows.map((r) => [r.line, r.status, r.problems])).toEqual([
      [2, 'exists', []], [3, 'new', []], [4, 'error', ['imp.p.saVat']], [5, 'error', ['imp.p.repeated']], [6, 'new', []]]);
    expect(p.counts).toEqual({ new: 2, exists: 1, error: 2 });
  });
  it('importing adds only the new rows, through the normal rules, audited', async () => {
    const r = await as(f.a.clientAccountant, (db) => Imp.run(db, f.a.id, 'customers', rows));
    expect(r).toMatchObject({ imported: 2, skipped: 3 });
    const names = (await owner.query(`SELECT name, building_number FROM contacts WHERE company_id = $1 AND is_customer ORDER BY name`, [f.a.id])).rows;
    expect(names.map((x) => x.name)).toEqual(['Gulf Steel Trading', 'Najran Builders', 'مؤسسة النور']);
    expect(names.find((x) => x.name === 'مؤسسة النور').building_number).toBe('1234');
    await expect(as(f.a.clientAccountant, (db) => Imp.run(db, f.a.id, 'customers', rows))).rejects.toThrow(/nothing new/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'contacts' AND company_id = $1`, [f.a.id])).rows[0].n).toBeGreaterThanOrEqual(3);
  });
  it('a missing required column is reported, and view-only people cannot import', async () => {
    const p = await as(f.a.clientAccountant, (db) => Imp.preview(db, f.a.id, 'suppliers', [['City'], ['Riyadh']]));
    expect(p.missing).toEqual(['name']);
    await expect(as(f.a.clientViewer, (db) => Imp.run(db, f.a.id, 'suppliers', [['Name'], ['New supplier']]))).rejects.toThrow();
  });
});

describe('Items and accounts', () => {
  it('items by code; accounts by code with the type in English or Arabic', async () => {
    expect(await as(f.staff, (db) => Imp.run(db, f.a.id, 'items', [['Code', 'Name', 'Sale price'], ['B6', 'Beam 6m', '1,250.50'], ['B6', 'Beam again', '']]))).toMatchObject({ imported: 1, skipped: 1 });
    expect((await owner.query(`SELECT sale_price::text FROM items WHERE company_id = $1 AND sku = 'B6'`, [f.a.id])).rows[0].sale_price).toBe('1250.50');
    const r = await as(f.staff, (db) => Imp.run(db, f.a.id, 'accounts', [['رمز الحساب', 'اسم الحساب', 'النوع'], ['5450', 'التسويق', 'مصروفات'], ['1000', 'Cash', 'asset'], ['4100', 'Wrong', 'expense']]));
    expect(r).toMatchObject({ imported: 1, skipped: 2 });
  });
});

describe('Opening balances', () => {
  const tb = [['Account code', 'Debit', 'Credit'], ['1000', '50,000.00', ''], ['1100', '20000', ''], ['5000', '', '10000']];
  it('must balance, unless the difference goes to owner\'s equity; posted as one entry', async () => {
    const p = await as(f.staff, (db) => Imp.preview(db, f.a.id, 'opening', tb, { date: '2026-01-01' }));
    expect(p.opening).toMatchObject({ debit: '70000.00', credit: '10000.00', difference: '60000.00', problems: ['imp.p.unbalanced'], warnings: ['imp.w.control'] });
    await expect(as(f.staff, (db) => Imp.run(db, f.a.id, 'opening', tb, { date: '2026-01-01' }))).rejects.toThrow(/cannot be posted/);
    const r = await as(f.staff, (db) => Imp.run(db, f.a.id, 'opening', tb, { date: '2026-01-01', balanceToEquity: true }));
    const lines = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code`, [r.entryId])).rows;
    expect(lines).toEqual([{ code: '1000', debit: '50000.00', credit: '0.00' }, { code: '1100', debit: '20000.00', credit: '0.00' },
      { code: '3000', debit: '0.00', credit: '60000.00' }, { code: '5000', debit: '0.00', credit: '10000.00' }]);
    expect((await as(f.staff, (db) => Imp.preview(db, f.a.id, 'opening', tb, { date: '2026-01-01' }))).opening!.warnings).toContain('imp.w.again');
  });
  it('unknown accounts, accounts that need a cost centre, and locked months are stopped before anything is posted', async () => {
    const p = await as(f.staff, (db) => Imp.preview(db, f.a.id, 'opening', [['Account code', 'Debit', 'Credit'], ['9999', '1', ''], ['5100', '', '1']], { date: '2026-01-01' }));
    expect(p.rows.map((r) => r.problems)).toEqual([['imp.p.noAccount'], ['imp.p.costCentre']]);
    await owner.query(`INSERT INTO periods (company_id, start_date, end_date, locked_at) VALUES ($1, '2025-12-01', '2025-12-31', now())`, [f.a.id]);
    const q = await as(f.staff, (db) => Imp.preview(db, f.a.id, 'opening', [['Account code', 'Debit', 'Credit'], ['1000', '1', ''], ['3000', '', '1']], { date: '2025-12-31' }));
    expect(q.opening!.problems).toEqual(['imp.p.locked']);
  });
  it('another company cannot import into this one', async () => {
    await expect(as(f.b.clientAccountant, (db) => Imp.run(db, f.a.id, 'customers', [['Name'], ['Intruder']]))).rejects.toThrow();
    expect((await owner.query(`SELECT count(*)::int AS n FROM contacts WHERE name = 'Intruder'`)).rows[0].n).toBe(0);
  });
});
