// Expenses routes: void, recurring expenses, categories, overview and expense reports.
// Drafts and recording use the document routes (type 'expense') in sales.ts.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as E from '../books/expensesService.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
type P = { id: string };
type Range = { from?: string; to?: string };
const range = (q: Range) => {
  const to = dateParam(q.to, today());
  return { from: dateParam(q.from, `${to.slice(0, 4)}-01-01`), to };
};

export function registerExpenseRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };

  app.post<{ Params: P; Body: { date?: string } }>('/api/documents/:id/void', async (req) => as(req, async (db) => {
    await E.voidExpense(db, uuidParam(req.params.id), dateParam(req.body?.date, today()));
    return { ok: true };
  }));

  app.get<{ Params: P }>('/api/companies/:id/recurring', async (req) => inCompany(req, req.params.id, (db, c) => E.listRecurring(db, c)));
  app.post<{ Params: P; Body: E.RecurringInput }>('/api/companies/:id/recurring', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await E.saveRecurring(db, c, req.body ?? {}) })));
  app.post<{ Params: P }>('/api/companies/:id/recurring/generate', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ created: await E.generateRecurring(db, c) })));
  app.get<{ Params: P }>('/api/recurring/:id', async (req) => as(req, (db) => E.getRecurring(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: E.RecurringInput }>('/api/recurring/:id', async (req) => as(req, async (db) => {
    const r = await E.getRecurring(db, uuidParam(req.params.id));
    return { id: await E.saveRecurring(db, r.companyId, req.body ?? {}, r.id) };
  }));
  app.post<{ Params: P }>('/api/recurring/:id/generate', async (req) => as(req, async (db) => {
    const r = await E.getRecurring(db, uuidParam(req.params.id));
    return { created: await E.generateRecurring(db, r.companyId, r.id) };
  }));

  app.get<{ Params: P; Querystring: Range }>('/api/companies/:id/expense-categories', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return E.categories(db, c, r.from, r.to); }));
  app.post<{ Params: P; Body: { name?: string; nameAr?: string; costCentreRequired?: boolean } }>('/api/companies/:id/expense-categories', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await E.addCategory(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/companies/:id/expense-overview', async (req) => inCompany(req, req.params.id, (db, c) => E.expenseOverview(db, c)));
  app.get<{ Params: P; Querystring: Range }>('/api/companies/:id/reports/expenses-by-category', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return E.expensesByCategory(db, c, r.from, r.to); }));
  app.get<{ Params: P; Querystring: Range }>('/api/companies/:id/reports/expenses-by-payee', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return E.expensesByPayee(db, c, r.from, r.to); }));
}
