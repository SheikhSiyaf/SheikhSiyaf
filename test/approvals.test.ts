// Approvals in the database: rules, requests that lock the draft, decisions by someone else with the right,
// issuing and paying only when approved, and the cash flow forecast from the books.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, sale, type Fixture, type Company } from './helpers.js';
import * as S from '../src/books/documentsService.js';
import * as A from '../src/books/approvalsService.js';
import * as F from '../src/books/forecastService.js';
import { postEntry } from '../src/ledger/ledger.js';

let f: Fixture;
let supplier: string, customer: string, financeManager: string;
async function acct(co: Company, code: string, name: string, type: string) {
  const r = await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [co.id, code]);
  return r.rows[0]?.id ?? (await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4) RETURNING id', [co.id, code, name, type])).rows[0].id;
}
const bill = (amount: string, who = f.a.clientAccountant, due = '2026-11-20') => as(who, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-11-01', dueDate: due,
  lines: [{ description: 'Steel', quantity: '1', unitPrice: amount, accountId: f.a.rent, vatCode: 'standard' }] }));
const status = async (id: string) => (await owner.query('SELECT status FROM approval_requests WHERE id = $1', [id])).rows[0].status;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [c, n, t] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']] as const) await acct(f.a, c, n, t);
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
  // A client user whose role may approve (a finance manager).
  const firm = (await owner.query('SELECT firm_id FROM companies WHERE id = $1', [f.a.id])).rows[0].firm_id;
  const role = (await owner.query(`INSERT INTO client_roles (firm_id, name, permissions, can_approve) VALUES ($1, 'Finance manager', $2, true) RETURNING id`,
    [firm, JSON.stringify({ Purchases: 'view', Reports: 'view' })])).rows[0].id;
  financeManager = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash) VALUES ($1, 'client', 'Finance Manager', $2, 'x') RETURNING id`,
    [firm, `fm.${Date.now()}@example.com`])).rows[0].id;
  await owner.query(`INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, 'client_viewer', $3)`, [financeManager, f.a.id, role]);
  await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-10-01', '100000.00', 'Opening cash')));
});

describe('Rules', () => {
  it('approvers set the rules; others cannot; nothing needs approval until a rule is on', async () => {
    expect((await as(f.staff, (db) => A.rules(db, f.a.id))).rules.every((r) => !r.active)).toBe(true);
    const small = await bill('100.00');
    await as(f.a.clientAccountant, (db) => S.issueDocument(db, small));   // no rule: issued straight away
    await expect(as(f.a.clientViewer, (db) => A.saveRule(db, f.a.id, { kind: 'bill', threshold: '5000' }))).rejects.toThrow();   // Client management: no approve right
    await expect(as(f.staff, (db) => A.saveRule(db, f.a.id, { kind: 'bill', threshold: '5000' }))).rejects.toThrow();            // staff accountant prepares, does not approve
    await as(f.reviewer, (db) => A.saveRule(db, f.a.id, { kind: 'bill', threshold: '5000.00' }));
    await as(financeManager, (db) => A.saveRule(db, f.a.id, { kind: 'payment', threshold: '10000.00' }));
    expect(await as(f.staff, (db) => A.needed(db, f.a.id, 'bill', '5000.00'))).toBe(true);
    expect(await as(f.staff, (db) => A.needed(db, f.a.id, 'bill', '4999.99'))).toBe(false);
  });
});

describe('Bills', () => {
  let big: string, req: string;
  it('a bill at or above the amount cannot be issued without approval', async () => {
    big = await bill('6000.00');
    await expect(as(f.a.clientAccountant, (db) => S.issueDocument(db, big))).rejects.toThrow(/needs approval/);
    const below = await bill('1000.00');
    await as(f.a.clientAccountant, (db) => S.issueDocument(db, below));   // below: fine
  });
  it('sent for approval, the draft is locked; the sender cannot approve it; a view-only user without the right cannot', async () => {
    req = await as(f.a.clientAccountant, (db) => A.requestDocument(db, big, 'Quarterly steel order'));
    expect((await owner.query('SELECT amount::text FROM approval_requests WHERE id = $1', [req])).rows[0].amount).toBe('6900.00');
    await expect(as(f.a.clientAccountant, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-11-01',
      lines: [{ description: 'Steel', quantity: '2', unitPrice: '6000.00', accountId: f.a.rent, vatCode: 'standard' }] }, big))).rejects.toThrow(/waiting for approval/);
    await expect(as(f.a.clientAccountant, (db) => S.issueDocument(db, big))).rejects.toThrow(/waiting for approval|needs approval/);
    await expect(as(f.a.clientAccountant, (db) => A.decide(db, req, 'approved'))).rejects.toThrow(/someone else/);
    await expect(as(f.a.clientViewer, (db) => A.decide(db, req, 'approved'))).rejects.toThrow(/role/);
    await expect(as(f.staff, (db) => A.decide(db, req, 'approved'))).rejects.toThrow(/role/);
    await expect(as(f.a.clientAccountant, (db) => A.requestDocument(db, big))).rejects.toThrow(/already waiting/);
  });
  it('rejected with a reason it goes back to the sender, who corrects it and sends again', async () => {
    await expect(as(financeManager, (db) => A.decide(db, req, 'rejected'))).rejects.toThrow(/reason/);
    await as(financeManager, (db) => A.decide(db, req, 'rejected', 'Price is above the agreed contract'));
    expect(await status(req)).toBe('rejected');
    await as(f.a.clientAccountant, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-11-01', dueDate: '2026-11-25',
      lines: [{ description: 'Steel', quantity: '1', unitPrice: '5500.00', accountId: f.a.rent, vatCode: 'standard' }] }, big));
    req = await as(f.a.clientAccountant, (db) => A.requestDocument(db, big));
  });
  it('approved by a client approver; the sender issues it; the request is done', async () => {
    await as(financeManager, (db) => A.decide(db, req, 'approved'));
    await expect(as(f.a.clientAccountant, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-11-01',
      lines: [{ description: 'Changed after approval', quantity: '1', unitPrice: '9000.00', accountId: f.a.rent, vatCode: 'standard' }] }, big))).rejects.toThrow(/waiting for approval/);
    await as(f.a.clientAccountant, (db) => S.issueDocument(db, big));
    expect(await status(req)).toBe('done');
    const row = await as(f.a.clientViewer, (db) => A.forDocument(db, big));
    expect(row).toMatchObject({ status: 'done', decidedBy: 'Finance Manager', requestedBy: 'Client Accountant SA', amount: '6325.00' });
  });
  it('withdrawn, the draft can be changed and deleted again', async () => {
    const b = await bill('7000.00');
    const r = await as(f.a.clientAccountant, (db) => A.requestDocument(db, b));
    await as(f.a.clientAccountant, (db) => A.withdraw(db, r));
    await as(f.a.clientAccountant, (db) => db.query('DELETE FROM documents WHERE id = $1', [b]));
    expect((await owner.query('SELECT count(*)::int AS n FROM documents WHERE id = $1', [b])).rows[0].n).toBe(0);
  });
});

describe('Supplier payments', () => {
  it('a payment at or above the amount is refused without approval; once approved it is recorded exactly as approved', async () => {
    const pay = { direction: 'made' as const, contactId: supplier, date: '2026-11-05', amount: '12000.00', accountId: f.a.cash, method: 'bank_transfer' };
    await expect(as(f.a.clientAccountant, (db) => S.recordPayment(db, f.a.id, pay))).rejects.toThrow(/needs approval/);
    const r = await as(f.a.clientAccountant, (db) => A.requestPayment(db, f.a.id, { ...pay, note: 'Advance for the next order' }));
    await expect(as(f.a.clientAccountant, (db) => A.payApproved(db, r))).rejects.toThrow(/not approved/);
    await as(f.reviewer, (db) => A.decide(db, r, 'approved'));
    // Not another amount, not another supplier.
    await expect(as(f.a.clientAccountant, (db) => S.recordPayment(db, f.a.id, { ...pay, amount: '15000.00', approvalRequestId: r }))).rejects.toThrow(/approved/);
    const paymentId = await as(f.a.clientAccountant, (db) => A.payApproved(db, r));
    expect((await owner.query('SELECT status, payment_id FROM approval_requests WHERE id = $1', [r])).rows[0]).toEqual({ status: 'done', payment_id: paymentId });
    await expect(as(f.a.clientAccountant, (db) => A.payApproved(db, r))).rejects.toThrow(/not approved/);   // once only
  });
});

describe('Separation and the record', () => {
  it('other companies see nothing; requests are never deleted; changes are audited', async () => {
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM approval_requests'))).rows).toEqual([]);
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM approval_rules'))).rows).toEqual([]);
    const any = (await owner.query('SELECT id FROM approval_requests WHERE company_id = $1 LIMIT 1', [f.a.id])).rows[0].id;
    await expect(owner.query('DELETE FROM approval_requests WHERE id = $1', [any])).rejects.toThrow(/never deleted/);
    await expect(owner.query(`UPDATE approval_requests SET amount = 1 WHERE id = $1`, [any])).rejects.toThrow(/not changed/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'approval_requests'`)).rows[0].n).toBeGreaterThan(0);
    const w = await as(financeManager, (db) => A.waiting(db, f.a.id));
    expect(w.canApprove).toBe(true);
  });
});

