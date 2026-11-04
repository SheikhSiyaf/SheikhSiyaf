// Foreign currency routes: rates (shared and the company's own), today's rate for a journal line, settings,
// the month-end revaluation (preview, post, reverse) and "sync now".
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as Fx from '../books/fxService.js';
import { syncRates } from '../books/fxJobs.js';

type P = { id: string };
type Q = { Params: P; Querystring: Record<string, string | undefined> };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerFxRoutes(app: FastifyInstance, { as, pool }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  app.get<Q>('/api/companies/:id/fx/rates', async (req) => inCompany(req, req.params.id, (db, c) => Fx.rates(db, c, dateParam(req.query.asOf, today()))));
  app.post<{ Params: P; Body: { currency?: string; date?: string; rate?: string } }>('/api/companies/:id/fx/rates', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await Fx.saveRate(db, c, req.body ?? {}); return { ok: true }; }));
  app.get<Q>('/api/companies/:id/fx/rate', async (req) => inCompany(req, req.params.id, async (db, c) => ({ rate: await Fx.rateFor(db, c, String(req.query.currency ?? ''), dateParam(req.query.date, today())) })));
  app.post<{ Params: P; Body: { autoRevalue?: boolean } }>('/api/companies/:id/fx/settings', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await Fx.saveSettings(db, c, req.body ?? {}); return { ok: true }; }));
  app.get<Q>('/api/companies/:id/fx/revaluation', async (req) => inCompany(req, req.params.id, (db, c) => Fx.preview(db, c, String(req.query.month ?? ''))));
  app.post<{ Params: P; Body: { month?: string } }>('/api/companies/:id/fx/revaluation', async (req) => inCompany(req, req.params.id, (db, c) => Fx.post(db, c, String(req.body?.month ?? ''))));
  app.get<Q>('/api/companies/:id/fx/revaluations', async (req) => inCompany(req, req.params.id, (db, c) => Fx.list(db, c)));
  app.post<{ Params: P }>('/api/fx-revaluations/:id/reverse', async (req) => as(req, async (db) => { await Fx.reverse(db, uuidParam(req.params.id)); return { ok: true }; }));
  // Sync now: only someone who may post in the company asks; the shared rates are written by the server itself.
  app.post<{ Params: P }>('/api/companies/:id/fx/sync', async (req) => {
    await inCompany(req, req.params.id, async (db, c) => {
      if (!(await db.query('SELECT app_has_role($1, posting_roles()) AS ok', [c])).rows[0].ok) throw new HttpError(403, 'Your role does not allow this.', 'err.forbidden');
    });
    const r = await syncRates(pool, { force: true });
    return { results: r.map((x) => ({ base: x.base, stored: x.stored, provider: x.provider, problem: x.problem })) };
  });
}

// ------------------------------------------------------------------ year-end closing
import * as YE from '../books/yearEndService.js';
export function registerYearEndRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  app.get<Q>('/api/companies/:id/year-end', async (req) => inCompany(req, req.params.id, (db, c) => YE.years(db, c)));
  app.get<Q>('/api/companies/:id/year-end/preview', async (req) => inCompany(req, req.params.id, (db, c) => YE.preview(db, c, dateParam(req.query.end, ''))));
  app.post<{ Params: P; Body: { end?: string } }>('/api/companies/:id/year-end/close', async (req) => inCompany(req, req.params.id, (db, c) => YE.close(db, c, dateParam(req.body?.end, ''))));
  app.post<{ Params: P; Body: { reason?: string } }>('/api/fiscal-years/:id/reopen', async (req) => as(req, async (db) => { await YE.reopen(db, uuidParam(req.params.id), String(req.body?.reason ?? '')); return { ok: true }; }));
}
