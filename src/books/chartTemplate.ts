// Chart of accounts template, copied to each new client (PRODUCT_SPEC: "template copied to each client").
export interface TemplateAccount {
  code: string;
  name: string;
  nameAr: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  costCentreRequired?: boolean;
  /** Money can be received into or paid from this account. */
  bank?: boolean;
}

/** Accounts the dashboard and VAT screens read by code. */
export const SYSTEM_ACCOUNTS = {
  cash: '1000',
  receivables: '1100',
  inputVat: '1200',
  payables: '2000',
  outputVat: '2100',
  claimsPayable: '2200',
  sales: '4000',
  costOfSales: '5000',
} as const;

export const CHART_TEMPLATE: TemplateAccount[] = [
  { code: '1000', name: 'Cash in bank', nameAr: 'النقد في البنك', type: 'asset', bank: true },
  { code: '1010', name: 'Cash on hand', nameAr: 'النقد في الصندوق', type: 'asset', bank: true },
  { code: '1100', name: 'Accounts receivable', nameAr: 'الذمم المدينة', type: 'asset' },
  { code: '1200', name: 'Input VAT', nameAr: 'ضريبة المدخلات', type: 'asset' },
  { code: '1500', name: 'Equipment', nameAr: 'المعدات', type: 'asset' },
  { code: '2000', name: 'Accounts payable', nameAr: 'الذمم الدائنة', type: 'liability' },
  { code: '2100', name: 'Output VAT', nameAr: 'ضريبة المخرجات', type: 'liability' },
  { code: '2200', name: 'Employee claims payable', nameAr: 'مطالبات الموظفين المستحقة', type: 'liability' },
  { code: '3000', name: "Owner's equity", nameAr: 'حقوق الملكية', type: 'equity' },
  { code: '4000', name: 'Sales', nameAr: 'المبيعات', type: 'income' },
  { code: '5000', name: 'Cost of sales', nameAr: 'تكلفة المبيعات', type: 'expense' },
  { code: '5100', name: 'Rent', nameAr: 'الإيجار', type: 'expense', costCentreRequired: true },
  { code: '5200', name: 'Salaries', nameAr: 'الرواتب', type: 'expense', costCentreRequired: true },
  { code: '5300', name: 'Utilities and telecom', nameAr: 'المرافق والاتصالات', type: 'expense' },
  { code: '5400', name: 'Office and general expenses', nameAr: 'مصروفات مكتبية وعامة', type: 'expense' },
];
