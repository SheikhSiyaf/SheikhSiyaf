// The checklist beside the bell: which items exist, who may see each, which tick themselves from the books, and how a company's
// Administrator may change the list. Pure functions only (no database), so every rule is tested on its own (test/checklist.test.ts).
// The words shown for the built-in items live in the web app (English and Arabic); the server sends only keys.
import { accessTo, type AccessLevel } from './modules.js';

export type Area = 'setup' | 'daily' | 'month_end';
export const AREAS: Area[] = ['setup', 'daily', 'month_end'];
export type Scope = 'company' | 'user';
export type Period = 'once' | 'day' | 'month';

/** Where "Go there" leads: a module page of the books, or one of the pages outside the books. */
export interface Go { module?: string; sub?: string; item?: string; page?: 'company' | 'security' }

/** What is true of the company and of the caller right now (read from the database by checklistService). */
export interface Facts {
  country: string; vatStatus: string; cr: string; vat: string | null; modules: string[];
  addressDone: boolean; logo: boolean; bankAccounts: boolean; customers: boolean; suppliers: boolean; items: boolean; entries: boolean;
  invoice: boolean; einvoicing: boolean; approvalRules: boolean; members: number; twofa: boolean;
  openBankLines: boolean; openBankLinesToMonthEnd: boolean; draftsToMonthEnd: boolean; signedOff: boolean;
}

/** The caller's role in this company. `null` = no client role (a firm's own staff): full access, the database still applies the rest. */
export interface Role { permissions: Record<string, string>; canApprove: boolean; canSignOff: boolean }

export interface BuiltIn {
  key: string; area: Area; scope: Scope; period: Period; go: Go;
  /** needs at least View on one of these modules (role-based) */
  modules?: string[];
  /** only when this optional module is switched on for the company */
  optional?: string;
  adminOnly?: boolean;
  needs?: 'approve' | 'signOff';
  /** only for companies where this is true (e.g. VAT registered) */
  applies?: (f: Facts) => boolean;
  /** the item ticks itself when this is true */
  auto?: (f: Facts) => boolean;
}

const BOOKS = ['Sales', 'Purchases', 'Expenses'];
const vatRegistered = (f: Facts) => f.vatStatus === 'registered';

