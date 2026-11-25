// The client home page as a dashboard. Which widgets a person receives, and every figure, is decided here on the server from their role.
import type { FastifyInstance } from 'fastify';
import { uuidParam, type Ctx } from './context.js';
import { HttpError } from './errors.js';
import * as D from '../books/dashboardService.js';

type P = { id: string };
type Dbx = Parameters<Parameters<Ctx['as']>[1]>[0];

export function registerDashboardRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const now = () => opts.now?.();
  const member = async (db: Dbx, companyId: string) => {
    if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
  };
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Dbx, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  // The Administrator may not be a member: the company is visible to them through their own firm.
  const asAdmin = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Dbx, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => {
      if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
      return fn(db, companyId);
    });
  };

  app.get<{ Params: P }>('/api/companies/:id/dashboard', async (req) => inCompany(req, req.params.id, (db, c) => D.myDashboard(db, c, now())));
  app.post<{ Params: P; Body: { period?: unknown; widgets?: unknown } }>('/api/companies/:id/dashboard/data', async (req) =>
    inCompany(req, req.params.id, (db, c) => D.widgetData(db, c, req.body ?? {}, now())));
  app.post<{ Params: P; Body: unknown }>('/api/companies/:id/dashboard', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await D.saveMine(db, c, req.body); return D.myDashboard(db, c, now()); }));
  app.post<{ Params: P }>('/api/companies/:id/dashboard/reset', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await D.resetMine(db, c); return D.myDashboard(db, c, now()); }));

  app.get<{ Params: P }>('/api/companies/:id/dashboard/defaults', async (req) => asAdmin(req, req.params.id, (db, c) => D.defaultsFor(db, c)));
  app.post<{ Params: P; Body: { scope?: unknown; roleId?: unknown; layout?: unknown } }>('/api/companies/:id/dashboard/defaults', async (req) =>
    asAdmin(req, req.params.id, async (db, c) => { await D.saveDefault(db, c, req.body ?? {}); return D.defaultsFor(db, c); }));
}
