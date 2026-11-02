// Employees, expense claims with approval, reimbursements, ledgers and projects.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as L from '../src/books/ledgerService.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
let bank: string, emp: string, customer: string, claimsPayable: string, project: string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  bank = f.a.cash;
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['2200', 'Employee claims payable', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  claimsPayable = (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '2200'`, [f.a.id])).rows[0].id;
  emp = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Yusuf Karim', employeeNo: 'E-001', jobTitle: 'Driver' }));
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
  project = await as(f.staff, (db) => L.saveProject(db, f.a.id, { name: 'Warehouse fit-out', contactId: customer, budget: '1000.00', startDate: '2026-03-01' }));
});

const line = (over: Record<string, unknown> = {}) =>
  ({ description: 'Fuel', quantity: '1', unitPrice: '100.00', accountId: f.a.rent, vatCode: 'standard' as const, ...over });
const draftClaim = (user = f.a.clientAccountant, over: Partial<S.DocumentInput> = {}) =>
  as(user, (db) => S.saveDraft(db, f.a.id, { type: 'claim', contactId: emp, issueDate: '2026-03-10', reference: 'Receipt 77', lines: [line()], ...over }));
const status = async (id: string) => (await owner.query('SELECT status, number, journal_entry_id FROM documents WHERE id = $1', [id])).rows[0];

describe('Employees', () => {
  it('are their own kind of contact, never also a customer or supplier, with unique employee numbers', async () => {
    await expect(as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, isSupplier: true, name: 'X' }))).rejects.toThrow(/cannot also be/);
    await expect(as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Other', employeeNo: 'E-001' }))).rejects.toThrow(/contacts_employee_no/);
    expect((await as(f.staff, (db) => S.listContacts(db, f.a.id, 'employee'))).map((c) => c.name)).toEqual(['Yusuf Karim']);
  });

  it('cannot be used on invoices or bills, and only employees can have claims', async () => {
    await expect(as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'invoice', contactId: emp, issueDate: '2026-03-10', lines: [line({ accountId: f.a.sales })] }))).rejects.toThrow(/Choose a customer/);
    await expect(draftClaim(f.staff, { contactId: customer })).rejects.toThrow(/Choose an employee/);
  });
});

describe('Claims and approvals', () => {
  it('submit gives a number and posts nothing; the submitter cannot approve; another person approves and it posts to claims payable', async () => {
    const id = await draftClaim();
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, id));
    expect(await status(id)).toMatchObject({ status: 'submitted', number: 'CLM-0001', journal_entry_id: null });
    await expect(owner.query(`UPDATE documents SET notes = 'x' WHERE id = $1`, [id])).rejects.toThrow(/cannot be changed/);
    await expect(owner.query(`UPDATE document_lines SET description = 'x' WHERE document_id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(as(f.a.clientAccountant, (db) => S.approveClaim(db, id))).rejects.toThrow(/someone else must approve/);
    await as(f.staff, (db) => S.approveClaim(db, id));
    const d = await status(id);
    expect(d.status).toBe('issued');
    const lines = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code`, [d.journal_entry_id])).rows;
    expect(lines.map((r) => [r.code, r.debit, r.credit])).toEqual([['1200', '15.00', '0.00'], ['2200', '0.00', '115.00'], ['5000', '100.00', '0.00']]);
    expect((await as(f.staff, (db) => S.getDocument(db, id))).state).toBe('approved');
  });

  it('rejecting needs a reason and posts nothing; the claim goes back to draft to be corrected and keeps its number', async () => {
    const id = await draftClaim();
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, id));
    const num = (await status(id)).number;
    await expect(as(f.staff, (db) => S.rejectClaim(db, id, ' '))).rejects.toThrow(/reason/);
    await as(f.staff, (db) => S.rejectClaim(db, id, 'Receipt missing'));
    expect(await status(id)).toMatchObject({ status: 'rejected', journal_entry_id: null });
    await as(f.a.clientAccountant, (db) => S.reopenClaim(db, id));
    await as(f.a.clientAccountant, (db) => S.saveDraft(db, f.a.id, { contactId: emp, issueDate: '2026-03-10', reference: 'Receipt 77 + 78', lines: [line({ unitPrice: '80.00' })] }, id));
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, id));
    expect((await status(id)).number).toBe(num);
  });

  it('view-only users and reviewers cannot submit or approve', async () => {
    const id = await draftClaim();
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, id));
    for (const u of [f.a.clientViewer, f.reviewer]) {
      await expect(as(u, (db) => S.approveClaim(db, id))).rejects.toThrow();
    }
    expect((await status(id)).status).toBe('submitted');
  });

  it('reimbursing the employee posts Dr claims payable / Cr bank, settles the claim, and shows in the employee ledger', async () => {
    const id = await draftClaim(f.a.clientAccountant, { issueDate: '2026-04-02', lines: [line({ unitPrice: '200.00', vatCode: 'zero' })] });
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, id));
    await as(f.partner, (db) => S.approveClaim(db, id));
    const open = await as(f.staff, (db) => S.openDocuments(db, f.a.id, emp, 'made'));
    expect(open.map((d) => d.id)).toContain(id);
    const pid = await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'made', contactId: emp, date: '2026-04-05', amount: '200.00', accountId: bank,
      allocations: [{ documentId: id, amount: '200.00' }] }));
    const je = (await owner.query('SELECT journal_entry_id FROM payments WHERE id = $1', [pid])).rows[0].journal_entry_id;
    const lines = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code`, [je])).rows;
    expect(lines.map((r) => [r.code, r.debit, r.credit])).toEqual([['1000', '0.00', '200.00'], ['2200', '200.00', '0.00']]);
    expect((await as(f.staff, (db) => S.getDocument(db, id))).state).toBe('reimbursed');

    const led = await as(f.staff, (db) => L.contactLedger(db, f.a.id, emp, '2026-04-01', '2026-04-30'));
    expect(led.opening).toBe('115.00');   // the March claim approved earlier is still owed
    expect(led.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([['0.00', '200.00', '315.00'], ['200.00', '0.00', '115.00']]);
    const balances = await as(f.staff, (db) => L.contactBalances(db, f.a.id, 'employee', '2026-12-31'));
    const ledgerTotal = await as(f.staff, (db) => L.accountLedger(db, f.a.id, claimsPayable, '2000-01-01', '2026-12-31'));
    expect(toMinor(balances.find((b) => b.id === emp)!.balance)).toBe(toMinor(ledgerTotal.closing));   // sub-ledger agrees with the control account
  });
});

