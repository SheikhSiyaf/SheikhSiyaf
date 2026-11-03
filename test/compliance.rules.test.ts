// Compliance calendar rules (src/books/compliance.ts): which deadlines a client has and when they fall due.
// Dates worked by hand from the rules in that file (to be confirmed with ZATCA, the FTA, GOSI, GPSSA and MOHRE).
import { describe, it, expect } from 'vitest';
import * as C from '../src/books/compliance.js';

const sa: C.ComplianceCompany = { country: 'SA', vatStatus: 'registered', vatRegistrationDate: null, fyEndMonth: 12, fyEndDay: 31, crExpiry: null, modules: [] };
const ae: C.ComplianceCompany = { ...sa, country: 'AE' };
const due = (list: C.Deadline[], kind: C.DeadlineKind) => list.filter((d) => d.kind === kind).map((d) => `${d.periodEnd ?? ''}>${d.due}`);

describe('VAT returns', () => {
  it('Saudi quarterly: due the last day of the month after the quarter', () => {
    const l = C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-01-01', '2026-12-31');
    expect(due(l, 'vat_return')).toEqual(['2025-12-31>2026-01-31', '2026-03-31>2026-04-30', '2026-06-30>2026-07-31', '2026-09-30>2026-10-31']);
  });
  it('Saudi monthly: every month, due the end of the next month', () => {
    const l = C.deadlinesBetween(sa, { ...C.defaultSettings(sa), vatFrequency: 'monthly' }, '2026-02-01', '2026-04-30');
    expect(due(l, 'vat_return')).toEqual(['2026-01-31>2026-02-28', '2026-02-28>2026-03-31', '2026-03-31>2026-04-30']);
  });
  it('UAE: due the 28th day of the month after the period, with staggered quarters', () => {
    const l = C.deadlinesBetween(ae, { ...C.defaultSettings(ae), vatQuarterEndMonth: 2 }, '2026-03-01', '2026-12-31');
    expect(due(l, 'vat_return')).toEqual(['2026-02-28>2026-03-28', '2026-05-31>2026-06-28', '2026-08-31>2026-09-28', '2026-11-30>2026-12-28']);
  });
  it('the first period starts on the VAT registration date; none before it and none when unregistered', () => {
    const l = C.deadlinesBetween({ ...sa, vatRegistrationDate: '2026-05-10' }, C.defaultSettings(sa), '2026-01-01', '2026-12-31');
    expect(l.filter((d) => d.kind === 'vat_return').map((d) => `${d.periodStart}..${d.periodEnd}`)).toEqual(['2026-05-10..2026-06-30', '2026-07-01..2026-09-30']);
    expect(C.deadlinesBetween({ ...sa, vatStatus: 'unregistered' }, C.defaultSettings(sa), '2026-01-01', '2026-12-31').filter((d) => d.kind === 'vat_return')).toEqual([]);
  });
  it('quarters are three months long and end in the chosen month', () => {
    expect(C.vatPeriods({ ...C.defaultSettings(sa), vatQuarterEndMonth: 1 }, '2026-01-01', '2026-07-31', null))
      .toEqual([{ start: '2025-11-01', end: '2026-01-31' }, { start: '2026-02-01', end: '2026-04-30' }, { start: '2026-05-01', end: '2026-07-31' }]);
  });
});

