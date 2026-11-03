// Statements: owner summary (one page), balance sheet, cash flow, the P&L in columns, and the VAT return worksheet.
// Every account name opens its ledger (drill-down to the transactions).
import { useState, type ReactNode } from 'react';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';

interface Line { accountId: string; code?: string; name: string; nameAr: string | null; amount: string; group?: string }
const monthEnd = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10);
const prevMonthEnd = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
const neg = (v: string) => toMinor(v) < 0n;
const Amt = ({ v, strong }: { v: string | null | undefined; strong?: boolean }) =>
  v == null ? <>—</> : <span className={`ltr ${neg(v) ? 'bad' : ''}`}>{strong ? <b>{fmt(v)}</b> : fmt(v)}</span>;
const change = (a: string, b: string) => fromMinor(toMinor(a) - toMinor(b));
const changePct = (a: string, b: string) => { const x = toMinor(b); return x === 0n ? null : Number(((toMinor(a) - x) * 1000n) / (x < 0n ? -x : x)) / 10; };

/** An account name that opens its general ledger. */
export function AccountLink({ books, l }: { books: CompanyBooks; l: { accountId: string; name: string; nameAr: string | null } }) {
  const local = useLocalName();
  const go = useGo(books.company.id);
  return <button className="link drill" onClick={() => go('Ledger', 'general-ledger', l.accountId)}>{local(l.name, l.nameAr)}</button>;
}

// ------------------------------------------------------------------ owner summary
interface Summary {
  asOf: string; monthStart: string; lastStart: string; lastEnd: string; yearStart: string;
  month: { revenue: string; grossProfit: string; netProfit: string }; lastMonth: { revenue: string; grossProfit: string; netProfit: string }; yearToDate: { revenue: string; grossProfit: string; netProfit: string };
  position: { cash: string; receivables: string; overdue: string; payables: string; inventory: string; vatDue: string; workingCapital: string };
  ratios: { grossMargin: number | null; netMargin: number | null; currentRatio: number | null; quickRatio: number | null; debtorDays: number | null; creditorDays: number | null };
  topCustomers: { id: string; name: string; nameAr: string | null; amount: string }[]; topExpenses: Line[];
}

