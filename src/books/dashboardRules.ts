// The client home page as a dashboard of widgets: which widgets exist, who may see each, what a saved layout may contain, and the
// periods the figures cover. Pure functions only (no database), tested on their own in test/dashboard.test.ts.
// The words and the pictures live in the web app; the server sends figures only, from posted entries, by the same functions the
// standard reports use, so a widget and its report can never disagree.
import { accessTo, type AccessLevel } from './modules.js';

export type Size = 'small' | 'wide' | 'tall' | 'large';
export const SIZES: Size[] = ['small', 'wide', 'tall', 'large'];
export type PeriodKind = 'this_month' | 'last_month' | 'this_quarter' | 'this_fy' | 'custom';
export const PERIOD_KINDS: PeriodKind[] = ['this_month', 'last_month', 'this_quarter', 'this_fy', 'custom'];
export interface PeriodSpec { kind: PeriodKind; from?: string; to?: string }
export interface Range { from: string; to: string }

/** Where "View report" leads, and which filters travel with it. */
export interface Drill { module: string; sub: string; item?: string; extra?: string; filter: 'asOf' | 'range' | 'none' }

export interface WidgetDef {
  key: string;
  /** needs at least View on one of these modules; none listed = every member of the company */
  modules?: string[];
  /** only when this optional module is switched on for the company */
  optional?: string;
  sizes: Size[]; defaultSize: Size;
  charts: string[]; defaultChart: string;
  /** whether the shared period changes what it shows (balances use the period's last day) */
  usesPeriod: boolean;
  drill: Drill;
  /** the screen works it out itself from an existing endpoint (deadlines) or from the person's role (shortcuts): the server sends no figures */
  client?: boolean;
}

const ALL: Size[] = ['small', 'wide', 'tall', 'large'];
export const WIDGETS: WidgetDef[] = [
  { key: 'cash', modules: ['Reports', 'Ledger', 'Bank'], sizes: ['small', 'wide'], defaultSize: 'small', charts: ['number'], defaultChart: 'number', usesPeriod: true, drill: { module: 'Reports', sub: 'trial-balance', filter: 'asOf' } },
  { key: 'receivables', modules: ['Sales'], sizes: ALL, defaultSize: 'small', charts: ['bars', 'table'], defaultChart: 'bars', usesPeriod: true, drill: { module: 'Reports', sub: 'aged-receivables', filter: 'asOf' } },
  { key: 'payables', modules: ['Purchases'], sizes: ALL, defaultSize: 'small', charts: ['bars', 'table'], defaultChart: 'bars', usesPeriod: true, drill: { module: 'Reports', sub: 'aged-payables', filter: 'asOf' } },
  { key: 'net_profit', modules: ['OwnerReports'], sizes: ['small', 'wide'], defaultSize: 'small', charts: ['number'], defaultChart: 'number', usesPeriod: true, drill: { module: 'Reports', sub: 'profit-and-loss', filter: 'range' } },
  { key: 'income_expense', modules: ['OwnerReports'], sizes: ['wide', 'large'], defaultSize: 'wide', charts: ['bar', 'line'], defaultChart: 'bar', usesPeriod: true, drill: { module: 'Reports', sub: 'profit-and-loss', filter: 'range' } },
  { key: 'expenses_by_category', modules: ['OwnerReports'], sizes: ALL, defaultSize: 'small', charts: ['bars', 'donut', 'table'], defaultChart: 'bars', usesPeriod: true, drill: { module: 'Reports', sub: 'profit-and-loss', filter: 'range' } },
  { key: 'vat_due', modules: ['Reports'], sizes: ['small', 'wide'], defaultSize: 'small', charts: ['number'], defaultChart: 'number', usesPeriod: true, drill: { module: 'Reports', sub: 'vat-return', filter: 'range' } },
  { key: 'overdue_invoices', modules: ['Sales'], sizes: ['wide', 'large', 'tall'], defaultSize: 'wide', charts: ['table'], defaultChart: 'table', usesPeriod: true, drill: { module: 'Sales', sub: 'invoices', item: '-', extra: 'overdue', filter: 'none' } },
  { key: 'bills_due', modules: ['Purchases'], sizes: ['wide', 'large', 'tall'], defaultSize: 'wide', charts: ['table'], defaultChart: 'table', usesPeriod: true, drill: { module: 'Purchases', sub: 'bills', item: '-', extra: 'overdue', filter: 'none' } },
  { key: 'stock_value', modules: ['Inventory'], optional: 'Inventory', sizes: ['small', 'wide'], defaultSize: 'small', charts: ['number'], defaultChart: 'number', usesPeriod: false, drill: { module: 'Inventory', sub: 'stock-value', filter: 'none' } },
  { key: 'books_status', modules: ['Reports', 'Ledger'], sizes: ['small', 'wide'], defaultSize: 'small', charts: ['number'], defaultChart: 'number', usesPeriod: false, drill: { module: 'Journal', sub: 'periods', filter: 'none' } },
  { key: 'deadlines', client: true, sizes: ['wide', 'large', 'tall', 'small'], defaultSize: 'wide', charts: ['list'], defaultChart: 'list', usesPeriod: false, drill: { module: 'Calendar', sub: 'upcoming', filter: 'none' } },
  { key: 'shortcuts', client: true, modules: ['Sales', 'Purchases', 'Expenses', 'Journal', 'Reports'], sizes: ['small', 'wide'], defaultSize: 'wide', charts: ['list'], defaultChart: 'list', usesPeriod: false, drill: { module: 'Home', sub: '', filter: 'none' } },
];
export const WIDGET_KEYS = new Set(WIDGETS.map((w) => w.key));
export const defOf = (type: string): WidgetDef | undefined => WIDGETS.find((w) => w.key === type);

