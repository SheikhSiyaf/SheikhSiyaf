// What each widget shows, drawn from the figures the server sent (or from the sample figures in the gallery and the Administrator's editor).
// A widget never works anything out from the books itself: it shows exact amounts as text and draws the same figures as a picture.
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { useDates, useDeadlineText, type CalItem } from '../calendar/Calendar.tsx';
import { useGo } from '../sales/common.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { BarChart, Donut, HBars, LineChart } from './charts.tsx';
import type { LayoutWidget, Result } from './types.ts';

export const EMPTY_ACTION: Record<string, [string, string, string?] | undefined> = {
  no_entries: ['Journal', 'new'], no_invoices: ['Sales', 'invoices', 'new'], no_bills: ['Purchases', 'bills', 'new'], no_items: ['Inventory', 'items', 'new'],
};

interface Ctx { currency: string; sample?: boolean; books?: CompanyBooks; today: string }
const num = (s: string) => Number(s);
const cls = (a: string) => (toMinor(a) < 0n ? 'bad' : toMinor(a) > 0n ? 'good' : '');

function Big({ value, cur, note }: { value: string; cur: string; note?: string }) {
  return <div className="dw-big"><b className="ltr">{fmt(value)}</b> <small>{cur}</small>{note && <div className="small mut">{note}</div>}</div>;
}

function Change({ value, label }: { value: string; label: string }) {
  const up = toMinor(value) >= 0n;
  return <div className={`small ${cls(value)}`}><span aria-hidden="true">{up ? '▲' : '▼'}</span> <b className="ltr">{fmt(up ? value : fromMinor(-toMinor(value)))}</b> <span className="mut">{label}</span></div>;
}

export function EmptyState({ reason, go }: { reason: string; go: (m: string, s?: string, i?: string) => void }) {
  const { t, has } = useI18n();
  const act = EMPTY_ACTION[reason];
  return (
    <div className="dw-empty">
      <p>{has(`dash.empty.${reason}`) ? t(`dash.empty.${reason}` as Key) : t('dash.empty.generic')}</p>
      {act && <button className="b p small" onClick={() => go(act[0], act[1], act[2])}>{t(`dash.act.${reason}` as Key)}</button>}
    </div>
  );
}

function Aging({ data, chart, side }: { data: { total: string; buckets: Record<string, string> }; chart: string; side: 'sales' | 'purchases' }) {
  const { t } = useI18n();
  const ks = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
  const labels = ks.map((k) => t(`aged.${k}` as Key));
  const total = side === 'sales' ? t('dash.w.receivables') : t('dash.w.payables');
  if (chart === 'table') {
    return (
      <table className="dw-table"><tbody>
        {ks.map((k, i) => <tr key={k}><td>{labels[i]}</td><td className="num ltr">{fmt(data.buckets[k])}</td></tr>)}
        <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(data.total)}</td></tr>
      </tbody></table>
    );
  }
  return <BarChart labels={labels} series={[{ label: total, values: ks.map((k) => num(data.buckets[k]!)), color: side === 'sales' ? 'var(--dc1)' : 'var(--dc2)' }]} caption={total} />;
}

function Deadlines({ books, today }: { books: CompanyBooks; today: string }) {
  const { t } = useI18n();
  const dt = useDates();
  const text = useDeadlineText(books.company.country);
  const c = useApi<CalItem[]>(`/api/companies/${books.company.id}/calendar`);
  if (!c.data) return <p className="small mut">{t('dash.loading')}</p>;
  const open = c.data.filter((i) => i.status === 'overdue' || i.status === 'soon');
  const next = c.data.find((i) => i.status === 'later' && i.due >= today);
  if (open.length === 0) return <p className="small mut">{next ? t('home.nextDeadline', { what: text(next).title, date: dt.day(next.due) }) : t('cal.none')}</p>;
  return (
    <table className="dw-table"><tbody>{open.slice(0, 5).map((i) => (
      <tr key={i.key}><td><b>{text(i).title}</b><div className="small mut">{text(i).detail}</div></td>
        <td className="num"><span className={`badge ${i.status === 'overdue' ? 'bad' : 'warn'}`}>{i.status === 'overdue' ? t('cal.s.overdue') : dt.day(i.due)}</span></td></tr>
    ))}</tbody></table>
  );
}