export function OwnerSummary({ books }: { books: CompanyBooks }) {
  const { t, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [asOf, setAsOf] = useState(today());
  const s = useApi<Summary>(`/api/companies/${books.company.id}/reports/owner-summary?asOf=${asOf}`);
  const monthName = (d: string) => new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  const d = s.data;
  const reviewed = books.reviewedUpTo;
  const row = (k: Key, f: 'revenue' | 'grossProfit' | 'netProfit') => d && (
    <tr key={k}><td>{t(k)}</td><td className="num"><Amt v={d.month[f]} strong /></td><td className="num"><Amt v={d.lastMonth[f]} /></td>
      <td className="num small">{changePct(d.month[f], d.lastMonth[f]) === null ? '—' : <span className={changePct(d.month[f], d.lastMonth[f])! < 0 ? 'bad' : 'good-text'}>{changePct(d.month[f], d.lastMonth[f])! > 0 ? '+' : ''}{changePct(d.month[f], d.lastMonth[f])}%</span>}</td>
      <td className="num"><Amt v={d.yearToDate[f]} /></td></tr>);
  const ratio = (k: Key, v: number | null, unit: string) => <tr key={k}><td>{t(k)}</td><td className="num ltr">{v === null ? '—' : `${v}${unit}`}</td><td className="small mut">{t(`${k}Hint` as Key)}</td></tr>;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <label className="f">{t('asOf')}<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <span className="spacer" />
        {reviewed && <span className="badge good" style={{ whiteSpace: 'normal' }}>✓ {t('rv.reviewedUpTo', { month: monthName(reviewed.periodEnd), name: reviewed.signedBy })}</span>}
      </div>
      {!d ? <Loading /> : <>
        <div className="grid">
          <button className="card fig" onClick={() => go('Bank', 'accounts')}><small>{t('rep.cash')}</small><b className="ltr">{fmt(d.position.cash)}</b><small>{books.company.currency}</small></button>
          <button className="card fig" onClick={() => go('Reports', 'aged-receivables')}><small>{t('rep.receivables')}</small><b className="ltr">{fmt(d.position.receivables)}</b>
            <small className={toMinor(d.position.overdue) > 0n ? 'bad' : ''}>{t('rep.overdueAmt', { amount: fmt(d.position.overdue) })}</small></button>
          <button className="card fig" onClick={() => go('Reports', 'aged-payables')}><small>{t('rep.payables')}</small><b className="ltr">{fmt(d.position.payables)}</b><small>{books.company.currency}</small></button>
          <button className="card fig" onClick={() => go('Reports', 'vat-return')}><small>{t('rep.vatDue')}</small><b className="ltr">{fmt(d.position.vatDue)}</b><small>{t('rep.fromBooks')}</small></button>
        </div>
        <div className="grid two">
          <div className="card">
            <h2>{t('rep.results')}</h2>
            <div className="wrap"><table>
              <thead><tr><th /><th className="num">{monthName(d.monthStart)}</th><th className="num">{monthName(d.lastStart)}</th><th className="num">{t('rep.change')}</th><th className="num">{t('rep.ytd')}</th></tr></thead>
              <tbody>{row('reports.sales', 'revenue')}{row('reports.grossProfit', 'grossProfit')}{row('reports.netProfit', 'netProfit')}</tbody>
            </table></div>
          </div>
          <div className="card">
            <h2>{t('rep.ratios')}</h2>
            <div className="wrap"><table><tbody>
              {ratio('rep.grossMargin', d.ratios.grossMargin, '%')}{ratio('rep.netMargin', d.ratios.netMargin, '%')}
              {ratio('rep.currentRatio', d.ratios.currentRatio, '')}{ratio('rep.quickRatio', d.ratios.quickRatio, '')}
              {ratio('rep.debtorDays', d.ratios.debtorDays, ` ${t('rep.days')}`)}{ratio('rep.creditorDays', d.ratios.creditorDays, ` ${t('rep.days')}`)}
              <tr><td>{t('rep.workingCapital')}</td><td className="num"><Amt v={d.position.workingCapital} /></td><td className="small mut">{t('rep.workingCapitalHint')}</td></tr>
            </tbody></table></div>
          </div>
        </div>
        <div className="grid two">
          <div className="card"><h2>{t('rep.topCustomers')}</h2>
            {d.topCustomers.length === 0 ? <div className="mut small">{t('reports.noActivity')}</div> : <div className="wrap"><table><tbody>{d.topCustomers.map((c) => (
              <tr key={c.id}><td><button className="link" onClick={() => go('Sales', 'customers', c.id)}>{local(c.name, c.nameAr)}</button></td><td className="num"><Amt v={c.amount} /></td></tr>))}</tbody></table></div>}</div>
          <div className="card"><h2>{t('rep.topExpenses')}</h2>
            {d.topExpenses.length === 0 ? <div className="mut small">{t('reports.noActivity')}</div> : <div className="wrap"><table><tbody>{d.topExpenses.map((l) => (
              <tr key={l.accountId}><td><AccountLink books={books} l={l} /></td><td className="num"><Amt v={l.amount} /></td></tr>))}</tbody></table></div>}</div>
        </div>
        <p className="mut small">{t('rep.summaryNote', { start: d.yearStart })}</p>
      </>}
    </>
  );
}

// ------------------------------------------------------------------ balance sheet
interface Bs { asOf: string; fyStart: string; sections: Record<string, Line[]>; totals: Record<string, string>; balances: boolean }

