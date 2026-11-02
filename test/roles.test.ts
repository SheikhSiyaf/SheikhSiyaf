// docs/ACCOUNTING_RULES.md > Separation and audit: roles
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, sale, owner, addPeriod, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, setPeriodLock } from '../src/ledger/ledger.js';

let f: Fixture;
let clientEntry: string;
beforeAll(async () => {
  f = await seed();
  await addPeriod(f.a.id, '2026-07-01', '2026-07-31');
  clientEntry = await as(f.a.clientAccountant, (db) => postEntry(db, sale(f.a, '2026-03-01', '75.00')));
});

const lockedAt = async () =>
  (await owner.query(`SELECT locked_at FROM periods WHERE company_id = $1 AND start_date = '2026-07-01'`, [f.a.id])).rows[0].locked_at;

describe('Roles', () => {
  it('partner, staff accountant and client accountant can post', async () => {
    for (const u of [f.partner, f.staff, f.a.clientAccountant]) {
      await expect(as(u, (db) => postEntry(db, sale(f.a, '2026-03-05', '1.00')))).resolves.toBeTruthy();
    }
  });

  it('client_viewer cannot post', async () => {
    await expect(as(f.a.clientViewer, (db) => postEntry(db, sale(f.a, '2026-03-05', '1.00')))).rejects.toThrow(/row-level security/);
    await expect(as(f.a.clientViewer, (db) => reverseEntry(db, clientEntry, '2026-03-06'))).rejects.toThrow(/row-level security/);
  });

  it('reviewer cannot edit client entries (no posting, no reversing, no update)', async () => {
    await expect(as(f.reviewer, (db) => postEntry(db, sale(f.a, '2026-03-05', '1.00')))).rejects.toThrow(/row-level security/);
    await expect(as(f.reviewer, (db) => reverseEntry(db, clientEntry, '2026-03-06'))).rejects.toThrow(/row-level security/);
    await expect(as(f.reviewer, (db) => db.query(`UPDATE journal_entries SET memo = 'x' WHERE id = $1`, [clientEntry]))).rejects.toThrow(/permission denied/);
    // ...but the reviewer can read them.
    const { rows } = await as(f.reviewer, (db) => db.query('SELECT id FROM journal_entries WHERE id = $1', [clientEntry]));
    expect(rows).toHaveLength(1);
  });

  it('only partner can lock/unlock periods', async () => {
    for (const u of [f.staff, f.reviewer, f.a.clientAccountant, f.a.clientViewer, f.admin]) {
      await expect(as(u, (db) => setPeriodLock(db, f.a.id, '2026-07-01', true))).rejects.toThrow(/Only the Firm partner/);
      expect(await lockedAt()).toBeNull();
    }
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-07-01', true));
    expect(await lockedAt()).not.toBeNull();
    for (const u of [f.staff, f.reviewer, f.a.clientAccountant]) {
      await expect(as(u, (db) => setPeriodLock(db, f.a.id, '2026-07-01', false))).rejects.toThrow(/Only the Firm partner/);
      expect(await lockedAt()).not.toBeNull();
    }
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-07-01', false));
    expect(await lockedAt()).toBeNull();
  });

  it('non-partners cannot create a period that is already locked', async () => {
    await expect(as(f.staff, (db) => db.query(
      `INSERT INTO periods (company_id, start_date, end_date, locked_at) VALUES ($1, '2026-08-01', '2026-08-31', now())`, [f.a.id],
    ))).rejects.toThrow(/row-level security/);
  });

  it('role must match the kind of user; client users belong to one company; admins have no books', async () => {
    const add = (u: string, c: string, r: string) =>
      owner.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)', [u, c, r]);
    await expect(add(f.a.clientAccountant, f.b.id, 'client_accountant')).rejects.toThrow(/their own company/);
    await expect(add(f.staff, f.b.id, 'client_accountant')).rejects.toThrow(/Firm staff can only be/);
    await expect(add(f.admin, f.a.id, 'partner')).rejects.toThrow(/Administrators cannot/);
  });

  it('only the Administrator adds clients, staff and users', async () => {
    const userSql = `INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'firm_staff', 'New', $2)`;
    await expect(as(f.partner, (db) => db.query(userSql, [f.firmId, `new.${Date.now()}@example.com`]))).rejects.toThrow(/row-level security/);
    await expect(as(f.admin, (db) => db.query(userSql, [f.firmId, `new.${Date.now()}@example.com`]))).resolves.toBeTruthy();
    await expect(as(f.partner, (db) => db.query(
      `INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, 'staff_accountant')`, [f.staff, f.b.id]))).rejects.toThrow(/row-level security/);
  });
});
