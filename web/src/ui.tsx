// Shared bits: top bar controls, error and loading states.
import type { ReactNode } from 'react';
import { ApiError } from './api.ts';
import { useI18n } from './i18n.tsx';
import { toggleTheme } from './theme.ts';

export function errorText(t: ReturnType<typeof useI18n>['t'], has: ReturnType<typeof useI18n>['has'], e: unknown): string {
  if (e instanceof ApiError && e.key && has(e.key)) return t(e.key);
  if (e instanceof ApiError) return e.message;
  return t('err.server');
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, has } = useI18n();
  return (
    <div className="notice bad" role="alert">
      {errorText(t, has, error)} {onRetry && <button className="link" onClick={onRetry}>{t('retry')}</button>}
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return <div className="mut" aria-busy="true">{t('loading')}</div>;
}

export function TopControls({ children }: { children?: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <>
      {children}
      <button className="b" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label={t('lang.toggle')}>{t('lang.toggle')}</button>
      <button className="b" onClick={toggleTheme} title={t('theme.toggle')} aria-label={t('theme.toggle')}>◐</button>
    </>
  );
}

/** Left sidebar: brand at the top, navigation, and the signed-in person with Sign out at the bottom. */
export function Sidebar({ subtitle, user, roleLabel, onSignOut, children }: {
  subtitle: string; user: { name: string; email: string }; roleLabel?: string; onSignOut: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <nav className="side" aria-label={t('app.name')}>
      <div className="brand"><b>{t('app.name')}</b><span>{subtitle}</span></div>
      <div className="side-items">{children}</div>
      <div className="side-user">
        <div className="who">
          <b>{user.name}</b>
          <span className="ltr">{user.email}</span>
          {roleLabel && <span>{roleLabel}</span>}
        </div>
        <button className="b signout" onClick={onSignOut}>{t('signOut')}</button>
      </div>
    </nav>
  );
}
