// Support chat (db/migrations/0042): a customer's people raise issues with Nusuh Books; the owner answers. Each person
// sees only their own conversations (their Administrator sees the customer's); nobody can write as Nusuh Books.
import { describe, it, expect, beforeAll } from 'vitest';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import * as Sup from '../src/books/supportService.js';

let f: Fixture, other: Fixture;
let thread: string;

beforeAll(async () => {
  f = await seed();
  other = await seed();
  await owner.query(`UPDATE users SET email = $2 WHERE id = $1`, [f.a.clientAccountant, `ca.${Date.now()}@support-test.example`]);
});

describe('Raising an issue', () => {
  it('a client user raises it, about their own company only', async () => {
    await expect(as(f.a.clientAccountant, (db) => Sup.open(db, { subject: 'VAT return', body: 'Help', companyId: f.b.id }))).rejects.toThrow(/different company/);
    await expect(as(f.a.clientAccountant, (db) => Sup.open(db, { subject: '', body: 'Help' }))).rejects.toThrow(/what it is about/);
    thread = await as(f.a.clientAccountant, (db) => Sup.open(db, { subject: 'Cannot issue an invoice', category: 'problem', companyId: f.a.id,
      body: 'The Issue button stays grey on ANT-0004.' }));
    const mine = await as(f.a.clientAccountant, (db) => Sup.list(db));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subject: 'Cannot issue an invoice', status: 'open', unread: 0, messages: 1 });
  });

  it('the owner sees it with the customer and company, answers, and the customer sees one unread reply from Nusuh Books', async () => {
    const all = await as(f.platformOwner, (db) => Sup.list(db));
    const t = all.find((x) => x.id === thread)!;
    expect(t).toMatchObject({ customer: 'Test firm', unread: 1, status: 'open' });
    expect(t.company).toMatch(/^Test SA/);
    const view = await as(f.platformOwner, (db) => Sup.get(db, thread));
    expect(view.messages.map((m: { fromOwner: boolean }) => m.fromOwner)).toEqual([false]);
    expect((await as(f.platformOwner, (db) => Sup.list(db))).find((x) => x.id === thread)!.unread).toBe(0);   // opening it marks it read
    await as(f.platformOwner, (db) => Sup.post(db, thread, 'The customer needs a VAT number first: add it on the customer.', 'https://books.example'));
    const mine = (await as(f.a.clientAccountant, (db) => Sup.list(db)))[0]!;
    expect(mine).toMatchObject({ status: 'answered', unread: 1 });
    const v = await as(f.a.clientAccountant, (db) => Sup.get(db, thread));
    expect(v.messages[1]).toMatchObject({ fromOwner: true, authorName: 'Nusuh Books', mine: false });
    expect(await as(f.a.clientAccountant, (db) => Sup.unread(db))).toBe(0);
    // The reply is emailed to the person who raised it, with a link to the app.
    const mail = (await owner.query(`SELECT to_email, body_text FROM email_outbox WHERE kind = 'notice' AND firm_id = $1`, [f.firmId])).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0].body_text).toContain('Cannot issue an invoice');
    expect(mail[0].body_text).toContain('https://books.example');
  });

  it('a customer reply opens it again; either side can close it; a new message reopens it', async () => {
    await as(f.a.clientAccountant, (db) => Sup.post(db, thread, 'Done, thank you.'));
    expect((await as(f.platformOwner, (db) => Sup.list(db))).find((x) => x.id === thread)).toMatchObject({ status: 'open', unread: 1 });
    expect(await as(f.platformOwner, (db) => Sup.unread(db))).toBeGreaterThanOrEqual(1);
    await as(f.platformOwner, (db) => Sup.close(db, thread));
    expect((await as(f.a.clientAccountant, (db) => Sup.list(db)))[0]!.status).toBe('closed');
    await as(f.a.clientAccountant, (db) => Sup.post(db, thread, 'One more question.'));
    expect((await as(f.a.clientAccountant, (db) => Sup.list(db)))[0]!.status).toBe('open');
  });
});

describe('Who sees what', () => {
  it("the customer's Administrator sees it; other people of the same customer and other customers do not", async () => {
    expect((await as(f.admin, (db) => Sup.list(db))).map((x) => x.id)).toContain(thread);
    expect(await as(f.staff, (db) => Sup.list(db))).toEqual([]);
    expect(await as(other.a.clientAccountant, (db) => Sup.list(db))).toEqual([]);
    expect(await as(other.admin, (db) => Sup.list(db))).toEqual([]);
    await expect(as(other.admin, (db) => Sup.get(db, thread))).rejects.toThrow(/Not found/);
    await expect(as(other.admin, (db) => Sup.post(db, thread, 'x'))).rejects.toThrow(/Not found/);
    expect((await as(other.a.clientAccountant, (db) => db.query('SELECT * FROM support_messages'))).rows).toHaveLength(0);
  });

  it('nobody writes as Nusuh Books, and messages are never changed', async () => {
    await expect(as(f.a.clientAccountant, (db) => db.query(`INSERT INTO support_messages (thread_id, author, from_owner, body) VALUES ($1, $2, true, 'fake')`, [thread, f.a.clientAccountant])))
      .rejects.toThrow(/permission denied/);
    await expect(appPool.query(`UPDATE support_threads SET status = 'closed'`)).rejects.toThrow(/permission denied/);
    await expect(owner.query(`UPDATE support_messages SET body = 'changed' WHERE thread_id = $1`, [thread])).rejects.toThrow();
    // Raised by the owner? No: the owner answers, customers raise.
    await expect(as(f.platformOwner, (db) => Sup.open(db, { subject: 'x', body: 'y' }))).rejects.toThrow(/Not allowed/);
  });
});
