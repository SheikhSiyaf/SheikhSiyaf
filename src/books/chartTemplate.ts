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
  rentalIncome: '4100',
  costOfSales: '5000',
  inventory: '1300',
  goodsReceived: '2050',
  openingEquity: '3000',
  accumulatedDepreciation: '1590',
  depreciation: '5050',
  disposalGainLoss: '4900',
  equipment: '1500',
  employeeLoans: '1150',
  salariesPayable: '2210',
  insurancePayable: '2220',
  eosProvision: '2230',
  salaries: '5200',
  insuranceExpense: '5210',
  eosExpense: '5220',
} as const;

export const CHART_TEMPLATE: TemplateAccount[] = [
  { code: '1000', name: 'Cash in bank', nameAr: 'النقد في البنك', type: 'asset', bank: true },
  { code: '1010', name: 'Cash on hand', nameAr: 'النقد في الصندوق', type: 'asset', bank: true },
  { code: '1100', name: 'Accounts receivable', nameAr: 'الذمم المدينة', type: 'asset' },
  { code: '1150', name: 'Employee loans and advances', nameAr: 'سلف وقروض الموظفين', type: 'asset' },
  { code: '1200', name: 'Input VAT', nameAr: 'ضريبة المدخلات', type: 'asset' },
  { code: '1300', name: 'Inventory', nameAr: 'المخزون', type: 'asset' },
  { code: '1500', name: 'Equipment', nameAr: 'المعدات', type: 'asset' },
  { code: '1510', name: 'Vehicles', nameAr: 'المركبات', type: 'asset' },
  { code: '1520', name: 'Furniture and fixtures', nameAr: 'الأثاث والتجهيزات', type: 'asset' },
  { code: '1530', name: 'Computers and IT equipment', nameAr: 'أجهزة الحاسب وتقنية المعلومات', type: 'asset' },
  { code: '1590', name: 'Accumulated depreciation', nameAr: 'مجمع الإهلاك', type: 'asset' },
  { code: '2000', name: 'Accounts payable', nameAr: 'الذمم الدائنة', type: 'liability' },
  { code: '2050', name: 'Goods received not yet billed', nameAr: 'بضائع مستلمة لم تصل فواتيرها', type: 'liability' },
  { code: '2100', name: 'Output VAT', nameAr: 'ضريبة المخرجات', type: 'liability' },
  { code: '2200', name: 'Employee claims payable', nameAr: 'مطالبات الموظفين المستحقة', type: 'liability' },
  { code: '2210', name: 'Salaries payable', nameAr: 'الرواتب المستحقة', type: 'liability' },
  { code: '2220', name: 'Social insurance payable', nameAr: 'التأمينات الاجتماعية المستحقة', type: 'liability' },
  { code: '2230', name: 'End of service provision', nameAr: 'مخصص مكافأة نهاية الخدمة', type: 'liability' },
  { code: '3000', name: "Owner's equity", nameAr: 'حقوق الملكية', type: 'equity' },
  { code: '4000', name: 'Sales', nameAr: 'المبيعات', type: 'income' },
  { code: '4100', name: 'Rental income', nameAr: 'إيرادات التأجير', type: 'income' },
  { code: '4900', name: 'Gain or loss on sale of assets', nameAr: 'أرباح أو خسائر بيع الأصول', type: 'income' },
  { code: '4950', name: 'Unrealised exchange gains and losses', nameAr: 'أرباح وخسائر فروقات العملة غير المحققة', type: 'income' },
  { code: '4951', name: 'Realised exchange gains and losses', nameAr: 'أرباح وخسائر فروقات العملة المحققة', type: 'income' },
  { code: '5000', name: 'Cost of sales', nameAr: 'تكلفة المبيعات', type: 'expense' },
  { code: '5050', name: 'Depreciation', nameAr: 'مصروف الإهلاك', type: 'expense' },
  { code: '5100', name: 'Rent', nameAr: 'الإيجار', type: 'expense', costCentreRequired: true },
  { code: '5200', name: 'Salaries', nameAr: 'الرواتب', type: 'expense', costCentreRequired: true },
  { code: '5210', name: 'Social insurance', nameAr: 'التأمينات الاجتماعية', type: 'expense' },
  { code: '5220', name: 'End of service benefits', nameAr: 'مكافأة نهاية الخدمة', type: 'expense' },
  { code: '5300', name: 'Utilities and telecom', nameAr: 'المرافق والاتصالات', type: 'expense' },
  { code: '5400', name: 'Office and general expenses', nameAr: 'مصروفات مكتبية وعامة', type: 'expense' },
];
