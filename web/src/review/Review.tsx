// Review: one month at a glance, automated checks, queries between the firm and the client, the monthly
// checklist and sign-off. Firm staff review; partners and reviewers sign off; client users read and answer.
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { moduleForType, pageForType } from '../books/nav.ts';

const lastMonthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10); };
const monthEndOf = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

interface Finding { itemKey: string; date: string | null; label: string; detail: string | null; amount: string | null; link: { type: string; id: string; docType?: string } | null;
  explained: { note: string; by: string | null; at: string } | null }
interface Check { key: string; severity: 'warning' | 'info'; findings: Finding[]; open: number }
interface QueryRow { id: string; periodEnd: string; subject: string; aboutType: string | null; aboutId: string | null; aboutLabel: string | null; status: string; raisedBy: string | null;
  raisedAt: string; closedBy: string | null; closedAt: string | null; messages: number; lastAt: string | null }
type QueryDetail = Omit<QueryRow, 'messages'> & { companyId: string };
interface MonthRow { periodEnd: string; signoff: { id: string; note: string | null; signedBy: string; signedAt: string; changedAfter: number } | null;
  lastWithdrawn: { by: string; at: string; reason: string } | null; openQueries: number; queries: number }
interface Checklist { periodEnd: string; items: { item: string; auto: boolean | null; ticked: boolean; note: string | null; by: string | null; at: string | null; done: boolean }[]; done: number; total: number }
interface Overview extends MonthRow { checks: { key: string; severity: string; open: number; total: number }[]; openFindings: number; checklist: { done: number; total: number };
  reviewedUpTo: { periodEnd: string; signedBy: string; signedAt: string } | null }

