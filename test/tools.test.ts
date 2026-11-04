// Accountant tools (db/migrations/0032_accountant_tools.sql, src/books/toolsService.ts, toolsJobs.ts): recurring sales
// invoices, statements, payment reminders, budgets against actual, notifications and the full export.
import { describe, it, expect, beforeAll } from 'vitest';
import { app, as, owner, seed, type Fixture } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as T from '../src/books/toolsService.js';
import { runAutoReminders, runRecurringInvoices } from '../src/books/toolsJobs.js';
import { postEntry } from '../src/ledger/ledger.js';

let f: Fixture;
let customer: string, quiet: string, rent: string;
const line = () => ({ description: 'Office rent', quantity: '1', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' as const });

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', email: 'ap@gulfsteel.example' }));
  quiet = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'No Email Co' }));
});

describe('Recurring sales invoices', () => {
  it('makes the invoices that are due, moves on, and stops at the end date (drafts by default)', async () => {
    rent = await as(f.staff, (db) => T.saveRecurringInvoice(db, f.a.id, { name: 'Office rent', contactId: customer, frequency: 'monthly', nextDate: '2026-01-31', endDate: '2026-03-31', termsDays: 15, lines: [line()] }));
    const r = await as(f.staff, (db) => T.generateRecurringInvoices(db, f.a.id, { upTo: '2026-06-30' }));
    expect(r.created).toHaveLength(3);
    const docs = (await owner.query(`SELECT issue_date::text AS d, due_date::text AS due, status FROM documents WHERE recurring_invoice_id = $1 ORDER BY issue_date`, [rent])).rows;
    expect(docs).toEqual([{ d: '2026-01-31', due: '2026-02-15', status: 'draft' }, { d: '2026-02-28', due: '2026-03-15', status: 'draft' }, { d: '2026-03-31', due: '2026-04-15', status: 'draft' }]);
    expect((await as(f.staff, (db) => T.getRecurringInvoice(db, rent)))).toMatchObject({ active: false, made: 3, grossAmount: '1150.00' });
    await expect(as(f.staff, (db) => T.saveRecurringInvoice(db, f.a.id, { name: 'x', contactId: customer, frequency: 'daily', nextDate: '2026-01-01', lines: [line()] }))).rejects.toThrow(/how often/);
  });

  it('the hourly job issues and emails as the person who set it up; customers without email are still invoiced', async () => {
    const a = await as(f.staff, (db) => T.saveRecurringInvoice(db, f.a.id, { name: 'Retainer', contactId: customer, frequency: 'monthly', nextDate: '2026-04-01', mode: 'issue_and_email', lines: [line()] }));
    const b = await as(f.staff, (db) => T.saveRecurringInvoice(db, f.a.id, { name: 'Support', contactId: quiet, frequency: 'monthly', nextDate: '2026-04-01', mode: 'issue_and_email', lines: [line()] }));
    const out = await runRecurringInvoices(app, '2026-04-02', 'https://books.example');
    expect(out.filter((x) => [a, b].includes(x.id))).toEqual(expect.arrayContaining([{ id: a, created: 1, problem: null }, { id: b, created: 1, problem: null }]));
    const doc = (await owner.query(`SELECT id, status, created_by FROM documents WHERE recurring_invoice_id = $1`, [a])).rows[0];
    expect(doc).toMatchObject({ status: 'issued', created_by: f.staff });
    expect((await owner.query(`SELECT count(*)::int AS n FROM email_outbox WHERE document_id = $1`, [doc.id])).rows[0].n).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM email_outbox e JOIN documents d ON d.id = e.document_id WHERE d.recurring_invoice_id = $1`, [b])).rows[0].n).toBe(0);
    expect((await runRecurringInvoices(app, '2026-04-02')).filter((x) => [a, b].includes(x.id))).toEqual([]);   // next is May
    await expect(as(f.staff, (db) => db.query(`SELECT * FROM recurring_invoices_due('2026-04-02')`))).resolves.toMatchObject({ rows: [] });
  });
});

describe('Statements and reminders', () => {
  let inv: string;
  it('a statement shows movements with the running balance and how old open invoices are', async () => {
    inv = await as(f.staff, async (db) => { const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-05-01', dueDate: '2026-05-15', lines: [line()] }); await S.issueDocument(db, id); return id; });
    const s = await as(f.staff, (db) => T.statement(db, f.a.id, customer, '2026-01-01', '2026-06-30'));
    expect(s.ledger.closing).toBe('2300.00');   // April retainer + May invoice
    expect(s.open.find((o) => o.id === inv)).toMatchObject({ daysOverdue: 46, bucket: '31-60' });
    expect(s.aging['31-60']).toBe('2300.00');   // the April retainer (60 days) and the May invoice (46 days)
    const id = await as(f.staff, (db) => T.emailStatement(db, f.a.id, customer, { from: '2026-01-01', to: '2026-06-30' }));
    const e = (await owner.query(`SELECT kind, to_email, jsonb_array_length(attachments) AS n, body_html FROM email_outbox WHERE id = $1`, [id])).rows[0];
    expect(e).toMatchObject({ kind: 'statement', to_email: 'ap@gulfsteel.example', n: 1 });
    expect(e.body_html).toContain('<table');
  });

  it('reminders: by hand any time; automatically once per level reached, as the person who turned them on', async () => {
    await as(f.staff, (db) => T.sendReminder(db, inv, 'https://b.example'));
    await as(f.staff, (db) => T.saveReminderSettings(db, f.a.id, { auto: true, days: [7, 30] }));
    expect(await runAutoReminders(app, '2026-06-30', '')).toEqual([]);   // no PUBLIC_URL: nothing goes out
    const first = await runAutoReminders(app, '2026-06-30', 'https://b.example');
    expect(first.find((r) => r.companyId === f.a.id)?.sent).toBe(2);   // the May invoice (46 days: level 30) and April retainer (75 days: level 30)
    expect((await runAutoReminders(app, '2026-07-01', 'https://b.example')).find((r) => r.companyId === f.a.id)?.sent).toBe(0);
    expect((await owner.query(`SELECT level_days FROM reminder_log WHERE document_id = $1 ORDER BY level_days`, [inv])).rows.map((r) => r.level_days)).toEqual([0, 30]);
    const quietInvoice = (await owner.query(`SELECT id FROM documents WHERE contact_id = $1 AND status = 'issued' LIMIT 1`, [quiet])).rows[0].id;
    await expect(as(f.staff, (db) => T.sendReminder(db, quietInvoice, 'https://b'))).rejects.toThrow(/no email address/);
  });
});

describe('Budgets', () => {
  it('budget against actual per account and month; income counts credits, expenses debits; positive variance is better', async () => {
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-02-10', memo: 'Rent', lines: [{ accountId: f.a.rent, debit: '1200.00' }, { accountId: f.a.cash, credit: '1200.00' }] }));
    const id = await as(f.staff, (db) => T.saveBudget(db, f.a.id, { name: '2026 plan', startDate: '2026-01-01', lines: [
      { accountId: f.a.rent, months: ['1000', '1000', '1000'] }, { accountId: f.a.sales, months: [0, '2000', 0, 0, '5000'] }] }));
    const b = await as(f.staff, (db) => T.budgetVsActual(db, id));
    const rentRow = b.lines.find((l: { accountId: string }) => l.accountId === f.a.rent)!;
    expect(rentRow.budget.slice(0, 3)).toEqual(['1000.00', '1000.00', '1000.00']);
    expect(rentRow.actual[1]).toBe('1200.00');
    expect(rentRow.variance).toBe('1800.00');
    const sales = b.lines.find((l: { accountId: string }) => l.accountId === f.a.sales)!;
    expect(sales.totalActual).toBe('3000.00');   // Jan to Mar drafts are not posted; April and May invoices are (2 x 1,000 + VAT out)
    await expect(as(f.staff, (db) => T.saveBudget(db, f.a.id, { name: 'Bad', startDate: '2026-01-15' }))).rejects.toThrow(/first day/);
    await expect(as(f.staff, (db) => T.saveBudget(db, f.a.id, { name: 'Bad2', startDate: '2026-01-01', lines: [{ accountId: f.a.cash, months: ['1'] }] }))).rejects.toThrow(/income or expense/);
    expect(await as(f.b.clientAccountant, (db) => T.listBudgets(db, f.a.id))).toEqual([]);
  });
});

describe('Notifications and export', () => {
  it('lists what needs attention; marking seen is per person', async () => {
    const n = await as(f.partner, (db) => T.notifications(db, f.a.id));
    const overdue = n.find((x) => x.kind === 'overdue')!;
    expect(overdue.count).toBeGreaterThan(0);
    expect(overdue.read).toBe(false);
    await as(f.partner, (db) => T.markRead(db, f.a.id, [overdue.key]));
    expect((await as(f.partner, (db) => T.notifications(db, f.a.id))).find((x) => x.kind === 'overdue')!.read).toBe(true);
    expect((await as(f.staff, (db) => T.notifications(db, f.a.id))).find((x) => x.kind === 'overdue')!.read).toBe(false);
  });
  it('exports every kind of record as CSV files in a ZIP', async () => {
    const x = await as(f.staff, (db) => T.exportAll(db, f.a.id));
    expect(x.fileName).toMatch(/export-.*\.zip$/);
    const text = Buffer.from(x.bytes).toString('latin1');
    for (const name of ['accounts.csv', 'journal.csv', 'documents.csv', 'contacts.csv', 'README.txt']) expect(text).toContain(name);
    expect(text).toContain('Gulf Steel');
    expect(text.slice(0, 4)).toBe('PK\x03\x04');
  });
});
