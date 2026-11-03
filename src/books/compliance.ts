// Compliance calendar rules: the deadlines a client has, worked out from its country and settings. Pure functions,
// shared by the API, the web app and the demo build. Nothing is stored for a worked-out deadline except whether it
// was done (by its key), so changing a setting moves the dates at once.
//
// The rules below follow the published guidance as we understand it; confirm each with the authority before a
// client relies on it (docs/DECISIONS.md): ZATCA (VAT, zakat), FTA (VAT, corporate tax), GOSI, GPSSA, MOHRE (WPS).

export type Country = 'SA' | 'AE' | 'OM';
export type DeadlineKind = 'vat_return' | 'social_insurance' | 'wps' | 'zakat' | 'corporate_tax' | 'cr_renewal' | 'document_expiry' | 'custom';
export const DEADLINE_KINDS: DeadlineKind[] = ['vat_return', 'social_insurance', 'wps', 'zakat', 'corporate_tax', 'cr_renewal', 'document_expiry', 'custom'];
export type Repeat = 'none' | 'monthly' | 'quarterly' | 'yearly';
export const REPEATS: Repeat[] = ['none', 'monthly', 'quarterly', 'yearly'];
export type Status = 'done' | 'overdue' | 'soon' | 'later';

export interface ComplianceCompany {
  country: Country; vatStatus: string; vatRegistrationDate: string | null;
  fyEndMonth: number; fyEndDay: number; crExpiry: string | null; modules: string[];
}
export interface ComplianceSettings {
  vatFrequency: 'monthly' | 'quarterly';
  /** Quarterly VAT: the month (1, 2 or 3) the first quarter of a calendar year ends in; quarters end every 3 months from it. */
  vatQuarterEndMonth: number;
  zakat: boolean; corporateTax: boolean;
  /** Payroll deadlines (salaries through WPS in the UAE) and social insurance (GOSI, GPSSA); only while HRM is on. */
  payroll: boolean; socialInsurance: boolean;
}
export interface Deadline {
  key: string; kind: DeadlineKind; due: string;
  periodStart?: string; periodEnd?: string;
  /** The HR document or custom deadline it comes from. */
  ref?: string; docKind?: string; label?: string;
}
export interface DocumentInput { id: string; kind: string; label: string; expiry: string }
export interface CustomInput { id: string; title: string; firstDue: string; repeat: Repeat }

/** Days before the due date a deadline counts as "due soon". */
export const SOON_DAYS = 14;

// ------------------------------------------------------------------ dates (ISO yyyy-mm-dd, UTC)
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parts = (s: string) => s.split('-').map(Number) as [number, number, number];
/** The last day of month m (1-12, may run past 12 or below 1) of year y. */
const endOf = (y: number, m: number) => iso(new Date(Date.UTC(y, m, 0)));
/** Day `day` of month m of year y, or that month's last day when it is shorter. */
const dayIn = (y: number, m: number, day: number) => { const [ey, em, last] = parts(endOf(y, m)); return iso(new Date(Date.UTC(ey, em - 1, Math.min(day, last)))); };
export const addDays = (s: string, n: number) => { const [y, m, d] = parts(s); return iso(new Date(Date.UTC(y, m - 1, d + n))); };
const daysBetween = (a: string, b: string) => Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86_400_000);
const ymd = (s: string): [number, number, number] => { const [y, m, d] = parts(s); return [y, m - 1, d]; };
const max = (a: string, b: string) => (a > b ? a : b);

// ------------------------------------------------------------------ settings
export function defaultSettings(co: Pick<ComplianceCompany, 'country' | 'modules'>): ComplianceSettings {
  return { vatFrequency: 'quarterly', vatQuarterEndMonth: 3, zakat: co.country === 'SA', corporateTax: co.country === 'AE', payroll: true, socialInsurance: true };
}