describe('Ledgers and projects', () => {
  it('account ledger: opening + movements = closing, matching the trial balance', async () => {
    const r = await as(f.partner, (db) => L.accountLedger(db, f.a.id, claimsPayable, '2026-04-01', '2026-12-31'));
    expect(toMinor(r.opening) + toMinor(r.totalCredit) - toMinor(r.totalDebit)).toBe(toMinor(r.closing));
    const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-12-31'));
    const row = tb.find((x) => x.accountId === claimsPayable);
    expect(toMinor(row?.credit ?? '0') - toMinor(row?.debit ?? '0')).toBe(toMinor(r.closing));
  });

  it('projects show income, costs, profit and budget used from lines tagged with the project', async () => {
    await as(f.staff, async (db) => {
      const inv = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-05-01', lines: [line({ accountId: f.a.sales, unitPrice: '1500.00', costCentreId: project })] });
      await S.issueDocument(db, inv);
    });
    const c = await draftClaim(f.a.clientAccountant, { issueDate: '2026-05-02', lines: [line({ unitPrice: '400.00', costCentreId: project, vatCode: 'exempt' })] });
    await as(f.a.clientAccountant, (db) => S.submitClaim(db, c));
    await as(f.staff, (db) => S.approveClaim(db, c));
    const p = (await as(f.partner, (db) => L.listProjects(db, f.a.id))).find((x) => x.id === project)!;
    expect(p).toMatchObject({ income: '1500.00', expense: '400.00', profit: '1100.00', budgetUsed: 40, customerName: 'Gulf Steel' });
    const led = await as(f.partner, (db) => L.costCentreLedger(db, f.a.id, project, '2026-01-01', '2026-12-31'));
    expect(led).toMatchObject({ income: '1500.00', expense: '400.00', profit: '1100.00' });
  });

  it('a project customer must be a customer of the company; other companies see nothing', async () => {
    await expect(as(f.staff, (db) => L.saveProject(db, f.a.id, { name: 'X', contactId: emp }))).rejects.toThrow(/customer of this company/);
    await expect(as(f.b.clientAccountant, (db) => L.getProject(db, project))).rejects.toThrow(/Not found/);
    await expect(as(f.b.clientAccountant, (db) => L.contactLedger(db, f.a.id, emp, '2026-01-01', '2026-12-31'))).rejects.toThrow(/Not found/);
  });
});
