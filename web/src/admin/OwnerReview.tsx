// Owner > Payment review: the queue of payments customers say they made, and the side-by-side review of one.
// People with "payments.view" read; "payments.review" recommends, rejects or asks the customer for more; only the Owner role approves.
// Every one of these rules is checked again in the database; the buttons here only follow it.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { halalasText } from '../trial/TransferPanel.tsx';

interface Row { id: string; reference: string; status: string; firm: string; totalHalalas: number | string; enteredHalalas: number | string; flags: string[]; recommended: boolean; hasFile: boolean; waitingSince: string; hoursWaiting: number | string; overdue: boolean }
interface Queue { reviewTargetHours: number; enabled: boolean; orders: Row[] }
interface Sub { id: string; amountHalalas: number | string; date: string; senderBank: string | null; bankRef: string | null; note: string | null; flags: string[]; at: string; file: { name: string; type: string } | null }
interface Detail {
  id: string; reference: string; status: string; firm: string; currency: string; subtotalHalalas: number | string; vatRate: string; vatHalalas: number | string; totalHalalas: number | string;
  recommendedBy: string | null; submissions: Sub[]; timeline: { at: string; status: string; by: string | null; clientNote: string | null; staffNote: string | null }[];
}
type Action = 'recommend' | 'reject' | 'need-info' | 'approve';
const riyadh = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
const FLAGS = ['duplicate_file', 'duplicate_bank_ref', 'amount_under', 'amount_over'];