// ------------------------------------------------------------------ VAT
/** VAT periods whose last day falls between from and to; the first starts no earlier than the registration date. */
export function vatPeriods(s: ComplianceSettings, from: string, to: string, registeredOn: string | null): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  const len = s.vatFrequency === 'monthly' ? 1 : 3;
  const anchor = s.vatFrequency === 'monthly' ? 1 : Math.min(3, Math.max(1, s.vatQuarterEndMonth));
  let [y, m] = parts(from);
  // Walk month ends from `from` to `to`; keep those that close a period.
  for (;;) {
    const end = endOf(y, m);
    if (end > to) break;
    if (end >= from && ((m - anchor) % len + len) % len === 0) {
      const first = endOf(y, m - len + 1).slice(0, 8) + '01';
      if (!registeredOn || end >= registeredOn) out.push({ start: registeredOn ? max(first, registeredOn) : first, end });
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
/** When the return for a VAT period is due (filing and payment). */
export function vatDue(country: Country, periodEnd: string): string {
  const [y, m] = parts(periodEnd);
  if (country === 'AE') return dayIn(y, m + 1, 28);       // FTA: 28 days after the end of the tax period
  if (country === 'OM') return addDays(periodEnd, 30);    // Oman Tax Authority: within 30 days of the period end
  return endOf(y, m + 1);                                 // ZATCA: the last day of the month after the period
}

// ------------------------------------------------------------------ the list
/** Every deadline due between from and to (inclusive), sorted by due date. */
export function deadlinesBetween(co: ComplianceCompany, s: ComplianceSettings, from: string, to: string,
  extra: { documents?: DocumentInput[]; custom?: CustomInput[] } = {}): Deadline[] {
  const out: Deadline[] = [];
  const [fy, fm] = parts(from);
  const before = endOf(fy, fm - 3).slice(0, 8) + '01';   // periods ending up to 3 months before `from` can fall due inside it
  const inside = (d: string) => d >= from && d <= to;

  if (co.vatStatus === 'registered') {
    for (const p of vatPeriods(s, before, to, co.vatRegistrationDate)) {
      const due = vatDue(co.country, p.end);
      if (inside(due)) out.push({ key: `vat:${p.end}`, kind: 'vat_return', due, periodStart: p.start, periodEnd: p.end });
    }
  }
  // Monthly payroll deadlines for each month that has ended, for clients that run payroll here (HRM).
  if (co.modules.includes('HRM') && (s.payroll || s.socialInsurance)) {
    let [y, m] = parts(before);
    for (;;) {
      const end = endOf(y, m);
      if (end > to) break;
      const start = `${end.slice(0, 8)}01`;
      if (s.socialInsurance && co.country !== 'OM') {
        const due = dayIn(y, m + 1, co.country === 'AE' ? 10 : 15);   // GPSSA by the 10th; GOSI by the 15th
        if (inside(due)) out.push({ key: `si:${end}`, kind: 'social_insurance', due, periodStart: start, periodEnd: end });
      }
      if (s.payroll && co.country === 'AE') {
        const due = dayIn(y, m + 1, 15);                                // WPS: salaries paid within 15 days of the due date
        if (inside(due)) out.push({ key: `wps:${end}`, kind: 'wps', due, periodStart: start, periodEnd: end });
      }
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }
  // Yearly returns after each financial year end.
  const [ty] = parts(to);
  for (let y = fy - 2; y <= ty; y++) {
    const fyEnd = dayIn(y, co.fyEndMonth, co.fyEndDay);
    if (s.zakat && co.country === 'SA') {
      const due = addDays(fyEnd, 120);                                  // zakat and income tax: 120 days after the year end
      if (inside(due)) out.push({ key: `zakat:${fyEnd}`, kind: 'zakat', due, periodEnd: fyEnd });
    }
    if (s.corporateTax && co.country === 'AE') {
      const [ey, em] = parts(fyEnd);
      const due = endOf(ey, em + 9);                                    // corporate tax: 9 months after the end of the tax period
      if (inside(due)) out.push({ key: `ct:${fyEnd}`, kind: 'corporate_tax', due, periodEnd: fyEnd });
    }
  }
  if (co.crExpiry && inside(co.crExpiry)) out.push({ key: `cr:${co.crExpiry}`, kind: 'cr_renewal', due: co.crExpiry });
  for (const d of extra.documents ?? []) {
    if (inside(d.expiry)) out.push({ key: `doc:${d.id}:${d.expiry}`, kind: 'document_expiry', due: d.expiry, ref: d.id, docKind: d.kind, label: d.label });
  }
  for (const c of extra.custom ?? []) {
    for (const due of occurrences(c.firstDue, c.repeat, from, to)) out.push({ key: `custom:${c.id}:${due}`, kind: 'custom', due, ref: c.id, label: c.title });
  }
  const order = (d: Deadline) => DEADLINE_KINDS.indexOf(d.kind);
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : order(a) - order(b) || a.key.localeCompare(b.key)));
}

/** The dates a deadline falls on between from and to: it keeps its day of the month, or the month end when shorter. */
export function occurrences(first: string, repeat: Repeat, from: string, to: string): string[] {
  if (repeat === 'none') return first >= from && first <= to ? [first] : [];
  const step = repeat === 'monthly' ? 1 : repeat === 'quarterly' ? 3 : 12;
  const [y0, m0, d0] = parts(first);
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const d = dayIn(y0, m0 + i * step, d0);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export function statusOf(due: string, done: boolean, today: string): Status {
  if (done) return 'done';
  if (due < today) return 'overdue';
  return daysBetween(today, due) <= SOON_DAYS ? 'soon' : 'later';
}

/** Checks a key belongs to this list of deadlines (a key cannot be made up to mark something else done). */
export const KEY = /^(vat|si|wps|zakat|ct|cr):\d{4}-\d{2}-\d{2}$|^(doc|custom):[0-9a-z-]{1,40}:\d{4}-\d{2}-\d{2}$/;
