// HR and payroll rules for Saudi Arabia and the UAE, as pure functions shared by the API and the demo build.
// Money is in minor units (bigint); rates are in basis points (1/100 of a percent). Days are whole days or
// hundredths of a day. The rates below must be confirmed with GOSI / GPSSA before going live (docs/DECISIONS.md).
import { divRoundHalfUp, type Minor } from '../money.js';

export type Country = 'SA' | 'AE' | 'OM';
export interface PayStructure { basic: Minor; housing: Minor; transport: Minor; other: Minor }
export const monthlyWage = (p: PayStructure): Minor => p.basic + p.housing + p.transport + p.other;
const pct = (amount: Minor, bp: number): Minor => divRoundHalfUp(amount * BigInt(bp), 10000n);
const min = (a: Minor, b: Minor) => (a < b ? a : b);

// ------------------------------------------------------------------ dates
/** Whole days from a to b, counting both (2026-01-01..2026-01-01 = 1). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000) + 1;
}
export const daysInMonth = (periodEnd: string) => +periodEnd.slice(8, 10);
/** Days of the month (ending periodEnd) that overlap from..to, both inclusive; to may be null (open). */
export function overlapDays(periodEnd: string, from: string, to: string | null): number {
  const start = `${periodEnd.slice(0, 7)}-01`;
  const a = from > start ? from : start;
  const b = to && to < periodEnd ? to : periodEnd;
  return a > b ? 0 : daysBetween(a, b);
}

// ------------------------------------------------------------------ service in calendar years
const ymd = (d: string) => [+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)] as const;
const dayNo = (d: string) => { const [y, m, dd] = ymd(d); return Date.UTC(y, m - 1, dd) / 86400000; };
const iso = (t: number) => new Date(t * 86400000).toISOString().slice(0, 10);
/** The date k months after the join date, on the same day of the month or the month's last day when it has fewer
 *  (a join date of 29 February has its anniversary on 28 February in other years). Always counted from the join date. */
export function monthsAfter(join: string, k: number): string {
  const [y, m, d] = ymd(join);
  const t = m - 1 + k, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return iso(Date.UTC(ny, nm, Math.min(d, last)) / 86400000);
}
/** Service from the join date to the end date: whole calendar months since the join date, then the days since the
 *  last monthly anniversary over the days of that month. Years = (months + days / monthDays) / 12, exactly. */
export interface Service { months: number; days: number; monthDays: number }
export function serviceBetween(join: string, end: string): Service {
  if (end <= join) return { months: 0, days: 0, monthDays: 1 };
  const [jy, jm] = ymd(join), [ey, em] = ymd(end);
  let months = (ey - jy) * 12 + (em - jm);
  while (months > 0 && monthsAfter(join, months) > end) months--;
  const anchor = monthsAfter(join, months), next = monthsAfter(join, months + 1);
  return { months, days: dayNo(end) - dayNo(anchor), monthDays: dayNo(next) - dayNo(anchor) };
}
/** Service as an exact fraction of years: num / den. */
const yearsFraction = (sv: Service) => ({ num: BigInt(sv.months * sv.monthDays + sv.days), den: BigInt(12 * sv.monthDays) });
/** Whole years completed (a person is "2 years" from the second anniversary of the join date). */
export const wholeYears = (sv: Service) => Math.floor(sv.months / 12);
const nextDay = (d: string) => iso(dayNo(d) + 1);

// ------------------------------------------------------------------ social insurance
export type Scheme = 'gosi' | 'gpssa' | 'none';
export interface InsuranceInput { country: Country; national: boolean; registeredOn: string | null; pay: PayStructure; asOf: string }
export interface Insurance { scheme: Scheme; base: Minor; employeeRate: number; employerRate: number; employee: Minor; employer: Minor }

/** First date of the new GOSI annuity system (Social Insurance Law 2024): Saudis registered from then pay the rising rate. */
export const GOSI_NEW_SYSTEM = '2024-07-03';
export const GOSI_CAP = 4500000n;        // SAR 45,000 a month
export const GPSSA_CAP = 7000000n;       // AED 70,000 a month

/** GOSI annuity (pension) rate for each side, in basis points: 9% for the old system; the new system rises 0.5% each July to 11%. */
export function gosiAnnuityRate(registeredOn: string | null, asOf: string): number {
  if (!registeredOn || registeredOn < GOSI_NEW_SYSTEM) return 900;
  const steps: [string, number][] = [['2028-07-01', 1100], ['2027-07-01', 1050], ['2026-07-01', 1000], ['2025-07-01', 950]];
  return steps.find(([from]) => asOf >= from)?.[1] ?? 900;
}

