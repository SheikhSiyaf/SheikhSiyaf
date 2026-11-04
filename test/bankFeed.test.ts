// Direct bank feeds (db/migrations/0038): a connected bank account brings its transactions in as statement lines
// through the statement import (no duplicates), the bank rules book what they recognise, and the job syncs as the
// person who connected it. Feeds stay with their company.
import { describe, it, expect, beforeAll } from 'vitest';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/bankService.js';
import * as BF from '../src/books/bankFeedService.js';
import { FEED_PROVIDERS } from '../src/bankfeeds/providers.js';

let f: Fixture;
let bank: string;
const lines = async () => (await owner.query(`SELECT txn_date::text AS d, description, amount::text, status FROM bank_statement_lines WHERE bank_account_id = $1 ORDER BY txn_date, description`, [bank])).rows;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  bank = (await owner.query(`SELECT id FROM bank_accounts WHERE account_id = $1`, [f.a.cash])).rows[0].id;
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [f.a.id, code, name, type]);
  }
  await owner.query(`UPDATE bank_accounts SET kind = 'bank', bank_name = 'Al Rajhi Bank' WHERE id = $1`, [bank]);
});

describe('Sandbox bank', () => {
  it('gives the same lines for the same days, and customers paying open invoices by transfer for what is due', async () => {
    const p = FEED_PROVIDERS.sandbox!;
    const a = await p.transactions('sbx-1234', '2026-06-01', '2026-06-10', { feedId: 'x' });
    expect(a.length).toBeGreaterThan(3);
    expect(await p.transactions('sbx-1234', '2026-06-01', '2026-06-10', { feedId: 'x' })).toEqual(a);
    expect(a).toContainEqual({ date: '2026-06-01', description: 'MONTHLY ACCOUNT FEE', reference: null, amount: '-25.00', balance: null });
    const invoices = Array.from({ length: 10 }, (_, i) => ({ id: `inv-${i}`, number: `INV-${i}`, customer: 'Gulf Steel', issueDate: '2026-06-02', due: '115.00' }));
    const paid = (await p.transactions('sbx-1234', '2026-06-01', '2026-06-10', { feedId: 'x', openInvoices: invoices })).filter((l) => l.description.startsWith('IBAN TRANSFER'));
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((l) => l.date === '2026-06-09' && l.amount === '115.00')).toBe(true);
  });
  it('Lean and Tarabut cannot be connected until there is an agreement', async () => {
    await expect(as(f.staff, (db) => BF.connect(db, bank, 'lean'))).rejects.toThrow(/not connected yet/);
  });
});

describe('A connected bank account', () => {
  it('only someone who posts connects it; the first sync brings the last 30 days in', async () => {
    await expect(as(f.a.clientViewer, (db) => BF.connect(db, bank, 'sandbox', '2026-06-30'))).rejects.toThrow();
    const r = await as(f.staff, (db) => BF.connect(db, bank, 'sandbox', '2026-06-30'));
    expect(r.imported).toBeGreaterThan(5);
    const ls = await lines();
    expect(ls[0]!.d >= '2026-05-31').toBe(true);
    expect(ls.at(-1)!.d <= '2026-06-30').toBe(true);
    const imp = (await owner.query(`SELECT file_name, feed_id FROM bank_imports WHERE bank_account_id = $1`, [bank])).rows;
    expect(imp).toEqual([{ file_name: 'Bank feed 2026-05-31 to 2026-06-30', feed_id: r.id }]);
    await expect(as(f.staff, (db) => BF.connect(db, bank, 'sandbox', '2026-06-30'))).rejects.toThrow(/already connected/);
  });

  it('syncing again the same day adds nothing; the next days add only their lines; rules book the bank fee', async () => {
    const before = (await lines()).length;
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed;
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-06-30'))).imported).toBe(0);
    await as(f.staff, (db) => B.saveRule(db, f.a.id, { matchText: 'ACCOUNT FEE', direction: 'out', accountId: f.a.rent, vatCode: 'out_of_scope' }));
    const r = await as(f.staff, (db) => BF.sync(db, feed.id, '2026-07-03'));
    const after = await lines();
    expect(after.length).toBe(before + r.imported);
    expect(after.filter((l) => l.d > '2026-06-30').length).toBe(r.imported);
    expect(after.find((l) => l.d === '2026-07-01' && l.description === 'MONTHLY ACCOUNT FEE')!.status).toBe('matched');
    expect(r.booked).toBeGreaterThan(0);
  });

  it('the job syncs as the person who connected it; an expired consent stops the feed until it is connected again', async () => {
    await owner.query(`UPDATE bank_feeds SET last_sync_at = now() - interval '7 hours' WHERE bank_account_id = $1`, [bank]);
    const out = (await BF.runBankFeeds(appPool, '2026-07-05')).filter((x) => x.problem === null);
    expect(out.length).toBeGreaterThan(0);
    const who = (await owner.query(`SELECT DISTINCT imported_by FROM bank_imports WHERE bank_account_id = $1`, [bank])).rows.map((x) => x.imported_by);
    expect(who).toEqual([f.staff]);
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed;
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-12-31'))).expired).toBe(true);
    expect((await as(f.staff, (db) => BF.feedFor(db, bank))).feed.status).toBe('expired');
    await as(f.staff, (db) => BF.disconnect(db, bank));
    expect((await as(f.staff, (db) => BF.feedFor(db, bank))).feed).toBeNull();
    await expect(owner.query(`UPDATE bank_feeds SET status = 'active' WHERE id = $1`, [feed.id])).rejects.toThrow(/stays disconnected/);
    await expect(owner.query(`DELETE FROM bank_feeds WHERE id = $1`, [feed.id])).rejects.toThrow();
  });

  it('other companies never see the feed', async () => {
    const other = await seed();
    expect((await as(other.staff, (db) => db.query('SELECT * FROM bank_feeds'))).rows).toHaveLength(0);
    await expect(as(f.staff, (db) => db.query('SELECT * FROM bank_feeds_due(0)'))).resolves.toMatchObject({ rows: [] });
  });
});
