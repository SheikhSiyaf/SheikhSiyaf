// Multi-currency accounts, exchange rates, the daily sync and the month-end revaluation (IAS 21)
// (db/migrations/0029_multi_currency.sql, src/books/fxService.ts, src/books/fxJobs.ts).
import { describe, it, expect, beforeAll } from 'vitest';
import { app, as, owner, seed, addPeriod, type Fixture } from './helpers.js';
import { postEntry, reverseEntry } from '../src/ledger/ledger.js';
import * as Setup from '../src/books/setupService.js';
import * as Fx from '../src/books/fxService.js';
import { runAutoRevaluations, syncRates } from '../src/books/fxJobs.js';

let f: Fixture;
let usd: string, eur: string, equity: string, opening: string;
const line = async (entry: string, account: string) => (await owner.query('SELECT debit::text, credit::text, fx_amount::text AS fx FROM journal_lines WHERE entry_id = $1 AND account_id = $2', [entry, account])).rows[0];
const code = async (c: string) => (await owner.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, c])).rows[0]?.id as string | undefined;

beforeAll(async () => {
  f = await seed();
  equity = (await code('3000')) ?? (await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '3000', 'Owner', 'equity') RETURNING id`, [f.a.id])).rows[0].id;
});

describe('Accounts in another currency', () => {
  it('asset and liability accounts can be kept in another currency; the company currency means none', async () => {
    usd = await as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '1020', name: 'USD account (Citi)', type: 'asset', currency: 'USD' }));
    eur = await as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '2010', name: 'Loan from Munich supplier', type: 'liability', currency: 'EUR' }));
    const sar = await as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '1030', name: 'Petty cash', type: 'asset', currency: 'SAR' }));
    expect((await owner.query('SELECT currency FROM accounts WHERE id = $1', [sar])).rows[0].currency).toBeNull();
    await expect(as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '3100', name: 'x', type: 'equity', currency: 'USD' }))).rejects.toThrow(/Only asset and liability/);
    await expect(as(f.staff, (db) => db.query(`UPDATE accounts SET currency = 'USD' WHERE id = $1`, [f.a.cash]))).rejects.toThrow(/used by the sales/);
  });

  it('every line on it gives the foreign amount and rate, and amount = foreign amount x rate', async () => {
    const entry = (fxAmount?: string, fxRate?: string, amount = '37400.00') => as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-10', memo: 'Capital in USD',
      lines: [{ accountId: usd, debit: amount, fxAmount, fxRate }, { accountId: equity, credit: amount }] }));
    await expect(entry()).rejects.toThrow(/kept in USD/);
    await expect(entry('10000.00', '3.74', '37500.00')).rejects.toThrow(/times the rate/);
    await expect(as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-10', lines: [{ accountId: f.a.cash, debit: '1.00', fxAmount: '1.00', fxRate: '1' }, { accountId: equity, credit: '1.00' }] })))
      .rejects.toThrow(/company's currency/);
    opening = await entry('10000.00', '3.74');
    expect(await line(opening, usd)).toEqual({ debit: '37400.00', credit: '0.00', fx: '10000.00' });
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-12', memo: 'Loan in EUR',
      lines: [{ accountId: eur, credit: '20000.00', fxAmount: '5000.00', fxRate: '4' }, { accountId: f.a.rent, debit: '20000.00' }] }));
    // The currency of an account with postings no longer changes.
    await expect(as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '1020', name: 'USD account (Citi)', type: 'asset', currency: 'GBP' }, usd))).rejects.toThrow(/has postings/);
    // A reversal carries the foreign amounts.
    const tmp = await entry('1.00', '3.74', '3.74');
    const rev = await as(f.staff, (db) => reverseEntry(db, tmp, '2026-03-11'));
    expect(await line(rev, usd)).toEqual({ debit: '0.00', credit: '3.74', fx: '1.00' });
  });
});

describe('Exchange rates', () => {
  it('the daily sync stores the provider rates; GCC currencies come from the central bank pegs', async () => {
    const fake = async (url: string) => { expect(url).toContain('SAR'); return { base_code: 'USD', rates: { USD: 1, SAR: 3.7503, AED: 3.6725, EUR: 0.92, GBP: 0.79, JPY: 150 } }; };
    const r = await syncRates(app, { day: '2026-03-31', fetchJson: fake, url: 'https://rates.example/{base}' });
    expect(r.find((x) => x.base === 'SAR')).toMatchObject({ provider: true, problem: null });
    const rate = (c: string) => as(f.staff, (db) => Fx.rateFor(db, f.a.id, c, '2026-03-31'));
    expect(await rate('USD')).toMatchObject({ rate: '3.75', source: 'central bank peg' });       // the peg, not the market's 3.7503
    expect(await rate('EUR')).toMatchObject({ rate: '4.07641304', source: 'rates.example' });   // 3.7503 / 0.92
    // Provider down: the pegs are still there.
    const down = await syncRates(app, { day: '2026-04-30', fetchJson: async () => { throw new Error('timeout'); } });
    expect(down.find((x) => x.base === 'SAR')).toMatchObject({ provider: false, problem: 'timeout' });
    expect(await as(f.staff, (db) => Fx.rateFor(db, f.a.id, 'USD', '2026-04-30'))).toMatchObject({ rate: '3.75', rateDate: '2026-04-30' });
    expect(await as(f.staff, (db) => Fx.rateFor(db, f.a.id, 'EUR', '2026-04-30'))).toMatchObject({ rateDate: '2026-03-31' });   // latest before
    // Nobody signed in writes shared rates.
    await expect(as(f.staff, (db) => db.query(`SELECT store_shared_rates('[]')`))).rejects.toThrow(/daily sync/);
    await expect(as(f.staff, (db) => db.query(`INSERT INTO exchange_rates (rate_date, currency, base, rate, source) VALUES ('2026-03-31', 'USD', 'SAR', 9, 'x')`))).rejects.toThrow();
  });

  it("a company's own rate wins on the same day and is never seen by other companies", async () => {
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'EUR', date: '2026-03-31', rate: '4.07' }));
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'EUR', date: '2026-03-31', rate: '4.07' }));   // same day: replaced, not doubled
    expect(await as(f.staff, (db) => Fx.rateFor(db, f.a.id, 'EUR', '2026-03-31'))).toMatchObject({ rate: '4.07', source: 'company' });
    await expect(as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'EUR', date: '2026-03-31', rate: '-1' }))).rejects.toThrow(/above 0/);
    expect((await as(f.b.clientAccountant, (db) => db.query(`SELECT 1 FROM exchange_rates WHERE company_id = $1`, [f.a.id]))).rows).toEqual([]);
    expect(await as(f.b.clientAccountant, (db) => Fx.rateFor(db, f.a.id, 'EUR', '2026-03-31'))).toBeNull();
  });
});

describe('Month-end revaluation', () => {
  it('shows the restatement at the closing rate before posting', async () => {
    const p = await as(f.staff, (db) => Fx.preview(db, f.a.id, '2026-03-31'));
    expect(p.lines.map((l) => [l.code, l.fxBalance, l.bookValue, l.rate, l.closingValue, l.adjustment, l.kind])).toEqual([
      ['1020', '10000.00', '37400.00', '3.75', '37500.00', '100.00', 'unrealised'],
      ['2010', '-5000.00', '-20000.00', '4.07', '-20350.00', '-350.00', 'unrealised'],
    ]);
    expect(p).toMatchObject({ unrealised: '-250.00', realised: '0.00', missing: [], locked: false, alreadyDone: null });
  });

  it('posts one entry on the month end: accounts against unrealised exchange gains and losses; once per month', async () => {
    const r = await as(f.staff, (db) => Fx.post(db, f.a.id, '2026-03-31'));
    const u = (await code('4950'))!;
    expect(await line(r.entryId!, usd)).toEqual({ debit: '100.00', credit: '0.00', fx: '0.00' });
    expect(await line(r.entryId!, eur)).toEqual({ debit: '0.00', credit: '350.00', fx: '0.00' });
    expect(await line(r.entryId!, u)).toEqual({ debit: '250.00', credit: '0.00', fx: null });
    expect((await owner.query('SELECT entry_date::text AS d, source_type FROM journal_entries WHERE id = $1', [r.entryId])).rows[0]).toEqual({ d: '2026-03-31', source_type: 'fx_revaluation' });
    await expect(as(f.staff, (db) => Fx.post(db, f.a.id, '2026-03-31'))).rejects.toThrow(/already revalued/);
    // Nothing else may post a company-currency difference on a foreign account.
    await expect(as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-03-31', lines: [{ accountId: usd, debit: '1.00', fxAmount: '0', fxRate: '1' }, { accountId: equity, credit: '1.00' }] })))
      .rejects.toThrow(/kept in USD/);
    // A second run on the restated balances finds nothing more.
    expect((await as(f.staff, (db) => Fx.preview(db, f.a.id, '2026-03-31'))).lines.every((l) => l.adjustment === '0.00')).toBe(true);
  });

  it('reversing it puts the balances back; then it can be done again', async () => {
    const [last] = await as(f.staff, (db) => Fx.list(db, f.a.id));
    await as(f.staff, (db) => Fx.reverse(db, last.id));
    await expect(as(f.staff, (db) => Fx.reverse(db, last.id))).rejects.toThrow(/already reversed/);
    expect((await as(f.staff, (db) => Fx.preview(db, f.a.id, '2026-03-31'))).unrealised).toBe('-250.00');
    await as(f.staff, (db) => Fx.post(db, f.a.id, '2026-03-31'));
  });

  it('settled balances show the realised difference; a missing rate or a locked month stops the posting', async () => {
    // April: the USD is spent at 3.76, the foreign balance is nil: the 100.00 left is realised.
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-04-15', memo: 'USD paid out',
      lines: [{ accountId: usd, credit: '37600.00', fxAmount: '10000.00', fxRate: '3.76' }, { accountId: equity, debit: '37600.00' }] }));
    const p = await as(f.staff, (db) => Fx.preview(db, f.a.id, '2026-04-30'));
    expect(p.lines.find((l) => l.code === '1020')).toMatchObject({ fxBalance: '0.00', bookValue: '-100.00', adjustment: '100.00', kind: 'realised' });
    expect(p.realised).toBe('100.00');
    // JPY account without a rate before its first rate date: refused with the currency named.
    const jpy = await as(f.staff, (db) => Setup.saveAccount(db, f.a.id, { code: '1040', name: 'Yen deposit', type: 'asset', currency: 'CHF' }));
    await as(f.staff, (db) => postEntry(db, { companyId: f.a.id, entryDate: '2026-04-20', lines: [{ accountId: jpy, debit: '420.00', fxAmount: '100.00', fxRate: '4.2' }, { accountId: equity, credit: '420.00' }] }));
    await expect(as(f.staff, (db) => Fx.post(db, f.a.id, '2026-04-30'))).rejects.toThrow(/no rate for CHF/);
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'CHF', date: '2026-04-30', rate: '4.25' }));
    await addPeriod(f.a.id, '2026-04-01', '2026-04-30', true);
    await expect(as(f.staff, (db) => Fx.post(db, f.a.id, '2026-04-30'))).rejects.toThrow(/locked/);
    await owner.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND start_date = '2026-04-01'`, [f.a.id]);
    const r = await as(f.staff, (db) => Fx.post(db, f.a.id, '2026-04-30'));
    const realised = (await code('4951'))!;
    expect(await line(r.entryId!, realised)).toEqual({ debit: '0.00', credit: '100.00', fx: null });
    // An earlier month cannot be redone while a later one stands.
    const march = (await as(f.staff, (db) => Fx.list(db, f.a.id))).find((x) => x.periodEnd === '2026-03-31' && x.status === 'posted')!;
    await expect(as(f.staff, (db) => Fx.reverse(db, march.id))).rejects.toThrow(/later month/);
  });

  it('the automatic month-end run revalues as the person who turned it on, and skips locked months', async () => {
    await as(f.staff, (db) => Fx.saveSettings(db, f.a.id, { autoRevalue: true }));
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'EUR', date: '2026-05-31', rate: '4.1' }));
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'CHF', date: '2026-05-31', rate: '4.3' }));
    await as(f.staff, (db) => Fx.saveRate(db, f.a.id, { currency: 'USD', date: '2026-05-31', rate: '3.75' }));
    await addPeriod(f.a.id, '2026-05-01', '2026-05-31', true);
    expect(await runAutoRevaluations(app, '2026-06-02')).toEqual([]);
    await owner.query(`UPDATE periods SET locked_at = NULL WHERE company_id = $1 AND start_date = '2026-05-01'`, [f.a.id]);
    const out = await runAutoRevaluations(app, '2026-06-02');
    expect(out).toEqual([{ companyId: f.a.id, ok: true, problem: null }]);
    const may = (await owner.query(`SELECT automatic, created_by FROM fx_revaluations WHERE company_id = $1 AND period_end = '2026-05-31' AND status = 'posted'`, [f.a.id])).rows[0];
    expect(may).toEqual({ automatic: true, created_by: f.staff });
    expect(await runAutoRevaluations(app, '2026-06-03')).toEqual([]);   // done once
    expect((await as(f.staff, (db) => Fx.settings(db, f.a.id))).enabledBy).toBeTruthy();
  });
});
