// Ledger > Currencies and rates (today's rates, the company's own rates, the daily sync, the automatic revaluation)
// and Ledger > Currency revaluation (the month-end restatement at the closing rate, IAS 21; preview, post, reverse).
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { isLocked } from '../books/Workspace.tsx';
import { CURRENCIES, parseRate } from '../../../src/books/fx.ts';

interface RateInfo { rate: string; rateDate: string; source: string }
interface Rates { base: string; asOf: string; lastSync: string | null; list: { code: string; en: string; ar: string; inUse: boolean; latest: RateInfo | null }[];
  own: { id: string; rateDate: string; currency: string; rate: string; createdBy: string | null }[];
  settings: { autoRevalue: boolean; enabledBy: string | null; enabledAt: string | null; lastRun: string | null; lastProblem: string | null } }
interface Preview { periodEnd: string; base: string; locked: boolean; alreadyDone: string | null; laterDone: string | null; unrealised: string; realised: string; missing: string[];
  lines: { accountId: string; code: string; name: string; currency: string; fxBalance: string; bookValue: string; rate: string | null; rateDate: string | null; rateSource: string | null;
    stale: boolean; closingValue: string | null; adjustment: string; kind: 'unrealised' | 'realised' }[] }
interface Reval { id: string; periodEnd: string; entryId: string | null; status: string; automatic: boolean; unrealised: string; realised: string; createdBy: string | null; createdAt: string }

