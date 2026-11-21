// The data behind each brochure company. Everything goes through the application's own services, so every rule the
// real app applies (balanced entries, locked periods, VAT maths, audit log) applies here too.
import type pg from 'pg';
import type { Db } from '../../src/db/session.js';
import { fromMinor, toMinor } from '../../src/money.js';
import * as Bank from '../../src/books/bankService.js';
import * as Inv from '../../src/books/inventoryService.js';
import * as Cal from '../../src/books/calendarService.js';
import { saveContact, setQuotationStatus, saveDraft, issueDocument, createCredit } from '../../src/books/documentsService.js';
import { businessNames, daysAgo, fakeIban, type Ctx, type Pair } from './lib.js';
import type { State } from './seed.js';
import * as Review from '../../src/books/reviewService.js';
import { previousMonthEnd } from '../../src/books/assets.js';
import { ownerEmail } from './seed.js';
import { note, opening, bankStatement, fileDeadlines, type Facts } from './common.js';
import { corniche, najd, zaytoon, rmart, rose, eastern } from './build2.js';


type Fam = { code: string; en: string; ar: string; unit: string; sizes: string[]; price: [number, number] };
// ------------------------------------------------------------------ Gulf Steel Trading
const STEEL: Fam[] = [
  { code: 'IPE', en: 'Steel beam IPE', ar: 'عارضة حديد', unit: 'pcs', sizes: ['100', '120', '140', '160', '180', '200', '220', '240', '270', '300'], price: [310, 1480] },
  { code: 'PLT', en: 'Steel plate', ar: 'صفيحة حديد', unit: 'pcs', sizes: ['3mm', '4mm', '5mm', '6mm', '8mm', '10mm', '12mm', '16mm', '20mm', '25mm'], price: [240, 2150] },
  { code: 'RBR', en: 'Rebar', ar: 'حديد تسليح', unit: 'ton', sizes: ['8mm', '10mm', '12mm', '14mm', '16mm', '18mm', '20mm', '22mm', '25mm', '32mm'], price: [2380, 2710] },
  { code: 'ANG', en: 'Angle iron', ar: 'زاوية حديد', unit: 'pcs', sizes: ['30x30', '40x40', '50x50', '60x60', '70x70', '80x80', '90x90', '100x100', '120x120', '150x150'], price: [38, 215] },
  { code: 'PIP', en: 'Round pipe', ar: 'ماسورة دائرية', unit: 'pcs', sizes: ['1in', '1.5in', '2in', '2.5in', '3in', '4in', '5in', '6in', '8in', '10in'], price: [64, 410] },
  { code: 'CHN', en: 'Steel channel', ar: 'قناة حديد', unit: 'pcs', sizes: ['U60', 'U80', 'U100', 'U120', 'U140', 'U160', 'U180', 'U200', 'U220', 'U240'], price: [120, 690] },
];

