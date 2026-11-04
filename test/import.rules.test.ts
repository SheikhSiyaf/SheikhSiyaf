// Bulk import rules (src/books/importRules.ts): templates, finding the header row in English or Arabic, amounts, row checks.
import { describe, it, expect } from 'vitest';
import * as I from '../src/books/importRules.js';
import { parseCsv } from '../src/bank/statement.js';

describe('Templates and headers', () => {
  it('the template has the headers (required ones marked) and an example row; it reads back cleanly', () => {
    const csv = I.template('customers');
    expect(csv.startsWith('﻿Name *,Arabic name,VAT number')).toBe(true);
    const m = I.mapRows('customers', parseCsv(csv.replace(/^﻿/, '')));
    expect(m.missing).toEqual([]);
    expect(m.records).toEqual([expect.objectContaining({ line: 2, values: expect.objectContaining({ name: 'Gulf Steel Trading', vatNumber: '300000000000003' }) })]);
  });
  it('finds the header row below a title, in any order, in Arabic, and ignores columns it does not know', () => {
    const rows = [['Customer list 2026'], [], ['الرقم الضريبي', 'ملاحظات', 'الاسم', 'مدة السداد (أيام)'], ['٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣', 'x', 'مؤسسة النور', '٣٠'], ['', '', '', '']];
    const m = I.mapRows('customers', rows);
    expect(m.header).toBe(2);
    expect(m.columns.map((c) => c.key)).toEqual(['vatNumber', null, 'name', 'paymentTermsDays']);
    expect(m.records).toEqual([{ line: 4, values: { vatNumber: '300000000000003', name: 'مؤسسة النور', paymentTermsDays: '30' } }]);
  });
  it('says which required columns are missing', () => {
    expect(I.mapRows('items', [['Name', 'Unit'], ['Beam', 'pcs']]).missing).toEqual(['sku']);
    expect(I.mapRows('opening', [['Something'], ['1']]).header).toBe(-1);
  });
});

describe('Amounts and row checks', () => {
  it('reads amounts as spreadsheets write them, never with floating point', () => {
    expect(I.amount('1,234.5')).toBe(123450n);
    expect(I.amount('(500.00)')).toBe(-50000n);
    expect(I.amount('SAR 10')).toBe(1000n);
    expect(I.amount('')).toBe(0n);
    expect(I.amount('1.234')).toBeNull();
    expect(I.amount('abc')).toBeNull();
  });
  it('checks each kind in plain terms', () => {
    expect(I.rowProblems('customers', { name: '', vatNumber: '123' }, 'SA')).toEqual(['imp.p.name', 'imp.p.saVat']);
    expect(I.rowProblems('customers', { name: 'X', vatNumber: '100234567800003', country: 'AE', buildingNumber: '12' }, 'SA')).toEqual(['imp.p.building']);
    expect(I.rowProblems('items', { sku: 'A', name: 'B', salePrice: '-5' }, 'SA')).toEqual(['imp.p.price']);
    expect(I.rowProblems('accounts', { code: '4100', name: 'Marketing', type: 'expense' }, 'SA')).toEqual(['imp.p.codeType']);
    expect(I.rowProblems('accounts', { code: '5450', name: 'التسويق', type: 'مصروفات' }, 'SA')).toEqual([]);
    expect(I.rowProblems('opening', { code: '1000', debit: '100', credit: '50' }, 'SA')).toEqual(['imp.p.both']);
    expect(I.rowProblems('opening', { code: '1000', debit: '(100)', credit: '' }, 'SA')).toEqual(['imp.p.negative']);
  });
});
