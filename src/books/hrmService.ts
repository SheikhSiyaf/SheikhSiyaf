// HRM: HR details, attendance, leave, loans, payroll, end of service and HR documents.
// Amounts come from src/books/payroll.ts; db/migrations/0017_hrm.sql checks lines add up and postings match.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { postEntry } from '../ledger/ledger.js';
import { fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { nextNumber } from './documentsService.js';
import { monthEnd } from './assets.js';
import * as P from './payroll.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const money = (v: unknown, label = 'err.amountFormat'): Minor => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s) return 0n;
  try { const m = toMinor(s); if (m < 0n) bad('Amounts cannot be negative.', 'err.amount'); return m; } catch (e) { if (e instanceof HttpError) throw e; return bad('Amounts have at most 2 decimals.', label); }
};
const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const dateOrNull = (v: unknown) => (typeof v === 'string' && DATE.test(v) ? v : null);
const prevDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1)).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);

async function accountByCode(db: Db, companyId: string, code: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code]);
  return rows[0]?.id ?? bad(`This client's chart of accounts has no account ${code}.`, 'err.chart');
}
async function companyCountry(db: Db, companyId: string): Promise<P.Country> {
  const r = (await db.query('SELECT country FROM companies WHERE id = $1', [companyId])).rows[0] ?? notFound();
  return r.country;
}
async function bankAccount(db: Db, companyId: string, id: unknown) {
  if (!id || !(await db.query('SELECT 1 FROM accounts WHERE id = $1 AND company_id = $2 AND is_bank', [id, companyId])).rows[0])
    bad('Choose the bank or cash account the money is paid from.', 'err.bankAccount');
  return String(id);
}

// ------------------------------------------------------------------ employees and their HR details
export interface Emp {
  id: string; companyId: string; name: string; nameAr: string | null; employeeNo: string | null; jobTitle: string | null; status: string;
  costCentreId: string | null; hasProfile: boolean; nationality: string | null; national: boolean; idNumber: string | null; passportNo: string | null;
  dateOfBirth: string | null; joinDate: string | null; contractType: string | null; contractEnd: string | null;
  basic: string; housing: string; transport: string; otherAllowance: string; wage: string;
  iban: string | null; bankRouting: string | null; wpsPersonId: string | null; insuranceNo: string | null; insuranceRegistered: string | null;
  annualLeaveDays: number | null; openingLeaveDays: string; openingAsOf: string | null; openingEos: string;
  leavingDate: string | null; leavingReason: string | null; settled: boolean; country: P.Country;
}
const EMP_SQL = `SELECT c.id, c.company_id AS "companyId", c.name, c.name_ar AS "nameAr", c.employee_no AS "employeeNo", c.job_title AS "jobTitle", c.status,
    c.default_cost_centre_id AS "costCentreId", p.contact_id IS NOT NULL AS "hasProfile", p.nationality, co.country,
    p.id_number AS "idNumber", p.passport_no AS "passportNo", p.date_of_birth::text AS "dateOfBirth", p.join_date::text AS "joinDate",
    p.contract_type AS "contractType", p.contract_end::text AS "contractEnd",
    coalesce(p.basic, 0)::text AS basic, coalesce(p.housing, 0)::text AS housing, coalesce(p.transport, 0)::text AS transport, coalesce(p.other_allowance, 0)::text AS "otherAllowance",
    p.iban, p.bank_routing AS "bankRouting", p.wps_person_id AS "wpsPersonId", p.insurance_no AS "insuranceNo", p.insurance_registered::text AS "insuranceRegistered",
    p.annual_leave_days AS "annualLeaveDays", coalesce(p.opening_leave_days, 0)::text AS "openingLeaveDays", p.opening_as_of::text AS "openingAsOf",
    coalesce(p.opening_eos, 0)::text AS "openingEos", p.leaving_date::text AS "leavingDate", p.leaving_reason AS "leavingReason",
    EXISTS (SELECT 1 FROM eos_settlements s WHERE s.contact_id = c.id) AS settled
  FROM contacts c JOIN companies co ON co.id = c.company_id LEFT JOIN employee_profiles p ON p.contact_id = c.id`;
const shape = (r: Record<string, unknown>): Emp => {
  const e = r as unknown as Emp;
  return { ...e, national: e.nationality === e.country, wage: fromMinor(toMinor(e.basic) + toMinor(e.housing) + toMinor(e.transport) + toMinor(e.otherAllowance)) };
};
const payOf = (e: Emp): P.PayStructure => ({ basic: toMinor(e.basic), housing: toMinor(e.housing), transport: toMinor(e.transport), other: toMinor(e.otherAllowance) });

export async function employees(db: Db, companyId: string): Promise<Emp[]> {
  return (await db.query(`${EMP_SQL} WHERE c.company_id = $1 AND c.is_employee ORDER BY c.name`, [companyId])).rows.map(shape);
}
export async function employee(db: Db, id: string): Promise<Emp> {
  const r = (await db.query(`${EMP_SQL} WHERE c.id = $1 AND c.is_employee`, [id])).rows[0] ?? notFound();
  return shape(r);
}

export interface ProfileInput {
  nationality?: string | null; idNumber?: string | null; passportNo?: string | null; dateOfBirth?: string | null; joinDate?: string | null; contractType?: string | null; contractEnd?: string | null;
  basic?: string | null; housing?: string | null; transport?: string | null; otherAllowance?: string | null; iban?: string | null; bankRouting?: string | null; wpsPersonId?: string | null;
  insuranceNo?: string | null; insuranceRegistered?: string | null; annualLeaveDays?: string | number | null; openingLeaveDays?: string | null; openingAsOf?: string | null; openingEos?: string | null;
}

