// The platform owner's Settings: the sign-in (main) email, an optional backup email, which email service is in use (never its
// key) and a test email. More settings will be added here. The main email is the account's login, so changing it goes through
// a link sent to the new address (src/api/auth.ts, db/migrations/0069).
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ChangeEmailForm } from '../pages/ChangeEmailForm.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { PaymentSettings } from './PaymentSettings.tsx';

interface Test { id: string; createdAt: string; to: string; status: 'queued' | 'sending' | 'sent' | 'failed'; attempts: number; lastError: string | null; sentAt: string | null }
interface Settings {
  email: string; backupEmail: string | null; backupVerified: boolean; twoFactor: boolean;
  pending: { purpose: 'main' | 'backup'; newEmail: string; expiresAt: string }[];
  service: { provider: string; from: string; keySet: boolean };
  tests: Test[];
}
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);

export function OwnerSettings() {
  const { t, has } = useI18n();
  const s = useApi<Settings>('/api/owner/settings');
  const [editing, setEditing] = useState<'main' | 'backup'>();
  const [msg, setMsg] = useState<string>();
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string>();
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const pendingOf = (p: 'main' | 'backup') => d.pending.find((x) => x.purpose === p);
  const sent = (email: string) => { setEditing(undefined); setMsg(t('emailset.sent', { email })); s.reload(); };
  const sendTest = async () => {
    setTestBusy(true); setTestError(undefined);
    try { await api('/api/owner/settings/test-email', { body: {} }); s.reload(); }
    catch (e) { setTestError(errorText(t, has, e)); } finally { setTestBusy(false); }
  };
  const provider = d.service.provider === 'none' ? t('oset.service.none') : d.service.provider;

  return (
    <>
      {msg && <div className="notice" id="oset-msg">{msg}</div>}

      <PaymentSettings />

      <div className="card" id="oset-service">
        <h2>{t('oset.service.title')}</h2>
        <table className="stack"><tbody>
          <tr><th>{t('oset.service.provider')}</th><td>{provider}</td></tr>
          <tr><th>{t('oset.service.from')}</th><td className="ltr">{d.service.from}</td></tr>
          <tr><th>{t('oset.service.key')}</th><td><span className={`badge ${d.service.keySet ? 'good' : 'bad'}`}>{t(d.service.keySet ? 'oset.service.keySet' : 'oset.service.keyMissing')}</span></td></tr>
        </tbody></table>
      </div>

      <div className="card" id="oset-main">
        <h2>{t('oset.main.title')}</h2>
        <div className="small mut" style={{ marginBottom: 6 }}>{t('oset.main.hint')}</div>
        <div><b className="ltr" id="oset-main-email">{d.email}</b></div>
        {pendingOf('main') && <div className="small mut">{t('oset.pending', { email: pendingOf('main')!.newEmail, time: when(pendingOf('main')!.expiresAt) })}</div>}
        {editing === 'main'
          ? <ChangeEmailForm purpose="main" twoFactor={d.twoFactor} idPrefix="oset-main" onSent={sent} onCancel={() => setEditing(undefined)} />
          : <div className="actions" style={{ marginTop: 8 }}><button className="b" id="oset-main-change" onClick={() => { setMsg(undefined); setEditing('main'); }}>{t('oset.change')}</button></div>}
      </div>

      <div className="card" id="oset-backup">
        <h2>{t('oset.backup.title')}</h2>
        <div className="small mut" style={{ marginBottom: 6 }}>{t('oset.backup.hint')}</div>
        {d.backupEmail
          ? <div><b className="ltr" id="oset-backup-email">{d.backupEmail}</b> <span className={`badge ${d.backupVerified ? 'good' : ''}`}>{t(d.backupVerified ? 'oset.backup.confirmed' : 'oset.backup.unconfirmed')}</span></div>
          : <div className="mut" id="oset-backup-none">{t('oset.backup.none')}</div>}
        {pendingOf('backup') && <div className="small mut">{t('oset.pending', { email: pendingOf('backup')!.newEmail, time: when(pendingOf('backup')!.expiresAt) })}</div>}
        {editing === 'backup'
          ? <ChangeEmailForm purpose="backup" twoFactor={d.twoFactor} idPrefix="oset-backup" onSent={sent} onCancel={() => setEditing(undefined)} />
          : <div className="actions" style={{ marginTop: 8 }}><button className="b" id="oset-backup-change" onClick={() => { setMsg(undefined); setEditing('backup'); }}>{t(d.backupEmail ? 'oset.change' : 'oset.add')}</button></div>}
      </div>

      <div className="card" id="oset-test">
        <h2>{t('oset.test.title')}</h2>
        <div className="small mut" style={{ marginBottom: 6 }}>{t('oset.test.hint')}</div>
        {testError && <div className="notice bad" role="alert" id="oset-test-error">{testError}</div>}
        <div className="actions"><button className="b p" id="oset-test-send" disabled={testBusy} onClick={() => void sendTest()}>{t('oset.test.send')}</button>{testBusy && <Loading />}</div>
        {d.tests.length === 0 ? <div className="small mut" style={{ marginTop: 8 }}>{t('oset.test.none')}</div> : (
          <div className="wrap" style={{ marginTop: 8 }}><table id="oset-test-list">
            <thead><tr><th>{t('oset.test.when')}</th><th>{t('oset.test.to')}</th><th>{t('oset.test.status')}</th></tr></thead>
            <tbody>{d.tests.map((x) => (
              <tr key={x.id}>
                <td className="ltr">{when(x.createdAt)}</td><td className="ltr">{x.to}</td>
                <td><span className={`badge ${x.status === 'sent' ? 'good' : x.status === 'failed' ? 'bad' : ''}`}>{t(`oset.test.st.${x.status}` as Key)}</span>
                  {x.lastError && <div className="small bad">{x.lastError}</div>}</td>
              </tr>))}</tbody>
          </table></div>)}
        <div className="small mut" style={{ marginTop: 8 }}>{t('oset.test.sentNote')}</div>
      </div>
    </>
  );
}
