import { describe, it, expect } from 'vitest';
import { parseUnits, fmtUnits, parsePercent, fmtPercent, splitByPercent, percentsFromShares, ownershipKind, PERCENT_TOTAL } from '../src/books/ownershipRules.js';

describe('percent and share parsing', () => {
  it('reads up to 4 decimals exactly and refuses the rest', () => {
    expect(parsePercent('33.3333')).toBe(333_333n);
    expect(parsePercent('100')).toBe(PERCENT_TOTAL);
    expect(parsePercent('0')).toBe(0n);
    expect(parsePercent('12.5')).toBe(125_000n);
    for (const bad of ['', 'abc', '-1', '100.0001', '12.34567', '1e2', ' ', '101']) expect(() => parsePercent(bad)).toThrow();
  });
  it('shows what was read', () => {
    expect(fmtPercent(333_333n)).toBe('33.3333');
    expect(fmtPercent(PERCENT_TOTAL)).toBe('100.0000');
    expect(fmtUnits(parseUnits('2500'))).toBe('2500.0000');
    expect(parseUnits('1,000.5')).toBe(10_005_000n);
  });
});

describe('splitting an amount by percent', () => {
  it('always adds back to the exact amount, never a halala more or less', () => {
    const thirds = [333_333n, 333_333n, 333_334n];
    for (const amount of [1n, 2n, 100n, 100_000n, 1_000_001n, 99_999_999n]) {
      const parts = splitByPercent(amount, thirds);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(amount);
      expect(parts.every((p) => p >= 0n)).toBe(true);
    }
  });
  it('splits plain cases as expected', () => {
    expect(splitByPercent(100_000n, [600_000n, 400_000n])).toEqual([60_000n, 40_000n]);
    expect(splitByPercent(100_000n, [PERCENT_TOTAL])).toEqual([100_000n]);
    expect(splitByPercent(0n, [500_000n, 500_000n])).toEqual([0n, 0n]);
  });
  it('gives the leftover halalas to the biggest remainders, earlier owner first on a tie', () => {
    expect(splitByPercent(100n, [333_333n, 333_333n, 333_334n])).toEqual([33n, 33n, 34n]);
    expect(splitByPercent(1n, [500_000n, 500_000n])).toEqual([1n, 0n]);
  });
  it('refuses percentages that do not total 100 or a negative amount', () => {
    expect(() => splitByPercent(100n, [500_000n, 400_000n])).toThrow(/100/);
    expect(() => splitByPercent(-1n, [PERCENT_TOTAL])).toThrow();
    expect(() => splitByPercent(100n, [])).toThrow();
  });
});

describe('percent from shares', () => {
  it('totals exactly 100 with the leftover to the largest remainders', () => {
    const p = percentsFromShares([parseUnits('1'), parseUnits('1'), parseUnits('1')]);
    expect(p.reduce((a, b) => a + b, 0n)).toBe(PERCENT_TOTAL);
    expect(p).toEqual([333_334n, 333_333n, 333_333n]);
  });
  it('keeps simple ratios exact', () => {
    expect(percentsFromShares([parseUnits('600'), parseUnits('400')])).toEqual([600_000n, 400_000n]);
  });
  it('refuses no shares or all zero', () => {
    expect(() => percentsFromShares([])).toThrow();
    expect(() => percentsFromShares([0n, 0n])).toThrow();
  });
});

describe('what each kind of business needs', () => {
  it('maps the legal form to the way owners are recorded', () => {
    expect(ownershipKind('Sole establishment')).toBe('sole');
    expect(ownershipKind('Partnership')).toBe('partnership');
    for (const f of ['LLC', 'Joint stock company', 'Branch of foreign company', 'Other', 'something new']) expect(ownershipKind(f)).toBe('shares');
  });
});
