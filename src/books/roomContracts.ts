// Rooms contract types (db/migrations/0095), as pure functions shared by the API, the screens and the demo build.
// Type A "short_stay": a hotel, serviced apartment or guest house stay, with a guest identity check (details only,
// never a copy of an ID). Type B "long_term": a monthly or yearly rental with the Ejar registration and renewal rules.
// Nothing here talks to a government system. Money is in minor units or exact decimal text.
import { divRoundHalfUp, fromMinor, toMinor } from '../money.js';
import { addDays, nights } from './rooms.js';

export type ContractType = 'short_stay' | 'long_term';
export const CONTRACT_TYPES: ContractType[] = ['short_stay', 'long_term'];
export type IdType = 'national_id' | 'iqama' | 'passport' | 'moi_digital';
export const ID_TYPES: IdType[] = ['national_id', 'iqama', 'passport', 'moi_digital'];
export type EjarStatus = 'not_registered' | 'pending' | 'registered';
export const EJAR_STATUSES: EjarStatus[] = ['not_registered', 'pending', 'registered'];
export type RentPeriod = 'monthly' | 'yearly';

/** The alerts before a long-term contract ends. */
export const RENEWAL_ALERT_DAYS = [90, 60] as const;
/** A non-renewal notice must be recorded at least this many days before the end date. */
export const NOTICE_DAYS = 60;
/** The cities where rent increases are blocked, until the administrator changes the list (a setting, not law in code). */
export const DEFAULT_FROZEN_CITIES = ['Riyadh'];

export const EJAR_WARNING = 'Rental contracts must be registered in Ejar.';

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ShortStayInput {
  idType?: string | null; idNumber?: string | null; nationality?: string | null; checkIn?: string | null; checkOut?: string | null;
  guests?: number | null; verifiedBy?: string | null; verifiedAt?: string | null;
}
/** The fields a short stay needs before it can be saved, by name (the screen shows each one). Empty = complete. */
export function missingShortStay(x: ShortStayInput): string[] {
  const out: string[] = [];
  if (!ID_TYPES.includes(x.idType as IdType)) out.push('idType');
  if (blank(x.idNumber)) out.push('idNumber');
  if (blank(x.nationality)) out.push('nationality');
  if (!DATE.test(String(x.checkIn ?? ''))) out.push('checkIn');
  if (!DATE.test(String(x.checkOut ?? ''))) out.push('checkOut');
  if (!Number.isInteger(x.guests) || (x.guests as number) < 1) out.push('guests');
  if (blank(x.verifiedBy)) out.push('verifiedBy');
  if (blank(x.verifiedAt)) out.push('verifiedAt');
  return out;
}

export interface LongTermInput {
  landlordName?: string | null; landlordIdType?: string | null; landlordIdNumber?: string | null;
  tenantName?: string | null; tenantIdType?: string | null; tenantIdNumber?: string | null;
  property?: string | null; unit?: string | null; city?: string | null; startDate?: string | null; endDate?: string | null;
  rent?: string | null; rentPeriod?: string | null; deposit?: string | null; vatCode?: string | null;
  ejarStatus?: string | null; ejarNumber?: string | null;
}
/** The fields a long-term rental needs before it can be saved. A registered contract needs its Ejar number. */
export function missingLongTerm(x: LongTermInput): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries({ landlordName: x.landlordName, landlordIdNumber: x.landlordIdNumber, tenantName: x.tenantName,
    tenantIdNumber: x.tenantIdNumber, property: x.property, unit: x.unit, city: x.city })) if (blank(v)) out.push(k);
  if (!ID_TYPES.includes(x.landlordIdType as IdType)) out.push('landlordIdType');
  if (!ID_TYPES.includes(x.tenantIdType as IdType)) out.push('tenantIdType');
  if (!DATE.test(String(x.startDate ?? ''))) out.push('startDate');
  if (!DATE.test(String(x.endDate ?? '')) || (DATE.test(String(x.startDate ?? '')) && String(x.endDate) <= String(x.startDate))) out.push('endDate');
  if (blank(x.rent) || !(Number(x.rent) > 0)) out.push('rent');
  if (!['monthly', 'yearly'].includes(String(x.rentPeriod))) out.push('rentPeriod');
  if (blank(x.deposit) || !(Number(x.deposit) >= 0)) out.push('deposit');
  if (!['standard', 'zero', 'exempt', 'out_of_scope'].includes(String(x.vatCode))) out.push('vatCode');
  if (!EJAR_STATUSES.includes(x.ejarStatus as EjarStatus)) out.push('ejarStatus');
  else if (x.ejarStatus === 'registered' && blank(x.ejarNumber)) out.push('ejarNumber');
  return out;
}

/** The warning to show on a long-term contract, or null when it is registered. */
export const ejarWarning = (status: string | null | undefined): string | null => (status === 'registered' ? null : EJAR_WARNING);

/** Whole days from `today` to `end` (negative once the contract has ended). */
export const daysLeft = (today: string, end: string): number => nights(today, end) - nights(end, today);

