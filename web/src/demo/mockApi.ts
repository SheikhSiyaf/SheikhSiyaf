// Demo build only: answers the same /api requests as src/api/server.ts, from sample data held in
// this browser page. It repeats the database's rules (balance, two lines, cost centres, locked
// periods, roles, company separation, registration checks) so the preview behaves like the app.
// It is NOT the source of truth: the real rules live in db/migrations and are covered by `npm test`.
// Data resets when the page reloads.
import { toMinor, fromMinor } from '../../../src/money.ts';
import { vatForLine } from '../../../src/vat/vat.ts';
import { CHART_TEMPLATE, SYSTEM_ACCOUNTS } from '../../../src/books/chartTemplate.ts';
import { DEMO_COMPANIES, DEMO_FIRM, DEMO_PASSWORD, DEMO_USERS } from '../../../src/db/demoData.ts';
import {
  addDays, AGE_BUCKETS, ageBucket, nextOccurrence, type Frequency, documentTotals, formatNumber, isCredit, numberPrefix, postingFor, postingForPayment, priceLine, sideOf,
  type AgeBucket, type Direction, type DocType, type LineInput, type PricedLine,
} from '../../../src/books/documents.ts';

type Role = 'partner' | 'reviewer' | 'staff_accountant' | 'client_accountant' | 'client_viewer';
interface User {
  id: string; name: string; email: string; kind: 'admin' | 'firm_staff' | 'client'; staffRole: Role | null; twoFactor: boolean;
  status: 'active' | 'suspended'; password: string | null; inviteToken: string | null;
}
interface Company {
  id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string;
  vatStatus: 'registered' | 'unregistered'; vatNumber: string | null; crNumber: string; city: string;
  invoicePrefix: string; paymentTermsDays: number; status: 'active' | 'suspended';
  fields: Record<string, string>;   // the rest of the registration form, as entered
}
interface Account { id: string; companyId: string; code: string; name: string; nameAr: string | null; type: string; costCentreRequired: boolean; isBank: boolean }
interface CostCentre { id: string; companyId: string; name: string; nameAr: string | null; kind: string }
interface Period { companyId: string; startDate: string; endDate: string; lockedAt: string | null }
interface Line { id: string; accountId: string; costCentreId: string | null; debit: bigint; credit: bigint }
interface Entry { id: string; companyId: string; date: string; memo: string | null; createdBy: string; createdAt: string; reversesEntryId: string | null; lines: Line[] }
interface Membership { userId: string; companyId: string; role: Role }

const POSTING: Role[] = ['partner', 'staff_accountant', 'client_accountant'];
let seq = 0;
const uid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

const db = {
  firmName: DEMO_FIRM,
  activity: [] as { id: string; at: string; actor: string | null; key: string; params: Record<string, string> }[],
  users: [] as User[], companies: [] as Company[], memberships: [] as Membership[], accounts: [] as Account[],
  costCentres: [] as CostCentre[], periods: [] as Period[], entries: [] as Entry[],
};
let session: string | null = null;

class Fail extends Error {
  constructor(public status: number, message: string, public key?: string, public details?: string[]) { super(message); }
}
const fail = (status: number, message: string, key?: string, details?: string[]): never => { throw new Fail(status, message, key, details); };

// ------------------------------------------------------------------ rules (mirror db/migrations)
function roleOf(userId: string | null, companyId: string): Role | undefined {
  const u = db.users.find((x) => x.id === userId);
  const c = db.companies.find((x) => x.id === companyId);
  if (!u || u.status !== 'active' || !c || c.status !== 'active') return undefined;   // suspended = no access
  return db.memberships.find((m) => m.userId === userId && m.companyId === companyId)?.role;
}
function logActivity(key: string, params: Record<string, string>) {
  db.activity.unshift({ id: uid(), at: new Date().toISOString(), actor: db.users.find((u) => u.id === session)?.name ?? null, key, params });
}
function newInvite(u: User) {
  u.inviteToken = `demo-${uid().slice(-6)}-${Math.random().toString(36).slice(2, 10)}`;
  logActivity('act.inviteSent', { name: u.name });
  return { userId: u.id, name: u.name, email: u.email, token: u.inviteToken };
}
function isLocked(companyId: string, date: string) {
  return db.periods.some((p) => p.companyId === companyId && p.lockedAt && date >= p.startDate && date <= p.endDate);
}

function post(userId: string, companyId: string, date: string, memo: string | null, lines: Omit<Line, 'id'>[], reverses: string | null = null): string {
  const role = roleOf(userId, companyId);
  if (!role || !POSTING.includes(role)) fail(403, 'Your role does not allow this.', 'err.forbidden');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Some values are not in the right format.', 'err.format');
  if (isLocked(companyId, date)) fail(400, 'This period is locked. Choose a date in an open period.', 'err.periodLocked');
  for (const l of lines) {
    if (l.debit < 0n || l.credit < 0n || (l.debit && l.credit) || (!l.debit && !l.credit))
      fail(400, 'Each line needs a debit or a credit amount, not both, and never negative.', 'err.lineAmounts');
    if (!db.accounts.some((a) => a.id === l.accountId && a.companyId === companyId)) fail(400, 'That belongs to a different company.', 'err.otherCompany');
    if (l.costCentreId && !db.costCentres.some((c) => c.id === l.costCentreId && c.companyId === companyId)) fail(400, 'That belongs to a different company.', 'err.otherCompany');
  }
  if (lines.length < 2) fail(400, 'An entry needs at least two lines.', 'err.twoLines');
  const d = lines.reduce((s, l) => s + l.debit, 0n), c = lines.reduce((s, l) => s + l.credit, 0n);
  if (d !== c) fail(400, `Entry does not balance (debit ${fromMinor(d)}, credit ${fromMinor(c)}).`, 'err.notBalanced');
  if (lines.some((l) => !l.costCentreId && db.accounts.find((a) => a.id === l.accountId)?.costCentreRequired))
    fail(400, 'A cost centre is required for one of the accounts used.', 'err.costCentreRequired');
  const id = uid();
  db.entries.push({ id, companyId, date, memo, createdBy: userId, createdAt: new Date().toISOString(), reversesEntryId: reverses,
    lines: lines.map((l) => ({ ...l, id: uid() })) });
  return id;
}

function reverse(userId: string, entryId: string, date: string): string {
  const e = db.entries.find((x) => x.id === entryId && roleOf(userId, x.companyId));
  if (!e) return fail(404, 'Not found.', 'err.notFound');
  if (e.reversesEntryId) fail(400, 'This entry is itself a reversal. Post a new entry instead.', 'err.isReversal');
  if (db.entries.some((x) => x.reversesEntryId === e.id)) fail(400, 'This entry has already been reversed.', 'err.alreadyReversed');
  return post(userId, e.companyId, date, `Reversal of ${e.memo ?? e.id}`,
    e.lines.map((l) => ({ accountId: l.accountId, costCentreId: l.costCentreId, debit: l.credit, credit: l.debit })), e.id);
}

function setupBooks(companyId: string) {
  for (const a of CHART_TEMPLATE) {
    db.accounts.push({ id: uid(), companyId, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, costCentreRequired: Boolean(a.costCentreRequired), isBank: Boolean(a.bank) });
  }
  db.costCentres.push({ id: uid(), companyId, name: 'Head office', nameAr: 'المكتب الرئيسي', kind: 'branch' });
  const y = new Date().getFullYear();
  for (let m = 1; m <= 12; m++) {
    const last = new Date(y, m, 0).getDate();
    db.periods.push({ companyId, startDate: `${y}-${String(m).padStart(2, '0')}-01`, endDate: `${y}-${String(m).padStart(2, '0')}-${last}`, lockedAt: null });
  }
}

// ------------------------------------------------------------------ demo data (same as src/db/seed.ts)
function seed() {
  for (const u of DEMO_USERS) {
    db.users.push({ id: uid(), name: u.name, email: u.email, kind: u.kind, staffRole: u.kind === 'firm_staff' ? (u.role as Role) : null,
      twoFactor: false, status: 'active', password: DEMO_PASSWORD, inviteToken: null });
  }
  const userByEmail = (e: string) => db.users.find((u) => u.email === e)!;
  for (const c of DEMO_COMPANIES) {
    const id = uid();
    db.companies.push({ id, name: c.name, nameAr: c.nameAr, country: c.country, currency: c.currency, vatRate: c.vatRate, vatStatus: 'registered',
      vatNumber: c.vatNumber, crNumber: c.crNumber, city: c.city, invoicePrefix: c.invoicePrefix, paymentTermsDays: 30, status: 'active',
      fields: { legalForm: c.legalForm, address: c.address, fyEnd: '12-31' } });
    for (const u of DEMO_USERS.filter((x) => x.companies.includes(c.key))) db.memberships.push({ userId: userByEmail(u.email).id, companyId: id, role: u.role as Role });
    setupBooks(id);
    db.costCentres.push({ id: uid(), companyId: id, name: 'Branch 1', nameAr: 'الفرع 1', kind: 'branch' }, { id: uid(), companyId: id, name: 'Project A', nameAr: 'المشروع أ', kind: 'project' });

    const acct = (code: string) => db.accounts.find((a) => a.companyId === id && a.code === code)!.id;
    const cc = (name: string) => db.costCentres.find((x) => x.companyId === id && x.name === name)!.id;
    const net = (n: number) => BigInt(n) * 100n;
    const L = (code: string, debit: bigint, credit: bigint, centre?: string) => ({ accountId: acct(code), debit, credit, costCentreId: centre ? cc(centre) : null });
    const poster = userByEmail(DEMO_USERS.find((u) => u.companies.includes(c.key) && (u.role === 'client_accountant' || u.role === 'staff_accountant'))!.email).id;
    const p = (days: number, memo: string, lines: Omit<Line, 'id'>[]) => post(poster, id, daysAgo(days), memo, lines);
    p(120, 'Opening balance', [L('1000', net(50000), 0n), L('3000', 0n, net(50000))]);
    p(60, 'Rent · head office', [L('5100', net(4000), 0n, 'Head office'), L('1000', 0n, net(4000))]);
    p(25, 'Salaries', [L('5200', net(6000), 0n, 'Head office'), L('5200', net(2500), 0n, 'Branch 1'), L('1000', 0n, net(8500))]);
    const wrong = p(12, 'Office water delivery', [L('5400', net(180), 0n), L('1000', 0n, net(180))]);
    reverse(poster, wrong, daysAgo(11));
    db.entries.at(-1)!.memo = 'Reversal: posted twice';
    seedSales(id, poster, c);
    p(1, 'Electricity', [L('5300', net(650), 0n), L('1000', 0n, net(650))]);
    const cutoff = new Date(); cutoff.setDate(1); cutoff.setMonth(cutoff.getMonth() - 1);
    for (const per of db.periods) if (per.companyId === id && per.endDate < iso(cutoff)) per.lockedAt = new Date().toISOString();
  }
}

