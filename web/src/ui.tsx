// Shared bits: top bar controls, error and loading states.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, useApi } from './api.ts';
import { useI18n } from './i18n.tsx';
import { toggleTheme } from './theme.ts';
import { DEMO, navigate } from './router.ts';

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
  subtitle: string; user: { name: string; email: string; twoFactor?: boolean }; roleLabel?: string; onSignOut: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The small menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <nav className="side" aria-label={t('app.name')}>
      <div className="brand"><b>{t('app.name')}</b><span>{subtitle}</span></div>
      <div className="side-items">{children}</div>
      {/* The signed-in person, pinned to the bottom: one compact row; details and two-factor in a small menu above it. */}
      <div className="side-user" ref={box}>
        {open && (
          <div className="side-menu" role="menu">
            <span className="ltr small mut">{user.email}</span>
            <button className="link small security-link" role="menuitem" onClick={() => { setOpen(false); navigate('/security'); }}>
              {t('security.title')}: {user.twoFactor ? t('security.on') : t('security.off')}
            </button>
          </div>
        )}
        <div className="side-me">
          <button className="me" aria-expanded={open} aria-haspopup="menu" title={user.email} onClick={() => setOpen(!open)}>
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="who"><b>{user.name}</b>{roleLabel && <span>{roleLabel}</span>}</span>
          </button>
          <button className="signout" aria-label={t('signOut')} title={t('signOut')} onClick={onSignOut}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </nav>
  );
}

/** In-page confirmation (published pages and good UX both avoid browser pop-ups). */
export function ConfirmBar({ message, onYes, onNo, busy }: { message: string; onYes: () => void; onNo: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="notice warn actions" role="group">
      <span style={{ flex: '1 1 220px' }}>{message}</span>
      <button className="b p" disabled={busy} onClick={onYes}>{t('admin.confirm')}</button>
      <button className="b" onClick={onNo}>{t('cancel')}</button>
    </div>
  );
}

export interface Invite { userId: string; name: string; email: string; token: string }

/** Shows a new sign-in link once, with Copy. (Sending it by email comes later.) */
export function InviteBox({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const { t } = useI18n();
  const cfg = useApi<{ publicUrl?: string }>('/api/config');
  const [copied, setCopied] = useState<'yes' | 'no' | ''>('');
  const base = (cfg.data?.publicUrl || window.location.origin).replace(/\/$/, '');
  const link = `${base}/invite/${invite.token}`;
  const copy = () => {
    navigator.clipboard?.writeText(link).then(() => setCopied('yes'), () => setCopied('no'));
    if (!navigator.clipboard) setCopied('no');
  };
  return (
    <div className="notice invite" role="status">
      <b>{t('invite.title', { name: invite.name })}</b>
      <div className="small" style={{ margin: '4px 0 8px' }}>{t('invite.howTo', { email: invite.email })} {t('admin.inviteEmailed')}</div>
      <input readOnly value={link} className="ltr" style={{ width: '100%' }} onFocus={(e) => e.target.select()} aria-label={t('invite.copy')} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="b p" onClick={copy}>{t('invite.copy')}</button>
        {DEMO && (
          // In the demo the link opens here, as if on the new person's phone: sign the Administrator out first.
          <button className="b" onClick={() => void api('/api/logout', { body: {} }).then(() => navigate(`/invite/${invite.token}`))}>{t('invite.open')}</button>
        )}
        <button className="b" onClick={onClose}>{t('invite.close')}</button>
        {copied === 'yes' && <span className="small">{t('invite.copied')}</span>}
        {copied === 'no' && <span className="small">{t('invite.copyFailed')}</span>}
      </div>
    </div>
  );
}
