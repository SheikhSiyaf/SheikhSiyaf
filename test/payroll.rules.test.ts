// HR and payroll rules for Saudi Arabia and the UAE (src/books/payroll.ts), worked by hand.
import { describe, it, expect } from 'vitest';
import * as P from '../src/books/payroll.js';
import { toMinor, fromMinor } from '../src/money.js';

const pay = (basic: string, housing = '0.00', transport = '0.00', other = '0.00'): P.PayStructure =>
  ({ basic: toMinor(basic), housing: toMinor(housing), transport: toMinor(transport), other: toMinor(other) });
const m = (v: bigint) => fromMinor(v);

describe('Social insurance', () => {
  it('Saudi on the old GOSI system: 9.75% employee, 11.75% employer, on basic + housing', () => {
    const i = P.socialInsurance({ country: 'SA', national: true, registeredOn: '2015-03-01', pay: pay('10000.00', '2500.00', '500.00'), asOf: '2026-11-30' });
    expect([m(i.base), m(i.employee), m(i.employer)]).toEqual(['12500.00', '1218.75', '1468.75']);
  });
  it('Saudi registered from July 2024: the annuity rate rises 0.5% each July', () => {
    const at = (asOf: string) => P.socialInsurance({ country: 'SA', national: true, registeredOn: '2025-01-01', pay: pay('10000.00', '2500.00'), asOf });
    expect(m(at('2026-11-30').employee)).toBe('1343.75');   // 10% + 0.75%
    expect(m(at('2026-11-30').employer)).toBe('1593.75');   // 10% + 0.75% + 2%
    expect(m(at('2026-06-30').employee)).toBe('1281.25');   // 9.5% + 0.75%
    expect(P.gosiAnnuityRate('2025-01-01', '2029-01-31')).toBe(1100);
  });
  it('non-Saudis: 2% occupational hazards paid by the employer; the base is capped at SAR 45,000', () => {
    const i = P.socialInsurance({ country: 'SA', national: false, registeredOn: null, pay: pay('10000.00', '2500.00'), asOf: '2026-11-30' });
    expect([m(i.employee), m(i.employer)]).toEqual(['0.00', '250.00']);
    expect(m(P.socialInsurance({ country: 'SA', national: true, registeredOn: null, pay: pay('50000.00'), asOf: '2026-11-30' }).base)).toBe('45000.00');
  });
  it('UAE nationals: GPSSA 11% and 12.5% of the contract salary; others none', () => {
    const i = P.socialInsurance({ country: 'AE', national: true, registeredOn: null, pay: pay('12000.00', '5000.00', '3000.00'), asOf: '2026-11-30' });
    expect([i.scheme, m(i.employee), m(i.employer)]).toEqual(['gpssa', '2200.00', '2500.00']);
    expect(P.socialInsurance({ country: 'AE', national: false, registeredOn: null, pay: pay('12000.00'), asOf: '2026-11-30' }).scheme).toBe('none');
  });
});

describe('Overtime, absence and sick leave', () => {
  it('overtime: Saudi hourly wage + 50% of hourly basic; UAE hourly basic + 25%', () => {
    expect(m(P.overtimePay('SA', pay('6000.00', '1500.00', '500.00'), P.hoursToHundredths('10')))).toBe('458.33');
    expect(m(P.overtimePay('AE', pay('6000.00', '1500.00'), P.hoursToHundredths('10')))).toBe('312.50');
    expect(P.hoursToHundredths('2.5')).toBe(250);
    expect(() => P.hoursToHundredths('2.555')).toThrow();
  });
  it('sick leave pay tiers by the days already taken this year', () => {
    expect(P.sickUnpaidHundredths('SA', 25, 10)).toBe(125);   // 5 days full pay, 5 days at 75%
    expect(P.sickUnpaidHundredths('AE', 10, 10)).toBe(250);   // 5 days full pay, 5 at half pay
    expect(P.sickUnpaidHundredths('SA', 118, 4)).toBe(400);   // unpaid
  });
});

describe('Annual leave', () => {
  it('Saudi: 21 days a year, 30 after 5 years; UAE 30; pay for leave days', () => {
    expect(P.leaveEarnedHundredths('SA', '2025-01-01', '2025-12-31')).toBe(2100);
    // Service through 2026-12-31 is 7 calendar years: 5 at 21 days + 2 at 30 (was 16516 when counted as 1825 + 732 days / 365).
    expect(P.leaveEarnedHundredths('SA', '2020-01-01', '2026-12-31')).toBe(16500);
    expect(P.leaveEarnedHundredths('AE', '2025-01-01', '2025-12-31')).toBe(3000);
    // 30 days from the fifth anniversary of the join date (counted in calendar years, not 5 x 365 days).
    expect(P.annualLeaveDays('SA', '2020-01-01', '2025-12-31')).toBe(30);
    expect(P.annualLeaveDays('SA', '2020-01-01', '2024-12-30')).toBe(21);
    expect(m(P.leaveDaysPay('SA', pay('9000.00', '3000.00'), 1000))).toBe('4000.00');   // 10 days of the full wage
    expect(m(P.leaveDaysPay('AE', pay('9000.00', '3000.00'), 1000))).toBe('3000.00');   // 10 days of basic
  });
});

