// Sales and purchases: database operations. Every function runs inside withUser(), so row-level
// security and the database rules (db/migrations/0005) apply on top of the checks made here.
import { randomUUID } from 'node:crypto';
import { afterIssue } from './einvoiceService.js';
import type { Db } from '../db/session.js';
import { postEntry, reverseEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import {
  addDays, ageBucket, AGE_BUCKETS, convertLine, convertMinor, documentTotals, foreignCurrency, formatNumber, isCredit,
  numberPrefix, postingFor, postingForPayment, priceLine, rateToScaled, rateToString, roundVatByCategory, sideOf, VAT_CODES, PAYMENT_METHODS,
  type AgeBucket, type Direction, type DocType, type LineInput, type PricedLine,
} from './documents.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function companyInfo(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT id, currency, vat_rate::text AS "vatRate", invoice_prefix AS "invoicePrefix", payment_terms_days AS "paymentTermsDays"
     FROM companies WHERE id = $1`, [companyId]);
  return rows[0] ?? notFound();
}

export async function systemAccounts(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT code, id FROM accounts WHERE company_id = $1', [companyId]);
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const need = (code: string) => byCode.get(code) ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
  return {
    receivables: need(SYSTEM_ACCOUNTS.receivables), payables: need(SYSTEM_ACCOUNTS.payables),
    outputVat: need(SYSTEM_ACCOUNTS.outputVat), inputVat: need(SYSTEM_ACCOUNTS.inputVat),
    claimsPayable: byCode.get(SYSTEM_ACCOUNTS.claimsPayable) as string | undefined,
    // Only a payment in another currency needs it, so it is looked up but not demanded here (0058).
    fxGainLoss: byCode.get(SYSTEM_ACCOUNTS.realisedFx) as string | undefined,
  };
}

/** Next number in a gap-free sequence per company and type (rolled back with the transaction). */
export async function nextNumber(db: Db, companyId: string, seq: string, prefix: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO document_sequences (company_id, type, next_no) VALUES ($1, $2, 2)
     ON CONFLICT (company_id, type) DO UPDATE SET next_no = document_sequences.next_no + 1
     RETURNING next_no - 1 AS n`, [companyId, seq]);
  return formatNumber(prefix, rows[0].n);
}

// ------------------------------------------------------------------ contacts
export interface ContactInput {
  isCustomer?: boolean; isSupplier?: boolean; isEmployee?: boolean; employeeNo?: string; jobTitle?: string; defaultCostCentreId?: string | null;
  name?: string; nameAr?: string; vatNumber?: string; crNumber?: string;
  email?: string; phone?: string; address?: string; city?: string; country?: string; paymentTermsDays?: string | number | null;
  /** Saudi national address (needed on standard e-invoices): 4-digit building number, district, 5-digit postal code. */
  buildingNumber?: string; district?: string; postalCode?: string;
  status?: 'active' | 'archived';
}
const CONTACT_COLS = `c.id, c.is_customer AS "isCustomer", c.is_supplier AS "isSupplier", c.name, c.name_ar AS "nameAr",
  c.vat_number AS "vatNumber", c.cr_number AS "crNumber", c.email, c.phone, c.address, c.city, c.country,
  c.payment_terms_days AS "paymentTermsDays", c.status, c.is_employee AS "isEmployee", c.employee_no AS "employeeNo",
  c.job_title AS "jobTitle", c.default_cost_centre_id AS "defaultCostCentreId", c.building_number AS "buildingNumber", c.district, c.postal_code AS "postalCode"`;

function contactValues(c: ContactInput) {
  const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!t(c.name)) bad('Enter the name.', 'err.contactName');
  if (!c.isCustomer && !c.isSupplier && !c.isEmployee) bad('Choose customer, supplier or both.', 'err.contactRole');
  if (c.isEmployee && (c.isCustomer || c.isSupplier)) bad('An employee cannot also be a customer or supplier.', 'err.employeeOnly');
  const email = t(c.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email address.', 'err.email');
  const terms = c.paymentTermsDays === null || c.paymentTermsDays === undefined || c.paymentTermsDays === '' ? null : Number(c.paymentTermsDays);
  if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) bad('Payment terms are 0 to 365 days.', 'err.terms');
  const country = t(c.country)?.toUpperCase() ?? null;
  const building = t(c.buildingNumber), postal = t(c.postalCode);
  if (building && !/^\d{4}$/.test(building)) bad('The building number has 4 digits.', 'err.buildingNumber');
  if (postal && !/^\d{5}$/.test(postal)) bad('The postal code has 5 digits.', 'err.postalCode');
  return [Boolean(c.isCustomer), Boolean(c.isSupplier), t(c.name), t(c.nameAr), t(c.vatNumber)?.replace(/\s/g, '') ?? null, t(c.crNumber),
    email, t(c.phone), t(c.address), t(c.city), country, terms, c.status === 'archived' ? 'archived' : 'active',
    Boolean(c.isEmployee), c.isEmployee ? t(c.employeeNo) : null, c.isEmployee ? t(c.jobTitle) : null, c.isEmployee ? c.defaultCostCentreId || null : null,
    building, t(c.district), postal];
}

export async function saveContact(db: Db, companyId: string, c: ContactInput, id?: string): Promise<string> {
  const v = contactValues(c);
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE contacts SET is_customer=$2, is_supplier=$3, name=$4, name_ar=$5, vat_number=$6, cr_number=$7, email=$8, phone=$9,
         address=$10, city=$11, country=$12, payment_terms_days=$13, status=$14, is_employee=$15, employee_no=$16, job_title=$17,
         default_cost_centre_id=$18, building_number=$19, district=$20, postal_code=$21 WHERE id = $1 AND company_id = $22`, [id, ...v, companyId]);
    if (!rowCount) notFound();
    return id;
  }
  const { rows } = await db.query(
    `INSERT INTO contacts (company_id, is_customer, is_supplier, name, name_ar, vat_number, cr_number, email, phone, address, city, country,
       payment_terms_days, status, is_employee, employee_no, job_title, default_cost_centre_id, building_number, district, postal_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`, [companyId, ...v]);
  return rows[0].id;
}

/** role 'payee' = anyone money can be paid to: suppliers and employees. */
export async function listContacts(db: Db, companyId: string, role: 'customer' | 'supplier' | 'employee' | 'payee', q = '') {
  const flag = { customer: 'c.is_customer', supplier: 'c.is_supplier', employee: 'c.is_employee', payee: '(c.is_supplier OR c.is_employee)' }[role];
  const types = { customer: `('invoice')`, supplier: `('bill')`, employee: `('claim')`, payee: `('bill', 'claim')` }[role];
  const { rows } = await db.query(
    `SELECT ${CONTACT_COLS},
       coalesce((SELECT sum(document_amount_due(d.id)) FROM documents d
                 WHERE d.contact_id = c.id AND d.type IN ${types} AND d.status = 'issued'), 0)::numeric(18,2)::text AS "balanceDue",
       coalesce((SELECT sum(document_amount_due(d.id)) FROM documents d
                 WHERE d.contact_id = c.id AND d.type IN ${types} AND d.status = 'issued' AND d.due_date < current_date
                   AND document_amount_due(d.id) > 0), 0)::numeric(18,2)::text AS overdue
     FROM contacts c
     WHERE c.company_id = $1 AND ${flag}
       AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR coalesce(c.name_ar, '') ILIKE '%' || $2 || '%' OR coalesce(c.vat_number, '') LIKE $2 || '%')
     ORDER BY c.status, c.name`, [companyId, q.trim()]);
  return rows;
}

export async function getContact(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${CONTACT_COLS}, c.company_id AS "companyId" FROM contacts c WHERE c.id = $1`, [id]);
  return rows[0] ?? notFound();
}

