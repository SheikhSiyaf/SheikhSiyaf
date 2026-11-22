// The sidebar shows each module's main pages; the rest stay reachable (More links, search, addresses). Pages that belong
// to the owner reports disappear for a job title without that access.
import { describe, it, expect } from 'vitest';
import { NAV, moduleOf, menuSubs, moreSubs, subsFor, hiddenFor, navFor } from './nav.ts';

const keys = (m: string, perms?: Record<string, string> | null, fn = menuSubs) => fn(moduleOf(m), perms).map((s) => s.key);

describe('Sidebar', () => {
  it('Sales shows exactly Overview, Customers, Quotations, Invoices, Credit notes, Debit notes and Payments received', () => {
    expect(keys('Sales')).toEqual(['overview', 'customers', 'quotations', 'invoices', 'credit-notes', 'debit-notes', 'payments-received']);
  });
  it('the other Sales pages are still there, one tap away', () => {
    expect(keys('Sales', null, moreSubs)).toEqual(['recurring-invoices', 'online-payments', 'statements', 'reminders', 'e-invoicing', 'zatca', 'emails']);
  });
  it('no page is lost: every page is either in the menu or in More', () => {
    for (const m of NAV) expect([...menuSubs(m, null), ...moreSubs(m, null)].map((s) => s.key).sort()).toEqual(m.subs.map((s) => s.key).sort());
  });
  it('every module that has pages has at least one in the menu, and the first page is one you can open', () => {
    for (const m of NAV.filter((x) => x.subs.length)) { expect(menuSubs(m, null).length, m.key).toBeGreaterThan(0); expect(menuSubs(m, null)[0], m.key).toBe(m.subs[0]); }
  });
  it('the menu is short: no module lists more than 8 main pages', () => {
    for (const m of NAV) expect(menuSubs(m, null).length, m.key).toBeLessThanOrEqual(8);
  });
});

describe('Owner reports in the menu', () => {
  const without = { Reports: 'edit', OwnerReports: 'none' };
  it('are listed for a title that has them and for no title (full access)', () => {
    expect(keys('Reports', { Reports: 'edit', OwnerReports: 'view' })).toEqual(expect.arrayContaining(['owner-summary', 'profit-and-loss', 'balance-sheet', 'cash-flow']));
    expect(keys('Reports', null)).toEqual(expect.arrayContaining(['owner-summary', 'profit-and-loss']));
  });
  it('are left out for a title without them, and the first page is then a finance report', () => {
    for (const k of ['owner-summary', 'profit-and-loss', 'balance-sheet', 'cash-flow']) expect(keys('Reports', without)).not.toContain(k);
    expect(keys('Reports', without, subsFor)).not.toContain('owner-summary');
    expect(keys('Reports', without)).toEqual(expect.arrayContaining(['trial-balance', 'vat-return', 'aged-receivables']));
    expect(menuSubs(moduleOf('Reports'), without)[0]!.key).toBe('trial-balance');
  });
});

describe('A company that runs its own books', () => {
  it('has no accounting-firm modules in its menu', () => {
    expect(hiddenFor('company')).toEqual(expect.arrayContaining(['Portal', 'Review']));
    expect(navFor(['Inventory'], null, hiddenFor('company')).map((m) => m.key)).not.toEqual(expect.arrayContaining(['Review']));
    expect(hiddenFor('firm')).toEqual([]);
  });
});