const rateOk = (r: string) => { try { parseRate(r.trim()); return true; } catch { return false; } };
const lastMonthEnd = () => { const d = new Date(); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const monthEndOf = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

export function CurrencyRates({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const r = useApi<Rates>(`/api/companies/${books.company.id}/fx/rates?asOf=${today()}`);
  const [form, setForm] = useState({ currency: 'USD', date: today(), rate: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string; warn?: string }>({});
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg({});
    try { await fn(); setMsg({ ok }); r.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  /** Sync now: the provider's rates, or the central bank pegs only when it cannot be reached (said plainly). */
  const sync = async () => {
    setBusy(true); setMsg({});
    try {
      const x = await api<{ results: { base: string; stored: number; problem: string | null }[] }>(`/api/companies/${books.company.id}/fx/sync`, { body: {} });
      const mine = x.results.find((y) => y.base === r.data?.base);
      setMsg(mine?.problem ? { warn: t('fx.syncPegsOnly', { problem: mine.problem }) } : { ok: t('fx.synced') });
      r.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const sourceText = (s: string) => (s === 'company' ? t('fx.ownRate') : s === 'central bank peg' ? t('fx.peg') : s);
  return (
    <>
      <p className="mut small">{t('fx.ratesHint', { base: d.base })}</p>
      {msg.ok && <div className="notice" role="status" id="fx-msg">{msg.ok}</div>}
      {msg.warn && <div className="notice warn" role="status" id="fx-msg">{msg.warn}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        <div className="actions" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{t('fx.today', { base: d.base })}</h3>
          <span className="spacer" />
          <span className="small mut">{d.lastSync ? t('fx.lastSync', { at: d.lastSync.slice(0, 16).replace('T', ' ') }) : t('fx.neverSynced')}</span>
          {books.canPost && <button className="b" id="fx-sync" disabled={busy} onClick={() => void sync()}>{t('fx.syncNow')}</button>}
        </div>
        <div className="wrap"><table className="stack" id="fx-rates">
          <thead><tr><th>{t('fx.currency')}</th><th className="num">{t('fx.rateCol', { base: d.base })}</th><th>{t('fx.rateDate')}</th><th>{t('fx.source')}</th></tr></thead>
          <tbody>{d.list.map((c) => (
            <tr key={c.code} className={c.latest ? '' : 'mut'}>
              <td><b className="ltr">{c.code}</b> {local(c.en, c.ar)} {c.inUse && <span className="badge">{t('fx.inUse')}</span>}</td>
              <td className="num ltr" data-label={t('fx.rateCol', { base: d.base })}>{c.latest ? c.latest.rate : '—'}</td>
              <td className="ltr small" data-label={t('fx.rateDate')}>{c.latest?.rateDate ?? '—'}</td>
              <td className="small" data-label={t('fx.source')}>{c.latest ? sourceText(c.latest.source) : t('fx.noRateYet')}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      {books.canPost && <div className="card">
        <h3>{t('fx.ownTitle')}</h3>
        <p className="small mut">{t('fx.ownHint')}</p>
        <div className="row">
          <label className="f">{t('fx.currency')}<select id="fx-own-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {CURRENCIES.filter((c) => c.code !== d.base).map((c) => <option key={c.code} value={c.code}>{c.code} · {local(c.en, c.ar)}</option>)}</select></label>
          <label className="f">{t('date')}<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
          <label className="f">{t('fx.rateFor', { currency: form.currency, base: d.base })}<input id="fx-own-rate" className="num ltr" inputMode="decimal" value={form.rate} aria-invalid={form.rate !== '' && !rateOk(form.rate)}
            onChange={(e) => setForm({ ...form, rate: e.target.value })} />{form.rate !== '' && !rateOk(form.rate) && <span className="small bad">{t('err.rate')}</span>}</label>
          <button className="b p" id="fx-own-save" style={{ alignSelf: 'end', marginBottom: 12 }} disabled={busy || !rateOk(form.rate)}
            onClick={() => void run(() => api(`/api/companies/${books.company.id}/fx/rates`, { body: form }), t('fx.ownSaved'))}>{t('fx.ownSave')}</button>
        </div>
        {d.own.length > 0 && <div className="wrap"><table className="mini">
          <thead><tr><th>{t('date')}</th><th>{t('fx.currency')}</th><th className="num">{t('fx.rateCol', { base: d.base })}</th><th style={{ paddingInlineStart: 16 }}>{t('fx.by')}</th></tr></thead>
          <tbody>{d.own.slice(0, 20).map((x) => <tr key={x.id}><td className="ltr">{x.rateDate}</td><td className="ltr">{x.currency}</td><td className="num ltr">{x.rate}</td><td className="small" style={{ paddingInlineStart: 16 }}>{x.createdBy}</td></tr>)}</tbody>
        </table></div>}
      </div>}
      <div className="card" id="fx-auto">
        <h3>{t('fx.autoTitle')}</h3>
        <p className="small mut">{t('fx.autoHint')}</p>
        <label className="check-one">
          <input type="checkbox" id="fx-auto-on" disabled={!books.canPost || busy} checked={d.settings.autoRevalue}
            onChange={(e) => void run(() => api(`/api/companies/${books.company.id}/fx/settings`, { body: { autoRevalue: e.target.checked } }), e.target.checked ? t('fx.autoOn') : t('fx.autoOff'))} />
          <span>{t('fx.autoLabel')}</span>
        </label>
        {d.settings.autoRevalue && d.settings.enabledBy && <p className="small mut">{t('fx.autoBy', { name: d.settings.enabledBy })}</p>}
        {d.settings.lastProblem && <div className="notice warn small">{t('fx.autoProblem', { problem: d.settings.lastProblem })}</div>}
        <button className="link small" onClick={() => go('Ledger', 'fx-revaluation')}>{t('fx.openRevaluation')}</button>
      </div>
    </>
  );
}

export function CurrencyRevaluation({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const [month, setMonth] = useState(lastMonthEnd().slice(0, 7));
  const pe = monthEndOf(month);
  const p = useApi<Preview>(`/api/companies/${books.company.id}/fx/revaluation?month=${pe}`);
  const past = useApi<Reval[]>(`/api/companies/${books.company.id}/fx/revaluations`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg({});
    try { await fn(); setMsg({ ok }); p.reload(); past.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const d = p.data;
  const total = d ? toMinor(d.unrealised) + toMinor(d.realised) : 0n;
  const canPost = books.canPost && d && !d.locked && !d.alreadyDone && !d.laterDone && d.missing.length === 0 && !isLocked(books, pe);
  return (
    <>
      <p className="mut small">{t('fx.revalHint')}</p>
      <div className="actions" style={{ marginBottom: 10 }}>
        <label className="f">{t('hr.month')}<input id="fx-month" type="month" value={month} max={today().slice(0, 7)} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setMsg({}); } }} /></label>
        <span className="spacer" />
        <button className="b" onClick={() => go('Ledger', 'currencies')}>{t('sub.currencies')}</button>
      </div>
      {msg.ok && <div className="notice" role="status" id="fx-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {p.error && <ErrorNote error={p.error} onRetry={p.reload} />}
      {!d ? <Loading /> : (
        <div className="card" id="fx-preview">
          <h3>{t('fx.revalTitle', { date: pe })}</h3>
          {d.lines.length === 0 ? <p className="mut">{t('fx.nothingForeign')}</p> : <>
            {d.alreadyDone && <div className="notice">{t('fx.alreadyDone')}</div>}
            {d.laterDone && <div className="notice warn">{t('fx.laterDone', { date: d.laterDone })}</div>}
            {d.locked && <div className="notice warn">{t('err.periodLocked')}</div>}
            {d.missing.length > 0 && <div className="notice bad">{t('fx.missing', { list: d.missing.join(', ') })} <button className="link" onClick={() => go('Ledger', 'currencies')}>{t('fx.enterRate')}</button></div>}
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('journal.account')}</th><th className="num">{t('fx.foreignBalance')}</th><th className="num">{t('fx.closingRate')}</th>
                <th className="num">{t('fx.bookValue', { base: d.base })}</th><th className="num">{t('fx.closingValue', { base: d.base })}</th><th className="num">{t('fx.adjustment')}</th></tr></thead>
              <tbody>{d.lines.map((l) => (
                <tr key={l.accountId}>
                  <td><b className="ltr">{l.code}</b> {l.name} <span className="badge">{l.currency}</span>{l.kind === 'realised' && <div className="small mut">{t('fx.realisedNote')}</div>}</td>
                  <td className="num ltr" data-label={t('fx.foreignBalance')}>{l.currency} {fmt(l.fxBalance)}</td>
                  <td className="num ltr" data-label={t('fx.closingRate')}>{l.rate ?? '—'}{l.rateDate && <div className={`small ${l.stale ? 'bad' : 'mut'}`}>{l.rateDate}{l.stale ? ` · ${t('fx.stale')}` : ''}</div>}</td>
                  <td className="num ltr" data-label={t('fx.bookValue', { base: d.base })}>{fmt(l.bookValue)}</td>
                  <td className="num ltr" data-label={t('fx.closingValue', { base: d.base })}>{l.closingValue === null ? '—' : fmt(l.closingValue)}</td>
                  <td className={`num ltr ${toMinor(l.adjustment) < 0n ? 'bad' : ''}`} data-label={t('fx.adjustment')}><b>{fmt(l.adjustment)}</b></td>
                </tr>
              ))}</tbody>
            </table></div>
            <table className="totals"><tbody>
              <tr><td>{t('fx.unrealised')}</td><td className="num ltr">{fmt(d.unrealised)}</td></tr>
              <tr><td>{t('fx.realised')}</td><td className="num ltr">{fmt(d.realised)}</td></tr>
              <tr className="total"><td>{total >= 0n ? t('fx.netGain') : t('fx.netLoss')} ({d.base})</td><td className="num ltr" id="fx-net">{fmt(fromMinor(total < 0n ? -total : total))}</td></tr>
            </tbody></table>
            <div className="actions" style={{ marginTop: 10 }}>
              {books.canPost && <button className="b p" id="fx-post" disabled={busy || !canPost} onClick={() => void run(() => api(`/api/companies/${books.company.id}/fx/revaluation`, { body: { month: pe } }), t('fx.posted'))}>{t('fx.post', { date: pe })}</button>}
              <span className="small mut">{t('fx.postHint')}</span>
            </div>
          </>}
        </div>
      )}
      <div className="card">
        <h3>{t('fx.history')}</h3>
        {!past.data ? <Loading /> : past.data.length === 0 ? <p className="mut small">{t('fx.noHistory')}</p> : (
          <div className="wrap"><table className="stack" id="fx-history">
            <thead><tr><th>{t('fx.monthEnd')}</th><th className="num">{t('fx.unrealised')}</th><th className="num">{t('fx.realised')}</th><th>{t('fx.by')}</th><th>{t('hr.status')}</th><th /></tr></thead>
            <tbody>{past.data.map((x) => (
              <tr key={x.id} className={x.status === 'reversed' ? 'mut' : ''}>
                <td className="ltr">{x.periodEnd}</td>
                <td className="num ltr" data-label={t('fx.unrealised')}>{fmt(x.unrealised)}</td>
                <td className="num ltr" data-label={t('fx.realised')}>{fmt(x.realised)}</td>
                <td className="small" data-label={t('fx.by')}>{x.createdBy}{x.automatic && <span className="badge" style={{ marginInlineStart: 6 }}>{t('fx.automatic')}</span>}</td>
                <td data-label={t('hr.status')}><span className={`badge ${x.status === 'posted' ? 'good' : ''}`}>{t(`fx.s.${x.status}` as Key)}</span></td>
                <td className="num">{x.status === 'posted' && books.canPost && <button className="b small" disabled={busy || isLocked(books, x.periodEnd)}
                  onClick={() => void run(() => api(`/api/fx-revaluations/${x.id}/reverse`, { body: {} }), t('fx.reversed'))}>{t('fx.reverse')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
