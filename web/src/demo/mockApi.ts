// Demo build only: answers the same /api requests as src/api/server.ts, from sample data held in
// this browser page. It repeats the database's rules (balance, two lines, cost centres, locked
// periods, roles, company separation, registration checks) so the preview behaves like the app.
// It is NOT the source of truth: the real rules live in db/migrations and are covered by `npm test`.
// Data resets when the page reloads.
import { toMinor, fromMinor, divRoundHalfUp } from '../../../src/money.ts';
import { vatForLine } from '../../../src/vat/vat.ts';
import { CHART_TEMPLATE, SYSTEM_ACCOUNTS } from '../../../src/books/chartTemplate.ts';
import { DEMO_COMPANIES, DEMO_FIRM, DEMO_PASSWORD, DEMO_RESTAURANT, DEMO_ROLES, DEMO_USERS } from '../../../src/db/demoData.ts';
import { accessTo, cleanModules, DEFAULT_MODULES, isIndustry, ROLE_MODULES, type AccessLevel, type Industry } from '../../../src/books/modules.ts';
import {
  addDays, AGE_BUCKETS, ageBucket, nextOccurrence, type Frequency, documentTotals, formatNumber, isCredit, numberPrefix, postingFor, postingForPayment, priceLine, sideOf,
  type AgeBucket, type Direction, type DocType, type LineInput, type PricedLine,
} from '../../../src/books/documents.ts';
import { autoAllocate, netFromGross, milliToString, quantityToMilli } from '../../../src/books/documents.ts';
import { bankFromIban, fingerprints, ibanValid, normaliseIban, similarity, type Layout, type StatementRow } from '../../../src/bank/statement.ts';
import { averageCost, issueCost, notePrefix, receivedValue, type NoteType } from '../../../src/books/inventory.ts';
import { depreciationDue, disposalResult, monthEnd, monthStart, nextMonthEnd, previousMonthEnd, targetDepreciation, type AssetTerms } from '../../../src/books/assets.ts';

type Role = 'partner' | 'reviewer' | 'staff_accountant' | 'client_accountant' | 'client_viewer';
interface User {
  id: string; name: string; email: string; kind: 'admin' | 'firm_staff' | 'client'; staffRole: Role | null; twoFactor: boolean;
  status: 'active' | 'suspended'; password: string | null; inviteToken: string | null;
}
interface Company {
  id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string;
  vatStatus: 'registered' | 'unregistered'; vatNumber: string | null; crNumber: string; city: string;
  invoicePrefix: string; paymentTermsDays: number; status: 'active' | 'suspended';
  industry: string; modules: string[];
  fields: Record<string, string>;   // the rest of the registration form, as entered
}
interface Account { id: string; companyId: string; code: string; name: string; nameAr: string | null; type: string; costCentreRequired: boolean; isBank: boolean; pnlGroup?: string | null }
interface CostCentre { id: string; companyId: string; name: string; nameAr: string | null; kind: string; status?: string; budget?: string | null; contactId?: string | null;
  startDate?: string | null; endDate?: string | null; description?: string | null }
