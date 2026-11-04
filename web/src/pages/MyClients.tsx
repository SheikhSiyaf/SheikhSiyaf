import { useApi, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { useDates } from '../calendar/Calendar.tsx';
import { navigate } from '../router.ts';
import { Sidebar, TopControls } from '../ui.tsx';

export function MyClients({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const role = me.user.staffRole ?? me.companies[0]?.role;
  const review = useApi<{ companyId: string; open: number; answered: number; reviewedUpTo: string | null }[]>('/api/review/my-clients');
  const rv = (id: string) => review.data?.find((r) => r.companyId === id);
  const cal = useApi<{ companyId: string; overdue: number; soon: number; next: { kind: string; due: string } | null }[]>('/api/calendar/my-clients');
  const portal = useApi<{ companyId: string; newUploads: number; openRequests: number; answeredRequests: number; unreadLetters: number }[]>('/api/portal/my-clients');
  const dt = useDates();
  const cl = (id: string) => cal.data?.find((r) => r.companyId === id);
  const pt = (id: string) => portal.data?.find((r) => r.companyId === id);
  const apr = useApi<{ companyId: string; toDecide: number }[]>('/api/approvals/my-clients');
  const ap = (id: string) => apr.data?.find((r) => r.companyId === id)?.toDecide ?? 0;
  return (
    <div className="app">
      <Sidebar subtitle={me.user.firmName} user={me.user} roleLabel={role ? t(`role.${role}`) : undefined} onSignOut={onSignOut}>
        <button className="on">{t('clients.title')}</button>
      </Sidebar>
      <main>
        <div className="top">
          <h1>{t('clients.title')}</h1>
          <TopControls />
        </div>
        <div className="card">
          <div className="mut" style={{ marginBottom: 8 }}>{t('clients.hint')}</div>
          {me.companies.length === 0 ? <div className="mut">{t('clients.empty')}</div> : (
            <div className="wrap">
              <table>
                <thead><tr><th>{t('col.client')}</th><th>{t('col.country')}</th><th>{t('col.currency')}</th><th>{t('col.vat')}</th><th>{t('col.yourRole')}</th><th>{t('rv.reviewedCol')}</th><th>{t('rv.queriesCol')}</th><th>{t('cal.col')}</th><th>{t('pt.col')}</th><th>{t('apr.col')}</th><th /></tr></thead>
                <tbody>
                  {me.companies.map((c) => (
                    <tr key={c.id}>
                      <td>{local(c.name, c.nameAr)}</td>
                      <td>{t(`country.${c.country}`)}</td>
                      <td>{c.currency}</td>
                      <td className="num">{Number(c.vatRate)}%</td>
                      <td>{t(`role.${c.role}`)}</td>
                      <td className="small ltr">{rv(c.id)?.reviewedUpTo?.slice(0, 7) ?? '—'}</td>
                      <td className="small">{rv(c.id)?.answered ? <button className="link" onClick={() => navigate(`/c/${c.id}/Review/queries`)}><span className="badge warn">{t('rv.answersN', { n: rv(c.id)!.answered })}</span></button> : null}
                        {rv(c.id)?.open ? <span className="mut"> {t('rv.withClientN', { n: rv(c.id)!.open })}</span> : null}{!rv(c.id)?.answered && !rv(c.id)?.open ? '—' : null}</td>
                      <td className="small">{cl(c.id)?.overdue ? <button className="link" onClick={() => navigate(`/c/${c.id}/Calendar/upcoming`)}><span className="badge bad">{t('cal.overdueN', { n: cl(c.id)!.overdue })}</span></button> : null}
                        {cl(c.id)?.next ? <div className="mut">{t(`cal.short.${cl(c.id)!.next!.kind}` as Key)} · {dt.day(cl(c.id)!.next!.due)}</div> : !cl(c.id)?.overdue ? '—' : null}</td>
                      <td className="small">{pt(c.id)?.newUploads || pt(c.id)?.answeredRequests ? <button className="link" onClick={() => navigate(`/c/${c.id}/Portal/documents`)}><span className="badge warn">{t('pt.newDocsN', { n: (pt(c.id)?.newUploads ?? 0) })}</span></button> : null}
                        {pt(c.id)?.openRequests ? <div className="mut">{t('pt.waitingN', { n: pt(c.id)!.openRequests })}</div> : null}{!pt(c.id)?.newUploads && !pt(c.id)?.answeredRequests && !pt(c.id)?.openRequests ? '—' : null}</td>
                      <td className="small">{ap(c.id) ? <button className="link" onClick={() => navigate(`/c/${c.id}/Approvals/waiting`)}><span className="badge warn">{t('apr.toDecideN', { n: ap(c.id) })}</span></button> : '—'}</td>
                      <td className="num"><button className="b p" onClick={() => navigate(`/c/${c.id}/Home`)}>{t('clients.open')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
