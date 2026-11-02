// docs/ACCOUNTING_RULES.md > Periods
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, sale, addPeriod, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, setPeriodLock } from '../src/ledger/ledger.js';

let f: Fixture;
beforeAll(async () => {
  f = await seed();
  await addPeriod(f.a.id, '2026-01-01', '2026-01-31', true);   // locked
  await addPeriod(f.a.id, '2026-02-01', '2026-02-28', false);  // open
});

describe('Periods', () => {
  it('posting into a locked period is rejected; unlocked period accepts', async () => {
    await expect(as(f.staff, (db) => postEntry(db, sale(f.a, '2026-01-15', '10.00')))).rejects.toThrow(/period is locked/);
    await expect(as(f.partner, (db) => postEntry(db, sale(f.a, '2026-01-31', '10.00')))).rejects.toThrow(/period is locked/);
    await expect(as(f.staff, (db) => postEntry(db, sale(f.a, '2026-02-01', '10.00')))).resolves.toBeTruthy();
    // Dates with no period defined are open.
    await expect(as(f.staff, (db) => postEntry(db, sale(f.a, '2026-06-01', '10.00')))).resolves.toBeTruthy();
  });

  it('reversal of an entry in a locked period must be dated in an open period', async () => {
    await addPeriod(f.a.id, '2026-03-01', '2026-03-31', false);
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-10', '25.00')));
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-03-01', true));
    await expect(as(f.staff, (db) => reverseEntry(db, id, '2026-03-31'))).rejects.toThrow(/period is locked/);
    await expect(as(f.staff, (db) => reverseEntry(db, id, '2026-02-10'))).resolves.toBeTruthy();
  });

  it('periods cannot overlap and their dates cannot be changed', async () => {
    await expect(addPeriod(f.a.id, '2026-02-15', '2026-03-15')).rejects.toThrow(/conflicting key|exclusion/);
    await expect(as(f.partner, (db) => db.query(
      `UPDATE periods SET end_date = '2026-02-27' WHERE company_id = $1 AND start_date = '2026-02-01'`, [f.a.id],
    ))).rejects.toThrow(/dates cannot be changed/);
  });
});
