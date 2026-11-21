// Pieces shared by the company builders.
import { fromMinor, toMinor } from '../../src/money.js';
import * as Bank from '../../src/books/bankService.js';
import * as Inv from '../../src/books/inventoryService.js';
import * as Cal from '../../src/books/calendarService.js';
import { daysAgo, fakeIban, type Ctx } from './lib.js';

export type Facts = Record<string, string>;

// ------------------------------------------------------------------ shared pieces

/** Cash and bank at the start of the books, funded by the owners. */
export async function opening(c: Ctx, bank: number, cash: number, ago = 120) {
  await c.post(daysAgo(ago), 'Opening balance', [c.L('1000', bank.toFixed(2)), c.L('1010', cash.toFixed(2)), c.L('3000', undefined, (bank + cash).toFixed(2))]);
}

/** The bank account's details and a statement built from the books, with a few lines the books do not have yet. */
export async function bankStatement(c: Ctx, matchShare: number): Promise<string> {
  const bankId = (await c.client.query('SELECT id FROM bank_accounts WHERE account_id = $1', [c.acct['1000']])).rows[0].id as string;
  await Bank.saveBankAccount(c.db, c.id, { kind: 'bank', bankName: 'Demo Bank', iban: fakeIban(Number(bankId.replace(/\D/g, '').slice(0, 6)) || 7), accountNumber: '0000000000000001', name: 'Demo Bank – current account', nameAr: 'البنك التجريبي – الحساب الجاري' }, bankId);
  const from = daysAgo(400);
  const rows = (await c.client.query(
    `SELECT e.entry_date::text AS date, e.memo, (l.debit - l.credit)::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND e.entry_date >= $2 AND e.entry_date < $3 ORDER BY e.entry_date, e.created_at`, [c.acct['1000'], from, daysAgo(1)])).rows;
  const lines = rows.map((r) => ({ date: r.date as string, description: String(r.memo ?? 'TRANSFER').toUpperCase().slice(0, 60), amount: r.amount as string }));
  const extras = [
    { date: daysAgo(30), description: 'MOBILE BUSINESS BILL 0112233', amount: '-345.00' },
    { date: daysAgo(14), description: 'POS FUEL STATION 44', amount: '-86.25' },
    { date: daysAgo(7), description: 'BANK SERVICE CHARGES', amount: '-25.00' },
    { date: daysAgo(5), description: 'MOBILE BUSINESS BILL 0112233', amount: '-299.00' },
  ];
  const all = [...lines, ...extras].sort((a, b) => a.date.localeCompare(b.date));
  let bal = toMinor((await c.client.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`, [c.acct['1000'], from])).rows[0].v);
  const statement = all.map((l) => { bal += toMinor(l.amount); return { ...l, reference: null, balance: fromMinor(bal) }; });
  await Bank.importStatement(c.db, bankId, { fileName: 'statement.csv', lines: statement });
  await Bank.saveRule(c.db, c.id, { matchText: 'MOBILE', direction: 'out', accountId: c.acct['5300'], vatCode: 'standard', label: 'Mobile and internet' });
  const open = await Bank.statementLines(c.db, bankId, { status: 'open' });
  let n = 0;
  for (const l of open) {
    if (l.suggestion?.kind === 'match' && c.r() < matchShare) { await Bank.matchLine(c.db, l.id, l.suggestion.journalLineId); n++; }
  }
  void n;
  return bankId;
}

/** Every earlier deadline (VAT return, social insurance) is filed, so nothing shows overdue on the home page. */
export async function fileDeadlines(c: Ctx) {
  const overdue = (await Cal.calendar(c.db, c.id, daysAgo(0))).filter((i) => i.status === 'overdue');
  for (const [k, i] of overdue.entries()) await Cal.markDone(c.db, c.id, i.key, { reference: `${i.kind === 'vat_return' ? 'VAT' : 'REF'}-${2600 + k}` });
}

export const note = async (c: Ctx, type: 'grn' | 'gdn', ago: number, contactId: string | null, lines: Inv.NoteLineInput[], reference?: string, otherCode?: string) => {
  const nid = await Inv.saveNoteDraft(c.db, c.id, { type, date: daysAgo(ago), contactId, reference, otherAccountId: otherCode ? c.acct[otherCode] : null, lines });
  await Inv.postNote(c.db, nid);
};

