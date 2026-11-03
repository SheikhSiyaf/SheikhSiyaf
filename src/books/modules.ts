// Industries and the optional modules they turn on. Core modules (Home, Sales, Purchases, Expenses, Bank,
// Journal, Ledger, Reports, Review) are always on. Shared by the API, the web app and the demo build.
export const INDUSTRIES = ['trading', 'retail', 'restaurant', 'services', 'construction', 'manufacturing', 'other'] as const;
export type Industry = (typeof INDUSTRIES)[number];
export const OPTIONAL_MODULES = ['Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM'] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

/** What each industry starts with. A restaurant tracks its materials in Restaurant, so Inventory is off. */
export const DEFAULT_MODULES: Record<Industry, OptionalModule[]> = {
  trading: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
  retail: ['Inventory', 'Assets', 'HRM', 'CRM'],
  restaurant: ['Restaurant', 'Assets', 'HRM', 'CRM'],
  services: ['Projects', 'Assets', 'HRM', 'CRM'],
  construction: ['Inventory', 'Projects', 'Assets', 'HRM'],
  manufacturing: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
  other: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
};

export const isIndustry = (v: unknown): v is Industry => INDUSTRIES.includes(v as Industry);
/** Keeps only known modules, in menu order. */
export const cleanModules = (v: unknown): OptionalModule[] =>
  OPTIONAL_MODULES.filter((m) => Array.isArray(v) && v.includes(m));
