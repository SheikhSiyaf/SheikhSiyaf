// Bulk import: checks each row against the books (already there, repeated in the file, unknown account) and
// imports through the same services as typing it in, so every rule, the audit log and data separation apply.
// Customers, suppliers, items and accounts: new rows are added, rows already in the books are left as they are,
// rows with problems are left out. Opening balances: all or nothing, as one balanced journal entry.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor } from '../money.js';
import { postEntry } from '../ledger/ledger.js';
import { saveContact } from './documentsService.js';
import { saveItem } from './inventoryService.js';
import { saveAccount } from './setupService.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { ACCOUNT_TYPE_WORDS, IMPORT_KINDS, amount, isYes, mapRows, rowProblems, type ImportKind } from './importRules.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
export const MAX_ROWS = 5000;
export interface Options { date?: string; balanceToEquity?: boolean }
export interface PreviewRow { line: number; values: Record<string, string>; status: 'new' | 'exists' | 'error'; problems: string[] }

export function kindOf(v: unknown): ImportKind {
  return IMPORT_KINDS.find((k) => k === v) ?? bad('Choose what to import.', 'err.format');
}

export async function preview(db: Db, companyId: string, kind: ImportKind, rows: unknown, o: Options = {}) {
  if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r))) bad('The file could not be read.', 'err.importFile');
  const cells = (rows as unknown[][]).map((r) => r.map((c) => (c == null ? '' : String(c))));
  if (cells.length > MAX_ROWS + 20) bad(`Import up to ${MAX_ROWS} rows at a time.`, 'err.importTooMany');
  const co = (await db.query('SELECT country, currency FROM companies WHERE id = $1', [companyId])).rows[0] ?? bad('Not found.', 'err.notFound');
  const m = mapRows(kind, cells);
  const out: PreviewRow[] = [];
  const seen = new Set<string>();
  const existing = await existingKeys(db, companyId, kind);
  const accounts = kind === 'opening' ? new Map((await db.query(
    `SELECT code, id, name, cost_centre_required AS ccr FROM accounts WHERE company_id = $1`, [companyId])).rows.map((r) => [r.code as string, r])) : new Map();
  for (const r of m.records) {
    const problems = rowProblems(kind, r.values, co.country);
    const key = keyOf(kind, r.values);
    if (key && seen.has(key)) problems.push('imp.p.repeated');
    if (key) seen.add(key);
    if (kind === 'opening' && r.values.code) {
      const a = accounts.get(r.values.code);
      if (!a) problems.push('imp.p.noAccount');
      else if (a.ccr) problems.push('imp.p.costCentre');
    }
    const exists = kind !== 'opening' && !problems.length && (existing.has(key) || (r.values.vatNumber && existing.has(`vat:${r.values.vatNumber.replace(/\s/g, '')}`)));
    out.push({ line: r.line, values: r.values, status: problems.length ? 'error' : exists ? 'exists' : 'new', problems });
  }
  const counts = { new: out.filter((x) => x.status === 'new').length, exists: out.filter((x) => x.status === 'exists').length, error: out.filter((x) => x.status === 'error').length };
  let opening = null as null | { debit: string; credit: string; difference: string; date: string | null; problems: string[]; warnings: string[] };
  if (kind === 'opening') {
    let dr = 0n, cr = 0n;
    for (const x of out) { dr += amount(x.values.debit ?? '') ?? 0n; cr += amount(x.values.credit ?? '') ?? 0n; }
    const problems: string[] = [], warnings: string[] = [];
    const date = o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
    if (!date) problems.push('imp.p.date');
    else if ((await db.query(`SELECT 1 FROM periods WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date AND locked_at IS NOT NULL`, [companyId, date])).rows[0]) problems.push('imp.p.locked');
    if (dr !== cr && !o.balanceToEquity) problems.push('imp.p.unbalanced');
    if (dr === 0n && cr === 0n) problems.push('imp.p.nothing');
    if (out.some((x) => ([SYSTEM_ACCOUNTS.receivables, SYSTEM_ACCOUNTS.payables] as string[]).includes(x.values.code ?? ''))) warnings.push('imp.w.control');
    if ((await db.query(`SELECT 1 FROM journal_entries WHERE company_id = $1 AND memo = 'Opening balances (imported)'`, [companyId])).rows[0]) warnings.push('imp.w.again');
    opening = { debit: fromMinor(dr), credit: fromMinor(cr), difference: fromMinor(dr - cr), date, problems, warnings };
  }
  return { kind, columns: m.columns, missing: m.missing, rows: out, counts, opening };
}