export async function saveProfile(db: Db, contactId: string, p: ProfileInput): Promise<void> {
  const e = await employee(db, contactId);
  const nationality = String(p.nationality ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(nationality)) bad('Choose the nationality.', 'err.nationality');
  const join = dateOrNull(p.joinDate) ?? bad('Enter the join date.', 'err.joinDate');
  const basic = money(p.basic);
  if (basic <= 0n) bad('Enter the basic salary.', 'err.basicSalary');
  const iban = t(p.iban)?.replace(/\s+/g, '').toUpperCase() ?? null;
  if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) bad('Check the IBAN.', 'err.iban');
  const leaveDays = p.annualLeaveDays === '' || p.annualLeaveDays == null ? null : Number(p.annualLeaveDays);
  if (leaveDays !== null && (!Number.isInteger(leaveDays) || leaveDays < 0 || leaveDays > 60)) bad('Annual leave is 0 to 60 days a year.', 'err.leaveDays');
  const opening = String(p.openingLeaveDays ?? '').trim() || '0';
  if (!/^-?\d+(\.\d{1,2})?$/.test(opening)) bad('Leave days have at most 2 decimals.', 'err.leaveDays');
  const v = [contactId, e.companyId, nationality, t(p.idNumber), t(p.passportNo), dateOrNull(p.dateOfBirth), join, p.contractType === 'limited' ? 'limited' : 'unlimited',
    dateOrNull(p.contractEnd), fromMinor(basic), fromMinor(money(p.housing)), fromMinor(money(p.transport)), fromMinor(money(p.otherAllowance)), iban,
    t(p.bankRouting), t(p.wpsPersonId), t(p.insuranceNo), dateOrNull(p.insuranceRegistered), leaveDays, opening, dateOrNull(p.openingAsOf), fromMinor(money(p.openingEos))];
  await db.query(
    `INSERT INTO employee_profiles (contact_id, company_id, nationality, id_number, passport_no, date_of_birth, join_date, contract_type, contract_end,
       basic, housing, transport, other_allowance, iban, bank_routing, wps_person_id, insurance_no, insurance_registered, annual_leave_days,
       opening_leave_days, opening_as_of, opening_eos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (contact_id) DO UPDATE SET nationality=$3, id_number=$4, passport_no=$5, date_of_birth=$6, join_date=$7, contract_type=$8, contract_end=$9,
       basic=$10, housing=$11, transport=$12, other_allowance=$13, iban=$14, bank_routing=$15, wps_person_id=$16, insurance_no=$17, insurance_registered=$18,
       annual_leave_days=$19, opening_leave_days=$20, opening_as_of=$21, opening_eos=$22`, v);
}

export async function hrSettings(db: Db, companyId: string) {
  const r = (await db.query(`SELECT employer_id AS "employerId", bank_routing AS "bankRouting", insurance_no AS "insuranceNo" FROM company_hr_settings WHERE company_id = $1`, [companyId])).rows[0];
  return r ?? { employerId: null, bankRouting: null, insuranceNo: null };
}
export async function saveHrSettings(db: Db, companyId: string, s: { employerId?: string; bankRouting?: string; insuranceNo?: string }) {
  await db.query(`INSERT INTO company_hr_settings (company_id, employer_id, bank_routing, insurance_no) VALUES ($1,$2,$3,$4)
    ON CONFLICT (company_id) DO UPDATE SET employer_id=$2, bank_routing=$3, insurance_no=$4`, [companyId, t(s.employerId), t(s.bankRouting), t(s.insuranceNo)]);
}

// ------------------------------------------------------------------ leave
export interface LeaveRow { id: string; contactId: string; name: string; nameAr: string | null; kind: string; startDate: string; endDate: string; days: number; reason: string | null;
  status: string; createdBy: string | null; decidedBy: string | null }
async function leaves(db: Db, companyId: string, where = '', args: unknown[] = []): Promise<LeaveRow[]> {
  return (await db.query(
    `SELECT l.id, l.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", l.kind, l.start_date::text AS "startDate", l.end_date::text AS "endDate", l.days,
            l.reason, l.status, person_name(l.created_by) AS "createdBy", person_name(l.decided_by) AS "decidedBy"
     FROM leave_requests l JOIN contacts c ON c.id = l.contact_id WHERE l.company_id = $1 ${where} ORDER BY l.start_date DESC`, [companyId, ...args])).rows;
}
export const listLeave = (db: Db, companyId: string, status = '') =>
  leaves(db, companyId, status ? 'AND l.status = $2' : '', status ? [status] : []);

export async function saveLeave(db: Db, companyId: string, x: { contactId?: string; kind?: string; startDate?: string; endDate?: string; reason?: string; approve?: boolean }): Promise<string> {
  if (!x.contactId) bad('Choose the employee.', 'err.employee');
  const kind = ['annual', 'sick', 'unpaid', 'other_paid'].includes(String(x.kind)) ? String(x.kind) : bad('Choose the type of leave.', 'err.leaveKind');
  const start = dateOrNull(x.startDate) ?? bad('Enter the dates.', 'err.date');
  const end = dateOrNull(x.endDate) ?? start;
  if (end < start) bad('The last day is before the first day.', 'err.leaveDates');
  const e = await employee(db, x.contactId!);
  if (e.joinDate && start < e.joinDate) bad('The leave starts before the person joined.', 'err.leaveBeforeJoin');
  return (await db.query(
    `INSERT INTO leave_requests (company_id, contact_id, kind, start_date, end_date, days, reason, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, app_user_id()) RETURNING id`,
    [companyId, x.contactId, kind, start, end, P.daysBetween(start, end), t(x.reason), x.approve ? 'approved' : 'requested'])).rows[0].id;
}
export async function decideLeave(db: Db, id: string, status: string): Promise<void> {
  if (!['approved', 'rejected', 'cancelled'].includes(status)) bad('Choose approve, reject or cancel.', 'err.leaveStatus');
  const { rowCount } = await db.query('UPDATE leave_requests SET status = $2 WHERE id = $1', [id, status]);
  if (!rowCount) notFound();
}

