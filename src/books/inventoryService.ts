// Inventory: items, goods received notes (GRN), goods delivery notes (GDN) and stock value.
// Every function runs inside withUser(); db/migrations/0011_inventory.sql re-checks the stock and its value.
import type { Db } from '../db/session.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { averageCost, issueCost, milliToString, notePrefix, quantityToMilli, receivedValue, type NoteType } from './inventory.js';
import { nextNumber } from './documentsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function accountByCode(db: Db, companyId: string, code: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code]);
  return rows[0]?.id ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
}

// ------------------------------------------------------------------ items
const ITEM_COLS = `i.id, i.company_id AS "companyId", i.sku, i.name, i.name_ar AS "nameAr", i.unit, i.sale_price::text AS "salePrice",
  i.reorder_level::text AS "reorderLevel", i.qty_on_hand::text AS "qtyOnHand", i.value_on_hand::text AS "valueOnHand", i.status`;
const withAverage = <T extends { qtyOnHand: string; valueOnHand: string; reorderLevel: string | null }>(r: T) => {
  const q = toMilli(r.qtyOnHand);
  return { ...r, averageCost: fromMinor(averageCost(q, toMinor(r.valueOnHand))), low: r.reorderLevel !== null && q <= toMilli(r.reorderLevel) };
};
/** "12.500" -> thousandths (zero allowed, for stock on hand). */
const toMilli = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };

export async function listItems(db: Db, companyId: string, q = '') {
  const { rows } = await db.query(
    `SELECT ${ITEM_COLS} FROM items i WHERE i.company_id = $1
       AND ($2 = '' OR i.name ILIKE '%' || $2 || '%' OR i.sku ILIKE '%' || $2 || '%' OR coalesce(i.name_ar, '') ILIKE '%' || $2 || '%')
     ORDER BY i.status, i.name`, [companyId, q.trim()]);
  return rows.map(withAverage);
}

export async function getItem(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${ITEM_COLS} FROM items i WHERE i.id = $1`, [id]);
  const item = rows[0] ?? notFound();
  const moves = (await db.query(
    `SELECT n.id AS "noteId", n.type, n.number, n.note_date::text AS date, c.name AS "contactName", l.quantity::text, l.value::text
     FROM stock_note_lines l JOIN stock_notes n ON n.id = l.note_id LEFT JOIN contacts c ON c.id = n.contact_id
     WHERE l.item_id = $1 AND n.status = 'posted' ORDER BY n.posted_at, l.line_no`, [id])).rows;
  let q = 0n, v = 0n;
  const movements = moves.map((m) => {
    const sign = m.type === 'grn' ? 1n : -1n;
    q += sign * toMilli(m.quantity); v += sign * toMinor(m.value);
    return { ...m, qtyAfter: milliToString(q), valueAfter: fromMinor(v) };
  });
  return { ...withAverage(item), movements };
}

export interface ItemInput { sku?: string; name?: string; nameAr?: string; unit?: string; salePrice?: string | null; reorderLevel?: string | null; status?: 'active' | 'archived' }

export async function saveItem(db: Db, companyId: string, i: ItemInput, id?: string): Promise<string> {
  const sku = String(i.sku ?? '').trim(), name = String(i.name ?? '').trim();
  if (!sku) bad('Enter the item code.', 'err.itemSku');
  if (!name) bad('Enter the item name.', 'err.itemName');
  let price: string | null = null, reorder: string | null = null;
  try {
    if (i.salePrice !== undefined && i.salePrice !== null && String(i.salePrice).trim() !== '') price = fromMinor(toMinor(String(i.salePrice).replace(/,/g, '').trim()));
    if (i.reorderLevel !== undefined && i.reorderLevel !== null && String(i.reorderLevel).trim() !== '') reorder = milliToString(toMilli(String(i.reorderLevel).trim()));
  } catch { bad('Prices have at most 2 decimals; quantities at most 3.', 'err.amountFormat'); }
  const v = [sku, name, i.nameAr?.trim() || null, i.unit?.trim() || 'pcs', price, reorder, i.status === 'archived' ? 'archived' : 'active'];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE items SET sku=$2, name=$3, name_ar=$4, unit=$5, sale_price=$6, reorder_level=$7, status=$8 WHERE id = $1`, [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(
    `INSERT INTO items (company_id, sku, name, name_ar, unit, sale_price, reorder_level, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, app_user_id()) RETURNING id`,
    [companyId, ...v])).rows[0].id;
}

// ------------------------------------------------------------------ goods notes
export interface NoteLineInput { itemId?: string; quantity?: string; unitCost?: string | null; costCentreId?: string | null }
export interface NoteInput { type?: NoteType; date?: string; contactId?: string | null; reference?: string; notes?: string; otherAccountId?: string | null; lines?: NoteLineInput[] }