/** Shortcuts, each shown only when the person's role may use its module (edit to create, view to read). */
function Shortcuts({ books, sample, go }: { books?: CompanyBooks; sample?: boolean; go: (m: string, s?: string, i?: string) => void }) {
  const { t } = useI18n();
  const level = (m: string) => (sample ? 'edit' : accessTo(books?.access?.permissions, m));
  const can = (m: string) => (sample || books?.canPost) && level(m) === 'edit';
  const actions: [boolean, string, string, Key][] = [
    [!!can('Sales'), 'Sales', 'invoices/new', 'ov.newInvoice'], [!!can('Sales'), 'Sales', 'payments-received/new', 'ov.recordReceipt'],
    [!!can('Expenses'), 'Expenses', 'expenses/new', 'exp.record'], [!!can('Purchases'), 'Purchases', 'bills/new', 'ov.newBill'], [!!can('Journal'), 'Journal', 'new', 'home.newEntry'],
    [level('Reports') !== 'none', 'Reports', 'trial-balance', 'home.trialBalance'], [level('Reports') !== 'none', 'Reports', 'vat-return', 'dash.w.vat_due'],
  ];
  const shown = actions.filter(([ok]) => ok);
  if (!shown.length) return <p className="small mut">{t('dash.empty.generic')}</p>;
  return <div className="actions">{shown.map(([, m, sub, key], i) => <button key={key + sub} className={i === 0 ? 'b p small' : 'b small'} onClick={() => !sample && go(m, ...(sub.split('/') as [string, string?]))}>{t(key)}</button>)}</div>;
}