/** Annual leave: earned to the date (by law or the person's own days a year), plus the opening balance, less approved annual leave. */
export async function leaveBalance(db: Db, e: Emp, asOf: string): Promise<{ earned: number; opening: number; taken: number; balance: number }> {
  if (!e.joinDate) return { earned: 0, opening: 0, taken: 0, balance: 0 };
  const from = e.openingAsOf && e.openingAsOf > e.joinDate ? addDays(e.openingAsOf, 1) : e.joinDate;
  const until = e.leavingDate && e.leavingDate < asOf ? e.leavingDate : asOf;
  const earnedAll = P.leaveEarnedHundredths(e.country, e.joinDate, until, e.annualLeaveDays);
  const earnedBefore = from > e.joinDate ? P.leaveEarnedHundredths(e.country, e.joinDate, prevDay(from), e.annualLeaveDays) : 0;
  const earned = Math.max(earnedAll - earnedBefore, 0);
  const opening = Math.round(Number(e.openingLeaveDays) * 100);
  const taken = (await db.query(
    `SELECT coalesce(sum(least(end_date, $3::date) - greatest(start_date, $2::date) + 1), 0)::int AS d FROM leave_requests
     WHERE contact_id = $1 AND kind = 'annual' AND status = 'approved' AND end_date >= $2 AND start_date <= $3`, [e.id, from, until])).rows[0].d * 100;
  return { earned: earned / 100, opening: opening / 100, taken: taken / 100, balance: (earned + opening - taken) / 100 };
}
export async function leaveBalances(db: Db, companyId: string, asOf = today()) {
  const out = [];
  for (const e of (await employees(db, companyId)).filter((x) => x.hasProfile && !x.settled)) {
    out.push({ contactId: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, perYear: e.annualLeaveDays ?? P.annualLeaveDays(e.country, P.daysBetween(e.joinDate!, asOf)), ...(await leaveBalance(db, e, asOf)) });
  }
  return out;
}

/** Days of approved leave of a kind inside the month. */
async function leaveDaysIn(db: Db, contactId: string, kind: string, from: string, to: string): Promise<number> {
  return (await db.query(
    `SELECT coalesce(sum(least(end_date, $4::date) - greatest(start_date, $3::date) + 1), 0)::int AS d FROM leave_requests
     WHERE contact_id = $1 AND kind = $2 AND status = 'approved' AND end_date >= $3 AND start_date <= $4`, [contactId, kind, from, to])).rows[0].d;
}

// ------------------------------------------------------------------ attendance (monthly sheet)
const monthStartOf = (periodEnd: string) => `${periodEnd.slice(0, 7)}-01`;
const checkMonth = (periodEnd: unknown): string => {
  const p = String(periodEnd ?? '');
  if (!DATE.test(p) || monthEnd(p) !== p) bad('Choose the month.', 'err.date');
  return p;
};
/** Employees on the books in a month: joined by its end, not settled before it starts. */
const inMonth = (e: Emp, periodEnd: string) => e.hasProfile && e.joinDate! <= periodEnd && (!e.leavingDate || e.leavingDate >= monthStartOf(periodEnd));

export async function attendance(db: Db, companyId: string, periodEnd: string) {
  checkMonth(periodEnd);
  const sheet = new Map((await db.query(`SELECT contact_id, absent_days, overtime_hours::text AS ot, notes FROM hr_attendance WHERE company_id = $1 AND period_end = $2`,
    [companyId, periodEnd])).rows.map((r) => [r.contact_id, r]));
  const posted = (await db.query(`SELECT 1 FROM payroll_runs WHERE company_id = $1 AND period_end = $2 AND status <> 'draft'`, [companyId, periodEnd])).rows.length > 0;
  const rows = [];
  for (const e of (await employees(db, companyId)).filter((x) => inMonth(x, periodEnd))) {
    const a = sheet.get(e.id);
    const from = monthStartOf(periodEnd);
    const fromClock = (await db.query('SELECT has_days FROM attendance_month_totals($1, $2)', [e.id, periodEnd])).rows[0].has_days as boolean;
    rows.push({ contactId: e.id, fromClock, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, absentDays: a?.absent_days ?? 0, overtimeHours: a?.ot ?? '0.00', notes: a?.notes ?? '',
      annualLeave: await leaveDaysIn(db, e.id, 'annual', from, periodEnd), sickLeave: await leaveDaysIn(db, e.id, 'sick', from, periodEnd),
      unpaidLeave: await leaveDaysIn(db, e.id, 'unpaid', from, periodEnd), otherLeave: await leaveDaysIn(db, e.id, 'other_paid', from, periodEnd) });
  }
  return { periodEnd, posted, rows };
}

export async function saveAttendance(db: Db, companyId: string, periodEnd: string, rows: { contactId?: string; employeeNo?: string; absentDays?: unknown; overtimeHours?: unknown; notes?: string }[]) {
  checkMonth(periodEnd);
  const staff = await employees(db, companyId);
  const problems: string[] = [];
  for (const r of rows ?? []) {
    const e = staff.find((x) => (r.contactId && x.id === r.contactId) || (r.employeeNo && x.employeeNo === String(r.employeeNo).trim()));
    if (!e) { problems.push(String(r.employeeNo ?? r.contactId ?? '?')); continue; }
    const absent = Number(String(r.absentDays ?? '0').trim() || 0);
    if (!Number.isInteger(absent) || absent < 0 || absent > 31) bad(`Absent days for ${e.name} must be a whole number of days.`, 'err.absentDays', [e.name]);
    let ot: number;
    try { ot = P.hoursToHundredths(String(r.overtimeHours ?? '0')); } catch { return bad(`Overtime hours for ${e.name} have at most 2 decimals.`, 'err.overtimeHours', [e.name]); }
    // A month that comes from the time clock keeps its numbers; only the notes change here.
    const clock = (await db.query('SELECT has_days, absent, overtime::text FROM attendance_month_totals($1, $2)', [e.id, periodEnd])).rows[0];
    if (clock.has_days) {
      await db.query(`UPDATE hr_attendance SET notes = $3 WHERE contact_id = $1 AND period_end = $2`, [e.id, periodEnd, t(r.notes)]);
      continue;
    }
    await db.query(`INSERT INTO hr_attendance (company_id, contact_id, period_end, absent_days, overtime_hours, notes) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (contact_id, period_end) DO UPDATE SET absent_days = $4, overtime_hours = $5, notes = $6`, [companyId, e.id, periodEnd, absent, (ot / 100).toFixed(2), t(r.notes)]);
  }
  if (problems.length) bad('Some employee numbers were not found.', 'err.attendanceUnknown', problems);
  return { saved: (rows ?? []).length };
}