describe('End of service', () => {
  const sa = (joinDate: string, endDate: string, reason: P.LeavingReason) => P.endOfService({ country: 'SA', joinDate, endDate, pay: pay('8000.00', '2000.00'), reason });
  it('Saudi: half a month for the first 5 years, a month after; resignation shares', () => {
    const e = sa('2018-01-01', '2025-12-31', 'termination');
    expect(e.serviceDays).toBe(2922);
    // Calendar service: 7 years 11 months 30/31 of a month = 2975/372 years (one day short of the 8th anniversary).
    expect(e.service).toEqual({ years: 7, months: 11, days: 30 });
    expect(m(e.full)).toBe('54973.12');                 // 10,000 x (5 x 1/2 + (2975/372 - 5)) = 10,000 x 2045/372
    expect(m(e.amount)).toBe('54973.12');
    expect(sa('2018-01-01', '2025-12-31', 'resignation')).toMatchObject({ share: '2/3', amount: toMinor('36648.75') });   // 2/3 of the exact amount, rounded once
    expect(sa('2023-01-01', '2025-12-31', 'resignation').share).toBe('1/3');
    expect(sa('2024-06-01', '2025-12-31', 'resignation').amount).toBe(0n);
    expect(P.endOfService({ country: 'SA', joinDate: '2024-06-01', endDate: '2025-12-31', pay: pay('8000.00', '2000.00'), reason: 'resignation' }, true).share).toBe('1');
  });
  it('UAE: 21 days of basic for the first 5 years, 30 after; none under a year; at most 2 years of basic', () => {
    const ae = (joinDate: string, endDate: string, basic = '12000.00') => P.endOfService({ country: 'AE', joinDate, endDate, pay: pay(basic, '5000.00'), reason: 'resignation' });
    // 6 years 11 months 30/31 = 2603/372 years: 12,000 / 30 x (21 x 5 + 30 x 743/372)
    expect(m(ae('2019-01-01', '2025-12-31').amount)).toBe('65967.74');
    expect(ae('2025-03-01', '2025-12-31').amount).toBe(0n);
    expect(m(ae('1990-01-01', '2025-12-31', '10000.00').amount)).toBe('240000.00');
    expect(P.endOfService({ country: 'AE', joinDate: '2025-03-01', endDate: '2025-12-31', pay: pay('12000.00'), reason: 'other' }, true).amount > 0n).toBe(true);
  });
});

describe('End of service in calendar years (audit: no leap-day pay)', () => {
  const p = pay('8000.00', '2000.00');
  const sa = (joinDate: string, endDate: string, reason: P.LeavingReason, accrual = false) => P.endOfService({ country: 'SA', joinDate, endDate, pay: p, reason }, accrual);
  const ae = (joinDate: string, endDate: string, basic = '10000.00') => P.endOfService({ country: 'AE', joinDate, endDate, pay: pay(basic), reason: 'termination' });
  it('Saudi, 7 calendar years, terminated: 45,000.00 (not 45,082.19 from counting leap days)', () => {
    const e = sa('2019-01-01', '2026-01-01', 'termination');
    expect(e.service).toEqual({ years: 7, months: 0, days: 0 });
    expect(m(e.amount)).toBe('45000.00');
  });
  it('the same person resigning gets two thirds: 30,000.00', () => {
    expect(sa('2019-01-01', '2026-01-01', 'resignation')).toMatchObject({ share: '2/3', amount: toMinor('30000.00') });
  });
  it('Saudi, 3 years 6 months, terminated: 17,500.00', () => {
    const e = sa('2022-07-01', '2026-01-01', 'termination');
    expect(e.service).toEqual({ years: 3, months: 6, days: 0 });
    expect(m(e.amount)).toBe('17500.00');
  });
  it('Saudi resignation: nothing the day before the second anniversary, a third on it', () => {
    expect(sa('2022-03-15', '2024-03-14', 'resignation')).toMatchObject({ share: '0', amount: 0n });
    expect(sa('2022-03-15', '2024-03-15', 'resignation')).toMatchObject({ share: '1/3', amount: toMinor('3333.33') });   // 10,000 x 1/2 x 2 / 3
    expect(sa('2019-03-15', '2024-03-14', 'resignation').share).toBe('1/3');   // the day before the 5th anniversary
    expect(sa('2019-03-15', '2024-03-15', 'resignation').share).toBe('2/3');
    expect(sa('2014-03-15', '2024-03-14', 'resignation').share).toBe('2/3');   // the day before the 10th
    expect(sa('2014-03-15', '2024-03-15', 'resignation').share).toBe('1');
  });
  it('UAE, 5 years, basic 10,000: 35,000.00; nothing under 1 year; the 2 years basic cap still applies', () => {
    expect(m(ae('2021-01-01', '2026-01-01').amount)).toBe('35000.00');
    expect(ae('2025-03-01', '2026-02-28').amount).toBe(0n);                // 11 months 27 days
    expect(m(ae('2025-03-01', '2026-03-01').amount)).toBe('7000.00');      // one year: 21 days of basic
    expect(m(ae('1990-01-01', '2026-01-01').amount)).toBe('240000.00');    // capped at 24 months of basic
  });
  it('a join date of 29 February: the anniversary in other years is 28 February', () => {
    expect(sa('2020-02-29', '2021-02-28', 'termination').service).toEqual({ years: 1, months: 0, days: 0 });
    expect(m(sa('2020-02-29', '2027-02-28', 'termination').amount)).toBe('45000.00');
    expect(sa('2020-02-29', '2022-02-27', 'resignation').share).toBe('0');
    expect(sa('2020-02-29', '2022-02-28', 'resignation').share).toBe('1/3');
    expect(sa('2020-02-29', '2024-02-29', 'termination').service).toEqual({ years: 4, months: 0, days: 0 });
  });
  it('part of a month counts as days over the days of that month, rounded only at the end', () => {
    // 1 year 0 months 15 days, the month from 2026-01-01 to 2026-02-01 having 31 days: 10,000 x 1/2 x (1 + 15/31/12)
    expect(m(sa('2025-01-01', '2026-01-16', 'termination').amount)).toBe('5201.61');
  });
  it('the accrual (provision) uses the same calendar measure', () => {
    expect(m(sa('2019-01-01', '2026-01-01', 'resignation', true).amount)).toBe('45000.00');
    expect(m(sa('2022-07-01', '2026-01-01', 'resignation', true).amount)).toBe('17500.00');
    expect(m(P.endOfService({ country: 'AE', joinDate: '2025-03-01', endDate: '2025-09-01', pay: pay('12000.00'), reason: 'other' }, true).amount)).toBe('4200.00');   // 6 months: 12,000 / 30 x 21 / 2
  });
});