// ------------------------------------------------------------------ documents
export interface DocumentInput {
  type?: DocType; contactId?: string | null; issueDate?: string; dueDate?: string | null; reference?: string | null; notes?: string | null;
  originalId?: string | null; lines?: LineInput[];
  /** Expenses only: who was paid when there is no supplier record, and the bank or cash account it came from. */
  payee?: string | null; paidFromAccountId?: string | null; recurringId?: string | null;
  /** Written in another currency (0058): the three-letter code and how much of the company's currency one unit of
   *  it is worth. Line unit prices are then read in that currency. Empty, or the company's own code, means an
   *  ordinary document and nothing changes. */
  currency?: string | null; fxRate?: string | null;
}

/** The currency a document or payment is written in, or null for the company's own (0058). */
function currencyOf(given: string | null | undefined, companyCurrency: string): string | null {
  try {
    return foreignCurrency(given, companyCurrency);
  } catch {
    return bad('A currency is three letters, such as USD or EUR.', 'err.currencyCode');
  }
}

/** The exchange rate for a document or payment in another currency: required, and more than zero. */
function ratePart(given: string | null | undefined): bigint {
  if (!String(given ?? '').trim()) bad('Enter the exchange rate for this currency.', 'err.fxRate');
  try {
    return rateToScaled(String(given));
  } catch {
    return bad('The exchange rate must be more than 0, with at most 8 decimals.', 'err.fxRate');
  }
}

function priceAll(lines: LineInput[] | undefined, vatRate: string): PricedLine[] {
  return (lines ?? []).map((l, i) => {
    if (!String(l.description ?? '').trim()) bad(`Line ${i + 1}: enter a description.`, 'err.lineDescription');
    if (!l.accountId) bad(`Line ${i + 1}: choose an account.`, 'err.lineAccount');
    if (!VAT_CODES.includes(l.vatCode)) bad(`Line ${i + 1}: choose the VAT treatment.`, 'err.lineVat');
    try {
      return priceLine({ ...l, description: String(l.description).trim() }, vatRate);
    } catch {
      return bad(`Line ${i + 1}: quantity must be more than 0 and the price a number with up to 2 decimals.`, 'err.lineNumbers');
    }
  });
}

