// The guided first-run setup for a customer in a free trial: the questions, what each answer switches on, and the extra
// accounts a kind of business usually needs. Pure rules, shared by the API and the screens; no database here.
// Public answers are checked against these lists on the server (the browser's choices are never trusted).

export const BUSINESS_TYPES = ['trading', 'services', 'restaurant', 'rentals', 'contracting', 'other'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const GOALS = ['invoicing', 'bookkeeping', 'vat', 'payroll', 'inventory', 'restaurant', 'rentals', 'rooms', 'assets', 'projects', 'crm', 'einvoicing', 'clients'] as const;
export type Goal = (typeof GOALS)[number];

export const STEPS = ['about', 'chart', 'data', 'done'] as const;
export type Step = (typeof STEPS)[number];

export const DATA_CHOICES = ['import', 'fresh'] as const;
export type DataChoice = (typeof DATA_CHOICES)[number];

/** The optional modules a goal needs. Goals that need none (invoicing, VAT, ...) are served by the core software. */
export const GOAL_MODULE: Partial<Record<Goal, string>> = {
  payroll: 'HRM', inventory: 'Inventory', restaurant: 'Restaurant', rentals: 'Rentals', rooms: 'Rooms', assets: 'Assets', projects: 'Projects', crm: 'CRM',
};
export const modulesForGoals = (goals: readonly string[]): string[] =>
  [...new Set(goals.map((g) => GOAL_MODULE[g as Goal]).filter((m): m is string => Boolean(m)))].sort();

export interface SetupAnswers { businessType: BusinessType; goals: Goal[]; dataChoice?: DataChoice }

/** Reads the answers of one step; anything outside the lists is refused (never silently dropped, so a tampered request is visible). */
export function cleanAnswers(x: { businessType?: unknown; goals?: unknown; dataChoice?: unknown }): { ok: true; value: Partial<SetupAnswers> } | { ok: false; problem: string } {
  const out: Partial<SetupAnswers> = {};
  if (x.businessType !== undefined && x.businessType !== null) {
    if (!(BUSINESS_TYPES as readonly string[]).includes(String(x.businessType))) return { ok: false, problem: 'businessType' };
    out.businessType = x.businessType as BusinessType;
  }
  if (x.goals !== undefined && x.goals !== null) {
    if (!Array.isArray(x.goals) || x.goals.length > GOALS.length || x.goals.some((g) => !(GOALS as readonly string[]).includes(String(g)))) return { ok: false, problem: 'goals' };
    out.goals = [...new Set(x.goals.map(String))] as Goal[];
  }
  if (x.dataChoice !== undefined && x.dataChoice !== null) {
    if (!(DATA_CHOICES as readonly string[]).includes(String(x.dataChoice))) return { ok: false, problem: 'dataChoice' };
    out.dataChoice = x.dataChoice as DataChoice;
  }
  return { ok: true, value: out };
}

/** Accounts a kind of business usually needs on top of the standard chart (codes that the standard chart does not use). Imported through the ordinary
 *  accounts import, so existing codes are left alone and nothing is posted. Header row first, in the import's own column names. */
export const ACCOUNT_HEADER = ['Code', 'Name', 'Arabic name', 'Type', 'Cost centre required'];
type Row = [code: string, name: string, nameAr: string, type: string];
export const INDUSTRY_ACCOUNTS: Record<BusinessType, Row[]> = {
  trading: [['4010', 'Sales returns and discounts', 'مردودات ومسموحات المبيعات', 'income'], ['5010', 'Freight and customs on purchases', 'الشحن والجمارك على المشتريات', 'expense'], ['5020', 'Packaging', 'مواد التغليف', 'expense']],
  services: [['4020', 'Service and consulting income', 'إيرادات الخدمات والاستشارات', 'income'], ['5410', 'Professional and subcontractor fees', 'أتعاب مهنية ومقاولي الباطن', 'expense'], ['5420', 'Software subscriptions', 'اشتراكات البرامج', 'expense']],
  restaurant: [['4010', 'Food and beverage sales', 'مبيعات الأطعمة والمشروبات', 'income'], ['5010', 'Food and beverage purchases', 'مشتريات الأطعمة والمشروبات', 'expense'], ['5020', 'Packaging and disposables', 'التغليف والمستهلكات', 'expense'], ['5060', 'Delivery app commissions', 'عمولات تطبيقات التوصيل', 'expense']],
  rentals: [['4110', 'Equipment rental income', 'إيرادات تأجير المعدات', 'income'], ['5110', 'Equipment repairs and maintenance', 'صيانة وإصلاح المعدات', 'expense'], ['5120', 'Fuel and transport', 'الوقود والنقل', 'expense']],
  contracting: [['4030', 'Contract revenue', 'إيرادات المقاولات', 'income'], ['5030', 'Subcontractors', 'مقاولو الباطن', 'expense'], ['5040', 'Site materials', 'مواد الموقع', 'expense'], ['5060', 'Site labour and camp costs', 'عمالة الموقع وتكاليف المعسكر', 'expense']],
  other: [],
};
export const industryRows = (b: BusinessType): string[][] => (INDUSTRY_ACCOUNTS[b].length ? [ACCOUNT_HEADER, ...INDUSTRY_ACCOUNTS[b].map((r) => [...r, 'no'])] : []);

/** Which module guide a path belongs to: the first part of /c/<company>/<Module>/... or 'Home'. */
export const GUIDE_PAGES = ['Home', 'Portal', 'Calendar', 'Approvals', 'Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'Reports', 'Review'] as const;
export const guideOf = (path: string): string | null => {
  const m = /^\/c\/[0-9a-f-]{36}(?:\/([A-Za-z]+))?/.exec(path);
  if (!m) return null;
  return (GUIDE_PAGES as readonly string[]).includes(m[1] ?? 'Home') ? (m[1] ?? 'Home') : null;
};
