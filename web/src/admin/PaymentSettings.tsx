// Owner > Settings > Payment settings: the names and prices of the plan the public website sells. They are the plan's own
// prices, so the website and the invoices cannot disagree. Every change needs a reason, is confirmed first, and is kept.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';

type Key = 'implementation' | 'cleanup' | 'annualCore' | 'perModule';
interface Line { key: Key; name: string; nameAr: string; amount: string }
interface Data {
  planName: string; planNameAr: string; currency: string; vatRate: string; lines: Line[]; customers: number;
  history: { at: string; by: string | null; reason: string; before: Record<string, string>; after: Record<string, string>; customersAffected: number }[];
}
const fmt = (n: string) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);

export function PaymentSettings() {
  const { t, has, lang } = useI18n();
  const d = useApi<Data>('/api/owner/payment-settings');
  const [f, setF] = useState<{ planName: string; planNameAr: string; lines: Line[] }>();
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const cur = d.data;
  const form = f ?? { planName: cur.planName, planNameAr: cur.planNameAr, lines: cur.lines };
  const setLine = (key: Key, patch: Partial<Line>) => { setMsg({}); setF({ ...form, lines: form.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }); };
  const changed = form.planName !== cur.planName || form.planNameAr !== cur.planNameAr
    || form.lines.some((l, i) => l.name !== cur.lines[i]!.name || l.nameAr !== cur.lines[i]!.nameAr || Number(l.amount) !== Number(cur.lines[i]!.amount));
  const lineName = (l: Line) => (lang === 'ar' && l.nameAr ? l.nameAr : l.name);
  const save = async () => {
    setBusy(true); setMsg({});
    try {
      const r = await api<{ changed: boolean }>('/api/owner/payment-settings', { body: { planName: form.planName, planNameAr: form.planNameAr, lines: form.lines, reason } });
      setMsg({ ok: t(r.changed ? 'psettings.saved' : 'psettings.nothing') }); setF(undefined); setReason(''); setStep('edit'); d.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); setStep('edit'); } finally { setBusy(false); }
  };
  const desc = (k: Key) => t(`psettings.line.${k}`);
  return (
    <div className="card" id="pay-settings">
      <h2>{t('psettings.title')}</h2>
      <div className="small mut" style={{ marginBottom: 8 }}>{t('psettings.hint')}</div>
      {msg.ok && <div className="notice" id="pay-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" id="pay-error">{msg.bad}</div>}
      {step === 'edit' ? (
        <form onSubmit={(e) => { e.preventDefault(); if (changed) setStep('confirm'); }}>
          <div className="row">
            <label className="f">{t('psettings.plan')}<input id="pay-plan" value={form.planName} onChange={(e) => { setMsg({}); setF({ ...form, planName: e.target.value }); }} maxLength={60} /></label>
            <label className="f">{t('psettings.planAr')}<input id="pay-plan-ar" dir="rtl" value={form.planNameAr} onChange={(e) => { setMsg({}); setF({ ...form, planNameAr: e.target.value }); }} maxLength={60} /></label>
          </div>
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('psettings.col.line')}</th><th>{t('psettings.col.name')}</th><th>{t('psettings.col.nameAr')}</th><th>{t('psettings.col.price', { cur: cur.currency })}</th></tr></thead>
            <tbody>{form.lines.map((l) => (
              <tr key={l.key}>
                <td className="small mut">{desc(l.key)}</td>
                <td><input id={`pay-name-${l.key}`} aria-label={t('psettings.col.name')} value={l.name} maxLength={60} onChange={(e) => setLine(l.key, { name: e.target.value })} /></td>
                <td><input id={`pay-ar-${l.key}`} aria-label={t('psettings.col.nameAr')} dir="rtl" value={l.nameAr} maxLength={60} onChange={(e) => setLine(l.key, { nameAr: e.target.value })} /></td>
                <td><input id={`pay-amount-${l.key}`} aria-label={t('psettings.col.price', { cur: cur.currency })} inputMode="decimal" dir="ltr" value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} /></td>
              </tr>))}</tbody>
          </table></div>
          <div className="small mut" style={{ margin: '6px 0' }}>{t('psettings.vat', { rate: String(Number(cur.vatRate)) })}</div>
          <div className="actions"><button className="b p" id="pay-review" disabled={!changed}>{t('psettings.review')}</button></div>
        </form>
      ) : (
        <div id="pay-confirm">
          <h3>{t('psettings.confirmTitle')}</h3>
          <div className="wrap"><table>
            <thead><tr><th>{t('psettings.col.line')}</th><th>{t('psettings.before')}</th><th>{t('psettings.after')}</th></tr></thead>
            <tbody>{form.lines.map((l, i) => {
              const o = cur.lines[i]!;
              const diff = l.name !== o.name || l.nameAr !== o.nameAr || Number(l.amount) !== Number(o.amount);
              return diff ? <tr key={l.key}><td>{lineName(o)}</td><td className="ltr">{o.name} · {cur.currency} {fmt(o.amount)}</td><td className="ltr"><b>{l.name} · {cur.currency} {fmt(l.amount)}</b></td></tr> : null;
            })}
              {(form.planName !== cur.planName || form.planNameAr !== cur.planNameAr) && <tr><td>{t('psettings.plan')}</td><td>{cur.planName}</td><td><b>{form.planName}</b></td></tr>}</tbody>
          </table></div>
          <div className="notice" id="pay-affect">{t('psettings.affect', { n: cur.customers })}</div>
          <label className="f">{t('psettings.reason')}<input id="pay-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="actions">
            <button className="b p" id="pay-confirm-go" disabled={busy || !reason.trim()} onClick={() => void save()}>{t('psettings.confirm')}</button>
            <button className="b" id="pay-back" disabled={busy} onClick={() => setStep('edit')}>{t('psettings.back')}</button>
          </div>
        </div>
      )}
      <h3 style={{ marginTop: 14 }}>{t('psettings.history')}</h3>
      {cur.history.length === 0 ? <div className="small mut" id="pay-history-none">{t('psettings.history.none')}</div> : (
        <div className="wrap"><table id="pay-history">
          <thead><tr><th>{t('psettings.h.when')}</th><th>{t('psettings.h.by')}</th><th>{t('psettings.h.reason')}</th><th>{t('psettings.h.changes')}</th></tr></thead>
          <tbody>{cur.history.map((h, i) => (
            <tr key={i}><td className="ltr">{when(h.at)}</td><td>{h.by ?? ''}</td><td>{h.reason}</td>
              <td className="small ltr">{Object.keys(h.after).map((k) => <div key={k}>{k}: {h.before[k]} → {h.after[k]}</div>)}</td></tr>))}</tbody>
        </table></div>)}
    </div>
  );
}
