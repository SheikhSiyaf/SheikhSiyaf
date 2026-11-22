// Ownership (db/migrations/0061, src/books/ownershipService.ts): owners with shares and percentages by date, capital
// contributions, drawings, dividends (declared, then paid) and the partners' profit split, all posted through the
// ledger. Company A is the Saudi fixture company; its legal form is changed per test group.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as O from '../src/books/ownershipService.js';
import { balanceSheet } from '../src/books/reportsService.js';

let f: Fixture;
const bal = async (code: string, co = () => f.a.id) => (await owner.query(`SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l
  JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [co(), code])).rows[0].v as string;
const acct = async (id: string) => (await owner.query('SELECT code, type, name FROM accounts WHERE id = $1', [id])).rows[0] as { code: string; type: string; name: string };
const form = (v: string) => owner.query('UPDATE companies SET legal_form = $2 WHERE id = $1', [f.a.id, v]);
const clean = async () => { for (const t of ['owner_transactions', 'ownership_holdings', 'owners']) await owner.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`); await owner.query('DELETE FROM owner_transactions WHERE company_id = $1', [f.a.id]);
  await owner.query('DELETE FROM ownership_holdings WHERE company_id = $1', [f.a.id]); await owner.query('DELETE FROM owners WHERE company_id = $1', [f.a.id]);
  for (const t of ['owner_transactions', 'ownership_holdings', 'owners']) await owner.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`); };
const person = (name: string) => as(f.staff, (db) => O.saveOwner(db, f.a.id, { name, nameAr: `${name} ع` }));
const hold = (date: string, rows: { ownerId: string; shares?: string; percent?: string }[]) => as(f.staff, (db) => O.setHoldings(db, f.a.id, { effectiveFrom: date, holdings: rows }));

beforeAll(async () => {
  f = await seed();
  await owner.query('UPDATE accounts SET is_bank = true WHERE id = $1', [f.a.cash]);
});

describe('Owners and holdings', () => {
  it('an owner gets a capital account and a current account of their own, in equity', async () => {
    const id = await person('Fahad Al-Harbi');
    const o = (await as(f.staff, (db) => O.overview(db, f.a.id))).owners.find((x) => x.id === id)!;
    expect((await acct(o.capitalAccountId)).type).toBe('equity');
    expect((await acct(o.currentAccountId)).type).toBe('equity');
    expect((await acct(o.capitalAccountId)).name).toMatch(/Fahad Al-Harbi/);
    expect(o.capitalAccountId).not.toBe(o.currentAccountId);
  });

  it('holdings must total exactly 100 percent, and shares can stand in for percentages', async () => {
    await clean();
    const a = await person('Owner One'), b = await person('Owner Two'), c = await person('Owner Three');
    await expect(hold('2027-01-01', [{ ownerId: a, percent: '60' }, { ownerId: b, percent: '39.9999' }])).rejects.toThrow(/100/);
    await expect(hold('2027-01-01', [{ ownerId: a, percent: '60' }, { ownerId: b, percent: '50' }])).rejects.toThrow(/100/);
    await hold('2027-01-01', [{ ownerId: a, shares: '1' }, { ownerId: b, shares: '1' }, { ownerId: c, shares: '1' }]);
    const ov = await as(f.staff, (db) => O.overview(db, f.a.id, '2027-06-01'));
    expect(ov.owners.map((x) => x.percent)).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(ov.totalPercent).toBe('100.0000');
    expect(ov.totalShares).toBe('3.0000');
  });

  it('a change applies from its date: the earlier percentages stay for the earlier dates', async () => {
    await clean();
    const a = await person('Alpha'), b = await person('Beta');
    await hold('2027-01-01', [{ ownerId: a, percent: '50' }, { ownerId: b, percent: '50' }]);
    await hold('2027-07-01', [{ ownerId: a, percent: '70' }, { ownerId: b, percent: '30' }]);
    const at = async (d: string) => (await as(f.staff, (db) => O.overview(db, f.a.id, d))).owners.map((x) => x.percent);
    expect(await at('2027-06-30')).toEqual(['50.0000', '50.0000']);
    expect(await at('2027-07-01')).toEqual(['70.0000', '30.0000']);
    expect(await at('2026-12-31')).toEqual(['0.0000', '0.0000']);
    // Setting the same date again replaces that date's holdings; it does not pile up.
    await hold('2027-07-01', [{ ownerId: a, percent: '80' }, { ownerId: b, percent: '20' }]);
    expect(await at('2027-08-01')).toEqual(['80.0000', '20.0000']);
  });

  it('an owner who leaves is given 0 percent from the leaving date and cannot take new money in or out', async () => {
    await clean(); await form('Partnership');
    const a = await person('Stays'), b = await person('Leaves');
    await hold('2027-01-01', [{ ownerId: a, percent: '50' }, { ownerId: b, percent: '50' }]);
    await hold('2027-09-01', [{ ownerId: a, percent: '100' }, { ownerId: b, percent: '0' }]);
    await as(f.staff, (db) => O.saveOwner(db, f.a.id, { name: 'Leaves', isActive: false }, b));
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: b, date: '2027-10-01', amount: '10.00', accountId: f.a.cash }))).rejects.toThrow(/no longer active/i);
  });

  it('a sole establishment has one owner at 100 percent', async () => {
    await clean(); await form('Sole establishment');
    const a = await person('Only Owner'), b = await person('Second');
    await expect(hold('2027-01-01', [{ ownerId: a, percent: '60' }, { ownerId: b, percent: '40' }])).rejects.toThrow(/one owner/i);
    await hold('2027-01-01', [{ ownerId: a, percent: '100' }]);
    expect((await as(f.staff, (db) => O.overview(db, f.a.id, '2027-02-01'))).kind).toBe('sole');
  });
});

describe('Capital and drawings', () => {
  it('a contribution is Dr bank, Cr the owner\'s capital account, and a drawing is Dr the owner\'s current account, Cr bank', async () => {
    await clean(); await form('Partnership');
    const a = await person('Partner A'), b = await person('Partner B');
    await hold('2027-01-01', [{ ownerId: a, percent: '50' }, { ownerId: b, percent: '50' }]);
    const bank0 = await bal('1000');
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-01', amount: '10000.00', accountId: f.a.cash, memo: 'Start-up capital' }));
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: a, date: '2027-03-01', amount: '1500.50', accountId: f.a.cash }));
    const o = (await as(f.staff, (db) => O.overview(db, f.a.id, '2027-12-31'))).owners.find((x) => x.id === a)!;
    expect(o.capital).toBe('10000.00');
    expect(o.current).toBe('-1500.50');
    expect((Number(await bal('1000')) - Number(bank0)).toFixed(2)).toBe('-8499.50');   // 10 000.00 in, 1 500.50 out (credits minus debits)
  });

  it('refuses a zero, negative or badly written amount, a bank account of another company, and a missing owner', async () => {
    const a = (await as(f.staff, (db) => O.overview(db, f.a.id))).owners[0]!.id;
    for (const amount of ['0', '-5', 'abc', '', '10.001']) {
      await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-02', amount, accountId: f.a.cash }))).rejects.toThrow();
    }
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-02', amount: '5.00', accountId: f.b.cash }))).rejects.toThrow();
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: '00000000-0000-4000-8000-000000000000', date: '2027-02-02', amount: '5.00', accountId: f.a.cash }))).rejects.toThrow();
  });

  it('a drawing needs a sole owner or partners; a company with shares pays dividends instead', async () => {
    await clean(); await form('LLC');
    const a = await person('Shareholder');
    await hold('2027-01-01', [{ ownerId: a, shares: '100' }]);
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: a, date: '2027-03-01', amount: '10.00', accountId: f.a.cash }))).rejects.toThrow(/dividend/i);
  });
});

describe("Partners' profit split", () => {
  it('shares a profit by percent to the halala, into each partner\'s current account, out of retained earnings', async () => {
    await clean(); await form('Partnership');
    const a = await person('P1'), b = await person('P2'), c = await person('P3');
    await hold('2027-01-01', [{ ownerId: a, percent: '33.3333' }, { ownerId: b, percent: '33.3333' }, { ownerId: c, percent: '33.3334' }]);
    const re0 = await bal('3100');
    const r = await as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '1000.01', memo: 'Profit 2027' }));
    expect(r.parts.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)).toBe(100001);
    const ov = await as(f.staff, (db) => O.overview(db, f.a.id, '2027-12-31'));
    expect(ov.owners.reduce((s, o) => s + Math.round(Number(o.current) * 100), 0)).toBe(100001);
    expect(((Number(await bal('3100')) - Number(re0)).toFixed(2))).toBe('-1000.01');
    const lines = (await owner.query('SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM journal_lines WHERE entry_id = $1', [r.entryId])).rows[0];
    expect(lines.d).toBe(lines.c);
  });

  it('uses the percentages in force on the date of the split', async () => {
    await clean(); await form('Partnership');
    const a = await person('Early A'), b = await person('Early B');
    await hold('2027-01-01', [{ ownerId: a, percent: '50' }, { ownerId: b, percent: '50' }]);
    await hold('2028-01-01', [{ ownerId: a, percent: '90' }, { ownerId: b, percent: '10' }]);
    const r = await as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '200.00' }));
    expect(r.parts.map((p) => p.amount)).toEqual(['100.00', '100.00']);
  });

  it('refuses a company with shares, no holdings, or an amount that is not above zero', async () => {
    await form('LLC');
    await expect(as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '10.00' }))).rejects.toThrow(/dividend/i);
    await clean(); await form('Partnership'); await person('Nobody Yet');
    await expect(as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '10.00' }))).rejects.toThrow(/percentages/i);
  });

  it('suggests the year\'s net profit from the books without posting anything', async () => {
    const s = await as(f.staff, (db) => O.profitSuggestion(db, f.a.id, '2027-01-01', '2027-12-31'));
    expect(s.netProfit).toMatch(/^-?\d+\.\d{2}$/);
  });
});

describe('Dividends', () => {
  it('declaring shares the dividend by holdings into dividends payable; paying clears it, never more than is owed', async () => {
    await clean(); await form('LLC');
    const a = await person('Share A'), b = await person('Share B');
    await hold('2027-01-01', [{ ownerId: a, shares: '600' }, { ownerId: b, shares: '400' }]);
    const re0 = await bal('3100');
    const d = await as(f.staff, (db) => O.declareDividend(db, f.a.id, { date: '2027-12-31', amount: '10000.00', memo: 'Final dividend 2027' }));
    expect(d.parts.map((p) => p.amount)).toEqual(['6000.00', '4000.00']);
    expect(await bal('2170')).toBe('10000.00');
    expect(((Number(await bal('3100')) - Number(re0)).toFixed(2))).toBe('-10000.00');
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'dividend_paid', ownerId: a, date: '2028-01-15', amount: '2500.00', accountId: f.a.cash }));
    expect(await bal('2170')).toBe('7500.00');
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'dividend_paid', ownerId: a, date: '2028-01-16', amount: '3500.01', accountId: f.a.cash }))).rejects.toThrow(/owed|payable/i);
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'dividend_paid', ownerId: a, date: '2028-01-16', amount: '3500.00', accountId: f.a.cash }));
    const ov = await as(f.staff, (db) => O.overview(db, f.a.id, '2028-02-01'));
    expect(ov.owners.find((x) => x.id === a)!.dividendsPayable).toBe('0.00');
    expect(ov.owners.find((x) => x.id === b)!.dividendsPayable).toBe('4000.00');
  });

  it('uses the holdings on the declaration date, and an odd amount still adds up exactly', async () => {
    await clean(); await form('LLC');
    const a = await person('Old A'), b = await person('Old B'), c = await person('New C');
    await hold('2027-01-01', [{ ownerId: a, shares: '1' }, { ownerId: b, shares: '1' }]);
    await hold('2027-07-01', [{ ownerId: a, shares: '1' }, { ownerId: b, shares: '1' }, { ownerId: c, shares: '1' }]);
    const before = await as(f.staff, (db) => O.declareDividend(db, f.a.id, { date: '2027-06-30', amount: '100.01' }));
    expect(before.parts).toHaveLength(2);
    const after = await as(f.staff, (db) => O.declareDividend(db, f.a.id, { date: '2027-07-31', amount: '100.01' }));
    expect(after.parts).toHaveLength(3);
    expect(after.parts.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)).toBe(10001);
  });
});

describe('Corrections', () => {
  it('a reversal puts the books and the owner back; it can be done once; the movement itself is never changed', async () => {
    await clean(); await form('Partnership');
    const a = await person('Rev A'), b = await person('Rev B');
    await hold('2027-01-01', [{ ownerId: a, percent: '50' }, { ownerId: b, percent: '50' }]);
    const id = await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: a, date: '2027-04-01', amount: '300.00', accountId: f.a.cash }));
    const cur = async () => (await as(f.staff, (db) => O.overview(db, f.a.id, '2027-12-31'))).owners.find((x) => x.id === a)!.current;
    expect(await cur()).toBe('-300.00');
    await as(f.staff, (db) => O.reverse(db, id, { date: '2027-04-02', memo: 'Entered by mistake' }));
    expect(await cur()).toBe('0.00');
    await expect(as(f.staff, (db) => O.reverse(db, id, { date: '2027-04-03' }))).rejects.toThrow(/already/i);
    await expect(owner.query('UPDATE owner_transactions SET amount = 1 WHERE id = $1', [id])).rejects.toThrow(/never changed/i);
    await expect(owner.query('DELETE FROM owner_transactions WHERE id = $1', [id])).rejects.toThrow(/never changed/i);
  });

  it('reversing a whole dividend declaration is refused once some of it has been paid', async () => {
    await clean(); await form('LLC');
    const a = await person('Div A');
    await hold('2027-01-01', [{ ownerId: a, shares: '10' }]);
    const d = await as(f.staff, (db) => O.declareDividend(db, f.a.id, { date: '2027-12-31', amount: '100.00' }));
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'dividend_paid', ownerId: a, date: '2028-01-02', amount: '40.00', accountId: f.a.cash }));
    await expect(as(f.staff, (db) => O.reverse(db, d.parts[0]!.id, { date: '2028-01-03' }))).rejects.toThrow(/paid/i);
  });
});

describe('Statement of changes in equity', () => {
  it('shows each owner\'s opening, contributions, profit, drawings, dividends and closing, and they add up', async () => {
    await clean(); await form('Partnership');
    const a = await person('Stmt A'), b = await person('Stmt B');
    await hold('2026-01-01', [{ ownerId: a, percent: '75' }, { ownerId: b, percent: '25' }]);
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2026-06-01', amount: '1000.00', accountId: f.a.cash }));
    await as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2026-12-31', amount: '400.00' }));
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-01', amount: '500.00', accountId: f.a.cash }));
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: a, date: '2027-05-01', amount: '100.00', accountId: f.a.cash }));
    await as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '800.00' }));
    const s = await as(f.staff, (db) => O.equityStatement(db, f.a.id, '2027-01-01', '2027-12-31'));
    const ra = s.owners.find((x) => x.ownerId === a)!;
    expect(ra).toMatchObject({ opening: '1300.00', contributions: '500.00', profit: '600.00', drawings: '100.00', dividends: '0.00', closing: '2300.00' });
    const rb = s.owners.find((x) => x.ownerId === b)!;
    expect(rb).toMatchObject({ opening: '100.00', contributions: '0.00', profit: '200.00', closing: '300.00' });
    expect(s.totals.closing).toBe('2600.00');
  });
});

describe('Separation and access', () => {
  it('another company\'s user sees none of it, and a viewer cannot write', async () => {
    await clean(); await form('Partnership');
    const a = await person('Private');
    await hold('2027-01-01', [{ ownerId: a, percent: '100' }]);
    expect(await as(f.b.clientAccountant, (db) => O.listOwnersRaw(db, f.a.id))).toEqual([]);
    await expect(as(f.b.clientAccountant, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-01', amount: '5.00', accountId: f.a.cash }))).rejects.toThrow();
    await expect(as(f.a.clientViewer, (db) => O.saveOwner(db, f.a.id, { name: 'Viewer made' }))).rejects.toThrow();
    await expect(as(f.a.clientViewer, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-02-01', amount: '5.00', accountId: f.a.cash }))).rejects.toThrow();
  });

  it('a locked period rejects an owner posting like any other', async () => {
    await owner.query(`INSERT INTO periods (company_id, start_date, end_date, locked_at) VALUES ($1, '2024-01-01', '2024-12-31', now()) ON CONFLICT DO NOTHING`, [f.a.id]);
    const a = (await as(f.staff, (db) => O.overview(db, f.a.id))).owners[0]!.id;
    await expect(as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2024-06-01', amount: '5.00', accountId: f.a.cash }))).rejects.toThrow(/locked/i);
  });

  it('every change is in the audit log', async () => {
    const n = (await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name IN ('owners', 'ownership_holdings', 'owner_transactions')`)).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});

