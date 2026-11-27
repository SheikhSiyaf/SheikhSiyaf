// The free trial on screen: the "X days left" bar for everyone in a trial, and what a customer sees once the trial is over
// (src/books/trialRules.ts decides which; /api/trial says). While the trial has ended the customer can only buy, contact us,
// and export its data; once the account is closed only the export, until the date; after that only a closed-account page.
import { useEffect, useState } from 'react';
import { api, useApi, type Me } from '../api.ts';
import { navigate, usePath } from '../router.ts';
import { BuyPanel } from './BuyPanel.tsx';
import { useI18n, type Key } from '../i18n.tsx';
import { TopControls } from '../ui.tsx';

export interface TrialInfo {
  level: 'full' | 'locked' | 'export_only' | 'closed';
  trialing: boolean; daysLeft: number | null; softDay?: boolean; softEndsAt?: string | null;
  trialEndsAt: string | null; graceEndsAt: string | null; exportUntil: string | null; deleteNotBefore: string | null;
  modules?: string[];
  intent?: { modules: string[]; cleanup: boolean; payFirst?: boolean } | null;   // what they chose on the website, if they came from its Order button
  prices?: { currency: string; lines: { key: string; name: string; nameAr: string; amount: number | string }[] };
  support?: { email: string; phone: string; hours: string; website: string };
  buyUrl?: string;
  testimonials?: { name: string; nameAr: string; role: string; roleAr: string; company: string; companyAr: string; quote: string; quoteAr: string }[];
}
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
  const [seen, setSeen] = useState(false);
  if (!d || !d.trialing || d.daysLeft === null) return null;
  if (d.softDay) {
    return (
      <>
        <div className="trial-bar urgent" id="trial-bar" role="note">
          <span id="trial-days">{t('trialui.bar.soft')}</span>
          <a className="trial-buy" id="trial-buy" href="/buy" onClick={(e) => { e.preventDefault(); navigate('/buy'); }}>{t('trialui.buy')}</a>
        </div>
        {!seen && (
          <div className="soft-pop" id="soft-pop" role="dialog" aria-modal="true" aria-labelledby="soft-title">
            <div className="card">
              <h2 id="soft-title">{t('trialui.soft.title')}</h2>
              <p>{t('trialui.soft.body')}</p>
              <div className="actions">
                <button className="b p big" id="soft-buy" onClick={() => { setSeen(true); navigate('/buy'); }}>{t('trialui.soft.buy')}</button>
                <button className="b" id="soft-later" onClick={() => setSeen(true)}>{t('trialui.soft.later')}</button>
              </div>
            </div>
          </div>)}
      </>
    );
  }
  const urgent = d.daysLeft <= 3;
  return (
    <div className={`trial-bar${urgent ? ' urgent' : ''}`} id="trial-bar" role="note">
      <span id="trial-days">{d.daysLeft === 1 ? t('trialui.bar.last') : t('trialui.bar', { n: d.daysLeft })}</span>
      <span className="trial-until">{t('trialui.bar.until', { date: day(d.trialEndsAt) })}</span>
      <a className="trial-buy" id="trial-buy" href="/buy" onClick={(e) => { e.preventDefault(); navigate('/buy'); }}>{t('trialui.buy')}</a>
    </div>
  );
}

function ContactLine({ t, support = CONTACT }: { t: ReturnType<typeof useI18n>['t']; support?: { email: string; phone: string; hours: string } }) {
  return <p className="small mut" id="trialui-contact">{t('trialui.contact', { email: support.email, phone: support.phone, hours: support.hours })}</p>;
}

/** The screen that replaces the software when the free trial has ended (locked) or the account is closed (export only). It is
 *  also the one place a customer is asked to buy, so it says plainly what they keep, what it costs and how buying works, with
 *  our own words (the website's) and, when there are any, the owner's real customer quotes. Nothing here is invented. */
