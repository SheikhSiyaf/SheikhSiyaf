// Sample figures for the widget gallery and for the Administrator's default-layout editor. They are invented, labelled "Sample" on screen,
// and never mixed with a company's real figures: the real home page shows only what the server worked out from the posted entries.
import type { Result } from './types.ts';

const addMonths = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 10);

export function sampleResult(id: string, type: string, today: string): Result {
  const first = `${today.slice(0, 7)}-01`;
  const months = [-5, -4, -3, -2, -1, 0].map((n) => addMonths(first, n));
  const base: Result = { id, type, state: 'ok', from: first, to: today, drill: { module: 'Reports', sub: '', query: {} }, data: {} };
  switch (type) {
    case 'cash': return { ...base, data: { asOf: today, balance: '184250.00', opening: '151900.00', change: '32350.00' } };
    case 'receivables': return { ...base, data: { asOf: today, total: '96480.00', contacts: 14, buckets: { current: '41200.00', d1_30: '28900.00', d31_60: '15300.00', d61_90: '7080.00', d90_plus: '4000.00' } } };
    case 'payables': return { ...base, data: { asOf: today, total: '58120.00', contacts: 9, buckets: { current: '30400.00', d1_30: '17220.00', d31_60: '6900.00', d61_90: '2600.00', d90_plus: '1000.00' } } };
    case 'net_profit': return { ...base, data: { from: first, to: today, revenue: '212400.00', netProfit: '48650.00', previous: { from: addMonths(first, -1), to: first, revenue: '198000.00', netProfit: '41200.00' } } };
    case 'income_expense': {
      const rev = [142000, 158500, 171200, 165900, 198000, 212400], exp = [118400, 126000, 131500, 129800, 156800, 163750];
      return { ...base, data: { columns: months.map((m, i) => ({ from: m, to: m, revenue: `${rev[i]}.00`, expenses: `${exp[i]}.00`, netProfit: `${rev[i]! - exp[i]!}.00` })) } };
    }
    case 'expenses_by_category': return { ...base, data: { from: first, to: today, total: '163750.00', other: '9350.00', rows: [
      { accountId: 'a1', name: 'Cost of goods sold', nameAr: 'تكلفة البضاعة المباعة', amount: '88200.00' }, { accountId: 'a2', name: 'Salaries', nameAr: 'الرواتب', amount: '41000.00' },
      { accountId: 'a3', name: 'Rent', nameAr: 'الإيجار', amount: '14400.00' }, { accountId: 'a4', name: 'Transport', nameAr: 'النقل', amount: '6200.00' }, { accountId: 'a5', name: 'Utilities', nameAr: 'المرافق', amount: '4400.00' }] } };
    case 'vat_due': return { ...base, data: { from: first, to: today, outputVat: '31860.00', inputVat: '14210.00', netVat: '17650.00', agreesWithBooks: true } };
    case 'overdue_invoices': return { ...base, data: { asOf: today, count: 4, total: '27640.00', rows: [
      { id: 's1', number: 'INV-0042', contact: 'Gulf Steel', contactAr: 'الخليج للحديد', due: addMonths(first, -2), amount: '9200.00' }, { id: 's2', number: 'INV-0047', contact: 'Najd Trading', contactAr: 'نجد للتجارة', due: addMonths(first, -1), amount: '8740.00' },
      { id: 's3', number: 'INV-0051', contact: 'Al Rawabi', contactAr: 'الروابي', due: addMonths(first, -1), amount: '6300.00' }, { id: 's4', number: 'INV-0053', contact: 'Red Sea Foods', contactAr: 'أغذية البحر الأحمر', due: first, amount: '3400.00' }] } };
    case 'bills_due': return { ...base, data: { asOf: today, count: 3, total: '14920.00', rows: [
      { id: 'b1', number: 'BILL-0018', contact: 'Riyadh Wholesale', contactAr: 'الرياض للجملة', due: addMonths(first, -1), amount: '7600.00' }, { id: 'b2', number: 'BILL-0021', contact: 'Gulf Packaging', contactAr: 'الخليج للتغليف', due: first, amount: '4320.00' },
      { id: 'b3', number: 'BILL-0022', contact: 'City Power', contactAr: 'كهرباء المدينة', due: first, amount: '3000.00' }] } };
    case 'stock_value': return { ...base, data: { total: '73420.00', booksValue: '73420.00', difference: '0.00' } };
    case 'books_status': return { ...base, data: { entries: 412, entriesThisMonth: 38, lockedUpTo: addMonths(first, -1) } };
    default: return base;
  }
}
