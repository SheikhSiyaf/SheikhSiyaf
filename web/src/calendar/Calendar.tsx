// Compliance calendar: VAT, payroll, zakat or corporate tax, licence and document deadlines for one client, worked
// out from its country and settings, plus its own deadlines. Firm staff and the client accountant mark them done;
// view-only people read them.
import { useMemo, useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';

export type DeadlineKind = 'vat_return' | 'social_insurance' | 'wps' | 'zakat' | 'corporate_tax' | 'cr_renewal' | 'document_expiry' | 'custom';
export interface CalItem {
  key: string; kind: DeadlineKind; due: string; periodStart?: string; periodEnd?: string; ref?: string; docKind?: string; label?: string; labelAr?: string | null;
  status: 'done' | 'overdue' | 'soon' | 'later';
  done: { by: string | null; at: string; reference: string | null; note: string | null } | null;
}
interface Settings { vatFrequency: 'monthly' | 'quarterly'; vatQuarterEndMonth: number; zakat: boolean; corporateTax: boolean; payroll: boolean; socialInsurance: boolean; saved: boolean; canEdit: boolean }
interface Custom { id: string; title: string; titleAr: string | null; firstDue: string; repeat: string; notes: string | null; status: string; createdBy: string | null }

const locale = (lang: string) => (lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB');
export function useDates() {
  const { lang } = useI18n();
  const d = (s: string, o: Intl.DateTimeFormatOptions) => new Date(`${s}T00:00:00Z`).toLocaleDateString(locale(lang), { timeZone: 'UTC', ...o });
  return {
    month: (s: string) => d(s, { month: 'long', year: 'numeric' }),
    short: (s: string) => d(s, { month: 'short' }),
    day: (s: string) => d(s, { day: 'numeric', month: 'short', year: 'numeric' }),
    weekday: (s: string) => d(s, { weekday: 'short' }),
  };
}

/** A deadline's name and what it is for, in plain words. */
export function useDeadlineText(country: string) {
  const { t } = useI18n();
  const local = useLocalName();
  const dt = useDates();
  return (d: Pick<CalItem, 'kind' | 'periodStart' | 'periodEnd' | 'docKind' | 'label' | 'labelAr'>) => {
    const title = d.kind === 'custom' ? local(d.label ?? '', d.labelAr ?? null)
      : d.kind === 'social_insurance' ? t(country === 'AE' ? 'cal.k.si.AE' : 'cal.k.si.SA')
      : d.kind === 'cr_renewal' ? t(country === 'AE' ? 'cal.k.cr.AE' : 'cal.k.cr.SA')
      : d.kind === 'document_expiry' ? t('cal.k.doc', { kind: t(`hr.doc.${d.docKind ?? 'other'}` as Key) })
      : t(`cal.k.${d.kind}` as Key);
    const quarter = d.periodStart && d.periodEnd && d.periodStart.slice(0, 7) !== d.periodEnd.slice(0, 7);
    const detail = d.kind === 'document_expiry' ? d.label ?? ''
      : d.kind === 'zakat' || d.kind === 'corporate_tax' ? t('cal.yearEnded', { date: dt.day(d.periodEnd!) })
      : d.periodEnd ? (quarter ? `${dt.short(d.periodStart!)} – ${dt.month(d.periodEnd)}` : dt.month(d.periodEnd)) : '';
    return { title, detail };
  };
}

const STATUS_TONE: Record<CalItem['status'], string> = { done: 'good', overdue: 'bad', soon: 'warn', later: '' };

export function Calendar({ books, sub }: { books: CompanyBooks; sub: string }) {
  if (sub === 'calendar-settings') return <CalendarSettings books={books} />;
  return <Upcoming books={books} />;
}

// ------------------------------------------------------------------ upcoming
function Upcoming({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  const text = useDeadlineText(books.company.country);
  const list = useApi<CalItem[]>(`/api/companies/${books.company.id}/calendar`);
  const canEdit = Boolean(books.portal?.calendarEdit);
  const [filter, setFilter] = useState<'open' | 'overdue' | 'soon' | 'done' | 'all'>('open');
  const [view, setView] = useState<'list' | 'month'>('list');
  const [doneFor, setDoneFor] = useState<{ key: string; reference: string }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const now = today();
  const items = list.data ?? [];
  const shown = items.filter((i) => (filter === 'all' ? true : filter === 'open' ? i.status !== 'done' && (i.due >= now || i.status === 'overdue') : i.status === filter));
  const count = (s: CalItem['status']) => items.filter((i) => i.status === s).length;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); list.reload(); return true; } catch (e) { setMsg({ bad: errorText(t, has, e) }); return false; } finally { setBusy(false); }
  };
  const done = (e: FormEvent) => {
    e.preventDefault();
    const d = doneFor!;
    void run(() => api(`/api/companies/${books.company.id}/calendar/done`, { body: { key: d.key, reference: d.reference } }), t('cal.markedDone')).then((x) => x && setDoneFor(undefined));
  };
  const link = (i: CalItem): [string, () => void] | null =>
    i.kind === 'vat_return' ? [t('cal.openVat'), () => go('Reports', 'vat-return')]
    : i.kind === 'social_insurance' || i.kind === 'wps' ? [t('cal.openPayroll'), () => go('HRM', 'payroll')]
    : i.kind === 'document_expiry' ? [t('cal.openDocs'), () => go('HRM', 'hr-documents')]
    : null;
  // Group the list by month of the due date.
  const groups = useMemo(() => {
    const g = new Map<string, CalItem[]>();
    for (const i of shown) { const k = i.due.slice(0, 7); g.set(k, [...(g.get(k) ?? []), i]); }
    return [...g.entries()];
  }, [shown]);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  return (
    <>
      <div className="grid">
        <button className={`card fig tile ${count('overdue') ? 'over' : ''}`} onClick={() => setFilter('overdue')}><small>{t('cal.overdue')}</small><b>{count('overdue')}</b><small>{t('cal.overdueSub')}</small></button>
        <button className={`card fig tile ${count('soon') ? 'warn' : ''}`} onClick={() => setFilter('soon')}><small>{t('cal.soon')}</small><b>{count('soon')}</b><small>{t('cal.soonSub')}</small></button>
        <button className="card fig tile" onClick={() => setFilter('open')}><small>{t('cal.later')}</small><b>{count('later')}</b><small>{t('cal.laterSub')}</small></button>
        <button className="card fig tile" onClick={() => setFilter('done')}><small>{t('cal.done')}</small><b>{count('done')}</b><small>{t('cal.doneSub')}</small></button>
      </div>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="seg" role="radiogroup" aria-label={t('cal.show')}>
          {(['open', 'overdue', 'soon', 'done', 'all'] as const).map((f) => <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{t(`cal.f.${f}` as Key)}</button>)}
        </div>
        <span className="spacer" />
        <div className="seg" role="radiogroup" aria-label={t('cal.view')}>
          {(['list', 'month'] as const).map((v) => <button key={v} id={`cal-view-${v}`} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{t(`cal.v.${v}` as Key)}</button>)}
        </div>
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {!list.data ? <Loading /> : view === 'month' ? <MonthGrid items={items} text={text} /> : groups.length === 0 ? <div className="card mut">{t('cal.none')}</div> : groups.map(([ym, rows]) => (
        <div className="card" key={ym}>
          <h2>{dt.month(`${ym}-01`)}</h2>
          <table className="stack cal"><tbody>{rows.map((i) => {
            const { title, detail } = text(i);
            const l = link(i);
            return (
              <tr key={i.key} className={i.status === 'done' ? 'mut' : ''}>
                <td className="cal-date"><b>{i.due.slice(8)}</b><small>{dt.weekday(i.due)}</small></td>
                <td><b>{title}</b>{detail && <div className="small mut">{detail}</div>}
                  {i.done && <div className="small good-text">✓ {t('cal.doneBy', { name: i.done.by ?? '', date: i.done.at.slice(0, 10) })}{i.done.reference ? ` · ${i.done.reference}` : ''}</div>}
                  {doneFor?.key === i.key && (
                    <form className="actions" style={{ marginTop: 6 }} onSubmit={done}>
                      <input id="cal-ref" aria-label={t('cal.reference')} placeholder={t('cal.referenceHint')} value={doneFor.reference} onChange={(e) => setDoneFor({ ...doneFor, reference: e.target.value })} />
                      <button className="b small p" id="cal-save-done" disabled={busy}>{t('cal.markDone')}</button>
                      <button type="button" className="b small" onClick={() => setDoneFor(undefined)}>{t('cancel')}</button>
                    </form>)}
                </td>
                <td data-label={t('cal.status')}><span className={`badge ${STATUS_TONE[i.status]}`}>{t(`cal.s.${i.status}` as Key)}</span></td>
                <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                  {l && <button className="link small" onClick={l[1]}>{l[0]}</button>}
                  {canEdit && !i.done && doneFor?.key !== i.key && <button className="b small" onClick={() => setDoneFor({ key: i.key, reference: '' })}>{t('cal.markDone')}</button>}
                  {canEdit && i.done && <button className="link small" onClick={() => void run(() => api(`/api/companies/${books.company.id}/calendar/undo`, { body: { key: i.key } }))}>{t('cal.undo')}</button>}
                </span></td>
              </tr>
            );
          })}</tbody></table>
        </div>
      ))}
      <p className="mut small">{t('cal.rulesNote')}</p>
    </>
  );
}

