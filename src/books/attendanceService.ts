// Daily attendance from time-clock files, and correction requests (db/migrations/0028_attendance_days.sql).
// Every function runs inside withUser(); the database refuses any change that skips an approval.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { monthEnd } from './assets.js';
import { employees } from './hrmService.js';
import { buildMonth, defaultWeekend, hoursText, mapAttendance, type DayResult, type DayStatus } from './attendanceRules.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 60000;

const checkMonth = (periodEnd: unknown): string => {
  const p = String(periodEnd ?? '');
  if (!DATE.test(p) || monthEnd(p) !== p) bad('Choose the month.', 'err.date');
  return p;
};

export interface ImportInput { periodEnd?: string; rows?: string[][]; weekend?: number[]; holidays?: string[]; dailyHours?: number | string; fileName?: string }

/** What a file means for the month, before anything is saved. */
async function plan(db: Db, companyId: string, x: ImportInput) {
  const periodEnd = checkMonth(x.periodEnd);
  const rows = Array.isArray(x.rows) ? x.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) : [];
  if (rows.length > MAX_ROWS) bad('The file has too many rows. Split it by month.', 'err.importTooMany');
  const country = (await db.query('SELECT country FROM companies WHERE id = $1', [companyId])).rows[0]?.country ?? notFound();
  const weekend = Array.isArray(x.weekend) ? [...new Set(x.weekend.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : defaultWeekend(country);
  const holidays = (Array.isArray(x.holidays) ? x.holidays : []).map(String).filter((d) => DATE.test(d));
  const dailyHours = Number(x.dailyHours ?? 8);
  if (!(dailyHours >= 1 && dailyHours <= 12)) bad('Normal hours a day are between 1 and 12.', 'err.dailyHours');
  const staff = (await employees(db, companyId)).filter((e) => e.hasProfile);
  const start = `${periodEnd.slice(0, 7)}-01`;
  const leaves = (await db.query(`SELECT id, contact_id AS "contactId", start_date::text AS "startDate", end_date::text AS "endDate" FROM leave_requests
    WHERE company_id = $1 AND status = 'approved' AND end_date >= $2 AND start_date <= $3`, [companyId, start, periodEnd])).rows;
  const file = mapAttendance(rows);
  const month = buildMonth({ periodEnd, records: file.records, weekend, holidays, dailyHours, leaves,
    employees: staff.map((e) => ({ id: e.id, employeeNo: e.employeeNo, joinDate: e.joinDate, leavingDate: e.leavingDate })) });
  const existing = new Map<string, { id: string; status: DayStatus; corrected: boolean }>((await db.query(
    `SELECT id, contact_id, day::text, status, correction_id IS NOT NULL AS corrected FROM hr_attendance_days WHERE company_id = $1 AND day BETWEEN $2 AND $3`,
    [companyId, start, periodEnd])).rows.map((r) => [`${r.contact_id}|${r.day}`, { id: r.id, status: r.status, corrected: r.corrected }]));
  const posted = (await db.query(`SELECT 1 FROM payroll_runs WHERE company_id = $1 AND period_end = $2 AND status <> 'draft'`, [companyId, periodEnd])).rows.length > 0;
  // Each day: new, changed, the same, or kept (only an approved correction may change an absence, a leave day or a corrected day).
  const work = month.days.map((d) => {
    const was = existing.get(`${d.contactId}|${d.day}`);
    const action: 'new' | 'update' | 'same' | 'kept' = !was ? 'new' : was.corrected || (['absent', 'leave'].includes(was.status) && was.status !== d.status) ? (was.status === d.status ? 'same' : 'kept') : 'update';
    return { d, was, action };
  });
  const people = month.inFile.map((id) => {
    const e = staff.find((s) => s.id === id)!;
    const mine = work.filter((w) => w.d.contactId === id);
    const count = (s: DayStatus) => mine.filter((w) => w.d.status === s).length;
    return { contactId: id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, present: count('present'), absent: count('absent'), leave: count('leave'), off: count('off'),
      overtimeHours: hoursText(mine.reduce((s, w) => s + w.d.overtimeMinutes, 0)), flags: mine.reduce((s, w) => s + w.d.flags.length, 0),
      kept: mine.filter((w) => w.action === 'kept').length };
  });
  return { periodEnd, posted, weekend, holidays, dailyHours, file, month, work, people,
    notInFile: staff.filter((e) => !month.inFile.includes(e.id) && e.joinDate && e.joinDate <= periodEnd && (!e.leavingDate || e.leavingDate >= start)).map((e) => ({ name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo })) };
}

export async function importPreview(db: Db, companyId: string, x: ImportInput) {
  const p = await plan(db, companyId, x);
  return { periodEnd: p.periodEnd, posted: p.posted, layout: p.file.layout, missing: p.file.missing, problems: p.file.problems.slice(0, 200), problemCount: p.file.problems.length,
    unknownNumbers: p.month.unknownNumbers, outsideMonth: p.month.outsideMonth, weekend: p.weekend, dailyHours: p.dailyHours, people: p.people, notInFile: p.notInFile,
    kept: p.work.filter((w) => w.action === 'kept').length };
}

const rec = (d: DayResult) => ({ contact_id: d.contactId, day: d.day, status: d.status, check_in: d.checkIn, check_out: d.checkOut, worked: d.minutes,
  ot: d.overtimeMinutes, leave_id: d.leaveId, flags: d.flags });

/** Saves the days. Absences, leave days and corrected days already recorded are kept (they change only through a correction). */
export async function importRun(db: Db, companyId: string, x: ImportInput) {
  const p = await plan(db, companyId, x);
  if (p.posted) bad('Payroll for this month is posted, so its attendance no longer changes.', 'err.attPosted');
  if (!p.file.layout) bad('The file needs an employee number column and a date column.', 'err.attColumns');
  if (!p.people.length) bad('Nobody in the file matches an employee number in this company.', 'err.attNobody');
  const importId = (await db.query(`INSERT INTO hr_attendance_imports (company_id, period_end, file_name, people, days, kept, created_by) VALUES ($1,$2,$3,$4,$5,$6, app_user_id()) RETURNING id`,
    [companyId, p.periodEnd, x.fileName?.slice(0, 200) || null, p.people.length, p.work.filter((w) => w.action === 'new' || w.action === 'update').length,
      p.work.filter((w) => w.action === 'kept').length])).rows[0].id;
  const fresh = p.work.filter((w) => w.action === 'new').map((w) => rec(w.d));
  if (fresh.length) {
    await db.query(`INSERT INTO hr_attendance_days (company_id, contact_id, day, status, check_in, check_out, worked_minutes, overtime_minutes, leave_id, import_id, flags)
      SELECT $1, x.contact_id, x.day, x.status, x.check_in, x.check_out, x.worked, x.ot, x.leave_id, $2, x.flags
      FROM jsonb_to_recordset($3::jsonb) AS x(contact_id uuid, day date, status text, check_in smallint, check_out smallint, worked smallint, ot smallint, leave_id uuid, flags text[])`,
    [companyId, importId, JSON.stringify(fresh)]);
  }
  const changed = p.work.filter((w) => w.action === 'update').map((w) => ({ id: w.was!.id, ...rec(w.d) }));
  if (changed.length) {
    await db.query(`UPDATE hr_attendance_days d SET status = x.status, check_in = x.check_in, check_out = x.check_out, worked_minutes = x.worked, overtime_minutes = x.ot,
        leave_id = x.leave_id, import_id = $1, flags = x.flags
      FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, status text, check_in smallint, check_out smallint, worked smallint, ot smallint, leave_id uuid, flags text[]) WHERE d.id = x.id`,
    [importId, JSON.stringify(changed)]);
  }
  return { importId, people: p.people.length, saved: fresh.length + changed.length, kept: p.work.filter((w) => w.action === 'kept').length };
}

/** The month day by day for everyone with days, and the corrections touching it. */
export async function monthDays(db: Db, companyId: string, periodEnd: string) {
  checkMonth(periodEnd);
  const start = `${periodEnd.slice(0, 7)}-01`;
  const days = (await db.query(
    `SELECT d.contact_id AS "contactId", d.day::text, d.status, d.check_in AS "checkIn", d.check_out AS "checkOut", d.worked_minutes AS "workedMinutes",
            d.overtime_minutes AS "overtimeMinutes", d.leave_id AS "leaveId", l.kind AS "leaveKind", d.correction_id AS "correctionId", d.flags
     FROM hr_attendance_days d LEFT JOIN leave_requests l ON l.id = d.leave_id WHERE d.company_id = $1 AND d.day BETWEEN $2 AND $3 ORDER BY d.day`, [companyId, start, periodEnd])).rows;
  const imports = (await db.query(`SELECT i.id, i.file_name AS "fileName", i.people, i.days, i.kept, i.created_at AS "createdAt", person_name(i.created_by) AS "createdBy"
    FROM hr_attendance_imports i WHERE i.company_id = $1 AND i.period_end = $2 ORDER BY i.created_at DESC`, [companyId, periodEnd])).rows;
  return { periodEnd, days, imports, corrections: await listCorrections(db, companyId, '', start, periodEnd) };
}

// ------------------------------------------------------------------ corrections
export interface CorrectionInput { contactId?: string; kind?: string; leaveKind?: string | null; leaveId?: string | null; dayFrom?: string; dayTo?: string; reason?: string }

export async function requestCorrection(db: Db, companyId: string, x: CorrectionInput): Promise<string> {
  if (!x.contactId) bad('Choose the employee.', 'err.employee');
  const kind = ['absence_to_leave', 'absence_excused', 'leave_to_working'].includes(String(x.kind)) ? String(x.kind) : bad('Choose what the days should become.', 'err.corrKind');
  const from = DATE.test(String(x.dayFrom)) ? String(x.dayFrom) : bad('Choose the days.', 'err.date');
  const to = DATE.test(String(x.dayTo ?? from)) ? String(x.dayTo ?? from) : from;
  if (to < from) bad('The last day is before the first day.', 'err.leaveDates');
  const reason = String(x.reason ?? '').trim() || bad('Say why the days should change.', 'err.corrReason');
  const leaveKind = kind === 'absence_to_leave' ? (['annual', 'sick', 'unpaid', 'other_paid'].includes(String(x.leaveKind)) ? String(x.leaveKind) : bad('Choose the type of leave.', 'err.leaveKind')) : null;
  return (await db.query(
    `INSERT INTO hr_attendance_corrections (company_id, contact_id, kind, leave_kind, leave_id, day_from, day_to, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, app_user_id()) RETURNING id`,
    [companyId, x.contactId, kind, leaveKind, kind === 'leave_to_working' ? x.leaveId || bad('Choose the leave.', 'err.corrLeave') : null, from, to, reason])).rows[0].id;
}

export async function decideCorrection(db: Db, id: string, status: string, note?: string): Promise<void> {
  if (!['approved', 'rejected', 'withdrawn'].includes(status)) bad('Approve, reject or withdraw.', 'err.corrStatus');
  if (status === 'rejected' && !String(note ?? '').trim()) bad('Say why it is rejected.', 'err.rejectReason');
  const { rowCount } = await db.query('UPDATE hr_attendance_corrections SET status = $2, decision_note = $3 WHERE id = $1', [id, status, String(note ?? '').trim() || null]);
  if (!rowCount) notFound();
}

export async function listCorrections(db: Db, companyId: string, status = '', from = '0001-01-01', to = '9999-12-31') {
  return (await db.query(
    `SELECT k.id, k.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", c.employee_no AS "employeeNo", k.kind, k.leave_kind AS "leaveKind", k.leave_id AS "leaveId",
            k.day_from::text AS "dayFrom", k.day_to::text AS "dayTo", k.day_to - k.day_from + 1 AS days, k.reason, k.status, k.decision_note AS "decisionNote",
            person_name(k.created_by) AS "createdBy", k.created_by = app_user_id() AS mine, k.created_at AS "createdAt", person_name(k.decided_by) AS "decidedBy", k.decided_at AS "decidedAt"
     FROM hr_attendance_corrections k JOIN contacts c ON c.id = k.contact_id
     WHERE k.company_id = $1 AND ($2 = '' OR k.status = $2) AND k.day_to >= $3 AND k.day_from <= $4
     ORDER BY (k.status = 'requested') DESC, k.created_at DESC`, [companyId, status, from, to])).rows;
}

/** Corrections waiting for this person to decide (someone else asked, and they may approve). */
export async function correctionsWaiting(db: Db, companyId: string): Promise<number> {
  return (await db.query(`SELECT CASE WHEN app_can_approve($1) THEN (SELECT count(*)::int FROM hr_attendance_corrections WHERE company_id = $1 AND status = 'requested' AND created_by <> app_user_id()) ELSE 0 END AS n`,
    [companyId])).rows[0].n;
}
