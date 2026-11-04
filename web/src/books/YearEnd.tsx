// Journal > Year-end: close a financial year (income and expenses to 3100 Retained earnings, every month locked),
// years in order, partner only; reopen the latest closed year with a reason.
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';

interface Closing { id: string; startDate: string; endDate: string; status: string; profit: string; closedBy: string | null; closedAt: string; reopenedBy: string | null;
  reopenedAt: string | null; reopenReason: string | null; entryId: string | null }
interface Year { startDate: string; endDate: string; profit: string; ended: boolean; closed: Closing | null; history: Closing[] }
interface Preview { startDate: string; endDate: string; profit: string; openMonths: number; drafts: number; retainedCode: string;
  lines: { accountId: string; code: string; name: string; type: string; costCentre: string | null; balance: string }[] }

export function YearEnd({ books, onChanged }: { books: CompanyBooks; onChanged: () => void }) {
  const { t, has } = useI18n();
  const ys = useApi<{ years: Year[]; nextToClose: string | null }>(`/api/companies/${books.company.id}/year-end`);
  const next = ys.data?.nextToClose ?? null;
  const pv = useApi<Preview>(next ? `/api/companies/${books.company.id}/year-end/preview?end=${next}` : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [reopen, setReopen] = useState<{ id: string; reason: string }>();
  const [sure, setSure] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg({});
    try { await fn(); setMsg({ ok }); setReopen(undefined); setSure(false); ys.reload(); pv.reload(); onChanged(); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (ys.error) return <ErrorNote error={ys.error} onRetry={ys.reload} />;
  if (!ys.data) return <Loading />;
  const partner = books.canLock;
  const latestClosed = ys.data.years.find((y) => y.closed);
  return (
    <>
      <p className="mut small">{t('ye.hint')}</p>
      {msg.ok && <div className="notice" role="status" id="ye-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {next && pv.data && (
        <div className="card" id="ye-preview">
          <h3>{t('ye.closeTitle', { from: pv.data.startDate, to: pv.data.endDate })}</h3>
          <div className="grid" style={{ marginBottom: 10 }}>
            <div className="card fig"><small>{toMinor(pv.data.profit) >= 0n ? t('ye.profit') : t('ye.loss')}</small><b className="ltr">{fmt(fromMinor(toMinor(pv.data.profit) < 0n ? -toMinor(pv.data.profit) : toMinor(pv.data.profit)))}</b><small>{t('ye.toRetained', { code: pv.data.retainedCode })}</small></div>
            <div className={`card fig ${pv.data.openMonths ? 'warn' : ''}`}><small>{t('ye.openMonths')}</small><b>{pv.data.openMonths}</b><small>{t('ye.openMonthsSub')}</small></div>
            <div className={`card fig ${pv.data.drafts ? 'warn' : ''}`}><small>{t('ye.drafts')}</small><b>{pv.data.drafts}</b><small>{t('ye.draftsSub')}</small></div>
          </div>
          {pv.data.lines.length > 0 && <div className="wrap"><table className="mini">
            <thead><tr><th>{t('journal.account')}</th><th>{t('journal.costCentre')}</th><th className="num">{t('ye.balance')}</th></tr></thead>
            <tbody>{pv.data.lines.map((l) => (
              <tr key={`${l.accountId}${l.costCentre}`}><td><span className="ltr">{l.code}</span> {l.name}</td><td className="small">{l.costCentre ?? '—'}</td>
                <td className="num ltr">{fmt(l.type === 'income' ? fromMinor(-toMinor(l.balance)) : l.balance)}</td></tr>
            ))}</tbody>
          </table></div>}
          {partner ? <>
            <label className="check-one" style={{ margin: '10px 0' }}><input type="checkbox" id="ye-sure" checked={sure} onChange={(e) => setSure(e.target.checked)} /><span>{t('ye.sure')}</span></label>
            <button className="b p" id="ye-close" disabled={busy || !sure} onClick={() => void run(() => api(`/api/companies/${books.company.id}/year-end/close`, { body: { end: next } }), t('ye.closed'))}>{t('ye.close', { year: next })}</button>
          </> : <p className="small mut">{t('ye.partnerOnly')}</p>}
        </div>
      )}
      {!next && <div className="notice small">{t('ye.nothingToClose')}</div>}
      <div className="card">
        <h3>{t('ye.years')}</h3>
        <div className="wrap"><table className="stack" id="ye-years">
          <thead><tr><th>{t('ye.year')}</th><th className="num">{t('ye.result')}</th><th>{t('hr.status')}</th><th /></tr></thead>
          <tbody>{ys.data.years.map((y) => (
            <tr key={y.endDate}>
              <td className="ltr">{y.startDate} – {y.endDate}</td>
              <td className="num ltr" data-label={t('ye.result')}>{fmt(y.profit)}</td>
              <td data-label={t('hr.status')}>{y.closed ? <><span className="badge good">{t('ye.s.closed')}</span><div className="small mut">{y.closed.closedBy} · {y.closed.closedAt.slice(0, 10)}</div></>
                : <span className="badge">{y.ended ? t('ye.s.open') : t('ye.s.current')}</span>}
                {y.history.map((h) => <div key={h.id} className="small mut">{t('ye.reopenedNote', { who: h.reopenedBy ?? '', reason: h.reopenReason ?? '' })}</div>)}</td>
              <td className="num">{partner && y.closed && latestClosed?.endDate === y.endDate && reopen?.id !== y.closed.id &&
                <button className="b small" onClick={() => setReopen({ id: y.closed!.id, reason: '' })}>{t('ye.reopen')}</button>}
                {reopen && y.closed && reopen.id === y.closed.id && <span className="actions" style={{ justifyContent: 'flex-end' }}>
                  <input aria-label={t('ye.reopenReason')} placeholder={t('ye.reopenReason')} value={reopen!.reason} onChange={(e) => setReopen({ ...reopen!, reason: e.target.value })} />
                  <button className="b small" disabled={busy || !reopen!.reason.trim()} onClick={() => void run(() => api(`/api/fiscal-years/${reopen!.id}/reopen`, { body: { reason: reopen!.reason } }), t('ye.reopened'))}>{t('ye.reopen')}</button>
                  <button className="b small" onClick={() => setReopen(undefined)}>{t('cancel')}</button></span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}
