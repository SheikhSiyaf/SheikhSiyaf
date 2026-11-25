// The client home page as a dashboard: the rules (periods, what a saved layout may hold, who sees which widget), then the figures
// against the standard reports (they must agree to the cent), then the real thing through the API with throwaway customers:
// roles limit the widgets on the server, layouts are per person with defaults for roles and the company, only the company's
// Administrator sets defaults, and nobody reaches another company's layouts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import * as D from '../src/books/dashboardService.js';
import * as S from '../src/books/documentsService.js';
import * as R from '../src/books/reportsService.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { postEntry } from '../src/ledger/ledger.js';
import { fromMinor, toMinor } from '../src/money.js';
import {
  WIDGETS, builtInLayout, chooseLayout, cleanLayout, cleanPeriod, drillTarget, filterLayout, periodRange, validDate, visibleWidgets, defOf, rangeFor,
  type LayoutDoc, type Size,
} from '../src/books/dashboardRules.js';

const PW = 'pw-123456';
const doc = (widgets: LayoutDoc['widgets'], period: LayoutDoc['period'] = { kind: 'this_month' }): LayoutDoc => ({ period, widgets });
const w = (id: string, type: string, size: Size = 'small', extra: object = {}) => ({ id, type, size, ...extra });
const keysOf = (l: LayoutDoc) => l.widgets.map((x) => x.type);

