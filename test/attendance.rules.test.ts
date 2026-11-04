// Time-clock files (src/books/attendanceRules.ts): reading the file, punches, and the status of each day.
import { describe, it, expect } from 'vitest';
import * as A from '../src/books/attendanceRules.js';

const emp = [{ id: 'e1', employeeNo: 'E-001', joinDate: '2026-01-01', leavingDate: null }, { id: 'e2', employeeNo: '1002', joinDate: '2026-10-15', leavingDate: null }];
const month = (records: A.ClockRecord[], over: Partial<A.MonthInput> = {}) =>
  A.buildMonth({ periodEnd: '2026-10-31', records, weekend: A.defaultWeekend('SA'), holidays: [], dailyHours: 8, employees: emp, leaves: [], ...over });
const day = (r: A.MonthResult, id: string, d: string) => r.days.find((x) => x.contactId === id && x.day === d)!;

describe('Reading dates and times', () => {
  it('reads Gulf dates day first, ISO dates, Excel day numbers and Arabic digits', () => {
    expect(A.parseDate('2026-10-04')).toBe('2026-10-04');
    expect(A.parseDate('04/10/2026')).toBe('2026-10-04');
    expect(A.parseDate('٤-١٠-٢٠٢٦')).toBe('2026-10-04');
    expect(A.parseDate('46299')).toBe('2026-10-04');
    expect(A.parseDate('31/02/2026')).toBeNull();
    expect(A.parseDate('soon')).toBeNull();
  });
  it('reads times with or without seconds, AM/PM (also ص/م) and Excel fractions', () => {
    expect(A.parseTime('08:05')).toBe(485);
    expect(A.parseTime('8:05:59')).toBe(485);
    expect(A.parseTime('5:30 PM')).toBe(1050);
    expect(A.parseTime('12:10 am')).toBe(10);
    expect(A.parseTime('٥:٣٠ م')).toBe(1050);
    expect(A.parseTime('0.5')).toBe(720);
    expect(A.parseTime('25:00')).toBeNull();
  });
});

describe('Finding the layout', () => {
  it('one row per day, Arabic headers below a title', () => {
    const m = A.mapAttendance([['تقرير الحضور'], ['التاريخ', 'الرقم الوظيفي', 'الدخول', 'الخروج'], ['04/10/2026', 'E-001', '07:58', '17:10'], ['05/10/2026', 'E-001', '', '']]);
    expect(m.layout).toBe('daily');
    expect(m.header).toBe(1);
    expect(m.records[0]).toMatchObject({ employeeNo: 'E-001', date: '2026-10-04', timeIn: 478, timeOut: 1030, minutes: 552 });
    expect(m.records[1]).toMatchObject({ timeIn: null, timeOut: null, minutes: null });
  });
  it('punches from a time clock: first in, last out; one punch only is kept and flagged later', () => {
    const m = A.mapAttendance([['AC-No.', 'Name', 'Date/Time'], ['1002', 'Sara', '2026-10-15 08:00'], ['1002', 'Sara', '2026-10-15 12:30'], ['1002', 'Sara', '2026-10-15 17:00'],
      ['1002', 'Sara', '2026-10-16 09:00']]);
    expect(m.layout).toBe('punches');
    expect(m.records).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2026-10-15', timeIn: 480, timeOut: 1020, minutes: 540 }),
      expect.objectContaining({ date: '2026-10-16', timeIn: 540, timeOut: null, minutes: null })]));
  });
  it('says which lines it could not read and when the columns are missing', () => {
    const m = A.mapAttendance([['Employee no', 'Date', 'Time in', 'Time out'], ['E-001', '2026-13-01', '08:00', '17:00'], ['', '2026-10-01', '08:00', '17:00'], ['E-001', '2026-10-01', '8am', '17:00']]);
    expect(m.problems).toEqual([{ line: 2, problem: 'att.p.date' }, { line: 3, problem: 'att.p.noEmployee' }, { line: 4, problem: 'att.p.time' }]);
    expect(A.mapAttendance([['Name', 'Hours'], ['x', '8']]).missing.length).toBeGreaterThan(0);
  });
});

