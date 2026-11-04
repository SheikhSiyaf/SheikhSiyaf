// Daily attendance from the time clock, and overturning absences or leave only through an approved correction
// (db/migrations/0028_attendance_days.sql, src/books/attendanceService.ts).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as H from '../src/books/hrmService.js';
import * as AT from '../src/books/attendanceService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let faisal: string, ahmed: string, leave78: string;
const PE = '2026-09-30';
// Sunday 2026-09-01 is a Tuesday; Saudi weekend Friday and Saturday: 8 days off, 22 working days.
const file = (extra: string[][] = []) => [['Employee no', 'Date', 'Time in', 'Time out'],
  ['E-001', '01/09/2026', '08:00', '17:30'], ['E-001', '03/09/2026', '07:55', '16:00'], ['E-002', '01/09/2026', '08:00', '16:00'], ['E-002', '30/09/2026', '08:00', '16:00'], ...extra];
const day = async (contact: string, d: string) => (await owner.query('SELECT status, leave_id, correction_id FROM hr_attendance_days WHERE contact_id = $1 AND day = $2', [contact, d])).rows[0];
const month = async (contact: string) => (await owner.query('SELECT absent_days, overtime_hours::text AS ot FROM hr_attendance WHERE contact_id = $1 AND period_end = $2', [contact, PE])).rows[0];

beforeAll(async () => {
  f = await seed();
  faisal = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Faisal Al Harbi', employeeNo: 'E-001' }));
  ahmed = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Ahmed Mostafa', employeeNo: 'E-002' }));
  await as(f.staff, (db) => H.saveProfile(db, faisal, { nationality: 'SA', joinDate: '2020-01-01', basic: '10000.00' }));
  await as(f.staff, (db) => H.saveProfile(db, ahmed, { nationality: 'EG', joinDate: '2025-06-01', basic: '6000.00' }));
  // Ahmed's leave on 7 and 8 September was approved before the clock file came in.
  leave78 = await as(f.staff, (db) => H.saveLeave(db, f.a.id, { contactId: ahmed, kind: 'annual', startDate: '2026-09-07', endDate: '2026-09-08' }));
  await as(f.partner, (db) => H.decideLeave(db, leave78, 'approved'));
});

describe('Importing a time-clock file', () => {
  it('shows what the file means before saving: present, absent, leave, off and overtime per person', async () => {
    const p = await as(f.staff, (db) => AT.importPreview(db, f.a.id, { periodEnd: PE, rows: file([['X-9', '01/09/2026', '08:00', '17:00']]) }));
    expect(p.layout).toBe('daily');
    expect(p.unknownNumbers).toEqual(['X-9']);
    expect(p.people.find((x) => x.contactId === faisal)).toMatchObject({ present: 2, absent: 20, off: 8, leave: 0, overtimeHours: '1.58' });
    expect(p.people.find((x) => x.contactId === ahmed)).toMatchObject({ present: 2, absent: 18, leave: 2, off: 8 });
    expect((await owner.query('SELECT count(*)::int AS n FROM hr_attendance_days WHERE company_id = $1', [f.a.id])).rows[0].n).toBe(0);
  });

  it('saves the days; the monthly sheet for payroll follows them and cannot be changed by hand', async () => {
    const r = await as(f.staff, (db) => AT.importRun(db, f.a.id, { periodEnd: PE, rows: file(), fileName: 'clock-sep.csv' }));
    expect(r).toMatchObject({ people: 2, saved: 60, kept: 0 });
    expect(await month(faisal)).toEqual({ absent_days: 20, ot: '1.58' });
    expect(await month(ahmed)).toEqual({ absent_days: 18, ot: '0.00' });
    expect((await day(ahmed, '2026-09-07')).leave_id).toBe(leave78);
    await expect(owner.query(`UPDATE hr_attendance SET absent_days = 0 WHERE contact_id = $1 AND period_end = $2`, [faisal, PE])).rejects.toThrow(/time clock/);
    // The monthly screen may still change the notes.
    await as(f.staff, (db) => H.saveAttendance(db, f.a.id, PE, [{ contactId: faisal, absentDays: 0, overtimeHours: '0', notes: 'Clock file' }]));
    expect(await month(faisal)).toEqual({ absent_days: 20, ot: '1.58' });
    const sheet = await as(f.staff, (db) => H.attendance(db, f.a.id, PE));
    expect(sheet.rows.find((x) => x.contactId === faisal)).toMatchObject({ fromClock: true, notes: 'Clock file' });
  });

  it('an absence is never changed by hand or by a new file', async () => {
    await expect(as(f.staff, (db) => db.query(`UPDATE hr_attendance_days SET status = 'present' WHERE contact_id = $1 AND day = '2026-09-02'`, [faisal]))).rejects.toThrow(/approved correction/);
    await expect(as(f.staff, (db) => db.query(`DELETE FROM hr_attendance_days WHERE contact_id = $1`, [faisal]))).rejects.toThrow();
    const r = await as(f.staff, (db) => AT.importRun(db, f.a.id, { periodEnd: PE, rows: file([['E-001', '02/09/2026', '08:00', '16:00']]) }));
    expect(r.kept).toBe(1);
    expect((await day(faisal, '2026-09-02')).status).toBe('absent');
  });
});

