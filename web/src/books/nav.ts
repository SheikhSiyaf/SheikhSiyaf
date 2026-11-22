import { OPTIONAL_MODULES, accessTo } from '../../../src/books/modules.ts';
// The client workspace menu: each module and its sub-pages, in order.
// `built: false` pages show what comes next in the build order (CLAUDE.md).
/** `menu: false` pages are not in the sidebar; they stay reachable (More links, search, addresses). `needs` is a role module the page also requires. */
export interface SubPage { key: string; built: boolean; menu: boolean; needs?: string }
export interface Module { key: string; subs: SubPage[] }

const s = (key: string, built = true, needs?: string): SubPage => ({ key, built, menu: true, needs });
const h = (key: string, built = true): SubPage => ({ key, built, menu: false });
const own = (key: string): SubPage => s(key, true, 'OwnerReports');

export const NAV: Module[] = [
  { key: 'Home', subs: [] },
  { key: 'Portal', subs: [s('overview'), s('requests'), s('documents'), s('monthly-reports')] },
  { key: 'Calendar', subs: [s('upcoming'), s('calendar-settings')] },
  { key: 'Approvals', subs: [s('waiting'), s('approval-history'), s('approval-rules')] },
  { key: 'Sales', subs: [s('overview'), s('customers'), s('quotations'), s('invoices'), h('recurring-invoices'), s('credit-notes'), s('debit-notes'), s('payments-received'), h('online-payments'), h('statements'), h('reminders'), h('e-invoicing'), h('zatca'), h('emails')] },
  { key: 'Purchases', subs: [s('overview'), s('suppliers'), s('purchase-orders'), s('bills'), s('supplier-credits'), s('payments-made')] },
  { key: 'Expenses', subs: [s('overview'), s('expenses'), h('recurring'), h('categories'), s('claims'), h('approvals')] },
  { key: 'Bank', subs: [s('accounts'), s('import'), s('reconcile'), h('rules')] },
  { key: 'Inventory', subs: [s('items'), h('warehouse-desk'), s('grn'), s('gdn'), s('stock-value')] },
  { key: 'Restaurant', subs: [s('food-sales'), s('menu'), s('materials'), h('stock-desk'), h('materials-in'), h('wastage'), s('material-value')] },
  { key: 'Assets', subs: [s('register'), s('depreciation')] },
  { key: 'Rooms', subs: [s('front-desk'), s('room-calendar'), s('bookings'), h('room-setup')] },
  { key: 'Rentals', subs: [s('rental-board'), s('rental-contracts'), h('equipment')] },
  { key: 'Projects', subs: [s('projects'), s('project-report')] },
  { key: 'HRM', subs: [s('overview'), s('employees'), s('attendance'), s('leave'), s('payroll'), h('loans'), h('end-of-service'), h('hr-documents')] },
  { key: 'CRM', subs: [s('pipeline'), s('leads'), h('activities'), h('campaigns')] },
  { key: 'Journal', subs: [s('entries'), s('new'), h('periods'), h('year-end')] },
  { key: 'Ledger', subs: [s('chart-of-accounts'), h('cost-centres-setup'), s('general-ledger'), h('cost-centre-ledger'), s('customer-ledger'), s('supplier-ledger'), h('employee-ledger'), h('currencies'), h('fx-revaluation'), h('import-data')] },
  { key: 'Ownership', subs: [s('owners'), s('owner-movements'), s('equity-statement')] },
  { key: 'Reports', subs: [own('owner-summary'), own('profit-and-loss'), own('balance-sheet'), own('cash-flow'), h('cash-forecast'), h('budgets'), s('trial-balance'), h('cost-centres'), h('expenses-by-category'),
    h('expenses-by-payee'), s('aged-receivables'), s('aged-payables'), h('vat-summary'), s('vat-return')] },
  { key: 'Review', subs: [s('overview'), s('checks'), s('queries'), s('checklist'), s('sign-off')] },
];

/** Menu sections: what you do today, money in and out, operations, people, and the books. */
export const GROUPS: [string, string[]][] = [
  ['today', ['Home', 'Portal', 'Calendar', 'Approvals']],
  ['money', ['Sales', 'Purchases', 'Expenses', 'Bank']],
  ['operations', ['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects']],
  ['people', ['HRM', 'CRM']],
  ['books', ['Journal', 'Ledger', 'Ownership', 'Reports', 'Review']],
];
export const groupOf = (key: string) => GROUPS.find(([, ks]) => ks.includes(key))?.[0] ?? 'books';
/** The pages of a module this job title may open (pages that need a module the title lacks are left out). */
export const subsFor = (m: Module, permissions?: Record<string, string> | null) => m.subs.filter((x) => !x.needs || accessTo(permissions, x.needs) !== 'none');
/** The pages shown in the sidebar, and the rest (shown as "More" links inside the module). */
export const menuSubs = (m: Module, permissions?: Record<string, string> | null) => subsFor(m, permissions).filter((x) => x.menu);
export const moreSubs = (m: Module, permissions?: Record<string, string> | null) => subsFor(m, permissions).filter((x) => !x.menu);
export const moduleOf = (key: string) => NAV.find((m) => m.key === key) ?? NAV[0]!;
/** The menu for one client: core modules always, optional ones only when turned on for that client.
 *  Review, Portal and Calendar are open to everyone on the client (they are not part of client roles). */
export const navFor = (modules: string[] | undefined, permissions?: Record<string, string> | null, hide: string[] = []) =>
  NAV.filter((m) => (!(OPTIONAL_MODULES as readonly string[]).includes(m.key) || (modules ?? []).includes(m.key)) && accessTo(permissions, m.key) !== 'none' && !hide.includes(m.key));
/** Modules not shown for this customer: a company that keeps its own books has no accounting firm to talk to in the portal. */
export const hiddenFor = (tenantKind?: string | null) => (tenantKind === 'company' ? ['Portal'] : []);
export const isModuleBuilt = (m: Module) => m.subs.length === 0 || m.subs.some((x) => x.built);

/** Document type behind each list page. */
export const DOC_PAGES: Record<string, 'quotation' | 'invoice' | 'credit_note' | 'debit_note' | 'bill' | 'supplier_credit' | 'expense' | 'claim' | 'purchase_order'> = {
  quotations: 'quotation', invoices: 'invoice', 'credit-notes': 'credit_note', 'debit-notes': 'debit_note', 'purchase-orders': 'purchase_order', bills: 'bill', 'supplier-credits': 'supplier_credit', expenses: 'expense', claims: 'claim',
};
export const pageForType = (t: string) => Object.entries(DOC_PAGES).find(([, v]) => v === t)?.[0] ?? 'invoices';
export const moduleForType = (t: string) => (t === 'expense' || t === 'claim' ? 'Expenses' : ['bill', 'supplier_credit', 'purchase_order'].includes(t) ? 'Purchases' : 'Sales');