/**
 * Saudi Arabia (GOSI): Saudis pay annuity + 0.75% SANED; the employer pays the same plus 2% occupational hazards.
 * Non-Saudis: the employer pays 2% hazards only. Base: basic + housing, capped at SAR 45,000.
 * UAE (GPSSA): UAE nationals pay 11%, the employer 12.5%, on the full contract salary capped at AED 70,000.
 * Other nationalities in the UAE have no contribution (end of service gratuity instead). Oman (PASI) comes later.
 */
export function socialInsurance(i: InsuranceInput): Insurance {
  if (i.country === 'SA') {
    const base = min(i.pay.basic + i.pay.housing, GOSI_CAP);
    if (!i.national) return { scheme: 'gosi', base, employeeRate: 0, employerRate: 200, employee: 0n, employer: pct(base, 200) };
    const a = gosiAnnuityRate(i.registeredOn, i.asOf);
    const er = a + 75, rr = a + 75 + 200;
    return { scheme: 'gosi', base, employeeRate: er, employerRate: rr, employee: pct(base, er), employer: pct(base, rr) };
  }
  if (i.country === 'AE' && i.national) {
    const base = min(monthlyWage(i.pay), GPSSA_CAP);
    return { scheme: 'gpssa', base, employeeRate: 1100, employerRate: 1250, employee: pct(base, 1100), employer: pct(base, 1250) };
  }
  return { scheme: 'none', base: 0n, employeeRate: 0, employerRate: 0, employee: 0n, employer: 0n };
}

