// The checklist beside the bell. Which items a person receives is decided here on the server from their role; nothing is hidden only in the screen.
import type { FastifyInstance } from 'fastify';
import { uuidParam, type Ctx } from './context.js';
import { HttpError } from './errors.js';
import * as C from '../books/checklistService.js';

type P = { id: string };

async function member(db: Parameters<Parameters<Ctx['as']>[1]>[0], companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerChecklistRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Parameters<Parameters<Ctx['as']>[1]>[0], companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const now = () => opts.now?.();

  app.get<{ Params: P }>('/api/companies/:id/checklist', async (req) => inCompany(req, req.params.id, (db, c) => C.checklistFor(db, c, now())));
  app.post<{ Params: P; Body: { key?: unknown; done?: unknown } }>('/api/companies/:id/checklist/tick', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await C.setTick(db, c, req.body?.key, req.body?.done, now()); return C.checklistFor(db, c, now()); }));
  app.post<{ Params: P; Body: { key?: unknown; hidden?: unknown } }>('/api/companies/:id/checklist/hide', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await C.hideForMe(db, c, req.body?.key, req.body?.hidden, now()); return C.checklistFor(db, c, now()); }));

  // the company's Administrator (who may not be a member: the company is visible to them through their own firm). Each answer is the list as it is edited.
  const asAdmin = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Parameters<Parameters<Ctx['as']>[1]>[0], companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => {
      if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
      return fn(db, companyId);
    });
  };
  app.get<{ Params: P }>('/api/companies/:id/checklist/setup', async (req) => asAdmin(req, req.params.id, (db, c) => C.adminSetup(db, c)));
  app.post<{ Params: P; Body: unknown }>('/api/companies/:id/checklist/items', async (req) =>
    asAdmin(req, req.params.id, async (db, c) => { await C.saveItem(db, c, req.body); return C.adminSetup(db, c); }));
  app.post<{ Params: P; Body: { key?: unknown } }>('/api/companies/:id/checklist/items/delete', async (req) =>
    asAdmin(req, req.params.id, async (db, c) => { await C.deleteItem(db, c, req.body?.key); return C.adminSetup(db, c); }));
  app.post<{ Params: P; Body: { keys?: unknown } }>('/api/companies/:id/checklist/order', async (req) =>
    asAdmin(req, req.params.id, async (db, c) => { await C.reorder(db, c, req.body?.keys); return C.adminSetup(db, c); }));
}
