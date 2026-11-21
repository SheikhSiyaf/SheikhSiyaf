// Shared helpers for the brochure demo data. Everything here is fictional: companies, people, phone numbers and
// numbers are invented, emails end in @example.com, VAT and ID numbers are obviously fake. Nothing is sent anywhere.
import type pg from 'pg';
import type { Db } from '../../src/db/session.js';
import { fromMinor, toMinor } from '../../src/money.js';
import { vatForLine } from '../../src/vat/vat.js';
import { postEntry, type LineInput } from '../../src/ledger/ledger.js';
import { issueDocument, recordPayment, saveContact, saveDraft } from '../../src/books/documentsService.js';
import type { DocType } from '../../src/books/documents.js';

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

/** A small seeded random generator, so a rerun makes the same data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Pair = [en: string, ar: string];
export const FIRST_M: Pair[] = [['Abdullah', 'عبدالله'], ['Fahad', 'فهد'], ['Saud', 'سعود'], ['Turki', 'تركي'], ['Nasser', 'ناصر'], ['Majed', 'ماجد'], ['Sultan', 'سلطان'], ['Badr', 'بدر'],
  ['Rakan', 'راكان'], ['Yazeed', 'يزيد'], ['Mishari', 'مشاري'], ['Talal', 'طلال'], ['Waleed', 'وليد'], ['Saleh', 'صالح'], ['Ibrahim', 'إبراهيم'], ['Mansour', 'منصور'], ['Bandar', 'بندر'], ['Khaled', 'خالد']];
export const FIRST_F: Pair[] = [['Noura', 'نورة'], ['Reem', 'ريم'], ['Lama', 'لمى'], ['Hessa', 'حصة'], ['Sara', 'سارة'], ['Maha', 'مها'], ['Dalal', 'دلال'], ['Amal', 'أمل'], ['Layan', 'ليان'], ['Joud', 'جود']];
export const FAMILY: Pair[] = [['Al-Qahtani', 'القحطاني'], ['Al-Otaibi', 'العتيبي'], ['Al-Dossari', 'الدوسري'], ['Al-Harbi', 'الحربي'], ['Al-Ghamdi', 'الغامدي'], ['Al-Shehri', 'الشهري'],
  ['Al-Zahrani', 'الزهراني'], ['Al-Mutairi', 'المطيري'], ['Al-Subaie', 'السبيعي'], ['Al-Shammari', 'الشمري'], ['Al-Anazi', 'العنزي'], ['Al-Rashidi', 'الرشيدي'], ['Al-Juhani', 'الجهني'], ['Al-Balawi', 'البلوي']];
export const EXPAT: string[] = ['Rajesh Kumar', 'Mohammed Rafiq', 'Joseph Mathew', 'Ramesh Pillai', 'Imran Khan', 'Abdul Karim', 'Sunil Perera', 'Ali Raza', 'Jose Santos', 'Anil Nair', 'Hassan Abdelrahman',
  'Mahmoud Saeed', 'Tariq Mehmood', 'Vikram Singh', 'Pedro Alvarez', 'Nabil Haddad', 'Samir Aziz', 'Kamal Uddin', 'Suresh Babu', 'Yasser Fouad', 'Raju Thomas', 'Irfan Ali', 'Mostafa Ibrahim', 'George Varghese', 'Asif Iqbal'];
const PLACES: Pair[] = [['Najd', 'نجد'], ['Gulf', 'الخليج'], ['Red Sea', 'البحر الأحمر'], ['Eastern', 'الشرقية'], ['Riyadh', 'الرياض'], ['Jeddah', 'جدة'], ['Hijaz', 'الحجاز'], ['Tuwaiq', 'طويق'],
  ['Asir', 'عسير'], ['Qassim', 'القصيم'], ['Dhahran', 'الظهران'], ['Yanbu', 'ينبع'], ['Tabuk', 'تبوك'], ['Hail', 'حائل'], ['Jubail', 'الجبيل'], ['Madinah', 'المدينة']];
export const TRADES: Record<string, Pair[]> = {
  buyer: [['Contracting', 'للمقاولات'], ['Trading', 'للتجارة'], ['Industries', 'للصناعات'], ['Building Materials', 'لمواد البناء'], ['Engineering', 'للهندسة'], ['Projects', 'للمشاريع']],
  seller: [['Supplies', 'للتوريدات'], ['Wholesale', 'للجملة'], ['Distribution', 'للتوزيع'], ['Logistics', 'للخدمات اللوجستية'], ['Steel Mills', 'لمصانع الحديد'], ['Equipment', 'للمعدات']],
  hotel: [['Hospitality', 'للضيافة'], ['Travel', 'للسفر'], ['Events', 'للفعاليات'], ['Tourism', 'للسياحة']],
};

/** Distinct, believable business names. */
export function businessNames(r: () => number, n: number, kind: keyof typeof TRADES): Pair[] {
  const out: Pair[] = [];
  const seen = new Set<string>();
  while (out.length < n) {
    const p = PLACES[Math.floor(r() * PLACES.length)]!, t = TRADES[kind]![Math.floor(r() * TRADES[kind]!.length)]!;
    const en = `${p[0]} ${t[0]} Co`;
    if (seen.has(en)) continue;
    seen.add(en);
    out.push([en, `شركة ${p[1]} ${t[1]}`]);
  }
  return out;
}