// ---------------------------------------------------------------- who sees what
/** The caller's role. `null` = no client role (a firm's own staff): every module, the database still applies the rest. */
export interface Role { permissions: Record<string, string> }
const rank: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

/** The widgets this person may see: the module behind each must be switched on for the company and their role must reach at least View on it. */
export function visibleWidgets(role: Role | null, companyModules: string[]): WidgetDef[] {
  return WIDGETS.filter((w) => {
    if (w.optional && !companyModules.includes(w.optional)) return false;
    if (w.modules && role && !w.modules.some((m) => rank[accessTo(role.permissions, m)] >= 1)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- periods
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (d: unknown): d is string => {
  if (typeof d !== 'string' || !DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 10);
const MAX_CUSTOM_DAYS = 366 * 5;

/** The dates a period covers. `today` is the date in Riyadh; `fyStart` is the first day of the company's financial year that contains today.
 *  "This" periods run up to today, "last month" is the whole month before. A custom range must be real dates, in order, and at most five years. */
export function periodRange(spec: PeriodSpec, today: string, fyStart: string): Range | null {
  switch (spec.kind) {
    case 'this_month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': { const f = addMonths(`${today.slice(0, 7)}-01`, -1); return { from: f, to: addDays(`${today.slice(0, 7)}-01`, -1) }; }
    case 'this_fy': return { from: fyStart, to: today };
    case 'this_quarter': {
      const months = (+today.slice(0, 4) * 12 + +today.slice(5, 7)) - (+fyStart.slice(0, 4) * 12 + +fyStart.slice(5, 7));
      return { from: addMonths(fyStart, Math.floor(months / 3) * 3), to: today };
    }
    case 'custom': {
      if (!validDate(spec.from) || !validDate(spec.to) || spec.from > spec.to) return null;
      if ((Date.parse(spec.to) - Date.parse(spec.from)) / 86_400_000 > MAX_CUSTOM_DAYS) return null;
      return { from: spec.from, to: spec.to };
    }
  }
}

export type Cleaned<T> = { ok: true; value: T } | { ok: false; problem: string };

export function cleanPeriod(raw: unknown): Cleaned<PeriodSpec> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'period' };
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['kind', 'from', 'to'].includes(k))) return { ok: false, problem: 'period' };
  if (!PERIOD_KINDS.includes(r.kind as PeriodKind)) return { ok: false, problem: 'period' };
  if (r.kind === 'custom') {
    if (!validDate(r.from) || !validDate(r.to) || r.from > r.to || (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 > MAX_CUSTOM_DAYS) return { ok: false, problem: 'period' };
    return { ok: true, value: { kind: 'custom', from: r.from, to: r.to } };
  }
  if (r.from !== undefined || r.to !== undefined) return { ok: false, problem: 'period' };
  return { ok: true, value: { kind: r.kind as PeriodKind } };
}

// ---------------------------------------------------------------- layouts
export interface LayoutWidget { id: string; type: string; size: Size; title?: string; period?: PeriodSpec; chart?: string }
export interface LayoutDoc { period: PeriodSpec; widgets: LayoutWidget[] }
export const MAX_WIDGETS = 24;
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Checks a layout somebody sent. Anything not on the allowed lists is refused, not dropped, so a forged request shows up as an error.
 *  `allowed` limits the widget types (a person can only save widgets they can see); leave it out to allow every known type (the Administrator's defaults). */
export function cleanLayout(raw: unknown, allowed?: ReadonlySet<string>): Cleaned<LayoutDoc> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'body' };
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['period', 'widgets'].includes(k))) return { ok: false, problem: 'body' };
  const period = r.period === undefined ? { ok: true as const, value: { kind: 'this_month' as PeriodKind } } : cleanPeriod(r.period);
  if (!period.ok) return period;
  if (!Array.isArray(r.widgets) || r.widgets.length > MAX_WIDGETS) return { ok: false, problem: 'widgets' };
  const seen = new Set<string>();
  const widgets: LayoutWidget[] = [];
  for (const w of r.widgets) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return { ok: false, problem: 'widget' };
    const x = w as Record<string, unknown>;
    if (Object.keys(x).some((k) => !['id', 'type', 'size', 'title', 'period', 'chart'].includes(k))) return { ok: false, problem: 'widget' };
    if (typeof x.id !== 'string' || !ID.test(x.id) || seen.has(x.id)) return { ok: false, problem: 'id' };
    seen.add(x.id);
    const def = typeof x.type === 'string' ? defOf(x.type) : undefined;
    if (!def || (allowed && !allowed.has(def.key))) return { ok: false, problem: 'type' };
    if (!def.sizes.includes(x.size as Size)) return { ok: false, problem: 'size' };
    const out: LayoutWidget = { id: x.id, type: def.key, size: x.size as Size };
    if (x.title !== undefined && x.title !== null) {
      if (typeof x.title !== 'string') return { ok: false, problem: 'title' };
      const t = x.title.trim().replace(/\s+/g, ' ');
      if (t.length > 60) return { ok: false, problem: 'title' };
      if (t) out.title = t;
    }
    if (x.period !== undefined && x.period !== null) {
      if (!def.usesPeriod) return { ok: false, problem: 'period' };
      const p = cleanPeriod(x.period);
      if (!p.ok) return p;
      out.period = p.value;
    }
    if (x.chart !== undefined && x.chart !== null) {
      if (typeof x.chart !== 'string' || !def.charts.includes(x.chart)) return { ok: false, problem: 'chart' };
      out.chart = x.chart;
    }
    widgets.push(out);
  }
  return { ok: true, value: { period: period.value, widgets } };
}

