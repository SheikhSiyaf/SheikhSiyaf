// Paying by bank transfer (the customer's side of src/books/subpay.ts). The server shows only what the customer may see: the order, the
// bank account we publish, what they told us, and the steps so far. Nothing here decides a price, an amount or a status.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, errorText } from '../ui.tsx';

export interface PayOrder {
  id: string; reference: string; status: string; currency: string; subtotalHalalas: number | string; vatRate: string; vatHalalas: number | string; totalHalalas: number | string;
  expiresAt: string; reviewTargetHours: number;
  bank: { accountName: string; bank: string; iban: string; changedRecently: boolean } | null;
  submission: { amountHalalas: number | string; date: string; senderBank: string | null; bankRef: string | null; at: string } | null;
  timeline: { at: string; status: string; note: string | null }[];
}
export const halalasText = (h: number | string, cur: string) => { const n = BigInt(h); return `${cur} ${(n / 100n).toLocaleString('en-US')}.${String(n % 100n).padStart(2, '0')}`; };

/** Returns null when payments by transfer are not switched on, so the older form shows instead. */
export function useTransfer() { return useApi<{ enabled: boolean; order: PayOrder | null }>('/api/pay/order'); }

function Copy({ value, id, label }: { value: string; id: string; label: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return <button type="button" className="b sm" id={id} aria-label={label} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1800); }, () => undefined); }}>{done ? t('pay.copied') : t('pay.copy')}</button>;
}

export function TransferPanel({ data, reload }: { data: { enabled: boolean; order: PayOrder | null }; reload: () => void }) {
  const { t, has } = useI18n();
  const o = data.order;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => { setBusy(true); setError(undefined); try { await api('/api/pay/order', { body: {} }); reload(); } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); } };
  const startBtn = (key: Key) => (<>
    {error && <div className="notice bad" role="alert" id="pay-c-error">{error}</div>}
    <div className="actions"><button className="b p big" id="pay-c-start" disabled={busy} onClick={() => void start()}>{t(key)}</button></div></>);

  if (!o || o.status === 'expired' || o.status === 'rejected') {
    return (
      <section className="buy" id="buy-panel" data-state={o ? o.status : 'none'}>
        <h2 id="pay-c-title">{t(o?.status === 'rejected' ? 'pay.c.rejected.title' : o ? 'pay.c.expired.title' : 'pay.c.start.title')}</h2>
        <p>{t(o?.status === 'rejected' ? 'pay.c.rejected.body' : o ? 'pay.c.expired.body' : 'pay.c.start.body')}</p>
        {o?.status === 'rejected' && <Timeline o={o} />}
        {startBtn(o ? 'pay.c.again' : 'pay.c.start')}
      </section>);
  }
  const money = (h: number | string) => halalasText(h, o.currency);
  const open = o.status === 'awaiting_payment' || o.status === 'needs_info';
  return (
    <section className="buy" id="buy-panel" data-state={o.status}>
      <h2 id="pay-c-title">{t(`pay.c.status.${o.status}` as Key)}</h2>
      <p className="small mut" id="pay-c-ref-line">{t('pay.c.ref')}: <b className="ltr" id="pay-c-ref">{o.reference}</b> <Copy value={o.reference} id="pay-c-copy-ref" label={t('pay.c.ref')} /></p>
      <table className="buy-sum" id="pay-c-sum"><tbody>
        <tr><th scope="row">{t('pay.c.subtotal')}</th><td className="ltr">{money(o.subtotalHalalas)}</td></tr>
        <tr><th scope="row">{t('pay.c.vat', { rate: String(Number(o.vatRate)) })}</th><td className="ltr">{money(o.vatHalalas)}</td></tr>
        <tr className="tot"><th scope="row">{t('pay.c.total')}</th><td className="ltr" id="pay-c-total">{money(o.totalHalalas)}</td></tr>
      </tbody></table>
      {o.status === 'needs_info' && <div className="notice warn" id="pay-c-needinfo">{o.timeline.filter((e) => e.status === 'needs_info').slice(-1)[0]?.note ?? t('pay.c.needinfo')}</div>}
      {open && o.bank && <Bank o={o} />}
      {open && <Form o={o} onSent={reload} />}
      {!open && <Waiting o={o} money={money} />}
      <Timeline o={o} />
    </section>);
}

