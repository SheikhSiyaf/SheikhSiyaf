// HRM: HR details, attendance, leave, loans, payroll posting and payment, salary files, end of service, HR documents.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as H from '../src/books/hrmService.js';
import * as S from '../src/books/documentsService.js';
import * as P from '../src/books/payroll.js';
import { toMinor, fromMinor } from '../src/money.js';

let f: Fixture;
let saudi: string, egyptian: string, emirati: string;
const code = async (companyId: string, c: string) => (await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [companyId, c])).rows[0].id as string;
const balance = async (companyId: string, c: string) =>
  (await owner.query(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [companyId, c])).rows[0].v as string;

beforeAll(async () => {
  f = await seed();
  for (const co of [f.a, f.b]) {
    await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [co.cash]);
    for (const [c, name, type, cc] of [['1150', 'Employee loans and advances', 'asset', false], ['2210', 'Salaries payable', 'liability', false], ['2220', 'Social insurance payable', 'liability', false],
      ['2230', 'End of service provision', 'liability', false], ['5200', 'Salaries', 'expense', true], ['5210', 'Social insurance', 'expense', false], ['5220', 'End of service benefits', 'expense', false]] as const) {
      await owner.query(`INSERT INTO accounts (company_id, code, name, type, cost_centre_required) VALUES ($1,$2,$3,$4,$5)`, [co.id, c, name, type, cc]);
    }
  }
  saudi = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Faisal Al Harbi', employeeNo: 'E-001', jobTitle: 'Sales manager', defaultCostCentreId: f.a.headOffice }));
  egyptian = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isEmployee: true, name: 'Ahmed Mostafa', employeeNo: 'E-002', jobTitle: 'Storekeeper', defaultCostCentreId: f.a.branch1 }));
  await as(f.staff, (db) => H.saveProfile(db, saudi, { nationality: 'SA', joinDate: '2020-01-01', basic: '10000.00', housing: '2500.00', transport: '500.00', insuranceRegistered: '2015-01-01', idNumber: '1012345678' }));
  await as(f.staff, (db) => H.saveProfile(db, egyptian, { nationality: 'EG', joinDate: '2025-06-01', basic: '6000.00', housing: '1500.00', idNumber: '2412345678' }));
});

describe('HR details', () => {
  it('an employee needs a nationality, join date and basic salary; the IBAN is checked', async () => {
    await expect(as(f.staff, (db) => H.saveProfile(db, saudi, { nationality: 'SA', joinDate: '2020-01-01' }))).rejects.toThrow(/basic salary/);
    await expect(as(f.staff, (db) => H.saveProfile(db, saudi, { nationality: 'SA', joinDate: '2020-01-01', basic: '1.00', iban: 'nonsense' }))).rejects.toThrow(/IBAN/);
    const e = await as(f.staff, (db) => H.employee(db, saudi));
    expect(e).toMatchObject({ national: true, wage: '13000.00', country: 'SA' });
    expect((await as(f.staff, (db) => H.employee(db, egyptian))).national).toBe(false);
  });
  it('other companies and view-only users cannot see or change them', async () => {
    expect(await as(f.b.clientAccountant, (db) => H.employees(db, f.a.id))).toEqual([]);
    await expect(as(f.a.clientViewer, (db) => H.saveProfile(db, egyptian, { nationality: 'EG', joinDate: '2025-06-01', basic: '9000.00' }))).rejects.toThrow();
  });
});