function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string; details?: string[] }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); return true; } catch (e) { setMsg({ bad: errorText(t, has, e), details: (e as { details?: string[] }).details }); return false; } finally { setBusy(false); }
  };
  const notes = <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}
    {msg.details?.length ? <> {msg.details.map((d) => (has(`rv.item.${d}`) ? t(`rv.item.${d}` as Key) : d)).join(', ')}</> : null}</div>}</>;
  return { run, busy, notes };
}
function useMonthName() {
  const { lang } = useI18n();
  return (pe: string) => new Date(`${pe.slice(0, 7)}-01T00:00:00Z`).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function MonthPicker({ value, onChange }: { value: string; onChange: (pe: string) => void }) {
  const { t } = useI18n();
  return <label className="f">{t('rv.month')}<input id="rv-month" type="month" value={value.slice(0, 7)} max={today().slice(0, 7)} onChange={(e) => e.target.value && onChange(monthEndOf(e.target.value))} /></label>;
}
const Fig = ({ label, value, sub, tone, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; onClick?: () => void }) =>
  onClick ? <button className={`card fig tile ${tone ?? ''}`} onClick={onClick}><small>{label}</small><b>{value}</b>{sub && <small>{sub}</small>}</button>
    : <div className={`card fig ${tone ?? ''}`}><small>{label}</small><b>{value}</b>{sub && <small>{sub}</small>}</div>;

export function Review({ books, sub, item }: { books: CompanyBooks; sub: string; item?: string }) {
  const [pe, setPe] = useState(lastMonthEnd());
  const picker = <MonthPicker value={pe} onChange={setPe} />;
  if (sub === 'checks') return <Checks books={books} pe={pe} picker={picker} />;
  if (sub === 'queries') return item ? <QueryPage key={item} books={books} id={item} /> : <Queries books={books} pe={pe} picker={picker} />;
  if (sub === 'checklist') return <ChecklistPage books={books} pe={pe} picker={picker} />;
  if (sub === 'sign-off') return <SignOff books={books} pe={pe} setPe={setPe} picker={picker} />;
  return <ReviewOverview books={books} pe={pe} picker={picker} />;
}

// ------------------------------------------------------------------ overview
function ReviewOverview({ books, pe, picker }: { books: CompanyBooks; pe: string; picker: ReactNode }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const o = useApi<Overview>(`/api/companies/${books.company.id}/review/overview?month=${pe}`);
  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  const d = o.data;
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>{picker}<span className="spacer" />
        {d?.reviewedUpTo && <span className="badge good">{t(Boolean(books.review?.canReview) ? 'rv.signedUpTo' : 'rv.reviewedUpTo', { month: monthName(d.reviewedUpTo.periodEnd), name: d.reviewedUpTo.signedBy })}</span>}</div>
      {!d ? <Loading /> : <>
        <div className="grid">
          <Fig label={t('rv.findings')} value={d.openFindings} sub={t('rv.findingsSub')} tone={d.openFindings ? 'warn' : ''} onClick={() => go('Review', 'checks')} />
          <Fig label={t('rv.checklistFig')} value={`${d.checklist.done} / ${d.checklist.total}`} sub={t('rv.checklistSub')} onClick={() => go('Review', 'checklist')} />
          <Fig label={t('rv.queriesFig')} value={d.openQueries} sub={t('rv.queriesSub', { n: d.queries })} tone={d.openQueries ? 'warn' : ''} onClick={() => go('Review', 'queries')} />
          <Fig label={t('rv.signoffFig')} value={d.signoff ? t('rv.signed') : t('rv.notSigned')}
            sub={d.signoff ? t('rv.signedBy', { name: d.signoff.signedBy, date: d.signoff.signedAt.slice(0, 10) }) : t('rv.signoffSub')} onClick={() => go('Review', 'sign-off')} />
        </div>
        {d.signoff && d.signoff.changedAfter > 0 && <div className="notice warn">{t('rv.changedAfter', { n: d.signoff.changedAfter })}</div>}
        <div className="card">
          <h2>{t('rv.checksFor', { month: monthName(pe) })}</h2>
          <table className="stack"><tbody>{d.checks.map((c) => (
            <tr key={c.key}><td><button className="link" onClick={() => go('Review', 'checks')}>{t(`rv.check.${c.key}` as Key)}</button><div className="small mut">{t(`rv.checkHint.${c.key}` as Key)}</div></td>
              <td className="num">{c.open ? <span className={`badge ${c.severity === 'warning' ? 'warn' : ''}`}>{t('rv.openN', { n: c.open })}</span> : c.total ? <span className="badge good">{t('rv.allExplained')}</span> : <span className="badge good">{t('rv.clear')}</span>}</td></tr>
          ))}</tbody></table>
        </div>
      </>}
    </>
  );
}