export async function gulf(c: Ctx): Promise<Facts> {
  await opening(c, 540000, 18000);
  const buyers = businessNames(c.r, 15, 'buyer');
  const sellers = businessNames(c.r, 8, 'seller');
  const customers: string[] = [];
  for (const [i, n] of buyers.entries()) customers.push(await c.contact('customer', n, 100 + i));
  const suppliers: string[] = [];
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 200 + i, 21));

  // 60 items in one store, with believable prices and stock; a handful end up below their reorder level.
  const items: { id: string; name: string; sku: string; price: number; cost: number; reorder: number; qty: number }[] = [];
  for (const f of STEEL) {
    for (const [i, s] of f.sizes.entries()) {
      const price = Math.round(f.price[0] + ((f.price[1] - f.price[0]) * i) / (f.sizes.length - 1) + c.r() * 9);
      const cost = Math.round(price * (0.7 + c.r() * 0.08) * 100) / 100;
      const qty = Math.max(6, Math.round((4000 + c.r() * 5000) / cost));      // about SAR 4,000 to 9,000 of each item
      const reorder = Math.max(2, Math.round(qty * 0.22));
      const id = await Inv.saveItem(c.db, c.id, { sku: `${f.code}-${s}`.toUpperCase(), name: `${f.en} ${s}`, nameAr: `${f.ar} ${s}`, unit: f.unit, salePrice: price.toFixed(2), reorderLevel: String(reorder) });
      items.push({ id, name: `${f.en} ${s}`, sku: `${f.code}-${s}`, price, cost, reorder, qty });
    }
  }
  await note(c, 'grn', 110, null, items.map((it) => ({ itemId: it.id, quantity: String(it.qty), unitCost: it.cost.toFixed(2) })), 'Opening stock count', '3000');
  for (const [k, ago] of [[0, 62], [1, 38], [2, 15]] as const) {
    const pick = items.filter((_, i) => i % 3 === k);
    for (const it of pick) it.qty += it.reorder * 2;
    await note(c, 'grn', ago, suppliers[k]!, pick.map((it) => ({ itemId: it.id, quantity: String(it.reorder * 2), unitCost: (it.cost * 1.01).toFixed(2) })), `GRN-${4400 + k}`);
  }

  // 40 sales invoices over the last 90 days. Most are paid; ten are overdue; one is part paid.
  const invoices: { id: string; customer: string; ago: number }[] = [];
  for (let n = 0; n < 40; n++) {
    const ago = Math.max(1, 90 - Math.round(n * 2.2) - c.int(0, 2));
    const customer = customers[n % customers.length]!;
    const lines = Array.from({ length: c.int(1, 3) }, () => {
      const it = c.pick(items);
      const qty = it.price > 1000 ? c.int(1, 6) : c.int(4, 40);
      return c.SL(it.name, String(qty), (it.price * (0.97 + c.r() * 0.06)).toFixed(2), 'Head office');
    });
    const id = await c.doc('invoice', customer, ago, 30, lines, { reference: `PO-${4400 + n * 7}` });
    invoices.push({ id, customer, ago });
  }
  let partId = '';
  for (const [n, inv] of invoices.entries()) {
    const overdue = inv.ago > 31 && n % 4 === 1;           // about ten stay unpaid and past their due date
    const recent = inv.ago < 12 && n % 2 === 0;            // some recent ones are not yet due
    if (overdue || recent) continue;
    if (!partId && inv.ago < 40 && inv.ago > 18) {
      const due = await c.due(inv.id);
      const part = (Number(due) * 0.4).toFixed(2);
      await c.pay('received', inv.customer, Math.max(1, inv.ago - 12), part, '1000', [{ documentId: inv.id, amount: part }]);
      partId = inv.id;
      continue;
    }
    await c.payFull('received', inv.customer, inv.id, Math.max(1, inv.ago - c.int(5, 28)), n % 5 === 0 ? '1010' : '1000', n % 5 === 0 ? 'cash' : 'bank_transfer');
  }
  // One credit note against a paid invoice.
  const cn = await createCredit(c.db, invoices[3]!.id);
  const firstLine = (await c.client.query('SELECT description, unit_price::text AS p FROM document_lines WHERE document_id = $1 ORDER BY line_no LIMIT 1', [invoices[3]!.id])).rows[0];
  await saveDraft(c.db, c.id, { contactId: invoices[3]!.customer, issueDate: daysAgo(40), lines: [c.SL(`${firstLine.description} (returned, damaged)`, '2', firstLine.p, 'Head office')] }, cn);
  await issueDocument(c.db, cn);

  // Goods leave the store against invoices; seven items are run down below their reorder level.
  for (const [k, inv] of invoices.slice(8, 20).entries()) {
    const picks = [items[(k * 5) % items.length]!, items[(k * 5 + 2) % items.length]!];
    const lines = picks.filter((it) => it.qty > it.reorder + 6).map((it) => { const q = c.int(3, Math.max(3, Math.floor((it.qty - it.reorder) / 2))); it.qty -= q; return { itemId: it.id, quantity: String(q), costCentreId: c.cc['Head office'] }; });
    if (lines.length) await note(c, 'gdn', Math.max(1, inv.ago - 1), inv.customer, lines, `DN-${5100 + k}`);
  }
  const low = items.filter((_, i) => i % 9 === 4).slice(0, 7);
  await note(c, 'gdn', 2, customers[0]!, low.map((it) => { const q = Math.max(1, it.qty - Math.floor(it.reorder / 2)); it.qty -= q; return { itemId: it.id, quantity: String(q), costCentreId: c.cc['Head office'] }; }), 'DN-5199');

  // 12 purchase orders, then supplier bills (most paid) and a few running costs.
  const poStatus = ['sent', 'sent', 'sent', 'received', 'received', 'sent', 'received', 'sent', 'received', 'sent', 'cancelled', 'received'] as const;
  let po = '';
  for (let n = 0; n < 12; n++) {
    const it = c.pick(items);
    const id = await saveDraft(c.db, c.id, { type: 'purchase_order', contactId: suppliers[n % suppliers.length]!, issueDate: daysAgo(80 - n * 6), reference: `REQ-${300 + n}`,
      lines: [c.SL(`${it.name} (restock)`, String(it.reorder * 3), it.cost.toFixed(2), 'Head office', '5000')] });
    await setQuotationStatus(c.db, id, poStatus[n]!);
    if (n === 4) po = id;
  }
  for (let n = 0; n < 10; n++) {
    const id = await c.doc('bill', suppliers[n % suppliers.length]!, 85 - n * 8, 21, [c.SL('Steel stock purchase', '1', c.money(14000, 58000), undefined, '5000')], { reference: `INV-${7800 + n * 13}` });
    if (n % 3 !== 2) await c.payFull('made', suppliers[n % suppliers.length]!, id, Math.max(1, 85 - n * 8 - c.int(8, 20)));
  }
  for (const [ago, payee, desc, code] of [[40, 'Demo Fuel Station', 'Fuel for delivery trucks', '5400'], [26, 'Demo Office Supplies', 'Printer paper and toner', '5400'], [11, 'Demo Telecom', 'Internet and phone lines', '5300']] as const) {
    const did = await saveDraft(c.db, c.id, { type: 'expense', payee, paidFromAccountId: c.acct['1000'], issueDate: daysAgo(ago), lines: [c.SL(desc, '1', c.money(180, 940), undefined, code)] });
    await issueDocument(c.db, did);
  }
  await c.post(daysAgo(30), 'Warehouse rent', [c.L('5100', '18500.00', undefined, 'Head office'), c.L('1000', undefined, '18500.00')]);
  await c.post(daysAgo(3), 'Electricity', [c.L('5300', '2140.00'), c.L('1000', undefined, '2140.00')]);

  const bankId = await bankStatement(c, 0.5);

  // The customer's own view of an invoice can offer Pay online (sandbox: no money moves).
  await c.client.query(
    `INSERT INTO payment_settings (company_id, enabled, provider, deposit_account_id, enabled_by) VALUES ($1, true, 'sandbox', $2, $3)`, [c.id, c.acct['1000'], c.poster]);
  await fileDeadlines(c);
  // An invoice the customer can still pay online: issued, not yet due, nothing paid.
  const openInv = (await c.client.query(`SELECT id FROM documents d WHERE company_id = $1 AND type = 'invoice' AND status = 'issued' AND due_date >= current_date
    AND document_amount_due(d.id) = gross_total ORDER BY issue_date DESC LIMIT 1`, [c.id])).rows[0].id as string;
  return { bankId, invoiceId: partId || invoices[10]!.id, openInvoiceId: openInv, poId: po };
}

