// Emailing an issued invoice, credit note or quotation to the customer, copying its view link, and what was sent.
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Loading, errorText } from '../ui.tsx';
import { navigate } from '../router.ts';

export interface EmailRow { id: string; kind: string; to: string; toName: string | null; subject: string; status: string; attempts: number; lastError: string | null;
  documentId: string | null; attachments: number; createdBy: string | null; createdAt: string; sentAt: string | null }
const TONE: Record<string, string> = { sent: 'good', queued: 'warn', sending: 'warn', failed: 'bad' };

export function EmailStatus({ e }: { e: EmailRow }) {
  const { t } = useI18n();
  return <><span className={`badge ${TONE[e.status] ?? ''}`}>{t(`mail.s.${e.status}` as never)}</span>
    {e.status === 'queued' && e.lastError && <div className="small mut">{e.lastError}</div>}{e.status === 'failed' && <div className="small bad">{e.lastError}</div>}</>;
}

export function DocEmail({ books, documentId }: { books: CompanyBooks; documentId: string }) {
  const { t, has } = useI18n();
  const sent = useApi<{ emails: EmailRow[]; links: { id: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }[] }>(`/api/documents/${documentId}/emails`);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg({});
    try { setMsg({ ok: await fn() }); sent.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const live = (sent.data?.links ?? []).filter((l) => !l.revokedAt);
  const seen = live.find((l) => l.lastSeenAt);
  return (
    <div className="card" id="doc-email">
      <div className="actions">
        <h3 style={{ margin: 0 }}>{t('mail.title')}</h3>
        <span className="spacer" />
        {books.canPost && !open && <button className="b p" id="doc-email-open" onClick={() => { setOpen(true); setMsg({}); }}>{t('mail.send')}</button>}
        {books.canPost && <button className="b" id="doc-link" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ link: string }>(`/api/documents/${documentId}/link`, { body: {} });
          await navigator.clipboard?.writeText(r.link).catch(() => undefined);
          return t('mail.linkCopied', { link: r.link });
        })}>{t('mail.copyLink')}</button>}
        {books.canPost && <button className="b" id="doc-preview" disabled={busy} onClick={() => void api<{ link: string }>(`/api/documents/${documentId}/link`, { body: {} })
          .then((r) => navigate(new URL(r.link, window.location.href).pathname))}>{t('mail.preview')}</button>}
      </div>
      {msg.ok && <div className="notice small" role="status" id="doc-email-msg" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" style={{ marginTop: 8 }}>{msg.bad}</div>}
      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <label className="f">{t('mail.to')}<input id="doc-email-to" type="email" dir="ltr" value={to} placeholder={t('mail.toHint')} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <label className="f">{t('mail.message')}<textarea id="doc-email-message" rows={3} value={message} placeholder={t('mail.messageHint')} onChange={(e) => setMessage(e.target.value)} /></label>
          <p className="small mut">{t('mail.whatGoes')}</p>
          <div className="actions">
            <button className="b p" id="doc-email-send" disabled={busy} onClick={() => void run(async () => {
              const r = await api<{ to: string }>(`/api/documents/${documentId}/email`, { body: { to: to.trim() || undefined, message } });
              setOpen(false); setMessage('');
              return t('mail.queued', { to: r.to });
            })}>{t('mail.sendNow')}</button>
            <button className="b" onClick={() => setOpen(false)}>{t('cancel')}</button>
          </div>
        </div>
      )}
      {!sent.data ? <Loading /> : sent.data.emails.length > 0 && (
        <table className="mini" style={{ marginTop: 10 }}><tbody>{sent.data.emails.map((e) => (
          <tr key={e.id}><td className="ltr small">{e.to}</td><td className="small mut">{e.createdAt.slice(0, 16).replace('T', ' ')} · {e.createdBy}</td><td><EmailStatus e={e} /></td></tr>
        ))}</tbody></table>
      )}
      {seen && <p className="small mut" style={{ marginBottom: 0 }}>{t('mail.opened', { at: seen.lastSeenAt!.slice(0, 16).replace('T', ' ') })}</p>}
      {books.canPost && live.length > 0 && <button className="link small" onClick={() => void run(async () => { await api(`/api/documents/${documentId}/links/revoke`, { body: {} }); return t('mail.revoked'); })}>{t('mail.revoke')}</button>}
    </div>
  );
}

/** Sales > Emails sent: everything the company sent, with what is waiting or failed. */
export function EmailsSent({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const list = useApi<{ provider: string; emails: EmailRow[] }>(`/api/companies/${books.company.id}/emails`);
  const [err, setErr] = useState<string>();
  if (!list.data) return <Loading />;
  return (
    <>
      {list.data.provider === 'none' && <div className="notice warn" id="mail-no-provider">{t('mail.noProvider')}</div>}
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="card">
        {list.data.emails.length === 0 ? <p className="mut">{t('mail.none')}</p> : (
          <div className="wrap"><table className="stack" id="mail-list">
            <thead><tr><th>{t('mail.when')}</th><th>{t('mail.to')}</th><th>{t('mail.subject')}</th><th>{t('hr.status')}</th><th /></tr></thead>
            <tbody>{list.data.emails.map((e) => (
              <tr key={e.id}>
                <td className="small ltr">{e.createdAt.slice(0, 16).replace('T', ' ')}<div className="mut">{e.createdBy}</div></td>
                <td className="ltr small" data-label={t('mail.to')}>{e.to}</td>
                <td className="small" data-label={t('mail.subject')}>{e.subject}{e.attachments > 0 && <span className="mut"> · 📎 {e.attachments}</span>}</td>
                <td data-label={t('hr.status')}><EmailStatus e={e} /></td>
                <td className="num">{e.status === 'failed' && books.canPost && <button className="b small" onClick={() => { setErr(undefined); void api(`/api/emails/${e.id}/retry`, { body: {} }).then(list.reload, (x) => setErr(errorText(t, has, x))); }}>{t('mail.retry')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