/** Attendance file: employee number, absent days, overtime hours (comma, semicolon or tab separated; a header line is skipped). */
export function parseAttendanceCsv(text: string) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')))
    .filter((c) => c.length >= 2 && /\d/.test(c[1] ?? ''))
    .map(([employeeNo, absentDays, overtimeHours]) => ({ employeeNo, absentDays, overtimeHours: overtimeHours ?? '0' }));
}

// ------------------------------------------------------------------ loans and advances
export async function listLoans(db: Db, companyId: string) {
  return (await db.query(
    `SELECT l.id, l.number, l.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", l.issue_date::text AS "issueDate", l.amount::text, l.installment::text,
            loan_balance(l.id)::numeric(18,2)::text AS balance, l.notes, l.entry_id AS "entryId"
     FROM employee_loans l JOIN contacts c ON c.id = l.contact_id WHERE l.company_id = $1 ORDER BY l.issue_date DESC, l.number DESC`, [companyId])).rows;
}
async function openLoan(db: Db, contactId: string): Promise<{ id: string; installment: Minor; balance: Minor } | null> {
  const r = (await db.query(
    `SELECT id, installment::text, loan_balance(id)::text AS balance FROM employee_loans WHERE contact_id = $1 AND loan_balance(id) > 0 ORDER BY issue_date LIMIT 1`, [contactId])).rows[0];
  return r ? { id: r.id, installment: toMinor(r.installment), balance: toMinor(r.balance) } : null;
}
export async function issueLoan(db: Db, companyId: string, x: { contactId?: string; date?: string; amount?: string; installment?: string; bankAccountId?: string; notes?: string }): Promise<string> {
  if (!x.contactId) bad('Choose the employee.', 'err.employee');
  const e = await employee(db, x.contactId!);
  if (e.companyId !== companyId) notFound();
  if (e.settled) bad('This person has left.', 'err.employeeLeft');
  if (await openLoan(db, e.id)) bad('This person still has a loan being repaid. Finish it first.', 'err.loanOpen');
  const date = dateOrNull(x.date) ?? bad('Enter the date.', 'err.date');
  const amount = money(x.amount), installment = money(x.installment) || amount;
  if (amount <= 0n) bad('Enter the amount.', 'err.amount');
  if (installment > amount) bad('The monthly repayment cannot be more than the loan.', 'err.loanInstallment');
  const bank = await bankAccount(db, companyId, x.bankAccountId);
  const id = randomUUID();
  const number = await nextNumber(db, companyId, 'loan', 'LN-');
  const entryId = await postEntry(db, { companyId, entryDate: date, memo: `${number} · ${e.name}`, sourceType: 'employee_loan', sourceId: id,
    lines: [{ accountId: await accountByCode(db, companyId, SYSTEM_ACCOUNTS.employeeLoans), debit: fromMinor(amount) }, { accountId: bank, credit: fromMinor(amount) }] });
  await db.query(`INSERT INTO employee_loans (id, company_id, contact_id, number, issue_date, amount, installment, paid_from, entry_id, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, app_user_id())`, [id, companyId, e.id, number, date, fromMinor(amount), fromMinor(installment), bank, entryId, t(x.notes)]);
  return id;
}

// ------------------------------------------------------------------ end of service
async function provisionHeld(db: Db, e: Emp): Promise<Minor> {
  const r = (await db.query(`SELECT coalesce(sum(l.eos_accrual), 0)::text AS v FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
    WHERE l.contact_id = $1 AND r.status <> 'draft'`, [e.id])).rows[0].v;
  return toMinor(e.openingEos) + toMinor(r);
}

/** End of service for everyone: what the law gives today (and on resignation) next to the provision in the books. */
export async function eosSummary(db: Db, companyId: string, asOf = today()) {
  const rows = [];
  for (const e of (await employees(db, companyId)).filter((x) => x.hasProfile && !x.settled && x.joinDate! <= asOf)) {
    const pay = payOf(e);
    const full = P.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'termination' });
    const resign = P.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'resignation' });
    const accrued = P.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: asOf, pay, reason: 'termination' }, true);
    rows.push({ contactId: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo, joinDate: e.joinDate, serviceDays: full.serviceDays,
      basis: fromMinor(full.basis), full: fromMinor(full.amount), onResignation: fromMinor(resign.amount), accrued: fromMinor(accrued.amount), provision: fromMinor(await provisionHeld(db, e)) });
  }
  const books = (await db.query(`SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2`, [companyId, SYSTEM_ACCOUNTS.eosProvision])).rows[0].v;
  return { asOf, rows, books };
}

/** What a final settlement would pay: end of service by the reason, unused leave, less a loan still open. */
export async function settlementPreview(db: Db, contactId: string, x: { leavingDate?: string; reason?: string }) {
  const e = await employee(db, contactId);
  if (!e.hasProfile) bad('Enter this person\'s HR details first.', 'err.noProfile');
  if (e.settled) bad('This person\'s final settlement is already done.', 'err.settled');
  const leavingDate = dateOrNull(x.leavingDate) ?? bad('Enter the leaving date.', 'err.date');
  if (leavingDate < e.joinDate!) bad('The leaving date is before the join date.', 'err.leavingDate');
  const reason = P.LEAVING_REASONS.includes(x.reason as P.LeavingReason) ? (x.reason as P.LeavingReason) : bad('Choose why the person is leaving.', 'err.leavingReason');
  const pay = payOf(e);
  const eos = P.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: leavingDate, pay, reason });
  const leave = await leaveBalance(db, { ...e, leavingDate }, leavingDate);
  const leaveHundredths = Math.max(Math.round(leave.balance * 100), 0);
  const leavePay = P.leaveDaysPay(e.country, pay, leaveHundredths);
  const loan = await openLoan(db, e.id);
  const loanRecovered = loan ? (loan.balance < eos.amount + leavePay ? loan.balance : eos.amount + leavePay) : 0n;
  const provision = await provisionHeld(db, e);
  return { contactId: e.id, name: e.name, leavingDate, reason, serviceDays: eos.serviceDays, basis: fromMinor(eos.basis), share: eos.share, eosFull: fromMinor(eos.full),
    eosAmount: fromMinor(eos.amount), leaveDays: (leaveHundredths / 100).toFixed(2), leavePay: fromMinor(leavePay), loanId: loan?.id ?? null, loanBalance: fromMinor(loan?.balance ?? 0n),
    loanRecovered: fromMinor(loanRecovered), provision: fromMinor(provision), totalDue: fromMinor(eos.amount + leavePay - loanRecovered), costCentreId: e.costCentreId };
}