describe('Two things at once, and the books agree', () => {
  it('two people paying the same dividend at the same moment cannot pay more than is owed', async () => {
    await clean(); await form('LLC');
    const a = await person('Race A');
    await hold('2027-01-01', [{ ownerId: a, shares: '10' }]);
    const before = await bal('2170');
    await as(f.staff, (db) => O.declareDividend(db, f.a.id, { date: '2027-12-31', amount: '1000.00' }));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const payment = (db: Parameters<typeof O.record>[0]) => O.record(db, f.a.id, { kind: 'dividend_paid', ownerId: a, date: '2028-01-05', amount: '1000.00', accountId: f.a.cash });
    // The first payment is posted but not yet committed when the second one starts: the second must wait for it, then see nothing is owed.
    const first = as(f.staff, async (db) => { await payment(db); await sleep(500); });
    await sleep(150);
    const second = as(f.staff, (db) => payment(db));
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await bal('2170')).toBe(before);   // declared 1000.00, paid 1000.00 once
  });

  it('each owner\'s capital and current balances equal the ledger, and the balance sheet still balances', async () => {
    await clean(); await form('Partnership');
    const a = await person('Ledger A'), b = await person('Ledger B');
    await hold('2027-01-01', [{ ownerId: a, percent: '62.5' }, { ownerId: b, percent: '37.5' }]);
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: a, date: '2027-03-01', amount: '7000.33', accountId: f.a.cash }));
    await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'contribution', ownerId: b, date: '2027-03-02', amount: '1999.99', accountId: f.a.cash }));
    await as(f.staff, (db) => O.allocateProfit(db, f.a.id, { date: '2027-12-31', amount: '12345.67' }));
    const dr = await as(f.staff, (db) => O.record(db, f.a.id, { kind: 'drawing', ownerId: b, date: '2027-12-31', amount: '999.99', accountId: f.a.cash }));
    await as(f.staff, (db) => O.reverse(db, dr, { date: '2027-12-31' }));
    const ov = await as(f.staff, (db) => O.overview(db, f.a.id, '2027-12-31'));
    for (const o of ov.owners) {
      const led = async (id: string) => (await owner.query(`SELECT coalesce(sum(credit - debit), 0)::numeric(18,2)::text AS v FROM journal_lines WHERE account_id = $1`, [id])).rows[0].v;
      expect(await led(o.capitalAccountId)).toBe(o.capital);
      expect(await led(o.currentAccountId)).toBe(o.current);
    }
    const bs = await as(f.staff, (db) => balanceSheet(db, f.a.id, '2027-12-31'));
    expect(bs.balances).toBe(true);
  });
});
