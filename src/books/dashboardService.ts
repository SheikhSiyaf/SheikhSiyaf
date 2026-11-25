// The client home page as a dashboard: which widgets a person gets, the layout that applies (their own, their role's default, the company's,
// the built-in one), saving them, the Administrator's defaults, and the figures of each widget. Every figure comes from posted entries by the
// same functions the standard reports use (profitAndLoss, aged, vatReturn, stockValue...), so a widget and its report cannot disagree.
// Row-level security keeps companies and people apart; the checks here decide which widgets a role may see.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { fyStart, periodsFor, profitAndLoss, vatReturn } from './reportsService.js';
import { aged } from './documentsService.js';
import { stockValue } from './inventoryService.js';
import {
  builtInLayout, chooseLayout, cleanLayout, defOf, drillTarget, filterLayout, rangeFor, visibleWidgets, WIDGETS,
  type LayoutDoc, type Range, type Role, type WidgetDef,
} from './dashboardRules.js';

const bad = (key = 'err.dashInput') => new HttpError(400, 'That change to the home page is not allowed.', key);
const notFound = () => new HttpError(404, 'Not found.', 'err.notFound');

async function role(db: Db, companyId: string): Promise<Role | null> {
  const r = (await db.query('SELECT permissions FROM app_client_role($1)', [companyId])).rows[0];
  return r ? { permissions: r.permissions ?? {} } : null;
}
async function clock(db: Db, at?: Date) {
  return (await db.query(`SELECT ((coalesce($1::timestamptz, now())) AT TIME ZONE 'Asia/Riyadh')::date::text AS today, app_user_id() AS uid, app_is_admin() AS admin`, [at ?? null])).rows[0] as { today: string; uid: string; admin: boolean };
}
const modulesOf = async (db: Db, companyId: string): Promise<string[]> => (await db.query('SELECT modules FROM companies WHERE id = $1', [companyId])).rows[0]?.modules ?? [];

/** The widgets this person may see in this company. */
async function visibleFor(db: Db, companyId: string): Promise<WidgetDef[]> {
  return visibleWidgets(await role(db, companyId), await modulesOf(db, companyId));
}

async function readDoc(db: Db, companyId: string, where: string, params: unknown[]): Promise<LayoutDoc | null> {
  const r = (await db.query(`SELECT layout FROM dashboard_layouts WHERE company_id = $1 AND ${where}`, [companyId, ...params])).rows[0];
  if (!r) return null;
  const c = cleanLayout(r.layout);   // a stored document that no longer passes the rules (an old version) is ignored, never shown
  return c.ok ? c.value : null;
}

export interface CatalogEntry { key: string; sizes: string[]; defaultSize: string; charts: string[]; defaultChart: string; usesPeriod: boolean; client: boolean }
const entry = (d: WidgetDef): CatalogEntry => ({ key: d.key, sizes: d.sizes, defaultSize: d.defaultSize, charts: d.charts, defaultChart: d.defaultChart, usesPeriod: d.usesPeriod, client: !!d.client });

export interface MyDashboard { layout: LayoutDoc; source: 'user' | 'role' | 'company' | 'default'; catalog: CatalogEntry[]; today: string; currency: string }

/** The layout this person sees. Widgets they can no longer see are dropped silently. */
export async function myDashboard(db: Db, companyId: string, at?: Date): Promise<MyDashboard> {
  const c = await clock(db, at);
  const visible = await visibleFor(db, companyId);
  const roleId = (await db.query('SELECT dashboard_my_role($1) AS id', [companyId])).rows[0].id as string | null;
  const [mine, byRole, company] = await Promise.all([
    readDoc(db, companyId, `scope = 'user' AND user_id = $2`, [c.uid]),
    roleId ? readDoc(db, companyId, `scope = 'role' AND client_role_id = $2`, [roleId]) : Promise.resolve(null),
    readDoc(db, companyId, `scope = 'company'`, []),
  ]);
  const chosen = chooseLayout({ mine, role: byRole, company });
  const doc = chosen.doc ?? builtInLayout(visible);
  const currency = (await db.query('SELECT currency FROM companies WHERE id = $1', [companyId])).rows[0].currency as string;
  return { layout: filterLayout(doc, visible), source: chosen.source, catalog: visible.map(entry), today: c.today, currency };
}

