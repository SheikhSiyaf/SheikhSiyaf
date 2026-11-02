// Bank accounts, statement import, matching, booking lines, reconciliation and rules.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/bankService.js';
import * as S from '../src/books/documentsService.js';
import { postEntry } from '../src/ledger/ledger.js';

let f: Fixture;
let bank: string;   // bank_accounts.id of 1000
let inputVat: string, customer: string, supplier: string, fuel: string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'],
    ['3000', 'Owner', 'equity'], ['5400', 'Fuel', 'expense']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  const acct = async (code: string) => (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = $2`, [f.a.id, code])).rows[0].id;
  inputVat = await acct('1200'); fuel = await acct('5400');
  bank = (await owner.query(`SELECT id FROM bank_accounts WHERE account_id = $1`, [f.a.cash])).rows[0].id;
  customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel' }));
  supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Najd Wholesale' }));
});

const line = (date: string, description: string, amount: string, balance: string | null = null) => ({ date, description, reference: null, amount, balance });
const lines = (id: string) => as(f.staff, (db) => B.statementLines(db, id));

describe('Bank accounts', () => {
  it('every bank or cash ledger account has a bank account record', async () => {
    const list = await as(f.staff, (db) => B.listBankAccounts(db, f.a.id));
    expect(list.map((b) => b.code)).toEqual(['1000']);
  });

  it('adding a bank account creates its ledger account; the IBAN is checked and names the bank', async () => {
    await expect(as(f.a.clientAccountant, (db) => B.saveBankAccount(db, f.a.id, { iban: 'SA04 8000 0000 6080 1016 7519' }))).rejects.toThrow(/IBAN is not right/);
    const id = await as(f.a.clientAccountant, (db) => B.saveBankAccount(db, f.a.id, { iban: 'SA03 8000 0000 6080 1016 7519' }));
    const b = await as(f.a.clientAccountant, (db) => B.getBankAccount(db, id));
    expect(b).toMatchObject({ code: '1020', name: 'Al Rajhi Bank 7519', bankName: 'Al Rajhi Bank', iban: 'SA0380000000608010167519', kind: 'bank' });
    await expect(as(f.a.clientAccountant, (db) => B.saveBankAccount(db, f.a.id, { iban: 'SA0380000000608010167519' }))).rejects.toThrow(/bank_accounts_iban/);
    await expect(owner.query(`UPDATE bank_accounts SET iban = 'SA0000' WHERE id = $1`, [id])).rejects.toThrow(/iban_check/);
  });

  it('view-only users and other companies cannot add or see bank accounts', async () => {
    await expect(as(f.a.clientViewer, (db) => B.saveBankAccount(db, f.a.id, { bankName: 'X' }))).rejects.toThrow();
    expect(await as(f.b.clientAccountant, (db) => B.listBankAccounts(db, f.a.id))).toEqual([]);
  });
});

describe('Statement import', () => {
  it('imports lines once: an overlapping statement skips what is already there', async () => {
    const first = await as(f.staff, (db) => B.importStatement(db, bank, { fileName: 'march.csv', lines: [
      line('2026-03-02', 'POS PETROMIN FUEL', '-115.00', '9885.00'), line('2026-03-03', 'TRF FROM GULF STEEL', '2300.00', '12185.00')] }));
    expect(first).toMatchObject({ imported: 2, skipped: 0 });
    const again = await as(f.staff, (db) => B.importStatement(db, bank, { fileName: 'march-2.csv', lines: [
      line('2026-03-03', 'TRF FROM GULF STEEL', '2300.00', '12185.00'), line('2026-03-04', 'BANK CHARGES', '-25.00', '12160.00')] }));
    expect(again).toMatchObject({ imported: 1, skipped: 1 });
    expect((await lines(bank)).length).toBe(3);
  });

  it('the bank\'s record never changes; only its match does', async () => {
    const id = (await lines(bank))[0]!.id;
    await expect(owner.query(`UPDATE bank_statement_lines SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/never changed/);
  });

  it('refuses bad lines and closed or foreign accounts', async () => {
    await expect(as(f.staff, (db) => B.importStatement(db, bank, { lines: [line('03/03/2026', 'X', '1.00')] }))).rejects.toThrow(/date/);
    await expect(as(f.staff, (db) => B.importStatement(db, bank, { lines: [line('2026-03-03', 'X', '1.234')] }))).rejects.toThrow(/amount/);
    await expect(as(f.b.clientAccountant, (db) => B.importStatement(db, bank, { lines: [line('2026-03-03', 'X', '1.00')] }))).rejects.toThrow(/Not found/);
  });
});