// ------------------------------------------------------------------ helpers for responses
const s = fromMinor;
const me = () => {
  const u = db.users.find((x) => x.id === session);
  if (!u || u.status !== 'active') return fail(401, 'Please sign in.', 'err.signIn');
  return u;
};
const admin = () => { const u = me(); if (u.kind !== 'admin') fail(403, 'Only the Administrator can do this.', 'err.adminOnly'); return u; };
function member(companyId: string) {
  const u = me();
  const role = roleOf(u.id, companyId);
  if (!role) fail(404, 'Not found.', 'err.notFound');
  return { u, role: role! };
}
function balances(companyId: string, asOf: string) {
  const m = new Map<string, bigint>();
  for (const e of db.entries) if (e.companyId === companyId && e.date <= asOf)
    for (const l of e.lines) m.set(l.accountId, (m.get(l.accountId) ?? 0n) + l.debit - l.credit);
  return m;
}
function pnl(companyId: string, from: string, to: string) {
  const rows = new Map<string | null, { income: bigint; expense: bigint }>();
  for (const e of db.entries) if (e.companyId === companyId && e.date >= from && e.date <= to)
    for (const l of e.lines) {
      const a = db.accounts.find((x) => x.id === l.accountId)!;
      if (a.type !== 'income' && a.type !== 'expense') continue;
      const r = rows.get(l.costCentreId) ?? { income: 0n, expense: 0n };
      if (a.type === 'income') r.income += l.credit - l.debit; else r.expense += l.debit - l.credit;
      rows.set(l.costCentreId, r);
    }
  return rows;
}
const companyView = (c: Company) => ({ id: c.id, name: c.name, nameAr: c.nameAr, country: c.country, currency: c.currency, vatRate: c.vatRate });

// ------------------------------------------------------------------ sales and purchases (same rules as db/migrations/0005)
interface MContact {
  id: string; companyId: string; isCustomer: boolean; isSupplier: boolean; name: string; nameAr: string | null; vatNumber: string | null;
  crNumber: string | null; email: string | null; phone: string | null; address: string | null; city: string | null; country: string | null;
  paymentTermsDays: number | null; status: 'active' | 'archived';
}
interface MDoc {
  id: string; companyId: string; type: DocType; status: string; number: string | null; contactId: string | null; issueDate: string; dueDate: string | null;
  reference: string | null; notes: string | null; originalId: string | null; journalEntryId: string | null; lines: (PricedLine & { id: string })[]; createdAt: string;
  payee?: string | null; paidFromAccountId?: string | null; recurringId?: string | null; voidedAt?: string | null;
}
interface MPayment {
  id: string; companyId: string; direction: Direction; number: string; contactId: string; date: string; amount: bigint; accountId: string;
  method: string; reference: string | null; journalEntryId: string; voidedAt: string | null; allocations: { documentId: string; amount: bigint }[]; createdAt: string;
}
interface MRecurring {
  id: string; companyId: string; name: string; contactId: string | null; payee: string | null; paidFromAccountId: string; frequency: string;
  nextDate: string; anchorDay: number; endDate: string | null; active: boolean; lines: LineInput[]; reference: string | null;
}
const sdb = { contacts: [] as MContact[], docs: [] as MDoc[], payments: [] as MPayment[], seqs: new Map<string, number>(), recurring: [] as MRecurring[] };