export function TrialEnded({ me, trial, onSignOut }: { me: Me; trial: TrialInfo; onSignOut: () => void }) {
  const { t, has, lang } = useI18n();
  const day = useDay();
  const closed = trial.level === 'export_only';
  const lines = trial.prices?.lines ?? [];
  const cur = trial.prices?.currency ?? 'SAR';
  const money = (a: number | string) => `${cur} ${Number(a).toLocaleString('en-US', Number(a) % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined)}`;
  const when: Record<string, Key> = { implementation: 'trialui.price.once', cleanup: 'trialui.price.onceOptional', annualCore: 'trialui.price.year', perModule: 'trialui.price.yearModule' };
  const mod = lines.find((l) => l.key === 'perModule');
  const modules = trial.modules ?? [];
  const companies = me.companies;
  const buyButton = (id: string) => <a className="b p big" id={id} href="#buy-panel">{t('trialui.buy')}</a>;
  return (
    <main className="trial-ended" id="trial-ended" data-level={trial.level}>
      <div className="te-wrap">
        <div className="card te-main">
          <div className="top"><TopControls /></div>
          <span className="te-eyebrow">{t(closed ? 'trialui.eyebrow.closed' : 'trialui.eyebrow')}</span>
          <h1 id="trialui-title">{t(closed ? 'trialui.closed.title' : 'trialui.ended.title')}</h1>
          <p className="te-lead" id="trialui-body">{closed
            ? t('trialui.closed.body', { until: day(trial.exportUntil), delete: day(trial.deleteNotBefore) })
            : t('trialui.ended.body', { date: day(trial.graceEndsAt) })}</p>

          <div className="te-keep" id="trialui-keep">
            <b>{t('trialui.keep.title')}</b>
            <ul>{(['trialui.keep.1', 'trialui.keep.2', 'trialui.keep.3'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
          </div>

          {lines.length > 0 && (
            <div className="te-price" id="trial-price">
              <h2>{t('trialui.price.title')}</h2>
              <table><tbody>{lines.map((l) => (
                <tr key={l.key}>
                  <th scope="row">{lang === 'ar' && l.nameAr ? l.nameAr : l.name}<small>{when[l.key] ? t(when[l.key]!) : ''}</small></th>
                  <td className="ltr">{money(l.amount)}</td>
                </tr>))}</tbody></table>
              <p className="small mut">{t('trialui.price.vat')}</p>
            </div>)}

          <BuyPanel trial={trial} />
          <p className="small mut">{t('trialui.buyHint')}</p>

          <div className="te-steps" id="trial-steps">
            <h2>{t('trialui.steps.title')}</h2>
            <ol>
              <li><b>{t('trialui.steps.1')}</b><span>{t('trialui.steps.1d')}</span></li>
              <li><b>{t('trialui.steps.2')}</b><span>{t('trialui.steps.2d')}</span></li>
              <li><b>{t('trialui.steps.3')}</b><span>{t('trialui.steps.3d')}</span></li>
            </ol>
          </div>

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
                ? t('trialui.modules.some', { list: modules.map((m) => (has(`mod.${m}`) ? t(`mod.${m}` as Key) : m)).join(', '), price: mod ? money(mod.amount) : '' })
                : t('trialui.modules.none')}</p>
            </>)}
          <ContactLine t={t} support={trial.support} />
          <div className="actions"><button className="b" id="trialui-signout" onClick={onSignOut}>{t('signOut')}</button></div>
        </div>

        <aside className="te-promo" id="trial-promo" aria-label={t('trialui.promo.kicker')}>
          <span className="te-kicker">{t('trialui.promo.kicker')}</span>
          <h2>{t('trialui.promo.title')}</h2>
          <p>{t('trialui.promo.body')}</p>
          <div className="te-badges">
            {(['trialui.promo.b1', 'trialui.promo.b2', 'trialui.promo.b3'] as const).map((k) => <span key={k}>{t(k)}</span>)}
          </div>
          {(trial.testimonials?.length ?? 0) > 0 && (
            <div className="te-say" id="trial-testimonials">
              <b>{t('trialui.promo.say')}</b>
              {trial.testimonials!.map((q, i) => {
                const name = lang === 'ar' && q.nameAr ? q.nameAr : q.name, quote = lang === 'ar' && q.quoteAr ? q.quoteAr : q.quote;
                const who = [lang === 'ar' && q.roleAr ? q.roleAr : q.role, lang === 'ar' && q.companyAr ? q.companyAr : q.company].filter(Boolean).join(', ');
                return <figure key={i}><blockquote>{'\u201C'}{quote}{'\u201D'}</blockquote><figcaption><b>{name}</b>{who && <span>{who}</span>}</figcaption></figure>;
              })}
            </div>)}
          <div className="actions">{buyButton('trialui-buy-2')}</div>
          <p className="small te-talk">{t('trialui.promo.talk')} {trial.support?.email ?? CONTACT.email}</p>
        </aside>
      </div>
    </main>
  );
}

/** Buying while the free trial is still open: the same order and payment steps, from the "Buy" link in the trial bar. */
export function BuyPage({ trial }: { trial: TrialInfo }) {
  const { t } = useI18n();
  return (
    <main className="trial-ended" id="buy-page">
      <div className="card" style={{ maxWidth: 720, margin: '24px auto' }}>
        <div className="top"><TopControls /></div>
        <BuyPanel trial={trial} />
        <div className="actions"><button className="b" id="buy-back" onClick={() => navigate('/')}>{t('buy.back')}</button></div>
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