/** Saves the person's own layout. A widget they cannot see is refused (they could not have added it from the gallery). */
export async function saveMine(db: Db, companyId: string, raw: unknown): Promise<void> {
  const visible = await visibleFor(db, companyId);
  const c = cleanLayout(raw, new Set(visible.map((v) => v.key)));
  if (!c.ok) throw bad();
  const uid = (await db.query('SELECT app_user_id() AS u')).rows[0].u as string;
  await db.query(
    `INSERT INTO dashboard_layouts (company_id, scope, user_id, layout) VALUES ($1, 'user', $2, $3::jsonb)
     ON CONFLICT (company_id, user_id) WHERE scope = 'user' DO UPDATE SET layout = EXCLUDED.layout`, [companyId, uid, JSON.stringify(c.value)]);
}

/** "Reset to default": the person's own layout is removed, so the role's or the company's default applies again. */
export async function resetMine(db: Db, companyId: string): Promise<void> {
  await db.query(`DELETE FROM dashboard_layouts WHERE company_id = $1 AND scope = 'user' AND user_id = app_user_id()`, [companyId]);
}

// ---------------------------------------------------------------- the Administrator's defaults (no figures from the books anywhere here)
async function requireAdmin(db: Db): Promise<void> {
  if (!(await db.query('SELECT app_is_admin() AS a')).rows[0].a) throw new HttpError(403, 'Only the company Administrator can set the default home page.', 'err.dashAdmin');
}

export async function defaultsFor(db: Db, companyId: string) {
  await requireAdmin(db);
  const company = await readDoc(db, companyId, `scope = 'company'`, []);
  const roles = (await db.query(
    `SELECT r.id, r.name, r.name_ar AS "nameAr" FROM client_roles r JOIN companies c ON c.firm_id = r.firm_id WHERE c.id = $1 AND r.status = 'active' ORDER BY r.name`, [companyId])).rows as { id: string; name: string; nameAr: string | null }[];
  const out = [];
  for (const r of roles) out.push({ ...r, layout: await readDoc(db, companyId, `scope = 'role' AND client_role_id = $2`, [r.id]) });
  return { company, roles: out, catalog: WIDGETS.map(entry), builtIn: builtInLayout(WIDGETS) };
}

/** The Administrator sets (layout) or clears (layout null) the default for the company or for one role. Any known widget may be placed: each person's
 *  own role decides at read time which of them they see. */
export async function saveDefault(db: Db, companyId: string, body: { scope?: unknown; roleId?: unknown; layout?: unknown }): Promise<void> {
  await requireAdmin(db);
  if (body.scope !== 'company' && body.scope !== 'role') throw bad();
  if (body.scope === 'role' && (typeof body.roleId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.roleId))) throw bad();
  const roleId = body.scope === 'role' ? (body.roleId as string) : null;
  if (body.layout === null) {
    await db.query(`DELETE FROM dashboard_layouts WHERE company_id = $1 AND scope = $2 AND client_role_id IS NOT DISTINCT FROM $3`, [companyId, body.scope, roleId]);
    return;
  }
  const c = cleanLayout(body.layout);
  if (!c.ok) throw bad();
  if (roleId && !(await db.query(`SELECT 1 FROM client_roles r JOIN companies co ON co.firm_id = r.firm_id WHERE r.id = $1 AND co.id = $2`, [roleId, companyId])).rows[0]) throw notFound();
  if (body.scope === 'company') {
    await db.query(`INSERT INTO dashboard_layouts (company_id, scope, layout) VALUES ($1, 'company', $2::jsonb)
      ON CONFLICT (company_id) WHERE scope = 'company' DO UPDATE SET layout = EXCLUDED.layout`, [companyId, JSON.stringify(c.value)]);
  } else {
    await db.query(`INSERT INTO dashboard_layouts (company_id, scope, client_role_id, layout) VALUES ($1, 'role', $2, $3::jsonb)
      ON CONFLICT (company_id, client_role_id) WHERE scope = 'role' DO UPDATE SET layout = EXCLUDED.layout`, [companyId, roleId, JSON.stringify(c.value)]);
  }
}

// ---------------------------------------------------------------- the figures
export interface WidgetRequest { id?: unknown; type?: unknown; period?: unknown }
export interface WidgetResult { id: string; type: string; state: 'ok' | 'empty' | 'forbidden' | 'error'; empty?: string; from?: string; to?: string; data?: unknown; drill?: ReturnType<typeof drillTarget>; foreign?: boolean }

const add = (a: string, b: string) => fromMinor(toMinor(a) + toMinor(b));
const sub = (a: string, b: string) => fromMinor(toMinor(a) - toMinor(b));

