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
    expect(P.leaveEarnedHundredths('SA', '2020-01-01', '2026-12-31')).toBe(16516);   // 1825 days at 21 + 732 at 30
    expect(P.leaveEarnedHundredths('AE', '2025-01-01', '2025-12-31')).toBe(3000);
    expect(P.annualLeaveDays('SA', 6 * 365)).toBe(30);
    expect(m(P.leaveDaysPay('SA', pay('9000.00', '3000.00'), 1000))).toBe('4000.00');   // 10 days of the full wage
    expect(m(P.leaveDaysPay('AE', pay('9000.00', '3000.00'), 1000))).toBe('3000.00');   // 10 days of basic
  });
});

describe('End of service', () => {
  const sa = (joinDate: string, endDate: string, reason: P.LeavingReason) => P.endOfService({ country: 'SA', joinDate, endDate, pay: pay('8000.00', '2000.00'), reason });
  it('Saudi: half a month for the first 5 years, a month after; resignation shares', () => {
    const e = sa('2018-01-01', '2025-12-31', 'termination');
    expect(e.serviceDays).toBe(2922);
    expect(m(e.full)).toBe('55054.79');                 // 10,000 x (1825 + 2 x 1097) / 730
    expect(m(e.amount)).toBe('55054.79');
    expect(sa('2018-01-01', '2025-12-31', 'resignation')).toMatchObject({ share: '2/3', amount: toMinor('36703.19') });
    expect(sa('2023-01-01', '2025-12-31', 'resignation').share).toBe('1/3');
    expect(sa('2024-06-01', '2025-12-31', 'resignation').amount).toBe(0n);
    expect(P.endOfService({ country: 'SA', joinDate: '2024-06-01', endDate: '2025-12-31', pay: pay('8000.00', '2000.00'), reason: 'resignation' }, true).share).toBe('1');
  });
  it('UAE: 21 days of basic for the first 5 years, 30 after; none under a year; at most 2 years of basic', () => {
    const ae = (joinDate: string, endDate: string, basic = '12000.00') => P.endOfService({ country: 'AE', joinDate, endDate, pay: pay(basic, '5000.00'), reason: 'resignation' });
    expect(m(ae('2019-01-01', '2025-12-31').amount)).toBe('66065.75');
    expect(ae('2025-03-01', '2025-12-31').amount).toBe(0n);
    expect(m(ae('1990-01-01', '2025-12-31', '10000.00').amount)).toBe('240000.00');
    expect(P.endOfService({ country: 'AE', joinDate: '2025-03-01', endDate: '2025-12-31', pay: pay('12000.00'), reason: 'other' }, true).amount > 0n).toBe(true);
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
