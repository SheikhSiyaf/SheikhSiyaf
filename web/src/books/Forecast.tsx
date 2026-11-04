// Reports > Cash flow forecast: cash in the bank today, then what the books say comes in and goes out, week by
// week or month by month, with the items people add; how late customers pay; and the minimum cash to keep.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { IN_CATEGORIES, OUT_CATEGORIES } from '../../../src/books/forecast.ts';

interface Row { start: string; end: string; opening: string; inflows: Record<string, string>; outflows: Record<string, string>; totalIn: string; totalOut: string; net: string; closing: string; belowMinimum: boolean }
interface FlowRow { date: string; amount: string; direction: 'in' | 'out'; category: string; label: string; ref: { type: string; id: string } | null; period: number; overdue: boolean }
interface Forecast { grain: 'week' | 'month'; delayDays: number; opening: string; minimumCash: string; rows: Row[]; lowest: { amount: string; period: number }; flows: FlowRow[] }
interface Item { id: string; description: string; direction: 'in' | 'out'; amount: string; firstDate: string; repeat: string; endDate: string | null; status: string; createdBy: string | null }

export function CashForecast({ books }: { books: CompanyBooks }) {
  const { t, lang, has } = useI18n();
  const go = useGo(books.company.id);
  const [grain, setGrain] = useState<'week' | 'month'>('week');
  const [delay, setDelay] = useState(0);
  const f = useApi<Forecast>(`/api/companies/${books.company.id}/forecast?grain=${grain}&delay=${delay}`);
  const [pick, setPick] = useState<{ period: number; category: string | null }>();
  const [minimum, setMinimum] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const d = f.data;
  const label = (r: Row) => new Date(`${r.start}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB',
    grain === 'week' ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const saveMinimum = async () => {
    try { await api(`/api/companies/${books.company.id}/forecast/settings`, { body: { minimumCash: (minimum ?? '0').replace(/,/g, '') } }); setMinimum(undefined); setMsg(undefined); f.reload(); }
    catch (e) { setMsg(errorText(t, has, e)); }
  };
  const open = (fl: FlowRow) => {
    if (!fl.ref) return;
    if (fl.ref.type === 'document') go(fl.category === 'receivables' ? 'Sales' : fl.category === 'claims' ? 'Expenses' : 'Purchases', fl.category === 'receivables' ? 'invoices' : fl.category === 'claims' ? 'claims' : 'bills', fl.ref.id);
    else if (fl.ref.type === 'recurring') go('Expenses', 'recurring', fl.ref.id);
    else if (fl.ref.type === 'approval') go('Approvals', 'waiting');
  };
  if (f.error) return <ErrorNote error={f.error} onRetry={f.reload} />;
  const used = (dir: 'in' | 'out') => (dir === 'in' ? IN_CATEGORIES : OUT_CATEGORIES).filter((c) => d?.rows.some((r) => toMinor((dir === 'in' ? r.inflows : r.outflows)[c] ?? '0') !== 0n));
  const below = d?.rows.filter((r) => r.belowMinimum).length ?? 0;
  const detail = d && pick ? d.flows.filter((x) => x.period === pick.period && (!pick.category || x.category === pick.category)) : [];
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="seg" role="radiogroup" aria-label={t('fc.view')}>
          {(['week', 'month'] as const).map((g) => <button key={g} id={`fc-${g}`} role="radio" aria-checked={grain === g} className={grain === g ? 'on' : ''} onClick={() => { setGrain(g); setPick(undefined); }}>{t(`fc.grain.${g}` as Key)}</button>)}
        </div>
        <label className="f" style={{ margin: 0 }}>{t('fc.customersPay')}<select id="fc-delay" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
          {[0, 7, 14, 30, 60].map((n) => <option key={n} value={n}>{n ? t('fc.late', { n }) : t('fc.onTime')}</option>)}</select></label>
        <span className="spacer" />
        <label className="f" style={{ margin: 0 }}>{t('fc.minimum')}<span className="actions">
          <input id="fc-minimum" className="num" dir="ltr" inputMode="decimal" style={{ width: 130 }} disabled={!books.canPost} value={minimum ?? fmt(d?.minimumCash ?? '0')}
            onChange={(e) => setMinimum(e.target.value)} />
          {minimum !== undefined && <button className="b small p" id="fc-minimum-save" onClick={() => void saveMinimum()}>{t('save')}</button>}</span></label>
      </div>
      {msg && <div className="notice bad">{msg}</div>}
      {!d ? <Loading /> : <>
        <div className="grid">
          <div className="card fig"><small>{t('fc.cashToday')}</small><b className="ltr">{fmt(d.opening)}</b><small>{t('fc.cashTodaySub')}</small></div>
          <div className={`card fig ${toMinor(d.lowest.amount) < toMinor(d.minimumCash) ? 'over' : ''}`}><small>{t('fc.lowest')}</small><b className="ltr">{fmt(d.lowest.amount)}</b>
            <small>{t(grain === 'week' ? 'fc.inWeekOf' : 'fc.inMonthOf', { when: label(d.rows[d.lowest.period]!) })}</small></div>
          <div className="card fig"><small>{t('fc.ending')}</small><b className="ltr">{fmt(d.rows.at(-1)!.closing)}</b><small>{t('fc.endingSub', { date: d.rows.at(-1)!.end })}</small></div>
          <div className={`card fig ${below ? 'warn' : ''}`}><small>{t('fc.below')}</small><b>{below}</b><small>{t('fc.belowSub', { amount: fmt(d.minimumCash) })}</small></div>
        </div>
        {below > 0 && <div className="notice warn" id="fc-warning">⚠ {t('fc.warning', { when: label(d.rows.find((r) => r.belowMinimum)!), amount: fmt(d.minimumCash) })}</div>}
        <div className="card">
          <h2>{t('fc.chartTitle')}</h2>
          <BalanceChart rows={d.rows} minimum={d.minimumCash} label={label} cur={books.company.currency} onPick={(i) => setPick({ period: i, category: null })} />
        </div>
        <div className="card">
          <h2>{t('fc.tableTitle')}</h2>
          <div className="wrap"><table className="fc">
            <thead><tr><th />{d.rows.map((r, i) => <th key={r.start} className={`num ${r.belowMinimum ? 'fc-low' : ''}`}><button className="link" onClick={() => setPick({ period: i, category: null })}>{label(r)}</button></th>)}</tr></thead>
            <tbody>
              <tr className="fc-strong"><td>{t('fc.opening')}</td>{d.rows.map((r) => <td key={r.start} className="num">{fmt(r.opening)}</td>)}</tr>
              {used('in').map((c) => <tr key={c}><td>{t(`fc.c.${c}` as Key)}</td>{d.rows.map((r, i) => <td key={r.start} className="num">
                {toMinor(r.inflows[c] ?? '0') ? <button className="link" onClick={() => setPick({ period: i, category: c })}>{fmt(r.inflows[c]!)}</button> : <span className="mut">—</span>}</td>)}</tr>)}
              <tr className="fc-sum"><td>{t('fc.in')}</td>{d.rows.map((r) => <td key={r.start} className="num">{fmt(r.totalIn)}</td>)}</tr>
              {used('out').map((c) => <tr key={c}><td>{t(`fc.c.${c}` as Key)}</td>{d.rows.map((r, i) => <td key={r.start} className="num">
                {toMinor(r.outflows[c] ?? '0') ? <button className="link" onClick={() => setPick({ period: i, category: c })}>({fmt(r.outflows[c]!)})</button> : <span className="mut">—</span>}</td>)}</tr>)}
              <tr className="fc-sum"><td>{t('fc.out')}</td>{d.rows.map((r) => <td key={r.start} className="num">{toMinor(r.totalOut) ? `(${fmt(r.totalOut)})` : fmt(r.totalOut)}</td>)}</tr>
              <tr><td>{t('fc.net')}</td>{d.rows.map((r) => <td key={r.start} className={`num ${toMinor(r.net) < 0n ? 'bad' : ''}`}>{fmt(r.net)}</td>)}</tr>
              <tr className="fc-strong"><td>{t('fc.closing')}</td>{d.rows.map((r) => <td key={r.start} className={`num ${r.belowMinimum ? 'fc-low' : ''}`}>{r.belowMinimum ? '⚠ ' : ''}{fmt(r.closing)}</td>)}</tr>
            </tbody>
          </table></div>
          <p className="mut small">{t('fc.note')}</p>
        </div>
        {pick && <div className="card" id="fc-detail">
          <div className="actions"><h2 style={{ margin: 0 }}>{label(d.rows[pick.period]!)}{pick.category ? ` · ${t(`fc.c.${pick.category}` as Key)}` : ''}</h2><span className="spacer" />
            <button className="b small" onClick={() => setPick(undefined)}>{t('fc.close')}</button></div>
          {detail.length === 0 ? <div className="mut">{t('fc.nothing')}</div> : <table className="stack"><tbody>{detail.map((x, i) => (
            <tr key={`${x.label}${i}`}><td className="ltr small">{x.date}{x.overdue && <> <span className="badge warn">{t('fc.overdue')}</span></>}</td>
              <td>{x.ref ? <button className="link" onClick={() => open(x)}>{x.label}</button> : x.label}<div className="small mut">{t(`fc.c.${x.category}` as Key)}</div></td>
              <td className={`num ${x.direction === 'out' ? '' : 'good-text'}`}>{x.direction === 'out' ? `(${fmt(x.amount)})` : fmt(x.amount)}</td></tr>))}</tbody></table>}
        </div>}
        <Items books={books} onChange={f.reload} />
      </>}
    </>
  );
}

/** Closing cash per period as columns from zero, with the minimum cash as a dashed line; hover shows the figures. */
function BalanceChart({ rows, minimum, label, cur, onPick }: { rows: Row[]; minimum: string; label: (r: Row) => string; cur: string; onPick: (i: number) => void }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number>();
  const W = Math.max(560, rows.length * 48), H = 220, top = 14, bottom = 26, left = 6, right = 6;
  const vals = rows.map((r) => Number(r.closing));   // for drawing only; every figure shown comes from the strings
  const min = Math.min(0, ...vals, Number(minimum)), max = Math.max(0, ...vals, Number(minimum)) || 1;
  const y = (v: number) => top + ((max - v) / (max - min || 1)) * (H - top - bottom);
  const bw = (W - left - right) / rows.length;
  const bar = (i: number, v: number) => {
    const x = left + i * bw + 1, w = Math.max(2, bw - 2), y0 = y(0), y1 = y(v), r = Math.min(4, w / 2, Math.abs(y1 - y0));
    if (v >= 0) return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
    return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
  };
  const h = hover !== undefined ? rows[hover] : undefined;
  return (
    <div className="fc-chart" onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('fc.chartTitle')} preserveAspectRatio="none" style={{ width: '100%', height: H }}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="fc-axis" />
        {Number(minimum) > 0 && <line x1={0} x2={W} y1={y(Number(minimum))} y2={y(Number(minimum))} className="fc-min" />}
        {rows.map((r, i) => (
          <g key={r.start} onMouseEnter={() => setHover(i)} onClick={() => onPick(i)} style={{ cursor: 'pointer' }}>
            <rect x={left + i * bw} y={0} width={bw} height={H} fill="transparent" />
            <path d={bar(i, vals[i]!)} className={`fc-bar ${hover === i ? 'on' : ''}`} />
            {(i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 7) === 0) && <text x={left + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="fc-tick">{label(r)}</text>}
          </g>
        ))}
      </svg>
      {Number(minimum) > 0 && <div className="small mut fc-legend"><span className="fc-dash" /> {t('fc.minimumLine', { amount: fmt(minimum) })}</div>}
      {h && <div className="fc-tip" style={{ insetInlineStart: `${Math.min(80, ((hover! + 0.5) / rows.length) * 100)}%` }}>
        <b>{label(h)}</b> – {h.end}
        <div>{t('fc.in')}: <span className="ltr">{fmt(h.totalIn)}</span></div>
        <div>{t('fc.out')}: <span className="ltr">({fmt(h.totalOut)})</span></div>
        <div><b>{t('fc.closing')}: <span className="ltr">{fmt(h.closing)} {cur}</span></b>{h.belowMinimum && <> ⚠ {t('fc.belowShort')}</>}</div>
      </div>}
    </div>
  );
}

function Items({ books, onChange }: { books: CompanyBooks; onChange: () => void }) {
  const { t, has } = useI18n();
  const list = useApi<Item[]>(`/api/companies/${books.company.id}/forecast/items`);
  const [form, setForm] = useState<{ id?: string; description: string; direction: 'in' | 'out'; amount: string; firstDate: string; repeat: string; endDate: string; status?: string }>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>, id?: string) => {
    setBusy(true); setErr(undefined);
    try { await api(id ? `/api/forecast/items/${id}` : `/api/companies/${books.company.id}/forecast/items`, { body }); setForm(undefined); list.reload(); onChange(); }
    catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void save({ ...form, amount: form!.amount.replace(/,/g, ''), endDate: form!.endDate || null }, form!.id); };
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>{t('fc.itemsTitle')}</h2><span className="spacer" />
        {books.canPost && !form && <button className="b p" id="fc-new-item" onClick={() => setForm({ description: '', direction: 'out', amount: '', firstDate: today(), repeat: 'none', endDate: '' })}>{t('fc.newItem')}</button>}</div>
      <div className="small mut" style={{ marginBottom: 8 }}>{t('fc.itemsHint')}</div>
      {err && <div className="notice bad">{err}</div>}
      {form && (
        <form className="card inset" onSubmit={submit}>
          <div className="seg" role="radiogroup" style={{ marginBottom: 8 }}>
            {(['out', 'in'] as const).map((x) => <button type="button" key={x} id={`fc-item-${x}`} role="radio" aria-checked={form.direction === x} className={form.direction === x ? 'on' : ''} onClick={() => setForm({ ...form, direction: x })}>{t(`fc.dir.${x}` as Key)}</button>)}
          </div>
          <div className="row">
            <label className="f" style={{ flex: '2 1 240px' }}>{t('fc.what')}<input id="fc-item-desc" value={form.description} placeholder={t('fc.whatHint')} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <label className="f">{t('fc.amount')}<input id="fc-item-amount" className="num" dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('fc.date')}<input id="fc-item-date" type="date" value={form.firstDate} onChange={(e) => setForm({ ...form, firstDate: e.target.value })} /></label>
            <label className="f">{t('fc.repeat')}<select id="fc-item-repeat" value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
              {['none', 'weekly', 'monthly', 'quarterly', 'yearly'].map((r) => <option key={r} value={r}>{t(`fc.r.${r}` as Key)}</option>)}</select></label>
            {form.repeat !== 'none' && <label className="f">{t('fc.until')}<input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>}
          </div>
          <div className="actions"><button className="b p" id="fc-item-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut small">{t('fc.noItems')}</div> : (
        <table className="stack"><tbody>{list.data.map((x) => (
          <tr key={x.id} className={x.status === 'archived' ? 'mut' : ''}>
            <td><b>{x.description}</b><div className="small mut">{t(`fc.r.${x.repeat}` as Key)} · {x.firstDate}{x.endDate ? ` → ${x.endDate}` : ''}</div></td>
            <td className={`num ${x.direction === 'in' ? 'good-text' : ''}`} data-label={t('fc.amount')}>{x.direction === 'out' ? `(${fmt(x.amount)})` : fmt(x.amount)}</td>
            <td className="num">{books.canPost && <span className="actions" style={{ justifyContent: 'flex-end' }}>
              <button className="link small" onClick={() => setForm({ id: x.id, description: x.description, direction: x.direction, amount: x.amount, firstDate: x.firstDate, repeat: x.repeat, endDate: x.endDate ?? '', status: x.status })}>{t('cal.edit')}</button>
              <button className="link small" onClick={() => void save({ ...x, status: x.status === 'archived' ? 'active' : 'archived' }, x.id)}>{x.status === 'archived' ? t('cal.restore') : t('cal.archive')}</button>
            </span>}</td>
          </tr>
        ))}</tbody></table>
      )}
    </div>
  );
}