/** The built-in items, in the order they are shown. The first nine setup items keep the logic of the old home-page checklist. */
export const BUILT_IN: BuiltIn[] = [
  { key: 'company', area: 'setup', scope: 'company', period: 'once', adminOnly: true, go: { page: 'company' }, auto: (f) => f.addressDone },   // the brief also names the logo, but the software has no logo upload yet, so the address alone ticks it
  { key: 'registration', area: 'setup', scope: 'company', period: 'once', adminOnly: true, go: { page: 'company' }, auto: (f) => registrationLooksReal(f.country, f.cr, f.vatStatus, f.vat) },
  { key: 'chart', area: 'setup', scope: 'company', period: 'once', modules: ['Ledger'], go: { module: 'Ledger', sub: 'chart-of-accounts' } },
  { key: 'customers', area: 'setup', scope: 'company', period: 'once', modules: ['Sales'], go: { module: 'Sales', sub: 'customers', item: 'import' }, auto: (f) => f.customers },
  { key: 'suppliers', area: 'setup', scope: 'company', period: 'once', modules: ['Purchases'], go: { module: 'Purchases', sub: 'suppliers', item: 'import' }, auto: (f) => f.suppliers },
  { key: 'items', area: 'setup', scope: 'company', period: 'once', modules: ['Inventory'], optional: 'Inventory', go: { module: 'Inventory', sub: 'items', item: 'import' }, auto: (f) => f.items },
  { key: 'opening', area: 'setup', scope: 'company', period: 'once', modules: ['Ledger'], go: { module: 'Ledger', sub: 'import-data', item: 'opening' }, auto: (f) => f.entries },
  { key: 'bank', area: 'setup', scope: 'company', period: 'once', modules: ['Bank'], go: { module: 'Bank', sub: 'accounts', item: 'new' }, auto: (f) => f.bankAccounts },
  { key: 'invoice', area: 'setup', scope: 'company', period: 'once', modules: ['Sales'], go: { module: 'Sales', sub: 'invoices', item: 'new' }, auto: (f) => f.invoice },
  { key: 'einvoicing', area: 'setup', scope: 'company', period: 'once', modules: ['Sales'], go: { module: 'Sales', sub: 'e-invoicing' }, applies: (f) => vatRegistered(f) && f.country !== 'OM', auto: (f) => f.einvoicing },
  { key: 'approvals', area: 'setup', scope: 'company', period: 'once', needs: 'approve', go: { module: 'Approvals', sub: 'approval-rules' }, auto: (f) => f.approvalRules },
  { key: 'team', area: 'setup', scope: 'company', period: 'once', adminOnly: true, go: { page: 'company' }, auto: (f) => f.members > 1 },
  { key: 'twofa', area: 'setup', scope: 'user', period: 'once', go: { page: 'security' }, auto: (f) => f.twofa },

  { key: 'daily_record', area: 'daily', scope: 'user', period: 'day', modules: BOOKS, go: { module: 'Sales', sub: 'invoices' } },
  { key: 'daily_bank', area: 'daily', scope: 'company', period: 'day', modules: ['Bank'], go: { module: 'Bank', sub: 'reconcile' }, applies: (f) => f.bankAccounts, auto: (f) => !f.openBankLines },

  { key: 'me_bank', area: 'month_end', scope: 'company', period: 'month', modules: ['Bank'], go: { module: 'Bank', sub: 'reconcile' }, applies: (f) => f.bankAccounts, auto: (f) => !f.openBankLinesToMonthEnd },
  { key: 'me_drafts', area: 'month_end', scope: 'company', period: 'month', modules: BOOKS, go: { module: 'Sales', sub: 'invoices' }, auto: (f) => !f.draftsToMonthEnd },
  { key: 'me_vat', area: 'month_end', scope: 'company', period: 'month', modules: ['Reports'], go: { module: 'Reports', sub: 'vat-summary' }, applies: vatRegistered },
  { key: 'me_signoff', area: 'month_end', scope: 'company', period: 'month', needs: 'signOff', go: { module: 'Review', sub: 'sign-off' }, auto: (f) => f.signedOff },
];
export const BUILT_IN_KEYS = new Set(BUILT_IN.map((b) => b.key));

/** The module pages a custom item may lead to (a name not on this list is refused, so a saved link can never point anywhere odd). */
export const GO_MODULES = ['Home', 'Approvals', 'Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM',
  'Journal', 'Ledger', 'Reports', 'Review', 'Calendar', 'Portal'] as const;

/** The month a month-end item is about: the one that has just finished. `today` is the date in Riyadh. */
export function previousMonth(today: string): { period: string; end: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const end = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mm = String(pm).padStart(2, '0');
  return { period: `${py}-${mm}`, end: `${py}-${mm}-${String(end).padStart(2, '0')}` };
}

/** The period a tick is kept under: nothing for once-only items, the day for daily items, the month just finished for month-end items. */
export function periodKey(period: Period, today: string): string {
  return period === 'once' ? '' : period === 'day' ? today : previousMonth(today).period;
}

const PLACEHOLDER_CR = /^(.)\1*$/;   // 0000000000, 1111111111
/** True when the registration numbers look like real ones: not a filler, and a VAT number in the country's own shape when VAT-registered. */
export function registrationLooksReal(country: string, cr: string, vatStatus: string, vat: string | null): boolean {
  if (!cr || PLACEHOLDER_CR.test(cr)) return false;
  if (vatStatus !== 'registered') return true;
  if (!vat) return false;
  if (country === 'SA') return /^3\d{13}3$/.test(vat);
  if (country === 'AE') return /^\d{15}$/.test(vat) && !PLACEHOLDER_CR.test(vat);
  return vat.trim().length >= 6 && !PLACEHOLDER_CR.test(vat);
}

/** One row of the company's own changes to the list, as stored. */
export interface Override {
  key: string; isCustom: boolean; area: Area | null; scope: Scope; title: string | null; titleAr: string | null; help: string | null; helpAr: string | null;
  goModule: string | null; goSub: string | null; sort: number | null; hidden: boolean;
}
export interface Tick { key: string; userId: string | null; period: string; at: string }

