// Time-clock files into daily attendance (pure functions, shared by the server and the demo).
//
// Two layouts are read, with headers in English or Arabic, in any order, below a title if there is one:
//   * one row per person per day: employee number, date, time in, time out (or hours worked, or a status P / A / off);
//   * punches, as most time clocks export them: employee number and date-time, one row per punch
//     (the first punch of a day is the time in, the last the time out).
// For the month chosen, each person in the file gets one status per day:
//   present (clocked in, or marked present), absent (a working day with no punch), leave (approved leave covers the day),
//   off (weekend or public holiday with no punch; a punch on a day off is present, and all its hours are overtime).
// Days before the person joined or after they left are not counted, nor days after the last date in the file
// (a month still running is imported up to the day the file was taken). Overtime is the time worked beyond the normal
// hours of the day (8 by default: Saudi Labour Law art. 98 and UAE Labour Law art. 17), in hundredths of an hour.

export type DayStatus = 'present' | 'absent' | 'leave' | 'off';

const AR_DIGITS = /[٠-٩۰-۹]/g;
const digits = (s: string) => s.replace(AR_DIGITS, (d) => { const i = '٠١٢٣٤٥٦٧٨٩'.indexOf(d); return String(i >= 0 ? i : '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); });
const norm = (s: string) => digits(String(s ?? '')).trim().toLowerCase().replace(/[\s_.\-/()]+/g, ' ').trim();

const HEADERS: Record<string, string[]> = {
  employeeNo: ['employee no', 'employee number', 'emp no', 'employee id', 'emp id', 'staff no', 'no', 'ac no', 'badge', 'badge no', 'user id', 'enroll no', 'id', 'person id',
    'الرقم الوظيفي', 'رقم الموظف', 'الرقم'],
  name: ['name', 'employee name', 'employee', 'الاسم', 'اسم الموظف'],
  date: ['date', 'day', 'work date', 'التاريخ', 'اليوم'],
  dateTime: ['date time', 'datetime', 'punch time', 'check time', 'checktime', 'time stamp', 'timestamp', 'clock time', 'وقت البصمة', 'التاريخ والوقت'],
  timeIn: ['in', 'time in', 'check in', 'clock in', 'first in', 'on duty', 'الدخول', 'وقت الدخول'],
  timeOut: ['out', 'time out', 'check out', 'clock out', 'last out', 'off duty', 'الخروج', 'وقت الخروج'],
  hours: ['hours', 'worked hours', 'work hours', 'hours worked', 'work time', 'total hours', 'ساعات العمل', 'الساعات'],
  status: ['status', 'attendance', 'الحالة', 'الحضور'],
};

export interface ClockRecord { line: number; employeeNo: string; date: string; timeIn: number | null; timeOut: number | null; minutes: number | null; status: 'present' | 'absent' | 'off' | null }
export interface MappedFile { layout: 'daily' | 'punches' | null; header: number; missing: string[]; records: ClockRecord[]; problems: { line: number; problem: string }[] }

/** "2026-10-04", "04/10/2026", "4-10-2026", "2026/10/04" or an Excel day number -> "2026-10-04"; null if not a date. Day first, as in the Gulf. */
export function parseDate(v: string): string | null {
  const s = digits(String(v ?? '')).trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (r) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s))) { d = +r[1]!; m = +r[2]!; y = +r[3]!; }
  else if (/^\d{5}(\.\d+)?$/.test(s)) {   // Excel serial day (1900 system)
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return t.toISOString().slice(0, 10);
  } else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** "08:05", "8:05:30", "5:30 PM", "17.30", an Excel fraction of a day (0.354) -> minutes after midnight; null if not a time. */
export function parseTime(v: string): number | null {
  const s = digits(String(v ?? '')).trim().toLowerCase().replace('ص', 'am').replace('م', 'pm');
  if (!s) return null;
  if (/^0?\.\d+$/.test(s)) { const m = Math.round(Number(s) * 1440); return m >= 0 && m < 1440 ? m : null; }
  const r = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!r) return null;
  let h = +r[1]!; const min = +r[2]!;
  if (r[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (r[4] === 'pm' ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "8", "8.5", "7:45" hours -> minutes. */
function parseHours(v: string): number | null {
  const s = digits(String(v ?? '')).trim();
  if (!s) return null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) return +hm[1]! * 60 + +hm[2]!;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  const m = Math.round(Number(s) * 60);
  return m <= 24 * 60 ? m : null;
}

function parseStatus(v: string): ClockRecord['status'] {
  const s = norm(v);
  if (!s) return null;
  if (['p', 'present', 'حاضر', 'حضور', 'yes'].includes(s)) return 'present';
  if (['a', 'absent', 'غائب', 'غياب', 'no'].includes(s)) return 'absent';
  if (['off', 'w', 'weekend', 'h', 'holiday', 'rest', 'عطلة', 'إجازة رسمية', 'راحة'].includes(s)) return 'off';
  return null;
}

/** Splits a cell holding date and time ("2026-10-04 08:01", "04/10/2026 5:30 PM", an Excel day number with a fraction). */
function splitDateTime(v: string): { date: string | null; time: number | null } {
  const s = digits(String(v ?? '')).trim();
  if (/^\d{5}\.\d+$/.test(s)) { const n = Number(s); return { date: parseDate(String(Math.floor(n))), time: Math.round((n - Math.floor(n)) * 1440) % 1440 }; }
  const at = s.search(/[ T]\d{1,2}[:.]\d{2}/);
  if (at < 0) return { date: parseDate(s), time: null };
  return { date: parseDate(s.slice(0, at)), time: parseTime(s.slice(at + 1)) };
}

/** Finds the header row and reads the records. */
export function mapAttendance(rows: string[][]): MappedFile {
  const find = (cells: string[]) => cells.map((c) => {
    const n = norm(c);
    return Object.entries(HEADERS).find(([, names]) => names.includes(n))?.[0] ?? null;
  });
  let header = -1, cols: (string | null)[] = [];
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const c = find(rows[i] ?? []);
    if (c.includes('employeeNo') && (c.includes('date') || c.includes('dateTime'))) { header = i; cols = c; break; }
  }
  if (header < 0) return { layout: null, header: -1, missing: ['employeeNo', 'date'], records: [], problems: [] };
  const at = (k: string) => cols.indexOf(k);
  const hasTimes = at('timeIn') >= 0 || at('timeOut') >= 0 || at('hours') >= 0 || at('status') >= 0;
  const layout: MappedFile['layout'] = at('date') >= 0 && hasTimes ? 'daily' : 'punches';
  const records: ClockRecord[] = [], problems: MappedFile['problems'] = [];
  const punches = new Map<string, { line: number; employeeNo: string; date: string; times: number[] }>();
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const line = i + 1, cell = (k: string) => (at(k) >= 0 ? String(r[at(k)] ?? '') : '');
    const employeeNo = digits(cell('employeeNo')).trim();
    if (!employeeNo) { problems.push({ line, problem: 'att.p.noEmployee' }); continue; }
    if (layout === 'daily') {
      const date = parseDate(cell('date'));
      if (!date) { problems.push({ line, problem: 'att.p.date' }); continue; }
      const timeIn = parseTime(cell('timeIn')), timeOut = parseTime(cell('timeOut'));
      if ((cell('timeIn').trim() && timeIn === null) || (cell('timeOut').trim() && timeOut === null)) { problems.push({ line, problem: 'att.p.time' }); continue; }
      const hours = parseHours(cell('hours'));
      if (cell('hours').trim() && hours === null) { problems.push({ line, problem: 'att.p.hours' }); continue; }
      const minutes = timeIn !== null && timeOut !== null ? (timeOut - timeIn + 1440) % 1440 : hours;
      records.push({ line, employeeNo, date, timeIn, timeOut, minutes, status: parseStatus(cell('status')) });
    } else {
      const dt = at('dateTime') >= 0 ? splitDateTime(cell('dateTime')) : { date: parseDate(cell('date')), time: parseTime(cell('timeIn') || cell('timeOut')) };
      const date = dt.date ?? (at('date') >= 0 ? parseDate(cell('date')) : null);
      if (!date) { problems.push({ line, problem: 'att.p.date' }); continue; }
      const time = dt.time ?? parseTime(cell('timeIn'));
      if (time === null) { problems.push({ line, problem: 'att.p.time' }); continue; }
      const k = `${employeeNo}|${date}`;
      const p = punches.get(k) ?? { line, employeeNo, date, times: [] };
      p.times.push(time); punches.set(k, p);
    }
  }
  for (const p of punches.values()) {
    const ts = [...p.times].sort((a, b) => a - b);
    const one = ts.length === 1;
    records.push({ line: p.line, employeeNo: p.employeeNo, date: p.date, timeIn: ts[0]!, timeOut: one ? null : ts.at(-1)!, minutes: one ? null : ts.at(-1)! - ts[0]!, status: null });
  }
  return { layout, header, missing: [], records, problems };
}

/** Weekend days (0 Sunday … 6 Saturday): Saudi Arabia Friday and Saturday; UAE Saturday and Sunday (since 2022). */
export const defaultWeekend = (country: string): number[] => (country === 'AE' ? [6, 0] : [5, 6]);

export interface DayResult { contactId: string; day: string; status: DayStatus; checkIn: number | null; checkOut: number | null; minutes: number | null; overtimeMinutes: number;
  leaveId: string | null; flags: string[] }
export interface MonthInput {
  periodEnd: string; records: ClockRecord[]; weekend: number[]; holidays: string[]; dailyHours: number;
  employees: { id: string; employeeNo: string | null; joinDate: string | null; leavingDate: string | null }[];
  leaves: { id: string; contactId: string; startDate: string; endDate: string }[];
}
export interface MonthResult { days: DayResult[]; unknownNumbers: string[]; outsideMonth: number; inFile: string[] }

/** Two rows for the same person and day (a split shift): earliest in, latest out, time added up. */
function merge(a: ClockRecord, b: ClockRecord): ClockRecord {
  const ins = [a.timeIn, b.timeIn].filter((v): v is number => v !== null), outs = [a.timeOut, b.timeOut].filter((v): v is number => v !== null);
  return { ...b, timeIn: ins.length ? Math.min(...ins) : null, timeOut: outs.length ? Math.max(...outs) : null,
    minutes: a.minutes === null && b.minutes === null ? null : (a.minutes ?? 0) + (b.minutes ?? 0), status: b.status ?? a.status };
}

const addDay = (d: string, n = 1) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The status of every day of the month for everyone in the file. */
export function buildMonth(x: MonthInput): MonthResult {
  const start = `${x.periodEnd.slice(0, 7)}-01`;
  const byNo = new Map(x.employees.filter((e) => e.employeeNo).map((e) => [e.employeeNo!.trim().toLowerCase(), e]));
  const unknown = new Set<string>(); let outside = 0;
  const recs = new Map<string, ClockRecord>();
  for (const r of x.records) {
    if (r.date < start || r.date > x.periodEnd) { outside++; continue; }
    const e = byNo.get(r.employeeNo.toLowerCase());
    if (!e) { unknown.add(r.employeeNo); continue; }
    const k = `${e.id}|${r.date}`;
    const was = recs.get(k);
    recs.set(k, was ? merge(was, r) : r);
  }
  const inFile = [...new Set([...recs.keys()].map((k) => k.split('|')[0]!))];
  const last = [...recs.keys()].map((k) => k.split('|')[1]!).sort().at(-1) ?? x.periodEnd;
  const days: DayResult[] = [];
  const normal = Math.round(x.dailyHours * 60);
  for (const id of inFile) {
    const e = x.employees.find((y) => y.id === id)!;
    for (let d = start; d <= last; d = addDay(d)) {
      if ((e.joinDate && d < e.joinDate) || (e.leavingDate && d > e.leavingDate)) continue;
      const r = recs.get(`${id}|${d}`);
      const leave = x.leaves.find((l) => l.contactId === id && l.startDate <= d && l.endDate >= d);
      const offDay = x.weekend.includes(new Date(`${d}T00:00:00Z`).getUTCDay()) || x.holidays.includes(d);
      const clocked = r !== undefined && (r.timeIn !== null || r.timeOut !== null || (r.minutes ?? 0) > 0 || r.status === 'present');
      const flags: string[] = [];
      let status: DayStatus;
      if (leave) { status = 'leave'; if (clocked) flags.push('att.f.workedOnLeave'); }
      else if (r?.status === 'absent' && !clocked) status = offDay ? 'off' : 'absent';
      else if (clocked) status = 'present';
      else if (offDay || r?.status === 'off') status = 'off';
      else status = 'absent';
      if (r && r.timeIn !== null && r.timeOut === null && r.minutes === null) flags.push('att.f.onePunch');
      const minutes = status === 'present' ? r?.minutes ?? null : null;
      const overtime = minutes === null ? 0 : offDay ? minutes : Math.max(0, minutes - normal);
      days.push({ contactId: id, day: d, status, checkIn: r?.timeIn ?? null, checkOut: r?.timeOut ?? null, minutes, overtimeMinutes: status === 'present' ? overtime : 0,
        leaveId: status === 'leave' ? leave!.id : null, flags });
    }
  }
  return { days, unknownNumbers: [...unknown], outsideMonth: outside, inFile };
}

/** Minutes -> "HH:MM" (for times of day). */
export const clock = (m: number | null) => (m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
/** Minutes -> hours with 2 decimals, rounded half up ("1.25"). */
export const hoursText = (m: number) => { const h = Math.floor((m * 100 + 30) / 60); return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`; };

/** A file to download as an example: one row per person per day. */
export function attendanceTemplate(lang: 'en' | 'ar' = 'en') {
  const head = lang === 'ar' ? ['الرقم الوظيفي', 'الاسم', 'التاريخ', 'الدخول', 'الخروج'] : ['Employee no', 'Name', 'Date', 'Time in', 'Time out'];
  return `﻿${head.join(',')}\nE-001,Ahmed Ali,2026-10-04,07:58,17:10\nE-001,Ahmed Ali,2026-10-05,08:03,16:02\n`;
}
