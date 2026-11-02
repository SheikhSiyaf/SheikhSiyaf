import type { Me } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { Sidebar, TopControls } from '../ui.tsx';

export function MyClients({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const role = me.user.staffRole ?? me.companies[0]?.role;
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
                <thead><tr><th>{t('col.client')}</th><th>{t('col.country')}</th><th>{t('col.currency')}</th><th>{t('col.vat')}</th><th>{t('col.yourRole')}</th><th /></tr></thead>
                <tbody>
                  {me.companies.map((c) => (
                    <tr key={c.id}>
                      <td>{local(c.name, c.nameAr)}</td>
                      <td>{t(`country.${c.country}`)}</td>
                      <td>{c.currency}</td>
                      <td className="num">{Number(c.vatRate)}%</td>
                      <td>{t(`role.${c.role}`)}</td>
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
