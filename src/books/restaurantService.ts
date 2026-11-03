// Restaurant: menu items with their recipes (materials per portion), food cost, and food sales.
// A food sale issues a tax invoice, takes the recipe materials out of stock at average cost and, when paid at
// once, records the payment, all in one transaction (db/migrations/0013_restaurant.sql links the three).
import type { Db } from '../db/session.js';
import { divRoundHalfUp, fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { milliToString, quantityToMilli } from './documents.js';
import * as S from './documentsService.js';
import * as I from './inventoryService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMilli = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };

async function requireRestaurant(db: Db, companyId: string) {
  const { rows } = await db.query(`SELECT 'Restaurant' = ANY (modules) AS on FROM companies WHERE id = $1`, [companyId]);
  if (!rows[0]) notFound();
  if (!rows[0].on) bad('The Restaurant module is not turned on for this client.', 'err.restaurantOff');
}

/** Cost of one unit of each material: average cost while in stock, otherwise the last cost received. Minor units per 1 unit (exact numerator/denominator). */
async function unitCosts(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT i.id, i.qty_on_hand::text AS q, i.value_on_hand::text AS v,
            (SELECT l.unit_cost::text FROM stock_note_lines l JOIN stock_notes n ON n.id = l.note_id
             WHERE l.item_id = i.id AND n.type = 'grn' AND n.status = 'posted' ORDER BY n.posted_at DESC, l.line_no DESC LIMIT 1) AS last
     FROM items i WHERE i.company_id = $1`, [companyId]);
  return new Map(rows.map((r) => [r.id as string, toMilli(r.q) > 0n ? { num: toMinor(r.v), per: toMilli(r.q) } : { num: r.last ? toMinor(r.last) : 0n, per: 1000n }]));
}

// ------------------------------------------------------------------ recipes (menu items)
export async function listRecipes(db: Db, companyId: string, q = '') {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.name_ar AS "nameAr", r.category, r.sale_price::text AS "salePrice", r.vat_code AS "vatCode",
            r.income_account_id AS "incomeAccountId", r.status,
            coalesce((SELECT json_agg(json_build_object('itemId', l.item_id, 'quantity', l.quantity::text, 'sku', i.sku, 'name', i.name, 'nameAr', i.name_ar, 'unit', i.unit) ORDER BY i.name)
                      FROM recipe_lines l JOIN items i ON i.id = l.item_id WHERE l.recipe_id = r.id), '[]') AS lines
     FROM recipes r WHERE r.company_id = $1
       AND ($2 = '' OR r.name ILIKE '%' || $2 || '%' OR coalesce(r.name_ar, '') ILIKE '%' || $2 || '%' OR coalesce(r.category, '') ILIKE '%' || $2 || '%')
     ORDER BY r.status, coalesce(r.category, ''), r.name`, [companyId, q.trim()]);
  const costs = await unitCosts(db, companyId);
  return rows.map((r) => {
    const lines = (r.lines as { itemId: string; quantity: string }[]).map((l) => {
      const c = costs.get(l.itemId) ?? { num: 0n, per: 1000n };
      return { ...l, cost: fromMinor(divRoundHalfUp(toMilli(l.quantity) * c.num, c.per)) };
    });
    const cost = lines.reduce((t, l) => t + toMinor(l.cost), 0n);
    const price = toMinor(r.salePrice);
    return { ...r, lines, cost: fromMinor(cost), margin: fromMinor(price - cost), foodCostPct: price > 0n ? Number((cost * 1000n) / price) / 10 : null };
  });
}

export async function getRecipe(db: Db, id: string) {
  const { rows } = await db.query('SELECT company_id FROM recipes WHERE id = $1', [id]);
  if (!rows[0]) notFound();
  return (await listRecipes(db, rows[0].company_id)).find((r) => r.id === id)!;
}

export interface RecipeInput {
  name?: string; nameAr?: string; category?: string; salePrice?: string; vatCode?: string; incomeAccountId?: string | null; status?: 'active' | 'archived';
  lines?: { itemId?: string; quantity?: string }[];
}