/** A valid-looking but fake IBAN (bank code 00 does not exist). */
export function fakeIban(n: number): string {
  const bban = `00${String(100_000_000_000_000_000 + n * 7919).slice(0, 18)}`;   // 2 + 18 = 20 digits; with SA and the check: 24 characters
  const digits = (bban + '281000').split('').reduce((acc, ch) => (acc * 10 + Number(ch)) % 97, 0); // S=28, A=10, 00
  const check = String(98 - digits).padStart(2, '0');
  return `SA${check}${bban}`;
}
export const fakeVat = (n: number) => `3${String(100000 + n).padStart(13, '0')}3`;
export const fakePhone = (r: () => number) => `05${Math.floor(r() * 10)} 000 ${String(Math.floor(r() * 10000)).padStart(4, '0')}`;

export interface Ctx {
  client: pg.Client; db: Db; id: string; key: string; name: string; vatRate: string; firmId: string;
  acct: Record<string, string>; cc: Record<string, string>;
  poster: string; partner: string; userIds: Record<string, string>;
  asUser: (u: string) => Promise<unknown>;
  r: () => number;
  int: (a: number, b: number) => number;
  pick: <T>(a: readonly T[]) => T;
  /** A believable amount between a and b with cents. */
  money: (a: number, b: number) => string;
  L: (code: string, debit?: string | number, credit?: string | number, centre?: string) => LineInput;
  post: (date: string, memo: string, lines: LineInput[]) => Promise<string>;
  SL: (description: string, quantity: string, unitPrice: string, centre?: string | null, code?: string) => { description: string; quantity: string; unitPrice: string; accountId: string | undefined; costCentreId: string | null; vatCode: 'standard' };
  doc: (type: DocType, contactId: string, issued: number, dueIn: number | null, lines: ReturnType<Ctx['SL']>[], o?: { reference?: string; issue?: boolean }) => Promise<string>;
  due: (docId: string) => Promise<string>;
  pay: (direction: 'received' | 'made', contactId: string, ago: number, amount: string, accountCode: string, allocations: { documentId: string; amount: string }[], method?: string) => Promise<string>;
  /** Pays what is left on a document in full. */
  payFull: (direction: 'received' | 'made', contactId: string, docId: string, ago: number, accountCode?: string, method?: string) => Promise<void>;
  contact: (role: 'customer' | 'supplier', name: Pair, n: number, terms?: number) => Promise<string>;
}

export async function makeCtx(client: pg.Client, o: { id: string; key: string; name: string; vatRate: string; firmId: string; poster: string; partner: string; userIds: Record<string, string>; seed: number }): Promise<Ctx> {
  const db = client as unknown as Db;
  const acct = Object.fromEntries((await client.query('SELECT code, id FROM accounts WHERE company_id = $1', [o.id])).rows.map((x) => [x.code, x.id])) as Record<string, string>;
  const cc = Object.fromEntries((await client.query('SELECT name, id FROM cost_centres WHERE company_id = $1', [o.id])).rows.map((x) => [x.name, x.id])) as Record<string, string>;
  const r = rng(o.seed);
  const ctx: Ctx = {
    client, db, ...o, acct, cc, r,
    asUser: (u) => client.query("SELECT set_config('app.user_id', $1, true)", [u]),
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (a) => a[Math.floor(r() * a.length)]!,
    money: (a, b) => (Math.round((a + r() * (b - a)) * 100) / 100).toFixed(2),
    L: (code, debit, credit, centre) => ({ accountId: acct[code], debit: debit === undefined ? undefined : String(debit), credit: credit === undefined ? undefined : String(credit), costCentreId: centre ? cc[centre] : null }),
    post: (date, memo, lines) => postEntry(db, { companyId: o.id, entryDate: date, memo, lines }),
    SL: (description, quantity, unitPrice, centre, code = '4000') => ({ description, quantity, unitPrice, accountId: acct[code], costCentreId: centre ? cc[centre] ?? null : null, vatCode: 'standard' as const }),
    doc: async (type, contactId, issued, dueIn, lines, opts = {}) => {
      const did = await saveDraft(db, o.id, { type, contactId, issueDate: daysAgo(issued), dueDate: dueIn === null ? null : daysAgo(issued - dueIn), reference: opts.reference, lines });
      if (opts.issue !== false) await issueDocument(db, did);
      return did;
    },
    due: async (docId) => (await client.query('SELECT document_amount_due($1)::text AS d', [docId])).rows[0].d as string,
    pay: (direction, contactId, ago, amount, accountCode, allocations, method = 'bank_transfer') =>
      recordPayment(db, o.id, { direction, contactId, date: daysAgo(ago), amount, accountId: acct[accountCode], method, allocations }),
    payFull: async (direction, contactId, docId, ago, accountCode = '1000', method = 'bank_transfer') => {
      const amount = await ctx.due(docId);
      await ctx.pay(direction, contactId, ago, amount, accountCode, [{ documentId: docId, amount }], method);
    },
    contact: (role, name, n, terms = 30) => saveContact(db, o.id, {
      isCustomer: role === 'customer', isSupplier: role === 'supplier', name: name[0], nameAr: name[1],
      email: `accounts${n}@${name[0].toLowerCase().replace(/[^a-z]+/g, '')}.example.com`, country: 'SA', vatNumber: fakeVat(n), paymentTermsDays: terms, city: 'Riyadh',
      address: 'Demo address', buildingNumber: String(1000 + n), district: 'Al Olaya', postalCode: '12211',
    }),
  };
  return ctx;
}

/** Gross amount for a net amount at the company's VAT rate. */
export function gross(net: string, rate: string): string {
  const m = toMinor(net);
  return fromMinor(m + vatForLine(m, rate));
}
