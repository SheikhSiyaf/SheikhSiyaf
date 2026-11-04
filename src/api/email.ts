// Email routes: send a document to the customer, links to view it, the emails sent, retry; the public document page
// behind a link; and "forgot password" (no sign-in needed for the last two).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { baseUrl, uuidParam, type Ctx } from './context.js';
import { hashInviteToken } from './auth.js';
import { Throttle } from '../auth/throttle.js';
import * as E from '../books/emailService.js';
import { invitation } from '../email/templates.js';
import { emailConfig } from '../email/transport.js';

type P = { id: string };
export function registerEmailRoutes(app: FastifyInstance, { as, pool, opts }: Ctx) {
  const companyOfDoc = async (db: Db, id: string) => (await db.query('SELECT company_id FROM documents WHERE id = $1', [id])).rows[0]?.company_id
    ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();

  app.post<{ Params: P; Body: { to?: string; message?: string } }>('/api/documents/:id/email', async (req) =>
    as(req, (db) => E.emailDocument(db, uuidParam(req.params.id), req.body ?? {}, baseUrl(req, opts))));
  app.post<{ Params: P }>('/api/documents/:id/link', async (req) =>
    as(req, async (db) => ({ link: `${baseUrl(req, opts)}/i/${await E.documentLink(db, uuidParam(req.params.id))}` })));
  app.get<{ Params: P }>('/api/documents/:id/emails', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    return { emails: await E.list(db, await companyOfDoc(db, id), id), links: await E.links(db, id) };
  }));
  app.post<{ Params: P }>('/api/documents/:id/links/revoke', async (req) => as(req, async (db) => { await E.revokeLinks(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.get<{ Params: P }>('/api/companies/:id/emails', async (req) => as(req, async (db) => ({ provider: emailConfig().provider, emails: await E.list(db, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/emails/:id/retry', async (req) => as(req, async (db) => { await E.retry(db, uuidParam(req.params.id)); return { ok: true }; }));

  // Public: the document behind a link.
  app.get<{ Params: { token: string } }>('/api/public/documents/:token', async (req) => {
    const r = (await pool.query('SELECT document_public($1) AS d', [E.hashLinkToken(String(req.params.token))])).rows[0]?.d;
    if (!r) throw new HttpError(404, 'This link has expired or was withdrawn. Ask the sender for a new one.', 'err.linkInvalid');
    await pool.query('SELECT * FROM document_link_open($1)', [E.hashLinkToken(String(req.params.token))]);
    return r;
  });

  // Forgotten password: always the same answer, so it does not tell whether the address has an account.
  const throttle = new Throttle(pool, { kind: 'reset', max: 3, windowMs: 60 * 60_000 });
  app.post<{ Body: { email?: string } }>('/api/password-reset', async (req) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!E.EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'err.email');
    await throttle.check(email);
    await throttle.fail(email);
    const token = randomBytes(32).toString('base64url');
    const u = (await pool.query('SELECT * FROM start_password_reset($1, $2)', [email, hashInviteToken(token)])).rows[0];
    if (u) await E.queue(pool, { firmId: u.firm_id, kind: 'password_reset', to: u.email, toName: u.full_name, mail: invitation(u.full_name, `${baseUrl(req, opts)}/invite/${token}`, 'Nusuh Books', true) });
    return { ok: true };
  });
}