export function BalanceSheet({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const [asOf, setAsOf] = useState(today());
  const [cmp, setCmp] = useState<'none' | 'month' | 'year'>('year');
  const compareTo = cmp === 'month' ? prevMonthEnd(asOf) : cmp === 'year' ? `${+asOf.slice(0, 4) - 1}-12-31` : '';
  const r = useApi<{ current: Bs; compare: Bs | null }>(`/api/companies/${books.company.id}/reports/balance-sheet?asOf=${asOf}${compareTo ? `&compareTo=${compareTo}` : ''}`);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const c = books.company.currency;
  const other = (sec: string, id: string) => d?.compare?.sections[sec]?.find((l) => l.accountId === id)?.amount ?? (d?.compare ? '0.00' : null);
  const section = (sec: string, title: Key, total: Key, totKey: string) => {
    const ids = [...new Set([...(d!.current.sections[sec] ?? []), ...(d!.compare?.sections[sec] ?? [])].map((l) => l.accountId))];
    const lineOf = (id: string) => d!.current.sections[sec]!.find((l) => l.accountId === id) ?? { ...d!.compare!.sections[sec]!.find((l) => l.accountId === id)!, amount: '0.00' };
    return (
      <>
        <tr className="section"><td colSpan={d!.compare ? 3 : 2}><b>{t(title)}</b></td></tr>
        {ids.map((id) => { const l = lineOf(id); return <tr key={id}><td className="indent"><AccountLink books={books} l={l} /></td><td className="num"><Amt v={l.amount} /></td>{d!.compare && <td className="num mut"><Amt v={other(sec, id)} /></td>}</tr>; })}
        <tr className="subtotal"><td>{t(total)}</td><td className="num"><Amt v={d!.current.totals[totKey]} /></td>{d!.compare && <td className="num"><Amt v={d!.compare.totals[totKey]} /></td>}</tr>
      </>
    );
  };
  const extra = (k: Key, key: string) => <tr><td className="indent">{t(k)}</td><td className="num"><Amt v={d!.current.totals[key]} /></td>{d!.compare && <td className="num mut"><Amt v={d!.compare.totals[key]} /></td>}</tr>;
  const grand = (k: Key, key: string) => <tr className="total grand"><td>{t(k)}</td><td className="num"><Amt v={d!.current.totals[key]} strong /></td>{d!.compare && <td className="num"><Amt v={d!.compare.totals[key]} /></td>}</tr>;
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('sub.balance-sheet')}</h2><span className="spacer" />
        <label className="f">{t('asOf')}<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <label className="f">{t('rep.compareWith')}<select value={cmp} onChange={(e) => setCmp(e.target.value as typeof cmp)}>
          <option value="none">{t('rep.noCompare')}</option><option value="month">{t('rep.lastMonthEnd')}</option><option value="year">{t('rep.lastYearEnd')}</option></select></label>
      </div>
      {!d ? <Loading /> : <>
        {!d.current.balances && <div className="notice bad">{t('reports.outOfBalance')}</div>}
        <div className="wrap"><table className="pnl">
          <thead><tr><th>{t('reports.particulars')}</th><th className="num">{d.current.asOf} ({c})</th>{d.compare && <th className="num">{d.compare.asOf}</th>}</tr></thead>
          <tbody>
            {section('nonCurrentAssets', 'rep.nonCurrentAssets', 'rep.totalNonCurrentAssets', 'nonCurrentAssets')}
            {section('currentAssets', 'rep.currentAssets', 'rep.totalCurrentAssets', 'currentAssets')}
            {grand('rep.totalAssets', 'assets')}
            {section('currentLiabilities', 'rep.currentLiabilities', 'rep.totalCurrentLiabilities', 'currentLiabilities')}
            {section('nonCurrentLiabilities', 'rep.nonCurrentLiabilities', 'rep.totalNonCurrentLiabilities', 'nonCurrentLiabilities')}
            {section('equity', 'rep.equity', 'rep.capital', 'capital')}
            {extra('rep.earlierYears', 'earlierYears')}{extra('rep.thisYear', 'thisYear')}
            <tr className="subtotal"><td>{t('rep.totalEquity')}</td><td className="num"><Amt v={d.current.totals.equity} /></td>{d.compare && <td className="num"><Amt v={d.compare.totals.equity} /></td>}</tr>
            {grand('rep.totalLiabilitiesEquity', 'liabilitiesAndEquity')}
          </tbody>
        </table></div>
        <p className="mut small">{t('rep.bsNote', { start: d.current.fyStart })}</p>
      </>}
    </div>
  );
}

// ------------------------------------------------------------------ cash flow
interface Cf { from: string; to: string; sections: Record<string, Line[]>; totals: Record<string, string>; opening: string; closing: string; agrees: boolean }

export function CashFlow({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const r = useApi<Cf>(`/api/companies/${books.company.id}/reports/cash-flow?from=${from}&to=${to}`);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const sec = (k: string, title: Key, total: Key) => (
    <>
      <tr className="section"><td colSpan={2}><b>{t(title)}</b></td></tr>
      {(d!.sections[k] ?? []).map((l) => <tr key={l.accountId}><td className="indent"><AccountLink books={books} l={l} /></td><td className="num"><Amt v={l.amount} /></td></tr>)}
      {(d!.sections[k] ?? []).length === 0 && <tr><td className="indent mut">—</td><td /></tr>}
      <tr className="subtotal"><td>{t(total)}</td><td className="num"><Amt v={d!.totals[k]} /></td></tr>
    </>
  );
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('sub.cash-flow')}</h2><span className="spacer" />
        <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {!d ? <Loading /> : <>
        {!d.agrees && <div className="notice bad">{t('rep.cfNotAgree')}</div>}
        <div className="wrap"><table className="pnl">
          <thead><tr><th>{t('reports.particulars')}</th><th className="num">{t('reports.total')} ({books.company.currency})</th></tr></thead>
          <tbody>
            <tr className="total"><td>{t('rep.openingCash')}</td><td className="num"><Amt v={d.opening} /></td></tr>
            {sec('operating', 'rep.operating', 'rep.netOperating')}
            {sec('investing', 'rep.investing', 'rep.netInvesting')}
            {sec('financing', 'rep.financing', 'rep.netFinancing')}
            <tr className="total"><td>{t('rep.netChange')}</td><td className="num"><Amt v={d.totals.net} /></td></tr>
            <tr className="total grand"><td>{t('rep.closingCash')}</td><td className="num"><Amt v={d.closing} strong /></td></tr>
          </tbody>
        </table></div>
        <p className="mut small">{t('rep.cfNote')}</p>
      </>}
    </div>
  );
}