export async function saveRecipe(db: Db, companyId: string, r: RecipeInput, id?: string): Promise<string> {
  await requireRestaurant(db, companyId);
  const name = String(r.name ?? '').trim();
  if (!name) bad('Enter the menu item name.', 'err.recipeName');
  let price: Minor;
  try { price = toMinor(String(r.salePrice ?? '').replace(/,/g, '').trim()); } catch { return bad('Enter the selling price.', 'err.recipePrice'); }
  if (price < 0n) bad('Enter the selling price.', 'err.recipePrice');
  const vat = ['standard', 'zero', 'exempt', 'out_of_scope'].includes(String(r.vatCode)) ? r.vatCode : 'standard';
  const income = r.incomeAccountId || (await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, SYSTEM_ACCOUNTS.sales])).rows[0]?.id;
  const lines = (r.lines ?? []).filter((l) => l.itemId).map((l, i) => {
    try { return { itemId: l.itemId!, q: quantityToMilli(String(l.quantity ?? '').trim()) }; }
    catch { return bad(`Line ${i + 1}: enter the quantity used in one portion (up to 3 decimals).`, 'err.recipeQty'); }
  });
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) bad('Each material appears once in a recipe.', 'err.recipeDuplicate');
  const v = [name, r.nameAr?.trim() || null, r.category?.trim() || null, fromMinor(price), vat, income, r.status === 'archived' ? 'archived' : 'active'];
  let rid = id;
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE recipes SET name=$2, name_ar=$3, category=$4, sale_price=$5, vat_code=$6, income_account_id=$7, status=$8 WHERE id = $1 AND company_id = $9`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    await db.query('DELETE FROM recipe_lines WHERE recipe_id = $1', [id]);
  } else {
    rid = (await db.query(
      `INSERT INTO recipes (company_id, name, name_ar, category, sale_price, vat_code, income_account_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
  }
  for (const l of lines) {
    await db.query('INSERT INTO recipe_lines (company_id, recipe_id, item_id, quantity) VALUES ($1, $2, $3, $4)', [companyId, rid, l.itemId, milliToString(l.q)]);
  }
  return rid!;
}

// ------------------------------------------------------------------ food sales
export interface SaleInput {
  date?: string; contactId?: string | null; method?: 'cash' | 'card' | 'bank_transfer' | 'on_account'; accountId?: string | null;
  costCentreId?: string | null; reference?: string; lines?: { recipeId?: string; quantity?: number | string }[];
}

/** The walk-in customer used for sales with no named customer (created the first time). */
async function walkIn(db: Db, companyId: string): Promise<string> {
  const { rows } = await db.query(`SELECT id FROM contacts WHERE company_id = $1 AND is_customer AND name = 'Walk-in customer' LIMIT 1`, [companyId]);
  return rows[0]?.id ?? S.saveContact(db, companyId, { isCustomer: true, name: 'Walk-in customer', nameAr: 'عميل نقدي', paymentTermsDays: 0 });
}

