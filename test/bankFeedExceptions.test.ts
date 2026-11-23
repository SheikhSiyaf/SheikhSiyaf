// Bank feeds behind a provider-neutral layer: a transaction is never doubled however often it is fetched (by the provider's own id
// when it has one, by its content otherwise), late-booked lines are caught, an expired or withdrawn consent stops the feed and
// can be renewed in one step, and open lines nothing can place are listed as exceptions (unmatched or mismatched).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as B from '../src/books/bankService.js';
import * as BF from '../src/books/bankFeedService.js';
import { ConsentWithdrawnError, FEED_PROVIDERS, type FeedProvider } from '../src/bankfeeds/providers.js';
import * as S from '../src/books/documentsService.js';
import type { StatementRow } from '../src/bank/statement.js';

let f: Fixture;
let bank: string;
const real = FEED_PROVIDERS.sandbox!;
const lines = async () => (await owner.query(`SELECT txn_date::text AS d, description, amount::text, status, fingerprint FROM bank_statement_lines WHERE bank_account_id = $1 ORDER BY txn_date, description, amount`, [bank])).rows;

// A fake provider: it hands out whatever the test puts in `bank_`, each with a provider id, and can say the consent was withdrawn.
let served: StatementRow[] = [];
let withdrawn = false;
let revoked: string[] = [];
let revokeFails = false;
const fake: FeedProvider = {
  ready: true,
  async connect(ref) { return { externalAccountId: `fake-${ref.slice(-4)}`, consentDays: 90 }; },
  async transactions(_ext, from, to) {
    if (withdrawn) throw new ConsentWithdrawnError('The customer withdrew consent at the bank.');
    return served.filter((l) => l.date >= from && l.date <= to);
  },
  async revoke(ext) { if (revokeFails) throw new Error('provider down'); revoked.push(ext); },
};

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE accounts SET is_bank = true WHERE id = $1`, [f.a.cash]);
  bank = (await owner.query(`SELECT id FROM bank_accounts WHERE account_id = $1`, [f.a.cash])).rows[0].id;
  await owner.query(`UPDATE bank_accounts SET kind = 'bank', bank_name = 'Test Bank', iban = 'SA4420000001234567891234' WHERE id = $1`, [bank]);
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability']]) {
    await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [f.a.id, code, name, type]);
  }
  (FEED_PROVIDERS as Record<string, FeedProvider>).sandbox = fake;   // the real sandbox bank is put back below
});
afterAll(() => { (FEED_PROVIDERS as Record<string, FeedProvider>).sandbox = real; });

const row = (date: string, amount: string, description: string, externalId: string | null = null): StatementRow => ({ date, description, reference: null, amount, balance: null, externalId });

describe('No duplicates', () => {
  it('a transaction fetched again in an overlapping window is recognised by the provider\'s id, even when its text changes', async () => {
    served = [row('2026-08-10', '500.00', 'POS SETTLEMENT', 'tx-1'), row('2026-08-11', '250.00', 'IBAN TRANSFER', 'tx-2')];
    const r = await as(f.staff, (db) => BF.connect(db, bank, 'sandbox', '2026-08-12'));
    expect(r.imported).toBe(2);
    // the bank later fills in a longer description and one more line is booked for a past day
    served = [row('2026-08-10', '500.00', 'POS SETTLEMENT MADA TERMINAL 7', 'tx-1'), row('2026-08-11', '250.00', 'IBAN TRANSFER', 'tx-2'), row('2026-08-12', '90.00', 'LATE LINE', 'tx-3')];
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    const again = await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-13'));
    expect(again.imported).toBe(1);   // only tx-3: tx-1 and tx-2 are the same lines
    expect(again.skipped).toBe(2);
    expect((await lines()).map((l) => l.amount).sort()).toEqual(['250.00', '500.00', '90.00']);
  });

  it('a line the bank books late for a day already synced is still caught (the sync reaches back a few days)', async () => {
    served = [...served, row('2026-08-12', '33.00', 'BOOKED A DAY LATE', 'tx-4')];
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-14'))).imported).toBe(1);
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-14'))).imported).toBe(0);   // and never twice
  });

  it('two genuinely identical transactions with no provider id stay two lines, and are not doubled when fetched again', async () => {
    const same = (d: string) => [row(d, '12.00', 'COFFEE SHOP'), row(d, '12.00', 'COFFEE SHOP')];
    served = [...served.filter((l) => l.externalId), ...same('2026-08-14')];
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-15'))).imported).toBe(2);
    expect((await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-16'))).imported).toBe(0);
    expect((await lines()).filter((l) => l.description === 'COFFEE SHOP')).toHaveLength(2);
  });
});

describe('Consent', () => {
  it('shows a warning in the last days of consent, and stops fetching once it has ended', async () => {
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    await owner.query(`UPDATE bank_feeds SET consent_expires_on = current_date + 5 WHERE id = $1`, [feed.id]);
    const near = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    expect(near).toMatchObject({ status: 'active', consentWarning: true });
    expect(near.consentDaysLeft).toBe(5);
    await owner.query(`UPDATE bank_feeds SET consent_expires_on = '2026-08-15' WHERE id = $1`, [feed.id]);
    const stopped = await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-20'));
    expect(stopped).toMatchObject({ expired: true, imported: 0 });
    expect((await as(f.staff, (db) => BF.feedFor(db, bank))).feed!.status).toBe('expired');
  });

  it('renewing is one step: the same provider is connected again and nothing is missed or doubled', async () => {
    const before = (await lines()).length;
    served = [...served, row('2026-08-18', '70.00', 'AFTER THE GAP', 'tx-5')];
    const r = await as(f.staff, (db) => BF.reconnect(db, bank, '2026-08-20'));
    expect(r.imported).toBe(1);
    expect((await lines()).length).toBe(before + 1);
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    expect(feed).toMatchObject({ status: 'active', provider: 'sandbox' });
    await expect(as(f.staff, (db) => BF.reconnect(db, bank, '2026-08-20'))).rejects.toThrow(/still connected/);
  });

  it('a withdrawn consent stops the feed with the provider\'s reason, and can be renewed', async () => {
    const feed = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    withdrawn = true;
    const r = await as(f.staff, (db) => BF.sync(db, feed.id, '2026-08-22'));
    expect(r).toMatchObject({ expired: true, withdrawn: true, imported: 0 });
    const now = (await as(f.staff, (db) => BF.feedFor(db, bank))).feed!;
    expect(now).toMatchObject({ status: 'expired', lastError: 'The customer withdrew consent at the bank.' });
    withdrawn = false;
    expect((await as(f.staff, (db) => BF.reconnect(db, bank, '2026-08-23'))).expired).toBe(false);
  });

  it('disconnecting tells the provider to end the consent; if the provider is down it still disconnects and says so', async () => {
    expect((await as(f.staff, (db) => BF.disconnect(db, bank))).providerNotified).toBe(true);
    expect(revoked).toHaveLength(1);
    await as(f.staff, (db) => BF.connect(db, bank, 'sandbox', '2026-08-24'));
    revokeFails = true;
    expect((await as(f.staff, (db) => BF.disconnect(db, bank))).providerNotified).toBe(false);
    expect((await as(f.staff, (db) => BF.feedFor(db, bank))).feed).toBeNull();
    revokeFails = false;
  });

  it('never keeps a bank login: the feed row holds only the provider\'s account reference and the dates', async () => {
    const cols = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_feeds' ORDER BY column_name`)).rows.map((x) => x.column_name);
    expect(cols).toEqual(['bank_account_id', 'company_id', 'consent_expires_on', 'created_at', 'created_by', 'external_account_id', 'id', 'last_error', 'last_sync_at', 'provider', 'status', 'synced_to']);
  });
});