describe('Cash flow forecast', () => {
  it('starts from cash in the bank; customers, suppliers, waiting approvals and own items fall in their weeks', async () => {
    const inv = await as(f.staff, async (db) => {
      const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-11-01', dueDate: '2026-11-12', lines: [{ description: 'Beams', quantity: '1', unitPrice: '2000.00', accountId: f.a.sales, vatCode: 'standard' }] });
      await S.issueDocument(db, id); return id;
    });
    void inv;
    const waitingBill = await bill('8000.00', f.a.clientAccountant, '2026-11-18');
    await as(f.a.clientAccountant, (db) => A.requestDocument(db, waitingBill));
    await as(f.staff, (db) => F.saveItem(db, f.a.id, { description: 'New forklift', direction: 'out', amount: '45000.00', firstDate: '2026-11-25' }));
    await as(f.staff, (db) => F.saveItem(db, f.a.id, { description: 'Rent', direction: 'out', amount: '3000.00', firstDate: '2026-11-05', repeat: 'monthly' }));
    await as(f.staff, (db) => F.saveSettings(db, f.a.id, '60000'));
    const r = await as(f.a.clientViewer, (db) => F.forecast(db, f.a.id, '2026-11-03', { grain: 'week', count: 4 }));
    const cash = (await owner.query(`SELECT sum(l.debit - l.credit)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = $1 AND e.entry_date <= '2026-11-03'`, [f.a.cash])).rows[0].v;   // the payment dated 5 Nov is not in today's cash
    expect(r.opening).toBe(cash);
    expect(r.rows.map((x) => x.start)).toEqual(['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
    expect(r.rows[1]!.inflows.receivables).toBe('2300.00');               // due 12 Nov
    expect(r.rows[2]!.outflows.approvals).toBe('9200.00');                // the bill waiting for approval, due 18 Nov
    expect(r.rows[3]!.outflows.other_out).toBe('45000.00');               // forklift
    expect(r.rows[0]!.outflows.other_out).toBe('3000.00');                // rent on the 5th
    expect(r.rows[2]!.outflows.payables).toBe('1265.00');                 // the two small bills due 20 Nov
    expect(r.rows[3]!.outflows.payables).toBe('6325.00');                 // the approved bill due 25 Nov
    expect(r.minimumCash).toBe('60000.00');
    expect(r.rows.some((x) => x.belowMinimum)).toBe(true);
    // Customers paying two weeks late moves the invoice into week 4.
    const late = await as(f.staff, (db) => F.forecast(db, f.a.id, '2026-11-03', { grain: 'week', count: 4, delayDays: 14 }));
    expect(late.rows[3]!.inflows.receivables).toBe('2300.00');
    expect(late.rows[1]!.inflows.receivables).toBe('0.00');
  });
  it('view-only people read the forecast but do not add items; other companies see nothing', async () => {
    await expect(as(f.a.clientViewer, (db) => F.saveItem(db, f.a.id, { description: 'x', direction: 'in', amount: '1', firstDate: '2026-11-10' }))).rejects.toThrow();
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM forecast_items'))).rows).toEqual([]);
  });
});
