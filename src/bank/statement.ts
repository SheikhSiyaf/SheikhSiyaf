// Bank statement files: reading CSV rows, finding the columns, dates and amounts, and which of the
// client's bank accounts a file belongs to. Pure functions, shared by the web app (which reads the
// file in the browser) and the API (which checks every line again before saving it).
import { fromMinor, toMinor, type Minor } from '../money.js';

// ------------------------------------------------------------------ banks known to the system
/** Banks recognised from the IBAN (bank code after the check digits). The person can always change the name. */
export const BANKS: { country: 'SA' | 'AE'; code: string; name: string; nameAr: string }[] = [
  { country: 'SA', code: '80', name: 'Al Rajhi Bank', nameAr: 'مصرف الراجحي' },
  { country: 'SA', code: '10', name: 'Saudi National Bank', nameAr: 'البنك الأهلي السعودي' },
  { country: 'SA', code: '20', name: 'Riyad Bank', nameAr: 'بنك الرياض' },
  { country: 'SA', code: '45', name: 'Saudi Awwal Bank', nameAr: 'البنك السعودي الأول' },
  { country: 'SA', code: '55', name: 'Banque Saudi Fransi', nameAr: 'البنك السعودي الفرنسي' },
  { country: 'SA', code: '30', name: 'Arab National Bank', nameAr: 'البنك العربي الوطني' },
  { country: 'SA', code: '05', name: 'Alinma Bank', nameAr: 'مصرف الإنماء' },
  { country: 'SA', code: '60', name: 'Bank AlJazira', nameAr: 'بنك الجزيرة' },
  { country: 'SA', code: '15', name: 'Bank Albilad', nameAr: 'بنك البلاد' },
  { country: 'SA', code: '65', name: 'Saudi Investment Bank', nameAr: 'البنك السعودي للاستثمار' },
  { country: 'AE', code: '026', name: 'Emirates NBD', nameAr: 'بنك الإمارات دبي الوطني' },
  { country: 'AE', code: '035', name: 'First Abu Dhabi Bank', nameAr: 'بنك أبوظبي الأول' },
  { country: 'AE', code: '030', name: 'Abu Dhabi Commercial Bank', nameAr: 'بنك أبوظبي التجاري' },
  { country: 'AE', code: '033', name: 'Mashreq', nameAr: 'بنك المشرق' },
  { country: 'AE', code: '024', name: 'Dubai Islamic Bank', nameAr: 'بنك دبي الإسلامي' },
  { country: 'AE', code: '050', name: 'Abu Dhabi Islamic Bank', nameAr: 'مصرف أبوظبي الإسلامي' },
  { country: 'AE', code: '040', name: 'RAKBANK', nameAr: 'بنك رأس الخيمة الوطني' },
  { country: 'AE', code: '023', name: 'Commercial Bank of Dubai', nameAr: 'بنك دبي التجاري' },
];

export const normaliseIban = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

/** ISO 13616 check (mod 97). Saudi IBANs have 24 characters, UAE 23. Same rule as iban_valid() in the database. */
export function ibanValid(raw: string): boolean {
  const p = normaliseIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(p)) return false;
  if ((p.startsWith('SA') && p.length !== 24) || (p.startsWith('AE') && p.length !== 23)) return false;
  const s = p.slice(4) + p.slice(0, 4);
  let r = 0;
  for (const ch of s) r = Number(`${r}${/\d/.test(ch) ? ch : ch.charCodeAt(0) - 55}`) % 97;
  return r === 1;
}

export function bankFromIban(raw: string) {
  const p = normaliseIban(raw);
  if (p.startsWith('SA')) return BANKS.find((b) => b.country === 'SA' && b.code === p.slice(4, 6));
  if (p.startsWith('AE')) return BANKS.find((b) => b.country === 'AE' && b.code === p.slice(4, 7));
  return undefined;
}

// ------------------------------------------------------------------ CSV
/** Splits CSV text into rows. Handles quotes, a byte-order mark, and comma, semicolon or tab separators. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// ------------------------------------------------------------------ dates and amounts
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
export const latinDigits = (s: string) =>
  s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10)).replace(/٫/g, '.').replace(/٬/g, ',');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** "31/01/2026", "2026-01-31", "31-Jan-26", "31 January 2026", an Excel day number. Returns YYYY-MM-DD or null. */
export function parseDate(raw: string, order: DateOrder = 'dmy'): string | null {
  const s = latinDigits(String(raw)).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) return order === 'mdy' ? ymd(+m[3]!, +m[1]!, +m[2]!) : ymd(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2,4})$/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()); return mo < 0 ? null : ymd(+m[3]!, mo + 1, +m[1]!); }
  m = /^(\d{5})(\.\d+)?$/.exec(s);   // Excel stores dates as days since 1899-12-30
  if (m && +m[1]! > 30000 && +m[1]! < 80000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + +m[1]! * 86_400_000);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  return null;
}

/** Day-first or month-first, from the dates in the file (a first number over 12 means day-first). */
export function guessDateOrder(samples: string[]): DateOrder {
  let dmy = false, mdy = false;
  for (const raw of samples) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(latinDigits(raw).trim());
    if (!m) continue;
    if (+m[1]! > 12) dmy = true;
    if (+m[2]! > 12) mdy = true;
  }
  return mdy && !dmy ? 'mdy' : 'dmy';   // banks in the Gulf write the day first
}