describe('Days of the month', () => {
  const rec = (employeeNo: string, date: string, timeIn: number | null, timeOut: number | null): A.ClockRecord =>
    ({ line: 1, employeeNo, date, timeIn, timeOut, minutes: timeIn !== null && timeOut !== null ? timeOut - timeIn : null, status: null });

  it('present when clocked in, absent on a working day without a punch, off on the weekend (Saudi: Friday and Saturday)', () => {
    const r = month([rec('E-001', '2026-10-04', 480, 1020), rec('E-001', '2026-10-31', 480, 960)]);   // Sunday
    expect(day(r, 'e1', '2026-10-04')).toMatchObject({ status: 'present', minutes: 540, overtimeMinutes: 60 });
    expect(day(r, 'e1', '2026-10-05').status).toBe('absent');   // Monday
    expect(day(r, 'e1', '2026-10-02').status).toBe('off');      // Friday
    expect(day(r, 'e1', '2026-10-03').status).toBe('off');      // Saturday
    expect(r.days.filter((d) => d.contactId === 'e1')).toHaveLength(31);
  });

  it('UAE weekend is Saturday and Sunday; public holidays are off; work on a day off is all overtime', () => {
    const r = month([rec('E-001', '2026-10-02', 540, 780), rec('E-001', '2026-10-31', 540, 780)], { weekend: A.defaultWeekend('AE'), holidays: ['2026-10-06'] });
    expect(day(r, 'e1', '2026-10-02')).toMatchObject({ status: 'present', overtimeMinutes: 0 });   // Friday is a working day in the UAE
    expect(day(r, 'e1', '2026-10-04').status).toBe('off');                                       // Sunday
    expect(day(r, 'e1', '2026-10-06').status).toBe('off');                                       // holiday
    const r2 = month([rec('E-001', '2026-10-03', 540, 780)]);                                     // Saturday in Saudi Arabia
    expect(day(r2, 'e1', '2026-10-03')).toMatchObject({ status: 'present', overtimeMinutes: 240 });
  });

  it('approved leave wins over the clock; working on a leave day is flagged; one punch is flagged', () => {
    const r = month([rec('E-001', '2026-10-07', 480, 1000), rec('E-001', '2026-10-11', 480, null)], { leaves: [{ id: 'L1', contactId: 'e1', startDate: '2026-10-06', endDate: '2026-10-08' }] });
    expect(day(r, 'e1', '2026-10-06')).toMatchObject({ status: 'leave', leaveId: 'L1' });
    expect(day(r, 'e1', '2026-10-07')).toMatchObject({ status: 'leave', flags: ['att.f.workedOnLeave'], overtimeMinutes: 0 });
    expect(day(r, 'e1', '2026-10-11')).toMatchObject({ status: 'present', minutes: null, flags: ['att.f.onePunch'] });
  });

  it('only from the day the person joined; unknown numbers and other months are reported, not guessed', () => {
    const r = month([rec('1002', '2026-10-15', 480, 960), rec('1002', '2026-10-31', 480, 960), rec('X-9', '2026-10-15', 480, 960), rec('E-001', '2026-09-30', 480, 960)]);
    expect(r.days.filter((d) => d.contactId === 'e2')).toHaveLength(17);
    expect(r.days.some((d) => d.contactId === 'e1')).toBe(false);   // not in this month's file
    expect(r.unknownNumbers).toEqual(['X-9']);
    expect(r.outsideMonth).toBe(1);
  });

  it('a status column works without times; a split shift adds up', () => {
    const st = (date: string, status: A.ClockRecord['status']): A.ClockRecord => ({ line: 1, employeeNo: 'E-001', date, timeIn: null, timeOut: null, minutes: null, status });
    const r = month([st('2026-10-04', 'present'), st('2026-10-05', 'absent'), rec('E-001', '2026-10-06', 420, 660), rec('E-001', '2026-10-06', 960, 1260)]);
    expect(day(r, 'e1', '2026-10-04').status).toBe('present');
    expect(day(r, 'e1', '2026-10-05').status).toBe('absent');
    expect(day(r, 'e1', '2026-10-06')).toMatchObject({ checkIn: 420, checkOut: 1260, minutes: 540, overtimeMinutes: 60 });
  });

  it('a month still running stops at the last date in the file', () => {
    const r = month([rec('E-001', '2026-10-01', 480, 960), rec('E-001', '2026-10-05', 480, 960)]);
    expect(r.days.filter((d) => d.contactId === 'e1').map((d) => d.day).at(-1)).toBe('2026-10-05');
    expect(r.days.filter((d) => d.contactId === 'e1')).toHaveLength(5);
  });

  it('hours as text', () => {
    expect(A.hoursText(60)).toBe('1.00');
    expect(A.hoursText(25)).toBe('0.42');
    expect(A.clock(485)).toBe('08:05');
  });
});
