// The signed-in person's own two-factor sign-in set-up.
import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, type Me } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { DEMO } from '../router.ts';
import { ErrorNote, Sidebar, TopControls } from '../ui.tsx';

export function Security({ me, onSignOut, onChanged, onBack }: { me: Me; onSignOut: () => void; onChanged: () => void; onBack: () => void }) {
  const { t } = useI18n();
  const [setup, setSetup] = useState<{ secret: string; uri: string; ticket: string }>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.uri, { margin: 1, width: 180 }).then(setQr, () => setQr(undefined));
  }, [setup]);

  const start = async () => {
    setBusy(true); setError(undefined);
    try { setSetup(await api('/api/me/two-factor/start', { body: {} })); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/api/me/two-factor/confirm', { body: { ticket: setup!.ticket, code } });
      setDone(true); setSetup(undefined); onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const roleLabel = me.user.kind === 'admin' ? t('role.admin') : me.user.staffRole ? t(`role.${me.user.staffRole}`) : me.companies[0] ? t(`role.${me.companies[0].role}`) : undefined;
  return (
    <div className="app">
      <Sidebar subtitle={me.user.firmName} user={me.user} roleLabel={roleLabel} onSignOut={onSignOut}>
        <button onClick={onBack}>{t('security.back')}</button>
      </Sidebar>
      <main>
        <div className="top"><h1>{t('security.title')}</h1><TopControls /></div>
        <div className="card" style={{ maxWidth: 620 }}>
          {error !== undefined && <ErrorNote error={error} />}
          {done && <div className="notice">{t('security.done')}</div>}
          {me.user.twoFactor ? <p>{t('security.isOn')}</p> : DEMO ? <p className="mut">{t('security.demo')}</p> : !setup ? (
            <>
              <p>{t('security.intro')}</p>
              <button className="b p" disabled={busy} onClick={() => void start()}>{t('security.start')}</button>
            </>
          ) : (
            <form onSubmit={confirm}>
              <p>{t('security.scan')}</p>
              {qr && <img className="qr" src={qr} alt="" />}
              <p className="small">{t('security.key')}: <code className="ltr" style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
              <p>{t('security.enter')}</p>
              <div className="actions">
                <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} dir="ltr" aria-label={t('login.code')}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 4, fontSize: 20, width: 140 }} />
                <button className="b p" type="submit" disabled={busy || code.length !== 6}>{t('security.confirm')}</button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
