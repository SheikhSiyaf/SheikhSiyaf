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
interface User { id: string; name: string; email: string; kind: 'admin' | 'firm_staff' | 'client'; staffRole: Role | null; twoFactor: boolean }
interface Company {
  id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string;
  vatStatus: 'registered' | 'unregistered'; vatNumber: string | null; crNumber: string; city: string;
  invoicePrefix: string; paymentTermsDays: number;
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
  return db.memberships.find((m) => m.userId === userId && m.companyId === companyId)?.role;
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
    db.users.push({ id: uid(), name: u.name, email: u.email, kind: u.kind, staffRole: u.kind === 'firm_staff' ? (u.role as Role) : null, twoFactor: u.kind !== 'client' });
  }
  const userByEmail = (e: string) => db.users.find((u) => u.email === e)!;
  for (const c of DEMO_COMPANIES) {
    const id = uid();
    db.companies.push({ id, name: c.name, nameAr: c.nameAr, country: c.country, currency: c.currency, vatRate: c.vatRate, vatStatus: 'registered',
      vatNumber: c.vatNumber, crNumber: c.crNumber, city: c.city, invoicePrefix: c.invoicePrefix, paymentTermsDays: 30 });
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

// ------------------------------------------------------------------ helpers for responses
const s = fromMinor;
const me = () => { if (!session) fail(401, 'Please sign in.', 'err.signIn'); return db.users.find((u) => u.id === session)!; };
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

// ------------------------------------------------------------------ routes
type Body = Record<string, unknown> | undefined;
type Handler = (m: RegExpMatchArray, body: Body, query: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/config$/, () => ({ demoLogins: true, demoPassword: DEMO_PASSWORD })],
  ['GET', /^\/api\/demo-users$/, () => DEMO_USERS.map(({ name, email, kind, role, company }) => ({ name, email, kind, role, company }))],
  ['POST', /^\/api\/login$/, (_m, b) => {
    const u = db.users.find((x) => x.email.toLowerCase() === String(b?.email ?? '').trim().toLowerCase());
    if (!u || b?.password !== DEMO_PASSWORD) fail(401, 'The email or password is not right.', 'err.login');
    session = u!.id;
    return { ok: true };
  }],
  ['POST', /^\/api\/logout$/, () => { session = null; return { ok: true }; }],
  ['GET', /^\/api\/me$/, () => {
    const u = me();
    return {
      user: { id: u.id, name: u.name, email: u.email, kind: u.kind, staffRole: u.staffRole, firmName: DEMO_FIRM },
      companies: db.memberships.filter((m) => m.userId === u.id)
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
  ['GET', /^\/api\/admin\/companies$/, () => {
    if (me().kind !== 'admin') fail(403, 'Only the Administrator can do this.', 'err.adminOnly');
    return [...db.companies].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
      ...companyView(c), crNumber: c.crNumber, vatStatus: c.vatStatus, vatNumber: c.vatNumber, city: c.city,
      clientUsers: db.memberships.filter((m) => m.companyId === c.id && db.users.find((u) => u.id === m.userId)?.kind === 'client').length,
      staff: db.memberships.filter((m) => m.companyId === c.id).map((m) => db.users.find((u) => u.id === m.userId)!).filter((u) => u.kind === 'firm_staff').map((u) => u.name).sort(),
    }));
  }],
  ['GET', /^\/api\/admin\/staff$/, () => {
    if (me().kind !== 'admin') fail(403, 'Only the Administrator can do this.', 'err.adminOnly');
    return db.users.filter((u) => u.kind === 'firm_staff').sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.staffRole, twoFactor: u.twoFactor,
      clients: db.memberships.filter((m) => m.userId === u.id).map((m) => db.companies.find((c) => c.id === m.companyId)!.name).sort(),
    }));
  }],
  ['POST', /^\/api\/admin\/companies$/, (_m, b) => {
    if (me().kind !== 'admin') fail(403, 'Only the Administrator can do this.', 'err.adminOnly');
    const c = (b?.company ?? {}) as Record<string, string | undefined>;
    const v = (k: string) => (c[k] ?? '').trim();
    const country = v('country') as Company['country'];
    const d = { SA: ['SAR', '15.00'], AE: ['AED', '5.00'], OM: ['OMR', '5.00'] }[country];
    if (!d) fail(400, 'Choose the country.', 'err.country');
    const registered = v('vatStatus') !== 'unregistered';
    const fu = (b?.firstUser ?? {}) as Record<string, string | undefined>;
    if (!v('name') || !v('crNumber') || !v('legalForm') || !v('address') || !v('city')) fail(400, 'Fill in all required fields.', 'err.required');
    if (!(fu.name ?? '').trim() || !(fu.email ?? '').trim()) fail(400, 'Add the first client user (name and email).', 'err.firstClientUser');
    if (country === 'SA' && !/^\d{10}$/.test(v('crNumber'))) fail(400, 'A Saudi CR number has 10 digits.', 'err.saCr');
    if (registered && !v('vatNumber')) fail(400, 'Enter the VAT number, or choose VAT unregistered.', 'err.vatNumber');
    if (registered && country === 'SA' && !/^3\d{13}3$/.test(v('vatNumber'))) fail(400, 'A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat');
    if (registered && country === 'AE' && !/^\d{15}$/.test(v('vatNumber'))) fail(400, 'A UAE TRN has 15 digits.', 'err.aeTrn');
    if (db.companies.some((x) => x.crNumber === v('crNumber'))) fail(400, 'A client with this registration number already exists.', 'err.crTaken');
    if (registered && db.companies.some((x) => x.vatNumber === v('vatNumber'))) fail(400, 'A client with this VAT number already exists.', 'err.vatTaken');
    if (db.users.some((u) => u.email.toLowerCase() === (fu.email ?? '').trim().toLowerCase())) fail(400, 'A user with this email already exists.', 'err.emailTaken');
    const id = uid();
    db.companies.push({ id, name: v('name'), nameAr: v('nameAr') || null, country, currency: d![0]!, vatRate: registered ? d![1]! : '0.00',
      vatStatus: registered ? 'registered' : 'unregistered', vatNumber: registered ? v('vatNumber') : null, crNumber: v('crNumber'), city: v('city'),
      invoicePrefix: v('invoicePrefix') || 'INV-', paymentTermsDays: Number(v('paymentTermsDays') || 30) });
    const user: User = { id: uid(), name: fu.name!.trim(), email: fu.email!.trim(), kind: 'client', staffRole: null, twoFactor: false };
    db.users.push(user);
    db.memberships.push({ userId: user.id, companyId: id, role: fu.role === 'client_viewer' ? 'client_viewer' : 'client_accountant' });
    for (const sid of (b?.staffIds as string[] | undefined) ?? []) {
      const st = db.users.find((u) => u.id === sid && u.kind === 'firm_staff');
      if (st) db.memberships.push({ userId: st.id, companyId: id, role: st.staffRole! });
    }
    setupBooks(id);
    return { id };
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
