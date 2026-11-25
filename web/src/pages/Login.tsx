import { useState, type FormEvent } from 'react';
import { ApiError, api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, PasswordInput } from '../ui.tsx';
import { toggleTheme } from '../theme.ts';
import { NusuhMark } from '../brand.tsx';

/** The side panel's four points: a key (login.<key>.t and .d) and an icon path. */
const FEATURES: [string, string][] = [
  ['f1', 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6'],
  ['f2', 'M4 5h16M12 3v2M7 9c1 3 3 6 6 8M5 17c4-1 7-4 8-8M13 19l4-9 4 9M14.5 16h5'],
  ['f3', 'M3 21V8l7-4v17M10 21h11V11l-5-3M7 11v.01M7 15v.01M14 15v.01M17 15v.01'],
  ['f4', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'],
];

interface DemoUser { name: string; email: string; kind: string; role: string; company?: string; clientRole?: string }

/** Forgotten password: a one-hour link by email. The answer is the same whether or not the address has an account. */
function ForgotPassword({ initial }: { initial: string }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(initial);
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'bad'>('idle');
  return (
    <form className="card inset" id="forgot" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); setState('busy');
      void api('/api/password-reset', { body: { email } }).then(() => setState('sent'), () => setState('bad')); }}>
      <p className="small" style={{ marginTop: 0 }}>{t('login.forgotHint')}</p>
      <div className="actions">
        <input type="email" dir="ltr" required value={email} aria-label={t('login.email')} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
        <button className="b" id="forgot-send" disabled={state === 'busy' || !email}>{t('login.forgotSend')}</button>
      </div>
      {state === 'sent' && <p className="small good" role="status">{t('login.forgotSent')}</p>}
      {state === 'bad' && <p className="small bad" role="alert">{t('login.forgotBad')}</p>}
    </form>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, lang, setLang } = useI18n();
  const cfg = useApi<{ demoLogins: boolean; demoPassword?: string }>('/api/config');
  const demo = useApi<DemoUser[]>(cfg.data?.demoLogins ? '/api/demo-users' : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
  const [forgot, setForgot] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [ticket, setTicket] = useState<string>();
  const [code, setCode] = useState('');

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ ok?: boolean; twoFactor?: boolean; ticket?: string }>('/api/login', { body: { email: e, password: p } });
      if (r.twoFactor && r.ticket) { setTicket(r.ticket); setCode(''); }
      else onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/login/two-factor', { body: { ticket, code } });
      onSignedIn();
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.key === 'err.ticket') setTicket(undefined);
    } finally {
      setBusy(false);
    }
  };
  const submit = (ev: FormEvent) => { ev.preventDefault(); void signIn(email, password); };
  const groups: [string, string][] = [['owner', 'own.role'], ['admin', 'role.admin'], ['firm_staff', 'admin.staffTitle'], ['client', 'col.client']];

  return (
    <main className="auth">
      <section className="auth-form">
        <header className="auth-top">
          <span className="auth-brand"><NusuhMark size={34} /><b>{t('app.name')}</b></span>
          <span className="actions">
            <button className="b" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>{t('lang.toggle')}</button>
            <button className="b" onClick={toggleTheme} aria-label={t('theme.toggle')}>◐</button>
          </span>
        </header>
        <div className="login">
          <div className="card auth-card">
            <h1>{ticket ? t('login.codeTitle') : t('login.welcome')}</h1>
            <p className="mut" style={{ marginTop: 0 }}>{ticket ? t('login.codeHint') : t('login.subtitle')}</p>
            {error !== undefined && <ErrorNote error={error} />}
            {ticket ? (
              <form onSubmit={verify}>
                <div className="row">
                  <label className="f">{t('login.code')}
                    <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} dir="ltr" style={{ letterSpacing: 4, fontSize: 20 }} />
                  </label>
                </div>
                <div className="actions">
                  <button className="b p" type="submit" disabled={busy || code.length !== 6}>{t('login.verify')}</button>
                  <button className="link" type="button" onClick={() => { setTicket(undefined); setError(undefined); }}>{t('login.back')}</button>
                </div>
              </form>
            ) : (
              <form onSubmit={submit}>
                <div className="row">
                  <label className="f">{t('login.email')}
                    <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
                  </label>
                </div>
                <div className="row">
                  <label className="f">{t('login.password')}
                    <PasswordInput id="login-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </div>
                <div className="actions auth-actions">
                  <button className="b p" type="submit" disabled={busy || !email || !password}>{t('login.submit')}</button>
                  <button className="link small" type="button" id="forgot-open" onClick={() => setForgot(forgot === undefined ? email : undefined)}>{t('login.forgot')}</button>
                </div>
              </form>
            )}
            {forgot !== undefined && !ticket && <ForgotPassword initial={forgot} />}
            {!ticket && <p className="small auth-foot" style={{ marginTop: 14 }}>{t('login.newHere')} <button className="link" id="login-signup" onClick={() => navigate('/signup')}>{t('login.startTrial')}</button></p>}
          </div>
          {!ticket && demo.data && cfg.data?.demoPassword && (
            <div className="card demo">
              <h2>{t('login.demo')}</h2>
              <div className="mut small">{t('login.demoHint', { password: cfg.data.demoPassword })}</div>
              {groups.map(([kind, label]) => (
                <div key={kind} style={{ marginTop: 10 }}>
                  <b className="small">{t(label as 'role.admin')}</b>
                  {demo.data!.filter((u) => u.kind === kind).map((u) => (
                    <button key={u.email} className="b" disabled={busy} onClick={() => void signIn(u.email, cfg.data!.demoPassword!)}>
                      {u.name} <span className="mut">· {u.clientRole ?? t(`role.${u.role}` as 'role.admin')}{u.company ? ` · ${u.company}` : ''}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <footer className="auth-foot small mut">{t('login.foot', { year: String(new Date().getFullYear()) })}</footer>
      </section>

      <aside className="auth-aside" aria-label={t('login.panelTitle')}>
        <div className="aside-inner">
          <h2>{t('login.panelTitle')}</h2>
          <p className="aside-sub">{t('login.panelSub')}</p>
          <ul className="aside-features">
            {FEATURES.map(([key, d]) => (
              <li key={key}>
                <span className="fi" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg></span>
                <span><b>{t(`login.${key}.t` as 'login.f1.t')}</b><small>{t(`login.${key}.d` as 'login.f1.d')}</small></span>
              </li>
            ))}
          </ul>
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