export interface Item {
  key: string; area: Area; scope: Scope; period: Period; custom: boolean; go: Go | null;
  title: string | null; titleAr: string | null; help: string | null; helpAr: string | null;   // null = use the built-in wording
  done: boolean; how: 'auto' | 'manual' | null; doneAt: string | null; forMonth: string | null;
  hiddenByMe: boolean; hiddenForCompany: boolean; sort: number;
}

export interface Inputs {
  facts: Facts; role: Role | null; isAdmin: boolean; today: string; userId: string;
  overrides: Override[]; ticks: Tick[]; hiddenByMe: string[];
}

const rank: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };
const canView = (role: Role | null, modules: string[]) => !role || modules.some((m) => rank[accessTo(role.permissions, m)] >= 1);

/** Whether a built-in item is for this person at all. Enforced on the server: a role without the module never receives the item. */
export function visibleTo(b: BuiltIn, i: Pick<Inputs, 'facts' | 'role' | 'isAdmin'>): boolean {
  if (b.adminOnly && !i.isAdmin) return false;
  if (b.optional && !i.facts.modules.includes(b.optional)) return false;
  if (b.applies && !b.applies(i.facts)) return false;
  if (b.modules && !canView(i.role, b.modules)) return false;
  if (b.needs === 'approve' && i.role && !i.role.canApprove) return false;
  if (b.needs === 'signOff' && i.role && !i.role.canSignOff) return false;
  return true;
}

/** The whole list for one person, in order. Company-hidden items are dropped for everyone except the Administrator, who sees them marked. */
export function buildChecklist(i: Inputs): Item[] {
  const over = new Map(i.overrides.map((o) => [o.key, o]));
  const mine = new Set(i.hiddenByMe);
  const month = previousMonth(i.today).period;
  const tickFor = (key: string, scope: Scope, period: Period) => {
    const p = periodKey(period, i.today);
    return i.ticks.find((t) => t.key === key && t.period === p && (scope === 'company' ? t.userId === null : t.userId === i.userId));
  };
  const out: Item[] = [];
  BUILT_IN.forEach((b, n) => {
    if (!visibleTo(b, i)) return;
    const o = over.get(b.key);
    const auto = b.auto ? b.auto(i.facts) : false;
    const tick = tickFor(b.key, b.scope, b.period);
    out.push({
      key: b.key, area: b.area, scope: b.scope, period: b.period, custom: false, go: b.go,
      title: o?.title ?? null, titleAr: o?.titleAr ?? null, help: o?.help ?? null, helpAr: o?.helpAr ?? null,
      done: auto || !!tick, how: auto ? 'auto' : tick ? 'manual' : null, doneAt: auto ? null : tick?.at ?? null,
      forMonth: b.period === 'month' ? month : null, hiddenByMe: mine.has(b.key), hiddenForCompany: !!o?.hidden, sort: o?.sort ?? (n + 1) * 10,
    });
  });
  for (const o of i.overrides) {
    if (!o.isCustom || !o.area) continue;
    const tick = tickFor(o.key, o.scope, 'once');
    out.push({
      key: o.key, area: o.area, scope: o.scope, period: 'once', custom: true,
      go: o.goModule ? { module: o.goModule, ...(o.goSub ? { sub: o.goSub } : {}) } : null,
      title: o.title, titleAr: o.titleAr, help: o.help, helpAr: o.helpAr,
      done: !!tick, how: tick ? 'manual' : null, doneAt: tick?.at ?? null, forMonth: null,
      hiddenByMe: mine.has(o.key), hiddenForCompany: o.hidden, sort: o.sort ?? 1000,
    });
  }
  return out
    .filter((x) => i.isAdmin || !x.hiddenForCompany)
    .sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || a.sort - b.sort || a.key.localeCompare(b.key));
}

