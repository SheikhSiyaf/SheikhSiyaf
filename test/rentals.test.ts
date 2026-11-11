// Rentals (db/migrations/0041, src/books/rentalService.ts): items with rates, contracts with lines out and back, no
// double booking, hours for hourly items, billing into a draft invoice on rental income, each period billed once.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as R from '../src/books/rentalService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let crane: string, frames: string, customer: string, other: string, contract: string;
const bal = async (code: string) => (await owner.query(`SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l
  JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [f.a.id, code])).rows[0].v;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['4100', 'Rental income', 'income']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Builders', paymentTermsDays: 30 }));
  other = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Desert Towers' }));
});

describe('Rental items', () => {
  it('need a code, a name and at least one rate; income goes to 4100 unless chosen', async () => {
    await expect(as(f.staff, (db) => R.saveItem(db, f.a.id, { code: 'CR-50', name: 'Mobile crane 50t' }))).rejects.toThrow(/at least one rate/);
    crane = await as(f.staff, (db) => R.saveItem(db, f.a.id, { code: 'CR-50', name: 'Mobile crane 50t', category: 'Crane', identifier: 'Plate 1234 ABC', dayRate: '1500.00', hourRate: '350.00', monthRate: '30000.00' }));
    frames = await as(f.staff, (db) => R.saveItem(db, f.a.id, { code: 'SC-FR', name: 'Scaffolding frame', category: 'Scaffolding', units: 500, dayRate: '2.50', weekRate: '12.00' }));
    const items = await as(f.staff, (db) => R.listItems(db, f.a.id, '2026-11-01'));
    expect(items.find((i) => i.id === crane)).toMatchObject({ code: 'CR-50', incomeAccountCode: '4100', units: 1, out: 0 });
    await expect(as(f.a.clientViewer, (db) => R.saveItem(db, f.a.id, { code: 'X', name: 'X', dayRate: '1' }))).rejects.toThrow();
  });
});

describe('Rental contracts', () => {
  it('numbered RNT-; an item is never out twice on the same day; units count for pooled items', async () => {
    contract = await as(f.staff, (db) => R.saveContract(db, f.a.id, { contactId: customer, site: 'Riyadh Metro, station 4', reference: 'PO-778' }));
    expect((await as(f.staff, (db) => R.getContract(db, contract))).number).toBe('RNT-0001');
    await as(f.staff, (db) => R.addLine(db, contract, { itemId: crane, basis: 'day', outDate: '2026-11-01' }));   // rate taken from the item
    await as(f.staff, (db) => R.addLine(db, contract, { itemId: frames, basis: 'week', units: 300, outDate: '2026-11-01' }));
    const second = await as(f.staff, (db) => R.saveContract(db, f.a.id, { contactId: other }));
    await expect(as(f.staff, (db) => R.addLine(db, second, { itemId: crane, basis: 'day', outDate: '2026-11-20' }))).rejects.toThrow(/already rented out/);
    await expect(as(f.staff, (db) => R.addLine(db, second, { itemId: frames, basis: 'day', units: 250, outDate: '2026-11-05' }))).rejects.toThrow(/200 of 500 units free/);
    await as(f.staff, (db) => R.addLine(db, second, { itemId: frames, basis: 'day', units: 200, outDate: '2026-11-05', returnDate: '2026-11-06' }));
    const c = await as(f.staff, (db) => R.getContract(db, contract));
    expect(c.lines.map((l: { rate: string; basis: string }) => [l.basis, l.rate])).toEqual([['day', '1500.00'], ['week', '12.00']]);
  });

  it('hours are recorded only for items rented by the hour, on days they were out', async () => {
    const c2 = await as(f.staff, (db) => R.saveContract(db, f.a.id, { contactId: other }));
    const crane2 = await as(f.staff, (db) => R.saveItem(db, f.a.id, { code: 'CR-25', name: 'Mobile crane 25t', hourRate: '250.00' }));
    const line = await as(f.staff, (db) => R.addLine(db, c2, { itemId: crane2, basis: 'hour', outDate: '2026-11-02' }));
    await as(f.staff, (db) => R.recordHours(db, line, '2026-11-02', '8'));
    await as(f.staff, (db) => R.recordHours(db, line, '2026-11-03', '9.5'));
    await expect(as(f.staff, (db) => R.recordHours(db, line, '2026-11-01', '4'))).rejects.toThrow(/days the item was out/);
    const dayLine = (await as(f.staff, (db) => R.getContract(db, contract))).lines[0].id;
    await expect(as(f.staff, (db) => R.recordHours(db, dayLine, '2026-11-02', '8'))).rejects.toThrow(/only for items rented by the hour/);
    const id = await as(f.staff, (db) => R.bill(db, c2, '2026-11-30'));
    const inv = await as(f.staff, (db) => S.getDocument(db, id));
    expect(inv.lines.map((l: { quantity: string; unitPrice: string; net: string }) => [l.quantity, l.unitPrice, l.net])).toEqual([['17.500', '250.00', '4375.00']]);
    await expect(as(f.staff, (db) => R.recordHours(db, line, '2026-11-03', '10'))).rejects.toThrow(/billed/);
  });

  it('billing makes a draft invoice on rental income for each line, up to the day; a period is billed once', async () => {
    const id = await as(f.staff, (db) => R.bill(db, contract, '2026-11-10'));
    const inv = await as(f.staff, (db) => S.getDocument(db, id));
    expect(inv).toMatchObject({ type: 'invoice', status: 'draft', contactId: customer, reference: 'PO-778' });
    expect(inv.lines.map((l: { description: string; quantity: string; unitPrice: string; net: string; accountCode: string }) => [l.quantity, l.unitPrice, l.net, l.accountCode])).toEqual([
      ['10.000', '1500.00', '15000.00', '4100'],      // crane: 10 days at 1,500
      ['1.000', '5142.86', '5142.86', '4100'],        // 300 frames x 12.00 a week x 10 days / 7
    ]);
    expect(inv.lines[0].description).toContain('2026-11-01 to 2026-11-10');
    await expect(as(f.staff, (db) => R.bill(db, contract, '2026-11-10'))).rejects.toThrow(/Nothing to bill/);
    // Deleting the draft frees the period; issuing it posts the rental income.
    await as(f.staff, (db) => S.deleteDraft(db, id));
    const again = await as(f.staff, (db) => R.bill(db, contract, '2026-11-10'));
    await as(f.staff, (db) => S.issueDocument(db, again));
    expect(await bal('4100')).toBe('20142.86');
  });

  it('a billed line keeps its rate and start; the return date cannot go back before what is billed', async () => {
    const line = (await as(f.staff, (db) => R.getContract(db, contract))).lines[0];
    await expect(as(f.staff, (db) => R.updateLine(db, line.id, { rate: '1200.00' }))).rejects.toThrow(/billed/);
    await expect(as(f.staff, (db) => R.returnLine(db, line.id, '2026-11-08'))).rejects.toThrow(/before the end of what has been billed/);
  });

  it('returned items bill to the return day; closing needs everything back and billed', async () => {
    const lines = (await as(f.staff, (db) => R.getContract(db, contract))).lines;
    await as(f.staff, (db) => R.returnLine(db, lines[0].id, '2026-11-15'));
    await expect(as(f.staff, (db) => R.closeContract(db, contract))).rejects.toThrow(/return of every item/);
    await as(f.staff, (db) => R.returnLine(db, lines[1].id, '2026-11-12'));
    await expect(as(f.staff, (db) => R.closeContract(db, contract))).rejects.toThrow(/Bill the rental up to the return dates/);
    const id = await as(f.staff, (db) => R.bill(db, contract, '2026-11-30'));
    const inv = await as(f.staff, (db) => S.getDocument(db, id));
    expect(inv.lines.map((l: { net: string }) => l.net)).toEqual(['7500.00', '1028.57']);   // 5 crane days; 300 frames x 12 x 2 / 7
    await as(f.staff, (db) => S.issueDocument(db, id));
    await as(f.staff, (db) => R.closeContract(db, contract));
    expect((await as(f.staff, (db) => R.getContract(db, contract))).status).toBe('closed');
    // The crane is free again after its return.
    const c3 = await as(f.staff, (db) => R.saveContract(db, f.a.id, { contactId: other }));
    await as(f.staff, (db) => R.addLine(db, c3, { itemId: crane, basis: 'month', outDate: '2026-11-16' }));
  });

  it('a billed contract is not cancelled; another company sees none of it', async () => {
    await expect(as(f.staff, (db) => R.cancelContract(db, contract))).rejects.toThrow();
    expect(await as(f.b.clientAccountant, (db) => R.listContracts(db, f.a.id))).toEqual([]);
    await expect(owner.query('DELETE FROM rental_contracts WHERE id = $1', [contract])).rejects.toThrow();
  });

  it('the board shows what is out, booked and not yet billed', async () => {
    const b = await as(f.staff, (db) => R.board(db, f.a.id, '2026-11-20'));
    expect(b.onHire).toBeGreaterThan(0);
    expect(BigInt(b.unbilled.replace('.', ''))).toBeGreaterThan(0n);
  });
});
