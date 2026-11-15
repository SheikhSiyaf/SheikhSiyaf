// A new support issue emails the platform owner (db/migrations/0049): the subject and counts only, never the message,
// the customer's people or any accounting data. Every active owner gets it; nothing is sent from here (the outbox only).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as Sup from '../src/books/supportService.js';

let f: Fixture;
const outbox = async (since: Date) => (await owner.query(`SELECT o.to_email, o.subject, o.body_text, o.kind, o.company_id, f.kind AS firm_kind FROM email_outbox o
  JOIN firms f ON f.id = o.firm_id WHERE o.created_at >= $1 AND o.kind = 'notice' AND o.subject LIKE 'New support issue%'`, [since])).rows;

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE users SET email = $2 WHERE id = $1`, [f.platformOwner, `owner.${Date.now()}@nusuh-test.example`]);
});

describe('A customer raises a support issue', () => {
  it('the owner is emailed the subject and the number of conversations waiting, nothing else', async () => {
    const since = new Date(Date.now() - 1000);
    await as(f.a.clientAccountant, (db) => Sup.open(db, { subject: 'Bank feed stopped', category: 'problem', companyId: f.a.id,
      body: 'Account 1010 shows 12,345.67 and invoice ANT-0009 is missing.' }));
    const mine = (await outbox(since)).filter((r) => r.to_email.startsWith('owner.'));
    expect(mine).toHaveLength(1);
    const m = mine[0]!;
    expect(m.subject).toContain('Bank feed stopped');
    expect(m.firm_kind).toBe('platform');
    expect(m.company_id).toBeNull();
    expect(m.body_text).toMatch(/waiting for an answer: \d+/);
    for (const secret of ['12,345.67', 'ANT-0009', '1010', 'Test SA', 'Test firm']) expect(m.body_text + m.subject).not.toContain(secret);
  });

  it('a reply from the customer in the same conversation sends no new email', async () => {
    const t = (await as(f.a.clientAccountant, (db) => Sup.list(db)))[0]!;
    const since = new Date();
    await as(f.a.clientAccountant, (db) => Sup.post(db, t.id, 'Still broken.'));
    expect(await outbox(since)).toHaveLength(0);
  });
});
