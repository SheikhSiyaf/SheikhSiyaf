// Opened from the link in the confirmation email. Opening it only shows what it would do; the button confirms.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, TopControls, errorText } from '../ui.tsx';

export function ConfirmEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const { t, has } = useI18n();
  const info = useApi<{ purpose: 'main' | 'backup'; newEmail: string }>(`/api/email-change/${encodeURIComponent(token)}`);
  const [done, setDone] = useState<'main' | 'backup'>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true); setError(undefined);
    try { const r = await api<{ purpose: 'main' | 'backup' }>(`/api/email-change/${encodeURIComponent(token)}`, { body: {} }); setDone(r.purpose); }
    catch (err) { setError(errorText(t, has, err)); } finally { setBusy(false); }
  };
  const toSignIn = () => { navigate('/'); onDone(); };
  return (
    <main>
      <div className="login">
        <div className="actions" style={{ justifyContent: 'flex-end', marginBottom: 8 }}><TopControls /></div>
        <div className="card">
          <h1>{t('app.name')}</h1>
          <h2 style={{ fontSize: 17 }}>{t('cemail.title')}</h2>
          {info.error ? <><ErrorNote error={info.error} /><button className="b" onClick={toSignIn}>{t('invitePage.toSignIn')}</button></>
            : !info.data ? <Loading />
            : done ? (
              <>
                <div className="notice" id="cemail-done">{t(done === 'main' ? 'cemail.doneMain' : 'cemail.doneBackup', { email: info.data.newEmail })}</div>
                <button className="b p" onClick={toSignIn}>{t('invitePage.toSignIn')}</button>
              </>
            ) : (
              <>
                <p>{t(info.data.purpose === 'main' ? 'cemail.askMain' : 'cemail.askBackup', { email: info.data.newEmail })}</p>
                {error && <div className="notice bad" role="alert">{error}</div>}
                <button className="b p" id="cemail-confirm" disabled={busy} onClick={() => void confirm()}>{t('cemail.button')}</button>
              </>
            )}
        </div>
      </div>
    </main>
  );
}
