// Demo build only: answers the same /api requests as src/api/server.ts, from sample data held in
// this browser page. It repeats the database's rules (balance, two lines, cost centres, locked
// periods, roles, company separation, registration checks) so the preview behaves like the app.
// It is NOT the source of truth: the real rules live in db/migrations and are covered by `npm test`.
// Data resets when the page reloads.
import { toMinor, fromMinor, divRoundHalfUp } from '../../../src/money.ts';
import { vatForLine } from '../../../src/vat/vat.ts';
import * as Pay from '../../../src/books/payroll.ts';
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
interface Entry { id: string; companyId: string; date: string; memo: string | null; createdBy: string; createdAt: string; reversesEntryId: string | null; lines: Line[]; manual?: boolean }
interface Membership { userId: string; companyId: string; role: Role; clientRoleId?: string | null }
interface ClientRole { id: string; name: string; nameAr: string | null; description: string | null; permissions: Record<string, AccessLevel>; canApprove: boolean; status: 'active' | 'archived' }
const rolesDb: ClientRole[] = [];
/** The first active role with the same base, for a client user added without one. */
const defaultRole = (base: Role) => rolesDb.find((r) => r.status === 'active' && roleBase(r.permissions) === base) ?? null;
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
    const p = (days: number, memo: string, lines: Omit<Line, 'id'>[]) => { const eid = post(poster, id, daysAgo(days), memo, lines); db.entries.at(-1)!.manual = true; return eid; };
    p(120, 'Opening balance', [L('1000', net(50000), 0n), L('3000', 0n, net(50000))]);
    p(60, 'Rent · head office', [L('5100', net(4000), 0n, 'Head office'), L('1000', 0n, net(4000))]);
    p(25, 'Salaries', [L('5200', net(6000), 0n, 'Head office'), L('5200', net(2500), 0n, 'Branch 1'), L('1000', 0n, net(8500))]);
    const wrong = p(12, 'Office water delivery', [L('5400', net(180), 0n), L('1000', 0n, net(180))]);
    reverse(poster, wrong, daysAgo(11));
    db.entries.at(-1)!.memo = 'Reversal: posted twice';
    seedSales(id, poster, c);
    p(1, 'Electricity', [L('5300', net(650), 0n), L('1000', 0n, net(650))]);
    seedReview(id, poster);
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
  crmQuoteSync(d.id, status);
}
const copyLines = (d: MDoc) => d.lines.map(({ description, quantity, unitPrice, accountId, costCentreId, vatCode }) => ({ description, quantity, unitPrice, accountId, costCentreId, vatCode }));
function convertM(id: string) {
  const q = docOf(id); canPostIn(q.companyId);
  if (q.type !== 'quotation' || !['sent', 'accepted'].includes(q.status)) fail(400, 'Send or accept the quotation first.', 'err.quoteNotSent');
  const terms = sdb.contacts.find((c) => c.id === q.contactId)!.paymentTermsDays ?? 30;
  const nid = saveDraftM(q.companyId, { type: 'invoice', contactId: q.contactId, issueDate: today(), dueDate: addDays(today(), terms), reference: q.number, notes: q.notes, originalId: q.id, lines: copyLines(q) });
  q.status = 'invoiced';
  crmQuoteSync(q.id, 'invoiced');
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
  seedHrm(companyId, poster);
  seedCrm(companyId, poster);
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
interface MAttachment { id: string; companyId: string; documentId: string | null; noteId: string | null; hrDocId?: string | null; fileName: string; contentType: string; size: number; dataUrl: string; uploadedBy: string; uploadedAt: string }
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
function addAttachmentM(owner: { documentId?: string; noteId?: string; hrDocId?: string }, b: Record<string, unknown>) {
  const companyId = owner.documentId ? docOf(owner.documentId).companyId : owner.hrDocId ? hrDocOf(owner.hrDocId).companyId : noteOf(owner.noteId!).companyId;
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
  adb.files.push({ id, companyId, documentId: owner.documentId ?? null, noteId: owner.noteId ?? null, hrDocId: owner.hrDocId ?? null, fileName, contentType: type!, size, dataUrl: `data:${type};base64,${data}`,
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
      role, canPost: POSTING.includes(role), canLock: role === 'partner', reviewedUpTo: reviewedUpToM(c.id),
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
    const eid = post(u.id, id, String(b?.entryDate ?? ''), typeof b?.memo === 'string' ? b.memo : null, lines); db.entries.at(-1)!.manual = true;
    return { id: eid };
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
    const fcr = rolesDb.find((r) => r.id === fu.clientRoleId) ?? defaultRole(fu.role === 'client_viewer' ? 'client_viewer' : 'client_accountant');
    db.memberships.push({ userId: user.id, companyId: id, role: fcr ? roleBase(fcr.permissions) : 'client_accountant', clientRoleId: fcr?.id ?? null });
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
    const cr = b?.clientRoleId ? rolesDb.find((r) => r.id === b.clientRoleId) ?? fail(404, 'Not found.', 'err.notFound') : defaultRole(b?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant');
    db.memberships.push({ userId: u.id, companyId: c.id, role: cr ? roleBase(cr.permissions) : b?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant', clientRoleId: cr?.id ?? null });
    return { invite: newInvite(u) };
  }],
  ['POST', /^\/api\/admin\/companies\/([\w-]+)\/users\/([\w-]+)\/role$/, (m, b) => {
    admin();
    const c = company(m[1]!);
    const ms = db.memberships.find((x) => x.companyId === c.id && x.userId === m[2] && db.users.find((u) => u.id === x.userId)?.kind === 'client') ?? fail(404, 'Not found.', 'err.notFound');
    if (!b?.clientRoleId) fail(400, 'Choose a role.', 'err.roleChoose');
    const cr = rolesDb.find((r) => r.id === b!.clientRoleId) ?? fail(404, 'Not found.', 'err.notFound');
    ms.clientRoleId = cr.id;
    ms.role = roleBase(cr.permissions);
    logActivity('act.roleAssigned', { name: db.users.find((u) => u.id === ms.userId)!.name, client: c.name, role: cr.name });
    return { ok: true };
  }],
  ['GET', /^\/api\/admin\/roles$/, () => { admin();
    return [...rolesDb].sort((a, b) => a.status.localeCompare(b.status))
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

// ---------------------------------------------------------------- HRM (same rules as src/books/hrmService.ts and db/migrations/0017)
interface MProfile { contactId: string; companyId: string; nationality: string; idNumber: string | null; passportNo: string | null; dateOfBirth: string | null; joinDate: string;
  contractType: string; contractEnd: string | null; basic: bigint; housing: bigint; transport: bigint; other: bigint; iban: string | null; bankRouting: string | null;
  wpsPersonId: string | null; insuranceNo: string | null; insuranceRegistered: string | null; annualLeaveDays: number | null; openingLeaveDays: string; openingAsOf: string | null;
  openingEos: bigint; leavingDate: string | null; leavingReason: string | null }
interface MLeave { id: string; companyId: string; contactId: string; kind: string; startDate: string; endDate: string; days: number; reason: string | null; status: string; createdBy: string | null; decidedBy: string | null }
interface MLoan { id: string; companyId: string; contactId: string; number: string; issueDate: string; amount: bigint; installment: bigint; notes: string | null; entryId: string }
interface MPayLine { id: string; contactId: string; costCentreId: string | null; unpaidDays: number; absentDays: number; sickUnpaid: number; overtimeHours: string; loanId: string | null; note: string | null;
  l: Pay.PayLine; eos: bigint }
interface MPayRun { id: string; companyId: string; periodEnd: string; status: 'draft' | 'posted' | 'paid'; lines: MPayLine[]; entryId: string | null; paymentEntryId: string | null; paidOn: string | null; createdBy: string; postedBy: string | null }
interface MSettlement { id: string; companyId: string; contactId: string; leavingDate: string; reason: string; serviceDays: number; eosAmount: bigint; provision: bigint; leaveDays: string; leavePay: bigint; loanId: string | null; loanRecovered: bigint; totalDue: bigint; entryId: string }
interface MHrDoc { id: string; companyId: string; contactId: string; kind: string; number: string | null; issueDate: string | null; expiryDate: string | null; notes: string | null }
const hdb = { profiles: [] as MProfile[], settings: new Map<string, { employerId: string | null; bankRouting: string | null; insuranceNo: string | null }>(),
  attendance: [] as { companyId: string; contactId: string; periodEnd: string; absentDays: number; overtimeHours: string; notes: string | null }[],
  leave: [] as MLeave[], loans: [] as MLoan[], runs: [] as MPayRun[], settlements: [] as MSettlement[], docs: [] as MHrDoc[] };
const userName = (id: string | null) => db.users.find((u) => u.id === id)?.name ?? null;
const hrPostedBetween = (companyId: string, from: string, to: string) => hdb.runs.some((r) => r.companyId === companyId && r.status !== 'draft' && r.periodEnd >= from && `${r.periodEnd.slice(0, 7)}-01` <= to);
const empOf = (id: string) => sdb.contacts.find((c) => c.id === id && c.isEmployee && roleOf(session, c.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
const mStart = (pe: string) => `${pe.slice(0, 7)}-01`;
const addD = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const isMonthEnd = (p: string) => /^\d{4}-\d{2}-\d{2}$/.test(p) && Pay.daysInMonth(p) === new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7), 0)).getUTCDate();

function empRow(c: MContact) {
  const p = hdb.profiles.find((x) => x.contactId === c.id);
  const co = db.companies.find((x) => x.id === c.companyId)!;
  const pay = p ? p.basic + p.housing + p.transport + p.other : 0n;
  return { id: c.id, companyId: c.companyId, name: c.name, nameAr: c.nameAr, employeeNo: c.employeeNo, jobTitle: c.jobTitle, status: c.status, costCentreId: c.defaultCostCentreId,
    hasProfile: !!p, nationality: p?.nationality ?? null, national: p?.nationality === co.country, country: co.country as Pay.Country, idNumber: p?.idNumber ?? null, passportNo: p?.passportNo ?? null,
    dateOfBirth: p?.dateOfBirth ?? null, joinDate: p?.joinDate ?? null, contractType: p?.contractType ?? null, contractEnd: p?.contractEnd ?? null,
    basic: s(p?.basic ?? 0n), housing: s(p?.housing ?? 0n), transport: s(p?.transport ?? 0n), otherAllowance: s(p?.other ?? 0n), wage: s(pay), iban: p?.iban ?? null, bankRouting: p?.bankRouting ?? null,
    wpsPersonId: p?.wpsPersonId ?? null, insuranceNo: p?.insuranceNo ?? null, insuranceRegistered: p?.insuranceRegistered ?? null, annualLeaveDays: p?.annualLeaveDays ?? null,
    openingLeaveDays: p?.openingLeaveDays ?? '0.00', openingAsOf: p?.openingAsOf ?? null, openingEos: s(p?.openingEos ?? 0n), leavingDate: p?.leavingDate ?? null, leavingReason: p?.leavingReason ?? null,
    settled: hdb.settlements.some((x) => x.contactId === c.id) };
}
type MEmp = ReturnType<typeof empRow>;
const empsOf = (companyId: string) => sdb.contacts.filter((c) => c.companyId === companyId && c.isEmployee).sort((a, b) => a.name.localeCompare(b.name)).map(empRow);
const payOfM = (e: MEmp): Pay.PayStructure => ({ basic: toMinor(e.basic), housing: toMinor(e.housing), transport: toMinor(e.transport), other: toMinor(e.otherAllowance) });
const mny = (v: unknown): bigint => { const t = String(v ?? '').replace(/,/g, '').trim(); if (!t) return 0n; try { const x = toMinor(t); if (x < 0n) fail(400, 'Amounts cannot be negative.', 'err.amount'); return x; } catch (e) { if (e instanceof Fail) throw e; return fail(400, 'Amounts have at most 2 decimals.', 'err.amountFormat'); } };
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const dt = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function saveProfileM(contactId: string, b: Body) {
  const c = empOf(contactId); canPostIn(c.companyId);
  if (hdb.settlements.some((x) => x.contactId === contactId)) fail(400, 'This person\'s final settlement is done; their pay and leaving date no longer change.', 'err.settledFixed');
  const nationality = String(b?.nationality ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(nationality)) fail(400, 'Choose the nationality.', 'err.nationality');
  const joinDate = dt(b?.joinDate) ?? fail(400, 'Enter the join date.', 'err.joinDate');
  const basic = mny(b?.basic); if (basic <= 0n) fail(400, 'Enter the basic salary.', 'err.basicSalary');
  const iban = str(b?.iban)?.replace(/\s+/g, '').toUpperCase() ?? null;
  if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) fail(400, 'Check the IBAN.', 'err.iban');
  const old = hdb.profiles.find((x) => x.contactId === contactId);
  if (old && old.joinDate !== joinDate && hdb.runs.some((r) => r.status !== 'draft' && r.lines.some((l) => l.contactId === contactId))) fail(400, 'This person has been paid through payroll, so the join date can no longer change.', 'err.joinDateFixed');
  const leave = b?.annualLeaveDays === '' || b?.annualLeaveDays == null ? null : Number(b.annualLeaveDays);
  const v: MProfile = { contactId, companyId: c.companyId, nationality, idNumber: str(b?.idNumber), passportNo: str(b?.passportNo), dateOfBirth: dt(b?.dateOfBirth), joinDate,
    contractType: b?.contractType === 'limited' ? 'limited' : 'unlimited', contractEnd: dt(b?.contractEnd), basic, housing: mny(b?.housing), transport: mny(b?.transport), other: mny(b?.otherAllowance),
    iban, bankRouting: str(b?.bankRouting), wpsPersonId: str(b?.wpsPersonId), insuranceNo: str(b?.insuranceNo), insuranceRegistered: dt(b?.insuranceRegistered), annualLeaveDays: leave,
    openingLeaveDays: String(b?.openingLeaveDays ?? '').trim() || '0.00', openingAsOf: dt(b?.openingAsOf), openingEos: mny(b?.openingEos), leavingDate: old?.leavingDate ?? null, leavingReason: old?.leavingReason ?? null };
  if (old) Object.assign(old, v); else hdb.profiles.push(v);
}
const leaveDaysInM = (contactId: string, kind: string, from: string, to: string) => hdb.leave.filter((l) => l.contactId === contactId && l.kind === kind && l.status === 'approved' && l.endDate >= from && l.startDate <= to)
  .reduce((n, l) => n + Pay.daysBetween(l.startDate > from ? l.startDate : from, l.endDate < to ? l.endDate : to), 0);
function leaveBalanceM(e: MEmp, asOf: string) {
  if (!e.joinDate) return { earned: 0, opening: 0, taken: 0, balance: 0 };
  const from = e.openingAsOf && e.openingAsOf > e.joinDate ? addD(e.openingAsOf, 1) : e.joinDate;
  const until = e.leavingDate && e.leavingDate < asOf ? e.leavingDate : asOf;
  const all = Pay.leaveEarnedHundredths(e.country, e.joinDate, until, e.annualLeaveDays);
  const before = from > e.joinDate ? Pay.leaveEarnedHundredths(e.country, e.joinDate, addD(from, -1), e.annualLeaveDays) : 0;
  const earned = Math.max(all - before, 0), opening = Math.round(Number(e.openingLeaveDays) * 100), taken = leaveDaysInM(e.id, 'annual', from, until) * 100;
  return { earned: earned / 100, opening: opening / 100, taken: taken / 100, balance: (earned + opening - taken) / 100 };
}
const loanBalanceM = (l: MLoan) => l.amount - hdb.runs.filter((r) => r.status !== 'draft').flatMap((r) => r.lines).filter((x) => x.loanId === l.id).reduce((t, x) => t + x.l.loan, 0n)
  - hdb.settlements.filter((x) => x.loanId === l.id).reduce((t, x) => t + x.loanRecovered, 0n);
const openLoanM = (contactId: string) => hdb.loans.filter((l) => l.contactId === contactId && loanBalanceM(l) > 0n).sort((a, b) => a.issueDate.localeCompare(b.issueDate))[0] ?? null;
const provisionM = (e: MEmp) => toMinor(e.openingEos) + hdb.runs.filter((r) => r.status !== 'draft').flatMap((r) => r.lines).filter((x) => x.contactId === e.id).reduce((t, x) => t + x.eos, 0n);
const inMonthM = (e: MEmp, pe: string) => e.hasProfile && e.joinDate! <= pe && (!e.leavingDate || e.leavingDate >= mStart(pe));

function computeLineM(e: MEmp, pe: string, kept: { bonus: bigint; otherDeductions: bigint; note: string | null }): MPayLine {
  const from = mStart(pe);
  const att = hdb.attendance.find((a) => a.contactId === e.id && a.periodEnd === pe);
  const loan = e.settled ? null : openLoanM(e.id);
  const pay = payOfM(e);
  const base: Pay.PayLineInput = { country: e.country, national: e.national, registeredOn: e.insuranceRegistered, pay, periodEnd: pe, joinDate: e.joinDate!, endDate: e.leavingDate,
    unpaidLeaveDays: leaveDaysInM(e.id, 'unpaid', from, pe), absentDays: att?.absentDays ?? 0,
    sickUnpaidHundredths: Pay.sickUnpaidHundredths(e.country, leaveDaysInM(e.id, 'sick', addD(from, -365), addD(from, -1)), leaveDaysInM(e.id, 'sick', from, pe)),
    overtimeHundredths: Pay.hoursToHundredths(att?.overtimeHours ?? '0'), bonus: kept.bonus, otherDeductions: kept.otherDeductions, loanDeduction: 0n };
  const before = Pay.payLine(base);
  const lb = loan ? loanBalanceM(loan) : 0n;
  const ld = loan ? [loan.installment, lb, before.net > 0n ? before.net : 0n].reduce((a, b) => (a < b ? a : b)) : 0n;
  const l = Pay.payLine({ ...base, loanDeduction: ld });
  if (l.net < 0n) fail(400, `Deductions for ${e.name} are more than the pay this month.`, 'err.payrollNegative', [e.name]);
  const end = e.leavingDate && e.leavingDate < pe ? e.leavingDate : pe;
  const eos = e.settled ? 0n : Pay.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: end, pay, reason: 'termination' }, true).amount - provisionM(e);
  return { id: uid(), contactId: e.id, costCentreId: e.costCentreId, unpaidDays: base.unpaidLeaveDays, absentDays: base.absentDays, sickUnpaid: base.sickUnpaidHundredths,
    overtimeHours: (base.overtimeHundredths / 100).toFixed(2), loanId: ld > 0n ? loan!.id : null, note: kept.note, l, eos };
}
function writeLinesM(r: MPayRun) {
  const kept = new Map(r.lines.map((x) => [x.contactId, { bonus: x.l.bonus, otherDeductions: x.l.otherDeductions, note: x.note }]));
  r.lines = empsOf(r.companyId).filter((e) => inMonthM(e, r.periodEnd) && e.status === 'active').map((e) => computeLineM(e, r.periodEnd, kept.get(e.id) ?? { bonus: 0n, otherDeductions: 0n, note: null }));
}
const runOf = (id: string) => hdb.runs.find((r) => r.id === id && roleOf(session, r.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function runRow(r: MPayRun) {
  const tot = (f: (l: Pay.PayLine) => bigint) => r.lines.reduce((t, x) => t + f(x.l), 0n);
  return { id: r.id, periodEnd: r.periodEnd, status: r.status, totalGross: s(tot((l) => l.gross)), totalNet: s(tot((l) => l.net)), totalEmployer: s(tot((l) => l.insuranceEmployer)),
    entryId: r.entryId, paymentEntryId: r.paymentEntryId, paidOn: r.paidOn, createdBy: userName(r.createdBy), postedBy: userName(r.postedBy), people: r.lines.length };
}
function runDetail(r: MPayRun) {
  const lines = r.lines.map((x) => { const c = sdb.contacts.find((k) => k.id === x.contactId)!; const l = x.l;
    return { id: x.id, contactId: x.contactId, name: c.name, nameAr: c.nameAr, employeeNo: c.employeeNo, jobTitle: c.jobTitle, costCentreId: x.costCentreId, unpaidDays: x.unpaidDays,
      absentDays: x.absentDays, sickUnpaid: x.sickUnpaid, overtimeHours: x.overtimeHours, loanId: x.loanId, note: x.note, basic: s(l.basic), housing: s(l.housing), transport: s(l.transport),
      otherAllowance: s(l.other), overtime: s(l.overtime), bonus: s(l.bonus), gross: s(l.gross), absence: s(l.absence), sick: s(l.sick), insuranceEmployee: s(l.insuranceEmployee),
      insuranceEmployer: s(l.insuranceEmployer), loan: s(l.loan), otherDeductions: s(l.otherDeductions), net: s(l.net), eosAccrual: s(x.eos) }; }).sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k: keyof (typeof lines)[number]) => s(lines.reduce((t, l) => t + toMinor(String(l[k])), 0n));
  const totals = Object.fromEntries((['basic', 'housing', 'transport', 'otherAllowance', 'overtime', 'bonus', 'gross', 'absence', 'sick', 'insuranceEmployee', 'insuranceEmployer', 'loan', 'otherDeductions', 'net', 'eosAccrual'] as const).map((k) => [k, sum(k)]));
  return { ...runRow(r), companyId: r.companyId, lines, totals, missingDetails: empsOf(r.companyId).filter((e) => !e.hasProfile && e.status === 'active').map((e) => e.name) };
}
function prepareRunM(companyId: string, pe: string) {
  canPostIn(companyId);
  if (!isMonthEnd(pe)) fail(400, 'Choose the month.', 'err.date');
  if (pe > monthEnd(today())) fail(400, 'Payroll cannot be prepared for a future month.', 'err.payrollFuture');
  let r = hdb.runs.find((x) => x.companyId === companyId && x.periodEnd === pe);
  if (r && r.status !== 'draft') fail(400, 'Payroll for this month is already posted.', 'err.payrollPosted');
  if (!r) { r = { id: uid(), companyId, periodEnd: pe, status: 'draft', lines: [], entryId: null, paymentEntryId: null, paidOn: null, createdBy: session!, postedBy: null }; hdb.runs.push(r); }
  writeLinesM(r);
  return r.id;
}
function postRunM(id: string) {
  const r = runOf(id); canPostIn(r.companyId);
  if (r.status !== 'draft') fail(400, 'Payroll for this month is already posted.', 'err.payrollPosted');
  writeLinesM(r);
  if (!r.lines.length) fail(400, 'There is nobody to pay in this payroll.', 'err.payrollEmpty');
  const a = (code: string) => acctBy(r.companyId, code);
  if (a('5200').costCentreRequired) { const none = r.lines.filter((x) => !x.costCentreId).map((x) => sdb.contacts.find((c) => c.id === x.contactId)!.name); if (none.length) fail(400, 'Salaries need a cost centre.', 'err.payrollCostCentre', none); }
  const groups = new Map<string, { cc: string | null; salary: bigint; employer: bigint; eos: bigint }>();
  let ins = 0n, loans = 0n, net = 0n, eos = 0n;
  for (const x of r.lines) {
    const g = groups.get(x.costCentreId ?? '') ?? { cc: x.costCentreId, salary: 0n, employer: 0n, eos: 0n };
    g.salary += x.l.gross - x.l.absence - x.l.sick - x.l.otherDeductions; g.employer += x.l.insuranceEmployer; g.eos += x.eos; groups.set(x.costCentreId ?? '', g);
    ins += x.l.insuranceEmployee + x.l.insuranceEmployer; loans += x.l.loan; net += x.l.net; eos += x.eos;
  }
  const side = (accountId: string, v: bigint, cc: string | null = null) => (v > 0n ? [{ accountId, costCentreId: cc, debit: v, credit: 0n }] : v < 0n ? [{ accountId, costCentreId: cc, debit: 0n, credit: -v }] : []);
  r.entryId = post(session!, r.companyId, r.periodEnd, `Payroll ${r.periodEnd.slice(0, 7)}`, [
    ...[...groups.values()].flatMap((g) => [...side(a('5200').id, g.salary, g.cc), ...side(a('5210').id, g.employer, g.cc), ...side(a('5220').id, g.eos, g.cc)]),
    ...side(a('2230').id, -eos), ...side(a('2220').id, -ins), ...side(a('1150').id, -loans), ...side(a('2210').id, -net)]);
  r.status = 'posted'; r.postedBy = session;
}
function payRunM(id: string, b: Body) {
  const r = runOf(id); canPostIn(r.companyId);
  if (r.status === 'draft') fail(400, 'Post the payroll first.', 'err.payrollNotPosted');
  if (r.status === 'paid') fail(400, 'This payroll is already paid.', 'err.payrollPaid');
  const bank = db.accounts.find((x) => x.id === b?.bankAccountId && x.companyId === r.companyId && x.isBank) ?? fail(400, 'Choose the bank or cash account.', 'err.bankAccount');
  const date = dt(b?.date) ?? fail(400, 'Enter the date.', 'err.date');
  if (date < mStart(r.periodEnd)) fail(400, 'Salaries are paid in or after their month.', 'err.payDate');
  const net = r.lines.reduce((t, x) => t + x.l.net, 0n);
  r.paymentEntryId = post(session!, r.companyId, date, `Salaries paid ${r.periodEnd.slice(0, 7)}`, [{ accountId: acctBy(r.companyId, '2210').id, costCentreId: null, debit: net, credit: 0n },
    { accountId: bank.id, costCentreId: null, debit: 0n, credit: net }]);
  r.status = 'paid'; r.paidOn = date;
}
function salaryFileM(id: string) {
  const r = runOf(id);
  if (r.status === 'draft') fail(400, 'Post the payroll first.', 'err.payrollNotPosted');
  const co = db.companies.find((c) => c.id === r.companyId)!;
  const st = hdb.settings.get(r.companyId) ?? { employerId: null, bankRouting: null, insuranceNo: null };
  const missing: string[] = [];
  const rows: Pay.WpsRow[] = r.lines.map((x) => {
    const e = empRow(sdb.contacts.find((c) => c.id === x.contactId)!);
    if (!e.iban || (co.country === 'AE' && (!e.wpsPersonId || !e.bankRouting))) missing.push(e.name);
    const extra = x.l.overtime + x.l.bonus, variable = extra < x.l.net ? extra : x.l.net;
    return { personId: e.wpsPersonId ?? '', routing: e.bankRouting ?? '', iban: e.iban ?? '', name: e.name, employeeNo: e.employeeNo ?? '', idNumber: e.idNumber ?? '', fixed: x.l.net - variable, variable,
      deductions: x.l.absence + x.l.sick + x.l.insuranceEmployee + x.l.loan + x.l.otherDeductions, net: x.l.net, leaveDays: 0, basic: x.l.basic, housing: x.l.housing, otherAllowances: x.l.transport + x.l.other + x.l.overtime + x.l.bonus };
  });
  if (co.country === 'AE' && (!st.employerId || !st.bankRouting)) missing.unshift('—');
  if (missing.length) fail(400, 'The salary file needs bank details for everyone.', 'err.wpsMissing', missing);
  if (co.country === 'AE') return { fileName: `${st.employerId}.SIF`, contentType: 'text/plain', content: Pay.uaeSif({ employerId: st.employerId!, routing: st.bankRouting!, periodEnd: r.periodEnd, createdAt: new Date(), rows }) };
  return { fileName: `payroll-${r.periodEnd.slice(0, 7)}.csv`, contentType: 'text/csv', content: Pay.saudiPayrollCsv(rows) };
}
function settlementPreviewM(contactId: string, b: Body) {
  const c = empOf(contactId); const e = empRow(c);
  if (!e.hasProfile) fail(400, 'Enter this person\'s HR details first.', 'err.noProfile');
  if (e.settled) fail(400, 'This person\'s final settlement is already done.', 'err.settled');
  const leavingDate = dt(b?.leavingDate) ?? fail(400, 'Enter the leaving date.', 'err.date');
  if (leavingDate < e.joinDate!) fail(400, 'The leaving date is before the join date.', 'err.leavingDate');
  const reason = Pay.LEAVING_REASONS.includes(b?.reason as Pay.LeavingReason) ? (b!.reason as Pay.LeavingReason) : fail(400, 'Choose why the person is leaving.', 'err.leavingReason');
  const pay = payOfM(e);
  const eos = Pay.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: leavingDate, pay, reason });
  const lh = Math.max(Math.round(leaveBalanceM({ ...e, leavingDate }, leavingDate).balance * 100), 0);
  const leavePay = Pay.leaveDaysPay(e.country, pay, lh);
  const loan = openLoanM(e.id); const lb = loan ? loanBalanceM(loan) : 0n;
  const rec = loan ? (lb < eos.amount + leavePay ? lb : eos.amount + leavePay) : 0n;
  return { contactId: e.id, name: e.name, leavingDate, reason, serviceDays: eos.serviceDays, basis: s(eos.basis), share: eos.share, eosFull: s(eos.full), eosAmount: s(eos.amount),
    leaveDays: (lh / 100).toFixed(2), leavePay: s(leavePay), loanId: loan?.id ?? null, loanBalance: s(lb), loanRecovered: s(rec), provision: s(provisionM(e)), totalDue: s(eos.amount + leavePay - rec), costCentreId: e.costCentreId };
}
function settleM(contactId: string, b: Body) {
  const p = settlementPreviewM(contactId, b); const c = empOf(contactId); canPostIn(c.companyId);
  const a = (code: string) => acctBy(c.companyId, code).id;
  const eos = toMinor(p.eosAmount), prov = toMinor(p.provision), lp = toMinor(p.leavePay), loan = toMinor(p.loanRecovered), due = toMinor(p.totalDue);
  const side = (accountId: string, v: bigint, cc: string | null = null) => (v > 0n ? [{ accountId, costCentreId: cc, debit: v, credit: 0n }] : v < 0n ? [{ accountId, costCentreId: cc, debit: 0n, credit: -v }] : []);
  const lines = [...side(a('2230'), prov), ...side(a('5220'), eos - prov, p.costCentreId), ...side(a('5200'), lp, p.costCentreId), ...side(a('1150'), -loan), ...side(a('2210'), -due)];
  if (lines.length < 2) fail(400, 'There is nothing to settle for this person.', 'err.nothingToSettle');
  const entryId = post(session!, c.companyId, p.leavingDate, `Final settlement · ${c.name}`, lines);
  hdb.settlements.push({ id: uid(), companyId: c.companyId, contactId, leavingDate: p.leavingDate, reason: p.reason, serviceDays: p.serviceDays, eosAmount: eos, provision: prov, leaveDays: p.leaveDays,
    leavePay: lp, loanId: loan > 0n ? p.loanId : null, loanRecovered: loan, totalDue: due, entryId });
  const prof = hdb.profiles.find((x) => x.contactId === contactId)!; prof.leavingDate = p.leavingDate; prof.leavingReason = p.reason;
}
function saveLeaveM(companyId: string, b: Body) {
  canPostIn(companyId);
  if (!b?.contactId) fail(400, 'Choose the employee.', 'err.employee');
  const e = empRow(empOf(String(b!.contactId)));
  const kind = ['annual', 'sick', 'unpaid', 'other_paid'].includes(String(b?.kind)) ? String(b!.kind) : fail(400, 'Choose the type of leave.', 'err.leaveKind');
  const start = dt(b?.startDate) ?? fail(400, 'Enter the dates.', 'err.date'); const end = dt(b?.endDate) ?? start;
  if (end < start) fail(400, 'The last day is before the first day.', 'err.leaveDates');
  if (e.joinDate && start < e.joinDate) fail(400, 'The leave starts before the person joined.', 'err.leaveBeforeJoin');
  if (hdb.leave.some((l) => l.contactId === e.id && ['requested', 'approved'].includes(l.status) && l.startDate <= end && l.endDate >= start)) fail(400, 'This person already has leave on some of these days.', 'err.leaveOverlap');
  const approve = Boolean(b?.approve);
  if (approve && hrPostedBetween(companyId, start, end)) fail(400, 'Payroll is posted for these dates.', 'err.leavePosted');
  const id = uid();
  hdb.leave.push({ id, companyId, contactId: e.id, kind, startDate: start, endDate: end, days: Pay.daysBetween(start, end), reason: str(b?.reason), status: approve ? 'approved' : 'requested', createdBy: session, decidedBy: approve ? session : null });
  return id;
}
function decideLeaveM(id: string, status: string) {
  const l = hdb.leave.find((x) => x.id === id && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
  canPostIn(l.companyId);
  if (!['approved', 'rejected', 'cancelled'].includes(status)) fail(400, 'Choose approve, reject or cancel.', 'err.leaveStatus');
  if (l.status === 'rejected' || l.status === 'cancelled') fail(400, 'This leave request is closed.', 'err.leaveClosed');
  if (hrPostedBetween(l.companyId, l.startDate, l.endDate) && (l.status === 'approved' || status === 'approved')) fail(400, 'Payroll is posted for these dates.', 'err.leavePosted');
  l.status = status; l.decidedBy = session;
}
function issueLoanM(companyId: string, b: Body) {
  canPostIn(companyId);
  if (!b?.contactId) fail(400, 'Choose the employee.', 'err.employee');
  const e = empRow(empOf(String(b!.contactId)));
  if (e.settled) fail(400, 'This person has left.', 'err.employeeLeft');
  if (openLoanM(e.id)) fail(400, 'This person still has a loan being repaid.', 'err.loanOpen');
  const date = dt(b?.date) ?? fail(400, 'Enter the date.', 'err.date');
  const amount = mny(b?.amount), inst = mny(b?.installment) || amount;
  if (amount <= 0n) fail(400, 'Enter the amount.', 'err.amount');
  if (inst > amount) fail(400, 'The monthly repayment cannot be more than the loan.', 'err.loanInstallment');
  const bank = db.accounts.find((x) => x.id === b?.bankAccountId && x.companyId === companyId && x.isBank) ?? fail(400, 'Choose the bank or cash account.', 'err.bankAccount');
  const number = nextNo(companyId, 'loan', 'LN-');
  const entryId = post(session!, companyId, date, `${number} · ${e.name}`, [{ accountId: acctBy(companyId, '1150').id, costCentreId: null, debit: amount, credit: 0n }, { accountId: bank.id, costCentreId: null, debit: 0n, credit: amount }]);
  const id = uid(); hdb.loans.push({ id, companyId, contactId: e.id, number, issueDate: date, amount, installment: inst, notes: str(b?.notes), entryId }); return id;
}
function saveAttendanceM(companyId: string, pe: string, rows: { contactId?: string; employeeNo?: string; absentDays?: unknown; overtimeHours?: unknown; notes?: unknown }[]) {
  canPostIn(companyId);
  if (!isMonthEnd(pe)) fail(400, 'Choose the month.', 'err.date');
  if (hrPostedBetween(companyId, pe, pe)) fail(400, 'Payroll for this month is posted, so its attendance no longer changes.', 'err.attPosted');
  const staff = empsOf(companyId); const unknown: string[] = [];
  for (const r of rows) {
    const e = staff.find((x) => (r.contactId && x.id === r.contactId) || (r.employeeNo && x.employeeNo === String(r.employeeNo).trim()));
    if (!e) { unknown.push(String(r.employeeNo ?? r.contactId ?? '?')); continue; }
    const absent = Number(String(r.absentDays ?? '0').trim() || 0);
    if (!Number.isInteger(absent) || absent < 0 || absent > 31) fail(400, 'Days absent are whole days.', 'err.absentDays', [e.name]);
    let ot: number; try { ot = Pay.hoursToHundredths(String(r.overtimeHours ?? '0')); } catch { return fail(400, 'Overtime hours have at most 2 decimals.', 'err.overtimeHours', [e.name]); }
    const row = { companyId, contactId: e.id, periodEnd: pe, absentDays: absent, overtimeHours: (ot / 100).toFixed(2), notes: str(r.notes) };
    const old = hdb.attendance.find((a) => a.contactId === e.id && a.periodEnd === pe);
    if (old) Object.assign(old, row); else hdb.attendance.push(row);
  }
  if (unknown.length) fail(400, 'Some employee numbers were not found.', 'err.attendanceUnknown', unknown);
  return { saved: rows.length };
}
const parseCsvM = (text: string) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')))
  .filter((c) => c.length >= 2 && /\d/.test(c[1] ?? '')).map(([employeeNo, absentDays, overtimeHours]) => ({ employeeNo, absentDays, overtimeHours: overtimeHours ?? '0' }));
const hrDocRow = (d: MHrDoc) => { const c = sdb.contacts.find((x) => x.id === d.contactId)!;
  return { ...d, name: c.name, nameAr: c.nameAr, daysLeft: d.expiryDate ? Math.round((Date.parse(d.expiryDate) - Date.parse(today())) / 86400000) : null, files: adb.files.filter((a) => a.hrDocId === d.id).length }; };
const hrDocsOf = (companyId: string, contactId?: string | null) => hdb.docs.filter((d) => d.companyId === companyId && (!contactId || d.contactId === contactId)).map(hrDocRow)
  .sort((a, b) => (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999') || a.name.localeCompare(b.name));
function saveHrDocM(companyId: string, b: Body, id?: string) {
  canPostIn(companyId);
  if (!b?.contactId) fail(400, 'Choose the employee.', 'err.employee');
  empOf(String(b!.contactId));
  if (!['national_id', 'iqama', 'emirates_id', 'passport', 'visa', 'work_permit', 'contract', 'medical_insurance', 'driving_licence', 'other'].includes(String(b?.kind))) fail(400, 'Choose the type of document.', 'err.docKind');
  const issue = dt(b?.issueDate), expiry = dt(b?.expiryDate);
  if (issue && expiry && expiry < issue) fail(400, 'The expiry date is before the issue date.', 'err.docDates');
  const v = { contactId: String(b!.contactId), kind: String(b!.kind), number: str(b?.number), issueDate: issue, expiryDate: expiry, notes: str(b?.notes) };
  if (id) { Object.assign(hdb.docs.find((d) => d.id === id && d.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); hdb.docs.push({ id: nid, companyId, ...v }); return nid;
}
const hrDocOf = (id: string) => hdb.docs.find((d) => d.id === id && roleOf(session, d.companyId)) ?? fail(404, 'Not found.', 'err.notFound');

routes.push(
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/overview$/, (m) => {
    const id = inCo(m[1]!);
    const emps = empsOf(id).filter((e) => e.status === 'active' && !e.settled), withD = emps.filter((e) => e.hasProfile);
    const runs = hdb.runs.filter((r) => r.companyId === id).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
    const t = today();
    return { headcount: emps.length, withoutDetails: emps.length - withD.length, nationals: withD.filter((e) => e.national).length, monthlyWages: s(withD.reduce((x, e) => x + toMinor(e.wage), 0n)),
      lastRun: runs[0] ? runRow(runs[0]) : null, expiring: hrDocsOf(id).filter((d) => d.daysLeft !== null && d.daysLeft <= 60).slice(0, 8),
      pendingLeave: hdb.leave.filter((l) => l.companyId === id && l.status === 'requested').length,
      onLeave: new Set(hdb.leave.filter((l) => l.companyId === id && l.status === 'approved' && l.startDate <= t && l.endDate >= t).map((l) => l.contactId)).size };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/employees$/, (m) => empsOf(inCo(m[1]!))],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/settings$/, (m) => hdb.settings.get(inCo(m[1]!)) ?? { employerId: null, bankRouting: null, insuranceNo: null }],
  ['POST', /^\/api\/companies\/([\w-]+)\/hr\/settings$/, (m, b) => { const id = inCo(m[1]!); canPostIn(id); hdb.settings.set(id, { employerId: str(b?.employerId), bankRouting: str(b?.bankRouting), insuranceNo: str(b?.insuranceNo) }); return { ok: true }; }],
  ['GET', /^\/api\/employees\/([\w-]+)\/hr$/, (m) => empRow(empOf(m[1]!))],
  ['POST', /^\/api\/employees\/([\w-]+)\/hr$/, (m, b) => { saveProfileM(m[1]!, b); return { ok: true }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/attendance$/, (m, _b, q) => {
    const id = inCo(m[1]!); const pe = q.get('month') ?? ''; if (!isMonthEnd(pe)) fail(400, 'Choose the month.', 'err.date');
    const from = mStart(pe);
    return { periodEnd: pe, posted: hrPostedBetween(id, pe, pe), rows: empsOf(id).filter((e) => inMonthM(e, pe)).map((e) => { const a = hdb.attendance.find((x) => x.contactId === e.id && x.periodEnd === pe);
      return { contactId: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, absentDays: a?.absentDays ?? 0, overtimeHours: a?.overtimeHours ?? '0.00', notes: a?.notes ?? '',
        annualLeave: leaveDaysInM(e.id, 'annual', from, pe), sickLeave: leaveDaysInM(e.id, 'sick', from, pe), unpaidLeave: leaveDaysInM(e.id, 'unpaid', from, pe), otherLeave: leaveDaysInM(e.id, 'other_paid', from, pe) }; }) };
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/hr\/attendance$/, (m, b) => saveAttendanceM(inCo(m[1]!), String(b?.month ?? ''), b?.csv ? parseCsvM(String(b.csv)) : (b?.rows as []) ?? [])],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/leave$/, (m, _b, q) => { const id = inCo(m[1]!); const st = q.get('status') ?? '';
    return hdb.leave.filter((l) => l.companyId === id && (!st || l.status === st)).sort((a, b) => b.startDate.localeCompare(a.startDate)).map((l) => { const c = sdb.contacts.find((x) => x.id === l.contactId)!;
      return { ...l, name: c.name, nameAr: c.nameAr, createdBy: userName(l.createdBy), decidedBy: userName(l.decidedBy) }; }); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/hr\/leave$/, (m, b) => ({ id: saveLeaveM(inCo(m[1]!), b) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/leave-balances$/, (m, _b, q) => { const asOf = q.get('asOf') || today();
    return empsOf(inCo(m[1]!)).filter((e) => e.hasProfile && !e.settled).map((e) => ({ contactId: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo,
      perYear: e.annualLeaveDays ?? Pay.annualLeaveDays(e.country, Pay.daysBetween(e.joinDate!, asOf)), ...leaveBalanceM(e, asOf) })); }],
  ['POST', /^\/api\/leave\/([\w-]+)\/status$/, (m, b) => { decideLeaveM(m[1]!, String(b?.status)); return { ok: true }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/loans$/, (m) => { const id = inCo(m[1]!);
    return hdb.loans.filter((l) => l.companyId === id).sort((a, b) => b.issueDate.localeCompare(a.issueDate)).map((l) => { const c = sdb.contacts.find((x) => x.id === l.contactId)!;
      return { id: l.id, number: l.number, contactId: l.contactId, name: c.name, nameAr: c.nameAr, issueDate: l.issueDate, amount: s(l.amount), installment: s(l.installment), balance: s(loanBalanceM(l)), notes: l.notes, entryId: l.entryId }; }); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/hr\/loans$/, (m, b) => ({ id: issueLoanM(inCo(m[1]!), b) })],
  ['GET', /^\/api\/companies\/([\w-]+)\/payroll$/, (m) => { const id = inCo(m[1]!); return hdb.runs.filter((r) => r.companyId === id).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).map(runRow); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/payroll$/, (m, b) => ({ id: prepareRunM(inCo(m[1]!), String(b?.month ?? '')) })],
  ['GET', /^\/api\/payroll\/([\w-]+)$/, (m) => runDetail(runOf(m[1]!))],
  ['POST', /^\/api\/payroll\/([\w-]+)\/refresh$/, (m) => { const r = runOf(m[1]!); return { id: prepareRunM(r.companyId, r.periodEnd) }; }],
  ['POST', /^\/api\/payroll\/([\w-]+)\/post$/, (m) => { postRunM(m[1]!); return { entryId: runOf(m[1]!).entryId }; }],
  ['POST', /^\/api\/payroll\/([\w-]+)\/pay$/, (m, b) => { payRunM(m[1]!, b); return { entryId: runOf(m[1]!).paymentEntryId }; }],
  ['POST', /^\/api\/payroll\/([\w-]+)\/delete$/, (m) => { const r = runOf(m[1]!); canPostIn(r.companyId); if (r.status !== 'draft') fail(400, 'Only a draft payroll can be removed.', 'err.payrollPosted');
    hdb.runs = hdb.runs.filter((x) => x.id !== r.id); return { ok: true }; }],
  ['GET', /^\/api\/payroll\/([\w-]+)\/salary-file$/, (m) => salaryFileM(m[1]!)],
  ['POST', /^\/api\/payroll-lines\/([\w-]+)$/, (m, b) => {
    const r = hdb.runs.find((x) => x.lines.some((l) => l.id === m[1]) && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
    canPostIn(r.companyId);
    if (r.status !== 'draft') fail(400, 'Posted payroll never changes.', 'err.payrollPosted');
    const i = r.lines.findIndex((l) => l.id === m[1]);
    r.lines[i] = computeLineM(empRow(sdb.contacts.find((c) => c.id === r.lines[i]!.contactId)!), r.periodEnd, { bonus: mny(b?.bonus), otherDeductions: mny(b?.otherDeductions), note: str(b?.note) });
    return { ok: true };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/end-of-service$/, (m, _b, q) => {
    const id = inCo(m[1]!); const asOf = q.get('asOf') || today();
    const rows = empsOf(id).filter((e) => e.hasProfile && !e.settled && e.joinDate! <= asOf).map((e) => { const pay = payOfM(e);
      const full = Pay.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'termination' });
      return { contactId: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, joinDate: e.joinDate, serviceDays: full.serviceDays, basis: s(full.basis), full: s(full.amount),
        onResignation: s(Pay.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'resignation' }).amount),
        accrued: s(Pay.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'termination' }, true).amount), provision: s(provisionM(e)) }; });
    const acc = acctBy(id, '2230').id;
    const books = db.entries.filter((x) => x.companyId === id).flatMap((x) => x.lines).filter((l) => l.accountId === acc).reduce((t, l) => t + l.credit - l.debit, 0n);
    return { asOf, rows, books: s(books), settlements: hdb.settlements.filter((x) => x.companyId === id).map((x) => { const c = sdb.contacts.find((k) => k.id === x.contactId)!;
      return { id: x.id, contactId: x.contactId, name: c.name, nameAr: c.nameAr, leavingDate: x.leavingDate, reason: x.reason, serviceDays: x.serviceDays, eosAmount: s(x.eosAmount), leaveDays: x.leaveDays,
        leavePay: s(x.leavePay), loanRecovered: s(x.loanRecovered), totalDue: s(x.totalDue), entryId: x.entryId }; }) };
  }],
  ['POST', /^\/api\/employees\/([\w-]+)\/settlement-preview$/, (m, b) => settlementPreviewM(m[1]!, b)],
  ['POST', /^\/api\/employees\/([\w-]+)\/settlement$/, (m, b) => { settleM(m[1]!, b); return { id: m[1] }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/hr\/documents$/, (m, _b, q) => hrDocsOf(inCo(m[1]!), q.get('employee'))],
  ['POST', /^\/api\/companies\/([\w-]+)\/hr\/documents$/, (m, b) => ({ id: saveHrDocM(inCo(m[1]!), b) })],
  ['POST', /^\/api\/hr-documents\/([\w-]+)\/delete$/, (m) => { const d = hrDocOf(m[1]!); canPostIn(d.companyId); hdb.docs = hdb.docs.filter((x) => x.id !== d.id); adb.files = adb.files.filter((a) => a.hrDocId !== d.id); return { ok: true }; }],
  ['POST', /^\/api\/hr-documents\/([\w-]+)$/, (m, b) => { const d = hrDocOf(m[1]!); return { id: saveHrDocM(d.companyId, b, d.id) }; }],
  ['GET', /^\/api\/hr-documents\/([\w-]+)\/attachments$/, (m) => { hrDocOf(m[1]!); return attachmentRows((a) => a.hrDocId === m[1]); }],
  ['POST', /^\/api\/hr-documents\/([\w-]+)\/attachments$/, (m, b) => ({ id: addAttachmentM({ hrDocId: m[1]! }, b ?? {}) })],
);

/** Sample HR data, as in src/db/seed.ts. */
function seedHrm(companyId: string, poster: string) {
  const prev = session; session = poster;
  const co = db.companies.find((c) => c.id === companyId)!; const sa = co.country === 'SA';
  const byNo = (no: string) => sdb.contacts.find((c) => c.companyId === companyId && c.employeeNo === no)!.id;
  const yusuf = byNo('E-001'), mona = byNo('E-002');
  const booksStart = daysAgo(120); const openAt = new Date(Date.UTC(+booksStart.slice(0, 4), +booksStart.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
  const people = [
    { id: yusuf, nationality: sa ? 'EG' : 'IN', joined: daysAgo(900), basic: '3000.00', housing: '750.00', transport: '300.00', iban: sa ? 'SA4420000001234567891234' : 'AE460260001015333439101', wps: '10000123456781' },
    { id: mona, nationality: co.country, joined: daysAgo(2400), basic: '9000.00', housing: '2250.00', transport: '600.00', iban: sa ? 'SA0380000000608010167519' : 'AE070331234567890123456', wps: '10000123456782' },
  ];
  let opening = 0n;
  for (const p of people) {
    const eos = Pay.endOfService({ country: co.country as Pay.Country, joinDate: p.joined, endDate: openAt, pay: { basic: toMinor(p.basic), housing: toMinor(p.housing), transport: toMinor(p.transport), other: 0n }, reason: 'termination' }, true).amount;
    opening += eos;
    saveProfileM(p.id, { nationality: p.nationality, joinDate: p.joined, basic: p.basic, housing: p.housing, transport: p.transport, iban: p.iban,
      idNumber: sa ? (p.nationality === 'SA' ? '1087654321' : '2398765432') : '784199012345678', passportNo: p.nationality === co.country ? null : 'A1234567',
      insuranceRegistered: p.nationality === 'SA' ? daysAgo(2400) : null, bankRouting: sa ? null : '600310101', wpsPersonId: sa ? null : p.wps,
      openingEos: s(eos), openingLeaveDays: p.id === mona ? '12.50' : '4.00', openingAsOf: openAt });
  }
  post(poster, companyId, booksStart, 'Opening balances · end of service provision', [{ accountId: acctBy(companyId, '3000').id, costCentreId: null, debit: opening, credit: 0n },
    { accountId: acctBy(companyId, '2230').id, costCentreId: null, debit: 0n, credit: opening }]);
  hdb.settings.set(companyId, sa ? { employerId: '7001234567', bankRouting: null, insuranceNo: '500123456' } : { employerId: '0000001234567', bankRouting: '600310101', insuranceNo: 'GP-55120' });
  const lastEnd = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
  const months = [lastEnd(lastEnd(today())), lastEnd(today())];
  saveLeaveM(companyId, { contactId: mona, kind: 'annual', startDate: `${months[1]!.slice(0, 8)}10`, endDate: `${months[1]!.slice(0, 8)}14`, reason: 'Family visit', approve: true });
  saveLeaveM(companyId, { contactId: yusuf, kind: 'sick', startDate: `${months[0]!.slice(0, 8)}06`, endDate: `${months[0]!.slice(0, 8)}07`, approve: true });
  saveLeaveM(companyId, { contactId: yusuf, kind: 'annual', startDate: daysAgo(-10), endDate: daysAgo(-17), reason: 'Eid holiday travel' });
  issueLoanM(companyId, { contactId: yusuf, date: `${months[0]!.slice(0, 8)}03`, amount: '2000.00', installment: '500.00', bankAccountId: acctBy(companyId, '1000').id, notes: 'Salary advance' });
  saveAttendanceM(companyId, months[1]!, [{ contactId: yusuf, absentDays: 1, overtimeHours: '12' }, { contactId: mona, absentDays: 0, overtimeHours: '0' }]);
  for (const [n, m] of months.entries()) {
    const id = prepareRunM(companyId, m); postRunM(id);
    if (n === 0) payRunM(id, { bankAccountId: acctBy(companyId, '1000').id, date: addD(m, 1) });
  }
  for (const [who, kind, number, expiry] of [[yusuf, sa ? 'iqama' : 'emirates_id', sa ? '2398765432' : '784-1990-1234567-1', daysAgo(-25)], [yusuf, 'passport', 'A1234567', daysAgo(-900)],
    [yusuf, 'medical_insurance', 'MED-44821', daysAgo(-50)], [mona, sa ? 'national_id' : 'emirates_id', sa ? '1087654321' : '784-1985-7654321-2', daysAgo(-1400)], [mona, 'contract', 'C-2019-07', '']] as const) {
    saveHrDocM(companyId, { contactId: who, kind, number, expiryDate: expiry || undefined });
  }
  session = prev;
}

// ---------------------------------------------------------------- CRM (same rules as src/books/crmService.ts and db/migrations/0020)
interface MCampaign { id: string; companyId: string; name: string; channel: string; startDate: string | null; endDate: string | null; budget: bigint; status: string; audience: string | null; notes: string | null; createdAt: string }
interface MLead { id: string; companyId: string; name: string; nameAr: string | null; contactPerson: string | null; phone: string | null; email: string | null; source: string; campaignId: string | null;
  ownerId: string | null; status: string; estimatedValue: bigint; notes: string | null; lostReason: string | null; contactId: string | null; createdAt: string }
interface MDeal { id: string; companyId: string; title: string; contactId: string | null; leadId: string | null; stage: string; value: bigint; expectedClose: string | null; ownerId: string | null;
  quotationId: string | null; lostReason: string | null; closedAt: string | null; notes: string | null; createdAt: string }
interface MActivity { id: string; companyId: string; kind: string; subject: string; notes: string | null; dueDate: string | null; dueTime: string | null; doneAt: string | null;
  leadId: string | null; dealId: string | null; contactId: string | null; ownerId: string | null; createdAt: string }
const cdb = { campaigns: [] as MCampaign[], leads: [] as MLead[], deals: [] as MDeal[], activities: [] as MActivity[] };
const C_STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const C_OPEN = ['new', 'qualified', 'proposal', 'negotiation'];
const CHANCE: Record<string, number> = { new: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
const cstr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cdt = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const cpick = (v: unknown, list: string[], f: string) => (list.includes(String(v)) ? String(v) : f);
const peopleOf = (companyId: string) => db.memberships.filter((m) => m.companyId === companyId).map((m) => db.users.find((u) => u.id === m.userId)!).filter((u) => u.status === 'active')
  .map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
function crmLinks(companyId: string, x: { ownerId?: string | null; contactId?: string | null; campaignId?: string | null; leadId?: string | null; dealId?: string | null }, customerOnly = true) {
  const okC = (id: string) => sdb.contacts.some((c) => c.id === id && c.companyId === companyId && (!customerOnly || c.isCustomer));
  if ((x.ownerId && !db.memberships.some((m) => m.companyId === companyId && m.userId === x.ownerId)) || (x.contactId && !okC(x.contactId))
    || (x.campaignId && !cdb.campaigns.some((c) => c.id === x.campaignId && c.companyId === companyId)) || (x.leadId && !cdb.leads.some((l) => l.id === x.leadId && l.companyId === companyId))
    || (x.dealId && !cdb.deals.some((d) => d.id === x.dealId && d.companyId === companyId))) fail(400, 'That belongs to a different company.', 'err.otherCompany');
}
const campaignRow = (c: MCampaign) => {
  const leads = cdb.leads.filter((l) => l.campaignId === c.id);
  const won = cdb.deals.filter((d) => d.stage === 'won' && leads.some((l) => l.id === d.leadId));
  return { id: c.id, name: c.name, channel: c.channel, startDate: c.startDate, endDate: c.endDate, budget: s(c.budget), status: c.status, audience: c.audience, notes: c.notes,
    leads: leads.length, converted: leads.filter((l) => l.status === 'converted').length, won: won.length, wonValue: s(won.reduce((t, d) => t + d.value, 0n)),
    costPerLead: leads.length ? s(c.budget / BigInt(leads.length)) : null };
};
function saveCampaignM(companyId: string, b: Body, id?: string) {
  canPostIn(companyId);
  const name = cstr(b?.name) ?? fail(400, 'Enter the campaign name.', 'err.campaignName');
  const start = cdt(b?.startDate), end = cdt(b?.endDate);
  if (start && end && end < start) fail(400, 'The end date is before the start date.', 'err.campaignDates');
  const v = { name, channel: cpick(b?.channel, ['email', 'sms', 'whatsapp', 'social', 'event', 'print', 'other'], 'other'), startDate: start, endDate: end, budget: mny(b?.budget),
    status: cpick(b?.status, ['planned', 'running', 'done'], 'planned'), audience: cstr(b?.audience), notes: cstr(b?.notes) };
  if (id) { Object.assign(cdb.campaigns.find((c) => c.id === id && c.companyId === companyId) ?? fail(404, 'Not found.', 'err.notFound'), v); return id; }
  const nid = uid(); cdb.campaigns.push({ id: nid, companyId, ...v, createdAt: new Date().toISOString() }); return nid;
}
const nextAct = (f: (a: MActivity) => boolean) => cdb.activities.filter((a) => !a.doneAt && a.dueDate && f(a)).map((a) => a.dueDate!).sort()[0] ?? null;
const leadRow = (l: MLead) => ({ id: l.id, companyId: l.companyId, name: l.name, nameAr: l.nameAr, contactPerson: l.contactPerson, phone: l.phone, email: l.email, source: l.source, campaignId: l.campaignId,
  campaignName: cdb.campaigns.find((c) => c.id === l.campaignId)?.name ?? null, ownerId: l.ownerId, ownerName: userName(l.ownerId), status: l.status, estimatedValue: s(l.estimatedValue),
  notes: l.notes, lostReason: l.lostReason, contactId: l.contactId, createdAt: l.createdAt, nextActivity: nextAct((a) => a.leadId === l.id) });
const leadOf = (id: string) => cdb.leads.find((l) => l.id === id && roleOf(session, l.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveLeadM(companyId: string, b: Body, id?: string) {
  canPostIn(companyId);
  const name = cstr(b?.name) ?? fail(400, 'Enter the name of the possible customer.', 'err.leadName');
  const email = cstr(b?.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Check the email address.', 'err.email');
  if (!cstr(b?.phone) && !email) fail(400, 'Enter a phone number or an email.', 'err.leadReach');
  const status = cpick(b?.status, ['new', 'contacted', 'qualified', 'lost'], 'new');
  if (status === 'lost' && !cstr(b?.lostReason)) fail(400, 'Say why it was lost.', 'err.lostReason');
  const campaignId = cstr(b?.campaignId), ownerId = cstr(b?.ownerId);
  crmLinks(companyId, { campaignId, ownerId });
  const v = { name, nameAr: cstr(b?.nameAr), contactPerson: cstr(b?.contactPerson), phone: cstr(b?.phone), email, source: campaignId ? 'campaign' : cpick(b?.source, ['referral', 'website', 'walk_in', 'phone', 'social', 'exhibition', 'campaign', 'other'], 'other'),
    campaignId, ownerId, estimatedValue: mny(b?.estimatedValue), notes: cstr(b?.notes), lostReason: status === 'lost' ? cstr(b?.lostReason) : null, status };
  if (id) { const l = leadOf(id); if (l.status === 'converted') fail(400, 'This lead is already a customer.', 'err.leadConverted'); Object.assign(l, v); return id; }
  const nid = uid(); cdb.leads.push({ id: nid, companyId, ...v, contactId: null, createdAt: new Date().toISOString() }); return nid;
}
function convertLeadM(id: string, b: Body) {
  const l = leadOf(id); canPostIn(l.companyId);
  if (l.status === 'converted') fail(400, 'This lead is already a customer.', 'err.leadConverted');
  if (l.status === 'lost') fail(400, 'This lead was lost.', 'err.leadLost');
  const contactId = cstr(b?.contactId) ?? saveContactM(l.companyId, { isCustomer: true, name: l.name, nameAr: l.nameAr ?? undefined, email: l.email ?? undefined, phone: l.phone ?? undefined });
  l.status = 'converted'; l.contactId = contactId; l.lostReason = null;
  for (const d of cdb.deals) if (d.leadId === id && !d.contactId) d.contactId = contactId;
  const dealId = cstr(b?.dealTitle) ? saveDealM(l.companyId, { title: b!.dealTitle, contactId, leadId: id, value: b?.dealValue ?? s(l.estimatedValue), ownerId: l.ownerId, stage: 'qualified' }) : null;
  return { contactId, dealId };
}
const dealRow = (d: MDeal) => { const c = sdb.contacts.find((x) => x.id === d.contactId); const q = sdb.docs.find((x) => x.id === d.quotationId);
  return { id: d.id, companyId: d.companyId, title: d.title, contactId: d.contactId, customerName: c?.name ?? null, customerNameAr: c?.nameAr ?? null, leadId: d.leadId,
    leadName: cdb.leads.find((l) => l.id === d.leadId)?.name ?? null, stage: d.stage, value: s(d.value), expectedClose: d.expectedClose, ownerId: d.ownerId, ownerName: userName(d.ownerId),
    quotationId: d.quotationId, quotationNumber: q?.number ?? null, quotationStatus: q?.status ?? null, lostReason: d.lostReason, closedAt: d.closedAt, notes: d.notes, createdAt: d.createdAt,
    nextActivity: nextAct((a) => a.dealId === d.id) }; };
const dealOf = (id: string) => cdb.deals.find((d) => d.id === id && roleOf(session, d.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveDealM(companyId: string, b: Body, id?: string) {
  canPostIn(companyId);
  const title = cstr(b?.title) ?? fail(400, 'Enter what the deal is for.', 'err.dealTitle');
  const contactId = cstr(b?.contactId), leadId = cstr(b?.leadId), ownerId = cstr(b?.ownerId);
  if (!contactId && !leadId) fail(400, 'Choose the customer or the lead.', 'err.dealWho');
  const stage = cpick(b?.stage, C_STAGES, 'new');
  if (stage === 'lost' && !cstr(b?.lostReason)) fail(400, 'Say why the deal was lost.', 'err.lostReason');
  crmLinks(companyId, { contactId, leadId, ownerId });
  const old = id ? dealOf(id) : null;
  const closing = stage === 'won' || stage === 'lost';
  const v = { title, contactId, leadId, stage, value: mny(b?.value), expectedClose: cdt(b?.expectedClose), ownerId, lostReason: stage === 'lost' ? cstr(b?.lostReason) : null,
    closedAt: closing ? (old?.closedAt && old.stage === stage ? old.closedAt : today()) : null, notes: cstr(b?.notes) };
  if (old) { Object.assign(old, v); return old.id; }
  const nid = uid(); cdb.deals.push({ id: nid, companyId, ...v, quotationId: null, createdAt: new Date().toISOString() }); return nid;
}
function quoteDealM(id: string) {
  const d = dealOf(id); canPostIn(d.companyId);
  if (!d.contactId) fail(400, 'Make the lead a customer first.', 'err.dealNeedsCustomer');
  if (d.quotationId) fail(400, 'This deal already has a quotation.', 'err.dealHasQuotation');
  if (d.stage === 'won' || d.stage === 'lost') fail(400, 'This deal is closed.', 'err.dealClosed');
  const co = db.companies.find((c) => c.id === d.companyId)!;
  const qid = saveDraftM(d.companyId, { type: 'quotation', contactId: d.contactId, issueDate: today(), reference: d.title,
    lines: [{ description: d.title, quantity: '1', unitPrice: s(d.value), accountId: acctBy(d.companyId, '4000').id, vatCode: co.vatStatus === 'registered' ? 'standard' : 'out_of_scope' }] });
  d.quotationId = qid; if (d.stage === 'new' || d.stage === 'qualified') d.stage = 'proposal';
  return qid;
}
/** A deal follows its quotation (db/migrations/0020: after_quotation_status). */
function crmQuoteSync(quotationId: string, status: string) {
  for (const d of cdb.deals.filter((x) => x.quotationId === quotationId && x.stage !== 'won' && x.stage !== 'lost')) {
    if (status === 'invoiced') { d.stage = 'won'; d.closedAt = today(); d.lostReason = null; }
    else if (status === 'declined') { d.stage = 'lost'; d.closedAt = today(); d.lostReason = 'Quotation declined'; }
    else if ((status === 'sent' || status === 'accepted') && ['new', 'qualified', 'proposal'].includes(d.stage)) d.stage = status === 'accepted' ? 'negotiation' : 'proposal';
  }
}
const actRow = (a: MActivity) => { const c = sdb.contacts.find((x) => x.id === a.contactId);
  return { ...a, leadName: cdb.leads.find((l) => l.id === a.leadId)?.name ?? null, dealTitle: cdb.deals.find((d) => d.id === a.dealId)?.title ?? null, contactName: c?.name ?? null,
    contactNameAr: c?.nameAr ?? null, ownerName: userName(a.ownerId) }; };
const actOf = (id: string) => cdb.activities.find((a) => a.id === id && roleOf(session, a.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function saveActivityM(companyId: string, b: Body, id?: string) {
  canPostIn(companyId);
  const subject = cstr(b?.subject) ?? fail(400, 'Enter what the activity is about.', 'err.activitySubject');
  const time = cstr(b?.dueTime);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(400, 'Enter the time as hours and minutes.', 'err.activityTime');
  const leadId = cstr(b?.leadId), dealId = cstr(b?.dealId), contactId = cstr(b?.contactId), ownerId = cstr(b?.ownerId);
  if ([leadId, dealId, contactId].filter(Boolean).length > 1) fail(400, 'Link the activity to one lead, deal or customer.', 'err.activityLink');
  crmLinks(companyId, { leadId, dealId, contactId, ownerId }, false);
  const v = { kind: cpick(b?.kind, ['call', 'meeting', 'task', 'email', 'note'], 'task'), subject, notes: cstr(b?.notes), dueDate: cdt(b?.dueDate), dueTime: time, leadId, dealId, contactId, ownerId };
  if (id) { Object.assign(actOf(id), v); return id; }
  const nid = uid(); cdb.activities.push({ id: nid, companyId, ...v, doneAt: null, createdAt: new Date().toISOString() }); return nid;
}

routes.push(
  ['GET', /^\/api\/companies\/([\w-]+)\/crm\/people$/, (m) => peopleOf(inCo(m[1]!))],
  ['GET', /^\/api\/companies\/([\w-]+)\/crm\/campaigns$/, (m) => { const id = inCo(m[1]!);
    return cdb.campaigns.filter((c) => c.companyId === id).sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (b.startDate ?? b.createdAt).localeCompare(a.startDate ?? a.createdAt)).map(campaignRow); }],
  ['POST', /^\/api\/companies\/([\w-]+)\/crm\/campaigns$/, (m, b) => ({ id: saveCampaignM(inCo(m[1]!), b) })],
  ['POST', /^\/api\/crm\/campaigns\/([\w-]+)$/, (m, b) => { const c = cdb.campaigns.find((x) => x.id === m[1] && roleOf(session, x.companyId)) ?? fail(404, 'Not found.', 'err.notFound'); return { id: saveCampaignM(c.companyId, b, c.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/crm\/leads$/, (m, _b, q) => {
    const id = inCo(m[1]!); const st = q.get('status') ?? ''; const n = (q.get('q') ?? '').trim().toLowerCase(); const owner = q.get('owner');
    return cdb.leads.filter((l) => l.companyId === id && (!st || (st === 'open' ? ['new', 'contacted', 'qualified'].includes(l.status) : l.status === st))
      && (!n || [l.name, l.contactPerson ?? '', l.phone ?? ''].join(' ').toLowerCase().includes(n)) && (!owner || l.ownerId === owner))
      .sort((a, b) => Number(['converted', 'lost'].includes(a.status)) - Number(['converted', 'lost'].includes(b.status)) || b.createdAt.localeCompare(a.createdAt)).map(leadRow);
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/crm\/leads$/, (m, b) => ({ id: saveLeadM(inCo(m[1]!), b) })],
  ['GET', /^\/api\/crm\/leads\/([\w-]+)$/, (m) => leadRow(leadOf(m[1]!))],
  ['POST', /^\/api\/crm\/leads\/([\w-]+)\/convert$/, (m, b) => convertLeadM(m[1]!, b)],
  ['POST', /^\/api\/crm\/leads\/([\w-]+)$/, (m, b) => { const l = leadOf(m[1]!); return { id: saveLeadM(l.companyId, b, l.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/crm\/pipeline$/, (m, _b, q) => {
    const id = inCo(m[1]!); const owner = q.get('owner'); const from = q.get('from') || `${today().slice(0, 4)}-01-01`, to = q.get('to') || today();
    const rows = cdb.deals.filter((d) => d.companyId === id && (!owner || d.ownerId === owner) && (C_OPEN.includes(d.stage) || (d.closedAt! >= from && d.closedAt! <= to)))
      .sort((a, b) => (a.expectedClose ?? '9999').localeCompare(b.expectedClose ?? '9999') || a.createdAt.localeCompare(b.createdAt)).map(dealRow);
    const stages = C_STAGES.map((st) => { const deals = rows.filter((r) => r.stage === st); const total = deals.reduce((t, r) => t + toMinor(r.value), 0n);
      return { stage: st, chance: CHANCE[st]!, deals, count: deals.length, total: s(total), weighted: s((total * BigInt(CHANCE[st]!) + 50n) / 100n) }; });
    const open = stages.filter((x) => C_OPEN.includes(x.stage));
    const won = stages.find((x) => x.stage === 'won')!, lost = stages.find((x) => x.stage === 'lost')!;
    return { from, to, stages, openTotal: s(open.reduce((t, x) => t + toMinor(x.total), 0n)), weighted: s(open.reduce((t, x) => t + toMinor(x.weighted), 0n)), wonTotal: won.total,
      wonCount: won.count, lostCount: lost.count, winRate: won.count + lost.count ? Math.round((won.count * 100) / (won.count + lost.count)) : null };
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/crm\/deals$/, (m, b) => ({ id: saveDealM(inCo(m[1]!), b) })],
  ['GET', /^\/api\/crm\/deals\/([\w-]+)$/, (m) => dealRow(dealOf(m[1]!))],
  ['POST', /^\/api\/crm\/deals\/([\w-]+)\/stage$/, (m, b) => { const d = dealOf(m[1]!); saveDealM(d.companyId, { ...dealRow(d), stage: b?.stage, lostReason: b?.lostReason ?? d.lostReason }, d.id); return { ok: true }; }],
  ['POST', /^\/api\/crm\/deals\/([\w-]+)\/quotation$/, (m) => ({ id: quoteDealM(m[1]!) })],
  ['POST', /^\/api\/crm\/deals\/([\w-]+)$/, (m, b) => { const d = dealOf(m[1]!); return { id: saveDealM(d.companyId, b, d.id) }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/crm\/activities$/, (m, _b, q) => {
    const id = inCo(m[1]!); const show = q.get('show') ?? 'open'; const t = today();
    const f = (k: string, v: string | null) => !q.get(k) || v === q.get(k);
    return cdb.activities.filter((a) => a.companyId === id && (show === 'all' || (show === 'open' && !a.doneAt) || (show === 'overdue' && !a.doneAt && !!a.dueDate && a.dueDate < t) || (show === 'done' && !!a.doneAt))
      && f('owner', a.ownerId) && f('lead', a.leadId) && f('deal', a.dealId) && f('contact', a.contactId))
      .sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? '99').localeCompare(b.dueTime ?? '99'))
      .map(actRow);
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/crm\/activities$/, (m, b) => ({ id: saveActivityM(inCo(m[1]!), b) })],
  ['POST', /^\/api\/crm\/activities\/([\w-]+)\/done$/, (m, b) => { const a = actOf(m[1]!); canPostIn(a.companyId); a.doneAt = b?.done === false ? null : new Date().toISOString(); return { ok: true }; }],
  ['POST', /^\/api\/crm\/activities\/([\w-]+)\/delete$/, (m) => { const a = actOf(m[1]!); canPostIn(a.companyId); cdb.activities = cdb.activities.filter((x) => x.id !== a.id); return { ok: true }; }],
  ['POST', /^\/api\/crm\/activities\/([\w-]+)$/, (m, b) => { const a = actOf(m[1]!); return { id: saveActivityM(a.companyId, b, a.id) }; }],
);

/** Sample CRM data, as in src/db/seed.ts. */
function seedCrm(companyId: string, poster: string) {
  const prev = session; session = poster;
  const sa = db.companies.find((c) => c.id === companyId)!.country === 'SA';
  const cust = (name: string) => sdb.contacts.find((c) => c.companyId === companyId && c.name === name)!.id;
  const gulf = cust('Gulf Steel Trading'), faisal = cust('Al Faisal Contracting'), walkIn = cust('Walk-in customer');
  const camp = saveCampaignM(companyId, { name: sa ? 'Ramadan offer' : 'Dubai expo stand', channel: sa ? 'whatsapp' : 'event', startDate: daysAgo(40), endDate: daysAgo(10), budget: '3000.00', status: 'done',
    audience: sa ? 'Contractors in Riyadh' : 'Hotels and restaurants' });
  saveCampaignM(companyId, { name: 'Year-end newsletter', channel: 'email', startDate: daysAgo(-20), budget: '500.00', status: 'planned' });
  const lead1 = saveLeadM(companyId, { name: 'Najran Builders', nameAr: 'بناة نجران', contactPerson: 'Saeed', phone: '+966 55 123 4567', campaignId: camp, estimatedValue: '18000.00', ownerId: poster, status: 'qualified' });
  saveLeadM(companyId, { name: 'Coastal Hotels', contactPerson: 'Reem', email: 'purchasing@coastal.example', campaignId: camp, estimatedValue: '9000.00', ownerId: poster, status: 'contacted' });
  saveLeadM(companyId, { name: 'Prime Clinics', phone: '+966 50 765 4321', source: 'referral', estimatedValue: '6000.00', status: 'new' });
  saveLeadM(companyId, { name: 'Desert Cafe', phone: '+966 54 000 1122', source: 'walk_in', status: 'lost', lostReason: 'Chose a cheaper supplier', campaignId: camp });
  const conv = convertLeadM(lead1, { dealTitle: 'Steel frames for villa project', dealValue: '18000.00' });
  const q1 = quoteDealM(conv.dealId!); quoteStatusM(q1, 'sent');
  const d2 = saveDealM(companyId, { title: 'Annual supply contract', contactId: gulf, value: '42000.00', stage: 'negotiation', expectedClose: daysAgo(-14), ownerId: poster });
  saveDealM(companyId, { title: 'Warehouse racks phase 2', contactId: faisal, value: '12500.00', stage: 'qualified', expectedClose: daysAgo(-30) });
  saveDealM(companyId, { title: 'Spare parts order', contactId: gulf, value: '3200.00', stage: 'new' });
  saveDealM(companyId, { title: 'Delivery and installation', contactId: faisal, value: '7800.00', stage: 'won' });
  saveDealM(companyId, { title: 'Site cleaning', contactId: walkIn, value: '1500.00', stage: 'lost', lostReason: 'Customer postponed' });
  saveActivityM(companyId, { kind: 'call', subject: 'Call about the quotation', dueDate: daysAgo(2), dealId: conv.dealId, ownerId: poster });
  saveActivityM(companyId, { kind: 'meeting', subject: 'Contract terms meeting', dueDate: daysAgo(0), dueTime: '11:00', dealId: d2, ownerId: poster });
  saveActivityM(companyId, { kind: 'email', subject: 'Send product catalogue', dueDate: daysAgo(-3), contactId: gulf });
  saveActivityM(companyId, { kind: 'task', subject: 'Prepare samples', dueDate: daysAgo(-7), ownerId: poster });
  const done = saveActivityM(companyId, { kind: 'call', subject: 'First call with Najran Builders', dueDate: daysAgo(12), leadId: lead1 });
  actOf(done).doneAt = new Date().toISOString();
  session = prev;
}

// ---------------------------------------------------------------- Review (same rules as src/books/reviewService.ts and db/migrations/0021)
interface MQuery { id: string; companyId: string; periodEnd: string; subject: string; aboutType: string | null; aboutId: string | null; aboutLabel: string | null; status: string;
  raisedBy: string; raisedAt: string; closedBy: string | null; closedAt: string | null }
interface MMessage { id: string; companyId: string; queryId: string; author: string; body: string; createdAt: string }
interface MSignoff { id: string; companyId: string; periodEnd: string; note: string | null; signedBy: string; signedAt: string; withdrawnBy: string | null; withdrawnAt: string | null; withdrawReason: string | null }
const rvdb = { queries: [] as MQuery[], messages: [] as MMessage[], ticks: [] as { companyId: string; periodEnd: string; item: string; done: boolean; note: string | null; by: string; at: string }[],
  explained: [] as { companyId: string; check: string; item: string; note: string; by: string; at: string }[], signoffs: [] as MSignoff[] };
const RV_FIRM: Role[] = ['partner', 'reviewer', 'staff_accountant'];
const RV_SIGN: Role[] = ['partner', 'reviewer'];
const rvRole = (companyId: string) => roleOf(session, companyId);
const rvFirmOnly = (companyId: string) => { if (!RV_FIRM.includes(rvRole(companyId)!)) fail(403, 'Your role does not allow this.', 'err.forbidden'); };
const rvMonth = (v: unknown) => { const p = String(v ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(p) || monthEnd(p) !== p) fail(400, 'Choose the month.', 'err.date'); return p; };
const prevEnd = (pe: string) => new Date(Date.UTC(+pe.slice(0, 4), +pe.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
const grossOf = (d: MDoc) => d.lines.reduce((t, l) => t + l.net + l.vat, 0n);
const vatOf = (d: MDoc) => d.lines.reduce((t, l) => t + l.vat, 0n);
const linkDoc = (d: MDoc) => ({ type: 'document', id: d.id, docType: d.type });
const nameOfDoc = (d: MDoc) => sdb.contacts.find((c) => c.id === d.contactId)?.name ?? d.payee ?? '';

function runChecksM(companyId: string, pe: string) {
  const co = db.companies.find((c) => c.id === companyId)!;
  const from = `${pe.slice(0, 7)}-01`;
  const inMonth = (d: string) => d >= from && d <= pe;
  const reg = co.vatStatus === 'registered';
  const docs = sdb.docs.filter((d) => d.companyId === companyId);
  const issued = (types: string[]) => docs.filter((d) => types.includes(d.type) && d.status === 'issued' && inMonth(d.issueDate)).sort((a, b) => a.issueDate.localeCompare(b.issueDate));
  const vatNo = (d: MDoc) => sdb.contacts.find((c) => c.id === d.contactId)?.vatNumber ?? null;
  type F = { itemKey: string; date: string | null; label: string; detail: string | null; amount: string | null; link: Record<string, string> | null };
  const f = (d: MDoc, detail: string | null = null, amount = grossOf(d)): F => ({ itemKey: d.id, date: d.issueDate, label: `${d.number ?? ''} · ${nameOfDoc(d)}`, detail, amount: s(amount), link: linkDoc(d) });
  const dupes: F[] = [];
  const all = docs.filter((d) => ['bill', 'expense', 'invoice'].includes(d.type) && d.status === 'issued');
  for (const a of all) for (const b of all) {
    if (b.id <= a.id || b.type !== a.type || b.contactId !== a.contactId || (b.payee ?? '') !== (a.payee ?? '')) continue;
    const near = grossOf(a) === grossOf(b) && Math.abs(Date.parse(a.issueDate) - Date.parse(b.issueDate)) <= 7 * 86400000;
    const sameRef = !!a.reference && a.reference === b.reference;
    if ((near || sameRef) && (inMonth(a.issueDate) || inMonth(b.issueDate)))
      dupes.push({ itemKey: `${a.id}|${b.id}`, date: a.issueDate, label: `${a.number ?? ''} / ${b.number ?? ''} · ${nameOfDoc(a)}`, detail: sameRef ? a.reference : null, amount: s(grossOf(a)), link: linkDoc(a) });
  }
  const referenced = new Set([...sdb.docs.map((d) => d.journalEntryId), ...sdb.payments.map((p) => p.journalEntryId)]);
  const round = db.entries.filter((e) => e.companyId === companyId && inMonth(e.date) && (e as Entry & { manual?: boolean }).manual && !e.reversesEntryId && !referenced.has(e.id)
    && !db.entries.some((r) => r.reversesEntryId === e.id) && e.lines.some((l) => { const v = l.debit > l.credit ? l.debit : l.credit; return v >= 100000n && v % 100000n === 0n; }))
    .map((e) => ({ itemKey: e.id, date: e.date, label: e.memo ?? '', detail: null, amount: s(e.lines.reduce((m, l) => (l.debit > m ? l.debit : l.credit > m ? l.credit : m), 0n)), link: { type: 'entry', id: e.id } }));
  const unrec = odb.lines.filter((l) => l.companyId === companyId && l.status === 'open' && l.date <= pe).sort((a, b) => a.date.localeCompare(b.date)).map((l) => {
    const bank = odb.banks.find((b) => b.id === l.bankId)!; const acc = db.accounts.find((a) => a.id === bank.accountId)!;
    return { itemKey: l.id, date: l.date, label: `${acc.name} · ${l.description}`, detail: l.reference, amount: s(l.amount), link: { type: 'bank_line', id: bank.id } };
  });
  const bal = balances(companyId, pe);
  const abnormal = db.accounts.filter((a) => a.companyId === companyId && !['1590', '4900', '3000'].includes(a.code)).sort((a, b) => a.code.localeCompare(b.code)).flatMap((a) => {
    const v = bal.get(a.id) ?? 0n;
    return ((['asset', 'expense'].includes(a.type) && v < 0n) || (['liability', 'income'].includes(a.type) && v > 0n))
      ? [{ itemKey: a.id, date: null, label: `${a.code} ${a.name}`, detail: a.type, amount: s(v < 0n ? -v : v), link: { type: 'account', id: a.id } }] : [];
  });
  const cutoff = addD(pe, -90);
  const overdue = docs.filter((d) => d.type === 'invoice' && d.status === 'issued' && d.dueDate && d.dueDate < cutoff && amountDue(d) > 0n)
    .map((d) => ({ ...f(d, String(Math.round((Date.parse(pe) - Date.parse(d.dueDate!)) / 86400000)), amountDue(d)), date: d.dueDate }));
  const drafts = docs.filter((d) => d.status === 'draft' && ['invoice', 'bill', 'expense', 'credit_note', 'supplier_credit'].includes(d.type) && inMonth(d.issueDate))
    .map((d) => ({ ...f(d), label: `${d.type} · ${nameOfDoc(d)}` }));
  const mods = co.modules ?? [];
  const staff = mods.includes('HRM') ? empsOf(companyId).filter((e) => e.hasProfile && e.status === 'active' && e.joinDate! <= pe && (!e.leavingDate || e.leavingDate >= from)) : [];
  const payroll = staff.length && !hdb.runs.some((r) => r.companyId === companyId && r.periodEnd === pe && r.status !== 'draft') ? [{ itemKey: pe, date: pe, label: String(staff.length), detail: null, amount: null, link: null }] : [];
  const dep = mods.includes('Assets') && !odb.runs.some((r) => r.companyId === companyId && r.periodEnd === pe) && odb.assets.some((a) => a.companyId === companyId && a.status === 'active') ? (() => {
    const p = previewM(companyId, pe); return toMinor(p.total) > 0n ? [{ itemKey: pe, date: pe, label: String(p.lines.length), detail: null, amount: p.total, link: null }] : [];
  })() : [];
  const raw: [string, string, F[]][] = [
    ['missing_input_vat', 'warning', reg ? issued(['bill', 'expense']).filter((d) => vatNo(d) && d.lines.some((l) => l.vatCode !== 'standard')).map((d) => f(d, vatNo(d))) : []],
    ['vat_without_number', 'warning', reg ? issued(['bill', 'expense']).filter((d) => vatOf(d) > 0n && !vatNo(d)).map((d) => f(d, null, vatOf(d))) : []],
    ['sales_without_vat', 'info', reg ? issued(['invoice']).filter((d) => d.lines.some((l) => l.vatCode !== 'standard')).map((d) => f(d, [...new Set(d.lines.filter((l) => l.vatCode !== 'standard').map((l) => l.vatCode))].join(', '))) : []],
    ['duplicates', 'warning', dupes], ['round_amounts', 'info', round], ['unreconciled', 'warning', unrec], ['abnormal_balances', 'warning', abnormal],
    ['overdue_receivables', 'info', overdue], ['drafts_left', 'info', drafts], ['payroll_missing', 'warning', payroll], ['depreciation_missing', 'warning', dep],
  ];
  return raw.map(([key, severity, rows]) => {
    const findings = rows.map((r) => { const e = rvdb.explained.find((x) => x.companyId === companyId && x.check === key && x.item === r.itemKey);
      return { ...r, explained: e ? { note: e.note, by: userName(e.by), at: e.at } : null }; });
    return { key, severity, findings, open: findings.filter((x) => !x.explained).length };
  });
}
const queryRow = (q: MQuery) => { const ms = rvdb.messages.filter((m) => m.queryId === q.id);
  return { ...q, raisedBy: userName(q.raisedBy), closedBy: userName(q.closedBy), messages: ms.length, lastAt: ms.at(-1)?.createdAt ?? null }; };
const queryOf = (id: string) => rvdb.queries.find((q) => q.id === id && roleOf(session, q.companyId)) ?? fail(404, 'Not found.', 'err.notFound');
function replyM(id: string, body: unknown) {
  const q = queryOf(id); const text = cstr(body) ?? fail(400, 'Write the reply.', 'err.queryBody');
  if (q.status === 'closed') fail(400, 'This query is closed. Reopen it to reply.', 'err.queryClosed');
  rvdb.messages.push({ id: uid(), companyId: q.companyId, queryId: id, author: session!, body: text, createdAt: new Date().toISOString() });
  q.status = RV_FIRM.includes(rvRole(q.companyId)!) ? 'open' : 'answered';
}
function raiseQueryM(companyId: string, b: Body) {
  rvFirmOnly(companyId);
  const pe = rvMonth(b?.periodEnd);
  const subject = cstr(b?.subject) ?? fail(400, 'Enter what the question is about.', 'err.querySubject');
  const body = cstr(b?.body) ?? fail(400, 'Write the question.', 'err.queryBody');
  const aboutType = ['entry', 'document', 'account', 'bank_line', 'check'].includes(String(b?.aboutType)) ? String(b!.aboutType) : null;
  const id = uid();
  rvdb.queries.push({ id, companyId, periodEnd: pe, subject, aboutType, aboutId: aboutType ? cstr(b?.aboutId) : null, aboutLabel: aboutType ? cstr(b?.aboutLabel) : null, status: 'open',
    raisedBy: session!, raisedAt: new Date().toISOString(), closedBy: null, closedAt: null });
  rvdb.messages.push({ id: uid(), companyId, queryId: id, author: session!, body, createdAt: new Date().toISOString() });
  return id;
}
function setQueryStatusM(id: string, status: string) {
  const q = queryOf(id);
  if (!RV_FIRM.includes(rvRole(q.companyId)!)) fail(400, 'Only the accounting firm closes or reopens a query.', 'err.queryFirmOnly');
  if (status === 'closed') { q.status = 'closed'; q.closedBy = session; q.closedAt = new Date().toISOString(); } else { q.status = 'open'; q.closedBy = null; q.closedAt = null; }
}
const activeSignoff = (companyId: string, pe: string) => rvdb.signoffs.find((x) => x.companyId === companyId && x.periodEnd === pe && !x.withdrawnAt) ?? null;
const RV_ITEMS = ['bank_reconciled', 'sales_complete', 'purchases_complete', 'drafts_cleared', 'vat_reviewed', 'payroll_posted', 'depreciation_run', 'stock_counted', 'receivables_reviewed',
  'payables_reviewed', 'accruals', 'queries_closed'];
function checklistM(companyId: string, pe: string) {
  const co = db.companies.find((c) => c.id === companyId)!; const mods = co.modules ?? [];
  const from = `${pe.slice(0, 7)}-01`;
  const auto: Record<string, boolean> = {
    bank_reconciled: !odb.lines.some((l) => l.companyId === companyId && l.status === 'open' && l.date <= pe),
    drafts_cleared: !sdb.docs.some((d) => d.companyId === companyId && d.status === 'draft' && ['invoice', 'bill', 'expense', 'credit_note', 'supplier_credit'].includes(d.type) && d.issueDate >= from && d.issueDate <= pe),
    queries_closed: !rvdb.queries.some((q) => q.companyId === companyId && q.periodEnd === pe && q.status !== 'closed'),
  };
  if (mods.includes('HRM')) auto.payroll_posted = hdb.runs.some((r) => r.companyId === companyId && r.periodEnd === pe && r.status !== 'draft') || !hdb.profiles.some((p) => p.companyId === companyId && p.joinDate <= pe);
  if (mods.includes('Assets')) auto.depreciation_run = odb.runs.some((r) => r.companyId === companyId && r.periodEnd === pe) || !odb.assets.some((a) => a.companyId === companyId && a.status === 'active');
  const applies = (i: string) => (i === 'payroll_posted' ? mods.includes('HRM') : i === 'depreciation_run' ? mods.includes('Assets')
    : i === 'stock_counted' ? mods.includes('Inventory') || mods.includes('Restaurant') : i === 'vat_reviewed' ? co.vatStatus === 'registered' : true);
  const items = RV_ITEMS.filter(applies).map((item) => {
    const tk = rvdb.ticks.find((x) => x.companyId === companyId && x.periodEnd === pe && x.item === item);
    const a = item in auto ? auto[item]! : null;
    return { item, auto: a, ticked: tk?.done ?? false, note: tk?.note ?? null, by: tk?.done ? userName(tk.by) : null, at: tk?.done ? tk.at : null, done: Boolean(a) || Boolean(tk?.done) };
  });
  return { periodEnd: pe, items, done: items.filter((i) => i.done).length, total: items.length };
}
function tickM(companyId: string, pe: string, item: string, done: boolean, note: unknown) {
  rvFirmOnly(companyId); rvMonth(pe);
  if (!RV_ITEMS.includes(item)) fail(400, 'Choose the checklist item.', 'err.format');
  if (activeSignoff(companyId, pe)) fail(400, 'This month is signed off; its checklist no longer changes.', 'err.checklistSigned');
  const old = rvdb.ticks.find((x) => x.companyId === companyId && x.periodEnd === pe && x.item === item);
  const v = { companyId, periodEnd: pe, item, done, note: cstr(note), by: session!, at: new Date().toISOString() };
  if (old) Object.assign(old, v); else rvdb.ticks.push(v);
}
function monthsM(companyId: string, upTo: string) {
  const out = []; let pe = rvMonth(upTo);
  for (let i = 0; i < 12; i++) {
    const so = activeSignoff(companyId, pe);
    const w = rvdb.signoffs.filter((x) => x.companyId === companyId && x.periodEnd === pe && x.withdrawnAt).sort((a, b) => b.withdrawnAt!.localeCompare(a.withdrawnAt!))[0];
    const qs = rvdb.queries.filter((q) => q.companyId === companyId && q.periodEnd === pe);
    const from = `${pe.slice(0, 7)}-01`;
    out.push({ periodEnd: pe, signoff: so ? { id: so.id, note: so.note, signedBy: userName(so.signedBy), signedAt: so.signedAt,
      changedAfter: db.entries.filter((e) => e.companyId === companyId && e.date >= from && e.date <= pe && e.createdAt > so.signedAt).length } : null,
      lastWithdrawn: w ? { by: userName(w.withdrawnBy), at: w.withdrawnAt, reason: w.withdrawReason } : null, openQueries: qs.filter((q) => q.status !== 'closed').length, queries: qs.length });
    pe = prevEnd(pe);
  }
  return out;
}
function signOffM(companyId: string, pe: string, note: unknown) {
  rvMonth(pe);
  if (!RV_SIGN.includes(rvRole(companyId)!)) fail(400, 'Only a partner or reviewer signs off a month.', 'err.signoffRole');
  const cl = checklistM(companyId, pe); const missing = cl.items.filter((i) => !i.done).map((i) => i.item);
  if (missing.length) fail(400, 'Finish the checklist before signing off.', 'err.checklistOpen', missing);
  if (rvdb.queries.some((q) => q.companyId === companyId && q.periodEnd === pe && q.status !== 'closed')) fail(400, 'Close this month\'s queries first.', 'err.queriesOpen');
  if (pe >= today()) fail(400, 'A month is signed off after it has ended.', 'err.signoffEarly');
  if (activeSignoff(companyId, pe)) fail(400, 'A sign-off is never changed.', 'err.signoffFixed');
  const id = uid(); rvdb.signoffs.push({ id, companyId, periodEnd: pe, note: cstr(note), signedBy: session!, signedAt: new Date().toISOString(), withdrawnBy: null, withdrawnAt: null, withdrawReason: null });
  return id;
}
const reviewedUpToM = (companyId: string) => { const so = rvdb.signoffs.filter((x) => x.companyId === companyId && !x.withdrawnAt).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  return so ? { periodEnd: so.periodEnd, signedBy: userName(so.signedBy), signedAt: so.signedAt } : null; };

routes.push(
  ['GET', /^\/api\/review\/my-clients$/, () => db.memberships.filter((m) => m.userId === session).map((m) => ({ companyId: m.companyId,
    open: rvdb.queries.filter((q) => q.companyId === m.companyId && q.status === 'open').length, answered: rvdb.queries.filter((q) => q.companyId === m.companyId && q.status === 'answered').length,
    reviewedUpTo: reviewedUpToM(m.companyId)?.periodEnd ?? null }))],
  ['GET', /^\/api\/companies\/([\w-]+)\/review\/overview$/, (m, _b, q) => {
    const id = inCo(m[1]!); const pe = rvMonth(q.get('month')); const checks = runChecksM(id, pe); const cl = checklistM(id, pe);
    return { checks: checks.map((c) => ({ key: c.key, severity: c.severity, open: c.open, total: c.findings.length })), openFindings: checks.reduce((t, c) => t + c.open, 0),
      checklist: { done: cl.done, total: cl.total }, ...monthsM(id, pe)[0]!, reviewedUpTo: reviewedUpToM(id) };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/review\/checks$/, (m, _b, q) => runChecksM(inCo(m[1]!), rvMonth(q.get('month')))],
  ['POST', /^\/api\/companies\/([\w-]+)\/review\/explain$/, (m, b) => {
    const id = inCo(m[1]!); rvFirmOnly(id);
    rvdb.explained = rvdb.explained.filter((x) => !(x.companyId === id && x.check === b?.check && x.item === b?.item));
    if (cstr(b?.note)) rvdb.explained.push({ companyId: id, check: String(b!.check), item: String(b!.item), note: cstr(b!.note)!, by: session!, at: new Date().toISOString() });
    return { ok: true };
  }],
  ['GET', /^\/api\/companies\/([\w-]+)\/review\/queries$/, (m, _b, q) => {
    const id = inCo(m[1]!); const st = q.get('status') ?? ''; const pe = q.get('month');
    return rvdb.queries.filter((x) => x.companyId === id && (!st || (st === 'unresolved' ? x.status !== 'closed' : x.status === st)) && (!pe || x.periodEnd === pe)).map(queryRow)
      .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || (b.lastAt ?? b.raisedAt).localeCompare(a.lastAt ?? a.raisedAt));
  }],
  ['POST', /^\/api\/companies\/([\w-]+)\/review\/queries$/, (m, b) => ({ id: raiseQueryM(inCo(m[1]!), b) })],
  ['GET', /^\/api\/review\/queries\/([\w-]+)$/, (m) => { const q = queryOf(m[1]!);
    return { ...queryRow(q), messages: rvdb.messages.filter((x) => x.queryId === q.id).map((x) => ({ id: x.id, body: x.body, createdAt: x.createdAt, author: userName(x.author), mine: x.author === session,
      fromFirm: RV_FIRM.includes(roleOf(x.author, q.companyId)!) })) }; }],
  ['POST', /^\/api\/review\/queries\/([\w-]+)\/reply$/, (m, b) => { replyM(m[1]!, b?.body); return { ok: true }; }],
  ['POST', /^\/api\/review\/queries\/([\w-]+)\/status$/, (m, b) => { setQueryStatusM(m[1]!, String(b?.status)); return { ok: true }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/review\/checklist$/, (m, _b, q) => checklistM(inCo(m[1]!), rvMonth(q.get('month')))],
  ['POST', /^\/api\/companies\/([\w-]+)\/review\/checklist$/, (m, b) => { tickM(inCo(m[1]!), String(b?.month ?? ''), String(b?.item ?? ''), b?.done !== false, b?.note); return { ok: true }; }],
  ['GET', /^\/api\/companies\/([\w-]+)\/review\/months$/, (m, _b, q) => monthsM(inCo(m[1]!), String(q.get('month') ?? ''))],
  ['POST', /^\/api\/companies\/([\w-]+)\/review\/sign-off$/, (m, b) => ({ id: signOffM(inCo(m[1]!), String(b?.month ?? ''), b?.note) })],
  ['POST', /^\/api\/review\/sign-offs\/([\w-]+)\/withdraw$/, (m, b) => {
    const so = rvdb.signoffs.find((x) => x.id === m[1] && roleOf(session, x.companyId) && !x.withdrawnAt) ?? fail(404, 'Not found.', 'err.notFound');
    if (!RV_SIGN.includes(rvRole(so.companyId)!)) fail(400, 'Only a partner or reviewer withdraws a sign-off.', 'err.signoffRole');
    so.withdrawReason = cstr(b?.reason) ?? fail(400, 'Say why the sign-off is withdrawn.', 'err.withdrawReason');
    so.withdrawnBy = session; so.withdrawnAt = new Date().toISOString();
    return { ok: true };
  }],
);

/** Sample review data, as in src/db/seed.ts. */
function seedReview(companyId: string, poster: string) {
  const prev = session;
  const partner = db.memberships.find((m) => m.companyId === companyId && m.role === 'partner')!.userId;
  const last = prevEnd(today()), before = prevEnd(last);
  session = partner;
  const q0 = raiseQueryM(companyId, { periodEnd: before, subject: 'Office water delivery posted twice', body: 'We see a reversal for the water delivery. Was it paid once only?' });
  session = poster; replyM(q0, 'Yes, paid once. The second entry was a mistake and is reversed.');
  session = partner; setQueryStatusM(q0, 'closed');
  for (const i of checklistM(companyId, before).items.filter((x) => !x.done)) tickM(companyId, before, i.item, true, i.auto === false ? 'Checked: open items are next month\'s' : null);
  signOffM(companyId, before, 'Reviewed. VAT return can be filed.');
  const round = runChecksM(companyId, last).find((c) => c.key === 'round_amounts')?.findings[0];
  if (round) rvdb.explained.push({ companyId, check: 'round_amounts', item: round.itemKey, note: 'Agreed with the client', by: partner, at: new Date().toISOString() });
  raiseQueryM(companyId, { periodEnd: last, subject: 'Supplier bill without tax invoice', body: 'Please attach the supplier\'s tax invoice for the last bill from Najd Wholesale.', aboutType: 'check', aboutId: 'missing_input_vat' });
  const q2 = raiseQueryM(companyId, { periodEnd: last, subject: 'Cash on hand', body: 'Can you confirm the cash count at the month end?' });
  session = poster; replyM(q2, 'Counted on the last day; it agrees with the books.');
  session = partner; tickM(companyId, last, 'sales_complete', true, null); tickM(companyId, last, 'purchases_complete', true, null);
  session = prev;
}

// Sample data is created once everything above is defined.
seed();
// Client accountant and Client management are ordinary, editable roles (db/migrations/0018); every client user has one.
const all = (level: AccessLevel) => Object.fromEntries(ROLE_MODULES.map((m) => [m, level])) as Record<string, AccessLevel>;
rolesDb.unshift({ id: uid(), name: 'Client accountant', nameAr: 'محاسب العميل', description: 'Daily entry in every module the client has', permissions: all('edit'), canApprove: true, status: 'active' },
  { id: uid(), name: 'Client management', nameAr: 'إدارة العميل', description: 'Sees everything, changes nothing', permissions: all('view'), canApprove: false, status: 'active' });
for (const r of DEMO_ROLES) rolesDb.push({ id: uid(), ...r, status: 'active' });
for (const m of db.memberships) if (!m.clientRoleId && db.users.find((u) => u.id === m.userId)?.kind === 'client') m.clientRoleId = defaultRole(m.role)?.id ?? null;
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
