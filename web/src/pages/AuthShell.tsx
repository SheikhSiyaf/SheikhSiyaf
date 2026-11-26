// The frame of the sign-in, sign-up and e-mail-confirmation pages: the form on one side and a brand panel on the other
// (the panel follows the reading direction, so it flips in Arabic). On a phone the panel is replaced by a row of short trust points.
import type { ReactNode } from 'react';
import { useI18n, type Key } from '../i18n.tsx';
import { toggleTheme } from '../theme.ts';
import { NusuhMark } from '../brand.tsx';

/** The side panel's points on the sign-in page: a key (login.<key>.t and .d) and an icon path. */
const FEATURES: [string, string][] = [
  ['f1', 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6'],
  ['f2', 'M4 5h16M12 3v2M7 9c1 3 3 6 6 8M5 17c4-1 7-4 8-8M13 19l4-9 4 9M14.5 16h5'],
  ['f3', 'M3 21V8l7-4v17M10 21h11V11l-5-3M7 11v.01M7 15v.01M14 15v.01M17 15v.01'],
  ['f4', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'],
];
const BADGES: [Key, string][] = [
  ['auth.b.zatca', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'],
  ['auth.b.bilingual', 'M4 5h16M12 3v2M7 9c1 3 3 6 6 8M5 17c4-1 7-4 8-8M13 19l4-9 4 9M14.5 16h5'],
  ['auth.b.trial', 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z'],
];

const Icon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export function AuthShell({ variant, wide, children }: { variant: 'login' | 'signup'; wide?: boolean; children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const title = variant === 'login' ? t('login.panelTitle') : t('signup.panelTitle');
  return (
    <main className={`auth auth-${variant}`}>
      <section className="auth-form">
        <header className="auth-top">
          <span className="auth-brand"><NusuhMark size={36} /><b>{t('app.name')}</b></span>
          <span className="actions">
            <button className="b" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>{t('lang.toggle')}</button>
            <button className="b" onClick={toggleTheme} aria-label={t('theme.toggle')}>◐</button>
          </span>
        </header>
        <div className={`login ${wide ? 'signup' : ''}`}>
          {children}
          <ul className="auth-trust" aria-label={t('auth.trustLabel')}>
            {BADGES.map(([k, d]) => <li key={k}><Icon d={d} size={16} />{t(k)}</li>)}
          </ul>
        </div>
        <footer className="auth-foot small mut">{t('login.foot', { year: String(new Date().getFullYear()) })}</footer>
      </section>

      <aside className="auth-aside" aria-label={title}>
        <div className="aside-inner">
          <span className="aside-tag">{t('auth.b.zatca')}</span>
          <h2>{title}</h2>
          <p className="aside-sub">{variant === 'login' ? t('login.panelSub') : t('signup.panelSub')}</p>
          {variant === 'login' ? (
            <ul className="aside-features">
              {FEATURES.map(([key, d]) => (
                <li key={key}>
                  <span className="fi"><Icon d={d} /></span>
                  <span><b>{t(`login.${key}.t` as Key)}</b><small>{t(`login.${key}.d` as Key)}</small></span>
                </li>
              ))}
            </ul>
          ) : (
            <ol className="aside-steps">
              {[1, 2, 3].map((n) => (
                <li key={n}>
                  <span className="sn" aria-hidden="true">{n}</span>
                  <span><b>{t(`signup.step${n}.t` as Key)}</b><small>{t(`signup.step${n}.d` as Key)}</small></span>
                </li>
              ))}
            </ol>
          )}
          <div className="aside-preview" aria-hidden="true">
            <div className="pv-head"><span>{t('login.pv.cash')}</span><em>{t('login.preview')}</em></div>
            <div className="pv-big">SAR 482,300.00</div>
            <svg viewBox="0 0 220 56" width="100%" height="56" preserveAspectRatio="none"><polyline points="0,44 22,38 44,41 66,30 88,33 110,22 132,26 154,14 176,18 198,8 220,10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
            <div className="pv-row"><div><small>{t('login.pv.sales')}</small><b>128,450.00</b></div><div><small>{t('login.pv.due')}</small><b>61,900.00</b></div></div>
          </div>
        </div>
      </aside>
    </main>
  );
}

/** A bar that shows how strong a password looks as it is typed. It only guides: the rules are checked by the server. */
export function strengthOf(p: string): 0 | 1 | 2 | 3 {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 10) s++;
  if (/[A-Za-z]/.test(p) && /[0-9\W_]/.test(p)) s++;
  if (p.length >= 14 || (/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[\W_]/.test(p))) s++;
  return Math.max(1, s) as 1 | 2 | 3;
}
export function StrengthMeter({ value }: { value: string }) {
  const { t } = useI18n();
  const s = strengthOf(value);
  return (
    <div className="pw-meter" data-s={s} id="pw-meter" role="status" aria-live="polite">
      <span className="bars" aria-hidden="true"><i /><i /><i /></span>
      <small>{s === 0 ? '' : t(`pw.s${s}` as Key)}</small>
    </div>
  );
}