const NOTE_COLS = `n.id, n.company_id AS "companyId", n.type, n.status, n.number, n.note_date::text AS date, n.contact_id AS "contactId",
  c.name AS "contactName", c.name_ar AS "contactNameAr", n.reference, n.notes, n.other_account_id AS "otherAccountId",
  a.code AS "otherAccountCode", a.name AS "otherAccountName", a.name_ar AS "otherAccountNameAr", n.total_value::text AS "totalValue",
  n.journal_entry_id AS "journalEntryId", n.created_at AS "createdAt",
  (SELECT count(*) FROM stock_note_lines l WHERE l.note_id = n.id)::int AS "lineCount"`;

export async function listNotes(db: Db, companyId: string, type: NoteType, q = '') {
  const { rows } = await db.query(
    `SELECT ${NOTE_COLS} FROM stock_notes n LEFT JOIN contacts c ON c.id = n.contact_id JOIN accounts a ON a.id = n.other_account_id
     WHERE n.company_id = $1 AND n.type = $2
       AND ($3 = '' OR coalesce(n.number, '') ILIKE '%' || $3 || '%' OR coalesce(c.name, '') ILIKE '%' || $3 || '%' OR coalesce(n.reference, '') ILIKE '%' || $3 || '%')
     ORDER BY (n.status = 'draft') DESC, n.note_date DESC, n.created_at DESC`, [companyId, type, q.trim()]);
  return rows;
}

export async function getNote(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${NOTE_COLS} FROM stock_notes n LEFT JOIN contacts c ON c.id = n.contact_id JOIN accounts a ON a.id = n.other_account_id WHERE n.id = $1`, [id]);
  const note = rows[0] ?? notFound();
  const lines = (await db.query(
    `SELECT l.id, l.line_no AS "lineNo", l.item_id AS "itemId", i.sku, i.name, i.name_ar AS "nameAr", i.unit, l.quantity::text, l.unit_cost::text AS "unitCost",
            l.value::text, l.cost_centre_id AS "costCentreId", cc.name AS "costCentre", cc.name_ar AS "costCentreAr"
     FROM stock_note_lines l JOIN items i ON i.id = l.item_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.note_id = $1 ORDER BY l.line_no`, [id])).rows;
  return { ...note, lines };
}

async function lockNote(db: Db, id: string) {
  const { rows } = await db.query(`SELECT id, company_id AS "companyId", type, status, note_date::text AS date, other_account_id AS "otherAccountId", contact_id AS "contactId"
    FROM stock_notes WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? notFound();
}

