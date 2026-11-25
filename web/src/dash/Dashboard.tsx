// The client home page as a dashboard. A grid of widgets from the company's own books; each person can change their own view
// (move, resize, add, remove, rename, change a widget's period or chart type, then Save or Cancel, or Reset to the default), and the company's
// Administrator sets the default for the company or for a role in DefaultsEditor, using sample figures only.
// The grid is plain CSS (12 columns, four size presets) so it mirrors by itself in Arabic and stacks on a phone; widgets move by drag or by the arrows.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { navigate } from '../router.ts';
import { useGo } from '../sales/common.tsx';
import { useDates } from '../calendar/Calendar.tsx';
import { PERIOD_KINDS, SIZES, validDate } from '../../../src/books/dashboardRules.ts';
import { sampleResult } from './samples.ts';
import { WidgetBody } from './Widgets.tsx';
import type { Catalog, Dash, Defaults, LayoutDoc, LayoutWidget, Period, PeriodKind, Result } from './types.ts';

const newId = () => `w_${Math.random().toString(36).slice(2, 10)}`;
const T = (t: (k: Key, p?: Record<string, string | number>) => string, k: string, p?: Record<string, string | number>) => t(k as Key, p);

function useGoTo(companyId: string) {
  const go = useGo(companyId);
  return (module: string, sub?: string, item?: string, extra?: string) => go(module, sub, item, extra);
}

