// Owner > Payments: the switch for payments by bank transfer, the review and order rules, and the bank details customers pay into.
// The bank details are protected: only the Owner role changes them, after confirming who they are; a change shows to customers only after a delay,
// every Owner is e-mailed, and any Owner can cancel it while it waits. Every check is made again in the database.
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';

interface Settings { enabled: boolean; reviewTargetHours: number; orderOpenDays: number; bankChangeDelayHours: number; bankReady: boolean }
interface Bank { accountName: string; bank: string; iban: string; swift: string | null }
interface BankData {
  delayHours: number; live: (Bank & { changedAt: string | null }) | null;
  pending: (Bank & { id: string; effectiveAt: string; requestedAt: string; by: string | null }) | null;
  history: { at: string; state: 'pending' | 'applied' | 'cancelled'; by: string | null; accountName: string; iban: string }[];
}
const riyadh = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
const grouped = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

export function OwnerPayments() {
  const { t, has } = useI18n();
  const s = useApi<Settings>('/api/staff/payments-settings');
  const b = useApi<BankData>('/api/staff/payments/bank');
  const [form, setForm] = useState<Pick<Settings, 'reviewTargetHours' | 'orderOpenDays' | 'bankChangeDelayHours'>>();
  const [bankForm, setBankForm] = useState<{ accountName: string; bank: string; iban: string; swift: string; password: string; code: string }>();
  const [confirm, setConfirm] = useState<'on' | 'off' | 'cancel'>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); s.reload(); b.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (b.error) return <ErrorNote error={b.error} onRetry={b.reload} />;
  if (!s.data || !b.data) return <Loading />;
  const st = s.data, bank = b.data;
  const f = form ?? { reviewTargetHours: st.reviewTargetHours, orderOpenDays: st.orderOpenDays, bankChangeDelayHours: st.bankChangeDelayHours };
  const num = (v: string) => (v === '' ? NaN : Number(v));
  const saveSettings = (enabled: boolean, rest = f) => run(async () => { await api('/api/staff/payments-settings', { body: { enabled, ...rest } }); setForm(undefined); }, t('pay.savedBt'));

  const submitBank = (e: FormEvent) => {
    e.preventDefault();
    if (!bankForm) return;
    const x = bankForm;
    void run(async () => {
      const r = await api<{ immediate: boolean }>('/api/staff/payments/bank', { body: x });
      setBankForm(undefined);
      setMsg({ ok: r.immediate ? t('pay.bank.savedNow') : t('pay.bank.savedWaiting', { hours: bank.delayHours }) });
    });
  };

  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('pay.hintBt')}</div>
      {msg.ok && <div className="notice" id="pay-ok">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" id="pay-error">{msg.bad}</div>}
      {confirm === 'on' && <ConfirmBar busy={busy} message={t('pay.onConfirm')} onNo={() => setConfirm(undefined)} onYes={() => { setConfirm(undefined); void saveSettings(true); }} />}
      {confirm === 'off' && <ConfirmBar busy={busy} message={t('pay.offConfirm')} onNo={() => setConfirm(undefined)} onYes={() => { setConfirm(undefined); void saveSettings(false); }} />}
      {confirm === 'cancel' && bank.pending && <ConfirmBar busy={busy} message={t('pay.bank.cancelConfirm')} onNo={() => setConfirm(undefined)}
        onYes={() => { const id = bank.pending!.id; setConfirm(undefined); void run(() => api(`/api/staff/payments/bank/${id}/cancel`, { body: {} }), t('pay.bank.cancelled')); }} />}

      <div className="card" id="pay-switch">
        <h2>{t('pay.switch')}</h2>
        <p>{st.enabled ? <b id="pay-state">{t('pay.state.on')}</b> : <b id="pay-state">{t('pay.state.off')}</b>} <span className="mut small">{t(st.enabled ? 'pay.state.onSub' : 'pay.state.offSub')}</span></p>
        {!st.bankReady && !st.enabled && <div className="notice warn" id="pay-need-bank">{t('pay.needBank')}</div>}
        <button className={st.enabled ? 'b' : 'b p'} id="pay-toggle" disabled={busy || (!st.enabled && !st.bankReady)} onClick={() => setConfirm(st.enabled ? 'off' : 'on')}>{t(st.enabled ? 'pay.turnOff' : 'pay.turnOn')}</button>
      </div>

      <form className="card" id="pay-rules" onSubmit={(e) => { e.preventDefault(); void saveSettings(st.enabled); }}>
        <h2>{t('pay.rules')}</h2>
        <label className="f">{t('pay.reviewHours')}<input id="pay-hours" type="number" min={1} max={168} value={Number.isNaN(f.reviewTargetHours) ? '' : f.reviewTargetHours} onChange={(e) => setForm({ ...f, reviewTargetHours: num(e.target.value) })} /></label>
        <div className="mut small">{t('pay.reviewHoursHint')}</div>
        <label className="f">{t('pay.openDays')}<input id="pay-days" type="number" min={1} max={90} value={Number.isNaN(f.orderOpenDays) ? '' : f.orderOpenDays} onChange={(e) => setForm({ ...f, orderOpenDays: num(e.target.value) })} /></label>
        <label className="f">{t('pay.delayHours')}<input id="pay-delay" type="number" min={1} max={168} value={Number.isNaN(f.bankChangeDelayHours) ? '' : f.bankChangeDelayHours} onChange={(e) => setForm({ ...f, bankChangeDelayHours: num(e.target.value) })} /></label>
        <div className="mut small">{t('pay.delayHint')}</div>
        <div className="actions"><button className="b p" id="pay-rules-save" disabled={busy || !form}>{t('save')}</button></div>
      </form>

      <div className="card" id="pay-bank">
        <h2>{t('pay.bank')}</h2>
        {bank.live ? (
          <dl className="kv" id="pay-bank-live">
            <dt>{t('pay.bank.name')}</dt><dd>{bank.live.accountName}</dd>
            <dt>{t('pay.bank.bankName')}</dt><dd>{bank.live.bank}</dd>
            <dt>IBAN</dt><dd dir="ltr">{grouped(bank.live.iban)}</dd>
            {bank.live.swift && <><dt>SWIFT</dt><dd dir="ltr">{bank.live.swift}</dd></>}
            {bank.live.changedAt && <><dt>{t('pay.bank.since')}</dt><dd>{riyadh(bank.live.changedAt)}</dd></>}
          </dl>
        ) : <div className="notice warn" id="pay-bank-none">{t('pay.bank.none')}</div>}

        {bank.pending && (
          <div className="notice warn" id="pay-bank-pending" role="status">
            <b>{t('pay.bank.pendingTitle')}</b>
            <div>{t('pay.bank.pendingBody', { name: bank.pending.accountName, iban: grouped(bank.pending.iban), at: riyadh(bank.pending.effectiveAt), by: bank.pending.by ?? '' })}</div>
            <div className="actions"><button className="b" id="pay-bank-cancel" disabled={busy} onClick={() => setConfirm('cancel')}>{t('pay.bank.cancel')}</button></div>
          </div>
        )}

        {!bankForm && <button className="b p" id="pay-bank-change" onClick={() => setBankForm({ accountName: bank.live?.accountName ?? '', bank: bank.live?.bank ?? '', iban: '', swift: bank.live?.swift ?? '', password: '', code: '' })}>{t(bank.live ? 'pay.bank.change' : 'pay.bank.enter')}</button>}
        {bankForm && (
          <form onSubmit={submitBank} id="pay-bank-form" className="inset">
            <div className="notice warn small">{t(bank.live ? 'pay.bank.warnChange' : 'pay.bank.warnFirst', { hours: bank.delayHours })}</div>
            <label className="f">{t('pay.bank.name')}<input id="pay-bank-name" value={bankForm.accountName} onChange={(e) => setBankForm({ ...bankForm, accountName: e.target.value })} required maxLength={120} autoComplete="off" /></label>
            <label className="f">{t('pay.bank.bankName')}<input id="pay-bank-bank" value={bankForm.bank} onChange={(e) => setBankForm({ ...bankForm, bank: e.target.value })} required maxLength={120} autoComplete="off" /></label>
            <label className="f">IBAN<input id="pay-bank-iban" dir="ltr" value={bankForm.iban} onChange={(e) => setBankForm({ ...bankForm, iban: e.target.value })} required placeholder="SA00 0000 0000 0000 0000 0000" autoComplete="off" /></label>
            <label className="f">SWIFT ({t('optional')})<input id="pay-bank-swift" dir="ltr" value={bankForm.swift} onChange={(e) => setBankForm({ ...bankForm, swift: e.target.value })} maxLength={30} autoComplete="off" /></label>
            <hr />
            <div className="mut small">{t('pay.bank.confirmWho')}</div>
            <label className="f">{t('pay.bank.password')}<input id="pay-bank-password" type="password" value={bankForm.password} onChange={(e) => setBankForm({ ...bankForm, password: e.target.value })} required autoComplete="current-password" /></label>
            <label className="f">{t('pay.bank.code')}<input id="pay-bank-code" inputMode="numeric" value={bankForm.code} onChange={(e) => setBankForm({ ...bankForm, code: e.target.value })} maxLength={8} autoComplete="one-time-code" /></label>
            <div className="actions"><button className="b p" id="pay-bank-save" disabled={busy}>{t('pay.bank.submit')}</button><button type="button" className="b" onClick={() => setBankForm(undefined)}>{t('cancel')}</button></div>
          </form>
        )}

        {bank.history.length > 0 && (
          <div className="wrap"><table className="stack" id="pay-bank-history">
            <thead><tr><th>{t('pay.bank.when')}</th><th>{t('pay.bank.by')}</th><th>{t('pay.bank.name')}</th><th>IBAN</th><th>{t('staff.status')}</th></tr></thead>
            <tbody>{bank.history.map((h, i) => <tr key={i}><td>{riyadh(h.at)}</td><td>{h.by}</td><td>{h.accountName}</td><td dir="ltr">{grouped(h.iban)}</td><td>{t(`pay.bank.state.${h.state}`)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
