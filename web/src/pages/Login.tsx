import { useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
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

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/login', { body: { email: e, password: p } });
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const submit = (ev: FormEvent) => { ev.preventDefault(); void signIn(email, password); };
  const groups: [string, string][] = [['admin', 'role.admin'], ['firm_staff', 'admin.staffTitle'], ['client', 'col.client']];

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
          <p className="mut small">{t('login.twoFactorLater')}</p>
        </div>
        {demo.data && cfg.data?.demoPassword && (
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