/** What a person with no saved layout and no default sees: every widget they may see, in a sensible order. */
export function builtInLayout(visible: WidgetDef[]): LayoutDoc {
  const order = ['cash', 'receivables', 'payables', 'net_profit', 'income_expense', 'expenses_by_category', 'vat_due', 'stock_value', 'overdue_invoices', 'bills_due', 'deadlines', 'shortcuts', 'books_status'];
  const widgets = order.map((k) => visible.find((v) => v.key === k)).filter((d): d is WidgetDef => !!d).map((d) => ({ id: `d_${d.key}`, type: d.key, size: d.defaultSize }));
  return { period: { kind: 'this_month' }, widgets };
}

/** Drops widgets the person can no longer see (their role changed, a module was switched off). Silent, as agreed. */
export function filterLayout(doc: LayoutDoc, visible: WidgetDef[]): LayoutDoc {
  const keys = new Set(visible.map((v) => v.key));
  return { ...doc, widgets: doc.widgets.filter((w) => keys.has(w.type)) };
}

/** The saved layout that applies: the person's own, else their role's default, else the company's, else the built-in one. */
export function chooseLayout(sources: { mine?: LayoutDoc | null; role?: LayoutDoc | null; company?: LayoutDoc | null }): { source: 'user' | 'role' | 'company' | 'default'; doc: LayoutDoc | null } {
  if (sources.mine) return { source: 'user', doc: sources.mine };
  if (sources.role) return { source: 'role', doc: sources.role };
  if (sources.company) return { source: 'company', doc: sources.company };
  return { source: 'default', doc: null };
}

/** The period one widget covers: its own, or the shared one. */
export function rangeFor(w: Pick<LayoutWidget, 'period'>, shared: PeriodSpec, today: string, fyStart: string): Range | null {
  return periodRange(w.period ?? shared, today, fyStart);
}

/** The path and filters of "View report" for a widget over a range. */
export function drillTarget(def: WidgetDef, range: Range): { module: string; sub: string; item?: string; extra?: string; query: Record<string, string> } {
  const { module, sub, item, extra, filter } = def.drill;
  return { module, sub, ...(item ? { item } : {}), ...(extra ? { extra } : {}), query: filter === 'asOf' ? { asOf: range.to } : filter === 'range' ? { from: range.from, to: range.to } : {} };
}
