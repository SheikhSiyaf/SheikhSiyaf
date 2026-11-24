// A signed-in person's own sign-in email (everyone except the platform owner, who has Settings). It shows the address and lets
// them change it: a link goes to the new address and nothing changes until it is opened. There is no backup email and no
// test email here, so nobody uses up the email allowance (db/migrations/0069, src/api/auth.ts).
import { useState } from 'react';
import { useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote, Loading } from '../ui.tsx';
import { ChangeEmailForm } from './ChangeEmailForm.tsx';

interface EmailSettings { email: string; twoFactor: boolean; pending: { purpose: 'main' | 'backup'; newEmail: string; expiresAt: string }[] }

export function MyEmail() {
  const { t } = useI18n();
  const s = useApi<EmailSettings>('/api/me/email-settings');
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string>();
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const pending = s.data.pending.find((p) => p.purpose === 'main');
  return (
    <div className="card" id="my-email" style={{ maxWidth: 620, marginBottom: 12 }}>
      <h2>{t('myemail.title')}</h2>
      <div className="small mut" style={{ marginBottom: 6 }}>{t('myemail.hint')}</div>
      {msg && <div className="notice" id="my-email-msg">{msg}</div>}
      <div><b className="ltr" id="my-email-address">{s.data.email}</b></div>
      {pending && <div className="small mut">{t('oset.pending', { email: pending.newEmail, time: pending.expiresAt.replace('T', ' ').slice(0, 16) })}</div>}
      {editing
        ? <ChangeEmailForm purpose="main" twoFactor={s.data.twoFactor} idPrefix="my-email" onSent={(e) => { setEditing(false); setMsg(t('emailset.sent', { email: e })); s.reload(); }} onCancel={() => setEditing(false)} />
        : <div className="actions" style={{ marginTop: 8 }}><button className="b" id="my-email-change" onClick={() => { setMsg(undefined); setEditing(true); }}>{t('oset.change')}</button></div>}
    </div>
  );
}