// ------------------------------------------------------------------ P&L in columns
interface Pnl { from: string; to: string; lines: Line[]; revenue: string; costOfSales: string; grossProfit: string; indirectExpenses: string; otherIncome: string; netProfit: string }
type Compare = 'none' | 'previous' | 'lastYear' | 'monthly';

export function PnlStatement({ books, from, to }: { books: CompanyBooks; from: string; to: string }) {
  const { t, lang } = useI18n();
  const [compare, setCompare] = useState<Compare>('none');
  const r = useApi<{ columns: Pnl[] }>(`/api/companies/${books.company.id}/reports/pnl-columns?from=${from}&to=${to}&compare=${compare}`);
  const cols = r.data?.columns ?? [];
  const two = cols.length === 2 && compare !== 'monthly';
  const label = (p: Pnl) => (compare === 'monthly' ? new Date(`${p.from.slice(0, 7)}-01T00:00:00Z`).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : `${p.from} – ${p.to}`);
  const ids = (g: string) => [...new Map(cols.flatMap((c) => c.lines.filter((l) => l.group === g)).map((l) => [l.accountId, l])).values()];
  const amt = (c: Pnl, id: string) => c.lines.find((l) => l.accountId === id)?.amount ?? '0.00';
  const variance = (a: string, b: string) => <><td className="num"><Amt v={change(a, b)} /></td><td className="num small">{changePct(a, b) === null ? '—' : `${changePct(a, b)! > 0 ? '+' : ''}${changePct(a, b)}%`}</td></>;
  const lines = (g: string) => ids(g).map((l) => (
    <tr key={l.accountId}><td className="indent"><AccountLink books={books} l={l} /></td>{cols.map((c, i) => <td key={i} className="num"><Amt v={amt(c, l.accountId)} /></td>)}{two && variance(amt(cols[0]!, l.accountId), amt(cols[1]!, l.accountId))}</tr>));
  const head = (k: Key) => <tr className="section"><td colSpan={cols.length + (two ? 3 : 1)}><b>{t(k)}</b></td></tr>;
  const sub = (k: Key, f: keyof Pnl, cls = 'subtotal', loss?: Key) => {
    const v0 = String(cols[0]?.[f] ?? '0');
    return <tr className={cls}><td>{loss && neg(v0) ? t(loss) : t(k)}</td>{cols.map((c, i) => <td key={i} className="num"><Amt v={String(c[f])} strong={cls.includes('grand')} /></td>)}{two && variance(String(cols[0]![f]), String(cols[1]![f]))}</tr>;
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 8 }}>
        <label className="f">{t('rep.view')}<select id="pnl-compare" value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
          {(['none', 'previous', 'lastYear', 'monthly'] as const).map((x) => <option key={x} value={x}>{t(`rep.cmp.${x}`)}</option>)}</select></label>
      </div>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data ? <Loading /> : (
        <div className="wrap"><table className="pnl">
          <thead><tr><th>{t('reports.particulars')}</th>{cols.map((c, i) => <th key={i} className="num">{cols.length === 1 ? `${t('reports.total')} (${books.company.currency})` : label(c)}</th>)}
            {two && <><th className="num">{t('rep.change')}</th><th className="num">%</th></>}</tr></thead>
          <tbody>
            {head('reports.sales')}{lines('revenue')}{sub('reports.totalSales', 'revenue')}
            {head('reports.costOfSales')}{lines('cost_of_sales')}{sub('reports.totalCostOfSales', 'costOfSales')}
            {sub('reports.grossProfit', 'grossProfit', 'total', 'reports.grossLoss')}
            {head('reports.indirectExpenses')}{lines('indirect_expense')}{sub('reports.totalIndirectExpenses', 'indirectExpenses')}
            {head('reports.indirectIncome')}{lines('other_income')}{sub('reports.totalIndirectIncome', 'otherIncome')}
            {sub('reports.netProfit', 'netProfit', 'total grand', 'reports.netLoss')}
          </tbody>
        </table></div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ VAT return worksheet
interface VatRow { net: string; vat: string; adjust: string }
interface VatReturn { from: string; to: string; country: string; sales: Record<string, VatRow>; purchases: Record<string, VatRow>; outputVat: string; inputVat: string; netVat: string;
  books: { outputVat: string; inputVat: string; netVat: string }; agreesWithBooks: boolean }

export function VatReturnSheet({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const q = (() => { const d = new Date(); const m = d.getUTCMonth() - (d.getUTCMonth() % 3) - 3; return new Date(Date.UTC(d.getUTCFullYear(), m, 1)).toISOString().slice(0, 10); })();
  const [from, setFrom] = useState(q);
  const [to, setTo] = useState(monthEnd(new Date(Date.UTC(+q.slice(0, 4), +q.slice(5, 7) + 1, 1)).toISOString().slice(0, 10)));
  const r = useApi<VatReturn>(`/api/companies/${books.company.id}/reports/vat-return?from=${from}&to=${to}`);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const sa = books.company.country === 'SA';
  const row = (box: string, k: Key, x: VatRow | undefined, showVat = true): ReactNode => (
    <tr><td className="ltr small mut">{box}</td><td>{t(k)}</td><td className="num"><Amt v={x?.net ?? '0.00'} /></td><td className="num"><Amt v={x?.adjust ?? '0.00'} /></td><td className="num">{showVat ? <Amt v={x?.vat ?? '0.00'} /> : '—'}</td></tr>
  );
  const sum = (o: Record<string, VatRow>) => ({ net: fromMinor(Object.values(o).reduce((s, x) => s + toMinor(x.net), 0n)), adjust: fromMinor(Object.values(o).reduce((s, x) => s + toMinor(x.adjust), 0n)),
    vat: fromMinor(Object.values(o).reduce((s, x) => s + toMinor(x.vat), 0n)) });
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t(sa ? 'rep.vatReturnSA' : 'rep.vatReturnAE')}</h2><span className="spacer" />
        <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {!d ? <Loading /> : <>
        <div className="wrap"><table>
          <thead><tr><th>{t('rep.box')}</th><th>{t('reports.particulars')}</th><th className="num">{t('rep.amountExVat')}</th><th className="num">{t('rep.adjustments')}</th><th className="num">{t('rep.vatAmount')}</th></tr></thead>
          <tbody>
            <tr className="section"><td colSpan={5}><b>{t('rep.vatOnSales')}</b></td></tr>
            {row(sa ? '1' : '1a–1g', sa ? 'rep.saStandardSales' : 'rep.aeStandardSales', d.sales.standard)}
            {row(sa ? '3 / 4' : '4', 'rep.zeroRatedSales', d.sales.zero, false)}
            {row('5', 'rep.exemptSales', d.sales.exempt, false)}
            <tr className="subtotal"><td className="ltr small mut">{sa ? '6' : '8'}</td><td>{t('rep.totalSales')}</td><td className="num"><Amt v={sum(d.sales).net} /></td><td className="num"><Amt v={sum(d.sales).adjust} /></td><td className="num"><Amt v={d.outputVat} /></td></tr>
            <tr className="section"><td colSpan={5}><b>{t('rep.vatOnPurchases')}</b></td></tr>
            {row(sa ? '7' : '9', 'rep.standardPurchases', d.purchases.standard)}
            {row(sa ? '10' : '—', 'rep.zeroRatedPurchases', d.purchases.zero, false)}
            {row(sa ? '11' : '—', 'rep.exemptPurchases', d.purchases.exempt, false)}
            <tr className="subtotal"><td className="ltr small mut">{sa ? '12' : '11'}</td><td>{t('rep.totalPurchases')}</td><td className="num"><Amt v={sum(d.purchases).net} /></td><td className="num"><Amt v={sum(d.purchases).adjust} /></td><td className="num"><Amt v={d.inputVat} /></td></tr>
            <tr className="total grand"><td className="ltr small">{sa ? '13 / 16' : '14'}</td><td>{t('rep.netVatDue')}</td><td /><td /><td className="num"><Amt v={d.netVat} strong /></td></tr>
          </tbody>
        </table></div>
        <div className={`notice small ${d.agreesWithBooks ? '' : 'warn'}`} style={{ marginTop: 10 }}>
          {d.agreesWithBooks ? t('rep.vatAgrees') : t('rep.vatDiffers', { output: fmt(d.books.outputVat), input: fmt(d.books.inputVat), net: fmt(d.books.netVat) })}
        </div>
        <p className="mut small">{t(sa ? 'rep.vatNoteSA' : 'rep.vatNoteAE')}</p>
      </>}
    </div>
  );
}
