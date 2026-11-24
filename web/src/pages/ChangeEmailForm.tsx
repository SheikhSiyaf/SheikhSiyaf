// Asks to change a sign-in email (or the owner's backup email). Nothing changes here: a link goes to the NEW address and the
// change happens when it is opened. The person proves who they are with their password (and authenticator code when it is on).
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { PasswordInput, errorText } from '../ui.tsx';

export function ChangeEmailForm({ purpose, twoFactor, idPrefix, onSent, onCancel }:
  { purpose: 'main' | 'backup'; twoFactor: boolean; idPrefix: string; onSent: (email: string) => void; onCancel: () => void }) {
  const { t, has } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ sentTo: string }>('/api/me/email-change', { body: { purpose, newEmail: email.trim(), password, code: twoFactor ? code.trim() : undefined } });
      setPassword(''); setCode('');
      onSent(r.sentTo);
    } catch (err) { setError(errorText(t, has, err)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate className="inset" style={{ marginTop: 8 }}>
      {error && <div className="notice bad" role="alert" id={`${idPrefix}-error`}>{error}</div>}
      <div className="row">
        <label className="f">{t('emailset.newEmail')}<input id={`${idPrefix}-email`} type="email" dir="ltr" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="f">{t('emailset.password')}<PasswordInput id={`${idPrefix}-password`} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {twoFactor && <label className="f">{t('emailset.code')}<input id={`${idPrefix}-code`} inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      </div>
      <div className="actions">
        <button className="b p" id={`${idPrefix}-send`} disabled={busy || !email.trim() || !password || (twoFactor && !code.trim())}>{t('emailset.send')}</button>
        <button type="button" className="b" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
      </div>
      <div className="small mut">{t(purpose === 'main' ? 'emailset.mainHowTo' : 'emailset.backupHowTo')}</div>
    </form>
  );
}
