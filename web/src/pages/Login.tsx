import { useState, type FormEvent } from 'react';
import { ApiError, api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, PasswordInput } from '../ui.tsx';
import { AuthShell } from './AuthShell.tsx';
import { GoogleButton, pendingGoogle } from './GoogleButton.tsx';

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
  const { t } = useI18n();
  const cfg = useApi<{ demoLogins: boolean; demoPassword?: string; googleClientId?: string }>('/api/config');
  const demo = useApi<DemoUser[]>(cfg.data?.demoLogins ? '/api/demo-users' : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
  const [forgot, setForgot] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [ticket, setTicket] = useState<string | undefined>(() => { const p = pendingGoogle.current; if (p && 'twoFactor' in p) { pendingGoogle.current = undefined; return p.ticket; } return undefined; });
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
  /** Google's answer: signed in, or the code step of someone with two-step sign-in, or a new person (their company details are asked for on the sign-up page). */
  const google = async (credential: string, nonce: string) => {
    setError(undefined);
    try {
      const r = await api<{ ok?: boolean; twoFactor?: boolean; needsCompany?: boolean; ticket?: string; email?: string; name?: string }>('/api/login/google', { body: { credential, nonce } });
      if (r.needsCompany && r.ticket) { pendingGoogle.current = { needsCompany: true, ticket: r.ticket, email: r.email ?? '', name: r.name ?? '' }; navigate('/signup'); }
      else if (r.twoFactor && r.ticket) { setTicket(r.ticket); setCode(''); }
      else onSignedIn();
    } catch (err) { setError(err); }
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
    <AuthShell variant="login">
      <div className="card auth-card">
        <h1>{ticket ? t('login.codeTitle') : t('login.welcome')}</h1>
        <p className="auth-lead">{ticket ? t('login.codeHint') : t('login.subtitle')}</p>
        {error !== undefined && <ErrorNote error={error} />}
        {ticket ? (
          <form onSubmit={verify}>
            <label className="f">{t('login.code')}
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} dir="ltr" style={{ letterSpacing: 6, fontSize: 22, textAlign: 'center' }} />
            </label>
            <button className="b p" type="submit" disabled={busy || code.length !== 6}>{t('login.verify')}</button>
            <p className="auth-links"><button className="link" type="button" onClick={() => { setTicket(undefined); setError(undefined); }}>{t('login.back')}</button></p>
          </form>
        ) : (<>
          {cfg.data?.googleClientId && <>
            <GoogleButton clientId={cfg.data.googleClientId} text="signin_with" onCredential={google} />
            <div className="or"><span>{t('signup.or')}</span></div>
          </>}
          <form onSubmit={submit}>
            <label className="f">{t('login.email')}
              <input type="email" id="login-email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" placeholder="name@company.com" />
            </label>
            <label className="f">{t('login.password')}
              <PasswordInput id="login-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="b p" type="submit" id="login-submit" disabled={busy || !email || !password}>{t('login.submit')}</button>
            <p className="auth-links"><button className="link small" type="button" id="forgot-open" onClick={() => setForgot(forgot === undefined ? email : undefined)}>{t('login.forgot')}</button></p>
          </form>
        </>)}
        {forgot !== undefined && !ticket && <ForgotPassword initial={forgot} />}
        {!ticket && <p className="small auth-foot auth-switch">{t('login.newHere')} <button className="link" id="login-signup" onClick={() => navigate('/signup')}>{t('login.startTrial')}</button></p>}
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
    </AuthShell>
  );
}
