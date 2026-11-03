// Review routes: checks, queries, checklist, sign-off. Who may do what is enforced in the database (0021_review.sql).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as R from '../books/reviewService.js';

type P = { id: string };
type Q = Record<string, string | undefined>;
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerReviewRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const ok = { ok: true };
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/review/overview', async (req) => inCompany(req, req.params.id, (db, c) => R.overview(db, c, String(req.query.month ?? ''))));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/review/checks', async (req) => inCompany(req, req.params.id, (db, c) => R.runChecks(db, c, String(req.query.month ?? ''))));
  app.post<{ Params: P; Body: { check?: string; item?: string; note?: string } }>('/api/companies/:id/review/explain', async (req) => inCompany(req, req.params.id, async (db, c) => { await R.explain(db, c, req.body ?? {}); return ok; }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/review/queries', async (req) => inCompany(req, req.params.id, (db, c) => R.listQueries(db, c, { status: req.query.status, periodEnd: req.query.month })));
  app.post<{ Params: P; Body: Parameters<typeof R.raiseQuery>[2] }>('/api/companies/:id/review/queries', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await R.raiseQuery(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/review/queries/:id', async (req) => as(req, (db) => R.getQuery(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { body?: string } }>('/api/review/queries/:id/reply', async (req) => as(req, async (db) => { await R.reply(db, uuidParam(req.params.id), req.body?.body); return ok; }));
  app.post<{ Params: P; Body: { status?: string } }>('/api/review/queries/:id/status', async (req) => as(req, async (db) => { await R.setQueryStatus(db, uuidParam(req.params.id), String(req.body?.status)); return ok; }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/review/checklist', async (req) => inCompany(req, req.params.id, (db, c) => R.checklist(db, c, String(req.query.month ?? ''))));
  app.post<{ Params: P; Body: { month?: string; item?: string; done?: boolean; note?: string } }>('/api/companies/:id/review/checklist', async (req) => inCompany(req, req.params.id, async (db, c) => {
    await R.tick(db, c, String(req.body?.month ?? ''), String(req.body?.item ?? ''), req.body?.done !== false, req.body?.note); return ok;
  }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/review/months', async (req) => inCompany(req, req.params.id, (db, c) => R.months(db, c, String(req.query.month ?? ''))));
  app.post<{ Params: P; Body: { month?: string; note?: string } }>('/api/companies/:id/review/sign-off', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await R.signOff(db, c, String(req.body?.month ?? ''), req.body?.note) })));
  app.post<{ Params: P; Body: { reason?: string } }>('/api/review/sign-offs/:id/withdraw', async (req) => as(req, async (db) => { await R.withdraw(db, uuidParam(req.params.id), req.body?.reason); return ok; }));
}