export async function saveNoteDraft(db: Db, companyId: string, n: NoteInput, id?: string): Promise<string> {
  const existing = id ? await lockNote(db, id) : null;
  if (existing && existing.status !== 'draft') bad('Posted goods notes are never changed. Record a new note to correct one.', 'err.notePosted');
  const type: NoteType = existing?.type ?? (n.type === 'gdn' ? 'gdn' : n.type === 'grn' ? 'grn' : bad('Choose goods received or goods delivered.', 'err.format'));
  if (!n.date || !DATE.test(n.date)) bad('Enter the date.', 'err.date');
  const other = n.otherAccountId || await accountByCode(db, companyId, type === 'grn' ? SYSTEM_ACCOUNTS.goodsReceived : SYSTEM_ACCOUNTS.costOfSales);
  const lines = (n.lines ?? []).filter((l) => l.itemId || (l.quantity && String(l.quantity).trim()));
  const priced = lines.map((l, i) => {
    if (!l.itemId) bad(`Line ${i + 1}: choose the item.`, 'err.noteItem');
    let q: bigint;
    try { q = quantityToMilli(String(l.quantity ?? '').trim()); } catch { return bad(`Line ${i + 1}: enter a quantity above 0 (up to 3 decimals).`, 'err.noteQty'); }
    let cost: Minor | null = null;
    if (type === 'grn') {
      try { cost = toMinor(String(l.unitCost ?? '').replace(/,/g, '').trim()); } catch { return bad(`Line ${i + 1}: enter the cost per unit.`, 'err.noteCost'); }
      if (cost < 0n) bad(`Line ${i + 1}: enter the cost per unit.`, 'err.noteCost');
    }
    return { itemId: l.itemId!, qty: q, cost, costCentreId: l.costCentreId || null };
  });
  const head = [n.date, n.contactId || null, n.reference?.trim() || null, n.notes?.trim() || null, other];
  let noteId = id;
  if (existing) {
    await db.query(`UPDATE stock_notes SET note_date=$2, contact_id=$3, reference=$4, notes=$5, other_account_id=$6 WHERE id = $1`, [id, ...head]);
    await db.query('DELETE FROM stock_note_lines WHERE note_id = $1', [id]);
  } else {
    noteId = (await db.query(
      `INSERT INTO stock_notes (company_id, type, note_date, contact_id, reference, notes, other_account_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7, app_user_id()) RETURNING id`,
      [companyId, type, ...head])).rows[0].id;
  }
  for (const [i, l] of priced.entries()) {
    await db.query(
      `INSERT INTO stock_note_lines (company_id, note_id, line_no, item_id, quantity, unit_cost, value, cost_centre_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, noteId, i + 1, l.itemId, milliToString(l.qty), l.cost === null ? null : fromMinor(l.cost), l.cost === null ? '0' : fromMinor(receivedValue(l.qty, l.cost)), l.costCentreId]);
  }
  return noteId!;
}

export async function deleteNoteDraft(db: Db, id: string): Promise<void> {
  const n = await lockNote(db, id);
  if (n.status !== 'draft') bad('Posted goods notes are never changed. Record a new note to correct one.', 'err.notePosted');
  await db.query('DELETE FROM stock_note_lines WHERE note_id = $1', [id]);
  await db.query('DELETE FROM stock_notes WHERE id = $1', [id]);
}

/** Posts a goods note: moves the stock at cost (GRN) or average cost (GDN), numbers it and posts its journal entry. */
export async function postNote(db: Db, id: string): Promise<void> {
  const n = await lockNote(db, id);
  if (n.status !== 'draft') bad('This note has already been posted.', 'err.notePosted');
  const lines = (await db.query(
    `SELECT l.id, l.item_id AS "itemId", l.quantity::text, l.value::text, l.cost_centre_id AS "costCentreId", i.name, i.sku
     FROM stock_note_lines l JOIN items i ON i.id = l.item_id WHERE l.note_id = $1 ORDER BY l.line_no`, [id])).rows;
  if (!lines.length) bad('Add at least one item.', 'err.noteNoLines');
  // Lock the items in a fixed order and follow their stock line by line, as the database will.
  const itemIds = [...new Set(lines.map((l) => l.itemId as string))].sort();
  const stock = new Map<string, { q: bigint; v: Minor }>();
  for (const iid of itemIds) {
    const r = (await db.query('SELECT qty_on_hand::text AS q, value_on_hand::text AS v FROM items WHERE id = $1 FOR UPDATE', [iid])).rows[0];
    stock.set(iid, { q: toMilli(r.q), v: toMinor(r.v) });
  }
  let total = 0n;
  const byCentre = new Map<string, Minor>();
  for (const l of lines) {
    const s = stock.get(l.itemId)!;
    const q = toMilli(l.quantity);
    let value = toMinor(l.value);
    if (n.type === 'gdn') {
      if (q > s.q) bad(`Not enough stock of ${l.name} (${l.sku}): ${milliToString(s.q)} in stock.`, 'err.notEnoughStock');
      value = issueCost(s.q, s.v, q);
      await db.query('UPDATE stock_note_lines SET value = $2 WHERE id = $1', [l.id, fromMinor(value)]);
      s.q -= q; s.v -= value;
    } else { s.q += q; s.v += value; }
    total += value;
    const k = l.costCentreId ?? '';
    byCentre.set(k, (byCentre.get(k) ?? 0n) + value);
  }
  const number = await nextNumber(db, n.companyId, n.type, notePrefix(n.type));
  let entryId: string | null = null;
  if (total > 0n) {
    const inv = await accountByCode(db, n.companyId, SYSTEM_ACCOUNTS.inventory);
    const contact = n.contactId ? (await db.query('SELECT name FROM contacts WHERE id = $1', [n.contactId])).rows[0]?.name : null;
    const parts = [...byCentre.entries()].filter(([, v]) => v > 0n);
    const sideLines = parts.map(([cc, v]) => ({ accountId: n.type === 'grn' ? inv : n.otherAccountId, costCentreId: cc || null, debit: fromMinor(v) }));
    entryId = await postEntry(db, {
      companyId: n.companyId, entryDate: n.date, memo: `${number}${contact ? ` · ${contact}` : ''}`, sourceType: n.type, sourceId: id,
      lines: n.type === 'grn'
        ? [...sideLines, { accountId: n.otherAccountId, credit: fromMinor(total) }]
        : [...sideLines, { accountId: inv, credit: fromMinor(total) }],
    });
  }
  await db.query(`UPDATE stock_notes SET status = 'posted', number = $2, total_value = $3, journal_entry_id = $4 WHERE id = $1`, [id, number, fromMinor(total), entryId]);
}

// ------------------------------------------------------------------ stock value
/** Every item's stock and value, and whether the total agrees with 1300 Inventory in the books. */
export async function stockValue(db: Db, companyId: string) {
  const items = (await listItems(db, companyId)).filter((i) => i.status === 'active' || toMinor(i.valueOnHand) !== 0n);
  const total = items.reduce((s, i) => s + toMinor(i.valueOnHand), 0n);
  const books = (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.code = $2`, [companyId, SYSTEM_ACCOUNTS.inventory])).rows[0].v;
  return { items, total: fromMinor(total), booksValue: books, difference: fromMinor(toMinor(books) - total) };
}