describe("One employee's month", () => {
  const base: P.PayLineInput = { country: 'SA', national: true, registeredOn: '2015-01-01', pay: pay('10000.00', '2500.00', '500.00'), periodEnd: '2026-11-30',
    joinDate: '2020-01-01', endDate: null, unpaidLeaveDays: 0, absentDays: 0, sickUnpaidHundredths: 0, overtimeHundredths: 0, bonus: 0n, otherDeductions: 0n, loanDeduction: 0n };
  it('a full month: wage less GOSI', () => {
    const l = P.payLine(base);
    expect([m(l.gross), m(l.insuranceEmployee), m(l.insuranceEmployer), m(l.net)]).toEqual(['13000.00', '1218.75', '1468.75', '11781.25']);
  });
  it('a joiner on the 16th is paid 15 of 30 days; absence, overtime, loans and deductions', () => {
    const j = P.payLine({ ...base, joinDate: '2026-11-16' });
    expect([m(j.gross), m(j.insuranceEmployee)]).toEqual(['6500.00', '609.38']);
    const l = P.payLine({ ...base, absentDays: 2, overtimeHundredths: 1000, bonus: toMinor('500.00'), loanDeduction: toMinor('1000.00'), otherDeductions: toMinor('100.00') });
    expect(m(l.absence)).toBe('866.67');
    expect(m(l.overtime)).toBe('750.00');               // 10 h x (13,000/240 + 5,000/240)
    expect(m(l.net)).toBe(m(toMinor('13000.00') + toMinor('750.00') + toMinor('500.00') - toMinor('866.67') - toMinor('1218.75') - toMinor('1000.00') - toMinor('100.00')));
  });
});

describe('Salary transfer files', () => {
  const row: P.WpsRow = { personId: '10000123456789', routing: '600310101', iban: 'AE070331234567890123456', name: 'Omar Ali', employeeNo: 'E-001', idNumber: '784199012345678',
    fixed: toMinor('12000.00'), variable: toMinor('350.50'), deductions: 0n, net: toMinor('12350.50'), leaveDays: 0, basic: toMinor('8000.00'), housing: toMinor('3000.00'), otherAllowances: toMinor('1000.00') };
  it('UAE SIF: EDR per employee and an SCR total', () => {
    const sif = P.uaeSif({ employerId: '0000001234567', routing: '600310101', periodEnd: '2026-11-30', createdAt: new Date('2026-12-01T08:05:00Z'), rows: [row] }).split('\r\n');
    expect(sif[0]).toBe('EDR,10000123456789,600310101,AE070331234567890123456,2026-11-01,2026-11-30,30,12000.00,350.50,0');
    expect(sif[1]).toBe('SCR,0000001234567,600310101,2026-12-01,0805,112026,1,12350.50,AED,');
  });
  it('Saudi payroll file', () => {
    expect(P.saudiPayrollCsv([{ ...row, name: 'Ali, Omar' }]).split('\r\n')[1]).toBe('E-001,"Ali, Omar",784199012345678,AE070331234567890123456,8000.00,3000.00,1000.00,0.00,12350.50');
  });
});
