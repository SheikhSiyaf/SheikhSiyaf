import { OPTIONAL_MODULES, accessTo } from '../../../src/books/modules.ts';
// The client workspace menu: each module and its sub-pages, in order.
// `built: false` pages show what comes next in the build order (CLAUDE.md).
export interface SubPage { key: string; built: boolean }
export interface Module { key: string; subs: SubPage[] }

const s = (key: string, built = true): SubPage => ({ key, built });

export const NAV: Module[] = [
  { key: 'Home', subs: [] },
  { key: 'Portal', subs: [s('overview'), s('requests'), s('documents'), s('monthly-reports')] },
  { key: 'Calendar', subs: [s('upcoming'), s('calendar-settings')] },
  { key: 'Approvals', subs: [s('waiting'), s('approval-history'), s('approval-rules')] },
  { key: 'Sales', subs: [s('overview'), s('customers'), s('quotations'), s('invoices'), s('credit-notes'), s('payments-received'), s('e-invoicing')] },
  { key: 'Purchases', subs: [s('overview'), s('suppliers'), s('bills'), s('supplier-credits'), s('payments-made')] },
  { key: 'Expenses', subs: [s('overview'), s('expenses'), s('recurring'), s('categories'), s('claims'), s('approvals')] },
  { key: 'Bank', subs: [s('accounts'), s('import'), s('reconcile'), s('rules')] },
  { key: 'Inventory', subs: [s('items'), s('grn'), s('gdn'), s('stock-value')] },
  { key: 'Restaurant', subs: [s('food-sales'), s('menu'), s('materials'), s('materials-in'), s('wastage'), s('material-value')] },
  { key: 'Assets', subs: [s('register'), s('depreciation')] },
  { key: 'Projects', subs: [s('projects'), s('project-report')] },
  { key: 'HRM', subs: [s('overview'), s('employees'), s('attendance'), s('leave'), s('payroll'), s('loans'), s('end-of-service'), s('hr-documents')] },
  { key: 'CRM', subs: [s('pipeline'), s('leads'), s('activities'), s('campaigns')] },
  { key: 'Journal', subs: [s('entries'), s('new'), s('periods')] },
  { key: 'Ledger', subs: [s('chart-of-accounts'), s('cost-centres-setup'), s('general-ledger'), s('cost-centre-ledger'), s('customer-ledger'), s('supplier-ledger'), s('employee-ledger')] },
  { key: 'Reports', subs: [s('owner-summary'), s('profit-and-loss'), s('balance-sheet'), s('cash-flow'), s('cash-forecast'), s('trial-balance'), s('cost-centres'), s('expenses-by-category'),
    s('expenses-by-payee'), s('aged-receivables'), s('aged-payables'), s('vat-summary'), s('vat-return')] },
  { key: 'Review', subs: [s('overview'), s('checks'), s('queries'), s('checklist'), s('sign-off')] },
];

export const moduleOf = (key: string) => NAV.find((m) => m.key === key) ?? NAV[0]!;
/** The menu for one client: core modules always, optional ones only when turned on for that client.
 *  Review, Portal and Calendar are open to everyone on the client (they are not part of client roles). */
export const navFor = (modules: string[] | undefined, permissions?: Record<string, string> | null, hide: string[] = []) =>
  NAV.filter((m) => (!(OPTIONAL_MODULES as readonly string[]).includes(m.key) || (modules ?? []).includes(m.key)) && accessTo(permissions, m.key) !== 'none' && !hide.includes(m.key));
/** Modules not shown for this customer: a company that keeps its own books has no accounting firm to talk to in the portal. */
export const hiddenFor = (tenantKind?: string | null) => (tenantKind === 'company' ? ['Portal'] : []);
export const isModuleBuilt = (m: Module) => m.subs.length === 0 || m.subs.some((x) => x.built);

/** Document type behind each list page. */
export const DOC_PAGES: Record<string, 'quotation' | 'invoice' | 'credit_note' | 'bill' | 'supplier_credit' | 'expense' | 'claim'> = {
  quotations: 'quotation', invoices: 'invoice', 'credit-notes': 'credit_note', bills: 'bill', 'supplier-credits': 'supplier_credit', expenses: 'expense', claims: 'claim',
};
export const pageForType = (t: string) => Object.entries(DOC_PAGES).find(([, v]) => v === t)?.[0] ?? 'invoices';
export const moduleForType = (t: string) => (t === 'expense' || t === 'claim' ? 'Expenses' : ['bill', 'supplier_credit'].includes(t) ? 'Purchases' : 'Sales');