interface Period { companyId: string; startDate: string; endDate: string; lockedAt: string | null }
interface Line { id: string; accountId: string; costCentreId: string | null; debit: bigint; credit: bigint }
interface Entry { id: string; companyId: string; date: string; memo: string | null; createdBy: string; createdAt: string; reversesEntryId: string | null; lines: Line[] }
interface Membership { userId: string; companyId: string; role: Role; clientRoleId?: string | null }
interface ClientRole { id: string; name: string; nameAr: string | null; description: string | null; permissions: Record<string, AccessLevel>; canApprove: boolean; status: 'active' | 'archived' }
const rolesDb: ClientRole[] = [];
const roleBase = (p: Record<string, AccessLevel>): Role => (Object.values(p).includes('edit') ? 'client_accountant' : 'client_viewer');
/** The line of the profit and loss an account sits on (same defaults as db/migrations/0016). */
function pnlGroupOf(a: Account): string | null {
  if (a.type === 'income') return a.pnlGroup === 'revenue' || a.pnlGroup === 'other_income' ? a.pnlGroup : a.code >= '4800' ? 'other_income' : 'revenue';
  if (a.type === 'expense') return a.pnlGroup === 'cost_of_sales' || a.pnlGroup === 'indirect_expense' ? a.pnlGroup : a.code === '5000' ? 'cost_of_sales' : 'indirect_expense';
  return null;
}
/** The signed-in person's client role in a company, if they have one. */
function clientRoleIn(companyId: string): ClientRole | null {
  const id = db.memberships.find((m) => m.userId === session && m.companyId === companyId)?.clientRoleId;
  return id ? rolesDb.find((r) => r.id === id) ?? null : null;
}

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
      industry: c.industry, modules: [...DEFAULT_MODULES[c.industry]], fields: { legalForm: c.legalForm, address: c.address, fyEnd: '12-31' } });
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
  isEmployee: boolean; employeeNo: string | null; jobTitle: string | null; defaultCostCentreId: string | null;
}
interface MDoc {
  id: string; companyId: string; type: DocType; status: string; number: string | null; contactId: string | null; issueDate: string; dueDate: string | null;
  reference: string | null; notes: string | null; originalId: string | null; journalEntryId: string | null; lines: (PricedLine & { id: string })[]; createdAt: string;
  payee?: string | null; paidFromAccountId?: string | null; recurringId?: string | null; voidedAt?: string | null;
  submittedBy?: string | null; decidedBy?: string | null; rejectionReason?: string | null;
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
  return { receivables: a('1100'), payables: a('2000'), outputVat: a('2100'), inputVat: a('1200'), claimsPayable: a('2200') };
};
const docTotals = (d: MDoc) => documentTotals(d.lines);
function amountDue(d: MDoc): bigint {
  if (!['invoice', 'bill', 'claim'].includes(d.type) || d.status !== 'issued') return 0n;   // expenses are paid at once
  const paid = sdb.payments.filter((p) => !p.voidedAt).flatMap((p) => p.allocations).filter((a) => a.documentId === d.id).reduce((s, a) => s + a.amount, 0n);
  const credited = sdb.docs.filter((c) => c.originalId === d.id && isCredit(c.type) && c.status === 'issued').reduce((s, c) => s + docTotals(c).gross, 0n);
  return docTotals(d).gross - paid - credited;
}
function stateOfDoc(d: MDoc): string {
  if (d.type === 'quotation' || d.type === 'expense' || d.status === 'draft' || isCredit(d.type)) return d.status;
  if (d.type === 'claim') return d.status !== 'issued' ? d.status : amountDue(d) > 0n ? 'approved' : 'reimbursed';
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
    journalEntryId: d.journalEntryId, netTotal: s(t.net), vatTotal: s(t.vat), grossTotal: s(t.gross), amountDue: s(amountDue(d)), createdAt: d.createdAt,
    submittedBy: d.submittedBy ?? null, submittedByName: db.users.find((u) => u.id === d.submittedBy)?.name ?? null,
    decidedByName: db.users.find((u) => u.id === d.decidedBy)?.name ?? null, rejectionReason: d.rejectionReason ?? null };
}
function saveContactM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const t = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
  if (!t('name')) fail(400, 'Enter the name.', 'err.contactName');
  if (!b.isCustomer && !b.isSupplier && !b.isEmployee) fail(400, 'Choose customer, supplier or both.', 'err.contactRole');
  if (b.isEmployee && (b.isCustomer || b.isSupplier)) fail(400, 'An employee cannot also be a customer or supplier.', 'err.employeeOnly');
  if (b.isEmployee && t('employeeNo') && sdb.contacts.some((c) => c.companyId === companyId && c.id !== id && c.employeeNo === t('employeeNo')))
    fail(400, 'Another employee already has this employee number.', 'err.employeeNoTaken');
  const country = t('country')?.toUpperCase() ?? null, vat = t('vatNumber')?.replace(/\s/g, '') ?? null;
  if (vat && country === 'SA' && !/^3\d{13}3$/.test(vat)) fail(400, 'A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat');
  if (vat && country === 'AE' && !/^\d{15}$/.test(vat)) fail(400, 'A UAE TRN has 15 digits.', 'err.aeTrn');
  const terms = b.paymentTermsDays === '' || b.paymentTermsDays == null ? null : Number(b.paymentTermsDays);
  const v: Omit<MContact, 'id' | 'companyId'> = { isCustomer: Boolean(b.isCustomer), isSupplier: Boolean(b.isSupplier), name: t('name')!, nameAr: t('nameAr'),
    vatNumber: vat, crNumber: t('crNumber'), email: t('email'), phone: t('phone'), address: t('address'), city: t('city'), country, paymentTermsDays: terms,
    status: b.status === 'archived' ? 'archived' : 'active', isEmployee: Boolean(b.isEmployee), employeeNo: b.isEmployee ? t('employeeNo') : null,
    jobTitle: b.isEmployee ? t('jobTitle') : null, defaultCostCentreId: b.isEmployee ? (b.defaultCostCentreId as string) || null : null };
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
    if (side === 'purchases' && !['expense', 'asset'].includes(a!.type) && a!.code !== '2050') fail(400, 'Purchase lines use an expense or asset account.', 'err.purchaseAccount');
    try { return { ...priceLine({ ...l, description: String(l.description).trim() }, rate), id: uid() }; }
    catch { return fail(400, `Line ${i + 1}: check the quantity and price.`, 'err.lineNumbers'); }
  });
}
function saveDraftM(companyId: string, b: Record<string, unknown>, id?: string): string {
  canPostIn(companyId);
  const existing = id ? sdb.docs.find((d) => d.id === id) ?? fail(404, 'Not found.', 'err.notFound') : undefined;
  if (existing && existing.status !== 'draft') fail(400, 'Only drafts can be changed.', 'err.notDraft');
  const type = (existing?.type ?? b.type) as DocType;
  if (!['quotation', 'invoice', 'credit_note', 'bill', 'supplier_credit', 'expense', 'claim'].includes(type)) fail(400, 'Choose the document type.', 'err.format');
  const isExpense = type === 'expense';
  const contact = b.contactId ? sdb.contacts.find((c) => c.id === b.contactId && c.companyId === companyId) : undefined;
  if (!contact && !(isExpense && !b.contactId)) fail(400, 'Choose the customer or supplier.', 'err.contact');
  if (contact && (type === 'claim' ? !contact.isEmployee : sideOf(type) === 'sales' ? !contact.isCustomer : !contact.isSupplier))
    fail(400, type === 'claim' ? 'Choose an employee for this claim.' : 'Choose a customer or supplier of this company.', type === 'claim' ? 'err.pickEmployee' : 'err.contact');
  if (isExpense && b.paidFromAccountId && !db.accounts.some((a) => a.id === b.paidFromAccountId && a.companyId === companyId && a.isBank))
    fail(400, 'Choose one of this company\'s bank or cash accounts.', 'err.bankAccount');
  const issueDate = String(b.issueDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) fail(400, 'Enter the date.', 'err.date');
  const dueDate = b.dueDate ? String(b.dueDate) : null;
  if (dueDate && dueDate < issueDate) fail(400, 'The due date cannot be before the document date.', 'err.dueDate');
  const lines = priceLinesM(companyId, sideOf(type), b.lines as LineInput[]);
  const head = { contactId: contact?.id ?? null, issueDate, dueDate: isExpense ? null : dueDate, reference: (b.reference as string)?.trim() || null, notes: (b.notes as string)?.trim() || null, lines,
    payee: isExpense ? (b.payee as string)?.trim() || null : null, paidFromAccountId: isExpense ? (b.paidFromAccountId as string) || null : null };
  if (existing) { Object.assign(existing, { ...head, dueDate: type === 'claim' ? null : head.dueDate }); return existing.id; }
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
  if (d.type === 'claim') fail(400, 'Claims are submitted and approved, not issued.', 'err.format');
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
function submitClaimM(id: string) {
  const d = docOf(id); canPostIn(d.companyId);
  if (d.type !== 'claim' || d.status !== 'draft') fail(400, 'Only draft claims can be submitted.', 'err.notDraft');
  if (!d.lines.length) fail(400, 'Add at least one line.', 'err.noLines');
  if (!d.number) d.number = nextNo(d.companyId, 'claim', 'CLM-');
  d.status = 'submitted'; d.submittedBy = session; d.decidedBy = null; d.rejectionReason = null;
}
function decideM(id: string, approve: boolean, reason = '') {
  const d = docOf(id); canPostIn(d.companyId);
  if (d.type !== 'claim' || d.status !== 'submitted') fail(400, 'Only submitted claims can be approved or rejected.', 'err.claimNotSubmitted');
  if (d.submittedBy === session) fail(400, 'You submitted this claim, so someone else must approve or reject it.', 'err.selfApprove');
  if (!approve) {
    if (!reason.trim()) fail(400, 'Give a reason for rejecting the claim.', 'err.rejectReason');
    d.status = 'rejected'; d.decidedBy = session; d.rejectionReason = reason.trim(); return;
  }
  if (d.lines.some((l) => !l.costCentreId && db.accounts.find((a) => a.id === l.accountId)?.costCentreRequired))
    fail(400, 'A cost centre is required for one of the accounts used.', 'err.costCentreRequired');
  const c = sdb.contacts.find((x) => x.id === d.contactId)!;
  d.journalEntryId = post(session!, d.companyId, d.issueDate, `${d.number} · ${c.name}`,
    postingFor('claim', d.lines, sysAccts(d.companyId)).map((l) => ({ accountId: l.accountId, costCentreId: l.costCentreId ?? null, debit: toMinor(l.debit ?? '0'), credit: toMinor(l.credit ?? '0') })));
  d.status = 'issued'; d.decidedBy = session;
}
function reopenM(id: string) {
  const d = docOf(id); canPostIn(d.companyId);
  if (d.type !== 'claim' || !['submitted', 'rejected'].includes(d.status)) fail(400, 'Only submitted or rejected claims go back to draft.', 'err.format');
  d.status = 'draft'; d.submittedBy = null; d.decidedBy = null;
}

function payM(companyId: string, b: Record<string, unknown>) {
  canPostIn(companyId);
  const direction = b.direction === 'made' ? 'made' : 'received';
  const contact = sdb.contacts.find((c) => c.id === b.contactId && c.companyId === companyId && (direction === 'received' ? c.isCustomer : c.isSupplier || c.isEmployee));
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
    if (!d || d.contactId !== contact!.id || d.status !== 'issued' || d.type !== (direction === 'received' ? 'invoice' : contact!.isEmployee ? 'claim' : 'bill'))
      fail(400, 'A payment can only settle issued invoices (or bills) of the same customer (or supplier).', 'err.contact');
    if (a.amount <= 0n || a.amount > amountDue(d!)) fail(400, 'This is more than is due on the invoice.', 'err.overDue');
  }
  const date = String(b.date ?? '');
  const id = uid();
  const seq = direction === 'received' ? 'receipt' : 'payment';
  const number = nextNo(companyId, seq, numberPrefix(seq, ''));
  const entry = postingForPayment(direction, amount, bank!.id, sysAccts(companyId), contact!.isEmployee);
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
  const docs = sdb.docs.filter((d) => d.contactId === c.id && d.status === 'issued' && (c.isEmployee ? d.type === 'claim' : c.isCustomer ? d.type === 'invoice' : d.type === 'bill'));
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

// ------------------------------------------------------------------ ledgers and projects (same as src/books/ledgerService.ts)
/** Which document or payment each journal entry came from (reversals point to the same source). */
function entrySources(companyId: string) {
  const m = new Map<string, { contactId: string | null; number: string | null; sourceType: string; sourceId: string }>();
  for (const d of sdb.docs) if (d.companyId === companyId && d.journalEntryId) m.set(d.journalEntryId, { contactId: d.contactId, number: d.number, sourceType: 'document', sourceId: d.id });
  for (const p of sdb.payments) if (p.companyId === companyId) m.set(p.journalEntryId, { contactId: p.contactId, number: p.number, sourceType: 'payment', sourceId: p.id });
  for (const e of db.entries) if (e.companyId === companyId && e.reversesEntryId && m.has(e.reversesEntryId)) m.set(e.id, m.get(e.reversesEntryId)!);
  return m;
}
type Src = { contactId: string | null; number: string | null; sourceType: string; sourceId: string };
function lineRow(e: Entry, l: Line, src?: Src) {
  const a = db.accounts.find((x) => x.id === l.accountId)!; const cc = db.costCentres.find((x) => x.id === l.costCentreId);
  return { date: e.date, entryId: e.id, memo: e.memo, sourceType: src?.sourceType ?? null, sourceId: src?.sourceId ?? null, number: src?.number ?? null,
    accountCode: a.code, accountName: a.name, accountNameAr: a.nameAr, accountType: a.type, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null,
    debit: s(l.debit), credit: s(l.credit), d: l.debit, c: l.credit, at: e.createdAt };
}
type LRow = ReturnType<typeof lineRow>;
const strip = ({ d: _d, c: _c, at: _at, ...r }: LRow) => r;
function running(opening: bigint, rows: LRow[], sign: 1n | -1n) {
  let bal = opening; let td = 0n, tc = 0n;
  const out = rows.map((r) => { bal += sign * (r.d - r.c); td += r.d; tc += r.c; return { ...strip(r), balance: s(bal) }; });
  return { opening: s(opening), rows: out, closing: s(bal), totalDebit: s(td), totalCredit: s(tc) };
}
const byDate = (a: LRow, b: LRow) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at);
function rangeOf(q: URLSearchParams) { const to = q.get('to') || today(); return { from: q.get('from') || `${to.slice(0, 4)}-01-01`, to }; }
function accountLedgerM(companyId: string, accountId: string, from: string, to: string) {
  const acct = db.accounts.find((a) => a.id === accountId && a.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound');
  const sign: 1n | -1n = ['asset', 'expense'].includes(acct.type) ? 1n : -1n;
  const src = entrySources(companyId); let open = 0n; const rows: LRow[] = [];
  for (const e of db.entries) if (e.companyId === companyId) for (const l of e.lines) if (l.accountId === accountId) {
    if (e.date < from) open += l.debit - l.credit; else if (e.date <= to) rows.push(lineRow(e, l, src.get(e.id)));
  }
  return { account: { id: acct.id, code: acct.code, name: acct.name, nameAr: acct.nameAr, type: acct.type }, from, to, ...running(sign * open, rows.sort(byDate), sign) };
}
function costCentreLedgerM(companyId: string, ccId: string, from: string, to: string) {
  const cc = db.costCentres.find((x) => x.id === ccId && x.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound');
  const src = entrySources(companyId); const rows: LRow[] = []; let income = 0n, expense = 0n;
  for (const e of db.entries) if (e.companyId === companyId && e.date >= from && e.date <= to) for (const l of e.lines) if (l.costCentreId === ccId) {
    const r = lineRow(e, l, src.get(e.id)); rows.push(r);
    if (r.accountType === 'income') income += l.credit - l.debit;
    if (r.accountType === 'expense') expense += l.debit - l.credit;
  }
  rows.sort((a, b) => byDate(a, b) || a.accountCode.localeCompare(b.accountCode));
  return { costCentre: { id: cc.id, name: cc.name, nameAr: cc.nameAr, kind: cc.kind, budget: cc.budget ?? null }, from, to,
    rows: rows.map(strip), income: s(income), expense: s(expense), profit: s(income - expense) };
}
const controlFor = (c: MContact) => (c.isEmployee ? SYSTEM_ACCOUNTS.claimsPayable : c.isCustomer ? SYSTEM_ACCOUNTS.receivables : SYSTEM_ACCOUNTS.payables);
function contactLines(companyId: string, c: MContact) {
  const control = db.accounts.find((a) => a.companyId === companyId && a.code === controlFor(c))!.id; const src = entrySources(companyId);
  const out: { e: Entry; l: Line; src: Src }[] = [];
  for (const e of db.entries) { const x = src.get(e.id); if (e.companyId === companyId && x?.contactId === c.id) for (const l of e.lines) if (l.accountId === control) out.push({ e, l, src: x }); }
  return out;
}
function contactLedgerM(companyId: string, contactId: string, from: string, to: string) {
  const c = sdb.contacts.find((x) => x.id === contactId && x.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound');
  const sign: 1n | -1n = c.isCustomer && !c.isEmployee ? 1n : -1n; let open = 0n; const rows: LRow[] = [];
  for (const { e, l, src } of contactLines(companyId, c)) { if (e.date < from) open += l.debit - l.credit; else if (e.date <= to) rows.push(lineRow(e, l, src)); }
  return { contact: { id: c.id, name: c.name, nameAr: c.nameAr, isCustomer: c.isCustomer, isSupplier: c.isSupplier, isEmployee: c.isEmployee }, from, to, ...running(sign * open, rows.sort(byDate), sign) };
}
function contactBalancesM(companyId: string, role: string, asOf: string) {
  const flag = role === 'employee' ? 'isEmployee' : role === 'customer' ? 'isCustomer' : role === 'supplier' ? 'isSupplier' : fail(404, 'Not found.', 'err.notFound');
  return sdb.contacts.filter((c) => c.companyId === companyId && c[flag]).sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)).map((c) => {
    const v = contactLines(companyId, c).filter((x) => x.e.date <= asOf).reduce((t, x) => t + x.l.debit - x.l.credit, 0n);
    return { id: c.id, name: c.name, nameAr: c.nameAr, employeeNo: c.employeeNo, status: c.status, balance: s(role === 'customer' ? v : -v) };
  });
}
function projectRow(cc: CostCentre, from?: string | null, to?: string | null) {
  let income = 0n, expense = 0n;
  for (const e of db.entries) if (e.companyId === cc.companyId && (!from || e.date >= from) && (!to || e.date <= to)) for (const l of e.lines) if (l.costCentreId === cc.id) {
    const t = db.accounts.find((a) => a.id === l.accountId)!.type;
    if (t === 'income') income += l.credit - l.debit;
    if (t === 'expense') expense += l.debit - l.credit;
  }
  const c = sdb.contacts.find((x) => x.id === cc.contactId); const budget = cc.budget ? toMinor(cc.budget) : 0n;
  return { id: cc.id, companyId: cc.companyId, name: cc.name, nameAr: cc.nameAr, status: cc.status ?? 'active', budget: cc.budget ?? null, startDate: cc.startDate ?? null,
    endDate: cc.endDate ?? null, contactId: cc.contactId ?? null, description: cc.description ?? null, customerName: c?.name ?? null, customerNameAr: c?.nameAr ?? null,
    income: s(income), expense: s(expense), profit: s(income - expense), budgetUsed: budget > 0n ? Number((expense * 1000n) / budget) / 10 : null };
}
function saveProjectM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const t = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
  if (!t('name')) fail(400, 'Enter the project name.', 'err.projectName');
  let budget: string | null = null;
  if (t('budget')) {
    try { budget = s(toMinor(t('budget')!.replace(/,/g, ''))); } catch { fail(400, 'The budget must be a number with up to 2 decimals.', 'err.amountFormat'); }
    if (toMinor(budget!) < 0n) fail(400, 'The budget cannot be negative.', 'err.amountFormat');
  }
  if (t('startDate') && t('endDate') && t('endDate')! < t('startDate')!) fail(400, 'The end date cannot be before the start date.', 'err.endDate');
  const contactId = t('contactId');
  if (contactId && !sdb.contacts.some((c) => c.id === contactId && c.companyId === companyId && c.isCustomer)) fail(400, 'The project customer must be a customer of this company.', 'err.projectCustomer');
  const v = { name: t('name')!, nameAr: t('nameAr'), contactId, budget, startDate: t('startDate'), endDate: t('endDate'), status: b.status === 'closed' ? 'closed' : 'active', description: t('description') };
  if (id) { Object.assign(db.costCentres.find((x) => x.id === id && x.kind === 'project') ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); db.costCentres.push({ id: nid, companyId, kind: 'project', ...v }); return nid;
}
const projectOf = (id: string) => db.costCentres.find((x) => x.id === id && x.kind === 'project' && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound');

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
  // Projects: Project A gets a customer and budget; a second project with its own invoice and costs.
  Object.assign(db.costCentres.find((x) => x.companyId === companyId && x.name === 'Project A')!, { budget: '5000.00', contactId: walkIn, startDate: daysAgo(40), status: 'active' });
  const fitOut = saveProjectM(companyId, { name: 'Warehouse fit-out', nameAr: 'تجهيز المستودع', contactId: faisal, budget: '8000.00', startDate: daysAgo(30) });
  issueM(saveDraftM(companyId, { type: 'invoice', contactId: faisal, issueDate: daysAgo(15), dueDate: daysAgo(-15), lines: [{ ...SL('Fit-out works, stage 1', '1', '9500.00'), costCentreId: fitOut }] }));
  issueM(saveDraftM(companyId, { type: 'bill', contactId: najd, issueDate: daysAgo(14), dueDate: daysAgo(-1), reference: 'NW-88190', lines: [{ ...SL('Shelving and racks', '1', '5200.00', undefined, '5000'), costCentreId: fitOut }] }));
  // Employees and their expense claims: one reimbursed, one waiting for approval, one rejected.
  const yusuf = saveContactM(companyId, { isEmployee: true, name: 'Yusuf Karim', nameAr: 'يوسف كريم', employeeNo: 'E-001', jobTitle: 'Driver', defaultCostCentreId: cc('Branch 1') });
  const mona = saveContactM(companyId, { isEmployee: true, name: 'Mona Saeed', nameAr: 'منى سعيد', employeeNo: 'E-002', jobTitle: 'Site engineer', defaultCostCentreId: fitOut });
  const claim = (who: string, ago: number, desc: string, amount: string, code: string, centre: string | null, vatCode = 'standard') => {
    const id = saveDraftM(companyId, { type: 'claim', contactId: who, issueDate: daysAgo(ago), reference: `R-${ago}`, lines: [{ ...SL(desc, '1', amount, undefined, code), costCentreId: centre, vatCode }] });
    submitClaimM(id); return id;
  };
  const c1 = claim(yusuf, 20, 'Fuel and tolls for deliveries', '230.00', '5400', cc('Branch 1'));
  claim(mona, 8, 'Site materials bought on the spot', '640.00', '5000', fitOut);
  const c3 = claim(yusuf, 5, 'Lunch with customer', '180.00', '5400', null, 'zero');
  session = db.memberships.find((m) => m.companyId === companyId && m.role === 'partner')!.userId;   // someone other than the submitter decides
  decideM(c1, true); decideM(c3, false, 'Customer lunches need a pre-approval form');
  session = poster;
  pay('made', yusuf, 16, c1, s(amountDue(sdb.docs.find((d) => d.id === c1)!)), '1010', 'cash');
  seedOps(companyId, poster, c, { gulf, faisal, najd, fitOut });
  session = prev;
}

// ------------------------------------------------------------------ bank, inventory and fixed assets (same rules as db/migrations/0010-0012)
interface MBank { id: string; companyId: string; accountId: string; kind: 'bank' | 'cash' | 'card'; bankName: string | null; accountNumber: string | null; iban: string | null;
  importLayout: Layout | null; status: 'active' | 'closed' }
interface MLine { id: string; companyId: string; bankId: string; importId: string; date: string; description: string; reference: string | null; amount: bigint;
  balance: bigint | null; fp: string; status: 'open' | 'matched' | 'ignored'; journalLineId: string | null; createdAt: string }
interface MImport { id: string; companyId: string; bankId: string; fileName: string; lineCount: number; skipped: number; dateFrom: string; dateTo: string; importedBy: string; importedAt: string }
interface MRule { id: string; companyId: string; matchText: string; direction: 'in' | 'out'; accountId: string; costCentreId: string | null; vatCode: string; label: string | null;
  bankAccountId: string | null; active: boolean }
interface MItem { id: string; companyId: string; sku: string; name: string; nameAr: string | null; unit: string; salePrice: string | null; reorderLevel: string | null;
  q: bigint; v: bigint; status: 'active' | 'archived' }
interface MNoteLine { id: string; itemId: string; q: bigint; unitCost: bigint | null; value: bigint; costCentreId: string | null }
interface MNote { id: string; companyId: string; type: NoteType; status: 'draft' | 'posted'; number: string | null; date: string; contactId: string | null; reference: string | null;
  notes: string | null; otherAccountId: string; total: bigint; journalEntryId: string | null; createdAt: string; postedAt: string | null; lines: MNoteLine[] }
interface MAsset { id: string; companyId: string; number: string; name: string; nameAr: string | null; assetAccountId: string; expenseAccountId: string; costCentreId: string | null;
  contactId: string | null; purchaseDate: string; start: string; cost: bigint; residual: bigint; life: number; opening: bigint; serialNo: string | null; location: string | null;
  reference: string | null; notes: string | null; status: 'active' | 'disposed'; disposedOn: string | null; proceeds: bigint | null; disposalEntryId: string | null }
interface MRun { id: string; companyId: string; periodEnd: string; total: bigint; journalEntryId: string | null; runBy: string; runAt: string; lines: { assetId: string; amount: bigint }[] }
const odb = { banks: [] as MBank[], lines: [] as MLine[], imports: [] as MImport[], rules: [] as MRule[], items: [] as MItem[], notes: [] as MNote[], assets: [] as MAsset[], runs: [] as MRun[] };

const acctBy = (companyId: string, code: string) => db.accounts.find((a) => a.companyId === companyId && a.code === code) ?? fail(400, `No account ${code}.`, 'err.chart');
const ledgerSum = (accountId: string, upTo?: string) => db.entries.filter((e) => !upTo || e.date <= upTo).flatMap((e) => e.lines).filter((l) => l.accountId === accountId)
  .reduce((t, l) => t + l.debit - l.credit, 0n);
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const qtyStr = (q: bigint) => milliToString(q);
const toQ = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };

/** Every bank or cash ledger account has its bank account record (as the database trigger does). */
function banksOf(companyId: string) {
  for (const a of db.accounts.filter((x) => x.companyId === companyId && x.isBank)) {
    if (!odb.banks.some((b) => b.accountId === a.id)) odb.banks.push({ id: uid(), companyId, accountId: a.id, kind: a.code === '1010' ? 'cash' : 'bank', bankName: null, accountNumber: null, iban: null, importLayout: null, status: 'active' });
  }
  return odb.banks.filter((b) => b.companyId === companyId);
}
function bankRow(b: MBank) {
  const a = db.accounts.find((x) => x.id === b.accountId)!;
  const ls = odb.lines.filter((l) => l.bankId === b.id);
  return { ...b, code: a.code, name: a.name, nameAr: a.nameAr, booksBalance: s(ledgerSum(a.id)), openLines: ls.filter((l) => l.status === 'open').length,
    lastStatementDate: ls.map((l) => l.date).sort().at(-1) ?? null };
}
const bankOf = (id: string) => odb.banks.find((b) => b.id === id && roleOf(session, b.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveBankM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const kind = b.kind === 'cash' || b.kind === 'card' ? b.kind : 'bank';
  const iban = String(b.iban ?? '').trim() ? normaliseIban(String(b.iban)) : null;
  if (iban && !ibanValid(iban)) fail(400, 'This IBAN is not right.', 'err.iban');
  const known = iban ? bankFromIban(iban) : undefined;
  const bankName = String(b.bankName ?? '').trim() || known?.name || null;
  if (kind === 'bank' && !bankName) fail(400, 'Enter the bank name.', 'err.bankName');
  const number = String(b.accountNumber ?? '').replace(/\s/g, '') || null;
  if (iban && odb.banks.some((x) => x.companyId === companyId && x.id !== id && x.iban === iban)) fail(400, 'Another bank account already has this IBAN.', 'err.ibanTaken');
  if (number && odb.banks.some((x) => x.companyId === companyId && x.id !== id && x.accountNumber === number)) fail(400, 'Another bank account already has this account number.', 'err.bankNumberTaken');
  const last4 = (number ?? iban ?? '').slice(-4);
  const name = String(b.name ?? '').trim() || (kind === 'cash' ? 'Cash' : `${bankName ?? 'Bank'}${last4 ? ` ${last4}` : ''}`);
  const nameAr = String(b.nameAr ?? '').trim() || known?.nameAr || null;
  if (id) {
    const cur = bankOf(id);
    if (b.status === 'closed' && cur.status !== 'closed' && ledgerSum(cur.accountId) !== 0n) fail(400, 'Only an account with a zero balance in the books can be closed.', 'err.bankNotZero');
    Object.assign(cur, { kind, bankName, accountNumber: number, iban, status: b.status === 'closed' ? 'closed' : 'active' });
    Object.assign(db.accounts.find((a) => a.id === cur.accountId)!, { name, nameAr });
    return id;
  }
  let code = 1020;
  while (db.accounts.some((a) => a.companyId === companyId && a.code === String(code))) code++;
  const accountId = uid();
  db.accounts.push({ id: accountId, companyId, code: String(code), name, nameAr, type: 'asset', costCentreRequired: false, isBank: true });
  const nid = uid();
  odb.banks.push({ id: nid, companyId, accountId, kind, bankName, accountNumber: number, iban, importLayout: null, status: 'active' });
  return nid;
}
function importM(bankId: string, body: Record<string, unknown>) {
  const b = bankOf(bankId); canPostIn(b.companyId);
  if (b.status !== 'active') fail(400, 'This bank account is closed.', 'err.bankClosed');
  const lines = ((body.lines as StatementRow[]) ?? []).map((l) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) fail(400, 'The date is not right.', 'err.date');
    let amount: bigint, balance: bigint | null;
    try { amount = toMinor(String(l.amount)); balance = l.balance ? toMinor(String(l.balance)) : null; } catch { return fail(400, 'The amount is not a number.', 'err.amountFormat'); }
    if (!String(l.description ?? '').trim() || amount === 0n) fail(400, 'Each statement line needs a date, a description and an amount.', 'err.statementLine');
    return { date: String(l.date), description: String(l.description).replace(/\s+/g, ' ').trim(), reference: l.reference || null, amount: s(amount), balance: balance === null ? null : s(balance) };
  });
  if (!lines.length) fail(400, 'The file has no statement lines.', 'err.noStatementLines');
  const fps = fingerprints(lines);
  const fresh = lines.map((l, i) => ({ ...l, fp: fps[i]! })).filter((l) => !odb.lines.some((x) => x.bankId === bankId && x.fp === l.fp));
  const dates = lines.map((l) => l.date).sort();
  const importId = uid();
  odb.imports.push({ id: importId, companyId: b.companyId, bankId, fileName: String(body.fileName ?? 'statement'), lineCount: fresh.length, skipped: lines.length - fresh.length,
    dateFrom: dates[0]!, dateTo: dates.at(-1)!, importedBy: session!, importedAt: new Date().toISOString() });
  for (const l of fresh) odb.lines.push({ id: uid(), companyId: b.companyId, bankId, importId, date: l.date, description: l.description, reference: l.reference, amount: toMinor(l.amount),
    balance: l.balance === null ? null : toMinor(l.balance), fp: l.fp, status: 'open', journalLineId: null, createdAt: new Date().toISOString() });
  if (body.layout) b.importLayout = body.layout as Layout;
  return { importId, imported: fresh.length, skipped: lines.length - fresh.length };
}
/** Journal lines on the bank's ledger account not matched to any statement line (an entry and its reversal both left out). */
function unmatchedM(accountId: string, upTo?: string) {
  const matched = new Set(odb.lines.map((l) => l.journalLineId).filter(Boolean));
  const list = db.entries.filter((e) => !upTo || e.date <= upTo).flatMap((e) => e.lines.filter((l) => l.accountId === accountId && !matched.has(l.id))
    .map((l) => ({ id: l.id, date: e.date, memo: e.memo, amount: l.debit - l.credit, entryId: e.id, reversesEntryId: e.reversesEntryId, at: e.createdAt })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  const ids = new Set(list.map((l) => l.entryId));
  return list.filter((l) => !(l.reversesEntryId && ids.has(l.reversesEntryId)) && !list.some((x) => x.reversesEntryId === l.entryId));
}
function linesM(bankId: string, status: string) {
  const b = bankOf(bankId);
  const rows = odb.lines.filter((l) => l.bankId === bankId && (status === 'all' || l.status === status))
    .sort((x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt));
  const ledger = unmatchedM(b.accountId);
  const rules = odb.rules.filter((r) => r.companyId === b.companyId && r.active && (!r.bankAccountId || r.bankAccountId === bankId)).sort((x, y) => y.matchText.length - x.matchText.length);
  const due = sdb.docs.filter((d) => d.companyId === b.companyId && d.status === 'issued' && ['invoice', 'bill', 'claim'].includes(d.type) && amountDue(d) > 0n);
  const taken = new Set<string>();
  const suggest = (r: MLine) => {
    const hit = ledger.filter((l) => l.amount === r.amount && !taken.has(l.id) && days(l.date, r.date) <= 14)
      .sort((x, y) => (days(x.date, r.date) - similarity(x.memo ?? '', r.description) * 5) - (days(y.date, r.date) - similarity(y.memo ?? '', r.description) * 5))[0];
    if (hit) { taken.add(hit.id); return { kind: 'match', journalLineId: hit.id, date: hit.date, memo: hit.memo }; }
    const abs = r.amount < 0n ? -r.amount : r.amount;
    const name = (d: MDoc) => sdb.contacts.find((c) => c.id === d.contactId)!.name;
    const doc = due.filter((d) => (r.amount > 0n ? d.type === 'invoice' : d.type !== 'invoice') && amountDue(d) === abs)
      .sort((x, y) => similarity(name(y), r.description) - similarity(name(x), r.description))[0];
    if (doc) return { kind: 'pay', contactId: doc.contactId, contactName: name(doc), documentNumber: doc.number };
    const rule = rules.find((x) => x.direction === (r.amount > 0n ? 'in' : 'out') && r.description.toLowerCase().includes(x.matchText.toLowerCase()));
    if (rule) { const a = db.accounts.find((x) => x.id === rule.accountId)!; return { kind: 'rule', ruleId: rule.id, accountId: a.id, costCentreId: rule.costCentreId, vatCode: rule.vatCode, accountCode: a.code, accountName: a.name, accountNameAr: a.nameAr, label: rule.label }; }
    return null;
  };
  return rows.map((r) => {
    const e = r.journalLineId ? db.entries.find((x) => x.lines.some((l) => l.id === r.journalLineId)) : undefined;
    return { id: r.id, date: r.date, description: r.description, reference: r.reference, amount: s(r.amount), balance: r.balance === null ? null : s(r.balance), status: r.status,
      journalLineId: r.journalLineId, matchedMemo: e?.memo ?? null, suggestion: r.status === 'open' ? suggest(r) : null };
  });
}
const lineOf = (id: string) => odb.lines.find((l) => l.id === id && roleOf(session, l.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
const openLineOf = (id: string) => { const l = lineOf(id); canPostIn(l.companyId); if (l.status !== 'open') fail(400, 'This statement line is already dealt with.', 'err.lineDone'); return l; };
function matchToM(line: MLine, journalLineId: string) {
  const b = odb.banks.find((x) => x.id === line.bankId)!;
  const jl = db.entries.flatMap((e) => e.lines).find((l) => l.id === journalLineId);
  if (!jl || jl.accountId !== b.accountId) fail(400, 'A statement line can only be matched to an entry on the same bank account.', 'err.matchAccount');
  if ((line.amount > 0n && jl!.debit !== line.amount) || (line.amount < 0n && jl!.credit !== -line.amount)) fail(400, 'The amount in the books is not the amount on the statement.', 'err.matchAmount');
  if (odb.lines.some((l) => l.journalLineId === journalLineId)) fail(400, 'Already matched.', 'err.lineDone');
  line.status = 'matched'; line.journalLineId = journalLineId;
}
const bankSideM = (entryId: string, line: MLine) => {
  const b = odb.banks.find((x) => x.id === line.bankId)!;
  return db.entries.find((e) => e.id === entryId)!.lines.find((l) => l.accountId === b.accountId && (line.amount > 0n ? l.debit === line.amount : l.credit === -line.amount))!.id;
};
function bookM(lineId: string, body: Record<string, unknown>) {
  const line = openLineOf(lineId);
  const b = odb.banks.find((x) => x.id === line.bankId)!;
  const target = db.accounts.find((a) => a.id === body.accountId && a.companyId === line.companyId) ?? fail(400, 'Choose the account.', 'err.lineAccount');
  if (target.id === b.accountId) fail(400, 'Choose an account other than this bank account.', 'err.sameBank');
  const vatCode = (['standard', 'zero', 'exempt', 'out_of_scope'].includes(String(body.vatCode)) ? body.vatCode : 'out_of_scope') as LineInput['vatCode'];
  const description = (String(body.description ?? '').trim() || line.description).slice(0, 200);
  const cc = (body.costCentreId as string) || null;
  let entryId: string;
  if (line.amount < 0n && target.type === 'expense') {
    const split = netFromGross(-line.amount, db.companies.find((c) => c.id === line.companyId)!.vatRate, vatCode);
    const did = saveDraftM(line.companyId, { type: 'expense', payee: line.description.slice(0, 120), paidFromAccountId: b.accountId, issueDate: line.date, reference: line.reference,
      lines: [{ description, quantity: '1', unitPrice: s(split.net), accountId: target.id, costCentreId: cc, vatCode },
        ...(split.rounding > 0n ? [{ description: 'VAT rounding', quantity: '1', unitPrice: s(split.rounding), accountId: target.id, costCentreId: cc, vatCode: 'out_of_scope' }] : [])] });
    issueM(did); entryId = sdb.docs.find((d) => d.id === did)!.journalEntryId!;
  } else {
    const a = line.amount < 0n ? -line.amount : line.amount;
    entryId = post(session!, line.companyId, line.date, description, line.amount > 0n
      ? [{ accountId: b.accountId, costCentreId: null, debit: a, credit: 0n }, { accountId: target.id, costCentreId: cc, debit: 0n, credit: a }]
      : [{ accountId: target.id, costCentreId: cc, debit: a, credit: 0n }, { accountId: b.accountId, costCentreId: null, debit: 0n, credit: a }]);
  }
  matchToM(line, bankSideM(entryId, line));
  if (body.remember && String(body.remember).trim().length >= 3) {
    odb.rules.push({ id: uid(), companyId: line.companyId, matchText: String(body.remember).trim(), direction: line.amount > 0n ? 'in' : 'out', accountId: target.id, costCentreId: cc,
      vatCode, label: description, bankAccountId: null, active: true });
  }
  return entryId;
}
function payLineM(lineId: string, contactId: string) {
  const line = openLineOf(lineId);
  const b = odb.banks.find((x) => x.id === line.bankId)!;
  const direction = line.amount > 0n ? 'received' : 'made';
  const abs = line.amount < 0n ? -line.amount : line.amount;
  const c = sdb.contacts.find((x) => x.id === contactId) ?? fail(400, 'Choose the customer or supplier.', 'err.contact');
  const open = sdb.docs.filter((d) => d.contactId === contactId && d.status === 'issued' && d.type === (direction === 'received' ? 'invoice' : c.isEmployee ? 'claim' : 'bill') && amountDue(d) > 0n)
    .sort((x, y) => (x.dueDate ?? x.issueDate).localeCompare(y.dueDate ?? y.issueDate));
  const allocs = autoAllocate(abs, open.map((d) => ({ id: d.id, due: amountDue(d) })));
  const pid = payM(line.companyId, { direction, contactId, date: line.date, amount: s(abs), accountId: b.accountId, method: 'bank_transfer', reference: line.reference ?? line.description.slice(0, 80),
    allocations: allocs.map((a) => ({ documentId: a.id, amount: s(a.amount) })) });
  matchToM(line, bankSideM(sdb.payments.find((p) => p.id === pid)!.journalEntryId, line));
  return pid;
}
function reconM(bankId: string) {
  const b = bankOf(bankId); const acct = bankRow(b);
  const ls = odb.lines.filter((l) => l.bankId === bankId);
  const last = ls.map((l) => l.date).sort().at(-1) ?? null;
  if (!last) return { account: acct, statementDate: null, statementBalance: null, booksBalance: acct.booksBalance, inBooksOnly: [], onStatementOnly: [], difference: null };
  const end = ls.filter((l) => l.date === last && l.balance !== null);
  const lastLine = end.find((l) => !end.some((m) => m !== l && m.balance! - m.amount === l.balance)) ?? end.at(-1);
  const books = ledgerSum(b.accountId, last);
  const inBooks = unmatchedM(b.accountId, last);
  const onStatement = ls.filter((l) => l.status === 'open').sort((x, y) => x.date.localeCompare(y.date));
  const adjusted = books - inBooks.reduce((t, l) => t + l.amount, 0n) + onStatement.reduce((t, l) => t + l.amount, 0n);
  return { account: acct, statementDate: last, statementBalance: lastLine ? s(lastLine.balance!) : null, booksBalance: s(books),
    inBooksOnly: inBooks.map((l) => ({ journalLineId: l.id, date: l.date, memo: l.memo, amount: s(l.amount) })),
    onStatementOnly: onStatement.map((l) => ({ id: l.id, date: l.date, description: l.description, amount: s(l.amount) })), adjustedBooks: s(adjusted),
    difference: lastLine ? s(lastLine.balance! - adjusted) : null };
}
function ruleRow(r: MRule) {
  const a = db.accounts.find((x) => x.id === r.accountId)!; const cc = db.costCentres.find((x) => x.id === r.costCentreId);
  return { ...r, accountCode: a.code, accountName: a.name, accountNameAr: a.nameAr, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null };
}
function saveRuleM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const text = String(b.matchText ?? '').trim();
  if (text.length < 3) fail(400, 'Enter at least 3 letters of the text to look for.', 'err.ruleText');
  if (!db.accounts.some((a) => a.id === b.accountId && a.companyId === companyId)) fail(400, 'Choose the account.', 'err.lineAccount');
  const v = { matchText: text, direction: b.direction === 'in' ? 'in' as const : 'out' as const, accountId: String(b.accountId), costCentreId: (b.costCentreId as string) || null,
    vatCode: String(b.vatCode ?? 'out_of_scope'), label: (b.label as string)?.trim() || null, bankAccountId: (b.bankAccountId as string) || null, active: b.active !== false };
  if (id) { Object.assign(odb.rules.find((r) => r.id === id) ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); odb.rules.push({ id: nid, companyId, ...v }); return nid;
}

// ---- inventory
const itemRow = (i: MItem) => ({ id: i.id, companyId: i.companyId, sku: i.sku, name: i.name, nameAr: i.nameAr, unit: i.unit, salePrice: i.salePrice, reorderLevel: i.reorderLevel,
  qtyOnHand: qtyStr(i.q), valueOnHand: s(i.v), status: i.status, averageCost: s(averageCost(i.q, i.v)), low: i.reorderLevel !== null && i.q <= toQ(i.reorderLevel) });
const itemOf = (id: string) => odb.items.find((i) => i.id === id && roleOf(session, i.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveItemM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const sku = String(b.sku ?? '').trim(), name = String(b.name ?? '').trim();
  if (!sku) fail(400, 'Enter the item code.', 'err.itemSku');
  if (!name) fail(400, 'Enter the item name.', 'err.itemName');
  if (odb.items.some((i) => i.companyId === companyId && i.id !== id && i.sku === sku)) fail(400, 'Another item already has this code.', 'err.skuTaken');
  const v = { sku, name, nameAr: (b.nameAr as string)?.trim() || null, unit: (b.unit as string) || 'pcs', salePrice: b.salePrice ? s(toMinor(String(b.salePrice))) : null,
    reorderLevel: b.reorderLevel ? qtyStr(toQ(String(b.reorderLevel))) : null, status: b.status === 'archived' ? 'archived' as const : 'active' as const };
  if (id) { Object.assign(itemOf(id), v); return id; }
  const nid = uid(); odb.items.push({ id: nid, companyId, q: 0n, v: 0n, ...v }); return nid;
}
function noteRow(n: MNote) {
  const c = sdb.contacts.find((x) => x.id === n.contactId); const a = db.accounts.find((x) => x.id === n.otherAccountId)!;
  return { id: n.id, companyId: n.companyId, type: n.type, status: n.status, number: n.number, date: n.date, contactId: n.contactId, contactName: c?.name ?? null, contactNameAr: c?.nameAr ?? null,
    reference: n.reference, notes: n.notes, otherAccountId: a.id, otherAccountCode: a.code, otherAccountName: a.name, otherAccountNameAr: a.nameAr, totalValue: s(n.total),
    journalEntryId: n.journalEntryId, createdAt: n.createdAt, lineCount: n.lines.length };
}
const noteOf = (id: string) => odb.notes.find((n) => n.id === id && roleOf(session, n.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveNoteM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const existing = id ? noteOf(id) : undefined;
  if (existing && existing.status !== 'draft') fail(400, 'Posted goods notes are never changed. Record a new note to correct one.', 'err.notePosted');
  const type: NoteType = existing?.type ?? (b.type === 'gdn' ? 'gdn' : 'grn');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? ''))) fail(400, 'Enter the date.', 'err.date');
  const other = (b.otherAccountId as string) || acctBy(companyId, type === 'grn' ? '2050' : '5000').id;
  const oa = db.accounts.find((a) => a.id === other && a.companyId === companyId);
  if (!oa || oa.code === '1300' || (type === 'grn' ? !['liability', 'equity'].includes(oa.type) : oa.type !== 'expense'))
    fail(400, 'Goods received are credited to a liability or equity account; goods delivered are charged to an expense account.', 'err.noteAccount');
  const contactId = (b.contactId as string) || null;
  if (contactId && !sdb.contacts.some((c) => c.id === contactId && c.companyId === companyId && (type === 'grn' ? c.isSupplier : c.isCustomer)))
    fail(400, 'Choose a supplier (goods received) or a customer (goods delivered) of this company.', 'err.noteContact');
  const lines = ((b.lines as Record<string, string | null>[]) ?? []).filter((l) => l.itemId).map((l) => {
    let q: bigint; try { q = quantityToMilli(String(l.quantity ?? '').trim()); } catch { return fail(400, 'Enter a quantity above 0 (up to 3 decimals).', 'err.noteQty'); }
    let cost: bigint | null = null;
    if (type === 'grn') { try { cost = toMinor(String(l.unitCost ?? '').replace(/,/g, '').trim()); } catch { return fail(400, 'Enter the cost per unit.', 'err.noteCost'); } }
    if (!odb.items.some((i) => i.id === l.itemId && i.companyId === companyId)) fail(400, 'Choose the item on each line.', 'err.noteItem');
    return { id: uid(), itemId: String(l.itemId), q, unitCost: cost, value: cost === null ? 0n : receivedValue(q, cost), costCentreId: (l.costCentreId as string) || null };
  });
  const head = { date: String(b.date), contactId, reference: (b.reference as string)?.trim() || null, notes: (b.notes as string)?.trim() || null, otherAccountId: other, lines };
  if (existing) { Object.assign(existing, head); return existing.id; }
  const nid = uid();
  odb.notes.push({ id: nid, companyId, type, status: 'draft', number: null, total: 0n, journalEntryId: null, createdAt: new Date().toISOString(), postedAt: null, ...head });
  return nid;
}
function postNoteM(id: string) {
  const n = noteOf(id); canPostIn(n.companyId);
  if (n.status !== 'draft') fail(400, 'This note has already been posted.', 'err.notePosted');
  if (!n.lines.length) fail(400, 'Add at least one item.', 'err.noteNoLines');
  const stock = new Map(odb.items.filter((i) => i.companyId === n.companyId).map((i) => [i.id, { q: i.q, v: i.v }]));
  const byCc = new Map<string, bigint>(); let total = 0n;
  const values = n.lines.map((l) => {
    const st = stock.get(l.itemId)!;
    let v = l.value;
    if (n.type === 'gdn') {
      if (l.q > st.q) { const it = odb.items.find((i) => i.id === l.itemId)!; fail(400, `Not enough stock of ${it.name} (${it.sku}).`, 'err.notEnoughStock'); }
      v = issueCost(st.q, st.v, l.q); st.q -= l.q; st.v -= v;
    } else { st.q += l.q; st.v += v; }
    total += v; byCc.set(l.costCentreId ?? '', (byCc.get(l.costCentreId ?? '') ?? 0n) + v);
    return v;
  });
  const seqKey = `${n.companyId}:${n.type}`; const saved = sdb.seqs.get(seqKey);
  const number = nextNo(n.companyId, n.type, notePrefix(n.type));
  let entryId: string | null = null;
  try {
    if (total > 0n) {
      const inv = acctBy(n.companyId, '1300').id;
      const c = sdb.contacts.find((x) => x.id === n.contactId);
      const side = [...byCc.entries()].filter(([, v]) => v > 0n).map(([cc, v]) => ({ accountId: n.type === 'grn' ? inv : n.otherAccountId, costCentreId: cc || null, debit: v, credit: 0n }));
      entryId = post(session!, n.companyId, n.date, `${number}${c ? ` · ${c.name}` : ''}`, [...side, { accountId: n.type === 'grn' ? n.otherAccountId : inv, costCentreId: null, debit: 0n, credit: total }]);
    }
  } catch (e) { if (saved === undefined) sdb.seqs.delete(seqKey); else sdb.seqs.set(seqKey, saved); throw e; }
  n.lines.forEach((l, i) => { l.value = values[i]!; });
  for (const [iid, st] of stock) { const it = odb.items.find((i) => i.id === iid)!; it.q = st.q; it.v = st.v; }
  Object.assign(n, { status: 'posted', number, total, journalEntryId: entryId, postedAt: new Date().toISOString() });
}

// ---- fixed assets
const accumulatedOf = (a: MAsset) => a.opening + odb.runs.flatMap((r) => r.lines).filter((l) => l.assetId === a.id).reduce((t, l) => t + l.amount, 0n);
const bookedBefore = (a: MAsset, periodEnd: string, including = false) => odb.runs.filter((r) => r.periodEnd < periodEnd || (including && r.periodEnd === periodEnd))
  .flatMap((r) => r.lines).filter((l) => l.assetId === a.id).reduce((t, l) => t + l.amount, 0n);
const terms = (a: MAsset): AssetTerms => ({ cost: a.cost, residual: a.residual, lifeMonths: a.life, start: a.start, opening: a.opening, disposedOn: a.disposedOn });
function assetRow(a: MAsset) {
  const acc = db.accounts.find((x) => x.id === a.assetAccountId)!; const cc = db.costCentres.find((x) => x.id === a.costCentreId);
  const accumulated = accumulatedOf(a);
  return { id: a.id, companyId: a.companyId, number: a.number, name: a.name, nameAr: a.nameAr, assetAccountId: acc.id, assetAccountCode: acc.code, assetAccountName: acc.name, assetAccountNameAr: acc.nameAr,
    expenseAccountId: a.expenseAccountId, costCentreId: a.costCentreId, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null, contactId: a.contactId,
    supplierName: sdb.contacts.find((c) => c.id === a.contactId)?.name ?? null, purchaseDate: a.purchaseDate, depreciationStart: a.start, cost: s(a.cost), residualValue: s(a.residual),
    usefulLifeMonths: a.life, openingDepreciation: s(a.opening), serialNo: a.serialNo, location: a.location, reference: a.reference, notes: a.notes, status: a.status,
    disposedOn: a.disposedOn, disposalProceeds: a.proceeds === null ? null : s(a.proceeds), disposalEntryId: a.disposalEntryId, accumulated: s(accumulated),
    bookValue: a.status === 'disposed' ? '0.00' : s(a.cost - accumulated) };
}
const assetOf = (id: string) => odb.assets.find((a) => a.id === id && roleOf(session, a.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveAssetM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const name = String(b.name ?? '').trim();
  if (!name) fail(400, 'Enter the asset name.', 'err.assetName');
  const acc = db.accounts.find((a) => a.id === b.assetAccountId && a.companyId === companyId);
  if (!acc || acc.type !== 'asset' || acc.isBank || ['1100', '1200', '1300', '1590'].includes(acc.code)) fail(400, 'Choose the fixed asset account.', 'err.assetAccount');
  const purchaseDate = String(b.purchaseDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) fail(400, 'Enter the purchase date.', 'err.date');
  const m = (v: unknown) => { const t = String(v ?? '').replace(/,/g, '').trim(); if (!t) return 0n; try { return toMinor(t); } catch { return fail(400, 'Amounts have at most 2 decimals.', 'err.amountFormat'); } };
  const cost = m(b.cost), residual = m(b.residualValue), opening = m(b.openingDepreciation);
  if (cost <= 0n) fail(400, 'Enter the cost.', 'err.assetCost');
  if (residual < 0n || residual >= cost) fail(400, 'The value at the end of its life must be less than the cost.', 'err.assetResidual');
  if (opening < 0n || opening > cost - residual) fail(400, 'Depreciation before Nusuh Books is too high.', 'err.assetOpening');
  const life = Number(b.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 1200) fail(400, 'Enter the useful life in months (1 to 1200).', 'err.assetLife');
  const start = monthStart(b.depreciationStart ? String(b.depreciationStart) : purchaseDate);
  if (start < monthStart(purchaseDate)) fail(400, 'Depreciation cannot start before the month the asset was bought.', 'err.assetStart');
  const t = (k: string) => (b[k] as string)?.trim() || null;
  const v = { name, nameAr: t('nameAr'), assetAccountId: acc!.id, expenseAccountId: (b.expenseAccountId as string) || acctBy(companyId, '5050').id, costCentreId: t('costCentreId'),
    contactId: t('contactId'), purchaseDate, start, cost, residual, life, opening, serialNo: t('serialNo'), location: t('location'), reference: t('reference'), notes: t('notes') };
  if (id) {
    const cur = assetOf(id);
    if (cur.status === 'disposed') fail(400, 'A disposed asset never changes.', 'err.assetDisposed');
    if (odb.runs.some((r) => r.lines.some((l) => l.assetId === id)) && (cur.cost !== cost || cur.residual !== residual || cur.life !== life || cur.start !== start || cur.opening !== opening || cur.assetAccountId !== v.assetAccountId))
      fail(400, 'Depreciation has been booked on this asset, so its cost, life and accounts can no longer change.', 'err.assetLocked');
    Object.assign(cur, v); return id;
  }
  const nid = uid();
  odb.assets.push({ id: nid, companyId, number: nextNo(companyId, 'asset', 'FA-'), status: 'active', disposedOn: null, proceeds: null, disposalEntryId: null, ...v });
  return nid;
}
function nextRunM(companyId: string) {
  const last = odb.runs.filter((r) => r.companyId === companyId).map((r) => r.periodEnd).sort().at(-1);
  return last ? { periodEnd: nextMonthEnd(last), first: false } : { periodEnd: previousMonthEnd(today()), first: true };
}
function previewM(companyId: string, periodEnd: string) {
  if (monthEnd(periodEnd) !== periodEnd) fail(400, 'Choose the month.', 'err.date');
  const lines = odb.assets.filter((a) => a.companyId === companyId).sort((x, y) => x.number.localeCompare(y.number))
    .map((a) => ({ a, amount: depreciationDue(terms(a), periodEnd, bookedBefore(a, periodEnd)) })).filter((x) => x.amount > 0n);
  return { periodEnd, lines: lines.map(({ a, amount }) => ({ assetId: a.id, number: a.number, name: a.name, nameAr: a.nameAr, expenseAccountId: a.expenseAccountId, costCentreId: a.costCentreId, amount: s(amount) })),
    total: s(lines.reduce((t, x) => t + x.amount, 0n)) };
}
function runM(companyId: string, periodEnd: string) {
  canPostIn(companyId);
  const next = nextRunM(companyId);
  if (!next.first && periodEnd !== next.periodEnd) fail(400, 'Depreciation runs one month at a time, in order.', 'err.depNextMonth');
  if (periodEnd > monthEnd(today())) fail(400, 'Depreciation cannot be run for a future month.', 'err.depFuture');
  const p = previewM(companyId, periodEnd);
  const total = toMinor(p.total);
  let entryId: string | null = null;
  if (total > 0n) {
    const g = new Map<string, { accountId: string; costCentreId: string | null; v: bigint }>();
    for (const l of p.lines) { const k = `${l.expenseAccountId}|${l.costCentreId ?? ''}`; const x = g.get(k) ?? { accountId: l.expenseAccountId, costCentreId: l.costCentreId, v: 0n }; x.v += toMinor(l.amount); g.set(k, x); }
    entryId = post(session!, companyId, periodEnd, `Depreciation ${periodEnd.slice(0, 7)}`, [...[...g.values()].map((x) => ({ accountId: x.accountId, costCentreId: x.costCentreId, debit: x.v, credit: 0n })),
      { accountId: acctBy(companyId, '1590').id, costCentreId: null, debit: 0n, credit: total }]);
  }
  const id = uid();
  odb.runs.push({ id, companyId, periodEnd, total, journalEntryId: entryId, runBy: session!, runAt: new Date().toISOString(), lines: p.lines.map((l) => ({ assetId: l.assetId, amount: toMinor(l.amount) })) });
  return { runId: id, total: p.total };
}
function disposeM(id: string, b: Record<string, unknown>) {
  const a = assetOf(id); canPostIn(a.companyId);
  if (a.status !== 'active') fail(400, 'This asset has already been disposed of.', 'err.assetDisposed');
  const date = String(b.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Enter the date.', 'err.date');
  if (date < a.purchaseDate) fail(400, 'An asset cannot be disposed of before it was bought.', 'err.assetDisposeDate');
  let proceeds: bigint; try { proceeds = toMinor(String(b.proceeds ?? '0').trim() || '0'); } catch { return fail(400, 'Amounts have at most 2 decimals.', 'err.amountFormat'); }
  if (proceeds > 0n && !db.accounts.some((x) => x.id === b.bankAccountId && x.companyId === a.companyId && x.isBank)) fail(400, 'Choose the bank or cash account the money went into.', 'err.bankAccount');
  const prev = previousMonthEnd(date);
  if (depreciationDue(terms(a), prev, bookedBefore(a, prev, true)) > 0n) fail(400, `Run depreciation up to ${prev} before disposing of this asset.`, 'err.depBeforeDisposal');
  if (odb.runs.some((r) => r.periodEnd > monthEnd(date) && r.lines.some((l) => l.assetId === id))) fail(400, 'Depreciation was already booked for months after this date.', 'err.disposeAfterRuns');
  const acc = accumulatedOf(a); const result = disposalResult(a.cost, acc, proceeds);
  const gl = acctBy(a.companyId, '4900').id;
  const entryId = post(session!, a.companyId, date, `Disposal of ${a.number} · ${a.name}`, [
    ...(acc > 0n ? [{ accountId: acctBy(a.companyId, '1590').id, costCentreId: null, debit: acc, credit: 0n }] : []),
    ...(proceeds > 0n ? [{ accountId: String(b.bankAccountId), costCentreId: null, debit: proceeds, credit: 0n }] : []),
    { accountId: a.assetAccountId, costCentreId: null, debit: 0n, credit: a.cost },
    ...(result > 0n ? [{ accountId: gl, costCentreId: a.costCentreId, debit: 0n, credit: result }] : result < 0n ? [{ accountId: gl, costCentreId: a.costCentreId, debit: -result, credit: 0n }] : []),
  ]);
  Object.assign(a, { status: 'disposed', disposedOn: date, proceeds, disposalEntryId: entryId });
  return entryId;
}
function assetSummaryM(companyId: string) {
  const active = odb.assets.filter((a) => a.companyId === companyId && a.status === 'active');
  const by = new Map<string, bigint>();
  for (const a of active) by.set(a.assetAccountId, (by.get(a.assetAccountId) ?? 0n) + a.cost);
  return {
    cost: s(active.reduce((t, a) => t + a.cost, 0n)), accumulated: s(active.reduce((t, a) => t + accumulatedOf(a), 0n)),
    bookValue: s(active.reduce((t, a) => t + a.cost - accumulatedOf(a), 0n)), accumulatedInBooks: s(-ledgerSum(acctBy(companyId, '1590').id)),
    accounts: [...by.entries()].map(([accountId, cost]) => { const a = db.accounts.find((x) => x.id === accountId)!; return { accountId, code: a.code, name: a.name, nameAr: a.nameAr, cost: s(cost), books: s(ledgerSum(accountId)) }; }),
    nextRun: nextRunM(companyId),
  };
}

// ---- restaurant (same rules as db/migrations/0013_restaurant.sql)
interface MRecipe { id: string; companyId: string; name: string; nameAr: string | null; category: string | null; salePrice: string; vatCode: string; incomeAccountId: string;
  status: 'active' | 'archived'; lines: { itemId: string; q: bigint }[] }
interface MSale { id: string; companyId: string; documentId: string; noteId: string | null; paymentId: string | null; method: string; createdAt: string }
const rdb = { recipes: [] as MRecipe[], sales: [] as MSale[] };
const restaurantOn = (companyId: string) => { if (!db.companies.find((c) => c.id === companyId)?.modules.includes('Restaurant')) fail(400, 'The Restaurant module is not turned on for this client.', 'err.restaurantOff'); };
function recipeRow(r: MRecipe) {
  const lines = r.lines.map((l) => {
    const it = odb.items.find((i) => i.id === l.itemId)!;
    const last = odb.notes.filter((n) => n.type === 'grn' && n.status === 'posted').flatMap((n) => n.lines).filter((x) => x.itemId === it.id).at(-1)?.unitCost ?? 0n;
    const cost = it.q > 0n ? divRoundHalfUp(l.q * it.v, it.q) : divRoundHalfUp(l.q * last, 1000n);
    return { itemId: it.id, quantity: qtyStr(l.q), sku: it.sku, name: it.name, nameAr: it.nameAr, unit: it.unit, cost: s(cost) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const cost = lines.reduce((t, l) => t + toMinor(l.cost), 0n); const price = toMinor(r.salePrice);
  return { id: r.id, name: r.name, nameAr: r.nameAr, category: r.category, salePrice: r.salePrice, vatCode: r.vatCode, incomeAccountId: r.incomeAccountId, status: r.status,
    lines, cost: s(cost), margin: s(price - cost), foodCostPct: price > 0n ? Number((cost * 1000n) / price) / 10 : null };
}
const recipeOf = (id: string) => rdb.recipes.find((r) => r.id === id && roleOf(session, r.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveRecipeM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId); restaurantOn(companyId);
  const name = String(b.name ?? '').trim();
  if (!name) fail(400, 'Enter the menu item name.', 'err.recipeName');
  if (rdb.recipes.some((r) => r.companyId === companyId && r.id !== id && r.name === name)) fail(400, 'Another menu item already has this name.', 'err.recipeNameTaken');
  let price: bigint; try { price = toMinor(String(b.salePrice ?? '').trim()); } catch { return fail(400, 'Enter the selling price.', 'err.recipePrice'); }
  const lines = ((b.lines as { itemId?: string; quantity?: string }[]) ?? []).filter((l) => l.itemId).map((l) => {
    try { return { itemId: String(l.itemId), q: quantityToMilli(String(l.quantity ?? '').trim()) }; } catch { return fail(400, 'Enter the quantity used in one portion.', 'err.recipeQty'); }
  });
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) fail(400, 'Each material appears once in a recipe.', 'err.recipeDuplicate');
  const v = { name, nameAr: (b.nameAr as string)?.trim() || null, category: (b.category as string)?.trim() || null, salePrice: s(price),
    vatCode: ['standard', 'zero', 'exempt', 'out_of_scope'].includes(String(b.vatCode)) ? String(b.vatCode) : 'standard',
    incomeAccountId: (b.incomeAccountId as string) || acctBy(companyId, '4000').id, status: b.status === 'archived' ? 'archived' as const : 'active' as const, lines };
  if (id) { Object.assign(recipeOf(id), v); return id; }
  const nid = uid(); rdb.recipes.push({ id: nid, companyId, ...v }); return nid;
}
function sellM(companyId: string, b: Record<string, unknown>) {
  canPostIn(companyId); restaurantOn(companyId);
  const date = String(b.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Enter the date.', 'err.date');
  const method = String(b.method);
  if (!['cash', 'card', 'bank_transfer', 'on_account'].includes(method)) fail(400, 'Choose how the customer paid.', 'err.saleMethod');
  if (method !== 'on_account' && !b.accountId) fail(400, 'Choose the cash or bank account.', 'err.bankAccount');
  const lines = ((b.lines as { recipeId: string; quantity: number }[]) ?? []).filter((l) => l.recipeId && Number(l.quantity) !== 0)
    .map((l) => ({ r: rdb.recipes.find((x) => x.id === l.recipeId && x.companyId === companyId) ?? fail(400, 'Choose menu items of this client.', 'err.saleEmpty'), q: Number(l.quantity) }));
  if (!lines.length) fail(400, 'Add at least one menu item.', 'err.saleEmpty');
  if (lines.some((l) => !Number.isInteger(l.q) || l.q < 1 || l.q > 999)) fail(400, 'Quantities are whole portions.', 'err.saleQty');
  if (lines.some((l) => l.r.status !== 'active')) fail(400, 'This menu item is no longer on the menu.', 'err.saleArchived');
  if (method === 'on_account' && !b.contactId) fail(400, 'Choose the customer the sale is charged to.', 'err.saleOnAccount');
  // Check the stock first, so nothing is recorded when a material runs out (the database does this with one transaction).
  const used = new Map<string, bigint>();
  for (const l of lines) for (const m of l.r.lines) used.set(m.itemId, (used.get(m.itemId) ?? 0n) + m.q * BigInt(l.q));
  for (const [iid, q] of used) { const it = odb.items.find((i) => i.id === iid)!; if (q > it.q) fail(400, `Not enough stock of ${it.name} (${it.sku}).`, 'err.notEnoughStock'); }
  const contactId = (b.contactId as string) || sdb.contacts.find((c) => c.companyId === companyId && c.isCustomer && c.name === 'Walk-in customer')?.id
    || saveContactM(companyId, { isCustomer: true, name: 'Walk-in customer', nameAr: 'عميل نقدي', paymentTermsDays: 0 });
  const invoiceId = saveDraftM(companyId, { type: 'invoice', contactId, issueDate: date, dueDate: date,
    lines: lines.map((l) => ({ description: l.r.name, quantity: String(l.q), unitPrice: l.r.salePrice, accountId: l.r.incomeAccountId, costCentreId: (b.costCentreId as string) || null, vatCode: l.r.vatCode })) });
  issueM(invoiceId);
  const inv = sdb.docs.find((d) => d.id === invoiceId)!;
  let noteId: string | null = null;
  if (used.size) {
    noteId = saveNoteM(companyId, { type: 'gdn', date, contactId, reference: inv.number, lines: [...used.entries()].map(([itemId, q]) => ({ itemId, quantity: qtyStr(q), costCentreId: (b.costCentreId as string) || null })) });
    postNoteM(noteId);
  }
  let paymentId: string | null = null;
  const gross = s(docTotals(inv).gross);
  if (method !== 'on_account') paymentId = payM(companyId, { direction: 'received', contactId, date, amount: gross, accountId: b.accountId, method, reference: inv.number, allocations: [{ documentId: invoiceId, amount: gross }] });
  rdb.sales.push({ id: uid(), companyId, documentId: invoiceId, noteId, paymentId, method, createdAt: new Date().toISOString() });
  return { invoiceId, number: inv.number };
}
function salesM(companyId: string, from: string, to: string) {
  const rows = rdb.sales.filter((x) => x.companyId === companyId).map((x) => {
    const d = sdb.docs.find((y) => y.id === x.documentId)!; const c = sdb.contacts.find((y) => y.id === d.contactId)!; const t = docTotals(d);
    const n = odb.notes.find((y) => y.id === x.noteId);
    return { id: x.id, method: x.method, createdAt: x.createdAt, invoiceId: d.id, number: d.number, date: d.issueDate, contactName: c.name, contactNameAr: c.nameAr,
      netTotal: s(t.net), vatTotal: s(t.vat), grossTotal: s(t.gross), foodCost: s(n?.total ?? 0n), amountDue: s(amountDue(d)),
      items: d.lines.map((l) => `${Number(l.quantity)} × ${l.description}`).join(', ') };
  }).filter((x) => x.date >= from && x.date <= to).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const sum = (k: 'netTotal' | 'grossTotal' | 'foodCost') => rows.reduce((t, r) => t + toMinor(r[k]), 0n);
  const net = sum('netTotal'), cost = sum('foodCost');
  return { from, to, sales: rows, count: rows.length, netTotal: s(net), grossTotal: s(sum('grossTotal')), foodCost: s(cost), foodCostPct: net > 0n ? Number((cost * 1000n) / net) / 10 : null };
}

// ---- chart of accounts, cost centres, attachments (same rules as db/migrations/0014)
interface MAttachment { id: string; companyId: string; documentId: string | null; noteId: string | null; fileName: string; contentType: string; size: number; dataUrl: string; uploadedBy: string; uploadedAt: string }
const adb = { files: [] as MAttachment[] };
function sellerOf(co: Company) {
  const bank = odb.banks.find((b) => b.companyId === co.id && b.kind === 'bank' && b.status === 'active' && b.iban);
  return { name: co.name, nameAr: co.nameAr, vatNumber: co.vatNumber, crNumber: co.crNumber, address: co.fields.address ?? '', city: co.city, country: co.country, currency: co.currency,
    phone: co.fields.phone || null, email: co.fields.email || null, bankName: bank?.bankName ?? null, iban: bank?.iban ?? null };
}
const CODE_START: Record<string, string> = { asset: '1', liability: '2', equity: '3', income: '4', expense: '56789' };
function nextCodeM(companyId: string, type: string) {
  const used = new Set(db.accounts.filter((a) => a.companyId === companyId).map((a) => a.code));
  for (const first of CODE_START[type] ?? '5') {
    const codes = [...used].filter((c) => c.startsWith(first)).map(Number).sort((a, b) => a - b);
    let c = codes.length ? Math.floor(codes.at(-1)! / 10) * 10 + 10 : Number(`${first}000`);
    while (used.has(String(c)) && c < Number(`${first}999`)) c++;
    if (c <= Number(`${first}999`) && !used.has(String(c))) return String(c);
  }
  return fail(400, 'There is no free code left.', 'err.noCode');
}
function saveAccountM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const name = String(b.name ?? '').trim();
  if (!name) fail(400, 'Enter the account name.', 'err.accountName');
  const type = String(b.type);
  if (!CODE_START[type]) fail(400, 'Choose the type of account.', 'err.accountType');
  const code = String(b.code ?? '').trim() || nextCodeM(companyId, type);
  if (!/^[1-9]\d{3}$/.test(code) || !CODE_START[type]!.includes(code[0]!)) fail(400, 'Account codes have 4 digits.', 'err.accountCode');
  if (db.accounts.some((a) => a.companyId === companyId && a.code === code && a.id !== id)) fail(400, 'Another account already has this code.', 'err.accountCodeTaken');
  const v = { code, name, nameAr: (b.nameAr as string)?.trim() || null, type, costCentreRequired: Boolean(b.costCentreRequired), pnlGroup: (b.pnlGroup as string) || null };
  if (id) {
    const a = db.accounts.find((x) => x.id === id && x.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound');
    if ((a.code !== code || a.type !== type) && db.entries.some((e) => e.lines.some((l) => l.accountId === id))) fail(400, 'This account has postings, so its code and type can no longer change.', 'err.accountUsed');
    Object.assign(a, v); return id;
  }
  const nid = uid(); db.accounts.push({ id: nid, companyId, isBank: false, ...v }); return nid;
}
function saveCostCentreM(companyId: string, b: Record<string, unknown>, id?: string) {
  canPostIn(companyId);
  const name = String(b.name ?? '').trim();
  if (!name) fail(400, 'Enter the cost centre name.', 'err.costCentreName');
  if (db.costCentres.some((c) => c.companyId === companyId && c.id !== id && c.name.toLowerCase() === name.toLowerCase())) fail(400, 'Another cost centre already has this name.', 'err.costCentreTaken');
  const parentId = (b.parentId as string) || null;
  if (parentId && (parentId === id || !db.costCentres.some((c) => c.id === parentId && c.companyId === companyId && c.kind !== 'project'))) fail(400, 'Choose a branch or department as the parent.', 'err.costCentreParent');
  const v = { name, nameAr: (b.nameAr as string)?.trim() || null, kind: b.kind === 'department' ? 'department' : 'branch', parentId, status: b.status === 'closed' ? 'closed' : 'active' };
  if (id) { Object.assign(db.costCentres.find((c) => c.id === id && c.companyId === companyId && c.kind !== 'project') ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); db.costCentres.push({ id: nid, companyId, ...v }); return nid;
}
function addAttachmentM(owner: { documentId?: string; noteId?: string }, b: Record<string, unknown>) {
  const companyId = owner.documentId ? docOf(owner.documentId).companyId : noteOf(owner.noteId!).companyId;
  canPostIn(companyId);
  const fileName = String(b.fileName ?? '').trim();
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const type = ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext];
  if (!type) fail(400, 'Attach a PDF or a picture.', 'err.attachmentType');
  const data = String(b.data ?? '');
  const size = Math.floor((data.length * 3) / 4);
  if (!size) fail(400, 'The file is empty.', 'err.attachmentEmpty');
  if (size > 10 * 1024 * 1024) fail(400, 'Files can be up to 10 MB.', 'err.attachmentSize');
  const id = uid();
  adb.files.push({ id, companyId, documentId: owner.documentId ?? null, noteId: owner.noteId ?? null, fileName, contentType: type!, size, dataUrl: `data:${type};base64,${data}`,
    uploadedBy: db.users.find((u) => u.id === session)?.name ?? '', uploadedAt: new Date().toISOString() });
  return id;
}
const attachmentRows = (f: (a: MAttachment) => boolean) => adb.files.filter((a) => f(a) && roleOf(session, a.companyId))
  .map(({ id, fileName, contentType, size, dataUrl, uploadedBy, uploadedAt }) => ({ id, fileName, contentType, size, dataUrl, uploadedBy, uploadedAt }));

/** Sample bank, stock and asset data, as in src/db/seed.ts. */
function seedOps(companyId: string, poster: string, c: { country: string }, contacts: { gulf: string; faisal: string; najd: string; fitOut: string }) {
  const prev = session; session = poster;
  const acct = (code: string) => acctBy(companyId, code).id;
  const cc = (name: string) => db.costCentres.find((x) => x.companyId === companyId && x.name === name)!.id;
  const fa = [
    { name: 'Delivery van', nameAr: 'شاحنة التوصيل', code: '1510', bought: daysAgo(430), cost: 8500000n, residual: 1500000n, life: 60, centre: 'Branch 1', serial: 'ABC 1234' },
    { name: 'Office furniture', nameAr: 'أثاث المكتب', code: '1520', bought: daysAgo(800), cost: 1800000n, residual: 0n, life: 84, centre: 'Head office', serial: null },
    { name: 'Laptops (4)', nameAr: 'أجهزة حاسب محمولة (4)', code: '1530', bought: daysAgo(300), cost: 960000n, residual: 0n, life: 36, centre: 'Head office', serial: null },
  ];
  const booksStart = daysAgo(120);
  const opening = fa.map((x) => targetDepreciation({ cost: x.cost, residual: x.residual, lifeMonths: x.life, start: monthStart(x.bought), opening: 0n }, previousMonthEnd(booksStart)));
  const tc = fa.reduce((t, x) => t + x.cost, 0n), to = opening.reduce((t, x) => t + x, 0n);
  post(poster, companyId, booksStart, 'Opening balances · fixed assets', [...fa.map((x) => ({ accountId: acct(x.code), costCentreId: null, debit: x.cost, credit: 0n })),
    { accountId: acct('1590'), costCentreId: null, debit: 0n, credit: to }, { accountId: acct('3000'), costCentreId: null, debit: 0n, credit: tc - to }]);
  fa.forEach((x, i) => saveAssetM(companyId, { name: x.name, nameAr: x.nameAr, assetAccountId: acct(x.code), purchaseDate: x.bought, cost: s(x.cost), residualValue: s(x.residual),
    usefulLifeMonths: x.life, openingDepreciation: s(opening[i]!), costCentreId: cc(x.centre), serialNo: x.serial }));
  for (let m = monthEnd(booksStart); m <= previousMonthEnd(today()); m = nextMonthEnd(m)) runM(companyId, m);

  if (db.companies.find((x) => x.id === companyId)!.industry === 'restaurant') {
    const mats: Record<string, string> = {};
    for (const m of DEMO_RESTAURANT.materials) mats[m.sku] = saveItemM(companyId, { sku: m.sku, name: m.name, nameAr: m.nameAr, unit: m.unit, reorderLevel: m.reorder });
    postNoteM(saveNoteM(companyId, { type: 'grn', date: daysAgo(20), contactId: contacts.najd, reference: 'Weekly delivery',
      lines: DEMO_RESTAURANT.materials.map((m) => ({ itemId: mats[m.sku], quantity: m.qty, unitCost: m.cost })) }));
    const menu: Record<string, string> = {};
    for (const r of DEMO_RESTAURANT.recipes) menu[r.name] = saveRecipeM(companyId, { name: r.name, nameAr: r.nameAr, category: r.category, salePrice: r.price,
      lines: r.lines.map(([sku, quantity]) => ({ itemId: mats[sku], quantity })) });
    for (const sale of DEMO_RESTAURANT.sales) {
      sellM(companyId, { date: daysAgo(sale.ago), method: sale.method, accountId: sale.method === 'cash' ? acct('1010') : sale.method === 'card' ? acct('1000') : null,
        contactId: sale.method === 'on_account' ? contacts.faisal : null, costCentreId: cc('Head office'), lines: sale.items.map(([name, quantity]) => ({ recipeId: menu[name], quantity })) });
    }
  } else {
    const item = (sku: string, name: string, nameAr: string, unit: string, salePrice: string, reorderLevel: string) => saveItemM(companyId, { sku, name, nameAr, unit, salePrice, reorderLevel });
    const beam = item('ST-12', 'Steel beam 12m', 'عارضة حديد 12م', 'pcs', '650.00', '10');
    const rebar = item('RB-16', 'Rebar 16mm', 'حديد تسليح 16مم', 'ton', '2600.00', '3');
    const angle = item('AI-50', 'Angle iron 50x50', 'زاوية حديد 50×50', 'pcs', '45.00', '50');
    const note = (type: NoteType, ago: number, contactId: string | null, lines: object[], reference: string, other?: string) =>
      postNoteM(saveNoteM(companyId, { type, date: daysAgo(ago), contactId, reference, otherAccountId: other ? acct(other) : null, lines }));
    note('grn', 110, null, [{ itemId: beam, quantity: '30', unitCost: '410.00' }, { itemId: rebar, quantity: '6', unitCost: '2150.00' }, { itemId: angle, quantity: '200', unitCost: '28.50' }], 'Opening stock count', '3000');
    note('grn', 9, contacts.najd, [{ itemId: beam, quantity: '20', unitCost: '425.00' }, { itemId: angle, quantity: '100', unitCost: '29.00' }], 'NW-DN-5531');
    note('gdn', 3, contacts.gulf, [{ itemId: beam, quantity: '15', costCentreId: cc('Head office') }, { itemId: angle, quantity: '40', costCentreId: cc('Head office') }], 'PO-4520');
    note('gdn', 1, contacts.faisal, [{ itemId: rebar, quantity: '4', costCentreId: contacts.fitOut }], 'Warehouse fit-out');
  }

  const bank = banksOf(companyId).find((b) => b.accountId === acct('1000'))!;
  const sa = c.country === 'SA';
  saveBankM(companyId, sa ? { kind: 'bank', iban: 'SA03 8000 0000 6080 1016 7519', accountNumber: '608010167519', name: 'Al Rajhi Bank – current account', nameAr: 'مصرف الراجحي – الحساب الجاري' }
    : { kind: 'bank', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1234567890123456', name: 'Mashreq – current account', nameAr: 'بنك المشرق – الحساب الجاري' }, bank.id);
  const from = daysAgo(45);
  const inBooks = db.entries.filter((e) => e.companyId === companyId && e.date >= from && e.date < daysAgo(1) && !/Office water|Reversal/.test(e.memo ?? ''))
    .flatMap((e) => e.lines.filter((l) => l.accountId === bank.accountId).map((l) => ({ date: e.date, amount: l.debit - l.credit,
      description: String(e.memo ?? 'TRANSFER').replace(/^[A-Z]+-\d+ · /, (m) => (l.debit > 0n ? 'TRF IN ' : 'TRF OUT ') + m).toUpperCase() })));
  const extras = [
    { date: daysAgo(30), description: 'STC BUSINESS BILL 0112233', amount: sa ? -34500n : -15750n }, { date: daysAgo(14), description: 'POS PETROMIN STATION 44', amount: -8625n },
    { date: daysAgo(7), description: 'BANK SERVICE CHARGES', amount: -2500n }, { date: daysAgo(5), description: 'STC BUSINESS BILL 0112233', amount: sa ? -29900n : -13650n },
  ];
  let bal = ledgerSum(bank.accountId, daysAgo(46));
  const statement = [...inBooks, ...extras].sort((a, b) => a.date.localeCompare(b.date)).map((l) => { bal += l.amount; return { date: l.date, description: l.description, reference: null, amount: s(l.amount), balance: s(bal) }; });
  importM(bank.id, { fileName: 'statement-last-45-days.csv', lines: statement });
  saveRuleM(companyId, { matchText: 'STC', direction: 'out', accountId: acct('5300'), vatCode: 'standard', label: 'Mobile and internet' });
  saveRuleM(companyId, { matchText: 'BANK SERVICE CHARGES', direction: 'out', accountId: acct('5400'), vatCode: 'exempt', label: 'Bank charges' });
  for (const l of linesM(bank.id, 'open')) {
    if (l.suggestion?.kind === 'match' && l.date < daysAgo(20)) matchToM(odb.lines.find((x) => x.id === l.id)!, (l.suggestion as { journalLineId: string }).journalLineId);
  }
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
  const industry = (c as Record<string, unknown>).industry;
  if (!isIndustry(industry)) fail(400, 'Choose the industry.', 'err.industry');
  const mods = (c as Record<string, unknown>).modules;
  Object.assign(co, {
    industry, modules: Array.isArray(mods) ? cleanModules(mods) : [...DEFAULT_MODULES[industry as Industry]],
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
      company: { ...companyView(c), vatStatus: c.vatStatus, vatNumber: c.vatNumber, crNumber: c.crNumber, city: c.city, invoicePrefix: c.invoicePrefix, paymentTermsDays: c.paymentTermsDays,
        industry: c.industry, modules: c.modules },
      role, canPost: POSTING.includes(role), canLock: role === 'partner',
      access: (() => { const r = clientRoleIn(c.id); return r && { name: r.name, nameAr: r.nameAr, permissions: r.permissions, canApprove: r.canApprove }; })(),
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
      return { costCentreId: ccId, name: cc?.name ?? null, nameAr: cc?.nameAr ?? null, kind: cc?.kind ?? null, income: s(r.income), expense: s(r.expense), profit: s(r.income - r.expense) };
    }).sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
    const sums: Record<string, bigint> = { revenue: 0n, other_income: 0n, cost_of_sales: 0n, indirect_expense: 0n };
    const lines = db.accounts.filter((a) => a.companyId === id && (a.type === 'income' || a.type === 'expense')).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
      let v = 0n;
      for (const e of db.entries) if (e.companyId === id && e.date >= from && e.date <= to) for (const l of e.lines) if (l.accountId === a.id) v += a.type === 'income' ? l.credit - l.debit : l.debit - l.credit;
      const group = pnlGroupOf(a)!; sums[group]! += v;
      return { accountId: a.id, name: a.name, nameAr: a.nameAr, group, amount: s(v), v };
    }).filter((a) => a.v !== 0n).map(({ v: _v, ...a }) => a);
    const gross = sums.revenue! - sums.cost_of_sales!;
    const statement = { lines, revenue: s(sums.revenue!), costOfSales: s(sums.cost_of_sales!), grossProfit: s(gross), indirectExpenses: s(sums.indirect_expense!),
      otherIncome: s(sums.other_income!), netProfit: s(gross - sums.indirect_expense! + sums.other_income!) };
    return { from, to, total: { income: s(income), expense: s(expense), profit: s(income - expense) }, byCostCentre, statement };
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
    const id = inCo(m[1]!); const r = q.get('role'); const role = r === 'supplier' ? 'isSupplier' : r === 'employee' ? 'isEmployee' : 'isCustomer'; const needle = (q.get('q') ?? '').trim().toLowerCase();
    return sdb.contacts.filter((c) => c.companyId === id && (r === 'payee' ? c.isSupplier || c.isEmployee : c[role]) && (!needle || [c.name, c.nameAr, c.vatNumber].join(' ').toLowerCase().includes(needle)))
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
    return { ...docRow(d), contact: c, seller: { ...sellerOf(co), originalNumber: sdb.docs.find((o) => o.id === d.originalId)?.number ?? null }, issuedAt: d.journalEntryId ? db.entries.find((e) => e.id === d.journalEntryId)?.createdAt ?? null : null,
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
  // ---------------------------------------------------------------- chart of accounts, cost centres, attachments, print header
  ['GET', /^\/api\/companies\/([\w-]+)\/print-header$/, (m) => ({ seller: sellerOf(company(inCo(m[1]!))) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/chart$/, (m) => { const id = inCo(m[1]!);
    return db.accounts.filter((a) => a.companyId === id).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
      const ls = db.entries.flatMap((e) => e.lines).filter((l) => l.accountId === a.id);
      return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, costCentreRequired: a.costCentreRequired, isBank: a.isBank, pnlGroup: pnlGroupOf(a), balance: s(ls.reduce((t, l) => t + l.debit - l.credit, 0n)), postings: ls.length };
    }); }],
  ['GET', /^\/api\/companies\/([\w-]+)\/chart\/next-code$/, (m, _b, q) => ({ code: nextCodeM(inCo(m[1]!), q.get('type') ?? 'expense') })],
  ['POST', /^\/api\/companies\/([\w-]+)\/accounts$/, (m, b) => ({ id: saveAccountM(inCo(m[1]!), b ?? {}) })],
  ['POST', /^\/api\/accounts\/([\w-]+)$/, (m, b) => { const a = db.accounts.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { id: saveAccountM(a.companyId, b ?? {}, a.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/cost-centres$/, (m) => { const id = inCo(m[1]!);
    return db.costCentres.filter((c) => c.companyId === id).map((c) => { const p = db.costCentres.find((x) => x.id === (c as { parentId?: string | null }).parentId);
      return { id: c.id, name: c.name, nameAr: c.nameAr, kind: c.kind, status: c.status ?? 'active', parentId: (c as { parentId?: string | null }).parentId ?? null, parentName: p?.name ?? null, parentNameAr: p?.nameAr ?? null,
        postings: db.entries.flatMap((e) => e.lines).filter((l) => l.costCentreId === c.id).length }; })
      .sort((a, b) => Number(a.kind === 'project') - Number(b.kind === 'project') || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/cost-centres$/, (m, b) => ({ id: saveCostCentreM(inCo(m[1]!), b ?? {}) })],
  ['POST', /^\/api\/cost-centres\/([\w-]+)$/, (m, b) => { const c = db.costCentres.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { id: saveCostCentreM(c.companyId, b ?? {}, c.id) }; }],
  ['GET', /^\/api\/documents\/([\w-]+)\/attachments$/, (m) => { docOf(m[1]!); return attachmentRows((a) => a.documentId === m[1]); }],
  ['POST', /^\/api\/documents\/([\w-]+)\/attachments$/, (m, b) => ({ id: addAttachmentM({ documentId: m[1]! }, b ?? {}) })],
  ['GET', /^\/api\/stock-notes\/([\w-]+)\/attachments$/, (m) => { noteOf(m[1]!); return attachmentRows((a) => a.noteId === m[1]); }],
  ['POST', /^\/api\/stock-notes\/([\w-]+)\/attachments$/, (m, b) => ({ id: addAttachmentM({ noteId: m[1]! }, b ?? {}) })],
  ['POST', /^\/api\/attachments\/([\w-]+)\/delete$/, (m) => { const a = adb.files.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); canPostIn(a.companyId);
    const draft = a.documentId ? sdb.docs.find((d) => d.id === a.documentId)?.status === 'draft' : odb.notes.find((n) => n.id === a.noteId)?.status === 'draft';
    if (!draft) fail(400, 'Attachments of an issued document are kept.', 'err.attachmentKept');
    adb.files = adb.files.filter((x) => x.id !== a.id); return { ok: true }; }],
  // ---------------------------------------------------------------- restaurant
  ['GET', /^\/api\/companies\/([\w-]+)\/recipes$/, (m, _b, q) => { const id = inCo(m[1]!); const n = (q.get('q') ?? '').trim().toLowerCase();
    return rdb.recipes.filter((r) => r.companyId === id && (!n || [r.name, r.nameAr, r.category].join(' ').toLowerCase().includes(n))).map(recipeRow)
      .sort((a, b) => a.status.localeCompare(b.status) || (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name)); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/recipes$/, (m, b) => ({ id: saveRecipeM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/recipes\/([\w-]+)$/, (m) => recipeRow(recipeOf(m[1]!))],
  ['POST', /^\/api\/recipes\/([\w-]+)$/, (m, b) => { const r = recipeOf(m[1]!); return { id: saveRecipeM(r.companyId, b ?? {}, r.id) }; }],
  ['POST', /^\/api\/companies\/([\w-]+)\/restaurant\/sales$/, (m, b) => sellM(inCo(m[1]!), b ?? {})],
  ['GET', /^\/api\/companies\/([\w-]+)\/restaurant\/sales$/, (m, _b, q) => { const to = q.get('to') || today(); return salesM(inCo(m[1]!), q.get('from') || to, to); }],
  // ---------------------------------------------------------------- bank
  ['GET', /^\/api\/companies\/([\w-]+)\/bank-accounts$/, (m) => banksOf(inCo(m[1]!)).map(bankRow).sort((a, b) => a.status.localeCompare(b.status) || a.code.localeCompare(b.code))],
  ['POST', /^\/api\/companies\/([\w-]+)\/bank-accounts$/, (m, b) => ({ id: saveBankM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/bank-accounts\/([\w-]+)$/, (m) => bankRow(bankOf(m[1]!))],
  ['POST', /^\/api\/bank-accounts\/([\w-]+)$/, (m, b) => { const x = bankOf(m[1]!); return { id: saveBankM(x.companyId, b ?? {}, x.id) }; }],
  ['POST', /^\/api\/bank-accounts\/([\w-]+)\/import$/, (m, b) => importM(m[1]!, b ?? {})],
  ['GET', /^\/api\/bank-accounts\/([\w-]+)\/imports$/, (m) => { bankOf(m[1]!); return odb.imports.filter((i) => i.bankId === m[1]).reverse().map((i) => ({ ...i,
    importedBy: db.users.find((u) => u.id === i.importedBy)?.name, remaining: odb.lines.filter((l) => l.importId === i.id).length, matched: odb.lines.filter((l) => l.importId === i.id && l.status === 'matched').length })); }],
  ['POST', /^\/api\/bank-imports\/([\w-]+)\/undo$/, (m) => { const i = odb.imports.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); canPostIn(i.companyId);
    const before = odb.lines.length; odb.lines = odb.lines.filter((l) => l.importId !== i.id || l.status === 'matched'); return { removed: before - odb.lines.length }; }],
  ['GET', /^\/api\/bank-accounts\/([\w-]+)\/lines$/, (m, _b, q) => linesM(m[1]!, q.get('status') ?? 'all')],
  ['GET', /^\/api\/bank-accounts\/([\w-]+)\/reconciliation$/, (m) => reconM(m[1]!)],
  ['POST', /^\/api\/bank-accounts\/([\w-]+)\/apply-rules$/, (m) => { const ls = linesM(m[1]!, 'open').filter((l) => l.suggestion?.kind === 'rule');
    for (const l of ls) { const x = l.suggestion as { accountId: string; costCentreId: string | null; vatCode: string; label: string | null }; bookM(l.id, { ...x, description: x.label }); } return { booked: ls.length }; }],
  ['GET', /^\/api\/bank-lines\/([\w-]+)\/candidates$/, (m) => { const l = lineOf(m[1]!); const b = odb.banks.find((x) => x.id === l.bankId)!;
    return unmatchedM(b.accountId).filter((x) => x.amount === l.amount).sort((x, y) => days(x.date, l.date) - days(y.date, l.date)).map((x) => ({ journalLineId: x.id, date: x.date, memo: x.memo, amount: s(x.amount) })); }],
  ['POST', /^\/api\/bank-lines\/([\w-]+)\/match$/, (m, b) => { matchToM(openLineOf(m[1]!), String(b?.journalLineId ?? '')); return { ok: true }; }],
  ['POST', /^\/api\/bank-lines\/([\w-]+)\/unmatch$/, (m) => { const l = lineOf(m[1]!); canPostIn(l.companyId); l.status = 'open'; l.journalLineId = null; return { ok: true }; }],
  ['POST', /^\/api\/bank-lines\/([\w-]+)\/ignore$/, (m) => { openLineOf(m[1]!).status = 'ignored'; return { ok: true }; }],
  ['POST', /^\/api\/bank-lines\/([\w-]+)\/book$/, (m, b) => ({ entryId: bookM(m[1]!, b ?? {}) })],
  ['POST', /^\/api\/bank-lines\/([\w-]+)\/pay$/, (m, b) => ({ paymentId: payLineM(m[1]!, String(b?.contactId ?? '')) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/bank-rules$/, (m) => { const id = inCo(m[1]!); return odb.rules.filter((r) => r.companyId === id).map(ruleRow).sort((a, b) => Number(b.active) - Number(a.active) || a.matchText.localeCompare(b.matchText)); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/bank-rules$/, (m, b) => ({ id: saveRuleM(inCo(m[1]!), b ?? {}) })],
  ['POST', /^\/api\/bank-rules\/([\w-]+)$/, (m, b) => { const r = odb.rules.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { id: saveRuleM(r.companyId, b ?? {}, r.id) }; }],
  ['POST', /^\/api\/bank-rules\/([\w-]+)\/delete$/, (m) => { const r = odb.rules.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); canPostIn(r.companyId);
    odb.rules = odb.rules.filter((x) => x.id !== r.id); return { ok: true }; }],
  // ---------------------------------------------------------------- inventory
  ['GET', /^\/api\/companies\/([\w-]+)\/items$/, (m, _b, q) => { const id = inCo(m[1]!); const n = (q.get('q') ?? '').trim().toLowerCase();
    return odb.items.filter((i) => i.companyId === id && (!n || [i.name, i.nameAr, i.sku].join(' ').toLowerCase().includes(n))).sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)).map(itemRow); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/items$/, (m, b) => ({ id: saveItemM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/items\/([\w-]+)$/, (m) => { const i = itemOf(m[1]!); let q = 0n, v = 0n;
    const movements = odb.notes.filter((n) => n.status === 'posted').sort((a, b) => a.postedAt!.localeCompare(b.postedAt!)).flatMap((n) => n.lines.filter((l) => l.itemId === i.id).map((l) => {
      const sign = n.type === 'grn' ? 1n : -1n; q += sign * l.q; v += sign * l.value;
      return { noteId: n.id, type: n.type, number: n.number, date: n.date, contactName: sdb.contacts.find((c) => c.id === n.contactId)?.name ?? null, quantity: qtyStr(l.q), value: s(l.value), qtyAfter: qtyStr(q), valueAfter: s(v) }; }));
    return { ...itemRow(i), movements }; }],
  ['POST', /^\/api\/items\/([\w-]+)$/, (m, b) => { const i = itemOf(m[1]!); return { id: saveItemM(i.companyId, b ?? {}, i.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/stock-value$/, (m) => { const id = inCo(m[1]!);
    const items = odb.items.filter((i) => i.companyId === id && (i.status === 'active' || i.v !== 0n)).sort((a, b) => a.name.localeCompare(b.name)).map(itemRow);
    const total = odb.items.filter((i) => i.companyId === id).reduce((t, i) => t + i.v, 0n); const books = ledgerSum(acctBy(id, '1300').id);
    return { items, total: s(total), booksValue: s(books), difference: s(books - total) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/stock-notes$/, (m, _b, q) => { const id = inCo(m[1]!); const n = (q.get('q') ?? '').trim().toLowerCase();
    return odb.notes.filter((x) => x.companyId === id && x.type === q.get('type') && (q.get('manual') !== '1' || !rdb.sales.some((r) => r.noteId === x.id))).map(noteRow).filter((x) => !n || [x.number, x.contactName, x.reference].join(' ').toLowerCase().includes(n))
      .sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/stock-notes$/, (m, b) => ({ id: saveNoteM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/stock-notes\/([\w-]+)$/, (m) => { const n = noteOf(m[1]!);
    return { ...noteRow(n), lines: n.lines.map((l, i) => { const it = odb.items.find((x) => x.id === l.itemId)!; const cc = db.costCentres.find((x) => x.id === l.costCentreId);
      return { id: l.id, lineNo: i + 1, itemId: it.id, sku: it.sku, name: it.name, nameAr: it.nameAr, unit: it.unit, quantity: qtyStr(l.q), unitCost: l.unitCost === null ? null : s(l.unitCost),
        value: s(l.value), costCentreId: l.costCentreId, costCentre: cc?.name ?? null, costCentreAr: cc?.nameAr ?? null }; }) }; }],
  ['POST', /^\/api\/stock-notes\/([\w-]+)$/, (m, b) => { const n = noteOf(m[1]!); return { id: saveNoteM(n.companyId, b ?? {}, n.id) }; }],
  ['POST', /^\/api\/stock-notes\/([\w-]+)\/post$/, (m) => { postNoteM(m[1]!); return { ok: true }; }],
  ['POST', /^\/api\/stock-notes\/([\w-]+)\/delete$/, (m) => { const n = noteOf(m[1]!); canPostIn(n.companyId); if (n.status !== 'draft') fail(400, 'Posted goods notes are never changed.', 'err.notePosted');
    odb.notes = odb.notes.filter((x) => x.id !== n.id); return { ok: true }; }],
  // ---------------------------------------------------------------- fixed assets
  ['GET', /^\/api\/companies\/([\w-]+)\/assets$/, (m, _b, q) => { const id = inCo(m[1]!); const n = (q.get('q') ?? '').trim().toLowerCase();
    return odb.assets.filter((a) => a.companyId === id && (!n || [a.name, a.number, a.serialNo].join(' ').toLowerCase().includes(n))).sort((a, b) => a.status.localeCompare(b.status) || a.number.localeCompare(b.number)).map(assetRow); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/assets$/, (m, b) => ({ id: saveAssetM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/asset-summary$/, (m) => assetSummaryM(inCo(m[1]!))],
  ['GET', /^\/api\/assets\/([\w-]+)$/, (m) => { const a = assetOf(m[1]!);
    return { ...assetRow(a), history: odb.runs.filter((r) => r.lines.some((l) => l.assetId === a.id)).sort((x, y) => x.periodEnd.localeCompare(y.periodEnd))
      .map((r) => ({ periodEnd: r.periodEnd, amount: s(r.lines.find((l) => l.assetId === a.id)!.amount), journalEntryId: r.journalEntryId })) }; }],
  ['POST', /^\/api\/assets\/([\w-]+)$/, (m, b) => { const a = assetOf(m[1]!); return { id: saveAssetM(a.companyId, b ?? {}, a.id) }; }],
  ['POST', /^\/api\/assets\/([\w-]+)\/dispose$/, (m, b) => ({ entryId: disposeM(m[1]!, b ?? {}) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/depreciation$/, (m) => { const id = inCo(m[1]!);
    return { next: nextRunM(id), runs: odb.runs.filter((r) => r.companyId === id).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
      .map((r) => ({ id: r.id, periodEnd: r.periodEnd, total: s(r.total), journalEntryId: r.journalEntryId, runAt: r.runAt, runBy: db.users.find((u) => u.id === r.runBy)?.name ?? '', assets: r.lines.length })) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/depreciation\/preview$/, (m, _b, q) => previewM(inCo(m[1]!), q.get('periodEnd') ?? '')],
  ['POST', /^\/api\/companies\/([\w-]+)\/depreciation\/run$/, (m, b) => runM(inCo(m[1]!), String(b?.periodEnd ?? ''))],
  // ---------------------------------------------------------------- claims, ledgers, projects
  ['POST', /^\/api\/documents\/([\w-]+)\/submit$/, (m) => { submitClaimM(m[1]!); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/reopen$/, (m) => { reopenM(m[1]!); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/approve$/, (m) => { decideM(m[1]!, true); return { ok: true }; }],
  ['POST', /^\/api\/documents\/([\w-]+)\/reject$/, (m, b) => { decideM(m[1]!, false, String(b?.reason ?? '')); return { ok: true }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/ledger\/account\/([\w-]+)$/, (m, _b, q) => { const r = rangeOf(q); return accountLedgerM(inCo(m[1]!), m[2]!, r.from, r.to); }],
  ['GET', /^\/api\/companies\/([\w-]+)\/ledger\/cost-centre\/([\w-]+)$/, (m, _b, q) => { const r = rangeOf(q); return costCentreLedgerM(inCo(m[1]!), m[2]!, r.from, r.to); }],
  ['GET', /^\/api\/companies\/([\w-]+)\/ledger\/contact\/([\w-]+)$/, (m, _b, q) => { const r = rangeOf(q); return contactLedgerM(inCo(m[1]!), m[2]!, r.from, r.to); }],
  ['GET', /^\/api\/companies\/([\w-]+)\/ledger\/balances\/(\w+)$/, (m, _b, q) => contactBalancesM(inCo(m[1]!), m[2]!, q.get('asOf') || today())],
  ['GET', /^\/api\/companies\/([\w-]+)\/projects$/, (m, _b, q) => { const id = inCo(m[1]!);
    return db.costCentres.filter((x) => x.companyId === id && x.kind === 'project').map((x) => projectRow(x, q.get('from'), q.get('to')))
      .sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/projects$/, (m, b) => ({ id: saveProjectM(inCo(m[1]!), b ?? {}) })],
  ['GET', /^\/api\/projects\/([\w-]+)$/, (m) => projectRow(projectOf(m[1]!))],
  ['POST', /^\/api\/projects\/([\w-]+)$/, (m, b) => { const p = projectOf(m[1]!); return { id: saveProjectM(p.companyId, b ?? {}, p.id) }; }],
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
    const id = inCo(m[1]!); const emp = sdb.contacts.find((c) => c.id === q.get('contactId'))?.isEmployee; const type = q.get('direction') === 'made' ? (emp ? 'claim' : 'bill') : 'invoice';
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
        paymentTermsDays: String(c.paymentTermsDays), status: c.status, industry: c.industry, modules: c.modules },
      users: db.memberships.filter((x) => x.companyId === c.id).map((x) => ({ x, u: db.users.find((u) => u.id === x.userId)! }))
        .filter(({ u }) => u.kind === 'client').map(({ x, u }) => ({ ...person(u), role: x.role, clientRoleId: x.clientRoleId ?? null })),
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
      crNumber: '', city: '', invoicePrefix: 'INV-', paymentTermsDays: 30, industry: 'other', modules: [], fields: {} };
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
    const cr = b?.clientRoleId ? rolesDb.find((r) => r.id === b.clientRoleId) ?? fail(404, 'Not found.', 'err.notFound') : null;
    db.memberships.push({ userId: u.id, companyId: c.id, role: cr ? roleBase(cr.permissions) : b?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant', clientRoleId: cr?.id ?? null });
    return { invite: newInvite(u) };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)\/users\/([\w-]+)\/role$/, (m, b) => {
    admin();
    const c = company(m[1]!);
    const ms = db.memberships.find((x) => x.companyId === c.id && x.userId === m[2] && db.users.find((u) => u.id === x.userId)?.kind === 'client') ?? fail(404, 'Not found.', 'err.notFound');
    const cr = b?.clientRoleId ? rolesDb.find((r) => r.id === b.clientRoleId) ?? fail(404, 'Not found.', 'err.notFound') : null;
    ms.clientRoleId = cr?.id ?? null;
    ms.role = cr ? roleBase(cr.permissions) : b?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant';
    logActivity('act.roleAssigned', { name: db.users.find((u) => u.id === ms.userId)!.name, client: c.name, role: cr?.name ?? ms.role });
    return { ok: true };
  }],
  ['GET', /^\/api\/admin\/roles$/, () => { admin();
    return [...rolesDb].sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name))
      .map((r) => ({ ...r, users: db.memberships.filter((x) => x.clientRoleId === r.id).length })); }],
  ['POST', /^\/api\/admin\/roles$/, (_m, b) => { admin(); const r = { id: uid(), ...roleValues(b) }; rolesDb.push(r); logActivity('act.roleAdded', { role: r.name }); return { id: r.id }; }],
  ['POST', /^\/api\/admin\/roles\/([\w-]+)$/, (m, b) => {
    admin();
    const r = rolesDb.find((x) => x.id === m[1]) ?? fail(404, 'Not found.', 'err.notFound');
    const v = roleValues(b, r.id);
    if (v.status === 'archived' && db.memberships.some((x) => x.clientRoleId === r.id)) fail(400, 'People still have this role. Give them another role first.', 'err.roleInUse');
    Object.assign(r, v);
    for (const x of db.memberships) if (x.clientRoleId === r.id) x.role = roleBase(r.permissions);
    logActivity('act.roleUpdated', { role: r.name });
    return { ok: true };
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

function roleValues(b: Body, id?: string): Omit<ClientRole, 'id'> {
  const name = String(b?.name ?? '').trim();
  if (!name) fail(400, 'Enter the title.', 'err.roleName');
  if (rolesDb.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) fail(400, 'Another role already has this title.', 'err.roleTaken');
  const permissions: Record<string, AccessLevel> = {};
  for (const m of ROLE_MODULES) { const v = (b?.permissions as Record<string, unknown> | undefined)?.[m]; if (v === 'view' || v === 'edit') permissions[m] = v; }
  return { name, nameAr: String(b?.nameAr ?? '').trim() || null, description: String(b?.description ?? '').trim() || null, permissions,
    canApprove: Boolean(b?.canApprove), status: b?.status === 'archived' ? 'archived' : 'active' };
}

// Access by client role, for requests about a company (same idea as src/api/permissions.ts, simplified).
const PATH_MODULES: [RegExp, string[]][] = [
  [/^(recurring|expense-categories|expense-overview)/, ['Expenses']],
  [/^(entries|periods)/, ['Journal']],
  [/^ledger\/cost-centre/, ['Ledger', 'Projects']],
  [/^(ledger|chart|accounts|cost-centres)/, ['Ledger']],
  [/^reports/, ['Reports']],
  [/^(bank-accounts|bank-rules)/, ['Bank']],
  [/^(items|stock-notes|stock-value)/, ['Inventory', 'Restaurant']],
  [/^(recipes|restaurant)/, ['Restaurant']],
  [/^(assets|asset-summary|depreciation)/, ['Assets']],
  [/^projects/, ['Projects']],
];
const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };
function checkAccess(method: string, path: string, body: Body, q: URLSearchParams) {
  const docMods = (type: string) => (type === 'expense' || type === 'claim' ? ['Expenses'] : ['bill', 'supplier_credit'].includes(type) ? ['Purchases'] : ['Sales']);
  let companyId: string | undefined, mods: string[] | undefined, approve = false;
  const cm = path.match(/^\/api\/companies\/([\w-]+)\/(.+)$/);
  const dm = path.match(/^\/api\/documents\/([\w-]+)(\/(approve|reject))?/);
  if (cm) {
    companyId = cm[1]!;
    const rest = cm[2]!;
    if (rest === 'documents') mods = docMods(String(method === 'GET' ? q.get('type') : body?.type));
    else if (rest === 'payments') mods = (method === 'GET' ? q.get('direction') : body?.direction) === 'received' ? ['Sales'] : ['Purchases', 'Expenses'];
    else if (rest === 'overview') mods = [q.get('side') === 'purchases' ? 'Purchases' : 'Sales'];
    else if (rest === 'contacts' && method === 'POST') mods = body?.isEmployee ? ['HRM', 'Expenses'] : [...(body?.isCustomer ? ['Sales', 'Restaurant'] : []), ...(body?.isSupplier ? ['Purchases', 'Expenses'] : [])];
    else if (rest === 'bank-accounts' && method === 'GET') mods = ['Bank', 'Restaurant'];
    else mods = PATH_MODULES.find(([re]) => re.test(rest))?.[1];
  } else if (dm) {
    const d = sdb.docs.find((x) => x.id === dm[1]);
    if (d) { companyId = d.companyId; mods = docMods(d.type); approve = Boolean(dm[3]); }
  }
  if (!companyId || !mods?.length || !session) return;
  const r = clientRoleIn(companyId);
  if (!r) return;
  const best = Math.max(...mods.map((m) => RANK[accessTo(r.permissions, m)]));
  if (best < RANK[method === 'GET' ? 'view' : 'edit']) fail(403, 'Your role does not allow this.', 'err.roleNoAccess');
  if (approve && !r.canApprove) fail(403, 'Your role does not allow approving claims.', 'err.roleNoApprove');
}

// Sample data is created once everything above is defined.
seed();
for (const r of DEMO_ROLES) rolesDb.push({ id: uid(), ...r, status: 'active' });
db.activity.push({ id: uid(), at: new Date().toISOString(), actor: null, key: 'act.firmCreated', params: { name: DEMO_FIRM } });

export function handle(method: string, url: string, body: unknown): { status: number; data: unknown } {
  const [path, qs] = url.split('?') as [string, string | undefined];
  try {
    const params = new URLSearchParams(qs ?? '');
    checkAccess(method, path, body as Body, params);
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