// ------------------------------------------------------------------ checks
function Checks({ books, pe, picker }: { books: CompanyBooks; pe: string; picker: ReactNode }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const firm = Boolean(books.review?.canReview);
  const c = useApi<Check[]>(`/api/companies/${books.company.id}/review/checks?month=${pe}`);
  const [explain, setExplain] = useState<{ check: string; item: string; note: string }>();
  const [ask, setAsk] = useState<{ check: string; f: Finding }>();
  const [showClear, setShowClear] = useState(false);
  const { run, busy, notes } = useRun();
  const open = (l: Finding['link']) => {
    if (!l) return;
    if (l.type === 'document') go(moduleForType(l.docType ?? 'invoice'), pageForType(l.docType ?? 'invoice'), l.id);
    else if (l.type === 'entry') go('Journal', 'entries');
    else if (l.type === 'account') go('Ledger', 'general-ledger', l.id);
    else if (l.type === 'bank_line') go('Bank', 'accounts', l.id);
  };
  if (c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  const list = c.data ?? [];
  const shown = list.filter((x) => showClear || x.findings.length);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>{picker}<span className="spacer" />
        <label className="check-one small"><input type="checkbox" checked={showClear} onChange={(e) => setShowClear(e.target.checked)} />{t('rv.showClear')}</label></div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('rv.checksHint')}</div>
      {notes}
      {ask && <AskForm books={books} pe={pe} preset={{ subject: `${t(`rv.check.${ask.check}` as Key)}: ${ask.f.label}`, aboutType: 'check', aboutId: ask.check, aboutLabel: ask.f.label }}
        onDone={() => setAsk(undefined)} />}
      {!c.data ? <Loading /> : shown.length === 0 ? <div className="card"><div className="notice">{t('rv.nothingFound')}</div></div> : shown.map((x) => (
        <div key={x.key} className="card">
          <div className="actions" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0, flex: '1 1 auto' }}>{t(`rv.check.${x.key}` as Key)}</h2>
            {x.findings.length === 0 ? <span className="badge good">{t('rv.clear')}</span> : <span className={`badge ${x.open ? (x.severity === 'warning' ? 'warn' : '') : 'good'}`}>{x.open ? t('rv.openN', { n: x.open }) : t('rv.allExplained')}</span>}
          </div>
          <div className="small mut" style={{ marginBottom: 6 }}>{t(`rv.checkHint.${x.key}` as Key)}</div>
          {x.findings.length > 0 && <div className="wrap"><table className="stack">
            <tbody>{x.findings.map((f) => (
              <tr key={f.itemKey} className={f.explained ? 'mut' : ''}>
                <td className="small ltr" style={{ whiteSpace: 'nowrap' }}>{f.date ?? ''}</td>
                <td>{f.link ? <button className="link" onClick={() => open(f.link)}>{findingLabel(t, x.key, f)}</button> : findingLabel(t, x.key, f)}
                  {f.detail && <div className="small mut">{findingDetail(t, x.key, f.detail)}</div>}
                  {f.explained && <div className="small">✓ {f.explained.note} <span className="mut">· {f.explained.by}</span></div>}</td>
                <td className="num ltr">{f.amount ? fmt(f.amount) : ''}</td>
                <td className="num">{firm && <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <button className="b small" onClick={() => setAsk({ check: x.key, f })}>{t('rv.askClient')}</button>
                  {f.explained ? <button className="b small" disabled={busy} onClick={() => void run(async () => { await api(`/api/companies/${books.company.id}/review/explain`, { body: { check: x.key, item: f.itemKey, note: '' } }); c.reload(); })}>{t('rv.unexplain')}</button>
                    : <button className="b small" onClick={() => setExplain({ check: x.key, item: f.itemKey, note: '' })}>{t('rv.explain')}</button>}
                </span>}</td>
              </tr>
            ))}</tbody>
          </table></div>}
          {explain && explain.check === x.key && (
            <form className="actions" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
              await api(`/api/companies/${books.company.id}/review/explain`, { body: explain }); setExplain(undefined); c.reload(); }); }}>
              <input id="rv-explain" style={{ flex: '1 1 300px' }} placeholder={t('rv.explainPlaceholder')} value={explain.note} onChange={(e) => setExplain({ ...explain, note: e.target.value })} />
              <button className="b p small" id="rv-explain-save" disabled={busy || !explain.note.trim()}>{t('rv.explainSave')}</button>
              <button type="button" className="b small" onClick={() => setExplain(undefined)}>{t('cancel')}</button>
            </form>
          )}
        </div>
      ))}
    </>
  );
}
function findingLabel(t: ReturnType<typeof useI18n>['t'], key: string, f: Finding) {
  if (key === 'payroll_missing') return t('rv.payrollMissingN', { n: f.label });
  if (key === 'depreciation_missing') return t('rv.depreciationMissingN', { n: f.label });
  if (key === 'drafts_left') { const [type, rest] = f.label.split(' · '); return `${t(`doc.title.${type}` as Key)} · ${rest ?? ''}`; }
  return f.label;
}
function findingDetail(t: ReturnType<typeof useI18n>['t'], key: string, d: string) {
  if (key === 'overdue_receivables') return t('rv.daysOverdue', { n: d });
  if (key === 'abnormal_balances') return t('rv.wrongSide', { type: t(`coa.type.${d}` as Key) });
  if (key === 'missing_input_vat') return t('rv.supplierVatNo', { no: d });
  if (key === 'duplicates') return t('rv.sameReference', { ref: d });
  if (key === 'sales_without_vat') return d.split(', ').map((v) => t(`vat.${v}` as Key, { rate: 0 })).join(', ');
  return d;
}

