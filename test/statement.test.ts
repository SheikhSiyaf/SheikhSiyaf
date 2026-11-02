// Statement files, IBANs, VAT split, stock cost and depreciation maths (pure functions, no database).
import { deflateRawSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { bankFromIban, detectLayout, findAccountInFile, fingerprints, ibanValid, parseAmount, parseCsv, parseDate, readStatement } from '../src/bank/statement.js';
import { readXlsx } from '../src/bank/xlsx.js';
import { netFromGross } from '../src/books/documents.js';
import { issueCost, receivedValue } from '../src/books/inventory.js';
import { depreciationDue, monthEnd, nextMonthEnd, previousMonthEnd, type AssetTerms } from '../src/books/assets.js';
import { fromMinor } from '../src/money.js';

describe('Statement files', () => {
  it('reads CSV with quotes, commas inside amounts and a byte-order mark', () => {
    const rows = parseCsv('﻿Date,Description,Amount\r\n01/02/2026,"Transfer, ACME ""LLC""","1,250.00"\n');
    expect(rows).toEqual([['Date', 'Description', 'Amount'], ['01/02/2026', 'Transfer, ACME "LLC"', '1,250.00']]);
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('understands dates, day first by default, and Excel day numbers', () => {
    expect(parseDate('05/02/2026')).toBe('2026-02-05');
    expect(parseDate('05/02/2026', 'mdy')).toBe('2026-05-02');
    expect(parseDate('2026-02-05')).toBe('2026-02-05');
    expect(parseDate('5-Feb-26')).toBe('2026-02-05');
    expect(parseDate('٠٥/٠٢/٢٠٢٦')).toBe('2026-02-05');
    expect(parseDate('46058')).toBe('2026-02-05');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('Opening balance')).toBeNull();
  });

  it('understands amounts written in many ways, exactly', () => {
    expect(parseAmount('1,234.50')).toBe(123450n);
    expect(parseAmount('(1,234.50)')).toBe(-123450n);
    expect(parseAmount('1,234.50 DR')).toBe(-123450n);
    expect(parseAmount('SAR 99')).toBe(9900n);
    expect(parseAmount('١٬٢٣٤٫٥٠')).toBe(123450n);
    expect(parseAmount('1234.5599999999999')).toBe(123456n);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });

  it('finds the columns in English and Arabic, with separate money out and money in columns', () => {
    const en = [['Account statement'], ['IBAN', 'SA03 8000 0000 6080 1016 7519'], ['Txn Date', 'Narrative', 'Withdrawal', 'Deposit', 'Balance'],
      ['01/03/2026', 'Opening balance', '', '', '10,000.00'], ['02/03/2026', 'POS STC PAY', '115.00', '', '9,885.00'], ['03/03/2026', 'Transfer from Gulf Steel', '', '2,300.00', '12,185.00']];
    const l = detectLayout(en)!;
    expect(l).toMatchObject({ headerRow: 2, date: 0, description: 1, debit: 2, credit: 3, balance: 4 });
    const { lines, leftOut } = readStatement(en, l);
    expect(leftOut).toBe(1);   // the opening balance row has no amount
    expect(lines).toEqual([
      { date: '2026-03-02', description: 'POS STC PAY', reference: null, amount: '-115.00', balance: '9885.00' },
      { date: '2026-03-03', description: 'Transfer from Gulf Steel', reference: null, amount: '2300.00', balance: '12185.00' },
    ]);
    const ar = [['التاريخ', 'البيان', 'المبلغ', 'الرصيد'], ['15/03/2026', 'رسوم خدمة', '-25.00', '975.00']];
    expect(readStatement(ar, detectLayout(ar)!).lines[0]).toMatchObject({ date: '2026-03-15', amount: '-25.00' });
    expect(detectLayout([['Name', 'Phone'], ['A', '1']])).toBeNull();
  });

  it('recognises which registered bank account a file belongs to, by IBAN or account number', () => {
    const rows = [['Account: 608010167519'], ['IBAN SA03 8000 0000 6080 1016 7519']];
    expect(findAccountInFile(rows, [{ id: 'x', iban: null, accountNumber: '1111111' }, { id: 'y', iban: 'SA0380000000608010167519', accountNumber: null }])).toBe('y');
    expect(findAccountInFile(rows, [{ id: 'z', iban: null, accountNumber: '6080-1016-7519' }])).toBe('z');
    expect(findAccountInFile(rows, [{ id: 'x', iban: null, accountNumber: '999999' }])).toBeNull();
  });

  it('gives each line a fingerprint, numbering identical lines', () => {
    const l = { date: '2026-03-02', description: 'Fee', reference: null, amount: '-5.00', balance: null };
    const f = fingerprints([l, l, { ...l, amount: '-6.00' }]);
    expect(f[0]).not.toBe(f[1]);
    expect(f[1]).toBe(`${f[0]}#2`);
  });

  it('reads the first sheet of an Excel file', async () => {
    const xlsx = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><t>Description</t></si><si><t>Amount</t></si><si><r><t>Salary </t></r><r><t>&amp; allowances</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
        + '<row r="2"><c r="A2"><v>46058</v></c><c r="B2" t="s"><v>3</v></c><c r="D2"><v>-8500.5</v></c></row></sheetData></worksheet>',
    });
    const rows = await readXlsx(xlsx);
    expect(rows).toEqual([['Date', 'Description', 'Amount'], ['46058', 'Salary & allowances', '', '-8500.5']]);
    const layout = detectLayout(rows)!;
    expect(readStatement(rows, layout).lines).toEqual([]);   // the amount sits in column D, not under "Amount": nothing is guessed
  });
});