describe('Leave and attendance', () => {
  it('leave is requested, approved and counted; overlapping leave is refused', async () => {
    const id = await as(f.a.clientAccountant, (db) => H.saveLeave(db, f.a.id, { contactId: saudi, kind: 'annual', startDate: '2026-09-06', endDate: '2026-09-15' }));
    await as(f.staff, (db) => H.decideLeave(db, id, 'approved'));
    await expect(as(f.staff, (db) => H.saveLeave(db, f.a.id, { contactId: saudi, kind: 'sick', startDate: '2026-09-15', endDate: '2026-09-16' }))).rejects.toThrow(/already has leave/);
    await as(f.staff, (db) => H.saveLeave(db, f.a.id, { contactId: saudi, kind: 'unpaid', startDate: '2026-10-05', endDate: '2026-10-05', approve: true }));
    const e = await as(f.staff, (db) => H.employee(db, saudi));
    const b = await as(f.staff, (db) => H.leaveBalance(db, e, '2026-10-31'));
    expect(b.taken).toBe(10);
    expect(b.earned).toBe(P.leaveEarnedHundredths('SA', '2020-01-01', '2026-10-31') / 100);
    expect(b.balance).toBeCloseTo(b.earned - 10, 2);
  });
  it('the attendance sheet takes absent days and overtime, by hand or from a file', async () => {
    await as(f.staff, (db) => H.saveAttendance(db, f.a.id, '2026-10-31', H.parseAttendanceCsv('Employee no,Absent,Overtime\nE-002,2,10\n')));
    const a = await as(f.staff, (db) => H.attendance(db, f.a.id, '2026-10-31'));
    expect(a.rows.find((r) => r.contactId === egyptian)).toMatchObject({ absentDays: 2, overtimeHours: '10.00' });
    expect(a.rows.find((r) => r.contactId === saudi)).toMatchObject({ unpaidLeave: 1 });
    await expect(as(f.staff, (db) => H.saveAttendance(db, f.a.id, '2026-10-31', [{ employeeNo: 'X-9', absentDays: 1 }]))).rejects.toThrow(/not found/);
  });
});