export function OwnerReview({ canApprove, canReview }: { canApprove: boolean; canReview: boolean }) {
  const { t } = useI18n();
  const q = useApi<Queue>('/api/staff/payments');
  const [open, setOpen] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'overdue' | 'flagged' | 'needs_info'>('all');
  const [done, setDone] = useState<string>();
  if (q.error) return <ErrorNote error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const rows = q.data.orders.filter((r) => filter === 'all' || (filter === 'overdue' && r.overdue) || (filter === 'flagged' && r.flags.length > 0) || (filter === 'needs_info' && r.status === 'needs_info'));
  const overdue = q.data.orders.filter((r) => r.overdue).length;
  return (
    <div id="rv">
      {!q.data.enabled && <div className="notice warn" id="rv-off">{t('prv.off')}</div>}
      {done && <div className="notice ok" role="status" id="rv-done">{done}</div>}
      <div className="card">
        <p id="rv-count">{t('prv.count', { n: String(q.data.orders.length), late: String(overdue), hours: String(q.data.reviewTargetHours) })}</p>
        <div className="actions" role="group" aria-label={t('prv.filter')}>
          {(['all', 'overdue', 'flagged', 'needs_info'] as const).map((f) => <button key={f} id={`rv-f-${f}`} className={`b sm${filter === f ? ' p' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`prv.f.${f}` as Key)}</button>)}
        </div>
        {rows.length === 0 ? <p className="mut" id="rv-empty">{t('prv.empty')}</p> : (
          <div className="wrap"><table className="stack" id="rv-queue"><thead><tr>
            <th>{t('prv.col.ref')}</th><th>{t('prv.col.customer')}</th><th>{t('prv.col.due')}</th><th>{t('prv.col.entered')}</th><th>{t('prv.col.waiting')}</th><th>{t('prv.col.flags')}</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} id={`rv-row-${r.reference}`} className={r.overdue ? 'late' : ''}>
                <td className="ltr">{r.reference}{r.recommended && <span className="tag"> ✓ {t('prv.recommended')}</span>}</td>
                <td>{r.firm}</td>
                <td className="ltr">{halalasText(r.totalHalalas, 'SAR')}</td>
                <td className="ltr">{halalasText(r.enteredHalalas, 'SAR')}</td>
                <td className={r.overdue ? 'bad' : ''}>{t('prv.hours', { n: String(r.hoursWaiting) })}{r.overdue ? ` · ${t('prv.late')}` : ''}{r.status === 'needs_info' ? ` · ${t('prv.f.needs_info')}` : ''}</td>
                <td>{r.flags.length ? r.flags.map((f) => <span key={f} className="tag bad">{FLAGS.includes(f) ? t(`prv.flag.${f}` as Key) : f}</span>) : '-'}</td>
                <td><button className="b sm" id={`rv-open-${r.reference}`} onClick={() => { setOpen(r.id); setDone(undefined); }}>{t('prv.open')}</button></td>
              </tr>))}</tbody></table></div>)}
      </div>
      {open && <Review id={open} canApprove={canApprove} canReview={canReview} onClose={() => setOpen(undefined)} onDone={(m) => { setOpen(undefined); setDone(m); q.reload(); }} />}
    </div>);
}

function Review({ id, canApprove, canReview, onClose, onDone }: { id: string; canApprove: boolean; canReview: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const { t, has } = useI18n();
  const d = useApi<Detail>(`/api/staff/payments/${id}`);
  const [act, setAct] = useState<Action>();
  const [text, setText] = useState('');
  const [saw, setSaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const o = d.data, s = o.submissions[0];
  const live = o.status === 'under_review';
  const differs = !!s && BigInt(s.amountHalalas) !== BigInt(o.totalHalalas);
  const go = async () => {
    if (!act) return;
    setBusy(true); setError(undefined);
    try {
      const body = act === 'reject' ? { reason: text } : act === 'need-info' ? { message: text } : act === 'recommend' ? { note: text } : { override: differs ? text : undefined };
      const r = await api<{ invoice?: { number: string } }>(`/api/staff/payments/${o.id}/${act}`, { body });
      onDone(t(`prv.done.${act}` as Key, { ref: o.reference, invoice: r?.invoice?.number ?? '' }));
    } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const need = act === 'approve' ? (differs ? 5 : 0) : act === 'recommend' ? 0 : 3;
  const ready = !!act && text.trim().length >= need && (act !== 'approve' || saw);
  const tag = (f: string) => <span key={f} className="tag bad" id={`rv-flag-${f}`}>{FLAGS.includes(f) ? t(`prv.flag.${f}` as Key) : f}</span>;
  return (
    <div className="card" id="rv-detail" aria-live="polite">
      <div className="actions"><h2 id="rv-title">{o.reference} · {o.firm}</h2><button className="b sm" id="rv-close" onClick={onClose}>{t('prv.close')}</button></div>
      {o.recommendedBy && <p className="small" id="rv-recby">{t('prv.recommendedBy', { name: o.recommendedBy })}</p>}
      <div className="rv-grid" id="rv-compare" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
        <section id="rv-expected"><h3>{t('prv.expected')}</h3>
          <dl>
            <dt>{t('pay.c.subtotal')}</dt><dd className="ltr">{halalasText(o.subtotalHalalas, o.currency)}</dd>
            <dt>{t('pay.c.vat', { rate: String(Number(o.vatRate)) })}</dt><dd className="ltr">{halalasText(o.vatHalalas, o.currency)}</dd>
            <dt>{t('pay.c.total')}</dt><dd className="ltr" id="rv-due"><b>{halalasText(o.totalHalalas, o.currency)}</b></dd>
            <dt>{t('pay.c.ref')}</dt><dd className="ltr">{o.reference}</dd>
          </dl></section>
        <section id="rv-told"><h3>{t('prv.told')}</h3>
          {!s ? <p className="mut">{t('prv.nosub')}</p> : (<>
            <dl>
              <dt>{t('buy.pay.amount')}</dt><dd className={`ltr${differs ? ' bad' : ''}`} id="rv-entered"><b>{halalasText(s.amountHalalas, o.currency)}</b></dd>
              <dt>{t('buy.pay.date')}</dt><dd className="ltr">{s.date}</dd>
              <dt>{t('pay.c.senderBank')}</dt><dd>{s.senderBank ?? '-'}</dd>
              <dt>{t('buy.pay.reference')}</dt><dd className="ltr">{s.bankRef ?? '-'}</dd>
              <dt>{t('pay.c.note')}</dt><dd>{s.note ?? '-'}</dd>
            </dl>
            {s.flags.length > 0 && <p id="rv-flags">{s.flags.map(tag)}</p>}
            <p className="small mut">{t('prv.slipNote')}</p>
            {s.file ? (s.file.type.startsWith('image/')
              ? <a id="rv-slip-link" href={`/api/staff/payments/slip/${s.id}`} target="_blank" rel="noopener noreferrer"><img id="rv-slip" alt={t('prv.slip')} src={`/api/staff/payments/slip/${s.id}`} style={{ maxWidth: '100%', maxHeight: 360 }} /></a>
              : <a className="b sm" id="rv-slip-link" href={`/api/staff/payments/slip/${s.id}`} download>{t('prv.slipOpen', { name: s.file.name })}</a>)
              : <p className="mut" id="rv-noslip">{t('prv.noslip')}</p>}
          </>)}</section>
      </div>
      <h3>{t('pay.c.timeline')}</h3>
      <ol className="small" id="rv-timeline">{o.timeline.map((e, i) => <li key={i}><span className="ltr">{riyadh(e.at)}</span> {has(`pay.c.status.${e.status}`) ? t(`pay.c.status.${e.status}` as Key) : e.status}{e.by ? ` · ${e.by}` : ''}{e.clientNote ? ` · ${e.clientNote}` : ''}{e.staffNote ? ` · ${e.staffNote}` : ''}</li>)}</ol>
      {!live && <p className="mut" id="rv-notlive">{t('prv.notLive')}</p>}
      {live && !canReview && <p className="mut" id="rv-readonly">{t('prv.readonly')}</p>}
      {live && canReview && (
        <div id="rv-actions">
          <div className="actions" role="group" aria-label={t('prv.actions')}>
            {canApprove && <button className="b p" id="rv-act-approve" aria-pressed={act === 'approve'} onClick={() => { setAct('approve'); setText(''); setError(undefined); }}>{t('prv.approve')}</button>}
            <button className="b" id="rv-act-recommend" aria-pressed={act === 'recommend'} onClick={() => { setAct('recommend'); setText(''); setError(undefined); }}>{t('prv.recommend')}</button>
            <button className="b" id="rv-act-need-info" aria-pressed={act === 'need-info'} onClick={() => { setAct('need-info'); setText(''); setError(undefined); }}>{t('prv.needInfo')}</button>
            <button className="b bad" id="rv-act-reject" aria-pressed={act === 'reject'} onClick={() => { setAct('reject'); setText(''); setError(undefined); }}>{t('prv.reject')}</button>
          </div>
          {!canApprove && <p className="small mut" id="rv-noapprove">{t('prv.noApprove')}</p>}
          {act && (
            <div id="rv-confirm">
              {act === 'approve' && <label className="check"><input type="checkbox" id="rv-saw" checked={saw} onChange={(e) => setSaw(e.target.checked)} />{t('prv.saw', { amount: s ? halalasText(s.amountHalalas, o.currency) : '' })}</label>}
              {(act !== 'approve' || differs) && (
                <label className="f">{t(act === 'approve' ? 'prv.why.override' : act === 'recommend' ? 'prv.why.recommend' : act === 'reject' ? 'prv.why.reject' : 'prv.why.needInfo')}
                  <textarea id="rv-text" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></label>)}
              {(act === 'reject' || act === 'need-info') && <p className="small mut">{t('prv.customerReads')}</p>}
              {error && <div className="notice bad" role="alert" id="rv-error">{error}</div>}
              <div className="actions"><button className={`b ${act === 'reject' ? 'bad' : 'p'}`} id="rv-go" disabled={busy || !ready} onClick={() => void go()}>{t(`prv.go.${act}` as Key)}</button></div>
            </div>)}
        </div>)}
    </div>);
}
