// Support chat between a customer's people and Nusuh Books (db/migrations/0042). Every write goes through the
// database functions, which decide who may see a conversation and whether a message is from Nusuh Books.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { bilingual } from '../email/templates.js';
import { queue } from './emailService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
export const CATEGORIES = ['question', 'problem', 'billing', 'idea', 'other'] as const;

export interface ThreadRow { id: string; subject: string; category: string; status: 'open' | 'answered' | 'closed'; createdAt: string; lastMessageAt: string;
  firmId: string; customer: string; customerKind: string; openedBy: string; openedByName: string; company: string | null; messages: number; unread: number;
  lastBody: string; lastFromOwner: boolean }

export async function list(db: Db): Promise<ThreadRow[]> {
  return (await db.query(`SELECT id, subject, category, status, created_at AS "createdAt", last_message_at AS "lastMessageAt", firm_id AS "firmId", customer,
    customer_kind AS "customerKind", opened_by AS "openedBy", opened_by_name AS "openedByName", company, messages, unread, last_body AS "lastBody",
    last_from_owner AS "lastFromOwner" FROM support_list()`)).rows;
}
/** Conversations with something unread for the person looking. */
export async function unread(db: Db): Promise<number> {
  return Number((await db.query('SELECT count(*) FILTER (WHERE unread > 0)::int AS n FROM support_list()')).rows[0].n);
}
/** One conversation with its messages; opening it marks it read for this side. */
export async function get(db: Db, id: string) {
  const t = (await list(db)).find((x) => x.id === id) ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();
  await db.query('SELECT support_seen($1)', [id]);
  const messages = (await db.query(`SELECT id, from_owner AS "fromOwner", author_name AS "authorName", mine, body, created_at AS "createdAt" FROM support_messages_of($1)`, [id])).rows;
  return { ...t, unread: 0, messages };
}

export async function open(db: Db, x: { subject?: string; category?: string; companyId?: string | null; body?: string }): Promise<string> {
  const category = CATEGORIES.includes(x.category as never) ? x.category : 'question';
  if (!String(x.subject ?? '').trim()) bad('Say in a few words what it is about.', 'err.supportSubject');
  if (!String(x.body ?? '').trim()) bad('Write your message.', 'err.supportBody');
  return (await db.query('SELECT support_open($1, $2, $3, $4) AS id', [String(x.subject).slice(0, 200), category, x.companyId || null, String(x.body).slice(0, 5000)])).rows[0].id;
}

/** A message. When Nusuh Books answers, the person who raised it is emailed (with a link to the app when base is known). */
export async function post(db: Db, id: string, body: string, base?: string): Promise<string> {
  if (!String(body ?? '').trim()) bad('Write your message.', 'err.supportBody');
  const mid = (await db.query('SELECT support_post($1, $2) AS id', [id, String(body).slice(0, 5000)])).rows[0].id as string;
  // Only when Nusuh Books answers: support_opener answers for the owner alone.
  const t = (await db.query(`SELECT firm_id AS "firmId", subject, name, email FROM support_opener($1)`, [id])).rows[0];
  if (t?.email) {
    const link = base ? `${base}/` : '';
    await queue(db, { firmId: t.firmId, kind: 'notice', to: t.email, toName: t.name,
      mail: bilingual(`Nusuh Books answered: ${t.subject} · رد نُصح: ${t.subject}`,
        [`Hello ${t.name},`, `Nusuh Books has answered your message "${t.subject}".`, ...(link ? ['Read it and reply under Help in the app:', link] : ['Read it and reply under Help in the app.'])],
        [`مرحباً ${t.name}،`, `ردّت نُصح على رسالتك "${t.subject}".`, ...(link ? ['اقرأ الرد وأجب من زر المساعدة في التطبيق:', link] : ['اقرأ الرد وأجب من زر المساعدة في التطبيق.'])], 'Nusuh Books') });
  }
  return mid;
}
export async function close(db: Db, id: string) { await db.query('SELECT support_close($1)', [id]); }
