// Demo firm used by `npm run db:seed`. Fictional people and companies, for trying the app only.
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_FIRM = 'Demo Accounting Firm';

export interface DemoCompany {
  key: string; name: string; nameAr: string; country: 'SA' | 'AE'; currency: string; vatRate: string;
  crNumber: string; vatNumber: string; legalForm: string; address: string; city: string; invoicePrefix: string;
}

export const DEMO_COMPANIES: DemoCompany[] = [
  { key: 'alnoor', name: 'Al Noor Trading', nameAr: 'النور للتجارة', country: 'SA', currency: 'SAR', vatRate: '15.00',
    crNumber: '1010123456', vatNumber: '300123456700003', legalForm: 'LLC', address: 'King Fahd Road, Al Olaya', city: 'Riyadh', invoicePrefix: 'ANT-' },
  { key: 'marina', name: 'Marina Café LLC', nameAr: 'مقهى المارينا ذ.م.م', country: 'AE', currency: 'AED', vatRate: '5.00',
    crNumber: 'DED-845210', vatNumber: '100234567800003', legalForm: 'LLC', address: 'Dubai Marina Walk', city: 'Dubai', invoicePrefix: 'MC-' },
  { key: 'riyadh', name: 'Riyadh Supplies Co', nameAr: 'شركة إمدادات الرياض', country: 'SA', currency: 'SAR', vatRate: '15.00',
    crNumber: '1010654321', vatNumber: '310987654300003', legalForm: 'Joint stock company', address: 'Prince Sultan St', city: 'Jeddah', invoicePrefix: 'RSC-' },
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
