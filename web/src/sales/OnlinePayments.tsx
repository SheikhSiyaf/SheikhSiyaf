// Sales > Online payments: the company's payment provider, the account the money lands in, and every online payment
// customers started from an invoice link (paid ones are recorded against the invoice automatically).
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from './common.tsx';

interface Settings { enabled: boolean; provider: 'sandbox' | 'moyasar'; publishableKey: string | null; hasSecret: boolean; depositAccountId: string | null; enabledBy: string | null }
interface Row { id: string; documentId: string; number: string; customer: string; amount: string; currency: string; provider: string; providerRef: string | null;
  status: 'created' | 'paid' | 'failed'; lastError: string | null; createdAt: string; paidAt: string | null; paymentNumber: string | null }

export function OnlinePayments({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const d = useApi<{ settings: Settings; payments: Row[] }>(`/api/companies/${books.company.id}/online-payments`);
  const [f, setF] = useState<Settings & { secretKey: string }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const s = d.data.settings;
  const form = f ?? { ...s, secretKey: '' };
  const banks = books.accounts.filter((a) => a.isBank);
  const save = async () => {
    setBusy(true); setMsg({});
    try { await api(`/api/companies/${books.company.id}/online-payments`, { body: form }); setF(undefined); setMsg({ ok: t('pay.saved') }); d.reload(); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('pay.hint')}</div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('pay.settings')}</h2><span className="spacer" />
          <span className={`badge ${s.enabled ? 'good' : ''}`}>{t(s.enabled ? 'pay.on' : 'pay.off')}</span></div>
        {s.enabled && s.enabledBy && <div className="small mut">{t('pay.enabledBy', { name: s.enabledBy })}</div>}
        <div className="seg" role="radiogroup" style={{ margin: '10px 0' }}>
          {(['sandbox', 'moyasar'] as const).map((p) => <button key={p} type="button" role="radio" id={`pay-provider-${p}`} aria-checked={form.provider === p}
            className={form.provider === p ? 'on' : ''} disabled={!books.canPost} onClick={() => setF({ ...form, provider: p })}>{t(`pay.provider.${p}`)}</button>)}
        </div>
        <div className="small mut" style={{ marginBottom: 8 }}>{t(`pay.providerHint.${form.provider}`)}</div>
        {form.provider !== 'sandbox' && (
          <div className="row">
            <label className="f">{t('pay.publishableKey')}<input dir="ltr" value={form.publishableKey ?? ''} disabled={!books.canPost} onChange={(e) => setF({ ...form, publishableKey: e.target.value })} /></label>
            <label className="f">{t('pay.secretKey')}<input dir="ltr" type="password" autoComplete="off" value={form.secretKey} placeholder={s.hasSecret ? t('pay.secretKept') : ''}
              disabled={!books.canPost} onChange={(e) => setF({ ...form, secretKey: e.target.value })} /></label>
          </div>
        )}
        <label className="f">{t('pay.deposit')}
          <select id="pay-deposit" value={form.depositAccountId ?? ''} disabled={!books.canPost} onChange={(e) => setF({ ...form, depositAccountId: e.target.value || null })}>
            <option value="">{t('pay.pickAccount')}</option>
            {banks.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
          </select></label>
        <div className="small mut" style={{ marginBottom: 8 }}>{t('pay.depositHint')}</div>
        <label className="check"><input type="checkbox" id="pay-enabled" checked={form.enabled} disabled={!books.canPost} onChange={(e) => setF({ ...form, enabled: e.target.checked })} />{t('pay.enable')}</label>
        {books.canPost && <div className="actions"><button className="b p" id="pay-save" disabled={busy || !f} onClick={() => void save()}>{t('save')}</button>
          {f && <button className="b" onClick={() => setF(undefined)}>{t('cancel')}</button>}</div>}
      </div>
      <div className="card">
        <h2>{t('pay.list')}</h2>
        {d.data.payments.length === 0 ? <div className="mut">{t('pay.none')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('pay.when')}</th><th>{t('pay.invoice')}</th><th>{t('pay.customer')}</th><th className="num">{t('pay.amount')}</th><th>{t('pay.status')}</th></tr></thead>
            <tbody>{d.data.payments.map((x) => (
              <tr key={x.id}>
                <td className="ltr small">{(x.paidAt ?? x.createdAt).slice(0, 16).replace('T', ' ')}</td>
                <td data-label={t('pay.invoice')}><button className="link" onClick={() => go('Sales', 'invoices', x.documentId)}>{x.number}</button></td>
                <td data-label={t('pay.customer')}>{x.customer}</td>
                <td className="num" data-label={t('pay.amount')}>{x.currency} {fmt(x.amount)}</td>
                <td data-label={t('pay.status')}><span className={`badge ${x.status === 'paid' ? 'good' : x.status === 'failed' ? 'bad' : ''}`}>{t(`pay.st.${x.status}`)}</span>
                  {x.paymentNumber && <span className="small mut"> {x.paymentNumber}</span>}{x.lastError && <div className="small mut">{x.lastError}</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
