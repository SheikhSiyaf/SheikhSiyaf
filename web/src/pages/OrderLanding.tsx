// /order: where the website's Order button lands. It carries only module names (and the clean-up flag), never a price. The selection is kept on the
// server. The person then chooses how to start: the 15-day free trial, or order and pay now (the buy screen opens straight after sign-up, with these
// modules ticked). Either way they pay by bank transfer and the order is priced again by the server. Prices shown here are the owner's, read from the software.
import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { navigate } from '../router.ts';
import { AuthShell } from './AuthShell.tsx';
import { getIntentToken, setIntentToken } from '../orderIntent.ts';

interface Site { currency: string; lines: { key: string; amount: number | string }[] }
const cents = (a: number | string) => Math.round(Number(a) * 100);

export function OrderLanding() {
  const { t, has } = useI18n();
  const [sel, setSel] = useState<{ modules: string[]; cleanup: boolean }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const site = useApi<Site>('/api/public/site-data');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    (async () => {
      try {
        const r = await api<{ token: string; modules: string[]; cleanup: boolean }>('/api/public/order-intent', { body: { modules: q.get('m') ?? '', cleanup: q.get('c') === '1' } });
        setIntentToken(r.token);
        setSel({ modules: r.modules, cleanup: r.cleanup });
        try { window.sessionStorage.setItem('nb_order_mode', q.get('mode') === 'pay' ? 'pay' : 'trial'); } catch { /* the page still works */ }
        window.history.replaceState(null, '', '/order');   // the address no longer carries the selection
      } catch (e) { setError(errorText(t, has, e)); }
    })();
  }, []);
  /** Records the choice under the secret token (the trial, or pay now), then goes to sign-up. A failure never stops the person: the trial is the default. */
  const choose = async (payFirst: boolean) => {
    setBusy(true);
    const token = getIntentToken();
    if (token) await api('/api/public/order-intent/mode', { body: { token, payFirst } }).catch(() => undefined);
    navigate('/signup');
  };
  const wantsPay = (() => { try { return window.sessionStorage.getItem('nb_order_mode') === 'pay'; } catch { return false; } })();
  const modName = (m: string) => (has(`mod.${m}`) ? t(`mod.${m}` as Key) : m);
  if (error) return <AuthShell variant="signup"><h1>{t('order.title')}</h1><div className="notice bad" role="alert" id="order-error">{error}</div><div className="actions"><button className="b p" onClick={() => navigate('/signup')}>{t('order.start')}</button></div></AuthShell>;
  if (!sel || site.loading) return <main><Loading /></main>;
  if (site.error) return <main><ErrorNote error={site.error} onRetry={site.reload} /></main>;
  const cur = site.data?.currency ?? 'SAR';
  const price = (k: string) => cents(site.data?.lines.find((l) => l.key === k)?.amount ?? 0);
  const once = price('implementation') + (sel.cleanup ? price('cleanup') : 0);
  const yearly = price('annualCore') + price('perModule') * sel.modules.length;
  const money = (c: number) => `${cur} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <AuthShell variant="signup"><h1>{t('order.title')}</h1>
      <p id="order-intro">{t('order.intro')}</p>
      <p id="order-selection"><b>{sel.modules.length ? sel.modules.map(modName).join(', ') : t('order.noModules')}</b>{sel.cleanup ? ` · ${t('order.cleanup')}` : ''}</p>
      <table className="buy-sum" id="order-sum"><tbody>
        <tr><th scope="row">{t('buy.sum.once')}</th><td className="ltr" id="order-once">{money(once)}</td></tr>
        <tr><th scope="row">{t('buy.sum.year')}</th><td className="ltr" id="order-year">{money(yearly)}</td></tr>
        <tr className="tot"><th scope="row">{t('buy.sum.sub')}</th><td className="ltr">{money(once + yearly)}</td></tr>
      </tbody></table>
      <p className="small mut">{t('order.vat')}</p>
      <div className="order-ways" id="order-ways">
        <section className={`order-way${wantsPay ? '' : ' pick'}`} id="order-way-trial">
          <h2>{t('order.trialTitle')}</h2>
          <p className="small">{t('order.trialText')}</p>
          <button className={`b ${wantsPay ? '' : 'p '}big`} id="order-start" disabled={busy} onClick={() => void choose(false)}>{t('order.start')}</button>
        </section>
        <section className={`order-way${wantsPay ? ' pick' : ''}`} id="order-way-pay">
          <h2>{t('order.payTitle')}</h2>
          <p className="small">{t('order.payText')}</p>
          <button className={`b ${wantsPay ? 'p ' : ''}big`} id="order-pay" disabled={busy} onClick={() => void choose(true)}>{t('order.payBtn')}</button>
        </section>
      </div>
      <p className="small">{t('order.how')}</p>
      <div className="actions"><button className="b big" id="order-signin" onClick={() => navigate('/')}>{t('order.signin')}</button></div>
    </AuthShell>);
}
