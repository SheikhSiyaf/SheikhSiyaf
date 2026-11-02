// Opened from a sign-in link: the person sets their own password.
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, TopControls } from '../ui.tsx';

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useI18n();
  const info = useApi<{ name: string; email: string }>(`/api/invite/${encodeURIComponent(token)}`);
  const cfg = useApi<{ minPassword: number }>('/api/config');
  const min = cfg.data?.minPassword ?? 10;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const problem = pw.length < min ? t('invitePage.min', { n: min }) : pw !== pw2 ? t('invitePage.mismatch') : '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/invite/${encodeURIComponent(token)}`, { body: { password: pw } });
      setDone(true);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const toSignIn = () => { navigate('/'); onDone(); };

  return (
    <main>
      <div className="login">
        <div className="actions" style={{ justifyContent: 'flex-end', marginBottom: 8 }}><TopControls /></div>
        <div className="card">
          <h1>{t('app.name')}</h1>
          <h2 style={{ fontSize: 17 }}>{t('invitePage.title')}</h2>
          {info.error ? <><ErrorNote error={info.error} /><button className="b" onClick={toSignIn}>{t('invitePage.toSignIn')}</button></>
            : !info.data ? <Loading />
            : done ? (
              <>
                <div className="notice">{t('invitePage.done')}</div>
                <button className="b p" onClick={toSignIn}>{t('invitePage.toSignIn')}</button>
              </>
            ) : (
              <form onSubmit={submit}>
                <p className="mut">{t('invitePage.welcome', { name: info.data.name, email: info.data.email })}</p>
                {error !== undefined && <ErrorNote error={error} />}
                <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
                <div className="row">
                  <label className="f">{t('invitePage.password')}
                    <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} dir="ltr" />
                  </label>
                </div>
                <div className="row">
                  <label className="f">{t('invitePage.confirm')}
                    <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} dir="ltr" />
                  </label>
                </div>
                {pw && problem && <p className="small bad">{problem}</p>}
                {!pw && <p className="small mut">{t('invitePage.min', { n: min })}</p>}
                <button className="b p" type="submit" disabled={busy || Boolean(problem)}>{t('invitePage.submit')}</button>
              </form>
            )}
        </div>
      </div>
    </main>
  );
}