function Bank({ o }: { o: PayOrder }) {
  const { t } = useI18n();
  const b = o.bank!;
  return (
    <div className="buy-bank" id="pay-c-bank">
      <h3>{t('buy.bank.title')}</h3>
      {b.changedRecently && <div className="notice warn" id="pay-c-changed" role="note">{t('pay.c.changed')}</div>}
      <p className="small">{t('pay.c.useRef')}</p>
      <dl>
        <dt>{t('buy.bank.account')}</dt><dd>{b.accountName}</dd>
        <dt>{t('buy.bank.bank')}</dt><dd>{b.bank}</dd>
        <dt>{t('buy.bank.iban')}</dt><dd className="ltr" id="pay-c-iban">{b.iban} <Copy value={b.iban} id="pay-c-copy-iban" label={t('buy.bank.iban')} /></dd>
        <dt>{t('pay.c.amount')}</dt><dd className="ltr">{halalasText(o.totalHalalas, o.currency)} <Copy value={`${BigInt(o.totalHalalas) / 100n}.${String(BigInt(o.totalHalalas) % 100n).padStart(2, '0')}`} id="pay-c-copy-amount" label={t('pay.c.amount')} /></dd>
      </dl>
      <p className="small mut">{t('pay.c.expires', { date: o.expiresAt.slice(0, 10) })}</p>
    </div>);
}

function Form({ o, onSent }: { o: PayOrder; onSent: () => void }) {
  const { t, has } = useI18n();
  const [f, setF] = useState({ amount: '', date: new Date().toISOString().slice(0, 10), senderBank: '', bankRef: '', note: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
      await api(`/api/pay/order/${o.id}/submit`, { body: { ...f, ...proof } });
      onSent();
    } catch (e) { setError((e as { local?: boolean }).local ? (e as Error).message : errorText(t, has, e)); } finally { setBusy(false); }
  };
  return (
    <form className="buy-pay" id="pay-c-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h3>{t('buy.pay.title')}</h3>
      <p className="small mut">{t('pay.c.slipNote')}</p>
      <label className="f">{t('buy.pay.amount')}<input id="pay-c-amount" inputMode="decimal" dir="ltr" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label className="f">{t('buy.pay.date')}<input id="pay-c-date" type="date" dir="ltr" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      <label className="f">{t('pay.c.senderBank')}<input id="pay-c-sender" maxLength={120} value={f.senderBank} onChange={(e) => setF({ ...f, senderBank: e.target.value })} /></label>
      <label className="f">{t('buy.pay.reference')}<input id="pay-c-bankref" maxLength={80} value={f.bankRef} onChange={(e) => setF({ ...f, bankRef: e.target.value })} /></label>
      <label className="f">{t('pay.c.note')}<textarea id="pay-c-note" maxLength={1000} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      <label className="f">{t('buy.pay.file')}<input id="pay-c-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      {error && <div className="notice bad" role="alert" id="pay-c-form-error">{error}</div>}
      <div className="actions"><button className="b p" id="pay-c-send" disabled={busy || !f.amount}>{t('buy.pay.send')}</button></div>
    </form>);
}

function Waiting({ o, money }: { o: PayOrder; money: (h: number | string) => string }) {
  const { t } = useI18n();
  const s = o.submission;
  return (
    <div id="pay-c-wait">
      <p>{t(o.status === 'approved' ? 'pay.c.approved.body' : 'pay.c.wait.body', { hours: String(o.reviewTargetHours) })}</p>
      {s && <p className="small mut" id="pay-c-told">{t('pay.c.told', { amount: money(s.amountHalalas), date: s.date, ref: s.bankRef ?? '-' })}</p>}
    </div>);
}

function Timeline({ o }: { o: PayOrder }) {
  const { t, has } = useI18n();
  return (
    <div id="pay-c-timeline"><h3>{t('pay.c.timeline')}</h3>
      <ol className="small">{o.timeline.map((e, i) => (
        <li key={i}><span className="ltr">{e.at.slice(0, 16).replace('T', ' ')}</span> {has(`pay.c.status.${e.status}`) ? t(`pay.c.status.${e.status}` as Key) : e.status}{e.note ? `: ${e.note}` : ''}</li>))}</ol></div>);
}

export function TransferGate({ children }: { children: React.ReactNode }) {
  const d = useTransfer();
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  if (!d.data.enabled) return <>{children}</>;
  return <TransferPanel data={d.data} reload={d.reload} />;
}