/** Sells menu items: issues the tax invoice, uses the recipe materials (GDN at average cost) and records the payment. */
export async function sellFood(db: Db, companyId: string, s: SaleInput) {
  await requireRestaurant(db, companyId);
  const date = s.date && DATE.test(s.date) ? s.date : bad('Enter the date.', 'err.date');
  const method = ['cash', 'card', 'bank_transfer', 'on_account'].includes(String(s.method)) ? s.method! : bad('Choose how the customer paid.', 'err.saleMethod');
  if (method !== 'on_account' && !s.accountId) bad('Choose the cash or bank account the money went into.', 'err.bankAccount');
  const wanted = (s.lines ?? []).map((l) => ({ recipeId: String(l.recipeId ?? ''), qty: Number(l.quantity) }))
    .filter((l) => l.recipeId && l.qty !== 0);
  if (!wanted.length) bad('Add at least one menu item.', 'err.saleEmpty');
  if (wanted.some((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 999)) bad('Quantities are whole portions (1 to 999).', 'err.saleQty');
  const recipes = new Map((await listRecipes(db, companyId)).map((r) => [r.id, r]));
  const lines = wanted.map((l) => ({ ...l, r: recipes.get(l.recipeId) ?? bad('Choose menu items of this client.', 'err.saleEmpty') }));
  if (lines.some((l) => l.r.status !== 'active')) bad('This menu item is no longer on the menu.', 'err.saleArchived');
  if (method === 'on_account' && !s.contactId) bad('Choose the customer the sale is charged to.', 'err.saleOnAccount');
  const contactId = s.contactId || await walkIn(db, companyId);

  // 1. The tax invoice.
  const invoiceId = await S.saveDraft(db, companyId, { type: 'invoice', contactId, issueDate: date, dueDate: date, reference: s.reference?.trim() || undefined,
    lines: lines.map((l) => ({ description: l.r.name, quantity: String(l.qty), unitPrice: l.r.salePrice, accountId: l.r.incomeAccountId,
      costCentreId: s.costCentreId || null, vatCode: l.r.vatCode })) });
  await S.issueDocument(db, invoiceId);
  const inv = (await db.query('SELECT number, gross_total::text AS gross FROM documents WHERE id = $1', [invoiceId])).rows[0];

  // 2. The materials used, taken out of stock at average cost.
  const used = new Map<string, bigint>();
  for (const l of lines) for (const m of l.r.lines) used.set(m.itemId, (used.get(m.itemId) ?? 0n) + toMilli(m.quantity) * BigInt(l.qty));
  let noteId: string | null = null;
  if (used.size) {
    noteId = await I.saveNoteDraft(db, companyId, { type: 'gdn', date, contactId, reference: inv.number,
      lines: [...used.entries()].map(([itemId, q]) => ({ itemId, quantity: milliToString(q), costCentreId: s.costCentreId || null })) });
    await I.postNote(db, noteId);
  }

  // 3. The payment, when paid at once.
  let paymentId: string | null = null;
  if (method !== 'on_account') {
    paymentId = await S.recordPayment(db, companyId, { direction: 'received', contactId, date, amount: inv.gross, accountId: s.accountId!,
      method: method === 'bank_transfer' ? 'bank_transfer' : method, reference: inv.number, allocations: [{ documentId: invoiceId, amount: inv.gross }] });
  }
  await db.query(`INSERT INTO restaurant_sales (company_id, document_id, stock_note_id, payment_id, method, created_by) VALUES ($1, $2, $3, $4, $5, app_user_id())`,
    [companyId, invoiceId, noteId, paymentId, method]);
  return { invoiceId, number: inv.number as string };
}

export async function listSales(db: Db, companyId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT s.id, s.method, s.created_at AS "createdAt", d.id AS "invoiceId", d.number, d.issue_date::text AS date, c.name AS "contactName", c.name_ar AS "contactNameAr",
            d.net_total::text AS "netTotal", d.vat_total::text AS "vatTotal", d.gross_total::text AS "grossTotal",
            coalesce(n.total_value, 0)::text AS "foodCost", document_amount_due(d.id)::numeric(18,2)::text AS "amountDue",
            (SELECT string_agg(trim(to_char(l.quantity, 'FM999990.###')) || ' × ' || l.description, ', ' ORDER BY l.line_no) FROM document_lines l WHERE l.document_id = d.id) AS items
     FROM restaurant_sales s JOIN documents d ON d.id = s.document_id JOIN contacts c ON c.id = d.contact_id LEFT JOIN stock_notes n ON n.id = s.stock_note_id
     WHERE s.company_id = $1 AND d.issue_date BETWEEN $2 AND $3 ORDER BY d.issue_date DESC, s.created_at DESC`, [companyId, from, to]);
  const sum = (k: 'netTotal' | 'grossTotal' | 'foodCost') => rows.reduce((t, r) => t + toMinor(r[k]), 0n);
  const net = sum('netTotal'), cost = sum('foodCost');
  return { from, to, sales: rows, count: rows.length, netTotal: fromMinor(net), grossTotal: fromMinor(sum('grossTotal')), foodCost: fromMinor(cost),
    foodCostPct: net > 0n ? Number((cost * 1000n) / net) / 10 : null };
}
