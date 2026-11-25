// The free trial on screen: the "X days left" bar for everyone in a trial, and what a customer sees once the trial is over
// (src/books/trialRules.ts decides which; /api/trial says). While the trial has ended the customer can only buy, contact us,
// and export its data; once the account is closed only the export, until the date; after that only a closed-account page.
import { useEffect } from 'react';
import { api, useApi, type Me } from '../api.ts';
import { usePath } from '../router.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { TopControls } from '../ui.tsx';

export interface TrialInfo {
  level: 'full' | 'locked' | 'export_only' | 'closed';
  trialing: boolean; daysLeft: number | null;
  trialEndsAt: string | null; graceEndsAt: string | null; exportUntil: string | null; deleteNotBefore: string | null;
  modules?: string[];
  prices?: { currency: string; lines: { key: string; name: string; nameAr: string; amount: number | string }[] };
  support?: { email: string; phone: string; hours: string; website: string };
  buyUrl?: string;
}
const BUY = 'https://nusuhbooks.com/order/';   // until buying happens inside the software (it opens the website's Order page)
const CONTACT = { email: 'hello@nusuhbooks.com', phone: '+966 546958273', hours: '8:00 am to 6:00 pm' };

function useDay() {
  const { lang } = useI18n();
  return (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { dateStyle: 'full', timeZone: 'Asia/Riyadh' }).format(new Date(iso)) : '');
}

/** The slim bar at the top while a free trial is open: how many days are left, and the way to buy. Nothing for anyone else. */
export function TrialBar() {
  const { t } = useI18n();
  const trial = useApi<TrialInfo>('/api/trial');
  const day = useDay();
  // Ask again when the person moves to another screen: the first look may have been before they signed in.
  const path = usePath();
  useEffect(() => { trial.reload(); }, [path, trial.reload]);
  const d = trial.data;
  if (!d || !d.trialing || d.daysLeft === null) return null;
  const urgent = d.daysLeft <= 3;
  return (
    <div className={`trial-bar${urgent ? ' urgent' : ''}`} id="trial-bar" role="note">
      <span id="trial-days">{d.daysLeft === 1 ? t('trialui.bar.last') : t('trialui.bar', { n: d.daysLeft })}</span>
      <span className="trial-until">{t('trialui.bar.until', { date: day(d.trialEndsAt) })}</span>
      <a className="trial-buy" id="trial-buy" href={d.buyUrl ?? BUY} target="_blank" rel="noopener noreferrer">{t('trialui.buy')}</a>
    </div>
  );
}

function ContactLine({ t, support = CONTACT }: { t: ReturnType<typeof useI18n>['t']; support?: { email: string; phone: string; hours: string } }) {
  return <p className="small mut" id="trialui-contact">{t('trialui.contact', { email: support.email, phone: support.phone, hours: support.hours })}</p>;
}

/** The screen that replaces the software when the free trial has ended (locked) or the account is closed (export only). */
export function TrialEnded({ me, trial, onSignOut }: { me: Me; trial: TrialInfo; onSignOut: () => void }) {
  const { t, has, lang } = useI18n();
  const day = useDay();
  const closed = trial.level === 'export_only';
  const mod = trial.prices?.lines.find((l) => l.key === 'perModule');
  const price = mod ? `${trial.prices!.currency} ${Number(mod.amount).toLocaleString('en-US')}` : '';
  const modules = trial.modules ?? [];
  const companies = me.companies;
  return (
    <main className="trial-ended" id="trial-ended" data-level={trial.level}>
      <div className="card" style={{ maxWidth: 720, margin: '40px auto' }}>
        <div className="top"><TopControls /></div>
        <h1 id="trialui-title">{t(closed ? 'trialui.closed.title' : 'trialui.ended.title')}</h1>
        <p id="trialui-body">{closed
          ? t('trialui.closed.body', { until: day(trial.exportUntil), delete: day(trial.deleteNotBefore) })
          : t('trialui.ended.body', { date: day(trial.graceEndsAt) })}</p>
        <div className="actions"><a className="b p" id="trialui-buy" href={trial.buyUrl ?? BUY} target="_blank" rel="noopener noreferrer">{t('trialui.buy')}</a></div>
        <p className="small mut">{t('trialui.buyHint')}</p>

        <h2>{t('trialui.export.title')}</h2>
        {companies.length > 0 ? (
          <>
            <p className="small mut">{t('trialui.export.hint')}</p>
            <ul id="trialui-exports" style={{ paddingInlineStart: 18 }}>
              {companies.map((c) => (
                <li key={c.id}><a href={`/api/companies/${c.id}/export`} download>{t('trialui.export.company', { name: lang === 'ar' && c.nameAr ? c.nameAr : c.name })}</a></li>))}
            </ul>
          </>
        ) : <p className="small mut" id="trialui-export-admin">{t('trialui.export.admin')}</p>}

        {!closed && (
          <>
            <h2>{t('trialui.modules.title')}</h2>
            <p id="trialui-modules">{modules.length
              ? t('trialui.modules.some', { list: modules.map((m) => (has(`mod.${m}`) ? t(`mod.${m}` as Key) : m)).join(', '), price })
              : t('trialui.modules.none')}</p>
          </>)}
        <ContactLine t={t} support={trial.support} />
        <div className="actions"><button className="b" id="trialui-signout" onClick={onSignOut}>{t('signOut')}</button></div>
      </div>
    </main>
  );
}

/** After the export window: nothing is left to open. */
export function ClosedAccount({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useI18n();
  return (
    <main className="trial-ended" id="trial-closed">
      <div className="card" style={{ maxWidth: 560, margin: '60px auto' }}>
        <div className="top"><TopControls /></div>
        <h1>{t('trialui.closed.title')}</h1>
        <p>{t('trialui.closedPage.body')}</p>
        <ContactLine t={t} />
        <div className="actions"><button className="b" id="trialui-signout" onClick={() => { void api('/api/logout', { method: 'POST', body: {} }).catch(() => undefined).then(onSignOut); }}>{t('signOut')}</button></div>
      </div>
    </main>
  );
}
