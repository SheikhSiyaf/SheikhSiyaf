// Self-service sign-up. Two ways in: Google (when switched on), and e-mail with a password.
// The e-mail way creates nothing until the person opens the e-mailed link; the Google way has Google's word for the e-mail, so it asks only for the company (src/books/signupService.ts).
import { getIntentToken } from '../orderIntent.ts';
import { useState, type FormEvent } from 'react';
import { ApiError, api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, PasswordInput } from '../ui.tsx';
import { AuthShell, StrengthMeter } from './AuthShell.tsx';
import { GoogleButton, pendingGoogle } from './GoogleButton.tsx';

const SITE = 'https://nusuhbooks.com';

const Shell = ({ children }: { children: React.ReactNode }) => <AuthShell variant="signup" wide>{children}</AuthShell>;

export function SignUp({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, lang } = useI18n();
  const cfg = useApi<{ enabled: boolean; google: boolean; googleClientId?: string }>('/api/signup/config');
  const [f, setF] = useState({ fullName: '', email: '', password: '', companyName: '', country: 'SA', crNumber: '', city: '', acceptTerms: false, website: '' });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const [g, setG] = useState(() => { const p = pendingGoogle.current; if (p && 'needsCompany' in p) { pendingGoogle.current = undefined; return p; } return undefined; });
  const set = (k: keyof typeof f, v: string | boolean) => { setError(undefined); setF({ ...f, [k]: v }); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await api('/api/signup', { body: { ...f, lang, intent: getIntentToken() ?? undefined } }); setSent(f.email); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };

  /** Google's answer: signed in (the page changes), or the company step for a new person, or the code step of an existing one (the sign-in page). */
  const google = async (credential: string, nonce: string) => {
    setError(undefined);
    try {
      const r = await api<{ ok?: boolean; twoFactor?: boolean; needsCompany?: boolean; ticket?: string; email?: string; name?: string }>('/api/login/google', { body: { credential, nonce } });
      if (r.needsCompany && r.ticket) { setG({ needsCompany: true, ticket: r.ticket, email: r.email ?? '', name: r.name ?? '' }); setF((x) => ({ ...x, fullName: x.fullName || r.name || '' })); }
      else if (r.twoFactor && r.ticket) { pendingGoogle.current = { twoFactor: true, ticket: r.ticket }; navigate('/'); }
      else onSignedIn();
    } catch (err) { setError(err); }
  };
  const finishGoogle = async (e: FormEvent) => {
    e.preventDefault();
    if (!g || !('needsCompany' in g)) return;
    setBusy(true); setError(undefined);
    try { await api('/api/signup/google', { body: { ticket: g.ticket, fullName: f.fullName, companyName: f.companyName, country: f.country, crNumber: f.crNumber, city: f.city, acceptTerms: f.acceptTerms, website: f.website, lang } }); onSignedIn(); }
    catch (err) { setError(err); setBusy(false); if (err instanceof ApiError && err.key === 'err.googleExpired') setG(undefined); }
  };

  if (cfg.data && !cfg.data.enabled) {
    return (
      <Shell><div className="card auth-card" id="signup-closed">
        <h1>{t('signup.closedTitle')}</h1>
        <p>{t('signup.closedBody')}</p>
        <p className="small"><a href={`${SITE}/contact/`}>{SITE}/contact/</a></p>
        <div className="actions"><button className="b" id="signup-to-login" onClick={() => navigate('/')}>{t('signup.signIn')}</button></div>
      </div></Shell>
    );
  }
  if (sent) {
    return (
      <Shell><div className="card auth-card" id="signup-sent">
        <h1>{t('signup.sentTitle')}</h1>
        <p>{t('signup.sentBody', { email: sent })}</p>
        <p className="small mut">{t('signup.sentHint')}</p>
      </div></Shell>
    );
  }
  const problem = error instanceof ApiError ? error.key : undefined;
  if (g && 'needsCompany' in g) {
    return (
      <Shell>
        <div className="card auth-card" id="google-company">
          <h1>{t('google.company.title')}</h1>
          <p className="auth-lead">{t('google.company.lead', { email: g.email })}</p>
          {error !== undefined && <ErrorNote error={error} />}
          <form onSubmit={finishGoogle} noValidate>
            <label className="f">{t('signup.fullName')}<input id="gc-name" autoComplete="name" required maxLength={120} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} aria-invalid={problem === 'err.signupName'} /></label>
            <label className="f">{t('signup.company')}<input id="gc-company" autoComplete="organization" required maxLength={160} value={f.companyName} onChange={(e) => set('companyName', e.target.value)} aria-invalid={problem === 'err.signupCompany'} /></label>
            <div className="auth-grid2">
              <label className="f">{t('signup.country')}
                <select id="gc-country" value={f.country} onChange={(e) => set('country', e.target.value)}>{(['SA', 'AE'] as const).map((c) => <option key={c} value={c}>{t(`signup.country.${c}` as Key)}</option>)}</select></label>
              <label className="f">{t('signup.city')}<input id="gc-city" autoComplete="address-level2" required maxLength={60} value={f.city} onChange={(e) => set('city', e.target.value)} aria-invalid={problem === 'err.signupCity'} /></label>
            </div>
            <label className="f">{t(`signup.cr.${f.country}` as Key)}<input id="gc-cr" inputMode={f.country === 'SA' ? 'numeric' : 'text'} dir="ltr" required maxLength={30} value={f.crNumber} onChange={(e) => set('crNumber', e.target.value)} aria-invalid={problem === 'err.signupCr'} /></label>
            <p className="hint">{t('signup.crHint')}</p>
            <div className="hp" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} /></label></div>
            <label className="check-one small auth-terms">
              <input id="gc-terms" type="checkbox" checked={f.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />
              <span>{t('signup.terms')} <a href={`${SITE}/legal/terms/`} target="_blank" rel="noopener noreferrer">{t('signup.termsLink')}</a> · <a href={`${SITE}/legal/privacy/`} target="_blank" rel="noopener noreferrer">{t('signup.privacyLink')}</a></span>
            </label>
            <button className="b p" id="gc-submit" type="submit" disabled={busy || !f.fullName || !f.companyName || !f.crNumber || !f.city || !f.acceptTerms}>{t('google.company.submit')}</button>
          </form>
          <p className="small auth-foot auth-switch"><button className="link" id="gc-other" onClick={() => { setG(undefined); setError(undefined); }}>{t('google.company.other')}</button></p>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="card auth-card" id="signup">
        <h1>{(() => { try { return window.sessionStorage.getItem('nb_order_mode') === 'pay' ? t('signup.titlePay') : t('signup.title'); } catch { return t('signup.title'); } })()}</h1>
        <p className="auth-lead">{t('signup.sub')}</p>
        {cfg.data?.google && cfg.data.googleClientId && <>
          <GoogleButton clientId={cfg.data.googleClientId} text="signup_with" onCredential={google} />
          <div className="or"><span>{t('signup.or')}</span></div>
        </>}
        {error !== undefined && <ErrorNote error={error} />}
        <form onSubmit={submit} noValidate>
          <h2 className="auth-sec"><span className="sn">1</span>{t('signup.sec.you')}</h2>
          <label className="f">{t('signup.fullName')}<input id="su-name" autoComplete="name" required maxLength={120} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} aria-invalid={problem === 'err.signupName'} /></label>
          <label className="f">{t('signup.email')}<input id="su-email" type="email" autoComplete="email" dir="ltr" required maxLength={254} value={f.email} onChange={(e) => set('email', e.target.value)} aria-invalid={problem === 'err.signupEmail' || problem === 'err.signupDisposable'} placeholder="name@company.com" /></label>
          <label className="f">{t('signup.password')}<PasswordInput id="su-password" autoComplete="new-password" required maxLength={200} value={f.password} onChange={(e) => set('password', e.target.value)} /></label>
          <StrengthMeter value={f.password} />
          <p className="hint">{t('signup.passwordHint')}</p>
          <h2 className="auth-sec"><span className="sn">2</span>{t('signup.sec.company')}</h2>
          <label className="f">{t('signup.company')}<input id="su-company" autoComplete="organization" required maxLength={160} value={f.companyName} onChange={(e) => set('companyName', e.target.value)} aria-invalid={problem === 'err.signupCompany'} /></label>
          <div className="auth-grid2">
            <label className="f">{t('signup.country')}
              <select id="su-country" value={f.country} onChange={(e) => set('country', e.target.value)}>{(['SA', 'AE'] as const).map((c) => <option key={c} value={c}>{t(`signup.country.${c}` as Key)}</option>)}</select></label>
            <label className="f">{t('signup.city')}<input id="su-city" autoComplete="address-level2" required maxLength={60} value={f.city} onChange={(e) => set('city', e.target.value)} aria-invalid={problem === 'err.signupCity'} /></label>
          </div>
          <label className="f">{t(`signup.cr.${f.country}` as Key)}<input id="su-cr" inputMode={f.country === 'SA' ? 'numeric' : 'text'} dir="ltr" required maxLength={30} value={f.crNumber} onChange={(e) => set('crNumber', e.target.value)} aria-invalid={problem === 'err.signupCr'} /></label>
          <p className="hint">{t('signup.crHint')}</p>
          {/* a field only robots fill in: hidden from people and from screen readers */}
          <div className="hp" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} /></label></div>
          <label className="check-one small auth-terms">
            <input id="su-terms" type="checkbox" checked={f.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />
            <span>{t('signup.terms')} <a href={`${SITE}/legal/terms/`} target="_blank" rel="noopener noreferrer">{t('signup.termsLink')}</a> · <a href={`${SITE}/legal/privacy/`} target="_blank" rel="noopener noreferrer">{t('signup.privacyLink')}</a></span>
          </label>
          <button className="b p" id="su-submit" type="submit" disabled={busy || !f.fullName || !f.email || !f.password || !f.companyName || !f.crNumber || !f.city || !f.acceptTerms}>{t('signup.submit')}</button>
        </form>
        <p className="small auth-foot auth-switch">{t('signup.haveAccount')} <button className="link" id="su-login" onClick={() => navigate('/')}>{t('signup.signIn')}</button></p>
      </div>
    </Shell>
  );
}

/** The link in the e-mail: one button, so a mail scanner that only opens links cannot use the link up. */
export function VerifySignUp({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const go = async () => {
    setBusy(true); setError(undefined);
    try { await api('/api/signup/verify', { body: { token } }); navigate('/'); onDone(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Shell><div className="card auth-card" id="verify">
      <h1>{t('verify.title')}</h1>
      <p>{t('verify.body')}</p>
      {error !== undefined && <><ErrorNote error={error} /><div className="actions"><button className="b" id="verify-again" onClick={() => navigate('/signup')}>{t('verify.startAgain')}</button></div></>}
      {error === undefined && <div className="actions"><button className="b p big" id="verify-go" disabled={busy} onClick={() => void go()}>{busy ? t('verify.busy') : t('verify.button')}</button></div>}
    </div></Shell>
  );
}