/** Records the final settlement and posts it; the amount due waits in 2210 Salaries payable until paid. */
export async function settle(db: Db, contactId: string, x: { leavingDate?: string; reason?: string }): Promise<string> {
  const s = await settlementPreview(db, contactId, x);
  const e = await employee(db, contactId);
  const id = randomUUID();
  const acc = (code: string) => accountByCode(db, e.companyId, code);
  const eos = toMinor(s.eosAmount), provision = toMinor(s.provision), leavePay = toMinor(s.leavePay), loan = toMinor(s.loanRecovered), due = toMinor(s.totalDue);
  const lines = [
    ...(provision > 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.eosProvision), debit: fromMinor(provision) }] : provision < 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.eosProvision), credit: fromMinor(-provision) }] : []),
    ...(eos - provision > 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.eosExpense), costCentreId: e.costCentreId, debit: fromMinor(eos - provision) }]
      : eos - provision < 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.eosExpense), costCentreId: e.costCentreId, credit: fromMinor(provision - eos) }] : []),
    ...(leavePay > 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.salaries), costCentreId: e.costCentreId, debit: fromMinor(leavePay) }] : []),
    ...(loan > 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.employeeLoans), credit: fromMinor(loan) }] : []),
    ...(due > 0n ? [{ accountId: await acc(SYSTEM_ACCOUNTS.salariesPayable), credit: fromMinor(due) }] : []),
  ];
  if (lines.length < 2) bad('There is nothing to settle for this person.', 'err.nothingToSettle');
  const entryId = await postEntry(db, { companyId: e.companyId, entryDate: s.leavingDate, memo: `Final settlement · ${e.name}`, sourceType: 'eos_settlement', sourceId: id, lines });
  await db.query(`INSERT INTO eos_settlements (id, company_id, contact_id, leaving_date, reason, service_days, eos_amount, provision, leave_days, leave_pay, loan_id,
      loan_recovered, total_due, entry_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, app_user_id())`,
    [id, e.companyId, e.id, s.leavingDate, s.reason, s.serviceDays, s.eosAmount, s.provision, s.leaveDays, s.leavePay, loan > 0n ? s.loanId : null, s.loanRecovered, s.totalDue, entryId]);
  return id;
}
export async function listSettlements(db: Db, companyId: string) {
  return (await db.query(`SELECT s.id, s.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", s.leaving_date::text AS "leavingDate", s.reason, s.service_days AS "serviceDays",
      s.eos_amount::text AS "eosAmount", s.leave_days::text AS "leaveDays", s.leave_pay::text AS "leavePay", s.loan_recovered::text AS "loanRecovered", s.total_due::text AS "totalDue", s.entry_id AS "entryId"
    FROM eos_settlements s JOIN contacts c ON c.id = s.contact_id WHERE s.company_id = $1 ORDER BY s.leaving_date DESC`, [companyId])).rows;
}

// ------------------------------------------------------------------ payroll
const LINE_COLS = `l.id, l.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", c.employee_no AS "employeeNo", c.job_title AS "jobTitle", l.cost_centre_id AS "costCentreId",
  l.unpaid_days AS "unpaidDays", l.absent_days AS "absentDays", l.sick_unpaid AS "sickUnpaid", l.overtime_hours::text AS "overtimeHours", l.loan_id AS "loanId", l.note,
  l.basic::text, l.housing::text, l.transport::text, l.other_allowance::text AS "otherAllowance", l.overtime::text, l.bonus::text, l.gross::text, l.absence::text, l.sick::text,
  l.insurance_employee::text AS "insuranceEmployee", l.insurance_employer::text AS "insuranceEmployer", l.loan::text, l.other_deductions::text AS "otherDeductions",
  l.net::text, l.eos_accrual::text AS "eosAccrual"`;
const RUN_COLS = `r.id, r.period_end::text AS "periodEnd", r.status, r.total_gross::text AS "totalGross", r.total_net::text AS "totalNet", r.total_employer::text AS "totalEmployer",
  r.entry_id AS "entryId", r.payment_entry_id AS "paymentEntryId", r.paid_on::text AS "paidOn", person_name(r.created_by) AS "createdBy", person_name(r.posted_by) AS "postedBy",
  (SELECT count(*) FROM payroll_lines l WHERE l.run_id = r.id)::int AS people`;

export const listRuns = async (db: Db, companyId: string) =>
  (await db.query(`SELECT ${RUN_COLS} FROM payroll_runs r WHERE r.company_id = $1 ORDER BY r.period_end DESC`, [companyId])).rows;

export async function getRun(db: Db, id: string) {
  const run = (await db.query(`SELECT ${RUN_COLS}, r.company_id AS "companyId" FROM payroll_runs r WHERE r.id = $1`, [id])).rows[0] ?? notFound();
  const lines = (await db.query(`SELECT ${LINE_COLS} FROM payroll_lines l JOIN contacts c ON c.id = l.contact_id WHERE l.run_id = $1 ORDER BY c.name`, [id])).rows;
  const sum = (k: string) => fromMinor(lines.reduce((s: Minor, l: Record<string, string>) => s + toMinor(l[k]!), 0n));
  const totals = Object.fromEntries(['basic', 'housing', 'transport', 'otherAllowance', 'overtime', 'bonus', 'gross', 'absence', 'sick', 'insuranceEmployee', 'insuranceEmployer',
    'loan', 'otherDeductions', 'net', 'eosAccrual'].map((k) => [k, sum(k)]));
  const missing = (await employees(db, run.companyId)).filter((e) => !e.hasProfile && e.status === 'active').map((e) => e.name);
  return { ...run, lines, totals, missingDetails: missing };
}