/** "1,234.50", "(1,234.50)", "-1234.5", "1,234.50 CR", "SAR 99", "١٬٢٣٤٫٥٠" -> minor units. Empty -> null. */
export function parseAmount(raw: string): Minor | null {
  let s = latinDigits(String(raw)).trim().toUpperCase();
  if (!s || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bDR\.?$/.test(s)) neg = true;
  s = s.replace(/\b(CR|DR)\.?$/, '').replace(/[A-Z]{3}|[^\d.,+-]/g, '').trim();
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = s.replace(/^\+/, '').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.') as [string, string?];
  // Excel can store 1234.56 as 1234.5599999999999: round the decimal text (never a float) to 2 places.
  const v = toMinor(`${whole}.${frac.slice(0, 2).padEnd(2, '0')}`) + (frac.length > 2 && frac[2]! >= '5' ? 1n : 0n);
  return neg ? -v : v;
}

// ------------------------------------------------------------------ columns
export interface Layout {
  headerRow: number;
  date: number;
  description: number;
  reference?: number;
  amount?: number;       // one signed column...
  debit?: number;        // ...or money out and money in in separate columns
  credit?: number;
  balance?: number;
  dateOrder: DateOrder;
}

const KEYS: Record<'date' | 'description' | 'reference' | 'debit' | 'credit' | 'amount' | 'balance', RegExp> = {
  date: /^(transaction |txn |posting |value |book(ing)? )?date$|^date\b|تاريخ/i,
  description: /description|narrat|details|particulars|remarks|memo|transaction$|البيان|الوصف|التفاصيل|بيان/i,
  reference: /ref|cheque|check|رقم المرجع|المرجع|مرجع/i,
  debit: /debit|withdraw|money out|paid out|مدين|سحب|مسحوب/i,
  credit: /credit|deposit|money in|paid in|دائن|إيداع|ايداع|مودع/i,
  amount: /^amount|المبلغ|^مبلغ/i,
  balance: /balance|الرصيد|رصيد/i,
};

/** Finds the header row and the columns, in English or Arabic. Null when the file does not look like a statement. */
export function detectLayout(rows: string[][]): Layout | null {
  for (let h = 0; h < Math.min(rows.length, 30); h++) {
    const head = rows[h]!.map((c) => c.toLowerCase());
    const find = (k: keyof typeof KEYS, not: number[] = []) => head.findIndex((c, i) => !not.includes(i) && c !== '' && KEYS[k].test(c));
    const date = find('date');
    if (date < 0) continue;
    const balance = find('balance', [date]);
    const debit = find('debit', [date, balance]);
    const credit = find('credit', [date, balance, debit]);
    const amount = find('amount', [date, balance, debit, credit]);
    const description = find('description', [date, balance, debit, credit, amount]);
    const reference = find('reference', [date, balance, debit, credit, amount, description]);
    if (description < 0 || !((debit >= 0 && credit >= 0) || amount >= 0)) continue;
    const opt = (i: number) => (i >= 0 ? i : undefined);
    const layout: Layout = { headerRow: h, date, description, reference: opt(reference), balance: opt(balance), dateOrder: 'dmy',
      ...(debit >= 0 && credit >= 0 ? { debit, credit } : { amount }) };
    layout.dateOrder = guessDateOrder(rows.slice(h + 1).map((r) => r[date] ?? ''));
    return layout;
  }
  return null;
}

export interface StatementRow { date: string; description: string; reference: string | null; amount: string; balance: string | null }

/** Reads the lines below the header. Rows without a date or an amount (titles, opening balance, totals) are left out. */
export function readStatement(rows: string[][], l: Layout): { lines: StatementRow[]; leftOut: number } {
  const lines: StatementRow[] = [];
  let leftOut = 0;
  for (const r of rows.slice(l.headerRow + 1)) {
    const date = parseDate(r[l.date] ?? '', l.dateOrder);
    let amount: Minor | null = null;
    if (l.amount !== undefined) amount = parseAmount(r[l.amount] ?? '');
    else {
      const out = parseAmount(r[l.debit!] ?? ''), inn = parseAmount(r[l.credit!] ?? '');
      if (out !== null && out !== 0n) amount = -(out < 0n ? -out : out);
      else if (inn !== null && inn !== 0n) amount = inn < 0n ? -inn : inn;
    }
    const description = (r[l.description] ?? '').replace(/\s+/g, ' ').trim();
    if (!date || amount === null || amount === 0n || !description) { leftOut++; continue; }
    const bal = l.balance !== undefined ? parseAmount(r[l.balance] ?? '') : null;
    lines.push({ date, description, reference: l.reference !== undefined ? (r[l.reference] ?? '').trim() || null : null,
      amount: fromMinor(amount), balance: bal === null ? null : fromMinor(bal) });
  }
  return { lines, leftOut };
}

/** The client's bank account whose IBAN or account number appears in the file. */
export function findAccountInFile(rows: string[][], accounts: { id: string; iban: string | null; accountNumber: string | null }[]): string | null {
  const text = rows.slice(0, 40).flat().join(' ').toUpperCase().replace(/[\s-]/g, '');
  const hit = accounts.find((a) => (a.iban && text.includes(normaliseIban(a.iban)))
    || (a.accountNumber && a.accountNumber.replace(/[\s-]/g, '').length >= 6 && text.includes(a.accountNumber.replace(/[\s-]/g, '').toUpperCase())));
  return hit?.id ?? null;
}

/** Identity of each line, so a line imported twice (overlapping statements) is recognised. Identical lines in one file are numbered. */
export function fingerprints(lines: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = `${l.date}|${l.amount}|${l.description.toLowerCase().replace(/\s+/g, ' ')}|${l.balance ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/** How alike two texts are (0-1), from the words they share. Used to rank match suggestions. */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter((w) => w.length > 2));
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}
