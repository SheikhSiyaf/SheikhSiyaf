// Chart of accounts, cost centres, attachments, the ZATCA QR code and Excel export.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as U from '../src/books/setupService.js';
import * as S from '../src/books/documentsService.js';
import { postEntry } from '../src/ledger/ledger.js';
import { readZatcaQr, zatcaQrPayload, zatcaTimestamp } from '../src/einvoice/zatcaQr.js';
import { toCell, writeXlsx } from '../src/export/xlsx.js';
import { readXlsx } from '../src/bank/xlsx.js';

let f: Fixture;
let supplier: string, bill: string;
const PDF = Buffer.from('%PDF-1.4\n% supplier invoice\n').toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['1100', 'Receivables', 'asset']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
  bill = await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-01', reference: 'NW-1',
    lines: [{ description: 'Stock', quantity: '1', unitPrice: '100.00', accountId: f.a.rent, vatCode: 'standard' }] }));
});

describe('Chart of accounts', () => {
  it('new accounts get the next code for their type; the code must match the type', async () => {
    expect(await as(f.staff, (db) => U.nextCode(db, f.a.id, 'expense'))).toBe('5110');
    const id = await as(f.staff, (db) => U.saveAccount(db, f.a.id, { name: 'Marketing', nameAr: 'التسويق', type: 'expense' }));
    expect((await owner.query('SELECT code FROM accounts WHERE id = $1', [id])).rows[0].code).toBe('5110');
    await expect(as(f.staff, (db) => U.saveAccount(db, f.a.id, { code: '4100', name: 'X', type: 'expense' }))).rejects.toThrow(/4 digits starting/);
    await expect(as(f.staff, (db) => U.saveAccount(db, f.a.id, { code: '5110', name: 'X', type: 'expense' }))).rejects.toThrow(/already has this code/);
    await expect(owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '9', 'X', 'asset')`, [f.a.id])).rejects.toThrow(/4 digits starting/);
  });

  it('an account with postings keeps its code and type; its name can change', async () => {
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-02', lines: [{ accountId: f.a.cash, debit: '10.00' }, { accountId: f.a.sales, credit: '10.00' }] }));
    await expect(as(f.staff, (db) => U.saveAccount(db, f.a.id, { code: '4010', name: 'Sales', type: 'income' }, f.a.sales))).rejects.toThrow(/has postings/);
    await as(f.staff, (db) => U.saveAccount(db, f.a.id, { code: '4000', name: 'Sales of goods', nameAr: 'مبيعات البضائع', type: 'income' }, f.a.sales));
    const row = (await as(f.staff, (db) => U.chart(db, f.a.id))).find((a) => a.id === f.a.sales)!;
    expect(row).toMatchObject({ name: 'Sales of goods', balance: '-10.00', postings: 1 });
  });

  it('view-only users cannot add accounts; other companies see none', async () => {
    await expect(as(f.a.clientViewer, (db) => U.saveAccount(db, f.a.id, { name: 'X', type: 'expense' }))).rejects.toThrow();
    expect(await as(f.b.clientAccountant, (db) => U.chart(db, f.a.id))).toEqual([]);
  });
});

describe('Cost centres', () => {
  it('branches and departments, with a parent; projects are kept apart', async () => {
    const dept = await as(f.staff, (db) => U.saveCostCentre(db, f.a.id, { name: 'Sales department', kind: 'department', parentId: f.a.headOffice }));
    const list = await as(f.staff, (db) => U.costCentres(db, f.a.id));
    expect(list.find((c) => c.id === dept)).toMatchObject({ kind: 'department', parentName: 'Head office' });
    await expect(as(f.staff, (db) => U.saveCostCentre(db, f.a.id, { name: 'head office' }))).rejects.toThrow(/already has this name/);
    const project = (await owner.query(`INSERT INTO cost_centres (company_id, kind, name) VALUES ($1, 'project', 'Tower') RETURNING id`, [f.a.id])).rows[0].id;
    await expect(as(f.staff, (db) => U.saveCostCentre(db, f.a.id, { name: 'Renamed' }, project))).rejects.toThrow(/Not found/);
    await expect(as(f.staff, (db) => U.saveCostCentre(db, f.a.id, { name: 'X', parentId: project }))).rejects.toThrow(/parent/);
  });
});

describe('Attachments', () => {
  it('a PDF or picture is attached to a bill; the file must really be one', async () => {
    const id = await as(f.staff, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'supplier-invoice.pdf', contentType: 'application/pdf', data: PDF }));
    await as(f.staff, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'receipt.png', data: PNG }));
    await expect(as(f.staff, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'virus.exe', data: PDF }))).rejects.toThrow(/PDF or a picture/);
    await expect(as(f.staff, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'fake.pdf', data: PNG }))).rejects.toThrow(/not a real PDF/);
    const got = await as(f.staff, (db) => U.getAttachment(db, id));
    expect(got.contentType).toBe('application/pdf');
    expect(Buffer.from(got.data).toString('base64')).toBe(PDF);
    expect((await as(f.staff, (db) => U.listAttachments(db, { documentId: bill }))).map((a) => a.fileName)).toEqual(['supplier-invoice.pdf', 'receipt.png']);
  });

  it('once the bill is issued its attachments stay; more can be added', async () => {
    await as(f.staff, (db) => S.issueDocument(db, bill));
    const [first] = await as(f.staff, (db) => U.listAttachments(db, { documentId: bill }));
    await expect(as(f.staff, (db) => U.removeAttachment(db, first!.id))).rejects.toThrow(/kept/);
    await as(f.staff, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'delivery-note.pdf', data: PDF }));
    expect((await as(f.staff, (db) => U.listAttachments(db, { documentId: bill }))).length).toBe(3);
  });

  it('other companies cannot read them; the audit log records the attachment but not the file', async () => {
    const [first] = await as(f.staff, (db) => U.listAttachments(db, { documentId: bill }));
    await expect(as(f.b.clientAccountant, (db) => U.getAttachment(db, first!.id))).rejects.toThrow(/Not found/);
    await expect(as(f.a.clientViewer, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'x.pdf', data: PDF }))).rejects.toThrow();
    const log = (await owner.query(`SELECT detail::text FROM audit_log WHERE table_name = 'attachments' AND row_id = $1`, [first!.id])).rows;
    expect(log.length).toBe(1);
    expect(log[0].detail).toContain('supplier-invoice.pdf');
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'attachment_files'`)).rows[0].n).toBe(0);
  });
});

