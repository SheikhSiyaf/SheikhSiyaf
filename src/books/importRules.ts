// Bulk import rules, shared by the API, the web app and the demo: what each kind of import holds, the template,
// reading the header row (English or Arabic, any order, extra columns ignored), and the checks a row must pass
// on its own. Checks against the books (duplicates, account codes) are in importService.ts.

export const IMPORT_KINDS = ['customers', 'suppliers', 'items', 'accounts', 'opening'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export interface Column { key: string; en: string; ar: string; required?: boolean; example: string; aliases?: string[] }

const contact: Column[] = [
  { key: 'name', en: 'Name', ar: 'الاسم', required: true, example: 'Gulf Steel Trading', aliases: ['customer', 'supplier', 'company', 'العميل', 'المورد'] },
  { key: 'nameAr', en: 'Arabic name', ar: 'الاسم بالعربية', example: 'الخليج للحديد' },
  { key: 'vatNumber', en: 'VAT number', ar: 'الرقم الضريبي', example: '300000000000003', aliases: ['trn', 'tax number', 'vat no', 'الرقم الضريبي للمنشأة'] },
  { key: 'crNumber', en: 'CR number', ar: 'السجل التجاري', example: '1010101010', aliases: ['cr', 'commercial registration', 'trade licence'] },
  { key: 'email', en: 'Email', ar: 'البريد الإلكتروني', example: 'accounts@gulfsteel.example', aliases: ['e-mail'] },
  { key: 'phone', en: 'Phone', ar: 'الهاتف', example: '+966 11 000 0000', aliases: ['mobile', 'telephone', 'الجوال'] },
  { key: 'address', en: 'Street', ar: 'الشارع', example: 'King Fahd Road', aliases: ['address', 'العنوان'] },
  { key: 'buildingNumber', en: 'Building number', ar: 'رقم المبنى', example: '1234' },
  { key: 'district', en: 'District', ar: 'الحي', example: 'Al Olaya' },
  { key: 'city', en: 'City', ar: 'المدينة', example: 'Riyadh' },
  { key: 'postalCode', en: 'Postal code', ar: 'الرمز البريدي', example: '12211', aliases: ['zip', 'po box'] },
  { key: 'country', en: 'Country', ar: 'الدولة', example: 'SA' },
  { key: 'paymentTermsDays', en: 'Payment terms (days)', ar: 'مدة السداد (أيام)', example: '30', aliases: ['terms', 'payment terms', 'credit days'] },
];
export const COLUMNS: Record<ImportKind, Column[]> = {
  customers: contact,
  suppliers: contact.map((c) => (c.key === 'name' ? { ...c, example: 'Najd Wholesale' } : c.key === 'nameAr' ? { ...c, example: 'نجد للجملة' } : c)),
  items: [
    { key: 'sku', en: 'Code', ar: 'الرمز', required: true, example: 'BEAM-6M', aliases: ['sku', 'item code', 'رمز الصنف'] },
    { key: 'name', en: 'Name', ar: 'الاسم', required: true, example: 'Steel beam 6m', aliases: ['item', 'description', 'الصنف'] },
    { key: 'nameAr', en: 'Arabic name', ar: 'الاسم بالعربية', example: 'جسر حديد 6م' },
    { key: 'unit', en: 'Unit', ar: 'الوحدة', example: 'pcs' },
    { key: 'salePrice', en: 'Sale price', ar: 'سعر البيع', example: '450.00', aliases: ['price'] },
    { key: 'reorderLevel', en: 'Reorder level', ar: 'حد إعادة الطلب', example: '10' },
  ],
  accounts: [
    { key: 'code', en: 'Code', ar: 'رمز الحساب', required: true, example: '5450', aliases: ['account code', 'account no', 'الرمز'] },
    { key: 'name', en: 'Name', ar: 'اسم الحساب', required: true, example: 'Marketing', aliases: ['account', 'account name', 'الاسم'] },
    { key: 'nameAr', en: 'Arabic name', ar: 'الاسم بالعربية', example: 'التسويق' },
    { key: 'type', en: 'Type', ar: 'النوع', required: true, example: 'expense', aliases: ['account type'] },
    { key: 'costCentreRequired', en: 'Cost centre required', ar: 'مركز التكلفة إلزامي', example: 'no' },
  ],
  opening: [
    { key: 'code', en: 'Account code', ar: 'رمز الحساب', required: true, example: '1000', aliases: ['code', 'account', 'الحساب'] },
    { key: 'name', en: 'Account name (for reference)', ar: 'اسم الحساب (للمرجع)', example: 'Cash in bank', aliases: ['account name', 'name', 'اسم الحساب'] },
    { key: 'debit', en: 'Debit', ar: 'مدين', example: '50000.00', aliases: ['dr'] },
    { key: 'credit', en: 'Credit', ar: 'دائن', example: '0.00', aliases: ['cr'] },
  ],
};
export const ACCOUNT_TYPE_WORDS: Record<string, string> = {
  asset: 'asset', assets: 'asset', 'أصل': 'asset', 'أصول': 'asset',
  liability: 'liability', liabilities: 'liability', 'التزام': 'liability', 'التزامات': 'liability', 'خصوم': 'liability',
  equity: 'equity', 'حقوق الملكية': 'equity', 'حقوق ملكية': 'equity',
  income: 'income', revenue: 'income', 'إيراد': 'income', 'إيرادات': 'income',
  expense: 'expense', expenses: 'expense', 'مصروف': 'expense', 'مصروفات': 'expense',
};

const norm = (s: string) => s.toLowerCase().replace(/\*/g, '').replace(/[()\s_.:-]+/g, ' ').trim();
/** Western digits for numbers typed with Arabic-Indic digits. */
export const latin = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

/** The template: the header row (English, or Arabic) and one example row. Excel opens it with the right letters (UTF-8 BOM). */
export function template(kind: ImportKind, lang: 'en' | 'ar' = 'en'): string {
  const cols = COLUMNS[kind];
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${cols.map((c) => cell(`${lang === 'ar' ? c.ar : c.en}${c.required ? ' *' : ''}`)).join(',')}\n${cols.map((c) => cell(c.example)).join(',')}\n`;
}

export interface Mapped { header: number; columns: { index: number; key: string | null; title: string }[]; missing: string[]; records: { line: number; values: Record<string, string> }[] }
/** Finds the header row (the first row naming a required column) and reads every row after it. */
export function mapRows(kind: ImportKind, rows: string[][]): Mapped {
  const cols = COLUMNS[kind];
  const names = new Map<string, string>();
  for (const c of cols) for (const n of [c.key, c.en, c.ar, ...(c.aliases ?? [])]) if (!names.has(norm(n))) names.set(norm(n), c.key);
  const header = rows.findIndex((r) => r.some((x) => cols.filter((c) => c.required).some((c) => names.get(norm(x ?? '')) === c.key)));
  if (header < 0) return { header: -1, columns: [], missing: cols.filter((c) => c.required).map((c) => c.key), records: [] };
  const used = new Set<string>();
  const columns = rows[header]!.map((title, index) => {
    const key = names.get(norm(title ?? '')) ?? null;
    if (!key || used.has(key)) return { index, key: null, title };
    used.add(key); return { index, key, title };
  });
  const missing = cols.filter((c) => c.required && !used.has(c.key)).map((c) => c.key);
  const records = rows.slice(header + 1).map((r, i) => {
    const values: Record<string, string> = {};
    for (const c of columns) if (c.key) values[c.key] = latin(String(r[c.index] ?? '').trim());
    return { line: header + i + 2, values };
  }).filter((x) => Object.values(x.values).some((v) => v !== ''));
  return { header, columns, missing, records };
}

/** An amount as written in a spreadsheet: commas, spaces, brackets for negatives; at most 2 decimals. Returns minor units. */
export function amount(raw: string): bigint | null {
  let s = raw.replace(/[\s,]/g, '').replace(/(SAR|AED|OMR|ر\.س|د\.إ)/gi, '');
  if (s === '' || s === '-') return 0n;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return neg ? -v : v;
}
const yes = (v: string) => /^(y|yes|true|1|نعم)$/i.test(v.trim());

/** Problems a row has on its own (keys of plain-language messages). */
export function rowProblems(kind: ImportKind, v: Record<string, string>, country: string): string[] {
  const out: string[] = [];
  if (kind === 'customers' || kind === 'suppliers') {
    if (!v.name) out.push('imp.p.name');
    const c = (v.country || country).toUpperCase();
    const vat = (v.vatNumber ?? '').replace(/\s/g, '');
    if (vat && c === 'SA' && !/^3\d{13}3$/.test(vat)) out.push('imp.p.saVat');
    if (vat && c === 'AE' && !/^\d{15}$/.test(vat)) out.push('imp.p.aeTrn');
    if (v.country && !/^[A-Za-z]{2}$/.test(v.country)) out.push('imp.p.country');
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) out.push('imp.p.email');
    if (v.buildingNumber && !/^\d{4}$/.test(v.buildingNumber)) out.push('imp.p.building');
    if (v.postalCode && !/^\d{5}$/.test(v.postalCode)) out.push('imp.p.postal');
    if (v.paymentTermsDays && (!/^\d+$/.test(v.paymentTermsDays) || Number(v.paymentTermsDays) > 365)) out.push('imp.p.terms');
  } else if (kind === 'items') {
    if (!v.sku) out.push('imp.p.sku');
    if (!v.name) out.push('imp.p.name');
    if (v.salePrice && (amount(v.salePrice) === null || amount(v.salePrice)! < 0n)) out.push('imp.p.price');
    if (v.reorderLevel && !/^\d+(\.\d{1,3})?$/.test(v.reorderLevel)) out.push('imp.p.reorder');
  } else if (kind === 'accounts') {
    if (!/^[1-9]\d{3}$/.test(v.code ?? '')) out.push('imp.p.code');
    if (!v.name) out.push('imp.p.name');
    const type = ACCOUNT_TYPE_WORDS[(v.type ?? '').toLowerCase().trim()];
    if (!type) out.push('imp.p.type');
    else if (/^[1-9]\d{3}$/.test(v.code ?? '') && !({ asset: '1', liability: '2', equity: '3', income: '4', expense: '56789' } as Record<string, string>)[type]!.includes(v.code![0]!)) out.push('imp.p.codeType');
  } else {
    if (!v.code) out.push('imp.p.code');
    const d = amount(v.debit ?? ''), c = amount(v.credit ?? '');
    if (d === null || c === null) out.push('imp.p.amount');
    else if (d < 0n || c < 0n) out.push('imp.p.negative');
    else if (d > 0n && c > 0n) out.push('imp.p.both');
  }
  return out;
}
export const isYes = yes;
