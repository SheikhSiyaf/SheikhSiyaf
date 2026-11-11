// Industries and the optional modules they turn on. Core modules (Home, Sales, Purchases, Expenses, Bank,
// Journal, Ledger, Reports, Review) are always on. Shared by the API, the web app and the demo build.
export const INDUSTRIES = ['trading', 'retail', 'restaurant', 'services', 'construction', 'manufacturing', 'other'] as const;
export type Industry = (typeof INDUSTRIES)[number];
export const OPTIONAL_MODULES = ['Inventory', 'Restaurant', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM'] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

/** What each industry starts with. A restaurant tracks its materials in Restaurant, so Inventory is off. */
export const DEFAULT_MODULES: Record<Industry, OptionalModule[]> = {
  trading: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
  retail: ['Inventory', 'Assets', 'HRM', 'CRM'],
  restaurant: ['Restaurant', 'Assets', 'HRM', 'CRM'],
  services: ['Projects', 'Assets', 'HRM', 'CRM'],
  construction: ['Inventory', 'Projects', 'Assets', 'Rentals', 'HRM'],
  manufacturing: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
  other: ['Inventory', 'Assets', 'Projects', 'HRM', 'CRM'],
};

export const isIndustry = (v: unknown): v is Industry => INDUSTRIES.includes(v as Industry);
/** Keeps only known modules, in menu order. */
export const cleanModules = (v: unknown): OptionalModule[] =>
  OPTIONAL_MODULES.filter((m) => Array.isArray(v) && v.includes(m));

/** Modules a client role sets access for (none, view or edit). Home is always shown. */
export const ROLE_MODULES = ['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Reports'] as const;
export type RoleModule = (typeof ROLE_MODULES)[number];
export type AccessLevel = 'none' | 'view' | 'edit';
export const ACCESS_LEVELS: AccessLevel[] = ['none', 'view', 'edit'];
/** Access to a module from a role's permissions; null permissions = full access (no client role). */
export function accessTo(permissions: Record<string, string> | null | undefined, module: string): AccessLevel {
  if (!permissions) return 'edit';
  if (!(ROLE_MODULES as readonly string[]).includes(module)) return 'edit';   // Home and modules outside roles
  const v = permissions[module];
  return v === 'edit' || v === 'view' ? v : 'none';
}
