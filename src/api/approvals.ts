// Approvals and the cash flow forecast. Who may do what is enforced in the database (0026_approvals_forecast.sql).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { today, uuidParam, type Ctx } from './context.js';
import * as A from '../books/approvalsService.js';
import * as F from '../books/forecastService.js';
import type { PaymentInput } from '../books/documentsService.js';

type Id = { id: string };
type Q = Record<string, string | undefined>;
const ok = { ok: true };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerApprovalRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const byId = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, id: string) => Promise<T>) => { const x = uuidParam(id); return as(req, (db) => fn(db, x)); };

  // ---------------------------------------------------------------- approvals
  app.get('/api/approvals/my-clients', async (req) => as(req, async (db) => (await db.query(
    `SELECT c AS "companyId", (SELECT count(*) FROM approval_requests r WHERE r.company_id = c AND r.status = 'pending' AND r.requested_by <> app_user_id() AND app_can_approve(c))::int AS "toDecide"
     FROM unnest(app_company_ids()) c`)).rows));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/approvals', async (req) => inCompany(req, req.params.id, (db, c) => A.list(db, c, req.query.status || undefined)));
  app.get<{ Params: Id }>('/api/companies/:id/approvals/waiting', async (req) => inCompany(req, req.params.id, (db, c) => A.waiting(db, c)));
  app.get<{ Params: Id }>('/api/companies/:id/approvals/rules', async (req) => inCompany(req, req.params.id, (db, c) => A.rules(db, c)));
  app.post<{ Params: Id; Body: { kind?: string; threshold?: string; active?: boolean } }>('/api/companies/:id/approvals/rules', async (req) => inCompany(req, req.params.id, async (db, c) => { await A.saveRule(db, c, req.body ?? {}); return ok; }));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/approvals/needed', async (req) => inCompany(req, req.params.id, async (db, c) =>
    ({ needed: /^\d+(\.\d{1,2})?$/.test(String(req.query.amount)) ? await A.needed(db, c, String(req.query.kind), String(req.query.amount)) : false })));
  app.post<{ Params: Id; Body: PaymentInput & { note?: string } }>('/api/companies/:id/approvals/payments', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await A.requestPayment(db, c, req.body ?? {}) })));
  app.get<{ Params: Id }>('/api/documents/:id/approval', async (req) => byId(req, req.params.id, (db, id) => A.forDocument(db, id)));
  app.post<{ Params: Id; Body: { note?: string } }>('/api/documents/:id/approval', async (req) => byId(req, req.params.id, async (db, id) => ({ id: await A.requestDocument(db, id, req.body?.note) })));
  app.post<{ Params: Id; Body: { decision?: string; reason?: string } }>('/api/approvals/:id/decide', async (req) => byId(req, req.params.id, async (db, id) => { await A.decide(db, id, String(req.body?.decision), req.body?.reason); return ok; }));
  app.post<{ Params: Id }>('/api/approvals/:id/withdraw', async (req) => byId(req, req.params.id, async (db, id) => { await A.withdraw(db, id); return ok; }));
  app.post<{ Params: Id; Body: { date?: string } }>('/api/approvals/:id/pay', async (req) => byId(req, req.params.id, async (db, id) => ({ id: await A.payApproved(db, id, req.body?.date) })));

  // ---------------------------------------------------------------- cash flow forecast
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/forecast', async (req) => inCompany(req, req.params.id, (db, c) =>
    F.forecast(db, c, today(), { grain: req.query.grain, count: Number(req.query.count) || undefined, delayDays: Number(req.query.delay) || 0 })));
  app.get<{ Params: Id }>('/api/companies/:id/forecast/items', async (req) => inCompany(req, req.params.id, (db, c) => F.items(db, c)));
  app.post<{ Params: Id; Body: F.ItemInput }>('/api/companies/:id/forecast/items', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await F.saveItem(db, c, req.body ?? {}) })));
  app.post<{ Params: Id; Body: F.ItemInput }>('/api/forecast/items/:id', async (req) => byId(req, req.params.id, async (db, id) => {
    const c = (await db.query('SELECT company_id FROM forecast_items WHERE id = $1', [id])).rows[0]?.company_id ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();
    return { id: await F.saveItem(db, c, req.body ?? {}, id) };
  }));
  app.post<{ Params: Id; Body: { minimumCash?: string } }>('/api/companies/:id/forecast/settings', async (req) => inCompany(req, req.params.id, async (db, c) => { await F.saveSettings(db, c, req.body?.minimumCash); return ok; }));
}