function canPostIn(companyId: string) {
  const role = roleOf(session, companyId);
  if (!role) fail(404, 'Not found.', 'err.notFound');
  if (!POSTING.includes(role!)) fail(403, 'Your role does not allow this.', 'err.forbidden');
}
function nextNo(companyId: string, seq: string, prefix: string) {
  const k = `${companyId}:${seq}`;
  const n = sdb.seqs.get(k) ?? 1;
  sdb.seqs.set(k, n + 1);
  return formatNumber(prefix, n);
}
const sysAccts = (companyId: string) => {
  const a = (code: string) => db.accounts.find((x) => x.companyId === companyId && x.code === code)!.id;
  return { receivables: a('1100'), payables: a('2000'), outputVat: a('2100'), inputVat: a('1200') };
};
const docTotals = (d: MDoc) => documentTotals(d.lines);
function amountDue(d: MDoc): bigint {
  if (!['invoice', 'bill'].includes(d.type) || d.status !== 'issued') return 0n;   // expenses are paid at once
  const paid = sdb.payments.filter((p) => !p.voidedAt).flatMap((p) => p.allocations).filter((a) => a.documentId === d.id).reduce((s, a) => s + a.amount, 0n);
  const credited = sdb.docs.filter((c) => c.originalId === d.id && isCredit(c.type) && c.status === 'issued').reduce((s, c) => s + docTotals(c).gross, 0n);
  return docTotals(d).gross - paid - credited;
}
function stateOfDoc(d: MDoc): string {
  if (d.type === 'quotation' || d.type === 'expense' || d.status === 'draft' || isCredit(d.type)) return d.status;
  const due = amountDue(d);
  if (due < 0n) return 'credit';
  if (due === 0n) return 'paid';
  if (d.dueDate && d.dueDate < today()) return 'overdue';
  return due < docTotals(d).gross ? 'partly_paid' : 'unpaid';
}
function docRow(d: MDoc) {
  const c = sdb.contacts.find((x) => x.id === d.contactId);
  const t = docTotals(d);
  const pa = db.accounts.find((a) => a.id === d.paidFromAccountId);
  return { id: d.id, companyId: d.companyId, type: d.type, status: d.status, state: stateOfDoc(d), number: d.number, contactId: d.contactId, contactName: c?.name ?? d.payee ?? '',
    contactNameAr: c?.nameAr ?? null, payee: d.payee ?? null, paidFromAccountId: d.paidFromAccountId ?? null, paidFromName: pa?.name ?? null, paidFromNameAr: pa?.nameAr ?? null,
    recurringId: d.recurringId ?? null, voidedAt: d.voidedAt ?? null, issueDate: d.issueDate, dueDate: d.dueDate, reference: d.reference, notes: d.notes, originalId: d.originalId,
    journalEntryId: d.journalEntryId, netTotal: s(t.net), vatTotal: s(t.vat), grossTotal: s(t.gross), amountDue: s(amountDue(d)), createdAt: d.createdAt };
}
function saveContactM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const t = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
  if (!t('name')) fail(400, 'Enter the name.', 'err.contactName');
  if (!b.isCustomer && !b.isSupplier) fail(400, 'Choose customer, supplier or both.', 'err.contactRole');
  const country = t('country')?.toUpperCase() ?? null, vat = t('vatNumber')?.replace(/\s/g, '') ?? null;
  if (vat && country === 'SA' && !/^3\d{13}3$/.test(vat)) fail(400, 'A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat');
  if (vat && country === 'AE' && !/^\d{15}$/.test(vat)) fail(400, 'A UAE TRN has 15 digits.', 'err.aeTrn');
  const terms = b.paymentTermsDays === '' || b.paymentTermsDays == null ? null : Number(b.paymentTermsDays);
  const v: Omit<MContact, 'id' | 'companyId'> = { isCustomer: Boolean(b.isCustomer), isSupplier: Boolean(b.isSupplier), name: t('name')!, nameAr: t('nameAr'),
    vatNumber: vat, crNumber: t('crNumber'), email: t('email'), phone: t('phone'), address: t('address'), city: t('city'), country, paymentTermsDays: terms,
    status: b.status === 'archived' ? 'archived' : 'active' };
  if (id) { Object.assign(sdb.contacts.find((x) => x.id === id) ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); sdb.contacts.push({ id: nid, companyId, ...v }); return nid;
}
function priceLinesM(companyId: string, side: 'sales' | 'purchases', lines: LineInput[] = []) {
  const rate = db.companies.find((c) => c.id === companyId)!.vatRate;
  return lines.map((l, i) => {
    const a = db.accounts.find((x) => x.id === l.accountId && x.companyId === companyId);
    if (!String(l.description ?? '').trim()) fail(400, `Line ${i + 1}: enter a description.`, 'err.lineDescription');
    if (!a) fail(400, `Line ${i + 1}: choose an account.`, 'err.lineAccount');
    if (side === 'sales' && a!.type !== 'income') fail(400, 'Sales lines use an income account.', 'err.salesAccount');
    if (side === 'purchases' && !['expense', 'asset'].includes(a!.type)) fail(400, 'Purchase lines use an expense or asset account.', 'err.purchaseAccount');
    try { return { ...priceLine({ ...l, description: String(l.description).trim() }, rate), id: uid() }; }
    catch { return fail(400, `Line ${i + 1}: check the quantity and price.`, 'err.lineNumbers'); }
  });
}
function saveDraftM(companyId: string, b: Record<string, unknown>, id?: string): string {
  canPostIn(companyId);
  const existing = id ? sdb.docs.find((d) => d.id === id) ?? fail(404, 'Not found.', 'err.notFound') : undefined;
  if (existing && existing.status !== 'draft') fail(400, 'Only drafts can be changed.', 'err.notDraft');
  const type = (existing?.type ?? b.type) as DocType;
  if (!['quotation', 'invoice', 'credit_note', 'bill', 'supplier_credit', 'expense'].includes(type)) fail(400, 'Choose the document type.', 'err.format');
  const isExpense = type === 'expense';
  const contact = b.contactId ? sdb.contacts.find((c) => c.id === b.contactId && c.companyId === companyId) : undefined;
  if (!contact && !(isExpense && !b.contactId)) fail(400, 'Choose the customer or supplier.', 'err.contact');
  if (contact && (sideOf(type) === 'sales' ? !contact.isCustomer : !contact.isSupplier)) fail(400, 'Choose a customer or supplier of this company.', 'err.contact');
  if (isExpense && b.paidFromAccountId && !db.accounts.some((a) => a.id === b.paidFromAccountId && a.companyId === companyId && a.isBank))
    fail(400, 'Choose one of this company\'s bank or cash accounts.', 'err.bankAccount');
  const issueDate = String(b.issueDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) fail(400, 'Enter the date.', 'err.date');
  const dueDate = b.dueDate ? String(b.dueDate) : null;
  if (dueDate && dueDate < issueDate) fail(400, 'The due date cannot be before the document date.', 'err.dueDate');
  const lines = priceLinesM(companyId, sideOf(type), b.lines as LineInput[]);
  const head = { contactId: contact?.id ?? null, issueDate, dueDate: isExpense ? null : dueDate, reference: (b.reference as string)?.trim() || null, notes: (b.notes as string)?.trim() || null, lines,
    payee: isExpense ? (b.payee as string)?.trim() || null : null, paidFromAccountId: isExpense ? (b.paidFromAccountId as string) || null : null };
  if (existing) { Object.assign(existing, head); return existing.id; }
  const nid = uid();
  sdb.docs.push({ id: nid, companyId, type, status: 'draft', number: null, originalId: (b.originalId as string) ?? null, journalEntryId: null, createdAt: new Date().toISOString(),
    recurringId: isExpense ? (b.recurringId as string) ?? null : null, ...head });
  return nid;
}
const docOf = (id: string) => sdb.docs.find((d) => d.id === id && roleOf(session, d.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function issueM(id: string) {
  const d = docOf(id);
  canPostIn(d.companyId);
  if (d.status !== 'draft') fail(400, 'This document has already been issued.', 'err.alreadyIssued');
  if (!d.lines.length) fail(400, 'Add at least one line.', 'err.noLines');
  if (d.type === 'expense' && !d.paidFromAccountId) fail(400, 'Choose the bank or cash account the expense was paid from.', 'err.bankAccount');
  if (d.type === 'expense' && !d.contactId && !(d.payee ?? '').trim()) fail(400, 'Enter who was paid (a supplier or a payee name).', 'err.payee');
  if (d.lines.some((l) => !l.costCentreId && db.accounts.find((a) => a.id === l.accountId)?.costCentreRequired))
    fail(400, 'A cost centre is required for one of the accounts used.', 'err.costCentreRequired');
  if (isCredit(d.type)) {
    const o = sdb.docs.find((x) => x.id === d.originalId)!;
    const before = sdb.docs.filter((x) => x.originalId === o.id && x.type === d.type && x.status === 'issued').reduce((sum, x) => sum + docTotals(x).gross, 0n);
    if (before + docTotals(d).gross > docTotals(o).gross) fail(400, 'A credit note cannot be more than what is left on the original.', 'err.creditTooMuch');
  }
  const company = db.companies.find((c) => c.id === d.companyId)!;
  const seqKey = `${d.companyId}:${d.type}`;
  const savedSeq = sdb.seqs.get(seqKey);
  const number = nextNo(d.companyId, d.type, numberPrefix(d.type, company.invoicePrefix));
  try {
    const c = sdb.contacts.find((x) => x.id === d.contactId);
    d.journalEntryId = post(session!, d.companyId, d.issueDate, `${number} · ${c?.name ?? d.payee}`,
      postingFor(d.type, d.lines, sysAccts(d.companyId), d.paidFromAccountId ?? undefined).map((l) => ({ accountId: l.accountId, costCentreId: l.costCentreId ?? null, debit: toMinor(l.debit ?? '0'), credit: toMinor(l.credit ?? '0') })));
  } catch (e) { if (savedSeq === undefined) sdb.seqs.delete(seqKey); else sdb.seqs.set(seqKey, savedSeq); throw e; }   // no gap in numbers
  d.number = number; d.status = 'issued';
}
function quoteStatusM(id: string, status: string) {
  const d = docOf(id); canPostIn(d.companyId);
  if (d.type !== 'quotation') fail(400, 'Only quotations have this status.', 'err.format');
  const ok = [['draft', 'sent'], ['draft', 'accepted'], ['draft', 'declined'], ['sent', 'accepted'], ['sent', 'declined'], ['declined', 'accepted']].some(([a, b]) => a === d.status && b === status);
  if (!ok) fail(400, 'This quotation cannot move to that status.', 'err.quoteStatus');
  if (!d.number) d.number = nextNo(d.companyId, 'quotation', 'QT-');
  d.status = status;
}
const copyLines = (d: MDoc) => d.lines.map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) => ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
function convertM(id: string) {
  const q = docOf(id); canPostIn(q.companyId);
  if (q.type !== 'quotation' || !['sent', 'accepted'].includes(q.status)) fail(400, 'Send or accept the quotation first.', 'err.quoteNotSent');
  const terms = sdb.contacts.find((c) => c.id === q.contactId)!.paymentTermsDays ?? 30;
  const nid = saveDraftM(q.companyId, { type: 'invoice', contactId: q.contactId, issueDate: today(), dueDate: addDays(today(), terms), reference: q.number, notes: q.notes, originalId: q.id, lines: copyLines(q) });
  q.status = 'invoiced';
  return nid;
}
function creditM(id: string) {
  const o = docOf(id); canPostIn(o.companyId);
  if (!['invoice', 'bill'].includes(o.type) || o.status !== 'issued') fail(400, 'Only issued invoices and bills can be credited.', 'err.notIssued');
  return saveDraftM(o.companyId, { type: o.type === 'invoice' ? 'credit_note' : 'supplier_credit', contactId: o.contactId, issueDate: today(), reference: o.number, originalId: o.id, lines: copyLines(o) });
}
function payM(companyId: string, b: Record<string, unknown>) {
  canPostIn(companyId);
  const direction = b.direction === 'made' ? 'made' : 'received';
  const contact = sdb.contacts.find((c) => c.id === b.contactId && c.companyId === companyId && (direction === 'received' ? c.isCustomer : c.isSupplier));
  if (!contact) fail(400, 'Choose the customer or supplier.', 'err.contact');
  const bank = db.accounts.find((a) => a.id === b.accountId && a.companyId === companyId && a.isBank);
  if (!bank) fail(400, 'Choose the bank or cash account.', 'err.bankAccount');
  let amount: bigint; let allocs: { documentId: string; amount: bigint }[];
  try {
    amount = toMinor(String(b.amount ?? '').replace(/,/g, ''));
    allocs = ((b.allocations as { documentId: string; amount: string }[]) ?? []).map((a) => ({ documentId: a.documentId, amount: toMinor(String(a.amount)) }));
  } catch { return fail(400, 'Amounts must be numbers with at most 2 decimals.', 'err.amountFormat'); }
  if (amount <= 0n) fail(400, 'Enter the amount.', 'err.amount');
  if (allocs.reduce((x, a) => x + a.amount, 0n) > amount) fail(400, 'The amounts settled are more than the payment.', 'err.overAllocated');
  for (const a of allocs) {
    const d = sdb.docs.find((x) => x.id === a.documentId);
    if (!d || d.contactId !== contact!.id || d.status !== 'issued' || d.type !== (direction === 'received' ? 'invoice' : 'bill'))
      fail(400, 'A payment can only settle issued invoices (or bills) of the same customer (or supplier).', 'err.contact');
    if (a.amount <= 0n || a.amount > amountDue(d!)) fail(400, 'This is more than is due on the invoice.', 'err.overDue');
  }
  const date = String(b.date ?? '');
  const id = uid();
  const seq = direction === 'received' ? 'receipt' : 'payment';
  const number = nextNo(companyId, seq, numberPrefix(seq, ''));
  const entry = postingForPayment(direction, amount, bank!.id, sysAccts(companyId));
  const je = post(session!, companyId, date, `${number} · ${contact!.name}`, entry.map((l) => ({ accountId: l.accountId, costCentreId: null, debit: toMinor(l.debit ?? '0'), credit: toMinor(l.credit ?? '0') })));
  sdb.payments.push({ id, companyId, direction, number, contactId: contact!.id, date, amount, accountId: bank!.id, method: String(b.method ?? 'bank_transfer'),
    reference: (b.reference as string)?.trim() || null, journalEntryId: je, voidedAt: null, allocations: allocs, createdAt: new Date().toISOString() });
  return id;
}
const payOf = (id: string) => sdb.payments.find((p) => p.id === id && roleOf(session, p.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function payRow(p: MPayment) {
  const a = db.accounts.find((x) => x.id === p.accountId)!;
  return { id: p.id, direction: p.direction, number: p.number, contactId: p.contactId, contactName: sdb.contacts.find((c) => c.id === p.contactId)!.name,
    date: p.date, amount: s(p.amount), accountId: a.id, accountName: a.name, accountNameAr: a.nameAr, method: p.method, reference: p.reference,
    voidedAt: p.voidedAt, unallocated: s(p.amount - p.allocations.reduce((x, y) => x + y.amount, 0n)), createdAt: p.createdAt };
}
function contactRow(c: MContact) {
  const docs = sdb.docs.filter((d) => d.contactId === c.id && d.status === 'issued' && (c.isCustomer ? d.type === 'invoice' : d.type === 'bill'));
  return { ...c, balanceDue: s(docs.reduce((x, d) => x + amountDue(d), 0n)),
    overdue: s(docs.filter((d) => d.dueDate && d.dueDate < today() && amountDue(d) > 0n).reduce((x, d) => x + amountDue(d), 0n)) };
}
const inCo = (id: string) => { member(id); return id; };

function saveRecurringM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const t = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
  if (!t('name')) fail(400, 'Give the recurring expense a name.', 'err.recurringName');
  if (!b.contactId && !t('payee')) fail(400, 'Enter who is paid (a supplier or a payee name).', 'err.payee');
  if (!db.accounts.some((a) => a.id === b.paidFromAccountId && a.companyId === companyId && a.isBank)) fail(400, 'Choose the bank or cash account it is paid from.', 'err.bankAccount');
  if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(String(b.frequency))) fail(400, 'Choose how often it repeats.', 'err.frequency');
  const nextDate = String(b.nextDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) fail(400, 'Enter the next date.', 'err.date');
  const endDate = t('endDate');
  if (endDate && endDate < nextDate) fail(400, 'The end date cannot be before the next date.', 'err.endDate');
  const lines = (b.lines as LineInput[]) ?? [];
  if (!lines.length) fail(400, 'Add at least one line.', 'err.noLines');
  priceLinesM(companyId, 'purchases', lines);   // same line checks as an expense
  const v = { name: t('name')!, contactId: (b.contactId as string) || null, payee: b.contactId ? null : t('payee'), paidFromAccountId: String(b.paidFromAccountId),
    frequency: String(b.frequency), nextDate, anchorDay: Number(nextDate.slice(8, 10)), endDate, active: b.active !== false, lines, reference: t('reference') };
  if (id) { Object.assign(sdb.recurring.find((r) => r.id === id) ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); sdb.recurring.push({ id: nid, companyId, ...v }); return nid;
}
function generateM(companyId: string, onlyId?: string, upTo = today()) {
  canPostIn(companyId);
  const created: string[] = [];
  for (const r of sdb.recurring.filter((x) => x.companyId === companyId && x.active && (!onlyId || x.id === onlyId))) {
    let next = r.nextDate; let n = 0;
    const limit = onlyId && next > upTo ? next : upTo;
    while (next <= limit && (!r.endDate || next <= r.endDate) && n < 12) {
      created.push(saveDraftM(companyId, { type: 'expense', contactId: r.contactId, payee: r.payee, paidFromAccountId: r.paidFromAccountId, issueDate: next,
        reference: r.reference, notes: r.name, lines: r.lines, recurringId: r.id }));
      next = nextOccurrence(next, r.frequency as Frequency, r.anchorDay); n++;
      if (onlyId) break;
    }
    r.nextDate = next;
    if (r.endDate && next > r.endDate) r.active = false;
  }
  return created;
}
function recRow(r: MRecurring) {
  const a = db.accounts.find((x) => x.id === r.paidFromAccountId)!;
  const net = r.lines.reduce((sum, l) => { try { return sum + priceLine({ ...l, vatCode: 'out_of_scope' }, '0').net; } catch { return sum; } }, 0n);
  return { ...r, payeeName: sdb.contacts.find((c) => c.id === r.contactId)?.name ?? r.payee ?? '', paidFromName: a.name, paidFromNameAr: a.nameAr,
    due: r.active && r.nextDate <= today() && (!r.endDate || r.nextDate <= r.endDate), netAmount: s(net) };
}
/** Spending per expense account between two dates, from the ledger. */
function spentByAccount(companyId: string, from: string, to: string) {
  return db.accounts.filter((a) => a.companyId === companyId && a.type === 'expense').map((a) => {
    let v = 0n;
    for (const e of db.entries) if (e.companyId === companyId && e.date >= from && e.date <= to) for (const l of e.lines) if (l.accountId === a.id) v += l.debit - l.credit;
    return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, costCentreRequired: a.costCentreRequired, spent: s(v), v };
  }).sort((x, y) => x.code.localeCompare(y.code));
}

function seedSales(companyId: string, poster: string, c: { country: string; city: string; vatRate: string }) {
  const prev = session; session = poster;
  const acct = (code: string) => db.accounts.find((a) => a.companyId === companyId && a.code === code)!.id;
  const cc = (name: string) => db.costCentres.find((x) => x.companyId === companyId && x.name === name)!.id;
  const vatNo = (n: number) => (c.country === 'SA' ? `3${String(n).padStart(13, '0')}3` : String(100000000000000 + n));
  const contact = (cust: boolean, name: string, nameAr: string, vatN?: number, terms = 30) =>
    saveContactM(companyId, { isCustomer: cust, isSupplier: !cust, name, nameAr, country: c.country, vatNumber: vatN ? vatNo(vatN) : '', paymentTermsDays: terms, city: c.city });
  const gulf = contact(true, 'Gulf Steel Trading', 'الخليج للحديد', 1234567);
  const faisal = contact(true, 'Al Faisal Contracting', 'الفيصل للمقاولات', 7654321);
  const walkIn = contact(true, 'Walk-in customer', 'عميل نقدي', undefined, 0);
  const najd = contact(false, 'Najd Wholesale', 'نجد للجملة', 2223334, 15);
  const telecom = contact(false, 'Desert Telecom', 'الصحراء للاتصالات', 5556667, 15);
  const SL = (description: string, quantity: string, unitPrice: string, centre?: string, code = '4000') =>
    ({ description, quantity, unitPrice, accountId: acct(code), costCentreId: centre ? cc(centre) : null, vatCode: 'standard' });
  const doc = (type: DocType, contactId: string, ago: number, dueIn: number | null, lines: object[], reference?: string, issue = true) => {
    const id = saveDraftM(companyId, { type, contactId, issueDate: daysAgo(ago), dueDate: dueIn === null ? null : daysAgo(ago - dueIn), reference, lines });
    if (issue) issueM(id);
    return id;
  };
  const grossOf = (id: string) => s(docTotals(sdb.docs.find((d) => d.id === id)!).gross);
  const pay = (direction: Direction, contactId: string, ago: number, docId: string, amount: string, code = '1000', method = 'bank_transfer') =>
    payM(companyId, { direction, contactId, date: daysAgo(ago), amount, accountId: acct(code), method, allocations: [{ documentId: docId, amount }] });
  const inv1 = doc('invoice', gulf, 95, 30, [SL('Steel beams 12m', '20', '500.00', 'Head office')], 'PO-4471');
  pay('received', gulf, 80, inv1, grossOf(inv1));
  const inv2 = doc('invoice', faisal, 34, 30, [SL('Rebar 16mm (tonnes)', '2', '2500.00', 'Head office'), SL('Delivery and offloading', '1', '2250.00', 'Branch 1')]);
  pay('received', faisal, 12, inv2, '3000.00');
  const cn = creditM(inv2);
  saveDraftM(companyId, { contactId: faisal, issueDate: daysAgo(10), reference: sdb.docs.find((d) => d.id === inv2)!.number, lines: [SL('Delivery and offloading (partial refund)', '1', '250.00', 'Branch 1')] }, cn);
  issueM(cn);
  const inv3 = doc('invoice', walkIn, 6, 0, [SL('Cut-to-size service', '3', '600.00', 'Project A')]);
  pay('received', walkIn, 6, inv3, grossOf(inv3), '1010', 'cash');
  doc('invoice', gulf, 2, 30, [SL('Steel plates 6mm', '15', '300.00', 'Head office')], 'PO-4520');
  doc('invoice', gulf, 0, 30, [SL('Angle iron 50x50', '40', '45.00', 'Head office')], undefined, false);
  const q = doc('quotation', faisal, 10, 30, [SL('Structural steel package', '1', '12000.00', 'Head office')], undefined, false);
  quoteStatusM(q, 'sent');
  const bill1 = doc('bill', najd, 30, 15, [SL('Steel stock purchase', '1', '3200.00', undefined, '5000')], 'NW-88102');
  pay('made', najd, 20, bill1, grossOf(bill1));
  doc('bill', telecom, 10, 15, [SL('Internet and phone lines', '1', '420.00', undefined, '5300')], 'DT-5531');
  for (const [ago, payee, bankCode, desc, amount, vatCode] of [
    [18, 'Petrol station', '1010', 'Fuel for delivery van', '150.00', 'standard'], [9, 'Al Waha Office Supplies', '1000', 'Printer toner and paper', '420.00', 'standard'],
    [4, 'City taxi', '1010', 'Taxi to customer site', '45.00', 'zero']] as const) {
    issueM(saveDraftM(companyId, { type: 'expense', payee, paidFromAccountId: acct(bankCode), issueDate: daysAgo(ago as number), lines: [{ ...SL(desc, '1', amount, undefined, '5400'), vatCode }] }));
  }
  const d0 = new Date(); const nextMonth = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  saveRecurringM(companyId, { name: 'Office rent', payee: 'Al Olaya Properties', paidFromAccountId: acct('1000'), frequency: 'monthly', nextDate: nextMonth,
    lines: [{ ...SL('Monthly office rent', '1', '4000.00', 'Head office', '5100'), vatCode: 'exempt' }] });
  saveRecurringM(companyId, { name: 'Internet and phones', contactId: telecom, paidFromAccountId: acct('1000'), frequency: 'monthly', nextDate: daysAgo(2),
    lines: [{ ...SL('Fibre internet and 5 mobile lines', '1', '299.00', undefined, '5300'), vatCode: 'standard' }] });
  session = prev;
}

// ------------------------------------------------------------------ admin helpers
const company = (id: string) => db.companies.find((c) => c.id === id) ?? fail(404, 'Not found.', 'err.notFound');
const user = (id: string) => db.users.find((u) => u.id === id) ?? fail(404, 'Not found.', 'err.notFound');
const staffOf = (companyId: string) => db.memberships.filter((m) => m.companyId === companyId)
  .map((m) => db.users.find((u) => u.id === m.userId)!).filter((u) => u.kind === 'firm_staff');
const person = (u: User) => ({ id: u.id, name: u.name, email: u.email, status: u.status, invitePending: Boolean(u.inviteToken), passwordSet: Boolean(u.password), twoFactor: u.twoFactor });
function emailFree(email: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) fail(400, 'Enter a valid email address.', 'err.email');
  if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) fail(400, 'A user with this email already exists.', 'err.emailTaken');
}
function addUser(name: string, email: string, kind: User['kind'], staffRole: Role | null): User {
  const u: User = { id: uid(), name: name.trim(), email: email.trim(), kind, staffRole, twoFactor: false, status: 'active', password: null, inviteToken: null };
  db.users.push(u);
  logActivity('act.userAdded', { name: u.name, role: staffRole ?? 'client' });
  return u;
}
function assign(userId: string, companyId: string, on: boolean) {
  const u = db.users.find((x) => x.id === userId && x.kind === 'firm_staff') ?? fail(404, 'Not found.', 'err.notFound');
  const c = company(companyId);
  const has = db.memberships.some((m) => m.userId === u.id && m.companyId === c.id);
  if (on && !has) { db.memberships.push({ userId: u.id, companyId: c.id, role: u.staffRole! }); logActivity('act.accessGiven', { name: u.name, client: c.name }); }
  if (!on && has) { db.memberships = db.memberships.filter((m) => !(m.userId === u.id && m.companyId === c.id)); logActivity('act.accessRemoved', { name: u.name, client: c.name }); }
  return { ok: true };
}
/** Same checks as the database (db/migrations) for registration fields. Country never changes here. */
function applyCompany(co: Company, c: Record<string, string | undefined>) {
  const v = (k: string) => (c[k] ?? '').trim();
  const registered = v('vatStatus') !== 'unregistered';
  if (!v('name') || !v('crNumber') || !v('legalForm') || !v('address') || !v('city')) fail(400, 'Fill in all required fields.', 'err.required');
  if (co.country === 'SA' && !/^\d{10}$/.test(v('crNumber'))) fail(400, 'A Saudi CR number has 10 digits.', 'err.saCr');
  if (registered && !v('vatNumber')) fail(400, 'Enter the VAT number, or choose VAT unregistered.', 'err.vatNumber');
  if (registered && co.country === 'SA' && !/^3\d{13}3$/.test(v('vatNumber'))) fail(400, 'A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat');
  if (registered && co.country === 'AE' && !/^\d{15}$/.test(v('vatNumber'))) fail(400, 'A UAE TRN has 15 digits.', 'err.aeTrn');
  if (db.companies.some((x) => x.id !== co.id && x.crNumber === v('crNumber'))) fail(400, 'A client with this registration number already exists.', 'err.crTaken');
  if (registered && db.companies.some((x) => x.id !== co.id && x.vatNumber === v('vatNumber'))) fail(400, 'A client with this VAT number already exists.', 'err.vatTaken');
  const rate = { SA: '15.00', AE: '5.00', OM: '5.00' }[co.country];
  Object.assign(co, {
    name: v('name'), nameAr: v('nameAr') || null, crNumber: v('crNumber'), city: v('city'),
    vatStatus: registered ? 'registered' : 'unregistered', vatNumber: registered ? v('vatNumber') : null, vatRate: registered ? rate : '0.00',
    invoicePrefix: v('invoicePrefix') || 'INV-', paymentTermsDays: Number(v('paymentTermsDays') || 30),
    fields: { tradeName: v('tradeName'), legalForm: v('legalForm'), crExpiry: v('crExpiry'), vatRegistrationDate: registered ? v('vatRegistrationDate') : '',
      address: v('address'), fyEnd: v('fyEnd') || '12-31', phone: v('phone'), email: v('email'), website: v('website'), complianceNotes: v('complianceNotes') },
  });
}