/** Creates a draft (no id) or replaces a draft's header and lines. */
export async function saveDraft(db: Db, companyId: string, d: DocumentInput, id?: string): Promise<string> {
  const company = await companyInfo(db, companyId);
  const type = id ? (await db.query('SELECT type FROM documents WHERE id = $1', [id])).rows[0]?.type : d.type;
  const isExpense = type === 'expense';
  if (!d.contactId && !isExpense) bad('Choose the customer or supplier.', 'err.contact');
  if (!d.issueDate || !DATE.test(d.issueDate)) bad('Enter the date.', 'err.date');
  if (d.dueDate && !DATE.test(d.dueDate)) bad('Some values are not in the right format.', 'err.format');
  if (d.dueDate && d.dueDate < d.issueDate!) bad('The due date cannot be before the document date.', 'err.dueDate');
  // Another currency (0058): the prices typed in are in THAT currency, so each line is priced twice — once as it is
  // written on the document, and once converted at the document's rate, which is what posts to the ledger.
  const currency = currencyOf(d.currency, company.currency);
  if (currency && (isExpense || type === 'claim')) {
    bad('An expense or an employee claim is recorded in the company\'s own currency.', 'err.fxNotHere');
  }
  const rateScaled = currency ? ratePart(d.fxRate) : null;
  // Each set of figures is a document in its own right, so each gets ZATCA's rounding: the VAT of a category is
  // worked out on that category's net total, not added up from rounded line amounts (0059).
  const written = roundVatByCategory(priceAll(d.lines, company.vatRate));
  const lines = rateScaled ? roundVatByCategory(written.map((l) => convertLine(l, rateScaled, company.vatRate))) : written;
  const totals = documentTotals(lines);
  const fxTotals = currency ? documentTotals(written) : null;
  const head = [d.contactId || null, d.issueDate, isExpense ? null : d.dueDate || null, d.reference?.trim() || null, d.notes?.trim() || null,
    fromMinor(totals.net), fromMinor(totals.vat), fromMinor(totals.gross),
    isExpense ? d.payee?.trim() || null : null, isExpense ? d.paidFromAccountId || null : null,
    currency, rateScaled ? rateToString(rateScaled) : null,
    fxTotals ? fromMinor(fxTotals.net) : null, fxTotals ? fromMinor(fxTotals.vat) : null, fxTotals ? fromMinor(fxTotals.gross) : null];
  let docId = id;
  if (docId) {
    const { rowCount } = await db.query(
      `UPDATE documents SET contact_id=$2, issue_date=$3, due_date=$4, reference=$5, notes=$6, net_total=$7, vat_total=$8, gross_total=$9,
         payee=$10, paid_from_account_id=$11, currency=$12, fx_rate=$13, fx_net_total=$14, fx_vat_total=$15, fx_gross_total=$16
       WHERE id = $1 AND company_id = $17 AND status = 'draft'`, [docId, ...head, companyId]);
    if (!rowCount) bad('Only drafts can be changed.', 'err.notDraft');
    await db.query('DELETE FROM document_lines WHERE document_id = $1', [docId]);
  } else {
    if (!d.type || !['quotation', 'invoice', 'credit_note', 'debit_note', 'bill', 'supplier_credit', 'expense', 'claim', 'purchase_order'].includes(d.type)) bad('Choose the document type.', 'err.format');
    const { rows } = await db.query(
      `INSERT INTO documents (company_id, type, contact_id, issue_date, due_date, reference, notes, net_total, vat_total, gross_total,
         payee, paid_from_account_id, currency, fx_rate, fx_net_total, fx_vat_total, fx_gross_total, original_id, recurring_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, app_user_id()) RETURNING id`,
      [companyId, d.type, ...head, d.originalId || null, isExpense ? d.recurringId || null : null]);
    docId = rows[0].id as string;
  }
  let n = 1;
  for (const [i, l] of lines.entries()) {
    const w = currency ? written[i]! : null;
    await db.query(
      `INSERT INTO document_lines (document_id, line_no, description, quantity, unit_price, account_id, cost_centre_id, vat_code, vat_rate,
         net_amount, vat_amount, fx_unit_price, fx_net_amount, fx_vat_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [docId, n++, l.description, l.quantity, l.unitPrice, l.accountId, l.costCentreId || null, l.vatCode, l.vatRate, fromMinor(l.net), fromMinor(l.vat),
       w ? w.unitPrice : null, w ? fromMinor(w.net) : null, w ? fromMinor(w.vat) : null]);
  }
  return docId!;
}

async function lockDoc(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT d.*, d.issue_date::text AS issue_day, coalesce(c.name, d.payee) AS contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = $1 FOR UPDATE OF d`, [id]);
  return rows[0] ?? notFound();
}

async function storedLines(db: Db, docId: string): Promise<PricedLine[]> {
  const { rows } = await db.query(
    `SELECT description, quantity::text, unit_price::text AS "unitPrice", account_id AS "accountId", cost_centre_id AS "costCentreId",
            vat_code AS "vatCode", vat_rate::text AS "vatRate", net_amount::text AS net, vat_amount::text AS vat
     FROM document_lines WHERE document_id = $1 ORDER BY line_no`, [docId]);
  return rows.map((r) => ({ ...r, net: toMinor(r.net), vat: toMinor(r.vat) }));
}

/**
 * Brings a draft's VAT up to ZATCA's rounding rule before it is issued (0059).
 *
 * A draft saved by an earlier version has each line's VAT rounded on its own, which the rule forbids and which the
 * database now refuses at issue. Rather than fail with a puzzling message on a draft the person did nothing wrong
 * with, the lines are corrected here: the category totals are unchanged in net terms, only the halalas move. A
 * draft already saved under the rule is left exactly as it is.
 */
async function fixVatRounding(db: Db, docId: string, lines: PricedLine[]): Promise<PricedLine[]> {
  const fixed = roundVatByCategory(lines);
  const changed = fixed.some((l, i) => l.vat !== lines[i]!.vat);
  const fx = (await db.query(
    `SELECT l.line_no AS "lineNo", l.fx_net_amount::text AS net, l.fx_vat_amount::text AS vat, l.vat_code AS "vatCode", l.vat_rate::text AS "vatRate"
     FROM document_lines l WHERE l.document_id = $1 AND l.fx_net_amount IS NOT NULL ORDER BY l.line_no`, [docId])).rows;
  const fxFixed = fx.length
    ? roundVatByCategory(fx.map((r) => ({ description: '', quantity: '1', unitPrice: '0', accountId: '', vatCode: r.vatCode, vatRate: r.vatRate, net: toMinor(r.net), vat: toMinor(r.vat) })))
    : [];
  const fxChanged = fxFixed.some((l, i) => l.vat !== toMinor(fx[i]!.vat));
  if (!changed && !fxChanged) return lines;
  let n = 1;
  for (const [i, l] of fixed.entries()) {
    await db.query('UPDATE document_lines SET vat_amount = $2, fx_vat_amount = coalesce($3, fx_vat_amount) WHERE document_id = $1 AND line_no = $4',
      [docId, fromMinor(l.vat), fxFixed[i] ? fromMinor(fxFixed[i]!.vat) : null, n++]);
  }
  const t = documentTotals(fixed);
  const ft = fxFixed.length ? documentTotals(fxFixed) : null;
  await db.query(
    `UPDATE documents SET vat_total = $2, gross_total = $3, fx_vat_total = coalesce($4, fx_vat_total), fx_gross_total = coalesce($5, fx_gross_total)
     WHERE id = $1`,
    [docId, fromMinor(t.vat), fromMinor(t.gross), ft ? fromMinor(ft.vat) : null, ft ? fromMinor(ft.gross) : null]);
  return fixed;
}

/** Gives the document its number, posts its journal entry and marks it issued. Never changes afterwards. */
/** Advances deducted on a final invoice (0046): Dr 2160 Customer advances (net) / Dr Output VAT (the advance's VAT) /
 *  Cr Receivables (prepaid amount), in the invoice's own entry. Nothing for other documents. */
async function advancePosting(db: Db, companyId: string, documentId: string) {
  const x = (await db.query(`SELECT coalesce(sum(net_amount), 0)::text AS net, coalesce(sum(vat_amount), 0)::text AS vat FROM advance_deductions WHERE document_id = $1`, [documentId])).rows[0];
  if (toMinor(x.net) === 0n) return [];
  const sys = await systemAccounts(db, companyId);
  const adv = (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '2160'`, [companyId])).rows[0]?.id
    ?? bad("This client's chart of accounts has no account 2160 Customer advances.", 'err.chart');
  const out = [{ accountId: adv as string, debit: x.net as string }];
  if (toMinor(x.vat) > 0n) out.push({ accountId: sys.outputVat, debit: x.vat });
  return [...out, { accountId: sys.receivables, credit: fromMinor(toMinor(x.net) + toMinor(x.vat)) }];
}

export async function issueDocument(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.status !== 'draft') bad('This document has already been issued.', 'err.alreadyIssued');
  if (d.type === 'quotation') bad('Quotations are sent, not issued.', 'err.format');
  if (d.type === 'purchase_order') bad('Purchase orders are sent, not issued.', 'err.format');
  if (d.type === 'claim') bad('Claims are submitted and approved, not issued.', 'err.format');
  let lines = await storedLines(db, id);
  if (!lines.length) bad('Add at least one line.', 'err.noLines');
  lines = await fixVatRounding(db, id, lines);
  if (d.type === 'expense' && !d.paid_from_account_id) bad('Choose the bank or cash account the expense was paid from.', 'err.bankAccount');
  if (d.type === 'expense' && !d.contact_id && !String(d.payee ?? '').trim()) bad('Enter who was paid (a supplier or a payee name).', 'err.payee');
  const company = await companyInfo(db, d.company_id);
  const number = await nextNumber(db, d.company_id, d.type, numberPrefix(d.type, company.invoicePrefix));
  const entryId = await postEntry(db, {
    companyId: d.company_id, entryDate: d.issue_day,
    memo: `${number} · ${d.contact_name}`, sourceType: d.type, sourceId: d.id,
    lines: [...postingFor(d.type, lines, await systemAccounts(db, d.company_id), d.paid_from_account_id ?? undefined), ...(await advancePosting(db, d.company_id, id))],
  });
  await db.query(`UPDATE documents SET status = 'issued', number = $2, journal_entry_id = $3 WHERE id = $1`, [id, number, entryId]);
  await afterIssue(db, id);   // e-invoicing (ZATCA, PINT AE) when the company has it on
}

export async function setQuotationStatus(db: Db, id: string, status: 'sent' | 'accepted' | 'declined' | 'received' | 'cancelled'): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'quotation' && d.type !== 'purchase_order') bad('Only quotations and purchase orders have this status.', 'err.format');
  const allowed = d.type === 'quotation' ? ['sent', 'accepted', 'declined'] : ['sent', 'received', 'cancelled'];
  if (!allowed.includes(status)) bad('Choose a status.', 'err.format');
  let number = d.number;
  if (!number && status !== 'cancelled') {
    const company = await companyInfo(db, d.company_id);
    number = await nextNumber(db, d.company_id, d.type, numberPrefix(d.type, company.invoicePrefix));
    await db.query(`UPDATE documents SET status = $2, number = $3 WHERE id = $1`, [id, status, number]);
    return;
  }
  await db.query(`UPDATE documents SET status = $2 WHERE id = $1`, [id, status]);
}

/** Quotation -> new draft invoice with the same lines. */
export async function convertQuotation(db: Db, id: string): Promise<string> {
  const q = await lockDoc(db, id);
  if (q.type !== 'quotation' || !['sent', 'accepted'].includes(q.status)) bad('Send or accept the quotation first.', 'err.quoteNotSent');
  const company = await companyInfo(db, q.company_id);
  const terms = (await getContact(db, q.contact_id)).paymentTermsDays ?? company.paymentTermsDays;
  const lines = (await storedLines(db, id)).map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) =>
    ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
  const newId = await saveDraft(db, q.company_id, {
    type: 'invoice', contactId: q.contact_id, issueDate: today(), dueDate: addDays(today(), terms), reference: q.number, notes: q.notes,
    originalId: q.id, lines,
  });
  await db.query(`UPDATE documents SET status = 'invoiced' WHERE id = $1`, [id]);
  return newId;
}

/** Purchase order -> new draft bill with the same lines (the bill points back to the order). */
export async function convertPurchaseOrder(db: Db, id: string): Promise<string> {
  const o = await lockDoc(db, id);
  if (o.type !== 'purchase_order' || !['sent', 'received'].includes(o.status)) bad('Send the purchase order first.', 'err.poNotSent');
  const company = await companyInfo(db, o.company_id);
  const terms = (await getContact(db, o.contact_id)).paymentTermsDays ?? company.paymentTermsDays;
  const lines = (await storedLines(db, id)).map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) =>
    ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
  const newId = await saveDraft(db, o.company_id, {
    type: 'bill', contactId: o.contact_id, issueDate: today(), dueDate: addDays(today(), terms), reference: o.number, notes: o.notes, originalId: o.id, lines,
  });
  await db.query(`UPDATE documents SET status = 'billed' WHERE id = $1`, [id]);
  return newId;
}

/** Issued invoice -> new draft debit note (an extra charge on it), with one line to fill in. */
export async function createDebit(db: Db, id: string): Promise<string> {
  const o = await lockDoc(db, id);
  if (o.type !== 'invoice' || o.status !== 'issued') bad('Only issued invoices get a debit note.', 'err.notIssued');
  const first = (await storedLines(db, id))[0]!;
  const due = (await db.query('SELECT due_date::text AS d FROM documents WHERE id = $1', [id])).rows[0].d as string | null;
  return saveDraft(db, o.company_id, {
    type: 'debit_note', contactId: o.contact_id, issueDate: today(), dueDate: due && due >= today() ? due : null, reference: o.number, originalId: o.id,
    lines: [{ description: `Additional charge on ${o.number}`, quantity: '1', unitPrice: '0', accountId: first.accountId, costCentreId: first.costCentreId, vatCode: first.vatCode }],
  });
}

/** Issued invoice (or bill) -> new draft credit note with the same lines, to be reduced as needed. */
export async function createCredit(db: Db, id: string): Promise<string> {
  const o = await lockDoc(db, id);
  if (!['invoice', 'bill'].includes(o.type) || o.status !== 'issued') bad('Only issued invoices and bills can be credited.', 'err.notIssued');
  const lines = (await storedLines(db, id)).map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) =>
    ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
  return saveDraft(db, o.company_id, {
    type: o.type === 'invoice' ? 'credit_note' : 'supplier_credit', contactId: o.contact_id, issueDate: today(), dueDate: null,
    reference: o.number, originalId: o.id, lines,
  });
}

export async function deleteDraft(db: Db, id: string): Promise<void> {
  const { rowCount } = await db.query(`DELETE FROM documents WHERE id = $1 AND status = 'draft'`, [id]);
  if (!rowCount) bad('Only drafts can be deleted.', 'err.notDraft');
}

const DOC_COLS = `d.id, d.company_id AS "companyId", d.type, d.status, d.number,
  (SELECT CASE WHEN e.kind = 'standard' AND e.status = 'pending' THEN 'not_cleared' WHEN e.status = 'rejected' THEN 'rejected' END FROM einvoices e
    WHERE e.document_id = d.id AND e.scheme = 'zatca' ORDER BY e.created_at DESC LIMIT 1) AS "einvoiceFlag", d.is_advance AS "isAdvance", d.contact_id AS "contactId", coalesce(c.name, d.payee) AS "contactName",
  c.name_ar AS "contactNameAr", d.payee, d.paid_from_account_id AS "paidFromAccountId", pa.name AS "paidFromName", pa.name_ar AS "paidFromNameAr",
  d.recurring_id AS "recurringId", d.voided_at AS "voidedAt", d.submitted_by AS "submittedBy", d.submitted_at AS "submittedAt",
  d.decided_by AS "decidedBy", d.decided_at AS "decidedAt", d.rejection_reason AS "rejectionReason",
  person_name(d.submitted_by) AS "submittedByName", person_name(d.decided_by) AS "decidedByName", d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate", d.reference, d.notes,
  d.original_id AS "originalId", d.journal_entry_id AS "journalEntryId",
  d.net_total::text AS "netTotal", d.vat_total::text AS "vatTotal", d.gross_total::text AS "grossTotal",
  d.currency, d.fx_rate::text AS "fxRate", d.fx_net_total::text AS "fxNetTotal", d.fx_vat_total::text AS "fxVatTotal",
  d.fx_gross_total::text AS "fxGrossTotal", document_fx_due(d.id)::numeric(18,2)::text AS "fxAmountDue",
  document_amount_due(d.id)::numeric(18,2)::text AS "amountDue", d.created_at AS "createdAt", d.issued_at AS "issuedAt"`;

export async function listDocuments(db: Db, companyId: string, type: DocType, f: { status?: string; q?: string; contactId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${DOC_COLS} FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id
     WHERE d.company_id = $1 AND d.type = $2
       AND ($3 = '' OR coalesce(c.name, d.payee, '') ILIKE '%' || $3 || '%' OR coalesce(d.number, '') ILIKE '%' || $3 || '%' OR coalesce(d.reference, '') ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR d.contact_id = $4)
     ORDER BY (d.status = 'draft') DESC, d.issue_date DESC, d.created_at DESC LIMIT 500`,
    [companyId, type, (f.q ?? '').trim(), f.contactId || null]);
  const t = today();
  return rows.map((r) => ({ ...r, state: stateOf(r, t) })).filter((r) => !f.status || f.status === 'all' || r.state === f.status
    || (f.status === 'unpaid' && ['unpaid', 'partly_paid', 'overdue'].includes(r.state)));
}

/** draft | issued | paid | partly_paid | unpaid | overdue | credit, or a quotation's own status */
function stateOf(r: { type: DocType; status: string; amountDue: string; grossTotal: string; dueDate: string | null }, t: string): string {
  if (r.type === 'quotation' || r.type === 'purchase_order' || r.type === 'expense' || r.status === 'draft' || isCredit(r.type)) return r.status;
  if (r.type === 'claim') return r.status !== 'issued' ? r.status : toMinor(r.amountDue) > 0n ? 'approved' : 'reimbursed';
  const due = toMinor(r.amountDue);
  if (due < 0n) return 'credit';
  if (due === 0n) return 'paid';
  if (r.dueDate && r.dueDate < t) return 'overdue';
  return due < toMinor(r.grossTotal) ? 'partly_paid' : 'unpaid';
}

export async function getDocument(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${DOC_COLS} FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id WHERE d.id = $1`, [id]);
  const d = rows[0] ?? notFound();
  const lines = await db.query(
    `SELECT l.id, l.line_no AS "lineNo", l.description, l.quantity::text, l.unit_price::text AS "unitPrice", l.account_id AS "accountId",
            a.code AS "accountCode", a.name AS "accountName", a.name_ar AS "accountNameAr", l.cost_centre_id AS "costCentreId",
            cc.name AS "costCentre", cc.name_ar AS "costCentreAr", l.vat_code AS "vatCode", l.vat_rate::text AS "vatRate",
            l.net_amount::text AS net, l.vat_amount::text AS vat, l.fx_unit_price::text AS "fxUnitPrice",
            l.fx_net_amount::text AS "fxNet", l.fx_vat_amount::text AS "fxVat"
     FROM document_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
     WHERE l.document_id = $1 ORDER BY l.line_no`, [id]);
  const payments = await db.query(
    `SELECT p.id, p.number, p.payment_date::text AS date, a.amount::text, a.fx_amount::text AS "fxAmount", p.currency,
            p.method, p.voided_at AS "voidedAt"
     FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = $1 ORDER BY p.payment_date`, [id]);
  const related = await db.query(
    `SELECT d.id, d.type, d.status, d.number, d.issue_date::text AS "issueDate", d.gross_total::text AS "grossTotal"
     FROM documents d WHERE (d.original_id = $1 OR d.id = $2) AND d.id <> $1 ORDER BY d.created_at`, [id, d.originalId]);
  const contact = d.contactId ? await getContact(db, d.contactId) : null;
  const seller = await db.query(
    `SELECT c.name, c.name_ar AS "nameAr", c.vat_number AS "vatNumber", c.cr_number AS "crNumber", c.address, c.city, c.country, c.currency,
            c.phone, c.email, b.bank_name AS "bankName", b.iban, (SELECT o.number FROM documents o WHERE o.id = $2) AS "originalNumber"
     FROM companies c LEFT JOIN LATERAL (SELECT bank_name, iban FROM bank_accounts WHERE company_id = c.id AND kind = 'bank' AND status = 'active' AND iban IS NOT NULL
                                         ORDER BY created_at LIMIT 1) b ON true
     WHERE c.id = $1`, [d.companyId, d.originalId]);
  const counter = (await db.query(`SELECT n.id, n.type, n.number FROM counter_links k JOIN stock_notes n ON n.id = k.stock_note_id WHERE k.document_id = $1`, [id])).rows[0] ?? null;
  // Advances deducted on this invoice (0046): each advance invoice and the amount (with VAT) taken off.
  const advances = (await db.query(`SELECT x.advance_id AS "advanceId", a.number, a.issue_date::text AS "issueDate", (x.net_amount + x.vat_amount)::text AS total
    FROM advance_deductions x JOIN documents a ON a.id = x.advance_id WHERE x.document_id = $1 ORDER BY a.issue_date, a.number`, [id])).rows;
  return { ...d, state: stateOf(d, today()), lines: lines.rows, payments: payments.rows, related: related.rows, contact, seller: seller.rows[0], counter, advances };
}

// ------------------------------------------------------------------ employee claims
/** Sends a draft claim for approval; it gets its number now and can no longer be edited. */
export async function submitClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim') bad('Only claims are submitted for approval.', 'err.format');
  if (d.status !== 'draft') bad('Only draft claims can be submitted.', 'err.notDraft');
  if (!(await storedLines(db, id)).length) bad('Add at least one line.', 'err.noLines');
  const number = d.number ?? await nextNumber(db, d.company_id, 'claim', numberPrefix('claim', ''));
  await db.query(`UPDATE documents SET status = 'submitted', number = $2 WHERE id = $1`, [id, number]);
}

/** Back to draft: a submitted claim withdrawn, or a rejected one to be corrected. */
export async function reopenClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || !['submitted', 'rejected'].includes(d.status)) bad('Only submitted or rejected claims go back to draft.', 'err.format');
  await db.query(`UPDATE documents SET status = 'draft' WHERE id = $1`, [id]);
}

/** Approves a submitted claim and posts it: Dr expenses, Dr input VAT, Cr employee claims payable. */
export async function approveClaim(db: Db, id: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || d.status !== 'submitted') bad('Only submitted claims can be approved.', 'err.claimNotSubmitted');
  const sys = await systemAccounts(db, d.company_id);
  if (!sys.claimsPayable) bad('This client\'s chart of accounts has no employee claims payable account (2200).', 'err.chart');
  const entryId = await postEntry(db, {
    companyId: d.company_id, entryDate: d.issue_day, memo: `${d.number} · ${d.contact_name}`, sourceType: 'claim', sourceId: d.id,
    lines: postingFor('claim', await storedLines(db, id), sys),
  });
  await db.query(`UPDATE documents SET status = 'issued', journal_entry_id = $2 WHERE id = $1`, [id, entryId]);
}

export async function rejectClaim(db: Db, id: string, reason: string): Promise<void> {
  const d = await lockDoc(db, id);
  if (d.type !== 'claim' || d.status !== 'submitted') bad('Only submitted claims can be rejected.', 'err.claimNotSubmitted');
  if (!reason.trim()) bad('Give a reason for rejecting the claim.', 'err.rejectReason');
  await db.query(`UPDATE documents SET status = 'rejected', rejection_reason = $2 WHERE id = $1`, [id, reason.trim().slice(0, 500)]);
}

// ------------------------------------------------------------------ payments
export interface PaymentInput {
  direction?: Direction; contactId?: string; date?: string; amount?: string; accountId?: string; method?: string; reference?: string;
  allocations?: { documentId: string; amount: string }[];
  /** A supplier payment approved beforehand (approvals, 0026): the request it carries out. */
  approvalRequestId?: string;
  /** Money going back the other way (0055): paid out to a customer, or received back from a supplier. */
  refund?: boolean;
  /** Made in another currency (0058). `amount` and every allocation amount are then read in THAT currency; what
   *  reaches the bank is worked out from the rate. */
  currency?: string | null; fxRate?: string | null;
}

export async function recordPayment(db: Db, companyId: string, p: PaymentInput): Promise<string> {
  const direction = p.direction === 'made' ? 'made' : p.direction === 'received' ? 'received' : bad('Choose received or paid.', 'err.format');
  if (!p.contactId) bad('Choose the customer or supplier.', 'err.contact');
  if (!p.date || !DATE.test(p.date)) bad('Enter the date.', 'err.date');
  if (!p.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const method = PAYMENT_METHODS.includes(p.method as never) ? p.method! : 'bank_transfer';
  let amount: bigint;
  let allocs: { documentId: string; amount: bigint }[];
  try {
    amount = toMinor(String(p.amount ?? '').replace(/,/g, ''));
    allocs = (p.allocations ?? []).filter((a) => a.amount && String(a.amount).trim() !== '' && String(a.amount).trim() !== '0')
      .map((a) => ({ documentId: a.documentId, amount: toMinor(String(a.amount).replace(/,/g, '')) }));
  } catch {
    return bad('Amounts must be numbers with at most 2 decimals.', 'err.amountFormat');
  }
  if (amount <= 0n) bad('Enter the amount.', 'err.amount');
  if (allocs.some((a) => a.amount <= 0n)) bad('Amounts must be more than 0.', 'err.amount');
  if (allocs.reduce((s, a) => s + a.amount, 0n) > amount) bad('The amounts settled are more than the payment.', 'err.overAllocated');

  const refund = Boolean(p.refund);
  // A refund reverses the side: money paid out to a customer is the sales side, money received back from a supplier
  // the purchases side. The side picks the control account; the direction still picks the bank entry and the number.
  const side: 'sales' | 'purchases' = (direction === 'received') !== refund ? 'sales' : 'purchases';
  const sys = await systemAccounts(db, companyId);

  // Another currency (0058): the amount and the allocations above are in the payment's currency. What reaches the
  // bank is that amount at the payment's rate; what the control account gives up is each document's share at the
  // rate THAT DOCUMENT was booked at. The gap between the two is the realised exchange gain or loss.
  const company = await companyInfo(db, companyId);
  const currency = currencyOf(p.currency, company.currency);
  let cash = amount;
  let fx: { settled: bigint; accountId: string } | undefined;
  let fxAmount: bigint | null = null;
  let payRate: bigint | null = null;
  const settledOf = new Map<string, bigint>();
  if (currency) {
    payRate = ratePart(p.fxRate);
    fxAmount = amount;
    cash = convertMinor(fxAmount, payRate);
    if (cash <= 0n) bad('Enter the amount.', 'err.amount');
    if (allocs.reduce((s, a) => s + a.amount, 0n) !== fxAmount) {
      bad(`A payment in ${currency} is settled in full against the invoices it pays, so the exchange difference can be worked out.`, 'err.fxAllocateAll');
    }
    if (!sys.fxGainLoss) {
      bad("This client's chart of accounts has no account 4951 Realised exchange gains and losses.", 'err.chart');
    }
    let settled = 0n;
    for (const a of allocs) {
      const r = (await db.query(
        `SELECT d.currency, d.fx_rate::text AS "fxRate", document_fx_due(d.id)::numeric(18,2)::text AS "fxDue",
                document_amount_due(d.id)::numeric(18,2)::text AS "due" FROM documents d WHERE d.id = $1`, [a.documentId])).rows[0] ?? notFound();
      if (r.currency !== currency) {
        bad(`This payment is in ${currency}: settle it against invoices written in the same currency.`, 'err.fxMismatch');
      }
      const fxDue = toMinor(r.fxDue);
      const due = toMinor(r.due);
      // Settling the last of what is owed hands over exactly what is left in the company's currency, so the
      // document closes to zero on both sides with no rounding left behind.
      const owed = refund ? -fxDue : fxDue;
      const mine = refund ? (a.amount === owed ? -due : -convertMinor(a.amount, rateToScaled(r.fxRate)))
                          : (a.amount === owed ? due : convertMinor(a.amount, rateToScaled(r.fxRate)));
      settledOf.set(a.documentId, mine);
      settled += mine;
    }
    fx = { settled, accountId: sys.fxGainLoss! };
  }

  const id = randomUUID();
  const number = await nextNumber(db, companyId, direction === 'received' ? 'receipt' : 'payment', numberPrefix(direction === 'received' ? 'receipt' : 'payment', ''));
  const contact = await getContact(db, p.contactId!);
  const entryId = await postEntry(db, {
    companyId, entryDate: p.date!, memo: `${number} · ${contact.name}`, sourceType: direction === 'received' ? 'payment_received' : 'payment_made', sourceId: id,
    lines: postingForPayment(direction, cash, p.accountId!, sys, !refund && Boolean(contact.isEmployee), side, fx),
  });
  await db.query(
    `INSERT INTO payments (id, company_id, direction, number, contact_id, payment_date, amount, account_id, method, reference, journal_entry_id, created_by, approval_request_id, is_refund, currency, fx_rate, fx_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_user_id(), $12, $13, $14, $15, $16)`,
    [id, companyId, direction, number, p.contactId, p.date, fromMinor(cash), p.accountId, method, p.reference?.trim() || null, entryId, p.approvalRequestId || null, refund,
     currency, payRate ? rateToString(payRate) : null, fxAmount === null ? null : fromMinor(fxAmount)]);
  for (const a of allocs) {
    const mine = settledOf.get(a.documentId);
    await db.query('INSERT INTO payment_allocations (payment_id, document_id, amount, fx_amount) VALUES ($1, $2, $3, $4)',
      [id, a.documentId, fromMinor(mine === undefined ? a.amount : mine), currency ? fromMinor(a.amount) : null]);
  }
  return id;
}

/** Voids a payment: posts the reversal and frees the documents it settled. */
export async function voidPayment(db: Db, id: string, date: string): Promise<void> {
  const { rows } = await db.query('SELECT journal_entry_id, voided_at FROM payments WHERE id = $1 FOR UPDATE', [id]);
  const p = rows[0] ?? notFound();
  if (p.voided_at) bad('This payment has already been voided.', 'err.alreadyVoided');
  const rev = await reverseEntry(db, p.journal_entry_id, date, 'Void payment');
  await db.query('UPDATE payments SET voided_at = now(), void_entry_id = $2 WHERE id = $1', [id, rev]);
}

const PAY_COLS = `p.id, p.direction, p.number, p.contact_id AS "contactId", c.name AS "contactName", p.payment_date::text AS date,
  p.amount::text, p.account_id AS "accountId", a.name AS "accountName", a.name_ar AS "accountNameAr", p.method, p.reference,
  p.voided_at AS "voidedAt", p.created_at AS "createdAt", p.is_refund AS "isRefund",
  p.currency, p.fx_rate::text AS "fxRate", p.fx_amount::text AS "fxAmount",
  (p.amount - coalesce((SELECT sum(x.amount) FROM payment_allocations x WHERE x.payment_id = p.id), 0))::numeric(18,2)::text AS unallocated`;

/** Payments of one LEDGER SIDE, named by its ordinary direction: 'received' lists receipts from customers together
 *  with refunds paid back to them, 'made' lists supplier payments together with money refunded back by suppliers.
 *  A customer refund belongs with the sales ledger, which is where an accountant looks for it. */
export async function listPayments(db: Db, companyId: string, direction: Direction, f: { q?: string; contactId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${PAY_COLS} FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id
     WHERE p.company_id = $1 AND ((p.direction = $2) <> p.is_refund)
       AND ($3 = '' OR c.name ILIKE '%' || $3 || '%' OR p.number ILIKE '%' || $3 || '%' OR coalesce(p.reference, '') ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR p.contact_id = $4)
     ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 500`, [companyId, direction, (f.q ?? '').trim(), f.contactId || null]);
  return rows;
}