// ------------------------------------------------------------------ queries
function AskForm({ books, pe, preset, onDone }: { books: CompanyBooks; pe: string; preset?: { subject: string; aboutType?: string; aboutId?: string; aboutLabel?: string }; onDone: (id?: string) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ subject: preset?.subject ?? '', body: '' });
  const { run, busy, notes } = useRun();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { const r = await api<{ id: string }>(`/api/companies/${books.company.id}/review/queries`, { body: { ...preset, ...f, periodEnd: pe } }); onDone(r.id); });
  };
  return (
    <form className="card inset" onSubmit={save}>
      <h2>{t('rv.askTitle')}</h2>
      {notes}
      <label className="f">{t('rv.subject')}<input id="q-subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
      <label className="f">{t('rv.question')}<textarea id="q-body" rows={3} value={f.body} placeholder={t('rv.questionExample')} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <div className="actions"><button className="b p" id="q-send" disabled={busy || !f.subject.trim() || !f.body.trim()}>{t('rv.send')}</button><button type="button" className="b" onClick={() => onDone()}>{t('cancel')}</button></div>
    </form>
  );
}

function Queries({ books, pe, picker }: { books: CompanyBooks; pe: string; picker: ReactNode }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const firm = Boolean(books.review?.canReview);
  const [status, setStatus] = useState('unresolved');
  const [all, setAll] = useState(true);
  const [asking, setAsking] = useState(false);
  const list = useApi<QueryRow[]>(`/api/companies/${books.company.id}/review/queries?status=${status}${all ? '' : `&month=${pe}`}`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <div className="seg">{['unresolved', 'answered', 'closed', ''].map((s) => <button key={s || 'all'} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{t(`rv.qs.${s || 'all'}` as Key)}</button>)}</div>
        <label className="check-one small"><input type="checkbox" checked={!all} onChange={(e) => setAll(!e.target.checked)} />{t('rv.onlyMonth')}</label>
        {!all && picker}
        <span className="spacer" />
        {firm && !asking && <button className="b p" id="q-new" onClick={() => setAsking(true)}>{t('rv.askNew')}</button>}
      </div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t(firm ? 'rv.queriesHintFirm' : 'rv.queriesHintClient')}</div>
      {asking && <AskForm books={books} pe={pe} onDone={(id) => { setAsking(false); if (id) go('Review', 'queries', id); }} />}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('rv.noQueries')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rv.subject')}</th><th>{t('rv.month')}</th><th>{t('rv.raisedBy')}</th><th className="num">{t('rv.messages')}</th><th>{t('rv.status')}</th></tr></thead>
            <tbody>{list.data.map((q) => (
              <tr key={q.id} className={q.status === 'closed' ? 'mut' : ''}>
                <td><button className="link" onClick={() => go('Review', 'queries', q.id)}>{q.subject}</button></td>
                <td className="small" data-label={t('rv.month')}>{monthName(q.periodEnd)}</td>
                <td className="small" data-label={t('rv.raisedBy')}>{q.raisedBy} <span className="mut ltr">{q.raisedAt.slice(0, 10)}</span></td>
                <td className="num" data-label={t('rv.messages')}>{q.messages}</td>
                <td data-label={t('rv.status')}><QueryBadge status={q.status} firm={firm} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
function QueryBadge({ status, firm }: { status: string; firm: boolean }) {
  const { t } = useI18n();
  // Who it is waiting for: open = waiting for the client; answered = waiting for the firm.
  const waitingForMe = (status === 'open' && !firm) || (status === 'answered' && firm);
  return <span className={`badge ${status === 'closed' ? 'good' : waitingForMe ? 'warn' : ''}`}>{t(`rv.status.${status}` as Key)}{waitingForMe ? ` · ${t('rv.yourTurn')}` : ''}</span>;
}

function QueryPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, lang } = useI18n();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const firm = Boolean(books.review?.canReview);
  const q = useApi<QueryDetail & { messages: { id: string; body: string; createdAt: string; author: string | null; mine: boolean; fromFirm: boolean }[] }>(`/api/review/queries/${id}`);
  const [text, setText] = useState('');
  const { run, busy, notes } = useRun();
  if (q.error) return <ErrorNote error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const when = (iso: string) => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const setStatus = (status: string) => void run(async () => { await api(`/api/review/queries/${id}/status`, { body: { status } }); q.reload(); });
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Review', 'queries')}>{t('rv.allQueries')}</button>
        <span className="spacer" />
        {firm && d.status !== 'closed' && <button className="b" id="q-close" disabled={busy} onClick={() => setStatus('closed')}>{t('rv.close')}</button>}
        {firm && d.status === 'closed' && <button className="b" disabled={busy} onClick={() => setStatus('open')}>{t('rv.reopen')}</button>}
      </div>
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0, flex: '1 1 auto' }}>{d.subject}</h2><QueryBadge status={d.status} firm={firm} /></div>
        <div className="small mut">{monthName(d.periodEnd)}{d.aboutType === 'check' && d.aboutId ? ` · ${t(`rv.check.${d.aboutId}` as Key)}` : ''}{d.closedBy ? ` · ${t('rv.closedBy', { name: d.closedBy })}` : ''}</div>
        <div className="thread">
          {d.messages.map((m) => (
            <div key={m.id} className={`msg ${m.fromFirm ? 'firm' : 'client'}`}>
              <div className="small mut">{m.author} · {m.fromFirm ? t('rv.fromFirm') : t('rv.fromClient')} · <span className="ltr">{when(m.createdAt)}</span></div>
              <div className="pre">{m.body}</div>
            </div>
          ))}
        </div>
        {notes}
        {d.status !== 'closed' ? (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/review/queries/${id}/reply`, { body: { body: text } }); setText(''); q.reload(); }); }}>
            <label className="f">{t('rv.reply')}<textarea id="q-reply" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={firm ? t('rv.replyFirm') : t('rv.replyClient')} /></label>
            <button className="b p" id="q-reply-send" disabled={busy || !text.trim()}>{t('rv.sendReply')}</button>
          </form>
        ) : <div className="mut small">{t('rv.closedNote')}</div>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ checklist
function ChecklistPage({ books, pe, picker }: { books: CompanyBooks; pe: string; picker: ReactNode }) {
  const { t } = useI18n();
  const firm = Boolean(books.review?.canReview);
  const c = useApi<Checklist>(`/api/companies/${books.company.id}/review/checklist?month=${pe}`);
  const months = useApi<MonthRow[]>(`/api/companies/${books.company.id}/review/months?month=${pe}`);
  const [note, setNote] = useState<{ item: string; text: string }>();
  const { run, busy, notes } = useRun();
  const signed = !!months.data?.[0]?.signoff;
  const set = (item: string, done: boolean, n?: string | null) => void run(async () => {
    await api(`/api/companies/${books.company.id}/review/checklist`, { body: { month: pe, item, done, note: n ?? null } }); setNote(undefined); c.reload();
  });
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>{picker}<span className="spacer" />{c.data && <b>{t('rv.doneOf', { done: c.data.done, total: c.data.total })}</b>}</div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('rv.checklistHint')}</div>
      {signed && <div className="notice small">{t('rv.checklistSigned')}</div>}
      {notes}
      <div className="card">
        {c.error && <ErrorNote error={c.error} onRetry={c.reload} />}
        {!c.data ? <Loading /> : (
          <table className="stack checklist"><tbody>{c.data.items.map((i) => (
            <tr key={i.item} className={i.done ? 'done' : ''}>
              <td style={{ width: 36 }}><input type="checkbox" aria-label={t(`rv.item.${i.item}` as Key)} checked={i.done} disabled={!firm || signed || busy || Boolean(i.auto)}
                onChange={(e) => (e.target.checked ? setNote({ item: i.item, text: '' }) : set(i.item, false))} /></td>
              <td><b>{t(`rv.item.${i.item}` as Key)}</b><div className="small mut">{t(`rv.itemHint.${i.item}` as Key)}</div>
                {i.auto !== null && <div className="small">{i.auto ? `✓ ${t('rv.autoDone')}` : t('rv.autoNotDone')}</div>}
                {i.ticked && <div className="small">✓ {i.by}{i.note ? ` · ${i.note}` : ''}</div>}
                {note?.item === i.item && (
                  <form className="actions" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); set(i.item, true, note.text); }}>
                    <input id="cl-note" style={{ flex: '1 1 260px' }} placeholder={t('rv.tickNote')} value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
                    <button className="b p small" id="cl-save">{t('rv.tick')}</button><button type="button" className="b small" onClick={() => setNote(undefined)}>{t('cancel')}</button>
                  </form>
                )}
                {firm && !signed && i.auto === false && !i.ticked && note?.item !== i.item && <button className="link small" onClick={() => setNote({ item: i.item, text: '' })}>{t('rv.tickAnyway')}</button>}
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ sign-off
function SignOff({ books, pe, setPe, picker }: { books: CompanyBooks; pe: string; setPe: (pe: string) => void; picker: ReactNode }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const canSign = Boolean(books.review?.canSignOff);
  const m = useApi<MonthRow[]>(`/api/companies/${books.company.id}/review/months?month=${lastMonthEnd() > pe ? lastMonthEnd() : pe}`);
  const cl = useApi<Checklist>(`/api/companies/${books.company.id}/review/checklist?month=${pe}`);
  const [note, setNote] = useState('');
  const [withdraw, setWithdraw] = useState<{ id: string; reason: string }>();
  const [confirm, setConfirm] = useState(false);
  const { run, busy, notes } = useRun();
  const row = m.data?.find((x) => x.periodEnd === pe);
  const ready = cl.data && cl.data.done === cl.data.total && row && row.openQueries === 0;
  const reload = () => { m.reload(); cl.reload(); };
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>{picker}</div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t(canSign ? 'rv.signHintSigner' : 'rv.signHintOther')}</div>
      {notes}
      {row && !row.signoff && canSign && (
        <div className="card inset">
          <h2>{t('rv.signTitle', { month: monthName(pe) })}</h2>
          <ul className="small" style={{ margin: '0 0 8px', paddingInlineStart: 18 }}>
            <li className={cl.data && cl.data.done === cl.data.total ? '' : 'bad'}>{t('rv.readyChecklist', { done: cl.data?.done ?? 0, total: cl.data?.total ?? 0 })}{cl.data && cl.data.done < cl.data.total && <> · <button className="link" onClick={() => go('Review', 'checklist')}>{t('sub.checklist')}</button></>}</li>
            <li className={row.openQueries ? 'bad' : ''}>{t('rv.readyQueries', { n: row.openQueries })}</li>
            {pe >= today() && <li className="bad">{t('rv.readyEnded')}</li>}
          </ul>
          <label className="f">{t('rv.signNote')}<input id="so-note" value={note} placeholder={t('rv.signNoteExample')} onChange={(e) => setNote(e.target.value)} /></label>
          {confirm ? <ConfirmBar busy={busy} message={t('rv.signConfirm', { month: monthName(pe) })} onNo={() => setConfirm(false)}
            onYes={() => void run(async () => { await api(`/api/companies/${books.company.id}/review/sign-off`, { body: { month: pe, note } }); setConfirm(false); setNote(''); reload(); }, t('rv.signedDone'))} />
            : <button className="b p" id="so-sign" disabled={!ready || pe >= today()} onClick={() => setConfirm(true)}>{t('rv.signButton')}</button>}
        </div>
      )}
      <div className="card">
        <h2>{t('rv.monthsTitle')}</h2>
        {!m.data ? <Loading /> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rv.month')}</th><th>{t('rv.status')}</th><th className="num">{t('rv.queriesFig')}</th><th /></tr></thead>
            <tbody>{m.data.map((x) => (
              <tr key={x.periodEnd} className={x.periodEnd === pe ? 'sel' : ''}>
                <td><button className="link" onClick={() => setPe(x.periodEnd)}>{monthName(x.periodEnd)}</button></td>
                <td data-label={t('rv.status')}>{x.signoff ? <>
                  <span className="badge good">{t('rv.signed')}</span> <span className="small">{t('rv.signedBy', { name: x.signoff.signedBy, date: x.signoff.signedAt.slice(0, 10) })}</span>
                  {x.signoff.note && <div className="small mut">{x.signoff.note}</div>}
                  {x.signoff.changedAfter > 0 && <div className="small bad">{t('rv.changedAfter', { n: x.signoff.changedAfter })}</div>}
                </> : <><span className="badge">{t('rv.notSigned')}</span>{x.lastWithdrawn && <div className="small mut">{t('rv.withdrawnNote', { name: x.lastWithdrawn.by, reason: x.lastWithdrawn.reason })}</div>}</>}</td>
                <td className="num" data-label={t('rv.queriesFig')}>{x.openQueries ? <span className="badge warn">{t('rv.openN', { n: x.openQueries })}</span> : x.queries}</td>
                <td className="num">{x.signoff && canSign && (withdraw?.id === x.signoff.id ? (
                  <form className="actions" style={{ justifyContent: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
                    await api(`/api/review/sign-offs/${x.signoff!.id}/withdraw`, { body: { reason: withdraw.reason } }); setWithdraw(undefined); reload(); }); }}>
                    <input id="so-reason" placeholder={t('rv.withdrawReason')} value={withdraw.reason} onChange={(e) => setWithdraw({ ...withdraw, reason: e.target.value })} />
                    <button className="b small" id="so-withdraw-save" disabled={busy || !withdraw.reason.trim()}>{t('rv.withdraw')}</button>
                  </form>) : <button className="b small" onClick={() => setWithdraw({ id: x.signoff!.id, reason: '' })}>{t('rv.withdraw')}</button>)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/** "Reviewed by your accountant" on the client's Home page, with queries waiting for them. */
export function ReviewedBadge({ books, go }: { books: CompanyBooks; go: (m: string, s?: string) => void }) {
  const { t } = useI18n();
  const monthName = useMonthName();
  const firm = Boolean(books.review?.canReview);
  const q = useApi<QueryRow[]>(`/api/companies/${books.company.id}/review/queries?status=${firm ? 'answered' : 'open'}`);
  const r = (books as CompanyBooks & { reviewedUpTo?: { periodEnd: string; signedBy: string } | null }).reviewedUpTo;
  const waiting = q.data?.length ?? 0;
  if (!r && !waiting) return null;
  return (
    <div className="actions" style={{ marginBottom: 10 }}>
      {r && <span className="badge good" id="reviewed-badge">✓ {t('rv.reviewedUpTo', { month: monthName(r.periodEnd), name: r.signedBy })}</span>}
      {waiting > 0 && <button className="b small" onClick={() => go('Review', 'queries')}>{t(firm ? 'rv.answersWaiting' : 'rv.questionsWaiting', { n: waiting })}</button>}
    </div>
  );
}
