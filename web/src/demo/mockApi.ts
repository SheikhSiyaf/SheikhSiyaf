// Demo build only: answers the same /api requests as src/api/server.ts, from sample data held in
// this browser page. It repeats the database's rules (balance, two lines, cost centres, locked
// periods, roles, company separation, registration checks) so the preview behaves like the app.
// It is NOT the source of truth: the real rules live in db/migrations and are covered by `npm test`.
// Data resets when the page reloads.
import { toMinor, fromMinor } from '../../../src/money.ts';
import { vatForLine } from '../../../src/vat/vat.ts';
import { CHART_TEMPLATE, SYSTEM_ACCOUNTS } from '../../../src/books/chartTemplate.ts';
import { DEMO_COMPANIES, DEMO_FIRM, DEMO_PASSWORD, DEMO_USERS } from '../../../src/db/demoData.ts';

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
interface Account { id: string; companyId: string; code: string; name: string; nameAr: string | null; type: string; costCentreRequired: boolean }
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
    db.accounts.push({ id: uid(), companyId, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, costCentreRequired: Boolean(a.costCentreRequired) });
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
    const vat = (n: number) => vatForLine(net(n), c.vatRate);
    const L = (code: string, debit: bigint, credit: bigint, centre?: string) => ({ accountId: acct(code), debit, credit, costCentreId: centre ? cc(centre) : null });
    const poster = userByEmail(DEMO_USERS.find((u) => u.companies.includes(c.key) && (u.role === 'client_accountant' || u.role === 'staff_accountant'))!.email).id;
    const p = (days: number, memo: string, lines: Omit<Line, 'id'>[]) => post(poster, id, daysAgo(days), memo, lines);
    const pre = c.invoicePrefix;
    p(120, 'Opening balance', [L('1000', net(50000), 0n), L('3000', 0n, net(50000))]);
    p(95, `${pre}0001 · Gulf Steel`, [L('1100', net(10000) + vat(10000), 0n), L('4000', 0n, net(10000), 'Head office'), L('2100', 0n, vat(10000))]);
    p(80, `Receipt for ${pre}0001`, [L('1000', net(10000) + vat(10000), 0n), L('1100', 0n, net(10000) + vat(10000))]);
    p(60, 'Rent · head office', [L('5100', net(4000), 0n, 'Head office'), L('1000', 0n, net(4000))]);
    p(34, `${pre}0002 · Al Faisal Contracting`, [L('1100', net(7250) + vat(7250), 0n), L('4000', 0n, net(5000), 'Head office'), L('4000', 0n, net(2250), 'Branch 1'), L('2100', 0n, vat(7250))]);
    p(30, 'Bill · Riyadh Wholesale', [L('5000', net(3200), 0n), L('1200', vat(3200), 0n), L('2000', 0n, net(3200) + vat(3200))]);
    p(25, 'Salaries', [L('5200', net(6000), 0n, 'Head office'), L('5200', net(2500), 0n, 'Branch 1'), L('1000', 0n, net(8500))]);
    const wrong = p(12, 'STC bill payment', [L('5300', net(420), 0n), L('1000', 0n, net(420))]);
    reverse(poster, wrong, daysAgo(11));
    db.entries.at(-1)!.memo = 'Reversal: STC bill posted twice';
    p(6, `${pre}0003 · Cash sale`, [L('1000', net(1800) + vat(1800), 0n), L('4000', 0n, net(1800), 'Project A'), L('2100', 0n, vat(1800))]);
    p(1, 'Utilities', [L('5300', net(650), 0n), L('1000', 0n, net(650))]);
    const cutoff = new Date(); cutoff.setDate(1); cutoff.setMonth(cutoff.getMonth() - 1);
    for (const per of db.periods) if (per.companyId === id && per.endDate < iso(cutoff)) per.lockedAt = new Date().toISOString();
  }
}
seed();
db.activity.push({ id: uid(), at: new Date().toISOString(), actor: null, key: 'act.firmCreated', params: { name: DEMO_FIRM } });

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
      company: { ...companyView(c), vatStatus: c.vatStatus, vatNumber: c.vatNumber, crNumber: c.crNumber, city: c.city },
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