// ------------------------------------------------------------------ the rest (added step by step)
export const BUILDERS: Record<string, (c: Ctx) => Promise<Facts>> = { corniche, najd, gulf, zaytoon, rmart, rose, eastern };

/** Firm-wide steps: older months are locked everywhere, one client's last month is reviewed and signed off, another is mid-review. */
export async function finishFirm(client: pg.Client, state: State, _firmId: string): Promise<void> {
  const db = client as unknown as Db;
  const asUser = (id: string) => client.query("SELECT set_config('app.user_id', $1, true)", [id]);
  const partner = state.users['partner@amal.example']!;
  await asUser(partner);
  for (const id of Object.values(state.companies)) {
    await client.query(`UPDATE periods SET locked_at = now() WHERE company_id = $1 AND locked_at IS NULL AND end_date < date_trunc('month', current_date) - interval '1 month'`, [id]);
  }
  const last = previousMonthEnd(daysAgo(0));
  // Gulf Steel Trading: queries answered and closed, every check ticked, signed off (which locks the month).
  const gulfId = state.companies.gulf;
  if (gulfId) {
    const poster = state.users[ownerEmail('gulf')]!;
    const q = await Review.raiseQuery(db, gulfId, { periodEnd: last, subject: 'Large payment to a new supplier', body: 'We see a first payment to a new steel supplier. Please confirm the purchase order.' });
    await asUser(poster); await Review.reply(db, q, 'Confirmed: PO REQ-304, approved by management.');
    await asUser(partner); await Review.setQueryStatus(db, q, 'closed');
    await Review.runChecks(db, gulfId, last);
    for (const item of (await Review.checklist(db, gulfId, last)).items.filter((i) => !i.done)) await Review.tick(db, gulfId, last, item.item, true, item.auto === false ? 'Checked and agreed' : null);
    await Review.signOff(db, gulfId, last, 'Reviewed. VAT return can be filed.');
  }
  // Corniche Resort: last month is mid-review, with checks run, queries open and about half the checklist ticked.
  const corId = state.companies.corniche;
  if (corId) {
    const reviewer = state.users['reviewer@amal.example']!;
    await asUser(reviewer);
    await Review.runChecks(db, corId, last);
    await Review.raiseQuery(db, corId, { periodEnd: last, subject: 'Laundry supplier invoice missing', body: 'Please attach the tax invoice for the October laundry service.' });
    const q2 = await Review.raiseQuery(db, corId, { periodEnd: last, subject: 'Cash on hand at the front desk', body: 'Can you confirm the cash count at the month end?' });
    await asUser(state.users[ownerEmail('corniche')]!); await Review.reply(db, q2, 'Counted on the last day; it agrees with the books.');
    await asUser(reviewer);
    const items = (await Review.checklist(db, corId, last)).items;
    for (const item of items.slice(0, Math.ceil(items.length / 2))) await Review.tick(db, corId, last, item.item, true, null);
  }
}
void saveContact; void (null as unknown as Db); void (null as unknown as Pair);
