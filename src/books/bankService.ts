// Bank: accounts, statement import, match suggestions, booking statement lines, reconciliation and rules.
// Every function runs inside withUser(); the database rules in db/migrations/0010_bank.sql apply on top.
import type { Db } from '../db/session.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { autoAllocate, netFromGross, VAT_CODES, type VatCode } from './documents.js';
import { bankFromIban, fingerprints, ibanValid, normaliseIban, similarity, type Layout, type StatementRow } from '../bank/statement.js';
import * as S from './documentsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ bank accounts
const ACCOUNT_COLS = `b.id, b.company_id AS "companyId", b.account_id AS "accountId", b.kind, b.bank_name AS "bankName", b.account_number AS "accountNumber",
  b.iban, b.status, b.import_layout AS "importLayout", a.code, a.name, a.name_ar AS "nameAr",
  (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l WHERE l.account_id = a.id)::numeric(18,2)::text AS "booksBalance",
  (SELECT count(*) FROM bank_statement_lines s WHERE s.bank_account_id = b.id AND s.status = 'open')::int AS "openLines",
  (SELECT max(txn_date) FROM bank_statement_lines s WHERE s.bank_account_id = b.id)::text AS "lastStatementDate"`;

export async function listBankAccounts(db: Db, companyId: string) {
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLS} FROM bank_accounts b JOIN accounts a ON a.id = b.account_id
    WHERE b.company_id = $1 ORDER BY b.status, a.code`, [companyId]);
  return rows;
}

export async function getBankAccount(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLS} FROM bank_accounts b JOIN accounts a ON a.id = b.account_id WHERE b.id = $1`, [id]);
  return rows[0] ?? notFound();
}

export interface BankAccountInput {
  kind?: 'bank' | 'cash' | 'card'; name?: string; nameAr?: string; bankName?: string; accountNumber?: string; iban?: string; status?: 'active' | 'closed';
}

export async function saveBankAccount(db: Db, companyId: string, b: BankAccountInput, id?: string): Promise<string> {
  const kind = b.kind === 'cash' || b.kind === 'card' ? b.kind : 'bank';
  const iban = b.iban?.trim() ? normaliseIban(b.iban) : null;
  if (iban && !ibanValid(iban)) bad('This IBAN is not right. Check it against the bank letter (Saudi IBANs have 24 characters, UAE 23).', 'err.iban');
  const bankName = b.bankName?.trim() || (iban ? bankFromIban(iban)?.name : undefined) || null;
  const number = b.accountNumber?.replace(/\s/g, '') || null;
  const last4 = (number ?? iban ?? '').slice(-4);
  const name = b.name?.trim() || (kind === 'cash' ? 'Cash' : `${bankName ?? 'Bank'}${last4 ? ` ${last4}` : ''}`);
  const nameAr = b.nameAr?.trim() || (iban ? bankFromIban(iban)?.nameAr : undefined) || null;
  if (kind === 'bank' && !bankName) bad('Enter the bank name.', 'err.bankName');
  if (id) {
    const cur = await getBankAccount(db, id);
    if (b.status === 'closed' && cur.status !== 'closed' && toMinor(cur.booksBalance) !== 0n)
      bad('Only an account with a zero balance in the books can be closed.', 'err.bankNotZero');
    await db.query(`UPDATE bank_accounts SET kind = $2, bank_name = $3, account_number = $4, iban = $5, status = $6 WHERE id = $1`,
      [id, kind, bankName, number, iban, b.status === 'closed' ? 'closed' : 'active']);
    await db.query(`UPDATE accounts SET name = $2, name_ar = $3 WHERE id = $1`, [cur.accountId, name, nameAr]);
    return id;
  }
  // A new ledger account in 1001-1099 (1000 and 1010 come with the chart).
  const used = new Set((await db.query(`SELECT code FROM accounts WHERE company_id = $1 AND code ~ '^10[0-9]{2}$'`, [companyId])).rows.map((r) => r.code));
  let code = 1020;
  while (used.has(String(code)) && code < 1100) code += 1;
  if (code >= 1100) bad('There is no free bank account code left (1000-1099).', 'err.noCode');
  const acct = (await db.query(
    `INSERT INTO accounts (company_id, code, name, name_ar, type, is_bank) VALUES ($1, $2, $3, $4, 'asset', true) RETURNING id`,
    [companyId, String(code), name, nameAr])).rows[0].id;
  const { rows } = await db.query(
    `UPDATE bank_accounts SET kind = $2, bank_name = $3, account_number = $4, iban = $5 WHERE account_id = $1 RETURNING id`,
    [acct, kind, bankName, number, iban]);
  return rows[0].id;
}

