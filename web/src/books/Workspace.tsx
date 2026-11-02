// A client's books: left sidebar of modules (the open one shows its sub-pages), top bar, and the page.
// Address: /c/<company>/<Module>/<sub-page>/<item>/<extra>
import type { ReactNode } from 'react';
import { useApi, type CompanyBooks, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, Sidebar, TopControls } from '../ui.tsx';
import { Home } from './Home.tsx';
import { Journal } from './Journal.tsx';
import { Reports } from './Reports.tsx';
import { Vat } from './Vat.tsx';
import { DOC_PAGES, NAV, isModuleBuilt, moduleOf } from './nav.ts';
import { Overview } from '../sales/Overview.tsx';
import { ContactList, ContactPage } from '../sales/Contacts.tsx';
import { DocEditor, DocList, DocView } from '../sales/Documents.tsx';
import { PaymentForm, PaymentList, PaymentView } from '../sales/Payments.tsx';
import { ExpensesOverview } from '../expenses/Overview.tsx';
import { RecurringForm, RecurringList } from '../expenses/Recurring.tsx';
import { Categories } from '../expenses/Categories.tsx';
import { ExpensesByCategory, ExpensesByPayee } from '../expenses/Reports.tsx';

export const MODULES = NAV.map((m) => m.key);

export function Workspace({ me, companyId, path, onSignOut }: { me: Me; companyId: string; path: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const books = useApi<CompanyBooks>(`/api/companies/${companyId}`);
  const [, , , modKey, subKey, rawItem, extra, extra2] = path.split('/');
  const item = rawItem === '-' ? undefined : rawItem;
  const mod = moduleOf(modKey ?? 'Home');
  const sub = mod.subs.find((s) => s.key === subKey) ?? mod.subs[0];
  const goModule = (m: string, s?: string) => navigate(`/c/${companyId}/${m}${s ? `/${s}` : ''}`);
  const b = books.data;
  const title = mod.key === 'Home' ? t('home.greeting', { name: me.user.name.split(' ')[0]! })
    : sub ? t(`sub.${sub.key}` as Key) : t(`mod.${mod.key}` as Key);

  const subMenu = (where: 'side' | 'top') => mod.subs.length > 0 && (
    <div className={where === 'side' ? 'subnav' : 'subtabs'} role="navigation" aria-label={t(`mod.${mod.key}` as Key)}>
      {mod.subs.map((s) => (
        <button key={s.key} className={`${s.key === sub?.key ? 'on' : ''} ${s.built ? '' : 'soon'}`} aria-current={s.key === sub?.key ? 'page' : undefined}
          onClick={() => goModule(mod.key, s.key)}>
          {t(`sub.${s.key}` as Key)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app">
      <Sidebar subtitle={b ? local(b.company.name, b.company.nameAr) : ''} user={me.user} roleLabel={b ? t(`role.${b.role}`) : undefined} onSignOut={onSignOut}>
        {NAV.map((m) => (
          <div key={m.key}>
            <button className={`${m.key === mod.key ? 'on' : ''} ${isModuleBuilt(m) ? '' : 'soon'}`} aria-current={m.key === mod.key && !sub ? 'page' : undefined}
              aria-expanded={m.subs.length ? m.key === mod.key : undefined} onClick={() => goModule(m.key)}>
              {t(`mod.${m.key}` as Key)}{m.subs.length > 0 && <span className="chev" aria-hidden="true">{m.key === mod.key ? '▾' : '▸'}</span>}
            </button>
            {m.key === mod.key && subMenu('side')}
          </div>
        ))}
      </Sidebar>
      <main>
        <div className="top">
          <h1>{title}</h1>
          <TopControls>
            {me.user.kind === 'firm_staff' && <button className="b" onClick={() => navigate('/')}>{t('clients.back')}</button>}
            {b && <span className="badge">{local(b.company.name, b.company.nameAr)} · {b.company.currency}</span>}
          </TopControls>
        </div>
        {subMenu('top')}
        {books.error && <ErrorNote error={books.error} onRetry={books.reload} />}
        {!b ? <Loading /> : (
          <>
            {!b.canPost && <div className="notice warn">{t('viewOnly')}</div>}
            <Page books={b} module={mod.key} sub={sub?.key ?? ''} built={sub?.built ?? true} item={item} extra={extra} extra2={extra2} reloadBooks={books.reload} goModule={goModule} />
          </>
        )}
      </main>
    </div>
  );
}

function Page({ books, module, sub, built, item, extra, extra2, reloadBooks, goModule }: {
  books: CompanyBooks; module: string; sub: string; built: boolean; item?: string; extra?: string; extra2?: string; reloadBooks: () => void; goModule: (m: string, s?: string) => void;
}): ReactNode {
  const { t, has } = useI18n();
  if (!built) {
    return (
      <div className="card">
        <h2>{t('soon.title', { module: t(`sub.${sub}` as Key) })}</h2>
        <p className="mut">{has(`soonSub.${sub}`) ? t(`soonSub.${sub}` as Key) : t(`soon.${module}` as Key)}</p>
      </div>
    );
  }
  const side = module === 'Purchases' ? 'purchases' : 'sales';
  switch (module) {
    case 'Home': return <Home books={books} go={goModule} />;
    case 'Journal': return <Journal books={books} sub={sub} reloadBooks={reloadBooks} go={(s) => goModule('Journal', s)} />;
    case 'Reports':
      if (sub === 'vat-summary') return <Vat books={books} />;
      if (sub === 'expenses-by-category') return <ExpensesByCategory books={books} />;
      if (sub === 'expenses-by-payee') return <ExpensesByPayee books={books} />;
      return <Reports books={books} sub={sub} />;
    case 'Expenses':
      if (sub === 'overview') return <ExpensesOverview books={books} />;
      if (sub === 'recurring') return item ? <RecurringForm key={item} books={books} id={item} /> : <RecurringList books={books} />;
      if (sub === 'categories') return <Categories books={books} onAdded={reloadBooks} />;
      if (sub === 'expenses') {
        if (item === 'new') return <DocEditor key="new-expense" books={books} type="expense" presetContactId={extra} />;
        if (item) return <DocView key={item} books={books} id={item} />;
        return <DocList key={`expense-${extra ?? ''}`} books={books} type="expense" filter={extra} />;
      }
      return null;
    case 'Sales':
    case 'Purchases': {
      if (sub === 'overview') return <Overview books={books} side={side} />;
      if (sub === 'customers' || sub === 'suppliers') {
        return item ? <ContactPage key={item} books={books} side={side} id={item} /> : <ContactList books={books} side={side} />;
      }
      if (sub === 'payments-received' || sub === 'payments-made') {
        const dir = sub === 'payments-received' ? 'received' : 'made';
        if (item === 'new') return <PaymentForm key={`${extra}-${extra2}`} books={books} direction={dir} presetContactId={extra} presetDocId={extra2} />;
        return item ? <PaymentView key={item} books={books} direction={dir} id={item} /> : <PaymentList books={books} direction={dir} />;
      }
      const type = DOC_PAGES[sub];
      if (type) {
        if (item === 'new') return <DocEditor key={`new-${extra ?? ''}`} books={books} type={type} presetContactId={extra} />;
        if (item) return <DocView key={item} books={books} id={item} />;
        return <DocList key={`${type}-${extra ?? ''}`} books={books} type={type} filter={extra} />;
      }
      return null;
    }
    default: return null;
  }
}

/** Latest end date of a locked period, or null. Posting on or before it is blocked. */
export function lockedUpTo(b: CompanyBooks): string | null {
  return b.periods.filter((p) => p.lockedAt).map((p) => p.endDate).sort().at(-1) ?? null;
}
export function isLocked(b: CompanyBooks, date: string): boolean {
  return b.periods.some((p) => p.lockedAt && date >= p.startDate && date <= p.endDate);
}
