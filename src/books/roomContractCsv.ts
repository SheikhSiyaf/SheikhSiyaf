// The registration record as rows and as a CSV file (shared by the API and the screen). Pure: no database.
export interface RegistrationRow { booking: string; checkIn: string; checkOut: string; guests: number; guest: string; room: string; idType: string; idNumber: string; nationality: string;
  verifiedBy: string; verifiedAt: string }
export const registrationFields = ['booking', 'checkIn', 'checkOut', 'guests', 'guest', 'room', 'idType', 'idNumber', 'nationality', 'verifiedBy', 'verifiedAt'] as const;

// A cell that starts like a formula is neutralised with a leading apostrophe, so a spreadsheet never runs a guest's name as a formula.
const csvCell = (v: unknown) => { const s = String(v ?? ''); const f = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return /[",\n\r]/.test(f) || f !== s ? `"${f.replace(/"/g, '""')}"` : f; };
export function registrationCsv(rows: RegistrationRow[]): string {
  const head = ['Booking', 'Check-in', 'Check-out', 'Guests', 'Guest', 'Room', 'ID type', 'ID number', 'Nationality', 'Verified by', 'Verified at'];
  return '﻿' + [head, ...rows.map((r) => registrationFields.map((k) => r[k]))].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