describe('IBANs', () => {
  it('checks the IBAN check digits and length, and knows the bank', () => {
    expect(ibanValid('SA03 8000 0000 6080 1016 7519')).toBe(true);
    expect(ibanValid('SA04 8000 0000 6080 1016 7519')).toBe(false);
    expect(ibanValid('SA038000000060801016751')).toBe(false);
    expect(ibanValid('AE07 0331 2345 6789 0123 456')).toBe(true);
    expect(bankFromIban('SA0380000000608010167519')?.name).toBe('Al Rajhi Bank');
    expect(bankFromIban('AE070331234567890123456')?.name).toBe('Mashreq');
  });
});

describe('Splitting a bank payment into amount before VAT and VAT', () => {
  it('finds the net whose VAT adds up exactly to the payment', () => {
    for (let gross = 1n; gross < 5000n; gross += 7n) {
      const r = netFromGross(gross, '15.00', 'standard');
      expect(r.net + r.vat + r.rounding).toBe(gross);
      expect(r.rounding >= 0n && r.rounding <= 1n).toBe(true);   // at most one halala that no net can reach
    }
    expect(netFromGross(11500n, '15.00', 'standard')).toEqual({ net: 10000n, vat: 1500n, rounding: 0n });
    expect(netFromGross(11500n, '15.00', 'exempt')).toEqual({ net: 11500n, vat: 0n, rounding: 0n });
  });
});

describe('Stock at average cost', () => {
  it('values goods received at quantity x cost and goods out at the average, leaving nothing behind', () => {
    expect(receivedValue(3000n, 3333n)).toBe(9999n);                // 3 x 33.33
    expect(issueCost(3000n, 10000n, 1000n)).toBe(3333n);           // 1 of 3 worth 100.00
    expect(issueCost(2000n, 6667n, 2000n)).toBe(6667n);            // the last 2 take what is left
    expect(() => issueCost(1000n, 500n, 2000n)).toThrow();
  });
});

describe('Straight-line depreciation', () => {
  const a: AssetTerms = { cost: 1200000n, residual: 0n, lifeMonths: 36, start: '2026-01-01', opening: 0n };
  it('books equal months, catches up missed months and never goes past cost less residual value', () => {
    expect(fromMinor(depreciationDue(a, '2025-12-31', 0n))).toBe('0.00');
    expect(fromMinor(depreciationDue(a, '2026-01-31', 0n))).toBe('333.33');
    expect(fromMinor(depreciationDue(a, '2026-03-31', 0n))).toBe('1000.00');     // three months caught up at once
    let booked = 0n;
    for (let m = monthEnd('2026-01-15'); m <= '2029-06-30'; m = nextMonthEnd(m)) booked += depreciationDue(a, m, booked);
    expect(booked).toBe(1200000n);
    const used = { ...a, residual: 200000n, opening: 500000n };
    expect(fromMinor(depreciationDue(used, '2026-01-31', 0n))).toBe('0.00');    // opening amount covers the early months
    expect(fromMinor(depreciationDue({ ...a, disposedOn: '2026-02-10' }, '2026-02-28', 0n))).toBe('0.00');
    expect(previousMonthEnd('2026-03-10')).toBe('2026-02-28');
  });
});

/** A minimal zip with deflated entries, like a real .xlsx file. */
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts: number[] = [], central: number[] = [];
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), d = enc.encode(text), z = new Uint8Array(deflateRawSync(d)), c = crc(d), offset = parts.length;
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(c), ...u32(z.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...z);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(c), ...u32(z.length), ...u32(d.length),
      ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n);
    count++;
  }
  const cdOffset = parts.length;
  return new Uint8Array([...parts, ...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(central.length), ...u32(cdOffset), ...u16(0)]);
}