export function WidgetBody({ item, result, ctx, go }: { item: LayoutWidget; result: Result; ctx: Ctx; go: (m: string, s?: string, i?: string, extra?: string) => void }) {
  const { t, lang } = useI18n();
  const local = useLocalName();
  const dt = useDates();
  const cur = ctx.currency;
  const chart = item.chart;
  if (result.state === 'empty') return <EmptyState reason={result.empty ?? 'generic'} go={go} />;
  const d = (result.data ?? {}) as Record<string, any>;
  switch (item.type) {
    case 'cash':
      return <><Big value={d.balance} cur={cur} note={t('dash.asOf', { date: dt.day(d.asOf) })} /><Change value={d.change} label={t('dash.cash.change')} /></>;
    case 'receivables': case 'payables':
      return <><Big value={d.total} cur={cur} note={t('dash.contacts', { n: d.contacts })} /><Aging data={d as { total: string; buckets: Record<string, string> }} chart={chart ?? 'bars'} side={item.type === 'receivables' ? 'sales' : 'purchases'} /></>;
    case 'net_profit':
      return <><Big value={d.netProfit} cur={cur} note={t('dash.profit.sales', { amount: fmt(d.revenue) })} /><Change value={fromMinor(toMinor(d.netProfit) - toMinor(d.previous.netProfit))} label={t('dash.profit.vsBefore', { amount: fmt(d.previous.netProfit) })} /></>;
    case 'income_expense': {
      const cols = d.columns as { from: string; revenue: string; expenses: string; netProfit: string }[];
      const labels = cols.map((c) => dt.short(c.from));
      const series = [{ label: t('dash.ie.income'), values: cols.map((c) => num(c.revenue)), color: 'var(--dc1)' }, { label: t('dash.ie.expenses'), values: cols.map((c) => num(c.expenses)), color: 'var(--dc2)' },
        ...(chart === 'line' ? [{ label: t('dash.ie.profit'), values: cols.map((c) => num(c.netProfit)), color: 'var(--dc3)' }] : [])];
      return chart === 'line' ? <LineChart labels={labels} series={series} caption={t('dash.w.income_expense')} /> : <BarChart labels={labels} series={series} caption={t('dash.w.income_expense')} />;
    }
    case 'expenses_by_category': {
      const rows = [...(d.rows as { name: string; nameAr: string | null; amount: string }[]).map((r) => ({ label: local(r.name, r.nameAr), value: num(r.amount), text: fmt(r.amount) })),
        ...(toMinor(d.other) > 0n ? [{ label: t('dash.other'), value: num(d.other), text: fmt(d.other) }] : [])];
      if (chart === 'donut') return <Donut slices={rows} caption={t('dash.w.expenses_by_category')} />;
      if (chart === 'table') return <table className="dw-table"><tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num ltr">{r.text}</td></tr>)}<tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(d.total)}</td></tr></tbody></table>;
      return <HBars rows={rows} caption={t('dash.w.expenses_by_category')} />;
    }
    case 'vat_due': {
      const net = toMinor(d.netVat);
      return (
        <>
          <Big value={fromMinor(net < 0n ? -net : net)} cur={cur} note={net >= 0n ? t('dash.vat.net') : t('dash.vat.refund')} />
          <table className="dw-table"><tbody>
            <tr><td>{t('dash.vat.output')}</td><td className="num ltr">{fmt(d.outputVat)}</td></tr><tr><td>{t('dash.vat.input')}</td><td className="num ltr">{fmt(d.inputVat)}</td></tr>
          </tbody></table>
          <span className={`badge ${d.agreesWithBooks ? 'good' : 'warn'}`}>{d.agreesWithBooks ? t('dash.vat.agree') : t('dash.vat.differs')}</span>
        </>
      );
    }
    case 'overdue_invoices': case 'bills_due': {
      const rows = d.rows as { id: string; number: string; contact: string | null; contactAr: string | null; due: string; amount: string }[];
      const mod = item.type === 'overdue_invoices' ? ['Sales', 'invoices'] : ['Purchases', 'bills'];
      return (
        <>
          <Big value={d.total} cur={cur} note={t(item.type === 'overdue_invoices' ? 'dash.od.count' : 'dash.bd.count', { n: d.count })} />
          <table className="dw-table"><thead><tr><th>{t('dash.col.number')}</th><th>{t('dash.col.name')}</th><th>{t('dash.col.due')}</th><th className="num">{t('dash.col.amount')}</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{ctx.sample ? r.number : <button className="link" onClick={() => go(mod[0]!, mod[1], r.id)}>{r.number}</button>}</td><td>{local(r.contact, r.contactAr)}</td><td>{dt.day(r.due)}</td><td className="num ltr">{fmt(r.amount)}</td></tr>)}</tbody></table>
          {d.count > rows.length && <div className="small mut">{t('dash.more', { n: d.count - rows.length })}</div>}
        </>
      );
    }
    case 'stock_value':
      return <><Big value={d.total} cur={cur} note={t('dash.stock.books', { amount: fmt(d.booksValue) })} />{toMinor(d.difference) !== 0n && <span className="badge warn">{t('dash.stock.diff', { amount: fmt(d.difference) })}</span>}</>;
    case 'books_status':
      return (
        <table className="dw-table"><tbody>
          <tr><td>{t('home.entriesThisMonth')}</td><td className="num">{d.entriesThisMonth}</td></tr>
          <tr><td>{t('home.lockedUpTo')}</td><td className="num">{d.lockedUpTo ? dt.day(d.lockedUpTo) : <span className="mut">{t('home.notLocked')}</span>}</td></tr>
        </tbody></table>
      );
    case 'deadlines':
      return ctx.sample || !ctx.books ? <p className="small mut">{t('home.nextDeadline', { what: t('dash.sample.deadline'), date: dt.day(ctx.today) })}</p> : <Deadlines books={ctx.books} today={ctx.today} />;
    case 'shortcuts':
      return <Shortcuts books={ctx.books} sample={ctx.sample} go={go} />;
    default: return <p className="small mut">{lang ? '' : ''}</p>;
  }
}