/** One person's month from their HR details, leave, attendance and loan; kept bonus, other deductions and note. */
async function computeLine(db: Db, e: Emp, periodEnd: string, kept: { bonus: Minor; otherDeductions: Minor; note: string | null }) {
  const from = monthStartOf(periodEnd);
  const att = (await db.query(`SELECT absent_days, overtime_hours::text AS ot FROM hr_attendance WHERE contact_id = $1 AND period_end = $2`, [e.id, periodEnd])).rows[0];
  const unpaid = await leaveDaysIn(db, e.id, 'unpaid', from, periodEnd);
  const sickNow = await leaveDaysIn(db, e.id, 'sick', from, periodEnd);
  const yearAgo = addDays(from, -365);
  const sickBefore = await leaveDaysIn(db, e.id, 'sick', yearAgo, prevDay(from));
  const loan = e.settled ? null : await openLoan(db, e.id);
  const pay = payOf(e);
  const base: P.PayLineInput = { country: e.country, national: e.national, registeredOn: e.insuranceRegistered, pay, periodEnd, joinDate: e.joinDate!, endDate: e.leavingDate,
    unpaidLeaveDays: unpaid, absentDays: att?.absent_days ?? 0, sickUnpaidHundredths: P.sickUnpaidHundredths(e.country, sickBefore, sickNow),
    overtimeHundredths: P.hoursToHundredths(att?.ot ?? '0'), bonus: kept.bonus, otherDeductions: kept.otherDeductions, loanDeduction: 0n };
  const before = P.payLine(base);
  const loanDeduction = loan ? [loan.installment, loan.balance, before.net > 0n ? before.net : 0n].reduce((a, b) => (a < b ? a : b)) : 0n;
  const l = P.payLine({ ...base, loanDeduction });
  if (l.net < 0n) bad(`Deductions for ${e.name} are more than the pay this month. Lower the other deductions.`, 'err.payrollNegative', [e.name]);
  let eos = 0n;
  if (!e.settled) {
    const end = e.leavingDate && e.leavingDate < periodEnd ? e.leavingDate : periodEnd;
    const target = P.endOfService({ country: e.country, joinDate: e.joinDate!, endDate: end, pay, reason: 'termination' }, true).amount;
    eos = target - await provisionHeld(db, e);
  }
  return { l, loanId: loanDeduction > 0n ? loan!.id : null, unpaid, absent: base.absentDays, sickUnpaid: base.sickUnpaidHundredths, ot: (base.overtimeHundredths / 100).toFixed(2), eos, ...kept };
}