// ------------------------------------------------------------------ import
export interface ImportInput { fileName?: string; lines?: StatementRow[]; layout?: Layout | null; /** Set by a bank feed sync (db/migrations/0038). */ feedId?: string | null }

/** Saves the lines of a statement file. Lines already imported (same fingerprint) are skipped. */
export async function importStatement(db: Db, bankAccountId: string, input: ImportInput) {
  const acct = await getBankAccount(db, bankAccountId);
  if (acct.status !== 'active') bad('This bank account is closed.', 'err.bankClosed');
  const lines = (input.lines ?? []).map((l, i) => {
    let amount: Minor, balance: Minor | null = null;
    try {
      amount = toMinor(String(l.amount));
      balance = l.balance === null || l.balance === undefined || l.balance === '' ? null : toMinor(String(l.balance));
    } catch { return bad(`Line ${i + 1}: the amount is not a number.`, 'err.amountFormat'); }
    if (!DATE.test(String(l.date))) bad(`Line ${i + 1}: the date is not right.`, 'err.date');
    const description = String(l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!description || amount === 0n) bad(`Line ${i + 1}: needs a description and an amount.`, 'err.statementLine');
    return { date: String(l.date), description, reference: l.reference?.toString().trim() || null, amount: fromMinor(amount), balance: balance === null ? null : fromMinor(balance) };
  });
  if (!lines.length) bad('The file has no statement lines.', 'err.noStatementLines');
  const prints = fingerprints(lines);
  const existing = new Set((await db.query(`SELECT fingerprint FROM bank_statement_lines WHERE bank_account_id = $1 AND fingerprint = ANY ($2)`,
    [bankAccountId, prints])).rows.map((r) => r.fingerprint));
  const fresh = lines.map((l, i) => ({ ...l, fp: prints[i]! })).filter((l) => !existing.has(l.fp));
  const dates = lines.map((l) => l.date).sort();
  const imp = (await db.query(
    `INSERT INTO bank_imports (company_id, bank_account_id, file_name, line_count, skipped, date_from, date_to, imported_by, feed_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, app_user_id(), $8) RETURNING id`,
    [acct.companyId, bankAccountId, String(input.fileName ?? 'statement').slice(0, 200), fresh.length, lines.length - fresh.length, dates[0], dates.at(-1), input.feedId ?? null])).rows[0].id;
  for (const l of fresh) {
    await db.query(
      `INSERT INTO bank_statement_lines (company_id, bank_account_id, import_id, txn_date, description, reference, amount, balance, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [acct.companyId, bankAccountId, imp, l.date, l.description, l.reference, l.amount, l.balance, l.fp]);
  }
  if (input.layout) await db.query('UPDATE bank_accounts SET import_layout = $2 WHERE id = $1', [bankAccountId, JSON.stringify(input.layout)]);
  return { importId: imp, imported: fresh.length, skipped: lines.length - fresh.length };
}

export async function listImports(db: Db, bankAccountId: string) {
  const { rows } = await db.query(
    `SELECT i.id, i.file_name AS "fileName", i.line_count AS "lineCount", i.skipped, i.date_from::text AS "dateFrom", i.date_to::text AS "dateTo",
            i.imported_at AS "importedAt", person_name(i.imported_by) AS "importedBy",
            (SELECT count(*) FROM bank_statement_lines s WHERE s.import_id = i.id)::int AS "remaining",
            (SELECT count(*) FROM bank_statement_lines s WHERE s.import_id = i.id AND s.status = 'matched')::int AS "matched"
     FROM bank_imports i WHERE i.bank_account_id = $1 ORDER BY i.imported_at DESC`, [bankAccountId]);
  return rows;
}

/** Removes the unmatched lines of an import (for a wrong file). Matched lines stay. */
export async function undoImport(db: Db, importId: string): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM bank_statement_lines WHERE import_id = $1 AND status <> 'matched'`, [importId]);
  return rowCount ?? 0;
}

// ------------------------------------------------------------------ statement lines and suggestions
interface LedgerLine { id: string; date: string; memo: string | null; amount: Minor; entryId: string; reversesEntryId: string | null; reversed: boolean }

/** Journal lines on the bank's ledger account that no statement line is matched to (excluding an entry and its reversal). */
async function unmatchedLedger(db: Db, ledgerAccountId: string, upTo?: string): Promise<LedgerLine[]> {
  const { rows } = await db.query(
    `SELECT l.id, e.entry_date::text AS date, e.memo, (l.debit - l.credit)::text AS amount, e.id AS "entryId", e.reverses_entry_id AS "reversesEntryId",
            EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND ($2::date IS NULL OR e.entry_date <= $2)
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s.journal_line_id = l.id)
     ORDER BY e.entry_date, e.created_at`, [ledgerAccountId, upTo ?? null]);
  const list = rows.map((r) => ({ ...r, amount: toMinor(r.amount) })) as LedgerLine[];
  const entries = new Set(list.map((l) => l.entryId));
  return list.filter((l) => !(l.reversed && list.some((x) => x.reversesEntryId === l.entryId)) && !(l.reversesEntryId && entries.has(l.reversesEntryId)));
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export async function statementLines(db: Db, bankAccountId: string, f: { status?: string; from?: string; to?: string } = {}) {
  const acct = await getBankAccount(db, bankAccountId);
  const { rows } = await db.query(
    `SELECT s.id, s.txn_date::text AS date, s.description, s.reference, s.amount::text, s.balance::text, s.status, s.journal_line_id AS "journalLineId",
            e.memo AS "matchedMemo", e.source_type AS "matchedSourceType", e.source_id AS "matchedSourceId"
     FROM bank_statement_lines s LEFT JOIN journal_lines l ON l.id = s.journal_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id
     WHERE s.bank_account_id = $1 AND ($2::text IS NULL OR $2 = 'all' OR s.status = $2)
       AND ($3::date IS NULL OR s.txn_date >= $3) AND ($4::date IS NULL OR s.txn_date <= $4)
     ORDER BY s.txn_date DESC, s.created_at DESC`, [bankAccountId, f.status ?? null, f.from || null, f.to || null]);
  const open = rows.filter((r) => r.status === 'open');
  if (!open.length) return rows.map((r) => ({ ...r, suggestion: null }));

  const ledger = await unmatchedLedger(db, acct.accountId);
  const rules = (await db.query(
    `SELECT r.id, r.match_text AS "matchText", r.direction, r.account_id AS "accountId", r.cost_centre_id AS "costCentreId", r.vat_code AS "vatCode", r.label,
            a.code AS "accountCode", a.name AS "accountName", a.name_ar AS "accountNameAr"
     FROM bank_rules r JOIN accounts a ON a.id = r.account_id
     WHERE r.company_id = $1 AND r.active AND (r.bank_account_id IS NULL OR r.bank_account_id = $2) ORDER BY length(r.match_text) DESC`,
    [acct.companyId, bankAccountId])).rows;
  const due = (await db.query(
    `SELECT d.id, d.number, d.type, d.contact_id AS "contactId", c.name AS "contactName", document_amount_due(d.id)::numeric(18,2)::text AS due
     FROM documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 AND d.status = 'issued' AND d.type IN ('invoice', 'bill', 'claim') AND document_amount_due(d.id) > 0`, [acct.companyId])).rows;

  const taken = new Set<string>();
  const suggest = (r: { date: string; description: string; amount: string }) => {
    const amt = toMinor(r.amount);
    // 1. Already in the books: same amount and direction, within two weeks; closest date and most similar text first.
    const inBooks = ledger.filter((l) => l.amount === amt && !taken.has(l.id) && daysBetween(l.date, r.date) <= 14)
      .sort((a, b) => (daysBetween(a.date, r.date) - similarity(a.memo ?? '', r.description) * 5) - (daysBetween(b.date, r.date) - similarity(b.memo ?? '', r.description) * 5));
    if (inBooks[0]) { taken.add(inBooks[0].id); return { kind: 'match' as const, journalLineId: inBooks[0].id, date: inBooks[0].date, memo: inBooks[0].memo }; }
    // 2. Settles an invoice (money in) or a bill or claim (money out) for exactly this amount.
    const want = amt > 0n ? ['invoice'] : ['bill', 'claim'];
    const docs = due.filter((d) => want.includes(d.type) && toMinor(d.due) === (amt < 0n ? -amt : amt))
      .sort((a, b) => similarity(b.contactName, r.description) - similarity(a.contactName, r.description));
    if (docs[0]) return { kind: 'pay' as const, contactId: docs[0].contactId, contactName: docs[0].contactName, documentNumber: docs[0].number };
    // 3. A rule.
    const text = r.description.toLowerCase();
    const rule = rules.find((x) => x.direction === (amt > 0n ? 'in' : 'out') && text.includes(String(x.matchText).toLowerCase()));
    if (rule) return { kind: 'rule' as const, ruleId: rule.id, accountId: rule.accountId, costCentreId: rule.costCentreId, vatCode: rule.vatCode,
      accountCode: rule.accountCode, accountName: rule.accountName, accountNameAr: rule.accountNameAr, label: rule.label };
    return null;
  };
  return rows.map((r) => ({ ...r, suggestion: r.status === 'open' ? suggest(r) : null }));
}

/** Candidates in the books for one line: same amount and direction, any date. */
export async function matchCandidates(db: Db, lineId: string) {
  const line = await getLine(db, lineId);
  const acct = await getBankAccount(db, line.bankAccountId);
  const amt = toMinor(line.amount);
  return (await unmatchedLedger(db, acct.accountId)).filter((l) => l.amount === amt)
    .sort((a, b) => daysBetween(a.date, line.date) - daysBetween(b.date, line.date))
    .map((l) => ({ journalLineId: l.id, date: l.date, memo: l.memo, amount: fromMinor(l.amount) }));
}

async function getLine(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT id, company_id AS "companyId", bank_account_id AS "bankAccountId", txn_date::text AS date, description, reference, amount::text, status
     FROM bank_statement_lines WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? notFound();
}
async function openLine(db: Db, id: string) {
  const line = await getLine(db, id);
  if (line.status !== 'open') bad('This statement line is already dealt with.', 'err.lineDone');
  return line;
}
async function bankSideOf(db: Db, entryId: string, ledgerAccountId: string, amount: Minor): Promise<string> {
  const a = fromMinor(amount < 0n ? -amount : amount);
  const { rows } = await db.query(
    `SELECT id FROM journal_lines WHERE entry_id = $1 AND account_id = $2 AND ${amount > 0n ? 'debit' : 'credit'} = $3 LIMIT 1`, [entryId, ledgerAccountId, a]);
  return rows[0]?.id ?? bad('The entry has no line on this bank account for this amount.', 'err.matchAmount');
}
async function setMatch(db: Db, lineId: string, journalLineId: string) {
  await db.query(`UPDATE bank_statement_lines SET status = 'matched', journal_line_id = $2 WHERE id = $1`, [lineId, journalLineId]);
}

export async function matchLine(db: Db, lineId: string, journalLineId: string): Promise<void> {
  await openLine(db, lineId);
  await setMatch(db, lineId, journalLineId);
}
export async function unmatchLine(db: Db, lineId: string): Promise<void> {
  const line = await getLine(db, lineId);
  if (line.status === 'open') return;
  await db.query(`UPDATE bank_statement_lines SET status = 'open' WHERE id = $1`, [lineId]);
}
export async function ignoreLine(db: Db, lineId: string): Promise<void> {
  await openLine(db, lineId);
  await db.query(`UPDATE bank_statement_lines SET status = 'ignored' WHERE id = $1`, [lineId]);
}

export interface BookInput { accountId?: string; costCentreId?: string | null; vatCode?: VatCode; description?: string; remember?: string | null }

/**
 * Books a statement line that is not in the books yet.
 *   Money out to an expense account: recorded as an expense paid from this bank (so its VAT is in the VAT reports).
 *   Anything else (transfers, loans, owner's money, other income): a journal entry with no VAT.
 * With `remember`, a rule is saved so similar lines are suggested the same way next time.
 */
export async function bookLine(db: Db, lineId: string, b: BookInput): Promise<string> {
  const line = await openLine(db, lineId);
  const acct = await getBankAccount(db, line.bankAccountId);
  const amount = toMinor(line.amount);
  const target = (await db.query(`SELECT id, type, is_bank AS "isBank" FROM accounts WHERE id = $1 AND company_id = $2`, [b.accountId, line.companyId])).rows[0]
    ?? bad('Choose the account.', 'err.lineAccount');
  if (target.id === acct.accountId) bad('Choose an account other than this bank account.', 'err.sameBank');
  const vatCode: VatCode = VAT_CODES.includes(b.vatCode as VatCode) ? b.vatCode! : 'out_of_scope';
  const description = (b.description?.trim() || line.description).slice(0, 200);
  let entryId: string;
  if (amount < 0n && target.type === 'expense') {
    const rate = (await db.query('SELECT vat_rate::text AS r FROM companies WHERE id = $1', [line.companyId])).rows[0].r;
    const split = netFromGross(-amount, rate, vatCode);
    const docId = await S.saveDraft(db, line.companyId, { type: 'expense', payee: line.description.slice(0, 120), paidFromAccountId: acct.accountId,
      issueDate: line.date, reference: line.reference ?? undefined,
      lines: [{ description, quantity: '1', unitPrice: fromMinor(split.net), accountId: target.id, costCentreId: b.costCentreId || null, vatCode },
        ...(split.rounding > 0n ? [{ description: 'VAT rounding', quantity: '1', unitPrice: fromMinor(split.rounding), accountId: target.id,
          costCentreId: b.costCentreId || null, vatCode: 'out_of_scope' as const }] : [])] });
    await S.issueDocument(db, docId);
    entryId = (await db.query('SELECT journal_entry_id FROM documents WHERE id = $1', [docId])).rows[0].journal_entry_id;
  } else {
    const a = fromMinor(amount < 0n ? -amount : amount);
    entryId = await postEntry(db, { companyId: line.companyId, entryDate: line.date, memo: description, sourceType: 'bank', sourceId: line.id,
      lines: amount > 0n
        ? [{ accountId: acct.accountId, debit: a }, { accountId: target.id, costCentreId: b.costCentreId || null, credit: a }]
        : [{ accountId: target.id, costCentreId: b.costCentreId || null, debit: a }, { accountId: acct.accountId, credit: a }] });
  }
  await setMatch(db, lineId, await bankSideOf(db, entryId, acct.accountId, amount));
  if (b.remember && b.remember.trim().length >= 3) {
    await saveRule(db, line.companyId, { matchText: b.remember.trim(), direction: amount > 0n ? 'in' : 'out', accountId: target.id,
      costCentreId: b.costCentreId || null, vatCode, label: description });
  }
  return entryId;
}

/** Money in from a customer, or out to a supplier or employee: records the payment, settling their oldest open documents. */
export async function payFromLine(db: Db, lineId: string, contactId: string): Promise<string> {
  const line = await openLine(db, lineId);
  const acct = await getBankAccount(db, line.bankAccountId);
  const amount = toMinor(line.amount);
  const direction = amount > 0n ? 'received' : 'made';
  const abs = amount < 0n ? -amount : amount;
  const open = await S.openDocuments(db, line.companyId, contactId, direction);
  const allocs = autoAllocate(abs, open.map((d) => ({ id: d.id, due: toMinor(d.amountDue) })));
  const pid = await S.recordPayment(db, line.companyId, { direction, contactId, date: line.date, amount: fromMinor(abs), accountId: acct.accountId,
    method: 'bank_transfer', reference: line.reference ?? line.description.slice(0, 80),
    allocations: allocs.map((a) => ({ documentId: a.id, amount: fromMinor(a.amount) })) });
  const entryId = (await db.query('SELECT journal_entry_id FROM payments WHERE id = $1', [pid])).rows[0].journal_entry_id;
  await setMatch(db, lineId, await bankSideOf(db, entryId, acct.accountId, amount));
  return pid;
}

// ------------------------------------------------------------------ reconciliation
/** Statement balance against the books: books - in books only + on statement only = statement. */
export async function reconciliation(db: Db, bankAccountId: string) {
  const acct = await getBankAccount(db, bankAccountId);
  const last = (await db.query(`SELECT max(txn_date)::text AS d FROM bank_statement_lines WHERE bank_account_id = $1`, [bankAccountId])).rows[0].d as string | null;
  if (!last) return { account: acct, statementDate: null, statementBalance: null, booksBalance: acct.booksBalance, inBooksOnly: [], onStatementOnly: [], difference: null };
  const endLines = (await db.query(`SELECT amount::text, balance::text FROM bank_statement_lines WHERE bank_account_id = $1 AND txn_date = $2 AND balance IS NOT NULL`,
    [bankAccountId, last])).rows.map((r) => ({ amount: toMinor(r.amount), balance: toMinor(r.balance) }));
  // The last line of the day is the one no other line follows (its balance is not another line's starting balance).
  const lastLine = endLines.find((l) => !endLines.some((m) => m !== l && m.balance - m.amount === l.balance)) ?? endLines.at(-1);
  const books = toMinor((await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND e.entry_date <= $2`, [acct.accountId, last])).rows[0].v);
  const inBooksOnly = await unmatchedLedger(db, acct.accountId, last);
  const onStatementOnly = (await db.query(
    `SELECT id, txn_date::text AS date, description, amount::text FROM bank_statement_lines WHERE bank_account_id = $1 AND status = 'open' ORDER BY txn_date`,
    [bankAccountId])).rows;
  const adjusted = books - inBooksOnly.reduce((s, l) => s + l.amount, 0n) + onStatementOnly.reduce((s, l) => s + toMinor(l.amount), 0n);
  return {
    account: acct, statementDate: last, statementBalance: lastLine ? fromMinor(lastLine.balance) : null, booksBalance: fromMinor(books),
    inBooksOnly: inBooksOnly.map((l) => ({ journalLineId: l.id, date: l.date, memo: l.memo, amount: fromMinor(l.amount) })),
    onStatementOnly, adjustedBooks: fromMinor(adjusted),
    difference: lastLine ? fromMinor(lastLine.balance - adjusted) : null,
  };
}

// ------------------------------------------------------------------ rules
export interface RuleInput { matchText?: string; direction?: 'in' | 'out'; accountId?: string; costCentreId?: string | null; vatCode?: VatCode;
  label?: string | null; bankAccountId?: string | null; active?: boolean }

export async function listRules(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT r.id, r.match_text AS "matchText", r.direction, r.account_id AS "accountId", r.cost_centre_id AS "costCentreId", r.vat_code AS "vatCode",
            r.label, r.active, r.bank_account_id AS "bankAccountId", a.code AS "accountCode", a.name AS "accountName", a.name_ar AS "accountNameAr",
            cc.name AS "costCentre", cc.name_ar AS "costCentreAr"
     FROM bank_rules r JOIN accounts a ON a.id = r.account_id LEFT JOIN cost_centres cc ON cc.id = r.cost_centre_id
     WHERE r.company_id = $1 ORDER BY r.active DESC, r.match_text`, [companyId]);
  return rows;
}
export async function saveRule(db: Db, companyId: string, r: RuleInput, id?: string): Promise<string> {
  const text = String(r.matchText ?? '').trim();
  if (text.length < 3) bad('Enter at least 3 letters of the text to look for.', 'err.ruleText');
  if (r.direction !== 'in' && r.direction !== 'out') bad('Choose money in or money out.', 'err.format');
  if (!r.accountId) bad('Choose the account.', 'err.lineAccount');
  const vat = VAT_CODES.includes(r.vatCode as VatCode) ? r.vatCode : 'out_of_scope';
  const v = [text, r.direction, r.accountId, r.costCentreId || null, vat, r.label?.trim() || null, r.bankAccountId || null, r.active !== false];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE bank_rules SET match_text=$2, direction=$3, account_id=$4, cost_centre_id=$5, vat_code=$6, label=$7, bank_account_id=$8, active=$9 WHERE id = $1`, [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(
    `INSERT INTO bank_rules (company_id, match_text, direction, account_id, cost_centre_id, vat_code, label, bank_account_id, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}
export async function deleteRule(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM bank_rules WHERE id = $1', [id]);
  if (!rowCount) notFound();
}

/** Books every open line that has a rule suggestion (one click for the routine lines). */
export async function applyRules(db: Db, bankAccountId: string): Promise<number> {
  const lines = (await statementLines(db, bankAccountId, { status: 'open' })).filter((l) => l.suggestion?.kind === 'rule');
  for (const l of lines) {
    const s = l.suggestion as { accountId: string; costCentreId: string | null; vatCode: VatCode; label: string | null };
    await bookLine(db, l.id, { accountId: s.accountId, costCentreId: s.costCentreId, vatCode: s.vatCode, description: s.label ?? undefined });
  }
  return lines.length;
}