// ------------------------------------------------------------------ routes
type Body = Record<string, unknown> | undefined;
type Handler = (m: RegExpMatchArray, body: Body, query: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/demo-users$/, () => DEMO_USERS.map(({ name, email, kind, role, company }) => ({ name, email, kind, role, company }))],
  ['POST', /^\/api\/login$/, (_m, b) => {
    const u = db.users.find((x) => x.email.toLowerCase() === String(b?.email ?? '').trim().toLowerCase());
    if (!u || !u.password || b?.password !== u.password) return fail(401, 'The email or password is not right.', 'err.login');
    if (u.status !== 'active') fail(403, 'This account is suspended. Contact the Administrator.', 'err.suspended');
    session = u.id;
    return { ok: true };
  }],
  ['POST', /^\/api\/logout$/, () => { session = null; return { ok: true }; }],
  ['GET', /^\/api\/me$/, () => {
    const u = me();
    return {
      user: { id: u.id, name: u.name, email: u.email, kind: u.kind, staffRole: u.staffRole, firmName: db.firmName, twoFactor: u.twoFactor },
      companies: db.memberships.filter((m) => m.userId === u.id && roleOf(u.id, m.companyId))
        .map((m) => ({ ...companyView(db.companies.find((c) => c.id === m.companyId)!), role: m.role }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)$/, (m) => {
    const { role } = member(m[1]!);
    const c = db.companies.find((x) => x.id === m[1])!;
    return {
      company: { ...companyView(c), vatStatus: c.vatStatus, vatNumber: c.vatNumber, crNumber: c.crNumber, city: c.city, invoicePrefix: c.invoicePrefix, paymentTermsDays: c.paymentTermsDays },
      role, canPost: POSTING.includes(role), canLock: role === 'partner',
      accounts: db.accounts.filter((a) => a.companyId === c.id).sort((a, b) => a.code.localeCompare(b.code)),
      costCentres: db.costCentres.filter((x) => x.companyId === c.id).sort((a, b) => a.name.localeCompare(b.name)),
      periods: db.periods.filter((p) => p.companyId === c.id),
    };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/summary$/, (m) => {
    const id = m[1]!; member(id);
    const t = today(), monthStart = `${t.slice(0, 7)}-01`;
    const b = balances(id, t);
    const bal = (code: string) => s(b.get(db.accounts.find((a) => a.companyId === id && a.code === code)!.id) ?? 0n);
    let income = 0n, expense = 0n;
    for (const r of pnl(id, monthStart, t).values()) { income += r.income; expense += r.expense; }
    const locked = db.periods.filter((p) => p.companyId === id && p.lockedAt).map((p) => p.endDate).sort().at(-1) ?? null;
    const es = db.entries.filter((e) => e.companyId === id);
    return {
      asOf: t, cash: bal(SYSTEM_ACCOUNTS.cash), receivables: bal(SYSTEM_ACCOUNTS.receivables), payables: bal(SYSTEM_ACCOUNTS.payables),
      inputVat: bal(SYSTEM_ACCOUNTS.inputVat), outputVat: bal(SYSTEM_ACCOUNTS.outputVat),
      monthIncome: s(income), monthExpense: s(expense), monthProfit: s(income - expense),
      entries: es.length, entriesThisMonth: es.filter((e) => e.date >= monthStart).length, lockedUpTo: locked,
    };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/entries$/, (m, _b, q) => {
    const id = m[1]!; member(id);
    const needle = (q.get('q') ?? '').trim();
    return db.entries
      .filter((e) => e.companyId === id && (!needle || (e.memo ?? '').toLowerCase().includes(needle.toLowerCase())
        || e.lines.some((l) => s(l.debit) === needle || s(l.credit) === needle)))
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))
      .slice(0, 200)
      .map((e) => ({
        id: e.id, date: e.date, memo: e.memo, createdBy: db.users.find((u) => u.id === e.createdBy)?.name ?? null,
        reversesEntryId: e.reversesEntryId, reversedById: db.entries.find((x) => x.reversesEntryId === e.id)?.id ?? null,
        lines: [...e.lines].sort((a, b) => (b.debit > a.debit ? 1 : b.debit < a.debit ? -1 : 0)).map((l) => {
          const a = db.accounts.find((x) => x.id === l.accountId)!;
          const cc = db.costCentres.find((x) => x.id === l.costCentreId);
          return { id: l.id, accountCode: a.code, accountName: a.name, accountNameAr: a.nameAr, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null, debit: s(l.debit), credit: s(l.credit) };
        }),
      }));
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/entries$/, (m, b) => {
    const id = m[1]!; const { u } = member(id);
    const raw = Array.isArray(b?.lines) ? (b!.lines as Record<string, string | null | undefined>[]) : [];
    let lines: Omit<Line, 'id'>[];
    try {
      lines = raw.map((l) => ({ accountId: String(l.accountId), costCentreId: l.costCentreId ?? null, debit: toMinor(l.debit ?? '0'), credit: toMinor(l.credit ?? '0') }));
    } catch { return fail(400, 'Amounts must be numbers with at most 2 decimals.', 'err.amountFormat'); }
    return { id: post(u.id, id, String(b?.entryDate ?? ''), typeof b?.memo === 'string' ? b.memo : null, lines) };
  }],
  ['POST', /^\/api\/entries\/([\w-]+)\/reverse$/, (m, b) => ({ id: reverse(me().id, m[1]!, String(b?.date ?? today())) })],
  ['POST', /^\/api\/companies\/([\w-]+)\/periods\/([\d-]+)\/lock$/, (m, b) => {
    const { role } = member(m[1]!);
    if (role !== 'partner') fail(403, 'Only the Firm partner can lock or unlock periods.', 'err.lockPartner');
    const p = db.periods.find((x) => x.companyId === m[1] && x.startDate === m[2]);
    if (!p) fail(404, 'Not found.', 'err.notFound');
    p!.lockedAt = b?.locked ? new Date().toISOString() : null;
    return { ok: true };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/reports\/trial-balance$/, (m, _b, q) => {
    const id = m[1]!; member(id);
    const asOf = q.get('asOf') || today();
    const b = balances(id, asOf);
    const rows = db.accounts.filter((a) => a.companyId === id && (b.get(a.id) ?? 0n) !== 0n).sort((x, y) => x.code.localeCompare(y.code))
      .map((a) => { const v = b.get(a.id)!; return { accountId: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, debit: s(v > 0n ? v : 0n), credit: s(v < 0n ? -v : 0n) }; });
    return { asOf, rows };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/reports\/profit-and-loss$/, (m, _b, q) => {
    const id = m[1]!; member(id);
    const to = q.get('to') || today(), from = q.get('from') || `${to.slice(0, 4)}-01-01`;
    const rows = pnl(id, from, to);
    let income = 0n, expense = 0n;
    const byCostCentre = [...rows.entries()].map(([ccId, r]) => {
      income += r.income; expense += r.expense;
      const cc = db.costCentres.find((x) => x.id === ccId);
      return { costCentreId: ccId, name: cc?.name ?? null, nameAr: cc?.nameAr ?? null, income: s(r.income), expense: s(r.expense), profit: s(r.income - r.expense) };
    }).sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
    return { from, to, total: { income: s(income), expense: s(expense), profit: s(income - expense) }, byCostCentre };
  }],
  ['GET', /^\/api\/config$/, () => ({ demoLogins: true, demoPassword: DEMO_PASSWORD, minPassword: 10, publicUrl: '' })],
  // ---------------------------------------------------------------- expenses
  ['POST', /^\/api\/documents\/([\w-]+)\/void$/, (m, b) => {
    const d = docOf(m[1]!); canPostIn(d.companyId);
    if (d.type !== 'expense') fail(400, 'Only expenses can be voided.', 'err.format');
    if (d.status === 'voided') fail(400, 'This expense has already been voided.', 'err.alreadyVoided');
    if (d.status !== 'issued') fail(400, 'Only recorded expenses can be voided.', 'err.notIssued');
    reverse(session!, d.journalEntryId!, String(b?.date ?? today()));
    d.status = 'voided'; d.voidedAt = new Date().toISOString();
    return { ok: true };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/recurring$/, (m) => { const id = inCo(m[1]!); return sdb.recurring.filter((r) => r.companyId === id)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.nextDate.localeCompare(b.nextDate)).map(recRow); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/recurring$/, (m, b) => ({ id: saveRecurringM(inCo(m[1]!), b ?? {}) })],
  ['POST', /^\/api\/companies\/([\w-]+)\/recurring\/generate$/, (m) => ({ created: generateM(inCo(m[1]!)) })],
  ['GET', /^\/api\/recurring\/([\w-]+)$/, (m) => recRow(sdb.recurring.find((r) => r.id === m[1] && roleOf(session, r.companyId)) ?? fail(404, 'Not found.', 'err.notFound'))],
  ['POST', /^\/api\/recurring\/([\w-]+)$/, (m, b) => { const r = sdb.recurring.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
    return { id: saveRecurringM(r.companyId, b ?? {}, r.id) }; }],
  ['POST', /^\/api\/recurring\/([\w-]+)\/generate$/, (m) => { const r = sdb.recurring.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
    return { created: generateM(r.companyId, r.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/expense-categories$/, (m) => {
    const id = inCo(m[1]!); return spentByAccount(id, `${today().slice(0, 4)}-01-01`, today()).map(({ v: _v, ...r }) => r); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/expense-categories$/, (m, b) => {
    const id = inCo(m[1]!); canPostIn(id);
    const name = String(b?.name ?? '').trim();
    if (!name) fail(400, 'Enter the category name.', 'err.categoryName');
    const codes = db.accounts.filter((a) => a.companyId === id && /^5\d{3}$/.test(a.code)).map((a) => Number(a.code)).sort((x, y) => y - x);
    const last = codes[0] ?? 5000; const code = last + 100 <= 5999 ? Math.floor(last / 100) * 100 + 100 : last + 1;
    const aid = uid();
    db.accounts.push({ id: aid, companyId: id, code: String(code), name, nameAr: String(b?.nameAr ?? '').trim() || null, type: 'expense', costCentreRequired: Boolean(b?.costCentreRequired), isBank: false });
    return { id: aid };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/expense-overview$/, (m) => {
    const id = inCo(m[1]!); const t0 = today(); const ms = `${t0.slice(0, 7)}-01`;
    const prev = new Date(`${ms}T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1);
    const pe = new Date(Date.parse(`${ms}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const cur = spentByAccount(id, ms, t0); const last = spentByAccount(id, prev.toISOString().slice(0, 10), pe);
    const rec = sdb.recurring.filter((r) => r.companyId === id && r.active);
    return { spentThisMonth: s(cur.reduce((x, r) => x + r.v, 0n)), spentLastMonth: s(last.reduce((x, r) => x + r.v, 0n)),
      drafts: sdb.docs.filter((d) => d.companyId === id && d.type === 'expense' && d.status === 'draft').length,
      recurringDue: rec.filter((r) => r.nextDate <= t0 && (!r.endDate || r.nextDate <= r.endDate)).length, recurringActive: rec.length,
      topCategories: cur.filter((r) => r.v > 0n).sort((a, b) => (b.v > a.v ? 1 : -1)).slice(0, 6).map(({ v: _v, ...r }) => r) };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/reports\/expenses-by-category$/, (m, _b, q) => {
    const id = inCo(m[1]!); const to = q.get('to') || today(); const from = q.get('from') || `${to.slice(0, 4)}-01-01`;
    const rows = spentByAccount(id, from, to).filter((r) => r.v !== 0n);
    return { from, to, rows: rows.map(({ v: _v, ...r }) => r), total: s(rows.reduce((x, r) => x + r.v, 0n)) };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/reports\/expenses-by-payee$/, (m, _b, q) => {
    const id = inCo(m[1]!); const to = q.get('to') || today(); const from = q.get('from') || `${to.slice(0, 4)}-01-01`;
    const groups = new Map<string, { name: string; nameAr: string | null; contactId: string | null; documents: number; net: bigint; vat: bigint; gross: bigint }>();
    for (const d of sdb.docs.filter((x) => x.companyId === id && ['bill', 'expense', 'supplier_credit'].includes(x.type) && x.status === 'issued' && x.issueDate >= from && x.issueDate <= to)) {
      const c = sdb.contacts.find((x) => x.id === d.contactId); const name = c?.name ?? d.payee ?? ''; const sign = d.type === 'supplier_credit' ? -1n : 1n; const t = docTotals(d);
      const g = groups.get(name) ?? { name, nameAr: c?.nameAr ?? null, contactId: c?.id ?? null, documents: 0, net: 0n, vat: 0n, gross: 0n };
      if (d.type !== 'supplier_credit') g.documents++;
      g.net += sign * t.net; g.vat += sign * t.vat; g.gross += sign * t.gross; groups.set(name, g);
    }
    const rows = [...groups.values()].sort((a, b) => (b.net > a.net ? 1 : -1));
    const tot = (k: 'net' | 'vat' | 'gross') => s(rows.reduce((x, r) => x + r[k], 0n));
    return { from, to, rows: rows.map((r) => ({ ...r, net: s(r.net), vat: s(r.vat), gross: s(r.gross) })), total: { net: tot('net'), vat: tot('vat'), gross: tot('gross') } };
  }],
  // ---------------------------------------------------------------- sales and purchases
  ['GET', /^\/api\/companies\/([\w-]+)\/contacts$/, (m, _b, q) => {
    const id = inCo(m[1]!); const role = q.get('role') === 'supplier' ? 'isSupplier' : 'isCustomer'; const needle = (q.get('q') ?? '').trim().toLowerCase();
    return sdb.contacts.filter((c) => c.companyId === id && c[role] && (!needle || [c.name, c.nameAr, c.vatNumber].join(' ').toLowerCase().includes(needle)))
      .sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)).map(contactRow);
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/contacts$/, (m, b) => ({ id: saveContactM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/contacts\/([\w-]+)$/, (m) => { const c = sdb.contacts.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { ...contactRow(c) }; }],
  ['POST', /^\/api\/contacts\/([\w-]+)$/, (m, b) => { const c = sdb.contacts.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { id: saveContactM(c.companyId, b ?? {}, c.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/documents$/, (m, _b, q) => {
    const id = inCo(m[1]!); const type = q.get('type'); const st = q.get('status') ?? 'all'; const needle = (q.get('q') ?? '').trim().toLowerCase(); const cid = q.get('contactId');
    return sdb.docs.filter((d) => d.companyId === id && d.type === type && (!cid || d.contactId === cid)).map(docRow)
      .filter((d) => !needle || [d.contactName, d.number, d.reference].join(' ').toLowerCase().includes(needle))
      .filter((d) => st === 'all' || d.state === st || (st === 'unpaid' && ['unpaid', 'partly_paid', 'overdue'].includes(d.state)))
      .sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt));
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/documents$/, (m, b) => {
    if (b?.type === 'credit_note' || b?.type === 'supplier_credit') fail(400, 'Create credit notes from the invoice or bill.', 'err.format');
    return { id: saveDraftM(inCo(m[1]!), { ...b, originalId: null }) };
  }],
  ['GET', /^\/api\/documents\/([\w-]+)$/, (m) => {
    const d = docOf(m[1]!); const c = sdb.contacts.find((x) => x.id === d.contactId) ?? null; const co = db.companies.find((x) => x.id === d.companyId)!;
    return { ...docRow(d), contact: c, seller: { name: co.name, nameAr: co.nameAr, vatNumber: co.vatNumber, crNumber: co.crNumber, address: co.fields.address ?? '', city: co.city, country: co.country, currency: co.currency },
      lines: d.lines.map((l, i) => { const a = db.accounts.find((x) => x.id === l.accountId)!; const cc = db.costCentres.find((x) => x.id === l.costCentreId);
        return { id: l.id, lineNo: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: a.id, accountCode: a.code, accountName: a.name, accountNameAr: a.nameAr,
          costCentreId: l.costCentreId ?? null, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null, vatCode: l.vatCode, vatRate: l.vatRate, net: s(l.net), vat: s(l.vat) }; }),
      payments: sdb.payments.filter((p) => p.allocations.some((a) => a.documentId === d.id)).map((p) => ({ id: p.id, number: p.number, date: p.date, amount: s(p.allocations.find((a) => a.documentId === d.id)!.amount), method: p.method, voidedAt: p.voidedAt })),
      related: sdb.docs.filter((x) => (x.originalId === d.id || x.id === d.originalId) && x.id !== d.id).map((x) => ({ id: x.id, type: x.type, status: x.status, number: x.number, issueDate: x.issueDate, grossTotal: s(docTotals(x).gross) })) };
  }],
  ['POST', /^\/api\/documents\/([\w-]+)$/, (m, b) => { const d = docOf(m[1]!); return { id: saveDraftM(d.companyId, { ...b, type: d.type, originalId: d.originalId }, d.id) }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/delete$/, (m) => { const d = docOf(m[1]!); canPostIn(d.companyId); if (d.status !== 'draft') fail(400, 'Only drafts can be deleted.', 'err.notDraft'); sdb.docs = sdb.docs.filter((x) => x.id !== d.id); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/issue$/, (m) => { issueM(m[1]!); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/quotation-status$/, (m, b) => { quoteStatusM(m[1]!, String(b?.status)); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/convert$/, (m) => ({ id: convertM(m[1]!) })],
  ['POST', /^\/api\/documents\/([\w-]+)\/credit$/, (m) => ({ id: creditM(m[1]!) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/payments$/, (m, _b, q) => {
    const id = inCo(m[1]!); const dir = q.get('direction'); const needle = (q.get('q') ?? '').trim().toLowerCase(); const cid = q.get('contactId');
    return sdb.payments.filter((p) => p.companyId === id && p.direction === dir && (!cid || p.contactId === cid)).map(payRow)
      .filter((p) => !needle || [p.contactName, p.number, p.reference].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/payments$/, (m, b) => ({ id: payM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/payments\/([\w-]+)$/, (m) => {
    const p = payOf(m[1]!);
    return { ...payRow(p), allocations: p.allocations.map((a) => { const d = sdb.docs.find((x) => x.id === a.documentId)!;
      return { documentId: d.id, number: d.number, type: d.type, issueDate: d.issueDate, grossTotal: s(docTotals(d).gross), amount: s(a.amount) }; }) };
  }],
  ['POST', /^\/api\/payments\/([\w-]+)\/void$/, (m, b) => {
    const p = payOf(m[1]!); canPostIn(p.companyId);
    if (p.voidedAt) fail(400, 'This payment has already been voided.', 'err.alreadyVoided');
    reverse(session!, p.journalEntryId, String(b?.date ?? today())); p.voidedAt = new Date().toISOString(); return { ok: true };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/open-documents$/, (m, _b, q) => {
    const id = inCo(m[1]!); const type = q.get('direction') === 'made' ? 'bill' : 'invoice';
    return sdb.docs.filter((d) => d.companyId === id && d.contactId === q.get('contactId') && d.type === type && d.status === 'issued' && amountDue(d) > 0n)
      .sort((a, b) => (a.dueDate ?? a.issueDate).localeCompare(b.dueDate ?? b.issueDate))
      .map((d) => ({ id: d.id, number: d.number, issueDate: d.issueDate, dueDate: d.dueDate, grossTotal: s(docTotals(d).gross), amountDue: s(amountDue(d)) }));
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/overview$/, (m, _b, q) => {
    const id = inCo(m[1]!); const sales = q.get('side') !== 'purchases'; const main = sales ? 'invoice' : 'bill'; const credit = sales ? 'credit_note' : 'supplier_credit';
    const monthStart = `${today().slice(0, 7)}-01`;
    const open = sdb.docs.filter((d) => d.companyId === id && d.type === main && d.status === 'issued' && amountDue(d) > 0n).map(docRow);
    const overdue = open.filter((d) => d.state === 'overdue');
    const sum = (xs: { amountDue: string }[]) => s(xs.reduce((x, d) => x + toMinor(d.amountDue), 0n));
    const month = sdb.docs.filter((d) => d.companyId === id && d.status === 'issued' && d.issueDate >= monthStart && (d.type === main || d.type === credit))
      .reduce((x, d) => x + (d.type === main ? 1n : -1n) * docTotals(d).net, 0n);
    const paid = sdb.payments.filter((p) => p.companyId === id && p.direction === (sales ? 'received' : 'made') && !p.voidedAt && p.date >= monthStart).reduce((x, p) => x + p.amount, 0n);
    return { outstanding: sum(open), outstandingCount: open.length, overdue: sum(overdue), overdueCount: overdue.length, thisMonthNet: s(month), paidThisMonth: s(paid),
      drafts: sdb.docs.filter((d) => d.companyId === id && d.type === main && d.status === 'draft').length,
      oldestOverdue: overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, 6) };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/reports\/aged$/, (m, _b, q) => {
    const id = inCo(m[1]!); const asOf = q.get('asOf') || today(); const type = q.get('side') === 'purchases' ? 'bill' : 'invoice';
    const rows = new Map<string, { contactId: string; name: string; nameAr: string | null; b: Record<AgeBucket, bigint> }>();
    for (const d of sdb.docs.filter((x) => x.companyId === id && x.type === type && x.status === 'issued' && x.issueDate <= asOf)) {
      const due = amountDue(d); if (due === 0n) continue;
      const c = sdb.contacts.find((x) => x.id === d.contactId)!;
      const r = rows.get(c.id) ?? { contactId: c.id, name: c.name, nameAr: c.nameAr, b: Object.fromEntries(AGE_BUCKETS.map((k) => [k, 0n])) as Record<AgeBucket, bigint> };
      r.b[ageBucket(d.dueDate ?? d.issueDate, asOf)] += due; rows.set(c.id, r);
    }
    return { asOf, rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ contactId: r.contactId, name: r.name, nameAr: r.nameAr,
      ...Object.fromEntries(AGE_BUCKETS.map((k) => [k, s(r.b[k])])), total: s(AGE_BUCKETS.reduce((x, k) => x + r.b[k], 0n)) })) };
  }],
  ['GET', /^\/api\/admin\/companies$/, () => {
    admin();
    return [...db.companies].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
      ...companyView(c), crNumber: c.crNumber, vatStatus: c.vatStatus, vatNumber: c.vatNumber, city: c.city, status: c.status,
      clientUsers: db.memberships.filter((m) => m.companyId === c.id && db.users.find((u) => u.id === m.userId && u.kind === 'client' && u.status === 'active')).length,
      staff: staffOf(c.id).filter((u) => u.status === 'active').map((u) => u.name).sort(),
    }));
  }],
  ['GET', /^\/api\/admin\/companies\/([\w-]+)$/, (m) => {
    admin();
    const c = company(m[1]!);
    return {
      company: { ...c.fields, id: c.id, name: c.name, nameAr: c.nameAr ?? '', country: c.country, currency: c.currency, crNumber: c.crNumber,
        vatStatus: c.vatStatus, vatNumber: c.vatNumber ?? '', vatRate: c.vatRate, city: c.city, invoicePrefix: c.invoicePrefix,
        paymentTermsDays: String(c.paymentTermsDays), status: c.status },
      users: db.memberships.filter((x) => x.companyId === c.id).map((x) => ({ x, u: db.users.find((u) => u.id === x.userId)! }))
        .filter(({ u }) => u.kind === 'client').map(({ x, u }) => ({ ...person(u), role: x.role })),
      staff: db.users.filter((u) => u.kind === 'firm_staff').map((u) => ({ id: u.id, name: u.name, role: u.staffRole, status: u.status,
        assigned: db.memberships.some((x) => x.userId === u.id && x.companyId === c.id) })),
    };
  }],
  ['POST', /^\/api\/admin\/companies$/, (_m, b) => {
    admin();
    const c = (b?.company ?? {}) as Record<string, string | undefined>;
    const country = (c.country ?? '').trim() as Company['country'];
    const d = { SA: ['SAR', '15.00'], AE: ['AED', '5.00'], OM: ['OMR', '5.00'] }[country];
    if (!d) fail(400, 'Choose the country.', 'err.country');
    const fu = (b?.firstUser ?? {}) as Record<string, string | undefined>;
    if (!(fu.name ?? '').trim() || !(fu.email ?? '').trim()) fail(400, 'Add the first client user (name and email).', 'err.firstClientUser');
    emailFree(fu.email!);
    const id = uid();
    const co: Company = { id, country, currency: d![0]!, status: 'active', name: '', nameAr: null, vatRate: '0', vatStatus: 'registered', vatNumber: null,
      crNumber: '', city: '', invoicePrefix: 'INV-', paymentTermsDays: 30, fields: {} };
    applyCompany(co, c);
    db.companies.push(co);
    const user = addUser(fu.name!, fu.email!, 'client', null);
    db.memberships.push({ userId: user.id, companyId: id, role: fu.role === 'client_viewer' ? 'client_viewer' : 'client_accountant' });
    logActivity('act.clientAdded', { client: co.name });
    for (const sid of (b?.staffIds as string[] | undefined) ?? []) assign(sid, id, true);
    setupBooks(id);
    return { id, invite: newInvite(user) };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)$/, (m, b) => {
    admin();
    const c = company(m[1]!);
    applyCompany(c, { ...(b?.company as Record<string, string | undefined>), country: c.country });
    logActivity('act.clientUpdated', { client: c.name });
    return { ok: true };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)\/status$/, (m, b) => {
    admin();
    const c = company(m[1]!);
    c.status = b?.active ? 'active' : 'suspended';
    logActivity(b?.active ? 'act.clientReactivated' : 'act.clientSuspended', { client: c.name });
    return { ok: true };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)\/users$/, (m, b) => {
    admin();
    const c = company(m[1]!);
    const name = String(b?.name ?? '').trim(), email = String(b?.email ?? '').trim();
    if (!name || !email) fail(400, 'Enter the name and email.', 'err.nameEmail');
    emailFree(email);
    const u = addUser(name, email, 'client', null);
    db.memberships.push({ userId: u.id, companyId: c.id, role: b?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant' });
    return { invite: newInvite(u) };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)\/staff$/, (m, b) => { admin(); return assign(String(b?.userId), m[1]!, Boolean(b?.assigned)); }],
  ['GET', /^\/api\/admin\/staff$/, () => {
    admin();
    return db.users.filter((u) => u.kind === 'firm_staff').sort((a, b) => a.name.localeCompare(b.name)).map((u) => {
      const ms = db.memberships.filter((x) => x.userId === u.id);
      return { ...person(u), role: u.staffRole, clientIds: ms.map((x) => x.companyId),
        clients: ms.map((x) => db.companies.find((c) => c.id === x.companyId)!.name).sort() };
    });
  }],
  ['POST', /^\/api\/admin\/staff$/, (_m, b) => {
    admin();
    const name = String(b?.name ?? '').trim(), email = String(b?.email ?? '').trim(), role = String(b?.role ?? '') as Role;
    if (!name || !email) fail(400, 'Enter the name and email.', 'err.nameEmail');
    if (!['partner', 'reviewer', 'staff_accountant'].includes(role)) fail(400, 'Choose the role.', 'err.role');
    emailFree(email);
    const u = addUser(name, email, 'firm_staff', role);
    for (const cid of (b?.clientIds as string[] | undefined) ?? []) assign(u.id, cid, true);
    return { invite: newInvite(u) };
  }],
  ['POST', /^\/api\/admin\/users\/([\w-]+)\/status$/, (m, b) => {
    const a = admin();
    if (m[1] === a.id) fail(400, 'You cannot suspend yourself.', 'err.selfSuspend');
    const u = user(m[1]!);
    u.status = b?.active ? 'active' : 'suspended';
    logActivity(b?.active ? 'act.userReactivated' : 'act.userSuspended', { name: u.name });
    return { ok: true };
  }],
  ['POST', /^\/api\/admin\/users\/([\w-]+)\/invite$/, (m) => {
    admin();
    const u = user(m[1]!);
    if (u.status !== 'active') fail(400, 'Reactivate this person first.', 'err.inviteSuspended');
    return { invite: newInvite(u) };
  }],
  ['POST', /^\/api\/admin\/users\/([\w-]+)\/reset-two-factor$/, (m) => {
    admin();
    const u = user(m[1]!);
    u.twoFactor = false;
    logActivity('act.twoFactorReset', { name: u.name });
    return { ok: true };
  }],
  ['GET', /^\/api\/admin\/activity$/, () => { admin(); return db.activity.slice(0, 300); }],
  ['GET', /^\/api\/admin\/settings$/, () => {
    admin();
    const active = db.users.filter((u) => u.status === 'active');
    return { firmName: db.firmName, users: { total: db.users.length, active: active.length, suspended: db.users.length - active.length,
      twoFactor: active.filter((u) => u.twoFactor).length, invitesPending: active.filter((u) => u.inviteToken).length,
      neverSignedIn: active.filter((u) => !u.password).length } };
  }],
  ['POST', /^\/api\/admin\/settings$/, (_m, b) => {
    admin();
    const name = String(b?.firmName ?? '').trim();
    if (!name) fail(400, 'Enter the firm name.', 'err.firmName');
    db.firmName = name;
    logActivity('act.firmRenamed', { name });
    return { ok: true };
  }],
  ['GET', /^\/api\/invite\/([\w-]+)$/, (m) => {
    const u = db.users.find((x) => x.inviteToken === m[1] && x.status === 'active');
    if (!u) return fail(404, 'This link has expired or was already used.', 'err.inviteInvalid');
    return { name: u.name, email: u.email };
  }],
  ['POST', /^\/api\/invite\/([\w-]+)$/, (m, b) => {
    const u = db.users.find((x) => x.inviteToken === m[1] && x.status === 'active');
    if (!u) return fail(404, 'This link has expired or was already used.', 'err.inviteInvalid');
    const pw = String(b?.password ?? '');
    if (pw.length < 10) fail(400, 'Use at least 10 characters.', 'err.passwordShort');
    u.password = pw; u.inviteToken = null;
    db.activity.unshift({ id: uid(), at: new Date().toISOString(), actor: u.name, key: 'act.passwordSet', params: { name: u.name } });
    return { ok: true };
  }],
];

// Sample data is created once everything above is defined.
seed();
db.activity.push({ id: uid(), at: new Date().toISOString(), actor: null, key: 'act.firmCreated', params: { name: DEMO_FIRM } });

export function handle(method: string, url: string, body: unknown): { status: number; data: unknown } {
  const [path, qs] = url.split('?') as [string, string | undefined];
  try {
    for (const [m, re, h] of routes) {
      const match = path.match(re);
      if (match && m === method) return { status: 200, data: JSON.parse(JSON.stringify(h(match, body as Body, new URLSearchParams(qs ?? '')))) };
    }
    return { status: 404, data: { error: 'Not found.', key: 'err.notFound' } };
  } catch (e) {
    if (e instanceof Fail) return { status: e.status, data: { error: e.message, key: e.key, details: e.details } };
    return { status: 500, data: { error: 'Something went wrong. Please try again.', key: 'err.server' } };
  }
}
