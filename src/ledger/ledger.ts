// Ledger service. The database enforces every rule; these functions are thin, typed wrappers
// that also check the obvious cases up front so the UI can prevent errors before posting.
import type { Db } from '../db/session.js';
import { toMinor, fromMinor } from '../money.js';

export interface LineInput {
  accountId: string;
  costCentreId?: string | null;
  debit?: string;   // decimal string, e.g. "100.00"
  credit?: string;
}

export interface EntryInput {
  companyId: string;
  entryDate: string; // YYYY-MM-DD
  memo?: string;
  sourceType?: string;
  sourceId?: string;
  lines: LineInput[];
}

/** Returns a list of plain-language problems; empty means the entry can be posted. */
export function checkEntry(input: EntryInput): string[] {
  const problems: string[] = [];
  if (input.lines.length < 2) problems.push('An entry needs at least two lines.');
  let d = 0n;
  let c = 0n;
  for (const [i, l] of input.lines.entries()) {
    const ld = toMinor(l.debit ?? '0');
    const lc = toMinor(l.credit ?? '0');
    if (ld < 0n || lc < 0n) problems.push(`Line ${i + 1}: amounts cannot be negative.`);
    if (ld !== 0n && lc !== 0n) problems.push(`Line ${i + 1}: use either debit or credit, not both.`);
    if (ld === 0n && lc === 0n) problems.push(`Line ${i + 1}: enter an amount.`);
    d += ld;
    c += lc;
  }
  if (d !== c) problems.push(`Entry does not balance (debit ${fromMinor(d)}, credit ${fromMinor(c)}).`);
  return problems;
}

/** Posts an entry. Must run inside withUser(); commits with the surrounding transaction. */
export async function postEntry(db: Db, input: EntryInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (company_id, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, app_user_id()) RETURNING id`,
    [input.companyId, input.entryDate, input.memo ?? null, input.sourceType ?? null, input.sourceId ?? null],
  );
  const id = rows[0]!.id;
  for (const l of input.lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, cost_centre_id, debit, credit) VALUES ($1, $2, $3, $4, $5)`,
      [id, l.accountId, l.costCentreId ?? null, l.debit ?? '0', l.credit ?? '0'],
    );
  }
  return id;
}

export async function reverseEntry(db: Db, entryId: string, date: string, memo?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT reverse_entry($1, $2, $3) AS id', [entryId, date, memo ?? null]);
  return rows[0]!.id;
}

export interface TrialBalanceRow { accountId: string; code: string; name: string; type: string; debit: string; credit: string }

export async function trialBalance(db: Db, companyId: string, asOf: string): Promise<TrialBalanceRow[]> {
  const { rows } = await db.query(
    `SELECT account_id AS "accountId", code, name, type, debit, credit FROM trial_balance($1, $2)`,
    [companyId, asOf],
  );
  return rows;
}

export async function setPeriodLock(db: Db, companyId: string, startDate: string, locked: boolean): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE periods SET locked_at = CASE WHEN $3 THEN now() END WHERE company_id = $1 AND start_date = $2`,
    [companyId, startDate, locked],
  );
  if (rowCount !== 1) throw new Error('Only the Firm partner can lock or unlock this period.');
}