async function writeLines(db: Db, runId: string, companyId: string, periodEnd: string) {
  const kept = new Map((await db.query(`SELECT contact_id, bonus::text, other_deductions::text AS od, note FROM payroll_lines WHERE run_id = $1`, [runId])).rows
    .map((r) => [r.contact_id, { bonus: toMinor(r.bonus), otherDeductions: toMinor(r.od), note: r.note as string | null }]));
  await db.query('DELETE FROM payroll_lines WHERE run_id = $1', [runId]);
  for (const e of (await employees(db, companyId)).filter((x) => inMonth(x, periodEnd) && x.status === 'active')) {
    const c = await computeLine(db, e, periodEnd, kept.get(e.id) ?? { bonus: 0n, otherDeductions: 0n, note: null });
    const l = c.l;
    await db.query(`INSERT INTO payroll_lines (company_id, run_id, contact_id, cost_centre_id, unpaid_days, absent_days, sick_unpaid, overtime_hours, loan_id, note,
        basic, housing, transport, other_allowance, overtime, bonus, gross, absence, sick, insurance_employee, insurance_employer, loan, other_deductions, net, eos_accrual)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [companyId, runId, e.id, e.costCentreId, c.unpaid, c.absent, c.sickUnpaid, c.ot, c.loanId, c.note, ...[l.basic, l.housing, l.transport, l.other, l.overtime, l.bonus, l.gross,
        l.absence, l.sick, l.insuranceEmployee, l.insuranceEmployer, l.loan, l.otherDeductions, l.net, c.eos].map(fromMinor)]);
  }
}

/** Prepares (or brings up to date) the draft payroll for a month. */
export async function prepareRun(db: Db, companyId: string, periodEnd: string): Promise<string> {
  checkMonth(periodEnd);
  if (periodEnd > monthEnd(today())) bad('Payroll cannot be prepared for a future month.', 'err.payrollFuture');
  const existing = (await db.query('SELECT id, status FROM payroll_runs WHERE company_id = $1 AND period_end = $2', [companyId, periodEnd])).rows[0];
  if (existing && existing.status !== 'draft') bad('Payroll for this month is already posted.', 'err.payrollPosted');
  const id = existing?.id ?? (await db.query('INSERT INTO payroll_runs (company_id, period_end, created_by) VALUES ($1, $2, app_user_id()) RETURNING id', [companyId, periodEnd])).rows[0].id;
  await writeLines(db, id, companyId, periodEnd);
  return id;
}

/** Changes a person's bonus, other deductions or note on a draft payroll and works the line out again. */
export async function updateLine(db: Db, lineId: string, x: { bonus?: string; otherDeductions?: string; note?: string }) {
  const r = (await db.query(`SELECT l.run_id, l.contact_id, r.period_end::text AS pe, r.status, r.company_id FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.id = $1`, [lineId])).rows[0] ?? notFound();
  if (r.status !== 'draft') bad('Posted payroll never changes. Correct it in a later month.', 'err.payrollPosted');
  const e = await employee(db, r.contact_id);
  const c = await computeLine(db, e, r.pe, { bonus: money(x.bonus), otherDeductions: money(x.otherDeductions), note: t(x.note) });
  const l = c.l;
  await db.query(`UPDATE payroll_lines SET unpaid_days=$2, absent_days=$3, sick_unpaid=$4, overtime_hours=$5, loan_id=$6, note=$7, basic=$8, housing=$9, transport=$10,
      other_allowance=$11, overtime=$12, bonus=$13, gross=$14, absence=$15, sick=$16, insurance_employee=$17, insurance_employer=$18, loan=$19, other_deductions=$20, net=$21, eos_accrual=$22
    WHERE id = $1`, [lineId, c.unpaid, c.absent, c.sickUnpaid, c.ot, c.loanId, c.note, ...[l.basic, l.housing, l.transport, l.other, l.overtime, l.bonus, l.gross, l.absence, l.sick,
      l.insuranceEmployee, l.insuranceEmployer, l.loan, l.otherDeductions, l.net, c.eos].map(fromMinor)]);
}

export async function deleteDraft(db: Db, id: string) {
  const { rowCount } = await db.query(`DELETE FROM payroll_runs WHERE id = $1 AND status = 'draft'`, [id]);
  if (!rowCount) bad('Only a draft payroll can be removed.', 'err.payrollPosted');
}

/** Brings the draft up to date, then posts it as one journal entry. */
export async function postRun(db: Db, id: string): Promise<string> {
  const run0 = (await db.query('SELECT company_id, period_end::text AS pe, status FROM payroll_runs WHERE id = $1', [id])).rows[0] ?? notFound();
  if (run0.status !== 'draft') bad('Payroll for this month is already posted.', 'err.payrollPosted');
  const companyId: string = run0.company_id, periodEnd: string = run0.pe;
  await writeLines(db, id, companyId, periodEnd);
  const run = await getRun(db, id);
  if (!run.lines.length) bad('There is nobody to pay in this payroll.', 'err.payrollEmpty');
  const acc = (code: string) => accountByCode(db, companyId, code);
  const salaries = await acc(SYSTEM_ACCOUNTS.salaries);
  if ((await db.query('SELECT cost_centre_required FROM accounts WHERE id = $1', [salaries])).rows[0].cost_centre_required) {
    const none = run.lines.filter((l: { costCentreId: string | null }) => !l.costCentreId).map((l: { name: string }) => l.name);
    if (none.length) bad('Salaries need a cost centre. Give these employees a cost centre first.', 'err.payrollCostCentre', none);
  }
  type G = { cc: string | null; salary: Minor; employer: Minor; eos: Minor };
  const groups = new Map<string, G>();
  let insurance = 0n, loans = 0n, net = 0n, eos = 0n;
  for (const l of run.lines as Record<string, string>[]) {
    const k = l.costCentreId ?? '';
    const g = groups.get(k) ?? { cc: l.costCentreId ?? null, salary: 0n, employer: 0n, eos: 0n };
    g.salary += toMinor(l.gross!) - toMinor(l.absence!) - toMinor(l.sick!) - toMinor(l.otherDeductions!);
    g.employer += toMinor(l.insuranceEmployer!); g.eos += toMinor(l.eosAccrual!);
    groups.set(k, g);
    insurance += toMinor(l.insuranceEmployee!) + toMinor(l.insuranceEmployer!); loans += toMinor(l.loan!); net += toMinor(l.net!); eos += toMinor(l.eosAccrual!);
  }
  const side = (accountId: string, v: Minor, cc?: string | null) => (v > 0n ? [{ accountId, costCentreId: cc ?? null, debit: fromMinor(v) }] : v < 0n ? [{ accountId, costCentreId: cc ?? null, credit: fromMinor(-v) }] : []);
  const [ins, eosExp, eosProv, loanAcc, payable] = [await acc(SYSTEM_ACCOUNTS.insuranceExpense), await acc(SYSTEM_ACCOUNTS.eosExpense), await acc(SYSTEM_ACCOUNTS.eosProvision),
    await acc(SYSTEM_ACCOUNTS.employeeLoans), await acc(SYSTEM_ACCOUNTS.salariesPayable)];
  const lines = [
    ...[...groups.values()].flatMap((g) => [...side(salaries, g.salary, g.cc), ...side(ins, g.employer, g.cc), ...side(eosExp, g.eos, g.cc)]),
    ...side(eosProv, -eos), ...side(await acc(SYSTEM_ACCOUNTS.insurancePayable), -insurance), ...side(loanAcc, -loans), ...side(payable, -net),
  ];
  const entryId = await postEntry(db, { companyId, entryDate: periodEnd, memo: `Payroll ${periodEnd.slice(0, 7)}`, sourceType: 'payroll', sourceId: id, lines });
  await db.query(`UPDATE payroll_runs SET status = 'posted', entry_id = $2, total_gross = $3, total_net = $4, total_employer = $5 WHERE id = $1`,
    [id, entryId, run.totals.gross, run.totals.net, run.totals.insuranceEmployer]);
  return entryId;
}

/** Pays the net salaries from a bank account: Dr 2210 / Cr bank. */
export async function payRun(db: Db, id: string, x: { bankAccountId?: string; date?: string }): Promise<string> {
  const r = (await db.query('SELECT company_id, period_end::text AS pe, status, total_net::text AS net FROM payroll_runs WHERE id = $1', [id])).rows[0] ?? notFound();
  if (r.status === 'draft') bad('Post the payroll before paying it.', 'err.payrollNotPosted');
  if (r.status === 'paid') bad('This payroll is already paid.', 'err.payrollPaid');
  const bank = await bankAccount(db, r.company_id, x.bankAccountId);
  const date = dateOrNull(x.date) ?? bad('Enter the date.', 'err.date');
  if (date < monthStartOf(r.pe)) bad('Salaries are paid in or after their month.', 'err.payDate');
  const entryId = await postEntry(db, { companyId: r.company_id, entryDate: date, memo: `Salaries paid ${r.pe.slice(0, 7)}`, sourceType: 'payroll_payment', sourceId: id,
    lines: [{ accountId: await accountByCode(db, r.company_id, SYSTEM_ACCOUNTS.salariesPayable), debit: r.net }, { accountId: bank, credit: r.net }] });
  await db.query(`UPDATE payroll_runs SET status = 'paid', paid_from = $2, paid_on = $3, payment_entry_id = $4 WHERE id = $1`, [id, bank, date, entryId]);
  return entryId;
}

/** The salary transfer file: UAE WPS SIF, or the Saudi payroll file for Mudad or the bank. */
export async function wpsFile(db: Db, id: string): Promise<{ fileName: string; contentType: string; content: string }> {
  const run = await getRun(db, id);
  if (run.status === 'draft') bad('Post the payroll before making the salary file.', 'err.payrollNotPosted');
  const country = await companyCountry(db, run.companyId);
  const settings = await hrSettings(db, run.companyId);
  const staff = new Map((await employees(db, run.companyId)).map((e) => [e.id, e]));
  const missing: string[] = [];
  const rows: P.WpsRow[] = (run.lines as Record<string, string>[]).map((l) => {
    const e = staff.get(l.contactId!)!;
    if (!e.iban || (country === 'AE' && (!e.wpsPersonId || !e.bankRouting))) missing.push(e.name);
    // Variable pay is overtime and bonus; fixed pay is the rest of what is paid, so fixed + variable = net.
    const extra = toMinor(l.overtime!) + toMinor(l.bonus!), netPay = toMinor(l.net!);
    const variable = extra < netPay ? extra : netPay, fixed = netPay - variable;
    const deductions = toMinor(l.absence!) + toMinor(l.sick!) + toMinor(l.insuranceEmployee!) + toMinor(l.loan!) + toMinor(l.otherDeductions!);
    return { personId: e.wpsPersonId ?? '', routing: e.bankRouting ?? '', iban: e.iban ?? '', name: e.name, employeeNo: e.employeeNo ?? '', idNumber: e.idNumber ?? '',
      fixed, variable, deductions, net: toMinor(l.net!), leaveDays: 0,
      basic: toMinor(l.basic!), housing: toMinor(l.housing!), otherAllowances: toMinor(l.transport!) + toMinor(l.otherAllowance!) + toMinor(l.overtime!) + toMinor(l.bonus!) };
  });
  if (country === 'AE' && (!settings.employerId || !settings.bankRouting)) missing.unshift('—');
  if (missing.length) bad('The salary file needs bank details for everyone (and, in the UAE, the WPS IDs).', 'err.wpsMissing', missing);
  const month = run.periodEnd.slice(0, 7);
  if (country === 'AE') {
    return { fileName: `${settings.employerId}${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.SIF`, contentType: 'text/plain',
      content: P.uaeSif({ employerId: settings.employerId!, routing: settings.bankRouting!, periodEnd: run.periodEnd, createdAt: new Date(), rows }) };
  }
  return { fileName: `payroll-${month}.csv`, contentType: 'text/csv', content: P.saudiPayrollCsv(rows) };
}

// ------------------------------------------------------------------ HR documents
const DOC_KINDS = ['national_id', 'iqama', 'emirates_id', 'passport', 'visa', 'work_permit', 'contract', 'medical_insurance', 'driving_licence', 'other'];
export async function listDocuments(db: Db, companyId: string, contactId?: string) {
  return (await db.query(
    `SELECT d.id, d.contact_id AS "contactId", c.name, c.name_ar AS "nameAr", d.kind, d.number, d.issue_date::text AS "issueDate", d.expiry_date::text AS "expiryDate", d.notes,
            (d.expiry_date - current_date)::int AS "daysLeft", (SELECT count(*) FROM attachments a WHERE a.employee_document_id = d.id)::int AS files
     FROM employee_documents d JOIN contacts c ON c.id = d.contact_id WHERE d.company_id = $1 AND ($2::uuid IS NULL OR d.contact_id = $2)
     ORDER BY d.expiry_date NULLS LAST, c.name`, [companyId, contactId ?? null])).rows;
}
export async function saveDocument(db: Db, companyId: string, x: { contactId?: string; kind?: string; number?: string; issueDate?: string; expiryDate?: string; notes?: string }, id?: string): Promise<string> {
  if (!x.contactId) bad('Choose the employee.', 'err.employee');
  if (!DOC_KINDS.includes(String(x.kind))) bad('Choose the type of document.', 'err.docKind');
  const issue = dateOrNull(x.issueDate), expiry = dateOrNull(x.expiryDate);
  if (issue && expiry && expiry < issue) bad('The expiry date is before the issue date.', 'err.docDates');
  const v = [x.contactId, x.kind, t(x.number), issue, expiry, t(x.notes)];
  if (id) {
    const { rowCount } = await db.query('UPDATE employee_documents SET contact_id=$2, kind=$3, number=$4, issue_date=$5, expiry_date=$6, notes=$7 WHERE id = $1', [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query('INSERT INTO employee_documents (company_id, contact_id, kind, number, issue_date, expiry_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [companyId, ...v])).rows[0].id;
}
export async function deleteDocument(db: Db, id: string) {
  const { rowCount } = await db.query('DELETE FROM employee_documents WHERE id = $1', [id]);
  if (!rowCount) notFound();
}

// ------------------------------------------------------------------ overview
export async function overview(db: Db, companyId: string) {
  const staff = await employees(db, companyId);
  const active = staff.filter((e) => e.status === 'active' && !e.settled);
  const withDetails = active.filter((e) => e.hasProfile);
  const runs = await listRuns(db, companyId);
  const docs = (await listDocuments(db, companyId)).filter((d: { daysLeft: number | null }) => d.daysLeft !== null && d.daysLeft <= 60);
  const pendingLeave = (await listLeave(db, companyId, 'requested')).length;
  const nationals = withDetails.filter((e) => e.national).length;
  const today_ = today();
  const onLeave = (await db.query(`SELECT count(DISTINCT contact_id)::int AS n FROM leave_requests WHERE company_id = $1 AND status = 'approved' AND $2 BETWEEN start_date AND end_date`, [companyId, today_])).rows[0].n;
  return {
    headcount: active.length, withoutDetails: active.length - withDetails.length, nationals, monthlyWages: fromMinor(withDetails.reduce((s, e) => s + toMinor(e.wage), 0n)),
    lastRun: runs[0] ?? null, expiring: docs.slice(0, 8), pendingLeave, onLeave,
  };
}
