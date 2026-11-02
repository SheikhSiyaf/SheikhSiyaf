// docs/ACCOUNTING_RULES.md > Separation and audit: audit log
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, sale, owner, addPeriod, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, setPeriodLock } from '../src/ledger/ledger.js';

let f: Fixture;
beforeAll(async () => {
  f = await seed();
  await addPeriod(f.a.id, '2026-05-01', '2026-05-31');
});

const logFor = async (rowId: string) =>
  (await owner.query('SELECT user_id, company_id, table_name, action, detail FROM audit_log WHERE row_id = $1 ORDER BY id', [rowId])).rows;

describe('Audit log', () => {
  it('every insert creates an audit_log row (entry and each line), stamped with user and company', async () => {
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-01', '10.00')));
    const entryLog = await logFor(id);
    expect(entryLog).toHaveLength(1);
    expect(entryLog[0]).toMatchObject({ user_id: f.staff, company_id: f.a.id, table_name: 'journal_entries', action: 'insert' });
    const lineIds = (await owner.query('SELECT id FROM journal_lines WHERE entry_id = $1', [id])).rows.map((r) => r.id);
    for (const l of lineIds) {
      expect(await logFor(l)).toMatchObject([{ table_name: 'journal_lines', action: 'insert', company_id: f.a.id }]);
    }
  });

  it('every reversal creates an audit_log row', async () => {
    const id = await as(f.staff, (db) => postEntry(db, sale(f.a, '2026-03-02', '10.00')));
    const rev = await as(f.partner, (db) => reverseEntry(db, id, '2026-03-03'));
    expect(await logFor(rev)).toMatchObject([{ action: 'reverse', user_id: f.partner, company_id: f.a.id }]);
  });

  it('every lock change creates an audit_log row', async () => {
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-05-01', true));
    await as(f.partner, (db) => setPeriodLock(db, f.a.id, '2026-05-01', false));
    const log = await logFor(`${f.a.id}:2026-05-01`);
    expect(log.map((r) => r.action)).toEqual(['insert', 'lock', 'unlock']);
    expect(log[1].user_id).toBe(f.partner);
  });

  it('audit_log cannot be edited or deleted, by the app or even the owner', async () => {
    const { rows } = await owner.query('SELECT id FROM audit_log WHERE company_id = $1 LIMIT 1', [f.a.id]);
    const id = rows[0].id;
    await expect(owner.query(`UPDATE audit_log SET action = 'x' WHERE id = $1`, [id])).rejects.toThrow(/audit log cannot be changed/);
    await expect(owner.query(`DELETE FROM audit_log WHERE id = $1`, [id])).rejects.toThrow(/audit log cannot be changed/);
    await expect(as(f.partner, (db) => db.query(`UPDATE audit_log SET action = 'x' WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(as(f.partner, (db) => db.query(`DELETE FROM audit_log WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(as(f.partner, (db) => db.query(
      `INSERT INTO audit_log (table_name, action, company_id) VALUES ('fake', 'insert', $1)`, [f.a.id]))).rejects.toThrow(/permission denied/);
  });

  it('secrets are never copied into the audit log', async () => {
    const { rows } = await owner.query(`SELECT detail::text AS d FROM audit_log WHERE table_name = 'users' LIMIT 5`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.d).not.toMatch(/password_hash|totp_secret_enc/);
  });
});