export async function getPayment(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${PAY_COLS}, p.company_id AS "companyId" FROM payments p JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`, [id]);
  const p = rows[0] ?? notFound();
  const allocations = await db.query(
    `SELECT d.id AS "documentId", d.number, d.type, d.issue_date::text AS "issueDate", d.gross_total::text AS "grossTotal",
            d.currency, d.fx_gross_total::text AS "fxGrossTotal", x.amount::text, x.fx_amount::text AS "fxAmount"
     FROM payment_allocations x JOIN documents d ON d.id = x.document_id WHERE x.payment_id = $1 ORDER BY d.issue_date`, [id]);
  return { ...p, allocations: allocations.rows };
}

/** Issued invoices (or bills) of a contact that still have something due, oldest due first. */
export async function openDocuments(db: Db, companyId: string, contactId: string, direction: Direction) {
  const { rows } = await db.query(
    `SELECT d.id, d.number, d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate", d.gross_total::text AS "grossTotal",
            d.currency, d.fx_rate::text AS "fxRate", d.fx_gross_total::text AS "fxGrossTotal",
            document_fx_due(d.id)::numeric(18,2)::text AS "fxAmountDue",
            document_amount_due(d.id)::numeric(18,2)::text AS "amountDue"
     FROM documents d WHERE d.company_id = $1 AND d.contact_id = $2 AND d.type = $3 AND d.status = 'issued'
       AND document_amount_due(d.id) > 0
     ORDER BY coalesce(d.due_date, d.issue_date), d.issue_date`, [companyId, contactId, direction === 'received' ? 'invoice' : (await getContact(db, contactId)).isEmployee ? 'claim' : 'bill']);
  return rows;
}

// ------------------------------------------------------------------ opening balances as open documents (0056)
export interface OpeningDocInput {
  type: 'invoice' | 'bill';
  contactId: string;
  /** The number the document had in the client's previous system: it is kept, not replaced. */
  number: string;
  issueDate: string;
  dueDate?: string;
  /** What is still owed on it today, the whole amount including whatever VAT the old system charged. */
  amount: string;
}

/** Brings one already-open invoice or bill in from the client's previous system.
 *
 *  It is NOT a new sale or purchase: the revenue, the cost and the VAT belong to the old system and were declared
 *  there. The whole amount is posted against 3000 Opening balances, so nothing lands in income, expense or VAT,
 *  and the document is never sent to e-invoicing. After that it behaves like any issued document: it ages, it
 *  appears on statements, and payments settle it. */
export async function addOpeningDocument(db: Db, companyId: string, o: OpeningDocInput): Promise<string> {
  const type = o.type === 'invoice' || o.type === 'bill' ? o.type : bad('Choose an invoice or a bill.', 'err.format');
  const number = String(o.number ?? '').trim();
  if (!number) bad('Enter the number this invoice had in the old system.', 'err.openingNumber');
  if (number.length > 60) bad('That number is too long.', 'err.format');
  let amount: bigint;
  try { amount = toMinor(String(o.amount ?? '').replace(/,/g, '')); } catch { return bad('The amount must be a number with at most 2 decimals.', 'err.amountFormat'); }
  if (amount <= 0n) bad('Enter the amount still owed.', 'err.amount');
  if (!o.issueDate || !DATE.test(o.issueDate)) bad('Enter the date.', 'err.date');
  if (o.dueDate && !DATE.test(o.dueDate)) bad('Some values are not in the right format.', 'err.format');
  if (o.dueDate && o.dueDate < o.issueDate) bad('The due date cannot be before the document date.', 'err.dueDate');
  if ((await db.query('SELECT 1 FROM documents WHERE company_id = $1 AND type = $2 AND number = $3', [companyId, type, number])).rows[0]) {
    bad(`${number} is already in the books.`, 'err.openingNumberTaken');
  }
  const equity = (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '3000'`, [companyId])).rows[0]
    ?? bad('This client has no opening balances account (3000).', 'err.chart');

  const { rows } = await db.query(
    `INSERT INTO documents (company_id, type, contact_id, issue_date, due_date, net_total, vat_total, gross_total, is_opening, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, '0.00', $6, true, app_user_id()) RETURNING id`,
    [companyId, type, o.contactId || null, o.issueDate, o.dueDate || null, fromMinor(amount)]);
  const id = rows[0].id as string;
  await db.query(
    `INSERT INTO document_lines (document_id, line_no, description, quantity, unit_price, account_id, vat_code, vat_rate, net_amount, vat_amount)
     VALUES ($1, 1, $2, '1', $3, $4, 'out_of_scope', 0, $3, '0.00')`,
    [id, `Opening balance · ${number}`, fromMinor(amount), equity.id]);

  const contact = await getContact(db, o.contactId);
  const entryId = await postEntry(db, {
    companyId, entryDate: o.issueDate, memo: `${number} · ${contact.name}`, sourceType: type, sourceId: id,
    lines: type === 'invoice'
      ? [{ accountId: (await systemAccounts(db, companyId)).receivables, debit: fromMinor(amount) }, { accountId: equity.id, credit: fromMinor(amount) }]
      : [{ accountId: equity.id, debit: fromMinor(amount) }, { accountId: (await systemAccounts(db, companyId)).payables, credit: fromMinor(amount) }],
  });
  // The number comes from the old system, so it is set here rather than taken from this company's sequence, and
  // afterIssue() is deliberately NOT called: an opening document is never sent to ZATCA.
  await db.query(`UPDATE documents SET status = 'issued', number = $2, journal_entry_id = $3 WHERE id = $1`, [id, number, entryId]);
  return id;
}