describe('Corrections need approval by someone else', () => {
  let excuse: string;
  it('a forgotten punch: asked by the accountant, refused to the asker and to roles without the approve right, approved by the partner', async () => {
    excuse = await as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-02', reason: 'Visited a customer; forgot to punch' }));
    await expect(as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-02', reason: 'again' }))).rejects.toThrow(/already waiting/);
    await expect(as(f.staff, (db) => AT.decideCorrection(db, excuse, 'approved'))).rejects.toThrow(/does not allow approving|row-level security/);
    await expect(as(f.partner, (db) => AT.decideCorrection(db, excuse, 'rejected'))).rejects.toThrow(/why/);
    await as(f.partner, (db) => AT.decideCorrection(db, excuse, 'approved'));
    expect(await day(faisal, '2026-09-02')).toMatchObject({ status: 'present', correction_id: excuse });
    expect((await month(faisal)).absent_days).toBe(19);
    await expect(as(f.partner, (db) => AT.decideCorrection(db, excuse, 'rejected', 'no'))).rejects.toThrow(/decided/);
  });

  it('the person who asks never approves their own correction', async () => {
    const own = await as(f.partner, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-06', reason: 'Training' }));
    await expect(as(f.partner, (db) => AT.decideCorrection(db, own, 'approved'))).rejects.toThrow(/Someone else/);
    await expect(as(f.staff, (db) => AT.decideCorrection(db, own, 'withdrawn'))).rejects.toThrow();
    await as(f.partner, (db) => AT.decideCorrection(db, own, 'withdrawn'));
    expect((await day(faisal, '2026-09-06')).status).toBe('absent');
  });

  it('absence into sick leave: the reviewer approves; the leave is created approved and the days follow', async () => {
    const id = await as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_to_leave', leaveKind: 'sick', dayFrom: '2026-09-09', dayTo: '2026-09-10', reason: 'Medical certificate' }));
    await as(f.reviewer, (db) => AT.decideCorrection(db, id, 'approved'));
    const d = await day(faisal, '2026-09-09');
    expect(d.status).toBe('leave');
    expect((await owner.query('SELECT kind, status, days FROM leave_requests WHERE id = $1', [d.leave_id])).rows[0]).toEqual({ kind: 'sick', status: 'approved', days: 2 });
    expect((await month(faisal)).absent_days).toBe(17);
  });

  it('only absent days can be asked to change; payroll-free months only', async () => {
    await expect(as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-01', reason: 'x' }))).rejects.toThrow(/recorded as absent/);
    await expect(as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-14', reason: '' }))).rejects.toThrow(/why/);
  });

  it('approving leave over recorded absences needs someone else with the approve right', async () => {
    const l = await as(f.staff, (db) => H.saveLeave(db, f.a.id, { contactId: faisal, kind: 'annual', startDate: '2026-09-14', endDate: '2026-09-15' }));
    await expect(as(f.staff, (db) => H.decideLeave(db, l, 'approved'))).rejects.toThrow(/recorded absent/);
    await expect(as(f.staff, (db) => H.saveLeave(db, f.a.id, { contactId: faisal, kind: 'annual', startDate: '2026-09-16', endDate: '2026-09-16', approve: true }))).rejects.toThrow(/recorded absent/);
    await as(f.partner, (db) => H.decideLeave(db, l, 'approved'));
    expect((await day(faisal, '2026-09-14')).status).toBe('leave');
    expect((await month(faisal)).absent_days).toBe(15);
  });

  it('approved leave is never cancelled directly; giving back a day goes through a correction and keeps the rest of the leave', async () => {
    await expect(as(f.partner, (db) => H.decideLeave(db, leave78, 'cancelled'))).rejects.toThrow(/correction request/);
    await expect(as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: ahmed, kind: 'leave_to_working', leaveId: leave78, dayFrom: '2026-09-08', dayTo: '2026-09-09', reason: 'x' })))
      .rejects.toThrow(/inside this person/);
    const id = await as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: ahmed, kind: 'leave_to_working', leaveId: leave78, dayFrom: '2026-09-08', reason: 'Came back early to cover the store' }));
    await as(f.partner, (db) => AT.decideCorrection(db, id, 'approved'));
    expect((await owner.query('SELECT status FROM leave_requests WHERE id = $1', [leave78])).rows[0].status).toBe('cancelled');
    const left = (await owner.query(`SELECT start_date::text AS s, end_date::text AS e, status FROM leave_requests WHERE contact_id = $1 AND status = 'approved'`, [ahmed])).rows;
    expect(left).toEqual([{ s: '2026-09-07', e: '2026-09-07', status: 'approved' }]);
    expect((await day(ahmed, '2026-09-07')).status).toBe('leave');
    expect(await day(ahmed, '2026-09-08')).toMatchObject({ status: 'present', correction_id: id });
  });

  it('corrections are listed for the month and waiting ones counted for approvers only', async () => {
    await as(f.staff, (db) => AT.requestCorrection(db, f.a.id, { contactId: faisal, kind: 'absence_excused', dayFrom: '2026-09-17', reason: 'Business trip' }));
    expect(await as(f.partner, (db) => AT.correctionsWaiting(db, f.a.id))).toBe(1);
    expect(await as(f.staff, (db) => AT.correctionsWaiting(db, f.a.id))).toBe(0);
    const m = await as(f.staff, (db) => AT.monthDays(db, f.a.id, PE));
    expect(m.days.length).toBe(60);
    expect(m.imports.length).toBe(2);
    expect(m.corrections.filter((c) => c.status === 'approved')).toHaveLength(3);
    expect(await as(f.b.clientAccountant, (db) => AT.listCorrections(db, f.a.id))).toEqual([]);
  });
});