describe('Exceptions', () => {
  let invoiceNumber = '', due = '';
  beforeAll(async () => {
    // an open invoice for a customer, to say what a payment is for
    const customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Gulf Dates Trading' }));
    const id = await as(f.staff, async (db) => {
      const d = await S.saveDraft(db, f.a.id, { type: 'invoice', contactId: customer, issueDate: '2026-08-30', lines: [{ description: 'Goods', quantity: '1', unitPrice: '1000.00', accountId: f.a.sales, vatCode: 'standard' }] });
      await S.issueDocument(db, d);
      return d;
    });
    const doc = (await owner.query(`SELECT d.number, document_amount_due(d.id)::numeric(18,2)::text AS due FROM documents d WHERE d.id = $1`, [id])).rows[0];
    invoiceNumber = doc.number; due = doc.due;
  });

  it('lists open lines nothing can place as unmatched, and a payment with the wrong amount for its document as a mismatch with the difference', async () => {
    expect(invoiceNumber, 'the fixture needs an open invoice to test a mismatch').not.toBe('');
    const lonely = [row('2026-09-01', '123.45', 'UNKNOWN PAYER 5555', 'ex-1')];
    const short = invoiceNumber ? [row('2026-09-01', String((Number(due) - 10).toFixed(2)), `TRANSFER ${invoiceNumber}`, 'ex-2')] : [];
    served = [...lonely, ...short];
    await as(f.staff, (db) => BF.connect(db, bank, 'sandbox', '2026-09-02'));
    const ex = await as(f.staff, (db) => B.exceptions(db, bank));
    expect(ex.lines.find((l) => l.description === 'UNKNOWN PAYER 5555')!.exception).toEqual({ kind: 'unmatched' });
    if (invoiceNumber) {
      const m = ex.lines.find((l) => l.description.includes(invoiceNumber))!;
      expect(m.exception).toMatchObject({ kind: 'mismatch', documentNumber: invoiceNumber, due, difference: '-10.00', reason: 'short' });
      expect(ex.mismatched).toBeGreaterThanOrEqual(1);
    }
    expect(ex.total).toBe(ex.unmatched + ex.mismatched);
  });

  it('a line that exactly matches a document is a suggestion, not an exception; and other companies never see them', async () => {
    const all = await as(f.staff, (db) => B.statementLines(db, bank, { status: 'open' }));
    for (const l of all) if (l.suggestion) expect(l.exception).toBeNull();
    const other = await seed();
    await expect(as(other.staff, (db) => B.exceptions(db, bank))).rejects.toThrow();
  });
});
