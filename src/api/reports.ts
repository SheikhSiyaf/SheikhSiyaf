// Report routes beyond the trial balance and profit and loss: P&L in columns (comparison, month by month), balance
// sheet (with a comparison date), cash flow, the one-page owner summary with ratios, and the VAT return worksheet.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as R from '../books/reportsService.js';

type P = { id: string };
type Q = Record<string, string | undefined>;
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerReportRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const range = (q: Q) => { const to = dateParam(q.to, today()); return { from: dateParam(q.from, `${to.slice(0, 4)}-01-01`), to }; };

  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/reports/pnl-columns', async (req) => inCompany(req, req.params.id, (db, c) => {
    const { from, to } = range(req.query);
    const compare = (['none', 'previous', 'lastYear', 'monthly'] as const).find((x) => x === req.query.compare) ?? 'none';
    return R.pnlColumns(db, c, from, to, compare);
  }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/reports/balance-sheet', async (req) => inCompany(req, req.params.id, async (db, c) => {
    const asOf = dateParam(req.query.asOf, today());
    const compareTo = req.query.compareTo ? dateParam(req.query.compareTo, asOf) : null;
    return { current: await R.balanceSheet(db, c, asOf), compare: compareTo ? await R.balanceSheet(db, c, compareTo) : null };
  }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/reports/cash-flow', async (req) => inCompany(req, req.params.id, (db, c) => { const { from, to } = range(req.query); return R.cashFlow(db, c, from, to); }));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/reports/owner-summary', async (req) => inCompany(req, req.params.id, (db, c) => R.ownerSummary(db, c, dateParam(req.query.asOf, today()))));
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/reports/vat-return', async (req) => inCompany(req, req.params.id, (db, c) => { const { from, to } = range(req.query); return R.vatReturn(db, c, from, to); }));
}