// ------------------------------------------------------------------ overtime, absence, sick leave
/** Hours as hundredths ("2.5" -> 250). */
export function hoursToHundredths(h: string | number): number {
  const s = String(h ?? '').trim();
  if (!s) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Hours are a number with at most 2 decimals.');
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/**
 * Overtime pay for the hours (in hundredths), on a 30-day, 8-hour month (240 hours):
 * Saudi Arabia (Labour Law art. 107): the hourly wage plus 50% of the hourly basic wage.
 * UAE (Decree-Law 33/2021 art. 19): the hourly basic wage plus 25%.
 */
export function overtimePay(country: Country, pay: PayStructure, hundredths: number): Minor {
  if (hundredths <= 0) return 0n;
  const h = BigInt(hundredths);
  if (country === 'SA') return divRoundHalfUp(h * (2n * monthlyWage(pay) + pay.basic), 240n * 2n * 100n);
  return divRoundHalfUp(h * pay.basic * 5n, 240n * 4n * 100n);
}

/** A monthly amount less days off on a 30-day month: amount x (30 - days) / 30. */
export const lessDays = (amount: Minor, days: number): Minor =>
  days >= 30 ? 0n : days <= 0 ? amount : amount - divRoundHalfUp(amount * BigInt(days), 30n);

/**
 * Sick leave: how much of each sick day is unpaid, in hundredths of a day, given the sick days already taken in the
 * past 12 months. Saudi Arabia (art. 117): 30 days full pay, 60 days at 75%, 30 unpaid. UAE (art. 31): 15 days
 * full pay, 30 at half pay, 45 unpaid. Days beyond that are unpaid.
 */
export function sickUnpaidHundredths(country: Country, priorDays: number, days: number): number {
  const tiers: [number, number][] = country === 'SA' ? [[30, 0], [90, 25], [120, 100]] : [[15, 0], [45, 50], [90, 100]];
  let out = 0;
  for (let d = priorDays + 1; d <= priorDays + days; d++) out += tiers.find(([upTo]) => d <= upTo)?.[1] ?? 100;
  return out;
}

// ------------------------------------------------------------------ annual leave
/** Annual leave a year: Saudi Arabia 21 days, 30 once 5 years of service are completed (art. 109); UAE 30 days
 *  (art. 29). Years are calendar years of service through the end of asOf. */
export const annualLeaveDays = (country: Country, joinDate: string, asOf: string) =>
  (country === 'SA' ? (wholeYears(serviceBetween(joinDate, nextDay(asOf))) >= 5 ? 30 : 21) : 30);

/** Leave earned from the join date through the end of asOf, in hundredths of a day: the yearly entitlement times the
 *  service in calendar years (SA moves to 30 a year after the 5th anniversary). Exact, rounded once at the end. */
export function leaveEarnedHundredths(country: Country, joinDate: string, asOf: string, perYear?: number | null): number {
  if (asOf < joinDate) return 0;
  const { num, den } = yearsFraction(serviceBetween(joinDate, nextDay(asOf)));
  if (perYear) return Number(divRoundHalfUp(num * BigInt(perYear) * 100n, den));
  if (country === 'SA') {
    const five = 5n * den, first = num < five ? num : five, after = num > five ? num - five : 0n;
    return Number(divRoundHalfUp((first * 21n + after * 30n) * 100n, den));
  }
  return Number(divRoundHalfUp(num * 30n * 100n, den));
}

/** Pay for a number of leave days (hundredths): Saudi Arabia on the full wage, UAE on the basic wage, a day = 1/30 of a month. */
export const leaveDaysPay = (country: Country, pay: PayStructure, hundredths: number): Minor =>
  hundredths <= 0 ? 0n : divRoundHalfUp((country === 'SA' ? monthlyWage(pay) : pay.basic) * BigInt(hundredths), 3000n);

// ------------------------------------------------------------------ end of service
export type LeavingReason = 'resignation' | 'termination' | 'contract_end' | 'retirement' | 'death' | 'other';
export const LEAVING_REASONS: LeavingReason[] = ['resignation', 'termination', 'contract_end', 'retirement', 'death', 'other'];
export interface EosInput { country: Country; joinDate: string; endDate: string; pay: PayStructure; reason: LeavingReason }
export interface Eos { serviceDays: number; service: { years: number; months: number; days: number }; basis: Minor; full: Minor; share: '1' | '2/3' | '1/3' | '0'; amount: Minor }

/**
 * End of service benefit.
 * Saudi Arabia (art. 84): half a month's wage (basic + allowances) for each of the first 5 years, a full month for each
 * year after; parts of a year count pro rata. On resignation (art. 85): nothing under 2 years, a third from 2 to 5
 * years, two thirds from 5 to 10 years, all of it from 10 years.
 * UAE (art. 51): 21 days' basic wage for each of the first 5 years and 30 days for each year after, a day being 1/30
 * of the monthly basic wage; nothing under 1 year of service; at most 2 years' basic wage.
 * With accrual, the amount owed as if the person left today for a reason giving the full benefit, from day one:
 * this is what the end of service provision holds.
 * Service is measured in calendar years, months and days from the join date to the end date (serviceBetween), so a
 * leap day adds nothing; the thresholds use completed years (2 years from the second anniversary). The amount is
 * worked out exactly and rounded once, half away from zero.
 */
export function endOfService(i: EosInput, accrual = false): Eos {
  const d = Math.max(daysBetween(i.joinDate, i.endDate), 0);
  const sv = serviceBetween(i.joinDate, i.endDate);
  const service = { years: wholeYears(sv), months: sv.months % 12, days: sv.days };
  const { num, den } = yearsFraction(sv);
  const five = 5n * den, first = num < five ? num : five, after = num > five ? num - five : 0n;
  const years = service.years;
  if (i.country === 'SA') {
    const basis = monthlyWage(i.pay);
    // Half a month for each of the first 5 years, a month for each year after: basis x (first / 2 + after) / den.
    const exact = basis * (first + 2n * after), per = 2n * den;
    const full = divRoundHalfUp(exact, per);
    let share: Eos['share'] = '1';
    if (!accrual && i.reason === 'resignation') share = years < 2 ? '0' : years < 5 ? '1/3' : years < 10 ? '2/3' : '1';
    const amount = share === '1' ? full : share === '0' ? 0n : divRoundHalfUp(exact * (share === '2/3' ? 2n : 1n), per * 3n);
    return { serviceDays: d, service, basis, full, share, amount };
  }
  if (i.country === 'AE') {
    const basis = i.pay.basic;
    // 21 days (of 30) of basic for each of the first 5 years, 30 days for each year after; at most 24 months of basic.
    const full = min(divRoundHalfUp(basis * (21n * first + 30n * after), 30n * den), basis * 24n);
    const share: Eos['share'] = !accrual && years < 1 ? '0' : '1';
    return { serviceDays: d, service, basis, full, share, amount: share === '1' ? full : 0n };
  }
  return { serviceDays: d, service, basis: 0n, full: 0n, share: '0', amount: 0n };   // Oman: comes with PASI
}

// ------------------------------------------------------------------ one employee's month
export interface PayLineInput {
  country: Country; national: boolean; registeredOn: string | null; pay: PayStructure; periodEnd: string;
  joinDate: string; endDate: string | null;
  unpaidLeaveDays: number; absentDays: number; sickUnpaidHundredths: number; overtimeHundredths: number;
  bonus: Minor; otherDeductions: Minor; loanDeduction: Minor;
}
export interface PayLine {
  daysOff: number; basic: Minor; housing: Minor; transport: Minor; other: Minor; overtime: Minor; bonus: Minor; gross: Minor;
  absence: Minor; sick: Minor; insuranceEmployee: Minor; insuranceEmployer: Minor; loan: Minor; otherDeductions: Minor; net: Minor;
}

/**
 * A month's pay on a 30-day month: each part of the wage less the days not employed, unpaid leave and absence;
 * sick days part paid by the tiers above; plus overtime and any bonus; less social insurance, loan repayment and
 * other deductions. Social insurance is on the contract base for the days employed.
 */
export function payLine(i: PayLineInput): PayLine {
  const dim = daysInMonth(i.periodEnd);
  const employed = overlapDays(i.periodEnd, i.joinDate, i.endDate);
  const notEmployed = employed === dim ? 0 : Math.min(30, Math.max(0, 30 - employed));
  const off = Math.min(30, notEmployed);
  const basic = lessDays(i.pay.basic, off), housing = lessDays(i.pay.housing, off), transport = lessDays(i.pay.transport, off), other = lessDays(i.pay.other, off);
  const earned: PayStructure = { basic, housing, transport, other };
  const wage = monthlyWage(i.pay);
  const absenceDays = Math.min(30 - off, i.unpaidLeaveDays + i.absentDays);
  const absence = min(divRoundHalfUp(wage * BigInt(absenceDays), 30n), monthlyWage(earned));
  const sick = min(divRoundHalfUp(wage * BigInt(i.sickUnpaidHundredths), 3000n), monthlyWage(earned) - absence);
  const overtime = overtimePay(i.country, i.pay, i.overtimeHundredths);
  const gross = monthlyWage(earned) + overtime + i.bonus;
  const ins = socialInsurance({ country: i.country, national: i.national, registeredOn: i.registeredOn, pay: earned, asOf: i.periodEnd });
  const net = gross - absence - sick - ins.employee - i.loanDeduction - i.otherDeductions;
  return { daysOff: off + absenceDays, basic, housing, transport, other, overtime, bonus: i.bonus, gross, absence, sick,
    insuranceEmployee: ins.employee, insuranceEmployer: ins.employer, loan: i.loanDeduction, otherDeductions: i.otherDeductions, net };
}

// ------------------------------------------------------------------ salary transfer files (WPS)
export interface WpsRow { personId: string; routing: string; iban: string; name: string; employeeNo: string; idNumber: string;
  fixed: Minor; variable: Minor; deductions: Minor; net: Minor; leaveDays: number; basic: Minor; housing: Minor; otherAllowances: Minor }
const amt = (v: Minor) => { const s = (v < 0n ? -v : v).toString().padStart(3, '0'); return `${v < 0n ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`; };

/**
 * UAE Wage Protection System salary information file (SIF): one EDR line per employee and one SCR line.
 * EDR: person ID, agent routing code, IBAN, pay start, pay end, days, fixed income, variable income, leave days.
 * SCR: employer ID, employer bank routing code, file date, time, salary month (MMYYYY), EDR count, total, AED, reference.
 * Check the layout with the client's bank or exchange house before the first upload.
 */
export function uaeSif(o: { employerId: string; routing: string; periodEnd: string; createdAt: Date; rows: WpsRow[]; reference?: string }): string {
  const start = `${o.periodEnd.slice(0, 7)}-01`;
  const days = daysInMonth(o.periodEnd);
  const edr = o.rows.map((r) => ['EDR', r.personId, r.routing, r.iban, start, o.periodEnd, days, amt(r.fixed), amt(r.variable), r.leaveDays].join(','));
  const total = o.rows.reduce((s, r) => s + r.fixed + r.variable, 0n);
  const d = o.createdAt.toISOString();
  const scr = ['SCR', o.employerId, o.routing, d.slice(0, 10), d.slice(11, 13) + d.slice(14, 16), o.periodEnd.slice(5, 7) + o.periodEnd.slice(0, 4),
    o.rows.length, amt(total), 'AED', o.reference ?? ''].join(',');
  return [...edr, scr].join('\r\n') + '\r\n';
}

/** Saudi payroll file for Mudad or the bank: one line per employee (check the layout with Mudad or the bank). */
export function saudiPayrollCsv(rows: WpsRow[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['Employee number', 'Name', 'National ID or Iqama', 'IBAN', 'Basic salary', 'Housing allowance', 'Other allowances', 'Deductions', 'Net salary'];
  return [head.join(','), ...rows.map((r) => [q(r.employeeNo), q(r.name), q(r.idNumber), q(r.iban), amt(r.basic), amt(r.housing), amt(r.otherAllowances), amt(r.deductions), amt(r.net)].join(','))]
    .join('\r\n') + '\r\n';
}