describe('Loans and payroll', () => {
  let run: string;
  it('a loan is paid out from the bank and repaid through payroll', async () => {
    await as(f.staff, (db) => H.issueLoan(db, f.a.id, { contactId: egyptian, date: '2026-09-20', amount: '3000.00', installment: '1000.00', bankAccountId: f.a.cash }));
    expect(await balance(f.a.id, '1150')).toBe('3000.00');
    await expect(as(f.staff, (db) => H.issueLoan(db, f.a.id, { contactId: egyptian, date: '2026-09-21', amount: '500.00', bankAccountId: f.a.cash }))).rejects.toThrow(/still has a loan/);
  });

  it('prepares the month: wage, unpaid leave, absence, overtime, GOSI, loan and end of service', async () => {
    run = await as(f.staff, (db) => H.prepareRun(db, f.a.id, '2026-10-31'));
    const r = await as(f.staff, (db) => H.getRun(db, run));
    const s = r.lines.find((l: { contactId: string }) => l.contactId === saudi);
    expect(s).toMatchObject({ gross: '13000.00', absence: '433.33', insuranceEmployee: '1218.75', insuranceEmployer: '1468.75', net: '11347.92', unpaidDays: 1 });
    const accrual = P.endOfService({ country: 'SA', joinDate: '2020-01-01', endDate: '2026-10-31', pay: { basic: toMinor('10000.00'), housing: toMinor('2500.00'), transport: toMinor('500.00'), other: 0n }, reason: 'termination' }, true).amount;
    expect(s.eosAccrual).toBe(fromMinor(accrual));
    const e = r.lines.find((l: { contactId: string }) => l.contactId === egyptian);
    expect(e).toMatchObject({ overtime: '437.50', gross: '7937.50', absence: '500.00', insuranceEmployee: '0.00', insuranceEmployer: '150.00', loan: '1000.00', net: '6437.50' });
  });

  it('a bonus or other deduction is kept when the draft is worked out again', async () => {
    const r = await as(f.staff, (db) => H.getRun(db, run));
    const line = r.lines.find((l: { contactId: string }) => l.contactId === egyptian);
    await as(f.staff, (db) => H.updateLine(db, line.id, { bonus: '200.00', note: 'Stock count' }));
    await as(f.staff, (db) => H.prepareRun(db, f.a.id, '2026-10-31'));
    const again = (await as(f.staff, (db) => H.getRun(db, run))).lines.find((l: { contactId: string }) => l.contactId === egyptian);
    expect(again).toMatchObject({ bonus: '200.00', net: '6637.50', note: 'Stock count' });
  });

  it('posting makes one balanced entry; the month is then fixed', async () => {
    await as(f.staff, (db) => H.postRun(db, run));
    const r = await as(f.staff, (db) => H.getRun(db, run));
    expect(r.status).toBe('posted');
    expect(await balance(f.a.id, '2210')).toBe(fromMinor(-toMinor(r.totals.net)));
    expect(await balance(f.a.id, '2220')).toBe(fromMinor(-(toMinor('1218.75') + toMinor('1468.75') + toMinor('150.00'))));
    expect(await balance(f.a.id, '1150')).toBe('2000.00');
    expect(await balance(f.a.id, '2230')).toBe(fromMinor(-toMinor(r.totals.eosAccrual)));
    const cc = (await owner.query(`SELECT count(*)::int AS n FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = '5200' AND l.cost_centre_id IS NULL`, [r.entryId])).rows[0].n;
    expect(cc).toBe(0);
    await expect(as(f.staff, (db) => H.saveAttendance(db, f.a.id, '2026-10-31', [{ employeeNo: 'E-002', absentDays: 0 }]))).rejects.toThrow(/posted/);
    await expect(owner.query(`UPDATE payroll_lines SET bonus = 0, gross = gross - bonus, net = net - bonus WHERE run_id = $1`, [run])).rejects.toThrow(/never changes/);
    await expect(as(f.staff, (db) => H.deleteDraft(db, run))).rejects.toThrow();
    const leave = (await as(f.staff, (db) => H.listLeave(db, f.a.id))).find((l) => l.kind === 'unpaid')!;
    await expect(as(f.staff, (db) => H.decideLeave(db, leave.id, 'cancelled'))).rejects.toThrow(/Payroll is posted/);
  });

  it('salary file needs bank details; paying clears salaries payable', async () => {
    await expect(as(f.staff, (db) => H.wpsFile(db, run))).rejects.toThrow(/bank details/);
    for (const [id, iban] of [[saudi, 'SA0380000000608010167519'], [egyptian, 'SA4420000001234567891234']]) {
      const e = await as(f.staff, (db) => H.employee(db, id!));
      await as(f.staff, (db) => H.saveProfile(db, id!, { ...e, annualLeaveDays: e.annualLeaveDays, iban }));
    }
    const file = await as(f.staff, (db) => H.wpsFile(db, run));
    expect(file.fileName).toBe('payroll-2026-10.csv');
    expect(file.content.split('\r\n').find((l) => l.startsWith('E-001'))).toMatch(/^E-001,Faisal Al Harbi,1012345678,SA0380000000608010167519,10000.00,2500.00,500.00,1652.08,11347.92$/);
    await as(f.staff, (db) => H.payRun(db, run, { bankAccountId: f.a.cash, date: '2026-11-01' }));
    expect(await balance(f.a.id, '2210')).toBe('0.00');
    await expect(as(f.staff, (db) => H.payRun(db, run, { bankAccountId: f.a.cash, date: '2026-11-01' }))).rejects.toThrow(/already paid/);
  });
});

