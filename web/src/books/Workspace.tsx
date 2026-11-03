// A client's books: left sidebar of modules (the open one shows its sub-pages), top bar, and the page.
// Address: /c/<company>/<Module>/<sub-page>/<item>/<extra>
import { BalanceSheet, CashFlow, OwnerSummary, VatReturnSheet } from './Statements.tsx';
import { useEffect, useState, type ReactNode } from 'react';
import { useApi, type CompanyBooks, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, Sidebar, TopControls } from '../ui.tsx';
import { Home } from './Home.tsx';
import { Journal } from './Journal.tsx';
import { Reports } from './Reports.tsx';
import { Vat } from './Vat.tsx';
import { DOC_PAGES, NAV, hiddenFor, isModuleBuilt, moduleOf, navFor } from './nav.ts';
import { Calendar } from '../calendar/Calendar.tsx';
import { Portal } from '../portal/Portal.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { Overview } from '../sales/Overview.tsx';
import { ContactList, ContactPage } from '../sales/Contacts.tsx';
import { DocEditor, DocList, DocView } from '../sales/Documents.tsx';
import { PaymentForm, PaymentList, PaymentView } from '../sales/Payments.tsx';
import { ExpensesOverview } from '../expenses/Overview.tsx';
import { RecurringForm, RecurringList } from '../expenses/Recurring.tsx';
import { Categories } from '../expenses/Categories.tsx';
import { ExpensesByCategory, ExpensesByPayee } from '../expenses/Reports.tsx';
import { Approvals } from '../expenses/Approvals.tsx';
import { ContactLedgers, CostCentreLedger, GeneralLedger } from '../ledger/Ledger.tsx';
import { ChartOfAccounts, CostCentres } from '../ledger/Setup.tsx';
import { ReportFrame } from '../print/Print.tsx';
import { ProjectList, ProjectPage, ProjectReport } from '../projects/Projects.tsx';
import { EmployeeList, EmployeePage } from '../hrm/Employees.tsx';
import { Activities, Campaigns, Leads, PipelinePage } from '../crm/Crm.tsx';
import { Review } from '../review/Review.tsx';
import { Attendance, EndOfService, HrDocuments, HrOverview, Leave, Loans, Payroll } from '../hrm/Hrm.tsx';
import { BankAccountForm, BankAccountList, BankAccountPage, ImportStatement, Reconcile, Rules } from '../bank/Bank.tsx';
import { ItemList, ItemPage, NoteEditor, NoteList, StockValue } from '../inventory/Inventory.tsx';
import { AssetPage, AssetRegister, Depreciation } from '../assets/Assets.tsx';
import { FoodSale, FoodSales, MenuList, RecipePage } from '../restaurant/Restaurant.tsx';

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

  // Which module's sub-menu is open in the sidebar. Opening a module shows its pages; pressing it again closes it.
  const [open, setOpen] = useState<string | null>(mod.key);
  useEffect(() => { setOpen(mod.key); }, [mod.key]);
  const onModule = (m: (typeof NAV)[number]) => {
    if (m.subs.length === 0) { goModule(m.key); return; }
    if (open === m.key) { setOpen(null); return; }        // second press closes it
    setOpen(m.key);
    if (m.key !== mod.key) goModule(m.key);               // a different module: open it and go to its first page
  };

  const subMenu = (m: (typeof NAV)[number], where: 'side' | 'top') => m.subs.length > 0 && (
    <div className={where === 'side' ? 'subnav' : 'subtabs'} role="navigation" aria-label={t(`mod.${m.key}` as Key)}>
      {m.subs.map((s) => (
        <button key={s.key} className={`${m.key === mod.key && s.key === sub?.key ? 'on' : ''} ${s.built ? '' : 'soon'}`}
          aria-current={m.key === mod.key && s.key === sub?.key ? 'page' : undefined}
          onClick={() => goModule(m.key, s.key)}>
          {t(`sub.${s.key}` as Key)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app">
      <Sidebar subtitle={b ? local(b.company.name, b.company.nameAr) : ''} user={me.user} roleLabel={b ? (b.access ? local(b.access.name, b.access.nameAr ?? null) : t(`role.${b.role}`)) : undefined} onSignOut={onSignOut}>
        {(b ? navFor(b.company.modules, b.access?.permissions, hiddenFor(b.portal?.tenantKind)) : NAV.filter((m) => m.key === 'Home')).map((m) => (
          <div key={m.key}>
            <button className={`${m.key === mod.key ? 'on' : ''} ${isModuleBuilt(m) ? '' : 'soon'}`} aria-current={m.key === mod.key && !sub ? 'page' : undefined}
              aria-expanded={m.subs.length ? open === m.key : undefined} onClick={() => onModule(m)}>
              {t(`mod.${m.key}` as Key)}{m.subs.length > 0 && <span className="chev" aria-hidden="true">{open === m.key ? '▾' : '▸'}</span>}
            </button>
            {open === m.key && subMenu(m, 'side')}
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
        {subMenu(mod, 'top')}
        {books.error && <ErrorNote error={books.error} onRetry={books.reload} />}
        {!b ? <Loading /> : (
          <>
            {!b.canPost && !['Review', 'Portal', 'Calendar'].includes(mod.key) && <div className="notice warn">{t('viewOnly')}</div>}
            {b.access && accessTo(b.access.permissions, mod.key) === 'none' ? (
              <div className="card"><h2>{t('access.noneTitle')}</h2><p className="mut">{t('access.noneText', { role: local(b.access.name, b.access.nameAr ?? null) })}</p>
                <button className="b p" onClick={() => goModule('Home')}>{t('mod.Home')}</button></div>
            ) : <>
            {b.access && b.canPost && accessTo(b.access.permissions, mod.key) === 'view' && <div className="notice small">{t('roleAccess', { role: local(b.access.name, b.access.nameAr ?? null), level: t(`access.${accessTo(b.access.permissions, mod.key)}` as Key) })}</div>}
            <Page books={{ ...b, canPost: b.canPost && accessTo(b.access?.permissions, mod.key) === 'edit' }} module={mod.key} sub={sub?.key ?? ''} built={sub?.built ?? true} item={item} extra={extra} extra2={extra2} reloadBooks={books.reload} goModule={goModule} />
            </>}
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
    case 'Reports': {
      const page = sub === 'owner-summary' ? <OwnerSummary books={books} /> : sub === 'balance-sheet' ? <BalanceSheet books={books} /> : sub === 'cash-flow' ? <CashFlow books={books} />
        : sub === 'vat-return' ? <VatReturnSheet books={books} />
        : sub === 'vat-summary' ? <Vat books={books} /> : sub === 'expenses-by-category' ? <ExpensesByCategory books={books} />
        : sub === 'expenses-by-payee' ? <ExpensesByPayee books={books} /> : <Reports books={books} sub={sub} />;
      return <ReportFrame key={sub} books={books} title={t(`sub.${sub}` as Key)}>{page}</ReportFrame>;
    }
    case 'Ledger':
      if (sub === 'chart-of-accounts') return <ChartOfAccounts books={books} onChanged={reloadBooks} />;
      if (sub === 'cost-centres-setup') return <CostCentres books={books} onChanged={reloadBooks} />;
      if (sub === 'general-ledger') return <GeneralLedger key={item ?? ''} books={books} initial={item} />;
      if (sub === 'cost-centre-ledger') return <CostCentreLedger key={item ?? ''} books={books} initial={item} />;
      return <ContactLedgers key={`${sub}-${item ?? ''}`} books={books} role={sub.replace('-ledger', '') as 'customer' | 'supplier' | 'employee'} contactId={item} />;
    case 'Projects':
      if (sub === 'project-report') return <ProjectReport books={books} />;
      return item ? <ProjectPage key={item} books={books} id={item} /> : <ProjectList books={books} />;
    case 'Bank':
      if (sub === 'import') return <ImportStatement key={item ?? ''} books={books} bankId={item} />;
      if (sub === 'reconcile') return <Reconcile key={item ?? ''} books={books} bankId={item} />;
      if (sub === 'rules') return <Rules books={books} />;
      if (item === 'new') return <BankAccountForm books={books} />;
      return item ? <BankAccountPage key={item} books={books} id={item} filter={extra} /> : <BankAccountList books={books} />;
    case 'Inventory':
    case 'Restaurant': {
      const mod = module as 'Inventory' | 'Restaurant';
      if (sub === 'food-sales') {
        if (item === 'new') return <FoodSale books={books} />;
        return item ? <DocView key={item} books={books} id={item} /> : <FoodSales books={books} />;
      }
      if (sub === 'menu') return item ? <RecipePage key={item} books={books} id={item} /> : <MenuList books={books} />;
      const type = sub === 'grn' || sub === 'materials-in' ? 'grn' : sub === 'gdn' || sub === 'wastage' ? 'gdn' : null;
      if (type) {
        if (item === 'new') return <NoteEditor key={`new-${sub}-${extra ?? ''}`} books={books} type={type} presetItemId={extra} mod={mod} />;
        return item ? <NoteEditor key={item} books={books} type={type} id={item} mod={mod} /> : <NoteList key={sub} books={books} type={type} mod={mod} />;
      }
      if (sub === 'stock-value' || sub === 'material-value') return <StockValue books={books} mod={mod} />;
      return item ? <ItemPage key={item} books={books} id={item} mod={mod} /> : <ItemList books={books} mod={mod} />;
    }
    case 'Assets':
      if (sub === 'depreciation') return <Depreciation books={books} />;
      return item ? <AssetPage key={item} books={books} id={item} /> : <AssetRegister books={books} />;
    case 'Review': return <Review books={books} sub={sub} item={item} />;
    case 'Portal': return <Portal books={books} sub={sub} item={item} extra={extra} />;
    case 'Calendar': return <Calendar books={books} sub={sub} />;
    case 'CRM':
      if (sub === 'leads') return <Leads books={books} id={item} />;
      if (sub === 'activities') return <Activities books={books} />;
      if (sub === 'campaigns') return <Campaigns books={books} />;
      return <PipelinePage books={books} id={item} />;
    case 'HRM':
      if (sub === 'employees') return item ? <EmployeePage key={`${item}${extra ?? ''}`} books={books} id={item} extra={extra} /> : <EmployeeList books={books} />;
      if (sub === 'overview') return <HrOverview books={books} />;
      if (sub === 'attendance') return <Attendance books={books} />;
      if (sub === 'leave') return <Leave books={books} />;
      if (sub === 'payroll') return <Payroll key={item ?? 'list'} books={books} id={item} />;
      if (sub === 'loans') return <Loans books={books} />;
      if (sub === 'end-of-service') return <EndOfService books={books} />;
      if (sub === 'hr-documents') return <HrDocuments books={books} />;
      return null;
    case 'Expenses':
      if (sub === 'overview') return <ExpensesOverview books={books} />;
      if (sub === 'recurring') return item ? <RecurringForm key={item} books={books} id={item} /> : <RecurringList books={books} />;
      if (sub === 'categories') return <Categories books={books} onAdded={reloadBooks} />;
      if (sub === 'approvals') return <Approvals books={books} />;
      if (sub === 'claims') {
        if (item === 'new') return <DocEditor key={`new-claim-${extra ?? ''}`} books={books} type="claim" presetContactId={extra} />;
        if (item) return <DocView key={item} books={books} id={item} />;
        return <DocList key={`claim-${extra ?? ''}`} books={books} type="claim" filter={extra} />;
      }
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