function keyOf(kind: ImportKind, v: Record<string, string>): string {
  if (kind === 'customers' || kind === 'suppliers') return `name:${(v.name ?? '').trim().toLowerCase()}`;
  if (kind === 'items') return `sku:${(v.sku ?? '').trim().toLowerCase()}`;
  return `code:${(v.code ?? '').trim()}`;
}
async function existingKeys(db: Db, companyId: string, kind: ImportKind): Promise<Set<string>> {
  if (kind === 'customers' || kind === 'suppliers') {
    const rows = (await db.query(`SELECT lower(name) AS n, vat_number AS v FROM contacts WHERE company_id = $1 AND ${kind === 'customers' ? 'is_customer' : 'is_supplier'}`, [companyId])).rows;
    return new Set(rows.flatMap((r) => [`name:${r.n}`, ...(r.v ? [`vat:${r.v}`] : [])]));
  }
  if (kind === 'items') return new Set((await db.query('SELECT lower(sku) AS s FROM items WHERE company_id = $1', [companyId])).rows.map((r) => `sku:${r.s}`));
  if (kind === 'accounts') return new Set((await db.query('SELECT code FROM accounts WHERE company_id = $1', [companyId])).rows.map((r) => `code:${r.code}`));
  return new Set();
}

export async function run(db: Db, companyId: string, kind: ImportKind, rows: unknown, o: Options = {}) {
  const p = await preview(db, companyId, kind, rows, o);
  if (p.missing.length) bad('Some required columns are missing.', 'err.importColumns', p.missing);
  if (kind === 'opening') {
    if (p.counts.error) bad('Fix the rows with problems first; opening balances are imported all together.', 'err.importRows');
    if (p.opening!.problems.length) bad('The opening balances cannot be posted yet.', 'err.importOpening', p.opening!.problems);
    const acct = new Map((await db.query('SELECT code, id FROM accounts WHERE company_id = $1', [companyId])).rows.map((r) => [r.code as string, r.id as string]));
    const lines = p.rows.map((r) => ({ accountId: acct.get(r.values.code!)!, debit: fromMinor(amount(r.values.debit ?? '') ?? 0n), credit: fromMinor(amount(r.values.credit ?? '') ?? 0n) }))
      .filter((l) => l.debit !== '0.00' || l.credit !== '0.00')
      .map((l) => (l.debit !== '0.00' ? { accountId: l.accountId, debit: l.debit } : { accountId: l.accountId, credit: l.credit }));
    const diff = amount(p.opening!.difference)!;
    if (diff !== 0n) {
      const eq = acct.get(SYSTEM_ACCOUNTS.openingEquity) ?? bad('This client has no owner\'s equity account (3000) for the difference.', 'err.chart');
      lines.push(diff > 0n ? { accountId: eq, credit: fromMinor(diff) } : { accountId: eq, debit: fromMinor(-diff) });
    }
    const entryId = await postEntry(db, { companyId, entryDate: p.opening!.date!, memo: 'Opening balances (imported)', lines });
    return { imported: lines.length, skipped: 0, entryId };
  }
  const todo = p.rows.filter((r) => r.status === 'new');
  if (!todo.length) bad('There is nothing new to import.', 'err.importNothing');
  for (const r of todo) {
    const v = r.values;
    if (kind === 'customers' || kind === 'suppliers') {
      await saveContact(db, companyId, { isCustomer: kind === 'customers', isSupplier: kind === 'suppliers', name: v.name, nameAr: v.nameAr, vatNumber: v.vatNumber, crNumber: v.crNumber,
        email: v.email, phone: v.phone, address: v.address, city: v.city, country: v.country?.toUpperCase() || undefined, paymentTermsDays: v.paymentTermsDays || null,
        buildingNumber: v.buildingNumber, district: v.district, postalCode: v.postalCode });
    } else if (kind === 'items') {
      const price = v.salePrice ? fromMinor(amount(v.salePrice)!) : null;
      await saveItem(db, companyId, { sku: v.sku, name: v.name, nameAr: v.nameAr, unit: v.unit || 'pcs', salePrice: price, reorderLevel: v.reorderLevel || null });
    } else {
      await saveAccount(db, companyId, { code: v.code, name: v.name, nameAr: v.nameAr, type: ACCOUNT_TYPE_WORDS[(v.type ?? '').toLowerCase().trim()], costCentreRequired: isYes(v.costCentreRequired ?? '') });
    }
  }
  return { imported: todo.length, skipped: p.counts.exists + p.counts.error, entryId: null };
}
