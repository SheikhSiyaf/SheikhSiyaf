// Buying inside the software: choose the optional modules, place the order, see our bank details, and tell us about the transfer.
// The amounts shown while choosing are only a preview; the server works out the real ones from the prices in Payment settings
// (src/books/trialOrders.ts) and shows them again once the order is placed. We never take a card: the customer pays by bank transfer
// and the platform owner marks the order paid after seeing the money.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, errorText } from '../ui.tsx';
import type { TrialInfo } from './TrialScreens.tsx';
import { TransferGate } from './TransferPanel.tsx';

export const OPTIONAL = ['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM'] as const;

interface Order {
  id: string; modules: string[]; cleanup: boolean; currency: string; lines: { key: string; quantity: number; amount: number }[];
  oneTime: number; yearly: number; vatRate: string; vat: string; total: string; confirmed: boolean;
  paymentAmount: string | null; paymentDate: string | null; paymentReference: string | null;
  bank: { accountName: string; bank: string; iban: string; swift: string } | null;
}
const cents = (a: number | string) => Math.round(Number(a) * 100);

export function BuyPanel({ trial }: { trial: TrialInfo }) {
  const { t, has, lang } = useI18n();
  const cur = trial.prices?.currency ?? 'SAR';
  const price = (key: string) => cents(trial.prices?.lines.find((l) => l.key === key)?.amount ?? 0);
  const money = (c: number) => `${cur} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const order = useApi<{ order: Order | null }>('/api/trial/order');
  const [pick, setPick] = useState<string[] | undefined>();
  const [cleanup, setCleanup] = useState<boolean | undefined>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const modName = (m: string) => (has(`mod.${m}`) ? t(`mod.${m}` as Key) : m);
  if (order.error) return <ErrorNote error={order.error} onRetry={order.reload} />;
  const o = order.data?.order ?? null;
  const picked = pick ?? (o ? o.modules : trial.modules ?? []);
  const wantsCleanup = cleanup ?? (o ? o.cleanup : false);
  const toggle = (m: string) => { setError(undefined); setPick(picked.includes(m) ? picked.filter((x) => x !== m) : [...picked, m]); };
  const once = price('implementation') + (wantsCleanup ? price('cleanup') : 0);
  const yearly = price('annualCore') + price('perModule') * picked.length;

  const place = async () => {
    setBusy(true); setError(undefined);
    try { await api('/api/trial/order', { body: { modules: picked, cleanup: wantsCleanup } }); setEditing(false); setPick(undefined); setCleanup(undefined); order.reload(); }
    catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };

  if (!o || editing) {
    return (
      <section className="buy" id="buy-panel">
        <h2>{t('buy.title')}</h2>
        <p className="small mut">{t('buy.intro')}</p>
        <h3>{t('buy.modules.title')}</h3>
        <p className="small mut">{t('buy.modules.hint', { price: money(price('perModule')) })}</p>
        <div className="buy-mods" id="buy-modules">{OPTIONAL.map((m) => (
          <label key={m} className="check"><input type="checkbox" id={`buy-mod-${m}`} checked={picked.includes(m)} onChange={() => toggle(m)} />{modName(m)}</label>))}</div>
        <label className="check"><input type="checkbox" id="buy-cleanup" checked={wantsCleanup} onChange={(e) => { setError(undefined); setCleanup(e.target.checked); }} />
          {t('buy.cleanup', { price: money(price('cleanup')) })}</label>
        <table className="buy-sum" id="buy-sum"><tbody>
          <tr><th scope="row">{t('buy.sum.once')}</th><td className="ltr" id="buy-once">{money(once)}</td></tr>
          <tr><th scope="row">{t('buy.sum.year')}</th><td className="ltr" id="buy-year">{money(yearly)}</td></tr>
          <tr className="tot"><th scope="row">{t('buy.sum.sub')}</th><td className="ltr" id="buy-sub">{money(once + yearly)}</td></tr>
        </tbody></table>
        <p className="small mut">{t('buy.sum.vat')}</p>
        {error && <div className="notice bad" role="alert" id="buy-error">{error}</div>}
        <div className="actions">
          <button className="b p big" id="buy-place" disabled={busy} onClick={() => void place()}>{t('buy.place')}</button>
          {o && <button className="b" id="buy-cancel-edit" disabled={busy} onClick={() => { setEditing(false); setPick(undefined); setCleanup(undefined); }}>{t('trials.act.cancelBtn')}</button>}
        </div>
      </section>
    );
  }
  const waiting = <Waiting order={o} lang={lang} modName={modName} trial={trial} onChange={() => setEditing(true)} onSent={order.reload} />;
  // When payments by bank transfer are switched on, the transfer panel takes over (it falls back to the older form while they are off).
  return o.confirmed ? waiting : <TransferGate>{waiting}</TransferGate>;
}

function Waiting({ order: o, modName, trial, onChange, onSent }: { order: Order; lang: string; modName: (m: string) => string; trial: TrialInfo; onChange: () => void; onSent: () => void }) {
  const { t, has } = useI18n();
  const [f, setF] = useState({ amount: '', date: new Date().toISOString().slice(0, 10), reference: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = o.modules.length ? o.modules.map(modName).join(', ') : t('buy.waiting.none');
  const money = (v: string | number) => `${o.currency} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const support = trial.support?.email ?? 'hello@nusuhbooks.com';
  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      let proof: { fileBase64: string; fileType: string; fileName: string } | undefined;
      if (file) {
        if (file.size > 5 * 1024 * 1024 || !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Object.assign(new Error(t('buy.error.file')), { local: true });
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        proof = { fileBase64: btoa(bin), fileType: file.type, fileName: file.name };
      }
      await api('/api/trial/order/payment', { body: { ...f, ...proof } });
      onSent();
    } catch (e) { setError((e as { local?: boolean }).local ? (e as Error).message : errorText(t, has, e)); } finally { setBusy(false); }
  };
  if (o.confirmed) {
    return (
      <section className="buy" id="buy-panel" data-state="confirmed">
        <h2 id="buy-done-title">{t('buy.pay.done.title')}</h2>
        <p id="buy-done-body">{t('buy.pay.done.body', { amount: money(o.paymentAmount ?? 0), date: o.paymentDate ?? '', ref: o.paymentReference ?? '' })}</p>
        <p className="small mut">{t('buy.waiting.sum', { list, rate: String(Number(o.vatRate)), total: money(o.total) })}</p>
      </section>
    );
  }
  return (
    <section className="buy" id="buy-panel" data-state="waiting">
      <h2 id="buy-waiting-title">{t('buy.waiting.title')}</h2>
      <p id="buy-waiting-sum">{t('buy.waiting.sum', { list, rate: String(Number(o.vatRate)), total: money(o.total) })}</p>
      <div className="buy-bank" id="buy-bank">
        <h3>{t('buy.bank.title')}</h3>
        {o.bank ? (
          <dl>
            <dt>{t('buy.bank.account')}</dt><dd>{o.bank.accountName}</dd>
            <dt>{t('buy.bank.bank')}</dt><dd>{o.bank.bank}</dd>
            <dt>{t('buy.bank.iban')}</dt><dd className="ltr" id="buy-iban">{o.bank.iban}</dd>
            <dt>{t('buy.bank.swift')}</dt><dd className="ltr">{o.bank.swift}</dd>
          </dl>) : <p id="buy-bank-none">{t('buy.bank.none', { email: support })}</p>}
      </div>
      <h3>{t('buy.pay.title')}</h3>
      <p className="small mut">{t('buy.pay.hint')}</p>
      <form className="buy-pay" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="f">{t('buy.pay.amount')}<input id="buy-amount" inputMode="decimal" dir="ltr" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="f">{t('buy.pay.date')}<input id="buy-date" type="date" dir="ltr" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="f">{t('buy.pay.reference')}<input id="buy-reference" maxLength={80} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
        <label className="f">{t('buy.pay.file')}<input id="buy-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {error && <div className="notice bad" role="alert" id="buy-pay-error">{error}</div>}
        <div className="actions">
          <button className="b p" id="buy-send" disabled={busy || !f.amount || !f.reference}>{t('buy.pay.send')}</button>
          <button type="button" className="b" id="buy-change" disabled={busy} onClick={onChange}>{t('buy.change')}</button>
        </div>
      </form>
    </section>
  );
}
