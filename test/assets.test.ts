// Fixed asset register: monthly straight-line depreciation and disposal.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as F from '../src/books/assetsService.js';
import { toMinor } from '../src/money.js';

let f: Fixture;
let equipment: string, accDep: string, depExp: string, van: string, laptop: string;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  for (const [code, name, type] of [['1500', 'Equipment', 'asset'], ['1590', 'Accumulated depreciation', 'asset'], ['5050', 'Depreciation', 'expense'],
    ['4900', 'Gain or loss on sale of assets', 'income']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4)`, [f.a.id, code, name, type]);
  }
  const acct = async (code: string) => (await owner.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = $2`, [f.a.id, code])).rows[0].id;
  equipment = await acct('1500'); accDep = await acct('1590'); depExp = await acct('5050');
  van = await as(f.staff, (db) => F.saveAsset(db, f.a.id, { name: 'Delivery van', assetAccountId: equipment, purchaseDate: '2025-01-10', cost: '72000.00',
    residualValue: '12000.00', usefulLifeMonths: 60, costCentreId: f.a.branch1 }));
  laptop = await as(f.staff, (db) => F.saveAsset(db, f.a.id, { name: 'Laptop', assetAccountId: equipment, purchaseDate: '2025-03-20', cost: '3600.00',
    usefulLifeMonths: 36, openingDepreciation: '500.00' }));
});

const run = (periodEnd: string, user = f.a.clientAccountant) => as(user, (db) => F.runDepreciation(db, f.a.id, periodEnd));

describe('Registering assets', () => {
  it('numbers them and checks cost, residual value, life and accounts', async () => {
    expect((await as(f.staff, (db) => F.getAsset(db, van))).number).toBe('FA-0001');
    await expect(as(f.staff, (db) => F.saveAsset(db, f.a.id, { name: 'X', assetAccountId: equipment, purchaseDate: '2025-01-01', cost: '100.00', residualValue: '100.00', usefulLifeMonths: 12 })))
      .rejects.toThrow(/less than the cost/);
    await expect(as(f.staff, (db) => F.saveAsset(db, f.a.id, { name: 'X', assetAccountId: f.a.cash, purchaseDate: '2025-01-01', cost: '100.00', usefulLifeMonths: 12 })))
      .rejects.toThrow(/fixed asset account/);
    await expect(as(f.staff, (db) => F.saveAsset(db, f.a.id, { name: 'X', assetAccountId: equipment, purchaseDate: '2025-01-01', cost: '100.00', usefulLifeMonths: 0 })))
      .rejects.toThrow(/useful life/);
  });
});

