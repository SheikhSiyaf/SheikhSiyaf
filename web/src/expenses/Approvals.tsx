// Approvals: employee claims waiting for a decision. Whoever submitted a claim cannot approve it.
import { useState } from 'react';
import { api, useApi, type CompanyBooks, type Me } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type DocRow } from '../sales/common.tsx';

type Claim = DocRow & { submittedBy: string | null; submittedByName: string | null; submittedAt: string | null };

export function Approvals({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const me = useApi<Me>('/api/me');
  const list = useApi<Claim[]>(`/api/companies/${books.company.id}/documents?type=claim&status=submitted`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const approve = async (c: Claim) => {
    setBusy(true); setMsg({});
    try { await api(`/api/documents/${c.id}/approve`, { body: {} }); setMsg({ ok: t('appr.approved', { number: c.number ?? '' }) }); list.reload(); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <p className="mut small">{t('appr.hint')}</p>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data || !me.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('appr.none')}</div> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('doc.number')}</th><th>{t('claim.employee')}</th><th>{t('doc.date')}</th><th>{t('appr.submittedBy')}</th><th className="num">{t('doc.total')}</th><th /></tr></thead>
              <tbody>
                {list.data.map((c) => {
                  const mine = c.submittedBy === me.data!.user.id;
                  return (
                    <tr key={c.id}>
                      <td><button className="link" onClick={() => go('Expenses', 'claims', c.id)}>{c.number}</button></td>
                      <td>{local(c.contactName, c.contactNameAr)}</td>
                      <td data-label={t('doc.date')}>{c.issueDate}</td>
                      <td className="small" data-label={t('appr.submittedBy')}>{c.submittedByName}</td>
                      <td className="num ltr" data-label={t('doc.total')}>{fmt(c.grossTotal)}</td>
                      <td>
                        {!books.canPost || (books.access && !books.access.canApprove) ? null : mine ? <span className="small mut">{t('appr.yours')}</span> : (
                          <div className="actions">
                            <button className="b p small" disabled={busy} onClick={() => void approve(c)}>{t('appr.approve')}</button>
                            <button className="b small" onClick={() => go('Expenses', 'claims', c.id)}>{t('appr.review')}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