describe('End of service', () => {
  it('the summary shows what the law gives and the provision held', async () => {
    const s = await as(f.staff, (db) => H.eosSummary(db, f.a.id, '2026-10-31'));
    const row = s.rows.find((r) => r.contactId === saudi)!;
    expect(row.provision).toBe(row.accrued);
    expect(toMinor(row.onResignation) < toMinor(row.full)).toBe(true);
    expect(s.books).toBe(fromMinor(s.rows.reduce((t, r) => t + toMinor(r.provision), 0n)));
  });

  it('a final settlement pays end of service by the reason and unused leave, recovers the loan, and releases the provision', async () => {
    const p = await as(f.staff, (db) => H.settlementPreview(db, egyptian, { leavingDate: '2026-11-15', reason: 'resignation' }));
    expect(p.eosAmount).toBe('0.00');                      // resigned under 2 years
    expect(toMinor(p.leavePay) > 0n).toBe(true);
    expect(p.loanRecovered).toBe(fromMinor(toMinor(p.loanBalance) < toMinor(p.leavePay) ? toMinor(p.loanBalance) : toMinor(p.leavePay)));
    const provisionBefore = toMinor(await balance(f.a.id, '2230'));
    await as(f.staff, (db) => H.settle(db, egyptian, { leavingDate: '2026-11-15', reason: 'resignation' }));
    expect(toMinor(await balance(f.a.id, '2230'))).toBe(provisionBefore + toMinor(p.provision));   // their provision released
    expect(await balance(f.a.id, '2210')).toBe(fromMinor(-toMinor(p.totalDue)));
    expect((await as(f.staff, (db) => H.employee(db, egyptian))).leavingDate).toBe('2026-11-15');
    await expect(as(f.staff, (db) => H.settle(db, egyptian, { leavingDate: '2026-11-15', reason: 'resignation' }))).rejects.toThrow(/already done/);
    const nov = await as(f.staff, (db) => H.prepareRun(db, f.a.id, '2026-11-30'));
    const line = (await as(f.staff, (db) => H.getRun(db, nov))).lines.find((l: { contactId: string }) => l.contactId === egyptian);
    expect(line).toMatchObject({ basic: '3000.00', housing: '750.00', eosAccrual: '0.00' });   // 15 of 30 days, no more provision
  });
});

describe('UAE payroll and documents', () => {
  it('UAE nationals pay GPSSA; the WPS file needs the employer and person IDs', async () => {
    emirati = await as(f.partner, (db) => S.saveContact(db, f.b.id, { isEmployee: true, name: 'Mariam Al Mansoori', employeeNo: 'U-1', defaultCostCentreId: f.b.headOffice }));
    await as(f.partner, (db) => H.saveProfile(db, emirati, { nationality: 'AE', joinDate: '2024-01-01', basic: '12000.00', housing: '5000.00', transport: '3000.00',
      iban: 'AE070331234567890123456', bankRouting: '600310101', wpsPersonId: '10000123456789' }));
    const run = await as(f.partner, (db) => H.prepareRun(db, f.b.id, '2026-10-31'));
    expect((await as(f.partner, (db) => H.getRun(db, run))).lines[0]).toMatchObject({ insuranceEmployee: '2200.00', insuranceEmployer: '2500.00', net: '17800.00' });
    await as(f.partner, (db) => H.postRun(db, run));
    await expect(as(f.partner, (db) => H.wpsFile(db, run))).rejects.toThrow(/bank details/);
    await as(f.partner, (db) => H.saveHrSettings(db, f.b.id, { employerId: '0000001234567', bankRouting: '600310101' }));
    const sif = await as(f.partner, (db) => H.wpsFile(db, run));
    expect(sif.content).toMatch(/^EDR,10000123456789,600310101,AE070331234567890123456,2026-10-01,2026-10-31,31,17800.00,0.00,0\r\nSCR,0000001234567,600310101,/);
  });

  it('documents with expiry dates show in the overview when due within 60 days', async () => {
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await as(f.staff, (db) => H.saveDocument(db, f.a.id, { contactId: saudi, kind: 'national_id', number: '1012345678', expiryDate: soon }));
    await as(f.staff, (db) => H.saveDocument(db, f.a.id, { contactId: saudi, kind: 'passport', number: 'P1', expiryDate: '2030-01-01' }));
    await expect(as(f.staff, (db) => H.saveDocument(db, f.a.id, { contactId: saudi, kind: 'passport', issueDate: '2026-01-01', expiryDate: '2025-01-01' }))).rejects.toThrow(/before the issue/);
    const o = await as(f.staff, (db) => H.overview(db, f.a.id));
    expect(o.expiring.map((d: { kind: string }) => d.kind)).toEqual(['national_id']);
    expect(o.headcount).toBe(1);
    expect(await as(f.b.clientAccountant, (db) => H.listDocuments(db, f.a.id))).toEqual([]);
  });
});