/** One item as the Administrator edits it: the definition only, with no figures or ticks from the books (an Administrator never sees the books). */
export interface SetupItem {
  key: string; area: Area; scope: Scope; custom: boolean; adminOnly: boolean; go: Go | null;
  title: string | null; titleAr: string | null; help: string | null; helpAr: string | null; hiddenForCompany: boolean; sort: number;
}
export function setupList(overrides: Override[]): SetupItem[] {
  const over = new Map(overrides.map((o) => [o.key, o]));
  const out: SetupItem[] = BUILT_IN.map((b, n) => {
    const o = over.get(b.key);
    return { key: b.key, area: b.area, scope: b.scope, custom: false, adminOnly: !!b.adminOnly, go: b.go, title: o?.title ?? null, titleAr: o?.titleAr ?? null,
      help: o?.help ?? null, helpAr: o?.helpAr ?? null, hiddenForCompany: !!o?.hidden, sort: o?.sort ?? (n + 1) * 10 };
  });
  for (const o of overrides) {
    if (!o.isCustom || !o.area) continue;
    out.push({ key: o.key, area: o.area, scope: o.scope, custom: true, adminOnly: false, go: o.goModule ? { module: o.goModule, ...(o.goSub ? { sub: o.goSub } : {}) } : null,
      title: o.title, titleAr: o.titleAr, help: o.help, helpAr: o.helpAr, hiddenForCompany: o.hidden, sort: o.sort ?? 1000 });
  }
  return out.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || a.sort - b.sort || a.key.localeCompare(b.key));
}

/** The button's numbers: Set up and Month end items that are shown to this person (daily items start afresh every day, so they are not counted). */
export function progress(items: Item[]): { done: number; total: number; open: number } {
  const counted = items.filter((x) => x.area !== 'daily' && !x.hiddenByMe && !x.hiddenForCompany);
  const done = counted.filter((x) => x.done).length;
  return { done, total: counted.length, open: counted.length - done };
}

// ---------------------------------------------------------------- what the Administrator may send
export type Cleaned<T> = { ok: true; value: T } | { ok: false; problem: string };
const text = (v: unknown, max: number): string | null | undefined | 'bad' => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return 'bad';
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? 'bad' : s;
};

export interface ItemInput { key?: string; area?: Area; scope?: Scope; title?: string | null; titleAr?: string | null; help?: string | null; helpAr?: string | null; goModule?: string | null; goSub?: string | null; hidden?: boolean }

/** Checks what the Administrator sends for one item. Anything not on the allowed lists is refused rather than dropped. */
export function cleanItem(raw: unknown, create: boolean): Cleaned<ItemInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'body' };
  const r = raw as Record<string, unknown>;
  const v: ItemInput = {};
  if (r.key !== undefined) { if (typeof r.key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(r.key)) return { ok: false, problem: 'key' }; v.key = r.key; }
  if (r.area !== undefined) { if (!AREAS.includes(r.area as Area)) return { ok: false, problem: 'area' }; v.area = r.area as Area; }
  if (r.scope !== undefined) { if (r.scope !== 'company' && r.scope !== 'user') return { ok: false, problem: 'scope' }; v.scope = r.scope; }
  for (const [name, max] of [['title', 120], ['titleAr', 120], ['help', 300], ['helpAr', 300]] as const) {
    const t = text(r[name], max);
    if (t === 'bad') return { ok: false, problem: name };
    if (t !== undefined) v[name] = t;
  }
  if (r.goModule !== undefined) {
    if (r.goModule !== null && !GO_MODULES.includes(r.goModule as never)) return { ok: false, problem: 'goModule' };
    v.goModule = r.goModule as string | null;
  }
  if (r.goSub !== undefined) {
    if (r.goSub !== null && (typeof r.goSub !== 'string' || !/^[a-z][a-z0-9-]{1,59}$/.test(r.goSub))) return { ok: false, problem: 'goSub' };
    v.goSub = r.goSub as string | null;
  }
  if (r.hidden !== undefined) { if (typeof r.hidden !== 'boolean') return { ok: false, problem: 'hidden' }; v.hidden = r.hidden; }
  if (create && (!v.area || !v.title)) return { ok: false, problem: v.area ? 'title' : 'area' };
  if (v.goSub && !v.goModule && v.goModule !== undefined) return { ok: false, problem: 'goSub' };
  return { ok: true, value: v };
}

/** A new custom item's key: letters and digits only, never a built-in's. */
export const newKey = (random: string) => `c_${random.replace(/[^a-f0-9]/g, '').slice(0, 12)}`;
