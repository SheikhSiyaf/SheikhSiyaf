// Client portal in the database: requests from the firm, documents from the client, monthly reports, who may do
// what, and separation between companies.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, sale, seed, type Fixture } from './helpers.js';
import * as P from '../src/books/portalService.js';
import * as U from '../src/books/setupService.js';
import { postEntry } from '../src/ledger/ledger.js';

let f: Fixture;
let request: string;
let upload: string;
const pdf = { fileName: 'statement.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 bank statement').toString('base64') };

beforeAll(async () => {
  f = await seed();
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-10', '1150.00')));
});

describe('Requests and documents', () => {
  it('the firm asks for documents; the client cannot ask', async () => {
    await expect(as(f.a.clientAccountant, (db) => P.createRequest(db, f.a.id, { title: 'March bank statement' }))).rejects.toThrow();
    request = await as(f.staff, (db) => P.createRequest(db, f.a.id, { title: 'March bank statement', category: 'bank_statement', periodEnd: '2026-03-31', dueDate: '2026-04-10' }));
    expect(await as(f.a.clientViewer, (db) => P.listRequests(db, f.a.id))).toMatchObject([{ title: 'March bank statement', status: 'open', requestedBy: 'Staff', answers: 0 }]);
  });

  it('the client answers with a file: the request is answered and the documents wait for the firm', async () => {
    upload = await as(f.a.clientAccountant, (db) => P.createUpload(db, f.a.id, { requestId: request, note: 'Attached, SNB account', periodEnd: '2026-03-31' }));
    await as(f.a.clientAccountant, (db) => U.addAttachment(db, { portalUploadId: upload }, pdf));
    expect((await as(f.staff, (db) => P.listRequests(db, f.a.id)))[0]).toMatchObject({ status: 'answered', answers: 1 });
    const [u] = await as(f.staff, (db) => P.listUploads(db, f.a.id));
    expect(u).toMatchObject({ id: upload, status: 'new', fromFirm: false, requestTitle: 'March bank statement', category: 'other', mine: false, files: [{ fileName: 'statement.pdf' }] });
    // Someone else on the client cannot add files to it, even with a posting role.
    await expect(as(f.staff, (db) => U.addAttachment(db, { portalUploadId: upload }, pdf))).rejects.toThrow(/Only the person who sent/);
  });

  it('view-only people can send documents too, and remove them until the firm deals with them', async () => {
    const id = await as(f.a.clientViewer, (db) => P.createUpload(db, f.a.id, { category: 'receipts', note: 'Fuel receipts' }));
    await as(f.a.clientViewer, (db) => U.addAttachment(db, { portalUploadId: id }, { ...pdf, fileName: 'fuel.pdf' }));
    await expect(as(f.a.clientAccountant, (db) => P.removeUpload(db, id))).rejects.toThrow(/Only the person who sent/);
    await as(f.a.clientViewer, (db) => P.removeUpload(db, id));
    expect((await owner.query('SELECT count(*)::int AS n FROM attachments WHERE portal_upload_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('only the firm marks documents dealt with; after that they are kept', async () => {
    await expect(as(f.a.clientAccountant, (db) => P.setUploadStatus(db, upload, 'processed'))).rejects.toThrow(/accountant/);
    await as(f.staff, (db) => P.setUploadStatus(db, upload, 'processed'));
    await expect(as(f.a.clientAccountant, (db) => P.removeUpload(db, upload))).rejects.toThrow(/dealt with/);
    await expect(as(f.a.clientAccountant, (db) => U.addAttachment(db, { portalUploadId: upload }, pdf))).rejects.toThrow(/dealt with/);
    await expect(owner.query(`UPDATE portal_uploads SET note = 'changed' WHERE id = $1`, [upload])).rejects.toThrow(/not changed/);
    await as(f.staff, (db) => P.setRequestStatus(db, request, 'done'));
    await expect(as(f.a.clientAccountant, (db) => P.setRequestStatus(db, request, 'open'))).rejects.toThrow();
    await expect(as(f.a.clientAccountant, (db) => P.createUpload(db, f.a.id, { requestId: request }))).rejects.toThrow(/already dealt with/);
  });

  it('what the firm shares needs no action and shows as from the firm', async () => {
    const id = await as(f.partner, (db) => P.createUpload(db, f.a.id, { category: 'tax', note: 'Your VAT return as filed' }));
    await as(f.partner, (db) => U.addAttachment(db, { portalUploadId: id }, { ...pdf, fileName: 'vat-q1.pdf' }));
    const u = (await as(f.a.clientViewer, (db) => P.listUploads(db, f.a.id))).find((x) => x.id === id)!;
    expect(u).toMatchObject({ fromFirm: true, status: 'processed', uploadedBy: 'Partner' });
    expect((await as(f.a.clientViewer, (db) => U.listAttachments(db, { portalUploadId: id }))).map((a) => a.fileName)).toEqual(['vat-q1.pdf']);
  });
});

describe('Monthly reports', () => {
  let letter: string;
  it('the firm publishes a finished month with its comments and the figures as they stood', async () => {
    await expect(as(f.a.clientAccountant, (db) => P.publishLetter(db, f.a.id, { periodEnd: '2026-03-31', commentary: 'x' }))).rejects.toThrow();
    await expect(as(f.staff, (db) => P.publishLetter(db, f.a.id, { periodEnd: '2099-03-31', commentary: 'Too early' }))).rejects.toThrow(/after the month has ended/);
    letter = await as(f.staff, (db) => P.publishLetter(db, f.a.id, { periodEnd: '2026-03-31', commentary: 'Sales were steady. Please send the missing bank statement.' }));
    const [l] = await as(f.a.clientViewer, (db) => P.listLetters(db, f.a.id));
    expect(l).toMatchObject({ id: letter, publishedBy: 'Staff', readAt: null, figures: { revenue: '1150.00', netProfit: '1150.00' } });
  });

  it('the client opening it marks it read; the firm opening it does not; it never changes', async () => {
    await as(f.staff, (db) => P.markLetterRead(db, letter));
    expect((await as(f.staff, (db) => P.listLetters(db, f.a.id)))[0].readAt).toBeNull();
    await as(f.a.clientViewer, (db) => P.markLetterRead(db, letter));
    await as(f.a.clientAccountant, (db) => P.markLetterRead(db, letter));   // already read: nothing changes
    expect((await as(f.staff, (db) => P.listLetters(db, f.a.id)))[0]).toMatchObject({ readBy: 'Client Viewer SA' });
    await expect(owner.query(`UPDATE portal_letters SET commentary = 'changed' WHERE id = $1`, [letter])).rejects.toThrow(/not changed/);
    await expect(owner.query(`DELETE FROM portal_letters WHERE id = $1`, [letter])).rejects.toThrow();
  });
});

describe('Separation and audit', () => {
  it("another company's people see nothing and cannot send into this company", async () => {
    for (const t of ['portal_requests', 'portal_uploads', 'portal_letters']) {
      expect((await as(f.b.clientAccountant, (db) => db.query(`SELECT * FROM ${t}`))).rows).toEqual([]);
    }
    await expect(as(f.b.clientAccountant, (db) => P.createUpload(db, f.a.id, { note: 'x' }))).rejects.toThrow();
    // The staff member is not on company B: they cannot ask B for anything.
    await expect(as(f.staff, (db) => P.createRequest(db, f.b.id, { title: 'x' }))).rejects.toThrow();
  });

  it("the firm's list across clients counts what is waiting", async () => {
    await as(f.partner, (db) => P.createRequest(db, f.b.id, { title: 'Payroll sheet' }));
    const rows = (await as(f.partner, (db) => db.query('SELECT * FROM portal_my_clients()'))).rows;
    expect(rows.find((r) => r.company_id === f.b.id)).toMatchObject({ open_requests: 1, new_uploads: 0 });
    const audited = (await owner.query(`SELECT DISTINCT table_name FROM audit_log WHERE table_name LIKE 'portal_%'`)).rows.map((r) => r.table_name).sort();
    expect(audited).toEqual(['portal_letters', 'portal_requests', 'portal_uploads']);
  });
});