/** Documents of a contact where WE are holding money that belongs to them, so it can be paid back (0055). A credit
 *  note on an invoice already paid leaves a negative amount due; `amountDue` here is that amount as a positive
 *  figure, which is the most that may be refunded against it. */
export async function refundable(db: Db, companyId: string, contactId: string) {
  const { rows } = await db.query(
    `SELECT d.id, d.number, d.type, d.issue_date::text AS "issueDate", d.currency, d.fx_rate::text AS "fxRate",
            (-document_amount_due(d.id))::numeric(18,2)::text AS "amountDue",
            (-document_fx_due(d.id))::numeric(18,2)::text AS "fxAmountDue"
     FROM documents d WHERE d.company_id = $1 AND d.contact_id = $2 AND d.status = 'issued'
       AND d.type IN ('invoice', 'debit_note', 'bill', 'claim') AND document_amount_due(d.id) < 0
     ORDER BY d.issue_date, d.number`, [companyId, contactId]);
  return rows;
}

// ------------------------------------------------------------------ overview and ageing
export async function overview(db: Db, companyId: string, side: 'sales' | 'purchases') {
  const main = side === 'sales' ? 'invoice' : 'bill';
  const credit = side === 'sales' ? 'credit_note' : 'supplier_credit';
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const open = await listDocuments(db, companyId, main, { status: 'unpaid' });
  const sum = (xs: { amountDue: string }[]) => fromMinor(xs.reduce((s, x) => s + toMinor(x.amountDue), 0n));
  const month = await db.query(
    `SELECT coalesce(sum(CASE WHEN type = $2 THEN net_total ELSE -net_total END), 0)::numeric(18,2)::text AS net
     FROM documents WHERE company_id = $1 AND type IN ($2, $3) AND status = 'issued' AND issue_date >= $4`, [companyId, main, credit, monthStart]);
  const drafts = await db.query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND type = $2 AND status = 'draft'`, [companyId, main]);
  const paid = await db.query(
    `SELECT coalesce(sum(amount), 0)::numeric(18,2)::text AS total FROM payments
     WHERE company_id = $1 AND direction = $2 AND voided_at IS NULL AND payment_date >= $3`, [companyId, side === 'sales' ? 'received' : 'made', monthStart]);
  const overdue = open.filter((d) => d.state === 'overdue');
  return {
    outstanding: sum(open), outstandingCount: open.length,
    overdue: sum(overdue), overdueCount: overdue.length,
    thisMonthNet: month.rows[0].net, paidThisMonth: paid.rows[0].total, drafts: drafts.rows[0].n,
    oldestOverdue: overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, 6),
  };
}

/** Amounts still due, per contact, by days past the due date. */
export async function aged(db: Db, companyId: string, side: 'sales' | 'purchases', asOf: string) {
  const { rows } = await db.query(
    `SELECT d.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", coalesce(d.due_date, d.issue_date)::text AS due,
            document_amount_due(d.id)::numeric(18,2)::text AS amount
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN accounts pa ON pa.id = d.paid_from_account_id
     WHERE d.company_id = $1 AND d.type = $2 AND d.status = 'issued' AND d.issue_date <= $3`,
    [companyId, side === 'sales' ? 'invoice' : 'bill', asOf]);
  const byContact = new Map<string, { contactId: string; name: string; nameAr: string | null; buckets: Record<AgeBucket, bigint> }>();
  for (const r of rows) {
    const amt = toMinor(r.amount);
    if (amt === 0n) continue;
    const row = byContact.get(r.contactId) ?? { contactId: r.contactId, name: r.name, nameAr: r.nameAr,
      buckets: Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0n])) as Record<AgeBucket, bigint> };
    row.buckets[ageBucket(r.due, asOf)] += amt;
    byContact.set(r.contactId, row);
  }
  const out = [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({
    contactId: r.contactId, name: r.name, nameAr: r.nameAr,
    ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, fromMinor(r.buckets[b])])),
    total: fromMinor(AGE_BUCKETS.reduce((s, b) => s + r.buckets[b], 0n)),
  }));
  return { asOf, rows: out };
}

export { sideOf };
