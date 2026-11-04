// The sandbox checkout (online payments set to Sandbox): stands in for the provider's payment page while a company
// tries online payments out. No card is asked for and no money moves.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, TopControls, errorText } from '../ui.tsx';
import { goTo } from './PublicDocument.tsx';

export function SandboxPay({ refId }: { refId: string }) {
  const { t, has } = useI18n();
  const c = useApi<{ amount: string; currency: string; outcome: string | null; returnUrl: string }>(`/api/public/payments/sandbox/${encodeURIComponent(refId)}`);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string>();
  const decide = async (outcome: 'paid' | 'failed') => {
    setBusy(true); setBad(undefined);
    try { goTo((await api<{ returnUrl: string }>(`/api/public/payments/sandbox/${encodeURIComponent(refId)}`, { body: { outcome } })).returnUrl); }
    catch (e) { setBad(errorText(t, has, e)); setBusy(false); }
  };
  return (
    <main className="public-doc">
      <div className="public-actions"><b>{t('sbx.title')}</b><span className="spacer" /><TopControls /></div>
      <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>
        {c.error ? <ErrorNote error={c.error} /> : !c.data ? <Loading /> : <>
          <div className="notice warn">{t('sbx.hint')}</div>
          <div style={{ fontSize: 28, margin: '16px 0' }}><b>{c.data.currency} {fmt(c.data.amount)}</b></div>
          {bad && <div className="notice bad" role="alert">{bad}</div>}
          {c.data.outcome ? <div className="mut">{t('sbx.done')}</div> : (
            <div className="actions">
              <button className="b p" id="sbx-pay" disabled={busy} onClick={() => void decide('paid')}>{t('sbx.pay')}</button>
              <button className="b" id="sbx-decline" disabled={busy} onClick={() => void decide('failed')}>{t('sbx.decline')}</button>
            </div>
          )}
        </>}
      </div>
    </main>
  );
}