describe('Matching and booking statement lines', () => {
  it('suggests the entry already in the books and matches it; amounts must agree', async () => {
    // A customer payment already recorded in the books.
    const inv = await as(f.staff, async (db) => {
      const d = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-02-20', dueDate: '2026-03-20',
        lines: [{ description: 'Steel', quantity: '1', unitPrice: '2000.00', accountId: f.a.sales, vatCode: 'standard' }] });
      await S.issueDocument(db, d); return d;
    });
    await as(f.staff, (db) => S.recordPayment(db, f.a.id, { direction: 'received', contactId: customer, date: '2026-03-01', amount: '2300.00',
      accountId: f.a.cash, allocations: [{ documentId: inv, amount: '2300.00' }] }));
    const l = (await lines(bank)).find((x) => x.description === 'TRF FROM GULF STEEL')!;
    expect(l.suggestion).toMatchObject({ kind: 'match', date: '2026-03-01' });
    const fee = (await lines(bank)).find((x) => x.description === 'BANK CHARGES')!;
    await expect(as(f.staff, (db) => B.matchLine(db, fee.id, (l.suggestion as { journalLineId: string }).journalLineId))).rejects.toThrow(/not the amount on the statement/);
    await as(f.staff, (db) => B.matchLine(db, l.id, (l.suggestion as { journalLineId: string }).journalLineId));
    expect((await lines(bank)).find((x) => x.id === l.id)!.status).toBe('matched');
  });

  it('money out booked to an expense account becomes an expense with its VAT; "always do this" saves a rule', async () => {
    const l = (await lines(bank)).find((x) => x.description === 'POS PETROMIN FUEL')!;
    await as(f.a.clientAccountant, (db) => B.bookLine(db, l.id, { accountId: fuel, vatCode: 'standard', remember: 'PETROMIN' }));
    const doc = (await owner.query(`SELECT d.type, d.status, d.net_total::text, d.vat_total::text, d.payee FROM documents d
      JOIN journal_lines jl ON jl.entry_id = d.journal_entry_id JOIN bank_statement_lines s ON s.journal_line_id = jl.id WHERE s.id = $1`, [l.id])).rows[0];
    expect(doc).toMatchObject({ type: 'expense', status: 'issued', net_total: '100.00', vat_total: '15.00', payee: 'POS PETROMIN FUEL' });
    expect(await owner.query(`SELECT 1 FROM journal_lines WHERE account_id = $1 AND debit = 15`, [inputVat]).then((r) => r.rowCount)).toBe(1);
    // The next fuel line is suggested by the rule.
    await as(f.staff, (db) => B.importStatement(db, bank, { lines: [line('2026-03-10', 'POS PETROMIN FUEL JEDDAH', '-57.50')] }));
    const next = (await lines(bank)).find((x) => x.description === 'POS PETROMIN FUEL JEDDAH')!;
    expect(next.suggestion).toMatchObject({ kind: 'rule', accountId: fuel, vatCode: 'standard' });
    expect(await as(f.staff, (db) => B.applyRules(db, bank))).toBe(1);
  });

  it('money from a customer or to a supplier records the payment and settles their oldest documents', async () => {
    const bill = await as(f.staff, async (db) => {
      const d = await S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-01', dueDate: '2026-03-15',
        lines: [{ description: 'Stock', quantity: '1', unitPrice: '1000.00', accountId: f.a.rent, vatCode: 'standard' }] });
      await S.issueDocument(db, d); return d;
    });
    await as(f.staff, (db) => B.importStatement(db, bank, { lines: [line('2026-03-12', 'TRF TO NAJD WHOLESALE', '-1150.00')] }));
    const l = (await lines(bank)).find((x) => x.description === 'TRF TO NAJD WHOLESALE')!;
    expect(l.suggestion).toMatchObject({ kind: 'pay', contactId: supplier });
    await as(f.staff, (db) => B.payFromLine(db, l.id, supplier));
    expect((await as(f.staff, (db) => S.getDocument(db, bill))).state).toBe('paid');
  });

  it('other lines post a journal entry with no VAT; the bank account itself cannot be the other side', async () => {
    const l = (await lines(bank)).find((x) => x.description === 'BANK CHARGES')!;
    await expect(as(f.staff, (db) => B.bookLine(db, l.id, { accountId: f.a.cash }))).rejects.toThrow(/other than this bank/);
    const owners = (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '3000'`, [f.a.id])).rows[0].id;
    await as(f.staff, (db) => B.bookLine(db, l.id, { accountId: owners }));
    await expect(as(f.staff, (db) => B.bookLine(db, l.id, { accountId: owners }))).rejects.toThrow(/already dealt with/);
  });

  it('reviewers and view-only users cannot match or book', async () => {
    await as(f.staff, (db) => B.importStatement(db, bank, { lines: [line('2026-03-20', 'UNKNOWN DEPOSIT', '500.00')] }));
    const l = (await lines(bank)).find((x) => x.description === 'UNKNOWN DEPOSIT')!;
    for (const u of [f.reviewer, f.a.clientViewer]) await expect(as(u, (db) => B.ignoreLine(db, l.id))).rejects.toThrow();
  });
});

describe('Reconciliation', () => {
  it('statement balance = books - in books only + on statement only; difference 0 when everything is accounted for', async () => {
    const id = await as(f.staff, (db) => B.saveBankAccount(db, f.a.id, { bankName: 'Riyad Bank', accountNumber: '2233445566' }));
    const ledger = (await as(f.staff, (db) => B.getBankAccount(db, id))).accountId;
    const owners = (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '3000'`, [f.a.id])).rows[0].id;
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-04-01', memo: 'Capital', lines: [{ accountId: ledger, debit: '1000.00' }, { accountId: owners, credit: '1000.00' }] }));
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-04-05', memo: 'Cheque 12 not cleared', lines: [{ accountId: owners, debit: '200.00' }, { accountId: ledger, credit: '200.00' }] }));
    await as(f.staff, (db) => B.importStatement(db, id, { lines: [line('2026-04-01', 'CASH DEPOSIT', '1000.00', '1000.00'), line('2026-04-06', 'SERVICE FEE', '-10.00', '990.00')] }));
    const dep = (await lines(id)).find((x) => x.description === 'CASH DEPOSIT')!;
    await as(f.staff, (db) => B.matchLine(db, dep.id, (dep.suggestion as { journalLineId: string }).journalLineId));
    const r = await as(f.staff, (db) => B.reconciliation(db, id));
    expect(r).toMatchObject({ statementDate: '2026-04-06', statementBalance: '990.00', booksBalance: '800.00', adjustedBooks: '990.00', difference: '0.00' });
    expect(r.inBooksOnly.map((x) => x.amount)).toEqual(['-200.00']);
    expect(r.onStatementOnly.map((x: { amount: string }) => x.amount)).toEqual(['-10.00']);
  });

  it('a matched line cannot be removed with its import; unmatched lines can', async () => {
    const imp = (await as(f.staff, (db) => B.listImports(db, bank))).find((i) => i.fileName === 'march.csv')!;
    expect(await as(f.staff, (db) => B.undoImport(db, imp.id))).toBe(0);
  });
});
