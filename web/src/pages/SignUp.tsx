// Self-service sign-up and its e-mail confirmation. Two ways in: Google (coming soon) and e-mail with a password.
// Nothing is created until the person opens the e-mailed link (src/books/signupService.ts).
import { useState, type FormEvent } from 'react';
import { ApiError, api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, PasswordInput } from '../ui.tsx';
import { AuthShell, StrengthMeter } from './AuthShell.tsx';

const SITE = 'https://nusuhbooks.com';

const Shell = ({ children }: { children: React.ReactNode }) => <AuthShell variant="signup" wide>{children}</AuthShell>;

export function SignUp() {
  const { t, lang } = useI18n();
  const cfg = useApi<{ enabled: boolean; google: boolean }>('/api/signup/config');
  const [f, setF] = useState({ fullName: '', email: '', password: '', companyName: '', country: 'SA', crNumber: '', city: '', acceptTerms: false, website: '' });
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const set = (k: keyof typeof f, v: string | boolean) => { setError(undefined); setF({ ...f, [k]: v }); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await api('/api/signup', { body: { ...f, lang } }); setSent(f.email); }
    catch (err) { setError(err); } finally { setBusy(false); }
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
  return (
    <Shell>
      <div className="card auth-card" id="signup">
        <h1>{t('signup.title')}</h1>
        <p className="auth-lead">{t('signup.sub')}</p>
        <button className="b google" id="signup-google" type="button" disabled title={t('signup.googleSoon')} aria-describedby="google-soon">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.3-3.9 7.1-9.7 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 010-9.4l-7.9-6.1a24 24 0 000 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
          <span>{t('signup.google')}</span>
        </button>
        <p className="small mut auth-soon" id="google-soon">{t('signup.googleSoon')}</p>
        <div className="or"><span>{t('signup.or')}</span></div>
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