describe('Depreciation runs', () => {
  it('the first run catches up every month since each asset started, in one entry Dr depreciation / Cr 1590', async () => {
    const r = await run('2025-06-30');
    // Van: 60,000 / 60 = 1,000 a month x 6 months. Laptop: 3,600 x 4/36 = 400, less 500 already depreciated = 0.
    expect(r.total).toBe('6000.00');
    const lines = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text, l.cost_centre_id FROM depreciation_runs r JOIN journal_lines l ON l.entry_id = r.journal_entry_id
      JOIN accounts a ON a.id = l.account_id WHERE r.id = $1 ORDER BY a.code`, [r.runId])).rows;
    expect(lines.map((x) => [x.code, x.debit, x.credit])).toEqual([['1590', '0.00', '6000.00'], ['5050', '6000.00', '0.00']]);
    expect(lines.find((x) => x.code === '5050')!.cost_centre_id).toBe(f.a.branch1);
  });

  it('runs one month at a time, in order, never twice and never for a future month', async () => {
    await expect(run('2025-08-31')).rejects.toThrow(/one month at a time/);
    expect((await run('2025-07-31')).total).toBe('1000.00');   // laptop: 3,600 x 5/36 = 500, all covered by the 500 before Nusuh Books
    await expect(owner.query(`INSERT INTO depreciation_runs (company_id, period_end, run_by) VALUES ($1, '2025-07-31', $2)`, [f.a.id, f.staff])).rejects.toThrow();
    await expect(owner.query(`UPDATE depreciation_runs SET total = 0 WHERE company_id = $1`, [f.a.id])).rejects.toThrow(/never changed/);
  });

  it('the database recomputes every amount', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query(`INSERT INTO depreciation_runs (company_id, period_end, run_by) VALUES ($1, '2025-08-31', $2) RETURNING id`, [f.a.id, f.staff])).rows[0].id;
      await expect(c.query(`INSERT INTO depreciation_lines (company_id, run_id, asset_id, amount) VALUES ($1, $2, $3, 999)`, [f.a.id, id, van])).rejects.toThrow(/depreciation for the asset is 1000/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('cost and life cannot change once depreciation is booked; the name can', async () => {
    await expect(as(f.staff, async (db) => F.saveAsset(db, f.a.id, { ...(await F.getAsset(db, van)), cost: '80000.00', usefulLifeMonths: 60 }, van)))
      .rejects.toThrow(/can no longer change/);
  });

  it('reviewers and view-only users cannot run depreciation; other companies see no assets', async () => {
    await expect(run('2025-08-31', f.reviewer)).rejects.toThrow();
    expect(await as(f.b.clientAccountant, (db) => F.listAssets(db, f.a.id))).toEqual([]);
  });
});

describe('Disposal', () => {
  it('needs depreciation up to the month before; removes cost and accumulated depreciation; the rest is a gain or loss', async () => {
    await expect(as(f.staff, (db) => F.disposeAsset(db, van, { date: '2025-10-15', proceeds: '60000.00', bankAccountId: f.a.cash }))).rejects.toThrow(/Run depreciation up to 2025-09-30/);
    expect((await run('2025-08-31')).total).toBe('1100.00');   // the laptop now adds 100 a month
    await run('2025-09-30');
    const before = await as(f.staff, (db) => F.getAsset(db, van));
    expect(before).toMatchObject({ accumulated: '9000.00', bookValue: '63000.00' });
    await as(f.staff, (db) => F.disposeAsset(db, van, { date: '2025-10-15', proceeds: '60000.00', bankAccountId: f.a.cash }));
    const e = (await owner.query(`SELECT a.code, l.debit::text, l.credit::text FROM fixed_assets x JOIN journal_lines l ON l.entry_id = x.disposal_entry_id
      JOIN accounts a ON a.id = l.account_id WHERE x.id = $1 ORDER BY a.code`, [van])).rows.map((r) => [r.code, r.debit, r.credit]);
    expect(e).toEqual([['1000', '60000.00', '0.00'], ['1500', '0.00', '72000.00'], ['1590', '9000.00', '0.00'], ['4900', '3000.00', '0.00']]);
    await expect(owner.query(`UPDATE fixed_assets SET notes = 'x' WHERE id = $1`, [van])).rejects.toThrow(/never changes/);
    expect((await as(f.staff, (db) => F.previewRun(db, f.a.id, '2025-10-31'))).lines.map((l) => l.number)).toEqual(['FA-0002']);
  });

  it('the register agrees with the books', async () => {
    const s = await as(f.partner, (db) => F.registerSummary(db, f.a.id));
    const laptopNow = await as(f.partner, (db) => F.getAsset(db, laptop));
    expect(s.accumulated).toBe(laptopNow.accumulated);
    // 1590 holds what was posted here; the laptop's 500 before Nusuh Books was in the opening balances, not posted in this test.
    expect(s.accumulated).toBe('700.00');
    expect(toMinor(s.accumulatedInBooks) + 50000n).toBe(toMinor(s.accumulated));
    const posted = (await owner.query(`SELECT sum(credit - debit)::text AS v FROM journal_lines WHERE account_id = $1`, [accDep])).rows[0].v;
    expect(posted).toBe(s.accumulatedInBooks);
    void depExp;
  });
});