describe('Payroll deadlines (only with HRM)', () => {
  it('Saudi: GOSI by the 15th of the next month', () => {
    const co = { ...sa, modules: ['HRM'] };
    expect(due(C.deadlinesBetween(co, C.defaultSettings(co), '2026-10-01', '2026-11-30'), 'social_insurance')).toEqual(['2026-09-30>2026-10-15', '2026-10-31>2026-11-15']);
    expect(due(C.deadlinesBetween(co, C.defaultSettings(co), '2026-10-01', '2026-11-30'), 'wps')).toEqual([]);
    expect(C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-10-01', '2026-11-30').some((d) => d.kind === 'social_insurance')).toBe(false);
  });
  it('UAE: WPS salaries by the 15th and GPSSA by the 10th of the next month', () => {
    const co = { ...ae, modules: ['HRM'] };
    const l = C.deadlinesBetween(co, C.defaultSettings(co), '2026-10-01', '2026-10-31');
    expect(due(l, 'wps')).toEqual(['2026-09-30>2026-10-15']);
    expect(due(l, 'social_insurance')).toEqual(['2026-09-30>2026-10-10']);
    expect(due(C.deadlinesBetween(co, { ...C.defaultSettings(co), socialInsurance: false }, '2026-10-01', '2026-10-31'), 'social_insurance')).toEqual([]);
  });
});

describe('Yearly deadlines', () => {
  it('Saudi zakat: 120 days after the financial year end', () => {
    expect(due(C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-01-01', '2026-12-31'), 'zakat')).toEqual(['2025-12-31>2026-04-30']);
    const june = { ...sa, fyEndMonth: 6, fyEndDay: 30 };
    expect(due(C.deadlinesBetween(june, C.defaultSettings(june), '2026-01-01', '2026-12-31'), 'zakat')).toEqual(['2026-06-30>2026-10-28']);
  });
  it('UAE corporate tax: the end of the ninth month after the year end', () => {
    expect(due(C.deadlinesBetween(ae, C.defaultSettings(ae), '2026-01-01', '2026-12-31'), 'corporate_tax')).toEqual(['2025-12-31>2026-09-30']);
    const march = { ...ae, fyEndMonth: 3, fyEndDay: 31 };
    expect(due(C.deadlinesBetween(march, C.defaultSettings(march), '2026-01-01', '2026-12-31'), 'corporate_tax')).toEqual(['2026-03-31>2026-12-31']);
    expect(C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-01-01', '2026-12-31').some((d) => d.kind === 'corporate_tax')).toBe(false);
  });
  it('the CR or trade licence expiry is a deadline', () => {
    const l = C.deadlinesBetween({ ...sa, crExpiry: '2026-12-20' }, C.defaultSettings(sa), '2026-11-01', '2026-12-31');
    expect(l.filter((d) => d.kind === 'cr_renewal')).toEqual([{ key: 'cr:2026-12-20', kind: 'cr_renewal', due: '2026-12-20' }]);
  });
});

describe('Documents and your own deadlines', () => {
  it('employee documents expiring in the window, keyed by document and date', () => {
    const l = C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-11-01', '2026-11-30', {
      documents: [{ id: 'd1', kind: 'iqama', label: 'Rahul Menon', expiry: '2026-11-20' }, { id: 'd2', kind: 'passport', label: 'Ahmed', expiry: '2027-03-01' }],
    });
    expect(l.filter((d) => d.kind === 'document_expiry')).toEqual([{ key: 'doc:d1:2026-11-20', kind: 'document_expiry', due: '2026-11-20', ref: 'd1', docKind: 'iqama', label: 'Rahul Menon' }]);
  });
  it('repeating deadlines keep their day, falling back to the month end', () => {
    expect(C.occurrences('2026-01-31', 'monthly', '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(C.occurrences('2025-05-15', 'quarterly', '2026-01-01', '2026-12-31')).toEqual(['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15']);
    expect(C.occurrences('2024-02-29', 'yearly', '2025-01-01', '2028-12-31')).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(C.occurrences('2026-06-01', 'none', '2026-01-01', '2026-12-31')).toEqual(['2026-06-01']);
    expect(C.occurrences('2027-06-01', 'none', '2026-01-01', '2026-12-31')).toEqual([]);
  });
  it('custom deadlines appear with their own key; the list is sorted by date', () => {
    const l = C.deadlinesBetween(sa, C.defaultSettings(sa), '2026-10-01', '2026-11-30', { custom: [{ id: 'c1', title: 'Municipality licence', firstDue: '2026-11-05', repeat: 'yearly' }] });
    expect(l.map((d) => d.key)).toEqual(['vat:2026-09-30', 'custom:c1:2026-11-05']);
    expect(l[1]).toMatchObject({ kind: 'custom', label: 'Municipality licence', ref: 'c1' });
  });
});

describe('Status', () => {
  it('done, overdue, due within 14 days, or later', () => {
    expect(C.statusOf('2026-11-01', false, '2026-11-03')).toBe('overdue');
    expect(C.statusOf('2026-11-01', true, '2026-11-03')).toBe('done');
    expect(C.statusOf('2026-11-03', false, '2026-11-03')).toBe('soon');
    expect(C.statusOf('2026-11-17', false, '2026-11-03')).toBe('soon');
    expect(C.statusOf('2026-11-18', false, '2026-11-03')).toBe('later');
  });
});
