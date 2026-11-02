// A client's books: left sidebar of modules, top bar, and the module itself.
import { useApi, type CompanyBooks, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, TopControls } from '../ui.tsx';
import { Home } from './Home.tsx';
import { Journal } from './Journal.tsx';
import { Reports } from './Reports.tsx';
import { Vat } from './Vat.tsx';

export const MODULES = ['Home', 'Sales', 'Purchases', 'Bank', 'Inventory', 'Assets', 'Journal', 'VAT', 'Reports', 'Review'] as const;
const BUILT = new Set(['Home', 'Journal', 'VAT', 'Reports']);

export function Workspace({ me, companyId, module, onSignOut }: { me: Me; companyId: string; module: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const books = useApi<CompanyBooks>(`/api/companies/${companyId}`);
  const mod = (MODULES as readonly string[]).includes(module) ? module : 'Home';
  const go = (m: string) => navigate(`/c/${companyId}/${m}`);
  const b = books.data;
  const title = mod === 'Home' ? t('home.greeting', { name: me.user.name.split(' ')[0]! }) : t(`mod.${mod}` as Key);

  return (
    <div className="app">
      <nav className="side" aria-label={t('app.name')}>
        <div className="brand"><b>{t('app.name')}</b><span>{b ? local(b.company.name, b.company.nameAr) : ''}</span></div>
        {MODULES.map((m) => (
          <button key={m} className={`${m === mod ? 'on' : ''} ${BUILT.has(m) ? '' : 'soon'}`} onClick={() => go(m)} aria-current={m === mod ? 'page' : undefined}>
            {t(`mod.${m}` as Key)}
          </button>
        ))}
      </nav>
      <main>
        <div className="top">
          <h1>{title}</h1>
          <TopControls who={`${me.user.name}${b ? ` · ${t(`role.${b.role}`)}` : ''}`} onSignOut={onSignOut}>
            {me.user.kind === 'firm_staff' && <button className="b" onClick={() => navigate('/')}>{t('clients.back')}</button>}
            {b && <span className="badge">{local(b.company.name, b.company.nameAr)} · {b.company.currency}</span>}
          </TopControls>
        </div>
        {books.error && <ErrorNote error={books.error} onRetry={books.reload} />}
        {!b ? <Loading /> : (
          <>
            {!b.canPost && <div className="notice warn">{t('viewOnly')}</div>}
            {mod === 'Home' && <Home books={b} go={go} />}
            {mod === 'Journal' && <Journal books={b} reloadBooks={books.reload} />}
            {mod === 'Reports' && <Reports books={b} />}
            {mod === 'VAT' && <Vat books={b} />}
            {!BUILT.has(mod) && (
              <div className="card">
                <h2>{t('soon.title', { module: t(`mod.${mod}` as Key) })}</h2>
                <p className="mut">{t(`soon.${mod}` as Key)}</p>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Latest end date of a locked period, or null. Posting on or before it is blocked. */
export function lockedUpTo(b: CompanyBooks): string | null {
  return b.periods.filter((p) => p.lockedAt).map((p) => p.endDate).sort().at(-1) ?? null;
}
export function isLocked(b: CompanyBooks, date: string): boolean {
  return b.periods.some((p) => p.lockedAt && date >= p.startDate && date <= p.endDate);
}