/** Whether any open invoice or bill is written in another currency (its amount is shown converted to the company's currency, with a note). */
async function hasForeign(db: Db, companyId: string, type: 'invoice' | 'bill'): Promise<boolean> {
  return (await db.query(
    `SELECT EXISTS (SELECT 1 FROM documents d WHERE d.company_id = $1 AND d.type = $2 AND d.status = 'issued' AND d.currency IS NOT NULL AND document_amount_due(d.id) <> 0) AS f`, [companyId, type])).rows[0].f;
}

async function cashAt(db: Db, companyId: string, asOf: string): Promise<string> {
  return (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.is_bank AND e.entry_date <= $2`, [companyId, asOf])).rows[0].v;
}
const dayBefore = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1)).toISOString().slice(0, 10);

async function figures(db: Db, companyId: string, def: WidgetDef, range: Range): Promise<{ data?: unknown; empty?: string; foreign?: boolean }> {
  const hasEntries = async () => (await db.query('SELECT EXISTS (SELECT 1 FROM journal_entries WHERE company_id = $1) AS x', [companyId])).rows[0].x as boolean;
  switch (def.key) {
    case 'cash': {
      if (!(await hasEntries())) return { empty: 'no_entries' };
      const balance = await cashAt(db, companyId, range.to), opening = await cashAt(db, companyId, dayBefore(range.from));
      return { data: { asOf: range.to, balance, opening, change: sub(balance, opening) } };
    }
    case 'receivables': case 'payables': {
      const side = def.key === 'receivables' ? 'sales' : 'purchases';
      const r = await aged(db, companyId, side, range.to);
      const total = (k: string) => r.rows.reduce((s, x) => s + toMinor((x as unknown as Record<string, string>)[k]!), 0n);
      const buckets = { current: fromMinor(total('current')), d1_30: fromMinor(total('d1_30')), d31_60: fromMinor(total('d31_60')), d61_90: fromMinor(total('d61_90')), d90_plus: fromMinor(total('d90_plus')) };
      const all = fromMinor(total('total'));
      const foreign = await hasForeign(db, companyId, side === 'sales' ? 'invoice' : 'bill');
      if (toMinor(all) === 0n) {
        const ever = (await db.query(`SELECT EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND type = $2 AND status = 'issued') AS x`, [companyId, side === 'sales' ? 'invoice' : 'bill'])).rows[0].x;
        return { empty: ever ? 'nothing_open' : (side === 'sales' ? 'no_invoices' : 'no_bills'), foreign };
      }
      return { data: { asOf: range.to, total: all, buckets, contacts: r.rows.length }, foreign };
    }
    case 'net_profit': {
      const [cur, prev] = periodsFor(range.from, range.to, 'previous');
      const a = await profitAndLoss(db, companyId, cur!.from, cur!.to), b = await profitAndLoss(db, companyId, prev!.from, prev!.to);
      if (!(await hasEntries())) return { empty: 'no_entries' };
      return { data: { from: cur!.from, to: cur!.to, revenue: a.revenue, netProfit: a.netProfit, previous: { from: prev!.from, to: prev!.to, revenue: b.revenue, netProfit: b.netProfit } } };
    }
    case 'income_expense': {
      if (!(await hasEntries())) return { empty: 'no_entries' };
      const cols = periodsFor(range.from, range.to, 'monthly');
      const out = [];
      for (const p of cols) {
        const x = await profitAndLoss(db, companyId, p.from, p.to);
        out.push({ from: p.from, to: p.to, revenue: x.revenue, expenses: add(x.costOfSales, x.indirectExpenses), netProfit: x.netProfit });
      }
      return { data: { columns: out } };
    }
    case 'expenses_by_category': {
      const x = await profitAndLoss(db, companyId, range.from, range.to);
      const rows = x.lines.filter((l) => l.group === 'cost_of_sales' || l.group === 'indirect_expense').sort((a, b) => (toMinor(b.amount) > toMinor(a.amount) ? 1 : toMinor(b.amount) < toMinor(a.amount) ? -1 : a.name.localeCompare(b.name)));
      if (!rows.length) return { empty: (await hasEntries()) ? 'no_expenses' : 'no_entries' };
      const top = rows.slice(0, 8);
      const rest = rows.slice(8).reduce((s, r) => s + toMinor(r.amount), 0n);
      return { data: { from: range.from, to: range.to, total: fromMinor(rows.reduce((s, r) => s + toMinor(r.amount), 0n)), rows: top.map((r) => ({ accountId: r.accountId, name: r.name, nameAr: r.nameAr, amount: r.amount })), other: fromMinor(rest) } };
    }
    case 'vat_due': {
      const reg = (await db.query('SELECT vat_status::text AS s FROM companies WHERE id = $1', [companyId])).rows[0].s;
      if (reg !== 'registered') return { empty: 'not_registered' };
      const v = await vatReturn(db, companyId, range.from, range.to);
      return { data: { from: v.from, to: v.to, outputVat: v.outputVat, inputVat: v.inputVat, netVat: v.netVat, agreesWithBooks: v.agreesWithBooks } };
    }
    case 'overdue_invoices': case 'bills_due': {
      const sales = def.key === 'overdue_invoices';
      const rows = (await db.query(
        `SELECT d.id, d.number, coalesce(c.name, d.payee) AS contact, c.name_ar AS "contactAr", d.due_date::text AS due, document_amount_due(d.id)::numeric(18,2)::text AS amount
         FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
         WHERE d.company_id = $1 AND d.type = $2 AND d.status = 'issued' AND d.due_date IS NOT NULL AND d.due_date < $3 AND document_amount_due(d.id) <> 0 ORDER BY d.due_date, d.number`,
        [companyId, sales ? 'invoice' : 'bill', range.to])).rows as { id: string; number: string; contact: string | null; contactAr: string | null; due: string; amount: string }[];
      const foreign = await hasForeign(db, companyId, sales ? 'invoice' : 'bill');
      if (!rows.length) {
        const ever = (await db.query(`SELECT EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND type = $2 AND status = 'issued') AS x`, [companyId, sales ? 'invoice' : 'bill'])).rows[0].x;
        return { empty: ever ? 'nothing_overdue' : (sales ? 'no_invoices' : 'no_bills'), foreign };
      }
      return { data: { asOf: range.to, count: rows.length, total: fromMinor(rows.reduce((s, r) => s + toMinor(r.amount), 0n)), rows: rows.slice(0, 5) }, foreign };
    }
    case 'stock_value': {
      const s = await stockValue(db, companyId);
      if (!s.items.length) return { empty: 'no_items' };
      return { data: { total: s.total, booksValue: s.booksValue, difference: s.difference } };
    }
    case 'books_status': {
      const t = range.to;
      const r = (await db.query(
        `SELECT count(*)::int AS entries, count(*) FILTER (WHERE entry_date >= $2)::int AS "entriesThisMonth" FROM journal_entries WHERE company_id = $1`, [companyId, `${t.slice(0, 7)}-01`])).rows[0];
      const lock = (await db.query(`SELECT max(end_date)::text AS v FROM periods WHERE company_id = $1 AND locked_at IS NOT NULL`, [companyId])).rows[0].v as string | null;
      return { data: { entries: r.entries, entriesThisMonth: r.entriesThisMonth, lockedUpTo: lock } };
    }
    default: return { data: {} };
  }
}

/** The figures for the widgets a screen asks for. A widget the person may not see comes back as "forbidden" with no figures (the screen drops it);
 *  a bad period or type is refused. */
export async function widgetData(db: Db, companyId: string, body: { period?: unknown; widgets?: unknown }, at?: Date): Promise<{ results: WidgetResult[]; today: string }> {
  const cl = await clock(db, at);
  const shared = cleanLayout({ period: body.period ?? { kind: 'this_month' }, widgets: [] });
  if (!shared.ok) throw bad();
  if (!Array.isArray(body.widgets) || body.widgets.length > 24) throw bad();
  const visible = await visibleFor(db, companyId);
  const fy = await fyStart(db, companyId, cl.today);
  const results: WidgetResult[] = [];
  const seen = new Set<string>();
  for (const raw of body.widgets as WidgetRequest[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.type !== 'string' || seen.has(raw.id)) throw bad();
    seen.add(raw.id);
    const def = defOf(raw.type);
    if (!def) throw bad();
    if (!visible.some((v) => v.key === def.key)) { results.push({ id: raw.id, type: def.key, state: 'forbidden' }); continue; }
    const checked = cleanLayout({ widgets: [{ id: raw.id, type: def.key, size: def.defaultSize, ...(raw.period ? { period: raw.period } : {}) }] });
    if (!checked.ok) throw bad();
    const range = rangeFor(checked.value.widgets[0]!, shared.value.period, cl.today, fy);
    if (!range) throw bad();
    const drill = drillTarget(def, range);
    if (def.client) { results.push({ id: raw.id, type: def.key, state: 'ok', from: range.from, to: range.to, data: {}, drill }); continue; }
    const f = await figures(db, companyId, def, range);
    results.push({ id: raw.id, type: def.key, state: f.empty ? 'empty' : 'ok', ...(f.empty ? { empty: f.empty } : { data: f.data }), from: range.from, to: range.to, drill, ...(f.foreign ? { foreign: true } : {}) });
  }
  return { results, today: cl.today };
}