describe('Names of the people involved', () => {
  it('firm staff see attachments client users uploaded, with their names; other companies get no name', async () => {
    await as(f.a.clientAccountant, (db) => U.addAttachment(db, { documentId: bill }, { fileName: 'from-client.pdf', data: PDF }));
    const seen = await as(f.partner, (db) => U.listAttachments(db, { documentId: bill }));
    expect(seen.find((a) => a.fileName === 'from-client.pdf')?.uploadedBy).toBe('Client Accountant SA');
    const name = await as(f.b.clientAccountant, async (db) => (await db.query('SELECT person_name($1) AS n', [f.a.clientAccountant])).rows[0].n);
    expect(name).toBeNull();
  });
});

describe('ZATCA QR code (phase 1)', () => {
  it('holds seller, VAT number, time, total and VAT as TLV in base64, Arabic included', () => {
    const qr = zatcaQrPayload({ sellerName: 'النور للتجارة', vatNumber: '300123456700003', timestamp: zatcaTimestamp('2026-03-05T09:30:12.345Z', '2026-03-05'), total: '1150.00', vatTotal: '150.00' });
    expect(readZatcaQr(qr)).toEqual({ 1: 'النور للتجارة', 2: '300123456700003', 3: '2026-03-05T09:30:12Z', 4: '1150.00', 5: '150.00' });
    expect(zatcaTimestamp(null, '2026-03-05')).toBe('2026-03-05T00:00:00Z');
  });
});

describe('Excel export', () => {
  it('writes a workbook Excel can open: titles, header, text and numbers', async () => {
    const book = writeXlsx({ title: ['Al Noor Trading', 'Trial balance · 31 March 2026'], header: ['Code', 'Account', 'Debit', 'Credit'],
      rows: [['1000', 'Cash in bank', toCell('12,500.00'), null], ['4000', 'Sales & services', null, toCell('12,500.00')], ['Total', null, toCell('12,500.00'), toCell('12,500.00')]] });
    const rows = await readXlsx(book);
    expect(rows[0]).toEqual(['Al Noor Trading']);
    expect(rows[2]).toEqual(['Code', 'Account', 'Debit', 'Credit']);
    expect(rows[3]).toEqual(['1000', 'Cash in bank', '12500.00']);
    expect(rows[4]).toEqual(['4000', 'Sales & services', '', '12500.00']);
    expect(toCell('-3,680.00')).toEqual({ n: '-3680.00' });
    expect(toCell('INV-0001')).toBe('INV-0001');
  });
});
