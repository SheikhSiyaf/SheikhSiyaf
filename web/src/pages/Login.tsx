import { useState, type FormEvent } from 'react';
import { ApiError, api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote } from '../ui.tsx';
import { toggleTheme } from '../theme.ts';

interface DemoUser { name: string; email: string; kind: string; role: string; company?: string }

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, lang, setLang } = useI18n();
  const cfg = useApi<{ demoLogins: boolean; demoPassword?: string }>('/api/config');
  const demo = useApi<DemoUser[]>(cfg.data?.demoLogins ? '/api/demo-users' : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
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
    <main>
      <div className="login">
        <div className="actions" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
          <button className="b" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>{t('lang.toggle')}</button>
          <button className="b" onClick={toggleTheme} aria-label={t('theme.toggle')}>◐</button>
        </div>
        <div className="card">
          <h1>{t('app.name')}</h1>
          <p className="mut" style={{ marginTop: 0 }}>{t('login.subtitle')}</p>
          {error !== undefined && <ErrorNote error={error} />}
          {ticket ? (
            <form onSubmit={verify}>
              <h2 style={{ fontSize: 17, margin: '6px 0' }}>{t('login.codeTitle')}</h2>
              <p className="mut small">{t('login.codeHint')}</p>
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
                  <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
                </label>
              </div>
              <button className="b p" type="submit" disabled={busy || !email || !password}>{t('login.submit')}</button>
            </form>
          )}
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
                    {u.name} <span className="mut">· {t(`role.${u.role}` as 'role.admin')}{u.company ? ` · ${u.company}` : ''}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