// ---------------------------------------------------------------- period picker
function PeriodPicker({ value, onChange, shared, id }: { value: Period | undefined; onChange: (p: Period | undefined) => void; shared?: boolean; id?: string }) {
  const { t } = useI18n();
  const kind = value?.kind ?? (shared ? undefined : 'this_month');
  const [from, setFrom] = useState(value?.from ?? '');
  const [to, setTo] = useState(value?.to ?? '');
  const apply = (f: string, e: string) => { if (validDate(f) && validDate(e) && f <= e) onChange({ kind: 'custom', from: f, to: e }); };
  return (
    <span className="dash-period">
      <select id={id} aria-label={t('dash.period')} value={kind ?? ''} onChange={(e) => {
        const k = e.target.value;
        if (!k) onChange(undefined);
        else if (k === 'custom') { const today = new Date().toISOString().slice(0, 10); const f = from || `${today.slice(0, 7)}-01`, e2 = to || today; setFrom(f); setTo(e2); onChange({ kind: 'custom', from: f, to: e2 }); }
        else onChange({ kind: k as PeriodKind });
      }}>
        {shared && <option value="">{t('dash.period.shared')}</option>}
        {PERIOD_KINDS.map((k) => <option key={k} value={k}>{T(t, `dash.p.${k}`)}</option>)}
      </select>
      {kind === 'custom' && (
        <>
          <input type="date" dir="ltr" aria-label={t('dash.from')} value={from} onChange={(e) => { setFrom(e.target.value); apply(e.target.value, to); }} />
          <input type="date" dir="ltr" aria-label={t('dash.to')} value={to} onChange={(e) => { setTo(e.target.value); apply(from, e.target.value); }} />
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- one widget
interface CardProps {
  item: LayoutWidget; def: Catalog; result?: Result; sample?: boolean; editing: boolean; first: boolean; last: boolean;
  ctx: { currency: string; books?: CompanyBooks; today: string; sample?: boolean };
  onChange: (w: LayoutWidget) => void; onRemove: () => void; onMove: (by: -1 | 1) => void;
  dragProps: Record<string, unknown>; go: (m: string, s?: string, i?: string, e?: string) => void;
}

function Card({ item, def, result, editing, first, last, ctx, onChange, onRemove, onMove, dragProps, go }: CardProps) {
  const { t } = useI18n();
  const dt = useDates();
  const title = item.title || T(t, `dash.w.${item.type}`);
  const open = (r: Result) => {
    const d = r.drill; if (!d) return;
    const q = new URLSearchParams(d.query).toString();
    const parts = [d.module, d.sub, d.item, d.extra].filter((x) => x !== undefined && x !== '');
    navigate(`/c/${ctx.books?.company.id}/${parts.join('/')}${q ? `?${q}` : ''}`);
  };
  const dates = result?.from && result.to && def.usesPeriod ? (['cash', 'receivables', 'payables', 'overdue_invoices', 'bills_due'].includes(item.type) ? t('dash.asOf', { date: dt.day(result.to) }) : t('dash.range', { from: dt.day(result.from), to: dt.day(result.to) })) : '';
  return (
    <section className={`dw ${editing ? 'editing' : ''}`} data-size={item.size} data-type={item.type} data-id={item.id} aria-label={title} {...dragProps}>
      <header>
        <h3>{title}</h3>
        {ctx.sample && <span className="badge dw-sample">{t('dash.sample')}</span>}
        {editing && <span className="dw-grip" aria-hidden="true" title={t('dash.drag')}>⠿</span>}
      </header>
      <div className="dw-body">
        {!result ? <p className="small mut">{t('dash.loading')}</p> : result.state === 'error' ? <p className="small bad">{t('dash.error')}</p> : <WidgetBody item={item} result={result} ctx={ctx} go={go} />}
      </div>
      {!editing && result && result.state !== 'error' && (
        <footer>
          <span className="small mut dw-dates">{dates}</span>
          {result.foreign && <span className="small mut dw-foreign">{t('dash.foreign', { cur: ctx.currency })}</span>}
          {!ctx.sample && result.drill && result.drill.sub && <button className="link small dw-report" onClick={() => open(result)}>{t('dash.viewReport')}</button>}
        </footer>
      )}
      {editing && (
        <div className="dw-edit" role="group" aria-label={t('dash.widgetEdit', { title })}>
          <label className="f">{t('dash.rename')}<input maxLength={60} value={item.title ?? ''} placeholder={T(t, `dash.w.${item.type}`)} onChange={(e) => onChange({ ...item, title: e.target.value || undefined })} /></label>
          <label className="f">{t('dash.size')}
            <select value={item.size} onChange={(e) => onChange({ ...item, size: e.target.value as LayoutWidget['size'] })}>{SIZES.filter((s) => def.sizes.includes(s)).map((s) => <option key={s} value={s}>{T(t, `dash.size.${s}`)}</option>)}</select></label>
          {def.charts.length > 1 && (
            <label className="f">{t('dash.chart')}
              <select value={item.chart ?? def.defaultChart} onChange={(e) => onChange({ ...item, chart: e.target.value })}>{def.charts.map((c) => <option key={c} value={c}>{T(t, `dash.chart.${c}`)}</option>)}</select></label>
          )}
          {def.usesPeriod && <label className="f">{t('dash.period')}<PeriodPicker shared value={item.period} onChange={(p) => onChange({ ...item, period: p })} /></label>}
          <div className="actions">
            <button className="b small" disabled={first} aria-label={t('dash.moveUp')} title={t('dash.moveUp')} onClick={() => onMove(-1)}>↑</button>
            <button className="b small" disabled={last} aria-label={t('dash.moveDown')} title={t('dash.moveDown')} onClick={() => onMove(1)}>↓</button>
            <span className="spacer" />
            <button className="link small bad dw-remove" onClick={onRemove}>{t('dash.remove')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the grid (used on the home page and in the Administrator's editor)
interface GridProps {
  doc: LayoutDoc; catalog: Catalog[]; results: Record<string, Result>; editing: boolean; onDoc: (d: LayoutDoc) => void;
  ctx: { currency: string; books?: CompanyBooks; today: string; sample?: boolean }; go: (m: string, s?: string, i?: string, e?: string) => void;
}

function Grid({ doc, catalog, results, editing, onDoc, ctx, go }: GridProps) {
  const [drag, setDrag] = useState<string>();
  const widgets = doc.widgets.filter((w) => catalog.some((c) => c.key === w.type));
  const move = (id: string, to: number) => {
    const from = doc.widgets.findIndex((w) => w.id === id);
    if (from < 0 || to < 0 || to >= doc.widgets.length || from === to) return;
    const next = [...doc.widgets]; const [x] = next.splice(from, 1); next.splice(to, 0, x!);
    onDoc({ ...doc, widgets: next });
  };
  return (
    <div className="dgrid" id="dash-grid" data-editing={editing ? '1' : undefined}>
      {widgets.map((w, i) => {
        const def = catalog.find((c) => c.key === w.type)!;
        const idx = doc.widgets.findIndex((x) => x.id === w.id);
        return (
          <Card key={w.id} item={w} def={def} result={results[w.id]} editing={editing} first={idx === 0} last={idx === doc.widgets.length - 1} ctx={ctx} go={go}
            onChange={(nw) => onDoc({ ...doc, widgets: doc.widgets.map((x) => (x.id === w.id ? nw : x)) })} onRemove={() => onDoc({ ...doc, widgets: doc.widgets.filter((x) => x.id !== w.id) })} onMove={(by) => move(w.id, idx + by)}
            dragProps={editing ? { draggable: true, onDragStart: (e: React.DragEvent) => { setDrag(w.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); },
              onDragOver: (e: React.DragEvent) => { if (drag) e.preventDefault(); }, onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag) move(drag, idx); setDrag(undefined); }, onDragEnd: () => setDrag(undefined) } : {}} />
        );
      })}
      {widgets.length === 0 && <div className="dw-none card" id="dash-none"><SomethingEmpty editing={editing} /></div>}
    </div>
  );
}
function SomethingEmpty({ editing }: { editing: boolean }) {
  const { t } = useI18n();
  return <p className="mut">{editing ? t('dash.noneEditing') : t('dash.none')}</p>;
}

// ---------------------------------------------------------------- the gallery of widgets to add (previews use sample figures)
function Gallery({ catalog, today, currency, onAdd, onClose }: { catalog: Catalog[]; today: string; currency: string; onAdd: (c: Catalog) => void; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="wiz-back" id="dash-gallery" role="dialog" aria-modal="true" aria-label={t('dash.gallery')}>
      <div className="wiz dash-gallery" tabIndex={-1} ref={ref}>
        <div className="actions"><h2 style={{ margin: 0 }}>{t('dash.gallery')}</h2><span className="spacer" /><button className="b" id="dash-gallery-close" onClick={onClose}>{t('ck.close')}</button></div>
        <p className="small mut">{t('dash.galleryHint')}</p>
        <div className="dash-gallery-list">
          {catalog.map((c) => (
            <div key={c.key} className="dash-gallery-item" data-type={c.key}>
              <div className="actions"><b>{T(t, `dash.w.${c.key}`)}</b><span className="spacer" /><button className="b p small" onClick={() => onAdd(c)} aria-label={`${t('dash.add')}: ${T(t, `dash.w.${c.key}`)}`}>{t('dash.addShort')}</button></div>
              <p className="small mut">{T(t, `dash.d.${c.key}`)}</p>
              <div className="dash-preview" aria-hidden="true">
                <Card item={{ id: `p_${c.key}`, type: c.key, size: c.defaultSize as LayoutWidget['size'] }} def={c} result={sampleResult(`p_${c.key}`, c.key, today)} sample editing={false} first last
                  ctx={{ currency, today, sample: true }} onChange={() => undefined} onRemove={() => undefined} onMove={() => undefined} dragProps={{}} go={() => undefined} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function useWidgetData(companyId: string | null, doc: LayoutDoc | undefined, period: Period | undefined, catalog: Catalog[]) {
  const [state, setState] = useState<{ results: Record<string, Result>; error?: string; key: string }>({ results: {}, key: '' });
  const { t, has } = useI18n();
  const request = useMemo(() => (doc && companyId ? { period: period ?? doc.period, widgets: doc.widgets.filter((w) => catalog.some((c) => c.key === w.type)).map((w) => ({ id: w.id, type: w.type, ...(w.period ? { period: w.period } : {}) })) } : null), [doc, period, companyId, catalog]);
  const key = JSON.stringify(request);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!request || !companyId) return;
    let live = true;
    api<{ results: Result[] }>(`/api/companies/${companyId}/dashboard/data`, { body: request })
      .then((r) => live && setState({ results: Object.fromEntries(r.results.map((x) => [x.id, x])), key }))
      .catch((e) => live && setState({ results: {}, error: errorText(t, has, e), key }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, companyId, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

// ---------------------------------------------------------------- the home page
export function Dashboard({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const id = books.company.id;
  const go = useGoTo(id);
  const d = useApi<Dash>(`/api/companies/${id}/dashboard`);
  const [draft, setDraft] = useState<LayoutDoc>();
  const [viewPeriod, setViewPeriod] = useState<Period>();
  const [gallery, setGallery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [fresh, setFresh] = useState<Dash>();   // what the server answered to the last save or reset, shown until the page has reloaded
  useEffect(() => setFresh(undefined), [d.data]);
  const cur = fresh ?? d.data;
  const editing = !!draft;
  const doc = draft ?? cur?.layout;
  const period = editing ? draft!.period : viewPeriod ?? doc?.period;
  const catalog = cur?.catalog ?? [];
  const data = useWidgetData(cur ? id : null, doc, period, catalog);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!cur || !doc) return <Loading />;
  // "forbidden" results (a role changed under an open page) are dropped without a word
  const visibleDoc: LayoutDoc = { ...doc, widgets: doc.widgets.filter((w) => data.results[w.id]?.state !== 'forbidden') };
  const run = async (fn: () => Promise<Dash>, ok?: string) => {
    setBusy(true); setMsg({});
    try { const r = await fn(); setFresh(r); d.reload(); setDraft(undefined); setViewPeriod(undefined); if (ok) setMsg({ ok }); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const addWidget = (c: Catalog) => {
    setDraft((x) => x && ({ ...x, widgets: [...x.widgets, { id: newId(), type: c.key, size: c.defaultSize as LayoutWidget['size'] }] }));
    setGallery(false);
  };
  const ctx = { currency: cur.currency, books, today: cur.today };
  return (
    <section id="dashboard" aria-label={t('dash.title')}>
      <div className="dash-bar actions" id="dash-bar">
        <label className="f dash-shared">{t('dash.period')}
          <PeriodPicker id="dash-period" value={period} onChange={(p) => (editing ? setDraft({ ...draft!, period: p ?? { kind: 'this_month' } }) : setViewPeriod(p ?? doc.period))} />
        </label>
        <span className="spacer" />
        {!editing && <button className="b" id="dash-edit" onClick={() => { setMsg({}); setDraft(structuredClone({ ...doc, period: period ?? doc.period })); }}>{t('dash.edit')}</button>}
        {editing && (
          <>
            <button className="b" id="dash-add" onClick={() => setGallery(true)}>{t('dash.add')}</button>
            <button className="b" id="dash-reset" disabled={busy} onClick={() => { if (window.confirm(t('dash.resetConfirm'))) void run(() => api<Dash>(`/api/companies/${id}/dashboard/reset`, { body: {} }), t('dash.resetDone')); }}>{t('dash.reset')}</button>
            <button className="b" id="dash-cancel" disabled={busy} onClick={() => { setDraft(undefined); setMsg({}); }}>{t('dash.cancel')}</button>
            <button className="b p" id="dash-save" disabled={busy} onClick={() => void run(() => api<Dash>(`/api/companies/${id}/dashboard`, { body: draft }), t('dash.saved'))}>{t('dash.save')}</button>
          </>
        )}
      </div>
      {editing && <p className="notice small" id="dash-hint">{t('dash.editHint')}</p>}
      {msg.ok && <div className="notice good" role="status" id="dash-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" id="dash-error">{msg.bad}</div>}
      {data.error && <ErrorNote error={{ message: data.error } as never} onRetry={data.reload} />}
      <Grid doc={visibleDoc} catalog={catalog} results={data.results} editing={editing} onDoc={(x) => setDraft(x)} ctx={ctx} go={go} />
      {gallery && <Gallery catalog={catalog} today={cur.today} currency={cur.currency} onAdd={addWidget} onClose={() => setGallery(false)} />}
      {!editing && cur.source !== 'user' && cur.source !== 'default' && <p className="small mut" id="dash-source">{t(cur.source === 'role' ? 'dash.sourceRole' : 'dash.sourceCompany')}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- the Administrator's defaults (sample figures only: an Administrator never sees the books)
export function DefaultsEditor({ companyId, currency }: { companyId: string; currency: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const d = useApi<Defaults>(`/api/companies/${companyId}/dashboard/defaults`);
  const [scope, setScope] = useState<'company' | string>('company');   // 'company' or a role id
  const [draft, setDraft] = useState<LayoutDoc>();
  const [gallery, setGallery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const today = new Date().toISOString().slice(0, 10);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const saved = scope === 'company' ? d.data.company : d.data.roles.find((r) => r.id === scope)?.layout ?? null;
  const doc = draft ?? saved ?? d.data.builtIn;
  const results = Object.fromEntries(doc.widgets.map((w) => [w.id, sampleResult(w.id, w.type, today)]));
  const post = async (layout: LayoutDoc | null, ok: string) => {
    setBusy(true); setMsg({});
    try { await api(`/api/companies/${companyId}/dashboard/defaults`, { body: { scope: scope === 'company' ? 'company' : 'role', ...(scope === 'company' ? {} : { roleId: scope }), layout } }); d.reload(); setDraft(undefined); setMsg({ ok }); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return (
    <details className="card" id="dash-defaults">
      <summary><h2 style={{ display: 'inline' }}>{t('dash.ad.title')}</h2></summary>
      <p className="small mut">{t('dash.ad.intro')}</p>
      <p className="small mut">{t('dash.ad.order')}</p>
      <div className="actions">
        <label className="f">{t('dash.ad.choose')}
          <select id="dash-scope" value={scope} onChange={(e) => { setScope(e.target.value); setDraft(undefined); setMsg({}); }}>
            <option value="company">{t('dash.ad.forCompany')}</option>
            {d.data.roles.map((r) => <option key={r.id} value={r.id}>{t('dash.ad.forRole', { role: local(r.name, r.nameAr) })}{r.layout ? ' ✓' : ''}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <button className="b" id="dash-ad-add" onClick={() => { if (!draft) setDraft(structuredClone(doc)); setGallery(true); }}>{t('dash.add')}</button>
        {saved && <button className="b" id="dash-ad-clear" disabled={busy} onClick={() => void post(null, t('dash.ad.cleared'))}>{t('dash.ad.clear')}</button>}
        <button className="b p" id="dash-ad-save" disabled={busy || !draft} onClick={() => draft && void post(draft, t('dash.ad.saved'))}>{t('dash.save')}</button>
      </div>
      {!saved && !draft && <p className="small" id="dash-ad-none">{t('dash.ad.none')}</p>}
      {msg.ok && <div className="notice good" role="status" id="dash-ad-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="dash-bar actions"><label className="f dash-shared">{t('dash.period')}<PeriodPicker value={doc.period} onChange={(p) => setDraft({ ...doc, period: p ?? { kind: 'this_month' } })} /></label></div>
      <Grid doc={doc} catalog={d.data.catalog} results={results} editing onDoc={(x) => setDraft(x)} ctx={{ currency, today, sample: true }} go={() => undefined} />
      {gallery && <Gallery catalog={d.data.catalog} today={today} currency={currency} onAdd={(c) => { setDraft((x) => ({ ...(x ?? doc), widgets: [...(x ?? doc).widgets, { id: newId(), type: c.key, size: c.defaultSize as LayoutWidget['size'] }] })); setGallery(false); }} onClose={() => setGallery(false)} />}
    </details>
  );
}
