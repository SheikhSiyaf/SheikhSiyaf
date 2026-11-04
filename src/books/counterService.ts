// The warehouse counter joined to sales and purchases (db/migrations/0036). In one transaction, all or nothing:
//   goods out -> the delivery note is posted and the customer's invoice issued at each item's sale price (a price can be
//                changed at the counter), and, when the customer pays there, the payment is recorded against it;
//   goods in  -> the goods received note is posted and the supplier's bill made as a draft for the accountant, at the
//                cost received, on 2050 Goods received not yet billed (issuing the bill clears it), optionally from
//                the purchase order it delivers.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { toMinor } from '../money.js';
import { addDays } from './documents.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { issueDocument, recordPayment, saveDraft } from './documentsService.js';
import { quickNote } from './inventoryService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };

async function accountByCode(db: Db, companyId: string, code: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code]);
  return rows[0]?.id ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
}
async function items(db: Db, companyId: string, ids: string[]) {
  const rows = (await db.query(`SELECT id, sku, name, sale_price::text AS "salePrice" FROM items WHERE company_id = $1 AND id = ANY($2::uuid[])`, [companyId, ids])).rows;
  return new Map(rows.map((r) => [r.id as string, r as { id: string; sku: string; name: string; salePrice: string | null }]));
}
async function termsDays(db: Db, companyId: string, contactId: string): Promise<number> {
  const r = (await db.query(`SELECT coalesce(ct.payment_terms_days, co.payment_terms_days) AS d FROM contacts ct JOIN companies co ON co.id = ct.company_id
    WHERE ct.id = $1 AND ct.company_id = $2`, [contactId, companyId])).rows[0];
  return r ? Number(r.d) : bad('Choose the customer or supplier.', 'err.contact');
}

export interface CounterSaleInput {
  date?: string; contactId?: string | null; reference?: string;
  lines?: { itemId?: string; quantity?: string; unitPrice?: string | null }[];
  /** The customer paid at the counter: the cash or bank account the money went to, and how. */
  paidToAccountId?: string | null; method?: string;
}

/** Goods out with the customer's invoice (and payment). */
export async function counterSale(db: Db, companyId: string, x: CounterSaleInput) {
  if (!x.contactId) bad('Choose the customer to make the invoice.', 'err.counterCustomer');
  const lines = (x.lines ?? []).filter((l) => l.itemId);
  if (!lines.length) bad('Add at least one item.', 'err.noteNoLines');
  const info = await items(db, companyId, lines.map((l) => l.itemId!));
  const priced = lines.map((l) => {
    const it = info.get(l.itemId!) ?? bad('Choose the item.', 'err.noteItem');
    const price = String(l.unitPrice ?? '').replace(/,/g, '').trim() || it.salePrice || '';
    let ok = false; try { ok = toMinor(price) > 0n; } catch { /* not an amount */ }
    if (!ok) bad(`Enter the selling price of ${it.name} (${it.sku}).`, 'err.counterPrice');
    return { ...l, it, price };
  });
  const note = await quickNote(db, companyId, { type: 'gdn', date: x.date, contactId: x.contactId, reference: x.reference,
    lines: priced.map((l) => ({ itemId: l.itemId!, quantity: String(l.quantity ?? '') })) });
  const date = x.date!;
  const sales = await accountByCode(db, companyId, SYSTEM_ACCOUNTS.sales);
  const paid = Boolean(x.paidToAccountId);
  const invoiceId = await saveDraft(db, companyId, {
    type: 'invoice', contactId: x.contactId, issueDate: date, dueDate: paid ? date : addDays(date, await termsDays(db, companyId, x.contactId!)),
    reference: x.reference?.trim() || note.number, notes: `Delivered from the counter: ${note.number}`,
    lines: priced.map((l) => ({ description: `${l.it.name} (${l.it.sku})`, quantity: String(l.quantity).trim(), unitPrice: l.price, accountId: sales, vatCode: 'standard' as const })),
  });
  await issueDocument(db, invoiceId);
  const inv = (await db.query(`SELECT number, gross_total::text AS total FROM documents WHERE id = $1`, [invoiceId])).rows[0];
  let paymentId: string | null = null;
  if (paid) {
    paymentId = await recordPayment(db, companyId, { direction: 'received', contactId: x.contactId!, date, amount: inv.total, accountId: x.paidToAccountId!,
      method: x.method || 'cash', reference: inv.number, allocations: [{ documentId: invoiceId, amount: inv.total }] });
  }
  await db.query('INSERT INTO counter_links (stock_note_id, company_id, document_id, payment_id) VALUES ($1, $2, $3, $4)', [note.id, companyId, invoiceId, paymentId]);
  return { note, invoice: { id: invoiceId, number: inv.number as string, total: inv.total as string }, paymentId };
}

