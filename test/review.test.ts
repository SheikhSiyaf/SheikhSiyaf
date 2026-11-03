// Review layer: automated checks, explained findings, queries between firm and client, checklist and sign-off.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as R from '../src/books/reviewService.js';
import * as S from '../src/books/documentsService.js';
import { postEntry } from '../src/ledger/ledger.js';

let f: Fixture;
const PE = '2026-03-31';
let query: string;
const find = (checks: R.Check[], key: string) => checks.find((c) => c.key === key)!;

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  const supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale', vatNumber: '300000000000003', country: 'SA' }));
  const noVat = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Small Shop' }));
  const bill = (contactId: string, date: string, vatCode: 'standard' | 'zero', reference: string) => as(f.staff, async (db) => {
    const id = await S.saveDraft(db, f.a.id, { type: 'bill', contactId, issueDate: date, reference, lines: [{ description: 'Stock', quantity: '1', unitPrice: '500.00', accountId: f.a.rent, vatCode }] });
    await S.issueDocument(db, id); return id;
  });
  await bill(supplier, '2026-03-05', 'zero', 'NW-1');          // supplier has a VAT number, no VAT claimed
  await bill(noVat, '2026-03-06', 'standard', 'SS-1');         // VAT claimed, supplier has no VAT number
  await bill(noVat, '2026-03-09', 'standard', 'SS-2');         // same supplier and total within 7 days: duplicate?
  await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-20', memo: 'Accrued bonus estimate', lines: [{ accountId: f.a.rent, debit: '5000.00' }, { accountId: f.a.cash, credit: '5000.00' }] }));
  await as(f.staff, (db) => S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-25', lines: [{ description: 'Left as draft', quantity: '1', unitPrice: '10.00', accountId: f.a.rent, vatCode: 'standard' }] }));
});

describe('Automated checks', () => {
  it('finds missing VAT, VAT without a supplier number, duplicates, round amounts, abnormal balances and drafts', async () => {
    const c = await as(f.reviewer, (db) => R.runChecks(db, f.a.id, PE));
    expect(find(c, 'missing_input_vat').findings.map((x) => x.label)).toEqual([expect.stringContaining('Najd Wholesale')]);
    expect(find(c, 'vat_without_number').findings.length).toBe(2);
    expect(find(c, 'duplicates').findings.length).toBe(1);
    expect(find(c, 'round_amounts').findings[0]).toMatchObject({ label: 'Accrued bonus estimate', amount: '5000.00' });
    expect(find(c, 'abnormal_balances').findings.map((x) => x.label)).toContain('1000 Cash in bank');   // the bank is overdrawn
    expect(find(c, 'drafts_left').findings.length).toBe(1);
    expect(find(c, 'unreconciled').findings).toEqual([]);
    // Another month has none of these.
    expect((await as(f.reviewer, (db) => R.runChecks(db, f.a.id, '2026-01-31'))).filter((x) => x.key !== 'abnormal_balances').every((x) => x.findings.length === 0)).toBe(true);
  });

  it('a finding can be explained by the firm; it stays listed but is no longer open', async () => {
    const item = find(await as(f.reviewer, (db) => R.runChecks(db, f.a.id, PE)), 'round_amounts').findings[0]!.itemKey;
    await as(f.reviewer, (db) => R.explain(db, f.a.id, { check: 'round_amounts', item, note: 'Agreed with the client: bonus estimate, payslips to follow' }));
    const r = find(await as(f.reviewer, (db) => R.runChecks(db, f.a.id, PE)), 'round_amounts');
    expect(r).toMatchObject({ open: 0 });
    expect(r.findings[0]!.explained).toMatchObject({ note: expect.stringContaining('bonus estimate'), by: 'Reviewer' });
    await expect(as(f.a.clientAccountant, (db) => R.explain(db, f.a.id, { check: 'round_amounts', item, note: 'x' }))).rejects.toThrow();
  });
});