/** A month at a glance: each day shows its deadlines. */
function MonthGrid({ items, text }: { items: CalItem[]; text: ReturnType<typeof useDeadlineText> }) {
  const { t, lang } = useI18n();
  const dt = useDates();
  const now = today();
  const [ym, setYm] = useState(now.slice(0, 7));
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;   // weeks start on Monday
  const move = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setYm(d.toISOString().slice(0, 7)); };
  const names = [...Array(7)].map((_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(locale(lang), { weekday: 'short', timeZone: 'UTC' }));
  const cells = [...Array(lead).fill(null), ...[...Array(days)].map((_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)];
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <button className="b small" aria-label={t('cal.prev')} onClick={() => move(-1)}>{lang === 'ar' ? '›' : '‹'}</button>
        <h2 style={{ margin: 0 }}>{dt.month(`${ym}-01`)}</h2>
        <button className="b small" aria-label={t('cal.next')} onClick={() => move(1)}>{lang === 'ar' ? '‹' : '›'}</button>
        <span className="spacer" />
        <button className="b small" onClick={() => setYm(now.slice(0, 7))}>{t('cal.thisMonth')}</button>
      </div>
      <div className="calgrid">
        {names.map((n) => <div key={n} className="calhead">{n}</div>)}
        {cells.map((d, i) => d === null ? <div key={`x${i}`} className="calday empty" /> : (
          <div key={d} className={`calday ${d === now ? 'today' : ''}`}>
            <span className="calnum">{Number(d.slice(8))}</span>
            {items.filter((x) => x.due === d).map((x) => <span key={x.key} className={`calitem ${STATUS_TONE[x.status]}`} title={text(x).title}>{text(x).title}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings and own deadlines
function CalendarSettings({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const dt = useDates();
  const s = useApi<Settings>(`/api/companies/${books.company.id}/calendar/settings`);
  const custom = useApi<Custom[]>(`/api/companies/${books.company.id}/calendar/custom?all=1`);
  const [edit, setEdit] = useState<Settings>();
  const [form, setForm] = useState<{ id?: string; title: string; titleAr: string; firstDue: string; repeat: string; notes: string; status?: string }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg({});
    try { await fn(); setMsg({ ok }); s.reload(); custom.reload(); return true; } catch (e) { setMsg({ bad: errorText(t, has, e) }); return false; } finally { setBusy(false); }
  };
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const v = edit ?? s.data;
  const canEdit = s.data.canEdit;
  const country = books.company.country;
  const hrm = (books.company.modules ?? []).includes('HRM');
  const toggle = (k: 'zakat' | 'corporateTax' | 'payroll' | 'socialInsurance', label: string, hint: string) => (
    <label className="check-one" key={k}><input type="checkbox" id={`cal-${k}`} disabled={!canEdit} checked={v[k]} onChange={(e) => setEdit({ ...v, [k]: e.target.checked })} />
      <span>{label}<div className="small mut">{hint}</div></span></label>);
  const quarters = (q: number) => [0, 3, 6, 9].map((o) => dt.short(`2026-${String(q + o).padStart(2, '0')}-01`)).join(', ');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const url = form?.id ? `/api/calendar/custom/${form.id}` : `/api/companies/${books.company.id}/calendar/custom`;
    void run(() => api(url, { body: form }), t('cal.customSaved')).then((x) => x && setForm(undefined));
  };
  return (
    <>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/calendar/settings`, { body: v }), t('cal.settingsSaved')).then((x) => x && setEdit(undefined)); }}>
        <h2>{t('cal.settingsTitle')}</h2>
        {!canEdit && <div className="notice small">{t('cal.viewOnly')}</div>}
        {books.company.vatStatus === 'registered' ? <>
          <div className="small" style={{ marginBottom: 4 }}>{t('cal.vatFrequency')}</div>
          <div className="seg" role="radiogroup" style={{ marginBottom: 8 }}>
            {(['quarterly', 'monthly'] as const).map((f) => <button type="button" key={f} id={`cal-vat-${f}`} role="radio" aria-checked={v.vatFrequency === f} disabled={!canEdit} className={v.vatFrequency === f ? 'on' : ''} onClick={() => setEdit({ ...v, vatFrequency: f })}>{t(`cal.vat.${f}` as Key)}</button>)}
          </div>
          {v.vatFrequency === 'quarterly' && <label className="f">{t('cal.quartersEnd')}
            <select id="cal-quarter" disabled={!canEdit} value={v.vatQuarterEndMonth} onChange={(e) => setEdit({ ...v, vatQuarterEndMonth: Number(e.target.value) })}>
              {[3, 1, 2].map((q) => <option key={q} value={q}>{quarters(q)}</option>)}
            </select></label>}
          <div className="small mut" style={{ marginBottom: 10 }}>{t(`cal.vatHint.${country}` as Key)}</div>
        </> : <div className="small mut" style={{ marginBottom: 10 }}>{t('cal.noVat')}</div>}
        <div className="checks">
          {country === 'SA' && toggle('zakat', t('cal.k.zakat'), t('cal.zakatHint'))}
          {country === 'AE' && toggle('corporateTax', t('cal.k.corporate_tax'), t('cal.ctHint'))}
          {hrm && country !== 'OM' && toggle('socialInsurance', t(country === 'AE' ? 'cal.k.si.AE' : 'cal.k.si.SA'), t(`cal.siHint.${country}` as Key))}
          {hrm && country === 'AE' && toggle('payroll', t('cal.k.wps'), t('cal.wpsHint'))}
        </div>
        {!hrm && <div className="small mut">{t('cal.noHrm')}</div>}
        {canEdit && <div className="actions" style={{ marginTop: 10 }}><button className="b p" id="cal-save-settings" disabled={busy || !edit}>{t('save')}</button></div>}
      </form>
      <div className="card">
        <div className="actions" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{t('cal.ownTitle')}</h2><span className="spacer" />
          {canEdit && !form && <button className="b p" id="cal-new" onClick={() => setForm({ title: '', titleAr: '', firstDue: today(), repeat: 'yearly', notes: '' })}>{t('cal.newOwn')}</button>}
        </div>
        <div className="small mut" style={{ marginBottom: 8 }}>{t('cal.ownHint')}</div>
        {form && (
          <form className="card inset" onSubmit={save}>
            <div className="row">
              <label className="f">{t('cal.ownName')}<input id="cal-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <label className="f">{t('cal.ownNameAr')}<input id="cal-title-ar" dir="rtl" value={form.titleAr} onChange={(e) => setForm({ ...form, titleAr: e.target.value })} /></label>
            </div>
            <div className="row">
              <label className="f">{t('cal.firstDue')}<input id="cal-first" type="date" value={form.firstDue} onChange={(e) => setForm({ ...form, firstDue: e.target.value })} /></label>
              <label className="f">{t('cal.repeat')}<select id="cal-repeat" value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
                {['none', 'monthly', 'quarterly', 'yearly'].map((r) => <option key={r} value={r}>{t(`cal.r.${r}` as Key)}</option>)}</select></label>
            </div>
            <label className="f">{t('cal.notes')}<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            <div className="actions"><button className="b p" id="cal-save-own" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        {!custom.data ? <Loading /> : custom.data.length === 0 ? <div className="mut small">{t('cal.ownNone')}</div> : (
          <table className="stack"><tbody>{custom.data.map((c) => (
            <tr key={c.id} className={c.status === 'archived' ? 'mut' : ''}>
              <td><b>{local(c.title, c.titleAr)}</b>{c.notes && <div className="small mut">{c.notes}</div>}</td>
              <td data-label={t('cal.firstDue')}>{dt.day(c.firstDue)}</td>
              <td data-label={t('cal.repeat')}>{t(`cal.r.${c.repeat}` as Key)}{c.status === 'archived' && <> <span className="badge">{t('cal.archived')}</span></>}</td>
              <td className="num">{canEdit && <span className="actions" style={{ justifyContent: 'flex-end' }}>
                <button className="link small" onClick={() => setForm({ id: c.id, title: c.title, titleAr: c.titleAr ?? '', firstDue: c.firstDue, repeat: c.repeat, notes: c.notes ?? '', status: c.status })}>{t('cal.edit')}</button>
                <button className="link small" onClick={() => void run(() => api(`/api/calendar/custom/${c.id}`, { body: { ...c, status: c.status === 'archived' ? 'active' : 'archived' } }), t('cal.customSaved'))}>{c.status === 'archived' ? t('cal.restore') : t('cal.archive')}</button>
              </span>}</td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
      <p className="mut small">{t('cal.rulesNote')}</p>
    </>
  );
}