describe('Periods', () => {
  it('this month runs to today and last month is the whole month before, across a year end', () => {
    expect(periodRange({ kind: 'this_month' }, '2026-11-25', '2026-01-01')).toEqual({ from: '2026-11-01', to: '2026-11-25' });
    expect(periodRange({ kind: 'last_month' }, '2026-11-25', '2026-01-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange({ kind: 'last_month' }, '2027-01-03', '2027-01-01')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodRange({ kind: 'last_month' }, '2024-03-10', '2024-01-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
  it('a quarter and the year follow the company\'s own financial year, not the calendar', () => {
    // a financial year that starts on 1 October: quarters start 1 Oct, 1 Jan, 1 Apr, 1 Jul
    expect(periodRange({ kind: 'this_quarter' }, '2026-11-25', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-11-25' });
    expect(periodRange({ kind: 'this_quarter' }, '2026-02-14', '2025-10-01')).toEqual({ from: '2026-01-01', to: '2026-02-14' });
    expect(periodRange({ kind: 'this_quarter' }, '2026-07-01', '2025-10-01')).toEqual({ from: '2026-07-01', to: '2026-07-01' });
    expect(periodRange({ kind: 'this_fy' }, '2026-02-14', '2025-10-01')).toEqual({ from: '2025-10-01', to: '2026-02-14' });
    // a calendar financial year
    expect(periodRange({ kind: 'this_quarter' }, '2026-05-02', '2026-01-01')).toEqual({ from: '2026-04-01', to: '2026-05-02' });
  });
  it('a custom range must be real dates in order and at most five years', () => {
    expect(periodRange({ kind: 'custom', from: '2026-03-01', to: '2026-03-31' }, '2026-11-25', '2026-01-01')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    for (const p of [{ kind: 'custom' as const }, { kind: 'custom' as const, from: '2026-03-31', to: '2026-03-01' }, { kind: 'custom' as const, from: '2026-02-30', to: '2026-03-01' },
      { kind: 'custom' as const, from: '2015-01-01', to: '2026-01-01' }, { kind: 'custom' as const, from: 'x', to: 'y' }]) {
      expect(periodRange(p, '2026-11-25', '2026-01-01'), JSON.stringify(p)).toBeNull();
    }
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2024-02-29')).toBe(true);
  });
  it('refuses a period with anything extra in it', () => {
    expect(cleanPeriod({ kind: 'this_month' }).ok).toBe(true);
    for (const p of [{ kind: 'forever' }, { kind: 'this_month', from: '2026-01-01' }, { kind: 'this_month', evil: 1 }, null, 'this_month', []]) expect(cleanPeriod(p).ok, JSON.stringify(p)).toBe(false);
  });
});

describe('Who sees which widget', () => {
  const role = (permissions: Record<string, string>) => ({ permissions });
  const keys = (r: ReturnType<typeof role> | null, modules: string[] = []) => visibleWidgets(r, modules).map((x) => x.key);
  it('a role sees only the widgets of modules it can at least view; a firm member without a client role sees them all', () => {
    expect(keys(null, ['Inventory'])).toEqual(WIDGETS.map((x) => x.key));
    const sales = keys(role({ Sales: 'view' }));
    expect(sales).toEqual(expect.arrayContaining(['receivables', 'overdue_invoices', 'shortcuts', 'deadlines']));
    expect(sales).not.toEqual(expect.arrayContaining(['cash']));
    for (const k of ['cash', 'payables', 'net_profit', 'income_expense', 'expenses_by_category', 'vat_due', 'bills_due', 'books_status', 'stock_value']) expect(sales, k).not.toContain(k);
    expect(keys(role({ Sales: 'none', Purchases: 'edit' }))).toContain('bills_due');
    expect(keys(role({ Sales: 'none', Purchases: 'edit' }))).not.toContain('receivables');
  });
  it('the owner reports (profit, income and expense) need their own module, so a finance title without it does not get them', () => {
    const fin = keys(role({ Sales: 'edit', Purchases: 'edit', Reports: 'edit', Ledger: 'edit', Bank: 'edit' }));
    expect(fin).toEqual(expect.arrayContaining(['cash', 'vat_due', 'receivables', 'payables']));
    for (const k of ['net_profit', 'income_expense', 'expenses_by_category']) expect(fin, k).not.toContain(k);
    expect(keys(role({ OwnerReports: 'view' }))).toEqual(expect.arrayContaining(['net_profit', 'income_expense', 'expenses_by_category']));
  });
  it('a widget of an optional module needs that module switched on for the company as well as the role', () => {
    expect(keys(role({ Inventory: 'edit' }), [])).not.toContain('stock_value');
    expect(keys(role({ Inventory: 'edit' }), ['Inventory'])).toContain('stock_value');
    expect(keys(role({ Inventory: 'none' }), ['Inventory'])).not.toContain('stock_value');
    expect(keys(null, [])).not.toContain('stock_value');
  });
  it('widgets a person can no longer see are dropped from a saved layout, silently', () => {
    const saved = doc([w('a', 'cash'), w('b', 'receivables'), w('c', 'net_profit', 'small')]);
    const visible = visibleWidgets(role({ Sales: 'view' }), []);
    expect(keysOf(filterLayout(saved, visible))).toEqual(['receivables']);
  });
  it('the built-in layout holds only what the person can see, and every widget in it exists', () => {
    const l = builtInLayout(visibleWidgets(role({ Sales: 'view' }), []));
    expect(keysOf(l)).toEqual(['receivables', 'overdue_invoices', 'deadlines', 'shortcuts']);
    expect(builtInLayout(visibleWidgets(null, ['Inventory'])).widgets.length).toBe(WIDGETS.length);
    expect(new Set(l.widgets.map((x) => x.id)).size).toBe(l.widgets.length);
  });
  it('the layout that applies is the person\'s own, else their role\'s, else the company\'s, else the built-in one', () => {
    const a = doc([w('a', 'cash')]), b = doc([w('b', 'receivables')]), c = doc([w('c', 'payables')]);
    expect(chooseLayout({ mine: a, role: b, company: c })).toEqual({ source: 'user', doc: a });
    expect(chooseLayout({ role: b, company: c })).toEqual({ source: 'role', doc: b });
    expect(chooseLayout({ company: c })).toEqual({ source: 'company', doc: c });
    expect(chooseLayout({})).toEqual({ source: 'default', doc: null });
  });
});

describe('What a saved layout may hold', () => {
  const ok = (x: unknown, allowed?: Set<string>) => cleanLayout(x, allowed);
  it('accepts a normal layout and keeps only the allowed parts of it', () => {
    const r = ok({ period: { kind: 'this_fy' }, widgets: [w('w_1', 'income_expense', 'wide', { title: '  Sales   and costs ', chart: 'line', period: { kind: 'last_month' } }), w('w_2', 'cash')] });
    expect(r.ok && r.value.widgets[0]).toEqual({ id: 'w_1', type: 'income_expense', size: 'wide', title: 'Sales and costs', chart: 'line', period: { kind: 'last_month' } });
  });
  it('refuses, and never drops, anything outside the lists', () => {
    const bad: [string, unknown][] = [
      ['unknown type', { widgets: [w('a', 'hack')] }], ['size not allowed for that widget', { widgets: [w('a', 'cash', 'large')] }], ['unknown size', { widgets: [w('a', 'cash', 'huge' as Size)] }],
      ['chart not offered', { widgets: [w('a', 'cash', 'small', { chart: 'pie' })] }], ['duplicate ids', { widgets: [w('a', 'cash'), w('a', 'payables')] }], ['bad id', { widgets: [w('A B', 'cash')] }],
      ['too many', { widgets: Array.from({ length: 25 }, (_, i) => w(`w${i}`, 'cash')) }], ['long title', { widgets: [w('a', 'cash', 'small', { title: 'x'.repeat(61) })] }],
      ['title not text', { widgets: [w('a', 'cash', 'small', { title: 7 })] }], ['own period on a widget with none', { widgets: [w('a', 'deadlines', 'wide', { period: { kind: 'this_month' } })] }],
      ['extra key on a widget', { widgets: [{ ...w('a', 'cash'), x: 1 }] }], ['extra key', { widgets: [], evil: 1 }], ['bad period', { period: { kind: 'x' }, widgets: [] }],
      ['widgets not a list', { widgets: 'cash' }], ['not an object', 'cash'], ['array', []], ['null', null],
    ];
    for (const [name, x] of bad) expect(ok(x).ok, name).toBe(false);
  });
  it('a person can only save widgets they can see', () => {
    const allowed = new Set(['receivables']);
    expect(ok({ widgets: [w('a', 'receivables')] }, allowed).ok).toBe(true);
    expect(ok({ widgets: [w('a', 'net_profit')] }, allowed).ok).toBe(false);
  });
  it('every widget offers its own default size and chart, and a way to its report', () => {
    for (const d of WIDGETS) {
      expect(d.sizes, d.key).toContain(d.defaultSize);
      expect(d.charts, d.key).toContain(d.defaultChart);
      expect(d.drill.module, d.key).toBeTruthy();
      expect(defOf(d.key)).toBe(d);
    }
    expect(new Set(WIDGETS.map((d) => d.key)).size).toBe(WIDGETS.length);
  });
  it('"View report" carries the same dates the widget used', () => {
    const range = { from: '2026-03-01', to: '2026-03-31' };
    expect(drillTarget(defOf('income_expense')!, range)).toEqual({ module: 'Reports', sub: 'profit-and-loss', query: { from: '2026-03-01', to: '2026-03-31' } });
    expect(drillTarget(defOf('cash')!, range)).toEqual({ module: 'Reports', sub: 'trial-balance', query: { asOf: '2026-03-31' } });
    expect(drillTarget(defOf('receivables')!, range).sub).toBe('aged-receivables');
    expect(drillTarget(defOf('overdue_invoices')!, range)).toMatchObject({ module: 'Sales', sub: 'invoices', extra: 'overdue', query: {} });
    expect(rangeFor({ period: { kind: 'custom', from: '2026-01-01', to: '2026-01-31' } }, { kind: 'this_month' }, '2026-11-25', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(rangeFor({}, { kind: 'this_month' }, '2026-11-25', '2026-01-01')).toEqual({ from: '2026-11-01', to: '2026-11-25' });
  });
});

describe('The figures equal the standard reports', () => {
  let f: Fixture;
  let customer: string, supplier: string;
  const period = { kind: 'custom', from: '2026-03-01', to: '2026-05-31' } as const;
  const line = (over: object = {}) => ({ description: 'Steel beams', quantity: '2', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' as const, ...over });
  const data = async (type: string, p: unknown = period, user = () => f.partner) => (await as(user(), (db) => D.widgetData(db, f.a.id, { period: p, widgets: [{ id: 'x', type }] }, new Date('2026-06-10T09:00:00Z')))).results[0]!;
  beforeAll(async () => {
    f = await seed();
    await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
    for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
      await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [f.a.id, code, name, type]);
    }
    customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Steel', country: 'SA', vatNumber: '300000000000003', paymentTermsDays: 30 }));
    supplier = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isSupplier: true, name: 'Riyadh Wholesale' }));
    await as(f.staff, async (db) => {
      for (const [date, due, price] of [['2026-03-10', '2026-04-09', '1000.00'], ['2026-04-20', '2026-05-20', '333.33'], ['2026-05-25', '2026-06-24', '10.10']]) {
        const id = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: date!, dueDate: due, lines: [line({ unitPrice: price })] });
        await S.issueDocument(db, id);
      }
      const bill = await S.saveDraft(db, f.a.id, { type: 'bill', contactId: supplier, issueDate: '2026-03-12', dueDate: '2026-04-11', lines: [{ description: 'Stock', quantity: '10', unitPrice: '32.00', accountId: f.a.rent, vatCode: 'standard' }] });
      await S.issueDocument(db, bill);
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-04-05', memo: 'Cash sale', lines: [{ accountId: f.a.cash, debit: '575.00' }, { accountId: f.a.sales, credit: '500.00' }, { accountId: (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '2100'`, [f.a.id])).rows[0].id, credit: '75.00' }] });
      await postEntry(db, { companyId: f.a.id, entryDate: '2026-05-02', memo: 'Rent paid', lines: [{ accountId: f.a.rent, debit: '120.00' }, { accountId: f.a.cash, credit: '120.00' }] });
    });
  });

  it('cash is the bank and cash accounts as the trial balance has them, with the change over the period', async () => {
    const r = await data('cash');
    const tb = await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-05-31'));
    const bankIds = new Set((await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND is_bank`, [f.a.id])).rows.map((x) => x.id as string));
    const fromTb = tb.filter((x) => bankIds.has(x.accountId)).reduce((s, x) => s + toMinor(x.debit) - toMinor(x.credit), 0n);
    expect(r.state).toBe('ok');
    expect((r.data as { balance: string }).balance).toBe(fromMinor(fromTb));
    const opening = (await as(f.partner, (db) => trialBalance(db, f.a.id, '2026-02-28'))).filter((x) => bankIds.has(x.accountId)).reduce((s, x) => s + toMinor(x.debit) - toMinor(x.credit), 0n);
    expect((r.data as { opening: string; change: string }).opening).toBe(fromMinor(opening));
    expect((r.data as { change: string }).change).toBe(fromMinor(fromTb - opening));
  });

  it('receivables and payables are the aged reports: the same total and the same columns', async () => {
    for (const [type, side] of [['receivables', 'sales'], ['payables', 'purchases']] as const) {
      const r = await data(type);
      const aged = await as(f.partner, (db) => S.aged(db, f.a.id, side, '2026-05-31'));
      const sum = (k: string) => fromMinor(aged.rows.reduce((s, x) => s + toMinor((x as unknown as Record<string, string>)[k]!), 0n));
      const d = r.data as { total: string; buckets: Record<string, string> };
      expect(d.total, type).toBe(sum('total'));
      for (const b of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus']) expect(d.buckets[b], `${type} ${b}`).toBe(sum(b));
      expect(Object.values(d.buckets).reduce((s, v) => s + toMinor(v), 0n)).toBe(toMinor(d.total));   // the columns add up to the total
    }
  });

  it('profit, and income against expenses by month, are the profit and loss report', async () => {
    const pnl = await as(f.partner, (db) => R.profitAndLoss(db, f.a.id, '2026-03-01', '2026-05-31'));
    const np = (await data('net_profit')).data as { netProfit: string; revenue: string; previous: { netProfit: string } };
    expect(np.netProfit).toBe(pnl.netProfit);
    expect(np.revenue).toBe(pnl.revenue);
    const prev = R.periodsFor('2026-03-01', '2026-05-31', 'previous')[1]!;
    expect(np.previous.netProfit).toBe((await as(f.partner, (db) => R.profitAndLoss(db, f.a.id, prev.from, prev.to))).netProfit);
    const ie = (await data('income_expense')).data as { columns: { from: string; to: string; revenue: string; expenses: string; netProfit: string }[] };
    expect(ie.columns.map((c) => c.from)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
    expect(fromMinor(ie.columns.reduce((s, c) => s + toMinor(c.revenue), 0n))).toBe(pnl.revenue);
    expect(fromMinor(ie.columns.reduce((s, c) => s + toMinor(c.netProfit), 0n))).toBe(pnl.netProfit);
    for (const c of ie.columns) expect(c.netProfit).toBe(fromMinor(toMinor(c.revenue) - toMinor(c.expenses) + toMinor((await as(f.partner, (db) => R.profitAndLoss(db, f.a.id, c.from, c.to))).otherIncome)));
  });

  it('expenses by category are the expense lines of the profit and loss, largest first, and add up', async () => {
    const pnl = await as(f.partner, (db) => R.profitAndLoss(db, f.a.id, '2026-03-01', '2026-05-31'));
    const d = (await data('expenses_by_category')).data as { total: string; rows: { name: string; amount: string }[]; other: string };
    const exp = pnl.lines.filter((l) => l.group === 'cost_of_sales' || l.group === 'indirect_expense');
    expect(d.total).toBe(fromMinor(exp.reduce((s, l) => s + toMinor(l.amount), 0n)));
    expect(fromMinor(d.rows.reduce((s, r) => s + toMinor(r.amount), 0n) + toMinor(d.other))).toBe(d.total);
    const amounts = d.rows.map((r) => toMinor(r.amount));
    expect(amounts).toEqual([...amounts].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)));
  });

  it('VAT is the VAT return worksheet for the same dates', async () => {
    const v = await as(f.partner, (db) => R.vatReturn(db, f.a.id, '2026-03-01', '2026-05-31'));
    const d = (await data('vat_due')).data as { outputVat: string; inputVat: string; netVat: string; agreesWithBooks: boolean };
    expect(d).toMatchObject({ outputVat: v.outputVat, inputVat: v.inputVat, netVat: v.netVat, agreesWithBooks: v.agreesWithBooks });
  });

  it('overdue invoices are the open invoices past their due date on the last day of the period, oldest first, with their exact amounts', async () => {
    const d = (await data('overdue_invoices', { kind: 'custom', from: '2026-05-01', to: '2026-06-10' })).data as { count: number; total: string; rows: { number: string; due: string; amount: string }[] };
    expect(d.count).toBe(2);                                      // due 9 Apr and 20 May; the third is due 24 Jun
    expect(d.rows.map((r) => r.due)).toEqual(['2026-04-09', '2026-05-20']);
    expect(d.rows.map((r) => r.amount)).toEqual(['2300.00', '766.66']);   // 2 x 1000 + 15% VAT; 2 x 333.33 = 666.66 + 100.00 VAT (99.999 rounded)
    expect(d.total).toBe(fromMinor(d.rows.reduce((s, r) => s + toMinor(r.amount), 0n)));
    const bills = (await data('bills_due', { kind: 'custom', from: '2026-05-01', to: '2026-06-10' })).data as { count: number; rows: { amount: string }[] };
    expect(bills.count).toBe(1);
    expect(bills.rows[0]!.amount).toBe('368.00');
  });

  it('every widget keeps money as exact strings with two decimals', async () => {
    for (const type of ['cash', 'receivables', 'payables', 'net_profit', 'vat_due', 'overdue_invoices', 'bills_due', 'income_expense', 'expenses_by_category']) {
      const r = await data(type);
      const money = JSON.stringify(r.data).match(/"(?:balance|total|netProfit|revenue|outputVat|inputVat|netVat|amount|expenses|change|opening)":"[^"]*"/g) ?? [];
      for (const m of money) expect(m, `${type} ${m}`).toMatch(/:"-?\d+\.\d{2}"$/);
    }
  });

  it('a widget names the report it opens, with the same dates', async () => {
    const r = await data('net_profit');
    expect(r.drill).toEqual({ module: 'Reports', sub: 'profit-and-loss', query: { from: '2026-03-01', to: '2026-05-31' } });
    expect(r.from).toBe('2026-03-01');
    expect(r.to).toBe('2026-05-31');
  });

  it('a new company with nothing in it gets helpful empty states, not zeros dressed up as figures', async () => {
    const empty = (await seed()).b;
    const res = (await as(f.partner, (db) => D.widgetData(db, empty.id, { period: { kind: 'this_month' }, widgets: ['cash', 'receivables', 'payables', 'net_profit', 'income_expense', 'overdue_invoices', 'bills_due'].map((t) => ({ id: t, type: t })) }, new Date('2026-06-10T09:00:00Z')))).results;
    expect(res.every((x) => x.state === 'empty'), JSON.stringify(res.map((x) => [x.type, x.state, x.empty]))).toBe(true);
    expect(res.find((x) => x.type === 'receivables')!.empty).toBe('no_invoices');
    expect(res.find((x) => x.type === 'bills_due')!.empty).toBe('no_bills');
  });

  it('refuses a bad period, an unknown widget, a repeated id and more than 24 widgets', async () => {
    const call = (body: object) => as(f.partner, (db) => D.widgetData(db, f.a.id, body));
    await expect(call({ period: { kind: 'forever' }, widgets: [] })).rejects.toThrow(/not allowed/);
    await expect(call({ widgets: [{ id: 'a', type: 'hack' }] })).rejects.toThrow(/not allowed/);
    await expect(call({ widgets: [{ id: 'a', type: 'cash' }, { id: 'a', type: 'cash' }] })).rejects.toThrow(/not allowed/);
    await expect(call({ widgets: Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, type: 'cash' })) })).rejects.toThrow(/not allowed/);
    await expect(call({ widgets: [{ id: 'a', type: 'cash', period: { kind: 'custom', from: '2026-05-01', to: '2026-01-01' } }] })).rejects.toThrow(/not allowed/);
    await expect(call({ widgets: 'cash' })).rejects.toThrow(/not allowed/);
  });
});

describe('Through the API, with throwaway customers', () => {
  let server: FastifyInstance;
  let ownerCookie = '';
  let planId = '';
  const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  beforeAll(async () => {
    const f = await seed();
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'dashboard-secret', lockCacheMs: 0 });
    ownerCookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
    planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  });
  afterAll(async () => { await server?.close(); });

  const login = async (email: string) => String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  /** A company with an Administrator (not a member) and a Finance person who uses the books. */
  async function customer() {
    const s = stamp();
    const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name: `Dash ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh', modules: [] },
      users: [{ name: 'Admin', email: `a.${s}@dash.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `f.${s}@dash.example.com`, jobTitle: 'Finance' }] } });
    expect(res.statusCode, res.body).toBe(200);
    const firm = res.json().id as string;
    const users = (await owner.query('SELECT id, email FROM users WHERE firm_id = $1', [firm])).rows as { id: string; email: string }[];
    for (const u of users) await owner.query('UPDATE users SET password_hash = $1, password_set_at = now() WHERE id = $2', [await hashPassword(PW), u.id]);
    await server.inject({ method: 'POST', url: `/api/owner/tenants/${firm}/subscription`, headers: { cookie: ownerCookie }, payload: { planId, cycle: 'yearly', startOn: new Date().toISOString().slice(0, 10), trial: true } });
    const adm = users.find((u) => u.email.startsWith('a.'))!, fin = users.find((u) => u.email.startsWith('f.'))!;
    const companyId = (await owner.query('SELECT id FROM companies WHERE firm_id = $1', [firm])).rows[0].id as string;
    const roleId = (await owner.query('SELECT client_role_id AS r FROM memberships WHERE user_id = $1 AND company_id = $2', [fin.id, companyId])).rows[0].r as string;
    return { firm, companyId, roleId, admin: { id: adm.id, cookie: await login(adm.email) }, fin: { id: fin.id, cookie: await login(fin.email) } };
  }
  type Cust = Awaited<ReturnType<typeof customer>>;
  async function colleague(c: Cust) {
    const s = stamp();
    const id = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash, password_set_at) VALUES ($1, 'client', 'Colleague', $2, $3, now()) RETURNING id`, [c.firm, `c.${s}@dash.example.com`, await hashPassword(PW)])).rows[0].id as string;
    await owner.query(`INSERT INTO memberships (user_id, company_id, role, client_role_id) SELECT $1, company_id, role, client_role_id FROM memberships WHERE user_id = $2 AND company_id = $3`, [id, c.fin.id, c.companyId]);
    return { id, cookie: await login(`c.${s}@dash.example.com`) };
  }
  const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, payload: payload as never, headers: { cookie } });
  const get = async (cookie: string, c: Cust) => (await call(cookie, 'GET', `/api/companies/${c.companyId}/dashboard`)).json() as D.MyDashboard;
  const save = (cookie: string, c: Cust, layout: unknown) => call(cookie, 'POST', `/api/companies/${c.companyId}/dashboard`, layout);
  const setRole = (c: Cust, perms: Record<string, string>) => owner.query(`UPDATE client_roles SET permissions = $2::jsonb WHERE id = $1`, [c.roleId, JSON.stringify(perms)]);

  it('Finance gets the widgets of the modules the role allows, starting from the built-in layout', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit', Purchases: 'edit', Reports: 'edit', Bank: 'edit' });
    const d = await get(c.fin.cookie, c);
    expect(d.source).toBe('default');
    expect(d.currency).toBe('SAR');
    const k = keysOf(d.layout);
    expect(k).toEqual(expect.arrayContaining(['cash', 'receivables', 'payables', 'vat_due', 'overdue_invoices', 'bills_due', 'deadlines', 'shortcuts']));
    for (const x of ['net_profit', 'income_expense', 'expenses_by_category', 'stock_value']) expect(k, x).not.toContain(x);
    expect(d.catalog.map((x) => x.key)).toEqual(expect.arrayContaining(k));
  });

  it('a role sees only its own widgets, and widgets it lost drop out of a saved layout without a word', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit', Purchases: 'edit', Reports: 'edit', OwnerReports: 'edit', Bank: 'edit' });
    const layout = { period: { kind: 'this_fy' }, widgets: [w('w1', 'net_profit', 'wide'), w('w2', 'receivables'), w('w3', 'cash')] };
    expect((await save(c.fin.cookie, c, layout)).statusCode).toBe(200);
    expect(keysOf((await get(c.fin.cookie, c)).layout)).toEqual(['net_profit', 'receivables', 'cash']);
    await setRole(c, { Sales: 'view' });                       // the Administrator narrows the role
    const after = await get(c.fin.cookie, c);
    expect(keysOf(after.layout)).toEqual(['receivables']);     // dropped silently, the rest kept in order
    expect(after.source).toBe('user');
    await setRole(c, { Sales: 'edit', OwnerReports: 'edit' }); // and widens it again: the saved layout is whole again
    expect(keysOf((await get(c.fin.cookie, c)).layout)).toEqual(['net_profit', 'receivables']);
  });

  it('a person cannot save a widget they cannot see, and bad layouts are refused with nothing stored', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit' });
    for (const layout of [{ widgets: [w('a', 'net_profit')] }, { widgets: [w('a', 'cash')] }, { widgets: [w('a', 'receivables', 'huge' as Size)] }, { widgets: [w('a', 'nope')] },
      { widgets: Array.from({ length: 25 }, (_, i) => w(`w${i}`, 'receivables')) }, { widgets: [w('a', 'receivables', 'small', { title: '<img src=x onerror=1>'.repeat(10) })] }, { widgets: 'x' }, 'text', null, { period: { kind: 'x' }, widgets: [] }]) {
      const r = await save(c.fin.cookie, c, layout);
      expect([400, 415], JSON.stringify(layout).slice(0, 60)).toContain(r.statusCode);
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM dashboard_layouts WHERE company_id = $1`, [c.companyId])).rows[0].n).toBe(0);
  });

  it('figures for a widget the role cannot see are never sent; the rest of the request still works', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit' });
    const r = await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/data`, { period: { kind: 'this_fy' }, widgets: [{ id: 'a', type: 'net_profit' }, { id: 'b', type: 'receivables' }, { id: 'c', type: 'cash' }] });
    expect(r.statusCode).toBe(200);
    const res = r.json().results as { id: string; state: string; data?: unknown }[];
    expect(res.map((x) => x.state)).toEqual(['forbidden', 'empty', 'forbidden']);
    expect(JSON.stringify(res.filter((x) => x.state === 'forbidden'))).not.toMatch(/data|balance|netProfit/);
    expect((await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/data`, { widgets: [{ id: 'a', type: 'hack' }] })).statusCode).toBe(400);
  });

  it('the layout is per person: my layout is not my colleague\'s, and Reset brings the default back', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit', Purchases: 'edit' });
    const w2 = await colleague(c);
    await save(c.fin.cookie, c, { widgets: [w('a', 'receivables', 'large', { title: 'Who owes us' })] });
    const mine = await get(c.fin.cookie, c);
    expect(mine.layout.widgets[0]).toMatchObject({ type: 'receivables', size: 'large', title: 'Who owes us' });
    expect((await get(w2.cookie, c)).source).toBe('default');
    expect((await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/reset`)).statusCode).toBe(200);
    expect((await get(c.fin.cookie, c)).source).toBe('default');
  });

  it('only the company\'s Administrator sets defaults, for the company and for one role, and a person\'s own layout still wins', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit', Purchases: 'edit', Reports: 'edit', Bank: 'edit' });
    const base = `/api/companies/${c.companyId}/dashboard/defaults`;
    // Finance (a member, not the Administrator) is refused
    const refused = await call(c.fin.cookie, 'POST', base, { scope: 'company', layout: { widgets: [w('a', 'receivables')] } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().key).toBe('err.dashAdmin');
    expect((await call(c.fin.cookie, 'GET', base)).statusCode).toBe(403);
    // the Administrator is not a member: they cannot read the books' home page, but they can set the defaults
    expect((await call(c.admin.cookie, 'GET', `/api/companies/${c.companyId}/dashboard`)).statusCode).toBe(404);
    expect((await call(c.admin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/data`, { widgets: [{ id: 'a', type: 'cash' }] })).statusCode).toBe(404);
    const start = (await call(c.admin.cookie, 'GET', base)).json();
    expect(start.company).toBeNull();
    expect(start.roles.some((r: { id: string }) => r.id === c.roleId)).toBe(true);
    expect(start.catalog.length).toBe(WIDGETS.length);
    expect(JSON.stringify(start)).not.toMatch(/balance|netProfit|amount/);   // a list of widgets and layouts only: no figures
    // company default, then a role default, then the person's own
    expect((await call(c.admin.cookie, 'POST', base, { scope: 'company', layout: { period: { kind: 'this_quarter' }, widgets: [w('c1', 'payables', 'wide'), w('c2', 'net_profit')] } })).statusCode).toBe(200);
    const viaCompany = await get(c.fin.cookie, c);
    expect(viaCompany.source).toBe('company');
    expect(keysOf(viaCompany.layout)).toEqual(['payables']);            // Finance has no owner reports: that widget is left out
    expect(viaCompany.layout.period).toEqual({ kind: 'this_quarter' });
    expect((await call(c.admin.cookie, 'POST', base, { scope: 'role', roleId: c.roleId, layout: { widgets: [w('r1', 'cash'), w('r2', 'vat_due')] } })).statusCode).toBe(200);
    expect(await get(c.fin.cookie, c)).toMatchObject({ source: 'role' });
    expect(keysOf((await get(c.fin.cookie, c)).layout)).toEqual(['cash', 'vat_due']);
    await save(c.fin.cookie, c, { widgets: [w('m1', 'receivables')] });
    expect(await get(c.fin.cookie, c)).toMatchObject({ source: 'user' });
    // clearing a default brings the next one up
    await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/reset`);
    await call(c.admin.cookie, 'POST', base, { scope: 'role', roleId: c.roleId, layout: null });
    expect((await get(c.fin.cookie, c)).source).toBe('company');
    // bad requests from the Administrator
    for (const body of [{ scope: 'everyone', layout: { widgets: [] } }, { scope: 'role', layout: { widgets: [] } }, { scope: 'role', roleId: 'nope', layout: { widgets: [] } }, { scope: 'company', layout: { widgets: [w('a', 'hack')] } }, { scope: 'company', layout: 5 }]) {
      expect([400, 404], JSON.stringify(body)).toContain((await call(c.admin.cookie, 'POST', base, body)).statusCode);
    }
    // a role of another customer cannot be given a default here
    const other = await customer();
    expect((await call(c.admin.cookie, 'POST', base, { scope: 'role', roleId: other.roleId, layout: { widgets: [] } })).statusCode).toBe(404);
    // every change is audited
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'dashboard_layouts'`, [c.companyId])).rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('another company can neither read nor change this company\'s layouts, and nobody writes around the rules in the database', async () => {
    const a = await customer(), b = await customer();
    await setRole(a, { Sales: 'edit' });
    await save(a.fin.cookie, a, { widgets: [w('a', 'receivables')] });
    await call(a.admin.cookie, 'POST', `/api/companies/${a.companyId}/dashboard/defaults`, { scope: 'company', layout: { widgets: [w('c', 'deadlines', 'wide')] } });
    const other = `/api/companies/${a.companyId}/dashboard`;
    expect((await call(b.fin.cookie, 'GET', other)).statusCode).toBe(404);
    expect((await call(b.fin.cookie, 'POST', `${other}/data`, { widgets: [] })).statusCode).toBe(404);
    expect((await call(b.fin.cookie, 'POST', other, { widgets: [] })).statusCode).toBe(404);
    expect((await call(b.fin.cookie, 'POST', `${other}/reset`)).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'GET', `${other}/defaults`)).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'POST', `${other}/defaults`, { scope: 'company', layout: { widgets: [] } })).statusCode).toBe(404);
    for (const who of [b.fin.id, b.admin.id]) {
      expect((await as(who, (db) => db.query('SELECT * FROM dashboard_layouts'))).rows.filter((r) => r.company_id === a.companyId)).toHaveLength(0);
    }
    // straight into the table: someone else's layout, a default without being the Administrator, a changed owner
    const ins = (cid: string, scope: string, user: string | null, role: string | null) => `INSERT INTO dashboard_layouts (company_id, scope, user_id, client_role_id, layout) VALUES ('${cid}', '${scope}', ${user ? `'${user}'` : 'NULL'}, ${role ? `'${role}'` : 'NULL'}, '{"widgets":[]}')`;
    await expect(as(a.fin.id, (db) => db.query(ins(a.companyId, 'user', a.admin.id, null)))).rejects.toThrow();            // for someone else
    await expect(as(a.fin.id, (db) => db.query(ins(a.companyId, 'company', null, null)))).rejects.toThrow();               // a default, not being the Administrator
    await expect(as(a.fin.id, (db) => db.query(ins(a.companyId, 'role', null, a.roleId)))).rejects.toThrow();
    await expect(as(b.fin.id, (db) => db.query(ins(a.companyId, 'user', b.fin.id, null)))).rejects.toThrow();              // another company
    await expect(as(b.admin.id, (db) => db.query(ins(a.companyId, 'company', null, null)))).rejects.toThrow();
    await expect(as(a.admin.id, (db) => db.query(ins(a.companyId, 'role', null, b.roleId)))).rejects.toThrow(/does not belong/);   // a role of another customer
    await expect(as(a.fin.id, (db) => db.query(`UPDATE dashboard_layouts SET company_id = $1 WHERE company_id = $2`, [b.companyId, a.companyId]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`UPDATE dashboard_layouts SET scope = 'company', user_id = NULL WHERE company_id = $1 AND scope = 'user'`, [a.companyId]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`INSERT INTO dashboard_layouts (company_id, scope, user_id, layout) VALUES ($1, 'user', $2, $3)`, [a.companyId, a.fin.id, JSON.stringify({ x: 'y'.repeat(31000) })]))).rejects.toThrow();
    // a colleague cannot read my own layout
    const w2 = await colleague(a);
    expect((await as(w2.id, (db) => db.query(`SELECT * FROM dashboard_layouts WHERE scope = 'user'`))).rows).toHaveLength(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM dashboard_layouts WHERE company_id = $1 AND scope = 'user'`, [a.companyId])).rows[0].n).toBe(1);
  });

  it('many saves at the same moment leave exactly one layout per person and no error', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit' });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => save(c.fin.cookie, c, { widgets: [w(`w${i}`, 'receivables', 'small', { title: `Run ${i}` })] })));
    expect(results.every((r) => r.statusCode === 200), results.map((r) => r.statusCode).join(',')).toBe(true);
    expect((await owner.query(`SELECT count(*)::int AS n FROM dashboard_layouts WHERE company_id = $1 AND scope = 'user'`, [c.companyId])).rows[0].n).toBe(1);
  });

  it('a stored layout that no longer passes the rules is ignored, never shown', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit' });
    await owner.query(`INSERT INTO dashboard_layouts (company_id, scope, user_id, layout) VALUES ($1, 'user', $2, $3)`, [c.companyId, c.fin.id, JSON.stringify({ widgets: [{ id: 'z', type: 'removed_in_a_later_version', size: 'small' }] })]);
    const d = await get(c.fin.cookie, c);
    expect(d.source).toBe('default');
    expect(keysOf(d.layout)).toContain('receivables');
  });

  it('the home page reads nothing it should not: the widget data call never posts or changes anything', async () => {
    const c = await customer();
    await setRole(c, { Sales: 'edit', Purchases: 'edit', Reports: 'edit', OwnerReports: 'edit', Bank: 'edit' });
    const before = (await owner.query(`SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1)::int AS e, (SELECT count(*) FROM audit_log WHERE company_id = $1)::int AS a`, [c.companyId])).rows[0];
    const r = await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/dashboard/data`, { period: { kind: 'this_fy' }, widgets: WIDGETS.map((x) => ({ id: x.key, type: x.key })) });
    expect(r.statusCode, r.body).toBe(200);
    const after = (await owner.query(`SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1)::int AS e, (SELECT count(*) FROM audit_log WHERE company_id = $1)::int AS a`, [c.companyId])).rows[0];
    expect(after).toEqual(before);
  });
});
