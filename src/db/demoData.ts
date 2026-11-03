// Demo firm used by `npm run db:seed`. Fictional people and companies, for trying the app only.
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_FIRM = 'Demo Accounting Firm';

export interface DemoCompany {
  key: string; name: string; nameAr: string; country: 'SA' | 'AE'; currency: string; vatRate: string;
  crNumber: string; vatNumber: string; legalForm: string; address: string; city: string; invoicePrefix: string;
  industry: 'trading' | 'restaurant';
}

export const DEMO_COMPANIES: DemoCompany[] = [
  { key: 'alnoor', name: 'Al Noor Trading', nameAr: 'النور للتجارة', country: 'SA', currency: 'SAR', vatRate: '15.00',
    crNumber: '1010123456', vatNumber: '300123456700003', legalForm: 'LLC', address: 'King Fahd Road, Al Olaya', city: 'Riyadh', invoicePrefix: 'ANT-', industry: 'trading' },
  { key: 'marina', name: 'Marina Café LLC', nameAr: 'مقهى المارينا ذ.م.م', country: 'AE', currency: 'AED', vatRate: '5.00',
    crNumber: 'DED-845210', vatNumber: '100234567800003', legalForm: 'LLC', address: 'Dubai Marina Walk', city: 'Dubai', invoicePrefix: 'MC-', industry: 'restaurant' },
  { key: 'riyadh', name: 'Riyadh Supplies Co', nameAr: 'شركة إمدادات الرياض', country: 'SA', currency: 'SAR', vatRate: '15.00',
    crNumber: '1010654321', vatNumber: '310987654300003', legalForm: 'Joint stock company', address: 'Prince Sultan St', city: 'Jeddah', invoicePrefix: 'RSC-', industry: 'trading' },
];

export interface DemoUser {
  name: string; email: string;
  kind: 'admin' | 'firm_staff' | 'client';
  role: 'admin' | 'partner' | 'reviewer' | 'staff_accountant' | 'client_accountant' | 'client_viewer';
  companies: string[];       // DemoCompany keys
  company?: string;          // display name for client users
}

export const DEMO_USERS: DemoUser[] = [
  { name: 'Nadia Admin', email: 'admin@firm.example', kind: 'admin', role: 'admin', companies: [] },
  { name: 'Omar Al Harbi', email: 'omar@firm.example', kind: 'firm_staff', role: 'partner', companies: ['alnoor', 'marina', 'riyadh'] },
  { name: 'Layla Haddad', email: 'layla@firm.example', kind: 'firm_staff', role: 'reviewer', companies: ['alnoor', 'marina'] },
  { name: 'Rami Saleh', email: 'rami@firm.example', kind: 'firm_staff', role: 'staff_accountant', companies: ['riyadh'] },
  { name: 'Sara Nasser', email: 'sara@alnoor.example', kind: 'client', role: 'client_accountant', companies: ['alnoor'], company: 'Al Noor Trading' },
  { name: 'Faisal Al Qahtani', email: 'faisal@alnoor.example', kind: 'client', role: 'client_viewer', companies: ['alnoor'], company: 'Al Noor Trading' },
  { name: 'Hana Rahman', email: 'hana@marinacafe.example', kind: 'client', role: 'client_accountant', companies: ['marina'], company: 'Marina Café LLC' },
  { name: 'Khalid Al Otaibi', email: 'khalid@riyadhsupplies.example', kind: 'client', role: 'client_viewer', companies: ['riyadh'], company: 'Riyadh Supplies Co' },
];

/** Sample restaurant (Marina Café): kitchen materials with their opening stock, the menu with recipes, and recent sales. */
export const DEMO_RESTAURANT = {
  materials: [
    { sku: 'CHK', name: 'Chicken breast', nameAr: 'صدر دجاج', unit: 'kg', qty: '40', cost: '22.00', reorder: '8' },
    { sku: 'RIC', name: 'Basmati rice', nameAr: 'أرز بسمتي', unit: 'kg', qty: '50', cost: '7.50', reorder: '10' },
    { sku: 'BUN', name: 'Burger buns', nameAr: 'خبز برجر', unit: 'pcs', qty: '200', cost: '0.90', reorder: '40' },
    { sku: 'PAT', name: 'Beef patty', nameAr: 'شريحة لحم', unit: 'pcs', qty: '150', cost: '4.20', reorder: '30' },
    { sku: 'CHS', name: 'Cheese slices', nameAr: 'شرائح جبن', unit: 'pcs', qty: '300', cost: '0.45', reorder: '50' },
    { sku: 'COF', name: 'Coffee beans', nameAr: 'حبوب القهوة', unit: 'kg', qty: '10', cost: '85.00', reorder: '2' },
    { sku: 'MLK', name: 'Fresh milk', nameAr: 'حليب طازج', unit: 'l', qty: '60', cost: '6.00', reorder: '12' },
    { sku: 'TOM', name: 'Tomatoes', nameAr: 'طماطم', unit: 'kg', qty: '20', cost: '5.50', reorder: '5' },
    { sku: 'LET', name: 'Lettuce', nameAr: 'خس', unit: 'kg', qty: '10', cost: '8.00', reorder: '3' },
    { sku: 'OIL', name: 'Cooking oil', nameAr: 'زيت طبخ', unit: 'l', qty: '30', cost: '9.00', reorder: '6' },
  ],
  recipes: [
    { name: 'Chicken machboos', nameAr: 'مجبوس دجاج', category: 'Mains', price: '38.00', lines: [['CHK', '0.300'], ['RIC', '0.200'], ['OIL', '0.030'], ['TOM', '0.050']] },
    { name: 'Classic burger', nameAr: 'برجر كلاسيك', category: 'Mains', price: '32.00', lines: [['BUN', '1'], ['PAT', '1'], ['CHS', '1'], ['LET', '0.020'], ['TOM', '0.030']] },
    { name: 'Garden salad', nameAr: 'سلطة الحديقة', category: 'Mains', price: '22.00', lines: [['LET', '0.120'], ['TOM', '0.100'], ['OIL', '0.015']] },
    { name: 'Cappuccino', nameAr: 'كابتشينو', category: 'Drinks', price: '16.00', lines: [['COF', '0.018'], ['MLK', '0.180']] },
    { name: 'Flat white', nameAr: 'فلات وايت', category: 'Drinks', price: '17.00', lines: [['COF', '0.020'], ['MLK', '0.150']] },
  ] as { name: string; nameAr: string; category: string; price: string; lines: [string, string][] }[],
  /** Days ago, how paid, and portions of each menu item. */
  sales: [
    { ago: 6, method: 'cash', items: [['Chicken machboos', 2], ['Cappuccino', 2]] },
    { ago: 5, method: 'card', items: [['Classic burger', 3], ['Flat white', 1]] },
    { ago: 4, method: 'card', items: [['Garden salad', 1], ['Cappuccino', 1]] },
    { ago: 3, method: 'cash', items: [['Chicken machboos', 4], ['Classic burger', 2], ['Flat white', 3]] },
    { ago: 2, method: 'on_account', items: [['Chicken machboos', 10], ['Garden salad', 5]] },
    { ago: 1, method: 'card', items: [['Classic burger', 2], ['Cappuccino', 4]] },
  ] as { ago: number; method: 'cash' | 'card' | 'on_account'; items: [string, number][] }[],
};