describe('Queries', () => {
  it('the firm asks, the client answers, only the firm closes', async () => {
    await expect(as(f.a.clientAccountant, (db) => R.raiseQuery(db, f.a.id, { periodEnd: PE, subject: 'X', body: 'Y' }))).rejects.toThrow();
    query = await as(f.reviewer, (db) => R.raiseQuery(db, f.a.id, { periodEnd: PE, subject: 'Najd bill without VAT', body: 'Please send the tax invoice for NW-1.', aboutType: 'check', aboutId: 'missing_input_vat' }));
    await as(f.a.clientAccountant, (db) => R.reply(db, query, 'Attached to the bill now; it is zero-rated export.'));
    expect((await as(f.staff, (db) => R.getQuery(db, query))).status).toBe('answered');
    await as(f.a.clientViewer, (db) => R.reply(db, query, 'Confirmed by management.'));   // view-only people can still answer
    await expect(as(f.a.clientAccountant, (db) => R.setQueryStatus(db, query, 'closed'))).rejects.toThrow(/firm/);
    await as(f.reviewer, (db) => R.reply(db, query, 'Thanks. Which customer was it exported to?'));
    const q = await as(f.a.clientAccountant, (db) => R.getQuery(db, query));
    expect(q.status).toBe('open');
    expect(q.messages.map((m: { fromFirm: boolean }) => m.fromFirm)).toEqual([true, false, false, true]);
    expect(await as(f.b.clientAccountant, (db) => R.listQueries(db, f.a.id))).toEqual([]);
    await expect(owner.query('UPDATE review_messages SET body = $2 WHERE query_id = $1', [query, 'changed'])).rejects.toThrow(/never changed/);
  });
});

describe('Checklist and sign-off', () => {
  it('cannot sign off with open queries, an unfinished checklist, before the month ends, or as staff', async () => {
    await expect(as(f.reviewer, (db) => R.signOff(db, f.a.id, PE))).rejects.toThrow(/checklist/);
    const cl = await as(f.staff, (db) => R.checklist(db, f.a.id, PE));
    expect(cl.items.find((i) => i.item === 'drafts_cleared')).toMatchObject({ auto: false, done: false });
    expect(cl.items.find((i) => i.item === 'bank_reconciled')).toMatchObject({ auto: true, done: true });
    for (const i of cl.items.filter((x) => !x.done && x.item !== 'queries_closed')) await as(f.staff, (db) => R.tick(db, f.a.id, PE, i.item, true, i.item === 'drafts_cleared' ? 'Draft is a duplicate, will be deleted' : null));
    await expect(as(f.a.clientAccountant, (db) => R.tick(db, f.a.id, PE, 'vat_reviewed', true))).rejects.toThrow();
    await expect(as(f.reviewer, (db) => R.signOff(db, f.a.id, PE))).rejects.toThrow(/checklist/);   // queries_closed is still open
    await as(f.reviewer, (db) => R.setQueryStatus(db, query, 'closed'));
    await expect(as(f.staff, (db) => R.signOff(db, f.a.id, PE))).rejects.toThrow(/partner or reviewer/);
    const thisMonth = new Date(); const pe = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await expect(owner.query(`INSERT INTO review_signoffs (company_id, period_end, signed_by) VALUES ($1, $2, $3)`, [f.a.id, pe, f.reviewer])).rejects.toThrow(/after it has ended/);
  });

  it('signing off shows "reviewed by your accountant", fixes the checklist, flags later changes, and can be withdrawn', async () => {
    const id = await as(f.reviewer, (db) => R.signOff(db, f.a.id, PE, 'March reviewed'));
    expect(await as(f.a.clientAccountant, (db) => R.reviewedUpTo(db, f.a.id))).toMatchObject({ periodEnd: PE, signedBy: 'Reviewer' });
    await expect(as(f.staff, (db) => R.tick(db, f.a.id, PE, 'vat_reviewed', false))).rejects.toThrow(/signed off/);
    await expect(as(f.reviewer, (db) => R.signOff(db, f.a.id, PE))).rejects.toThrow();
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-30', memo: 'Late adjustment', lines: [{ accountId: f.a.rent, debit: '10.00' }, { accountId: f.a.cash, credit: '10.00' }] }));
    const [m] = await as(f.reviewer, (db) => R.months(db, f.a.id, PE));
    expect(m).toMatchObject({ periodEnd: PE, signoff: { signedBy: 'Reviewer', changedAfter: 1 }, openQueries: 0, queries: 1 });
    await expect(as(f.staff, (db) => R.withdraw(db, id, 'x'))).rejects.toThrow();
    await expect(as(f.reviewer, (db) => R.withdraw(db, id, ''))).rejects.toThrow(/why/);
    await as(f.reviewer, (db) => R.withdraw(db, id, 'Late adjustment posted; review again'));
    expect(await as(f.a.clientAccountant, (db) => R.reviewedUpTo(db, f.a.id))).toBeNull();
    const [after] = await as(f.reviewer, (db) => R.months(db, f.a.id, PE));
    expect(after).toMatchObject({ signoff: null, lastWithdrawn: { reason: 'Late adjustment posted; review again', by: 'Reviewer' } });
    await expect(owner.query('DELETE FROM review_signoffs WHERE id = $1', [id])).rejects.toThrow(/never deleted/);
  });
});
