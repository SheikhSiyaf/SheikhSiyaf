// The client workspace menu: each module and its sub-pages, in order.
// `built: false` pages show what comes next in the build order (CLAUDE.md).
export interface SubPage { key: string; built: boolean }
export interface Module { key: string; subs: SubPage[] }

const s = (key: string, built = true): SubPage => ({ key, built });

export const NAV: Module[] = [
  { key: 'Home', subs: [] },
  { key: 'Sales', subs: [s('overview'), s('customers'), s('quotations'), s('invoices'), s('credit-notes'), s('payments-received')] },
  { key: 'Purchases', subs: [s('overview'), s('suppliers'), s('bills'), s('supplier-credits'), s('payments-made')] },
  { key: 'Bank', subs: [s('accounts', false), s('import', false), s('reconcile', false), s('rules', false)] },
  { key: 'Inventory', subs: [s('items', false), s('movements', false), s('recipes', false)] },
  { key: 'Assets', subs: [s('register', false), s('depreciation', false)] },
  { key: 'Journal', subs: [s('entries'), s('new'), s('periods')] },
  { key: 'VAT', subs: [s('summary'), s('return', false), s('e-invoicing', false)] },
  { key: 'Reports', subs: [s('trial-balance'), s('profit-and-loss'), s('cost-centres'), s('aged-receivables'), s('aged-payables')] },
  { key: 'Review', subs: [s('checks', false), s('queries', false), s('sign-off', false)] },
];

export const moduleOf = (key: string) => NAV.find((m) => m.key === key) ?? NAV[0]!;
export const isModuleBuilt = (m: Module) => m.subs.length === 0 || m.subs.some((x) => x.built);

/** Document type behind each list page. */
export const DOC_PAGES: Record<string, 'quotation' | 'invoice' | 'credit_note' | 'bill' | 'supplier_credit'> = {
  quotations: 'quotation', invoices: 'invoice', 'credit-notes': 'credit_note', bills: 'bill', 'supplier-credits': 'supplier_credit',
};
export const pageForType = (t: string) => Object.entries(DOC_PAGES).find(([, v]) => v === t)?.[0] ?? 'invoices';
export const moduleForType = (t: string) => (['bill', 'supplier_credit'].includes(t) ? 'Purchases' : 'Sales');