export interface CounterReceiveInput {
  date?: string; contactId?: string | null; reference?: string;
  lines?: { itemId?: string; quantity?: string; unitCost?: string | null }[];
  /** The purchase order these goods were ordered on (sent or received, same supplier): it is marked billed. */
  purchaseOrderId?: string | null;
}

/** Goods in with the supplier's bill as a draft. */
export async function counterReceive(db: Db, companyId: string, x: CounterReceiveInput) {
  if (!x.contactId) bad('Choose the supplier to make the bill.', 'err.counterSupplier');
  let po: { id: string; number: string } | null = null;
  if (x.purchaseOrderId) {
    po = (await db.query(`SELECT id, number FROM documents WHERE id = $1 AND company_id = $2 AND type = 'purchase_order' AND status IN ('sent', 'received') AND contact_id = $3
      FOR UPDATE`, [x.purchaseOrderId, companyId, x.contactId])).rows[0] ?? bad('Choose an open purchase order of this supplier.', 'err.counterPo');
  }
  const lines = (x.lines ?? []).filter((l) => l.itemId);
  const note = await quickNote(db, companyId, { type: 'grn', date: x.date, contactId: x.contactId, reference: x.reference,
    lines: lines.map((l) => ({ itemId: l.itemId!, quantity: String(l.quantity ?? ''), unitCost: l.unitCost ?? null })) });
  const info = await items(db, companyId, lines.map((l) => l.itemId!));
  const grni = await accountByCode(db, companyId, SYSTEM_ACCOUNTS.goodsReceived);
  const date = x.date!;
  const billId = await saveDraft(db, companyId, {
    type: 'bill', contactId: x.contactId, issueDate: date, dueDate: addDays(date, await termsDays(db, companyId, x.contactId!)),
    reference: x.reference?.trim() || po?.number || note.number, notes: `Goods received at the counter: ${note.number}${po ? ` (purchase order ${po.number})` : ''}`,
    originalId: po?.id ?? null,
    lines: lines.map((l) => { const it = info.get(l.itemId!)!; return { description: `${it.name} (${it.sku})`, quantity: String(l.quantity).trim(),
      unitPrice: String(l.unitCost ?? '').replace(/,/g, '').trim(), accountId: grni, vatCode: 'standard' as const }; }),
  });
  if (po) await db.query(`UPDATE documents SET status = 'billed' WHERE id = $1`, [po.id]);
  await db.query('INSERT INTO counter_links (stock_note_id, company_id, document_id) VALUES ($1, $2, $3)', [note.id, companyId, billId]);
  return { note, bill: { id: billId } };
}

/** The document a goods note made at the counter, or the goods note a document came from. */
export async function linkFor(db: Db, x: { noteId?: string; documentId?: string }) {
  const r = (await db.query(`SELECT l.stock_note_id AS "noteId", n.number AS "noteNumber", n.type AS "noteType", l.document_id AS "documentId", d.number AS "documentNumber",
      d.type AS "documentType", d.status AS "documentStatus", l.payment_id AS "paymentId"
    FROM counter_links l JOIN stock_notes n ON n.id = l.stock_note_id JOIN documents d ON d.id = l.document_id
    WHERE l.stock_note_id = $1 OR l.document_id = $2`, [x.noteId ?? null, x.documentId ?? null])).rows[0];
  return r ?? null;
}

/** Open purchase orders of a supplier, for goods in at the counter. */
export async function openOrders(db: Db, companyId: string, contactId: string) {
  return (await db.query(`SELECT id, number, issue_date::text AS date, gross_total::text AS total, status FROM documents
    WHERE company_id = $1 AND contact_id = $2 AND type = 'purchase_order' AND status IN ('sent', 'received') ORDER BY issue_date`, [companyId, contactId])).rows;
}