/** The renewal alert for a contract today: 60 once 60 days or fewer are left, else 90 once 90 or fewer, else null.
 *  A contract that has ended has no alert (it is expired). */
export function renewalAlert(today: string, end: string): 90 | 60 | null {
  const left = daysLeft(today, end);
  if (left < 0) return null;
  if (left <= 60) return 60;
  if (left <= 90) return 90;
  return null;
}

/** Renewal is automatic unless a non-renewal notice was recorded at least 60 days before the end date.
 *  The notice must name the date it was given and who gave it. */
export function renewsAutomatically(end: string, notice: { date?: string | null; by?: string | null } | null | undefined): boolean {
  if (!notice || blank(notice.date) || blank(notice.by)) return true;
  return daysLeft(String(notice.date), end) < NOTICE_DAYS;
}
/** Why a notice cannot be recorded (too late or incomplete), or null when it counts. */
export function noticeProblem(end: string, notice: { date?: string | null; by?: string | null }): 'incomplete' | 'late' | null {
  if (blank(notice.date) || blank(notice.by) || !DATE.test(String(notice.date))) return 'incomplete';
  return daysLeft(String(notice.date), end) < NOTICE_DAYS ? 'late' : null;
}

const norm = (s: string) => s.trim().toLowerCase();
/** Whether a city is on the rent-freeze list (the administrator edits the list). */
export const isFrozen = (city: string | null | undefined, frozenCities: string[]): boolean =>
  !blank(city) && frozenCities.some((c) => norm(c) === norm(String(city)));

/** A rent increase is blocked in a frozen city: the new rent may not be above the last registered rent.
 *  Returns null when allowed, else the reason (the screen shows it). */
export function rentIncreaseBlock(o: { city?: string | null; frozenCities: string[]; lastRegisteredRent?: string | null; newRent: string }): string | null {
  if (!isFrozen(o.city, o.frozenCities) || blank(o.lastRegisteredRent)) return null;
  if (toMinor(o.newRent) <= toMinor(String(o.lastRegisteredRent))) return null;
  return `Rent increases are blocked in ${String(o.city).trim()}: the rent cannot go above the last registered rent of ${fromMinor(toMinor(String(o.lastRegisteredRent)))}.`;
}

/** The maximum stay setting: null/0 means off. */
export const stayTooLong = (arrival: string, departure: string, maxDays: number | null | undefined): boolean =>
  !!maxDays && maxDays > 0 && nights(arrival, departure) > maxDays;

/** An optional extra charge (for example a municipal or tourism charge): rate is a percent with up to 3 decimals, taken on the
 *  price before VAT, rounded half up to the halala. No rate is built in; the administrator enters it. */
export function chargeAmount(netMinor: bigint, ratePercent: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(ratePercent.trim());
  if (!m) throw new Error(`Not a valid rate: "${ratePercent}"`);
  const thousandths = BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
  return divRoundHalfUp(netMinor * thousandths, 100_000n);
}

export interface Instalment { no: number; due: string; amount: string }
/** The payment schedule: one rent per month (or per year) from the start date to the day before the end date, each due on the
 *  same day of the month as the start (the last day of a shorter month). Months are whole: a part month is not charged here. */
export function instalments(start: string, end: string, rent: string, period: RentPeriod): Instalment[] {
  const step = period === 'monthly' ? 1 : 12;
  const [y, m, d] = [+start.slice(0, 4), +start.slice(5, 7), +start.slice(8, 10)];
  const out: Instalment[] = [];
  for (let i = 0; ; i++) {
    const total = (m - 1) + i * step;
    const yy = y + Math.floor(total / 12), mm = (total % 12) + 1;
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const due = `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    if (due >= end) break;
    out.push({ no: i + 1, due, amount: fromMinor(toMinor(rent)) });
    if (i > 600) break;
  }
  return out;
}

/** The booking number prefix and the receipt lines a guest sees for the price: the room price includes tax, with the tax shown
 *  as its own line, then each active charge line. All amounts are exact decimal text. */
export interface PriceLine { label: string; amount: string }
export function guestPriceLines(o: { totalWithVat: string; vatRate: string; charges: { name: string; ratePercent: string }[] }): { lines: PriceLine[]; total: string } {
  const gross = toMinor(o.totalWithVat);
  const bp = BigInt(Math.round(Number(o.vatRate) * 100));
  const net = divRoundHalfUp(gross * 10_000n, 10_000n + bp);
  const vat = gross - net;
  const lines: PriceLine[] = [{ label: 'Room price before tax', amount: fromMinor(net) }, { label: `Tax (${o.vatRate}%)`, amount: fromMinor(vat) }];
  let total = gross;
  for (const c of o.charges) { const a = chargeAmount(net, c.ratePercent); lines.push({ label: c.name, amount: fromMinor(a) }); total += a; }
  return { lines, total: fromMinor(total) };
}

export { addDays };
