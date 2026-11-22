// Ownership routes (src/books/ownershipService.ts). Everything is company-scoped and runs as the signed-in person, so
// row-level security applies; the module permission "Ownership" is checked in src/api/permissions.ts.
import type { FastifyInstance } from 'fastify';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as O from '../books/ownershipService.js';

type P = { id: string };

export function registerOwnershipRoutes(app: FastifyInstance, { as }: Ctx) {
  const id = (req: { params: P }) => uuidParam(req.params.id);
  app.get<{ Params: P; Querystring: { asOf?: string } }>('/api/companies/:id/ownership', async (req) => as(req, (db) => O.overview(db, id(req), req.query.asOf ? dateParam(req.query.asOf, today()) : undefined)));
  app.post<{ Params: P; Body: O.OwnerInput }>('/api/companies/:id/owners', async (req) => as(req, async (db) => ({ id: await O.saveOwner(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: O.OwnerInput }>('/api/owners/:id', async (req) => as(req, async (db) => {
    const r = (await db.query<{ company_id: string }>('SELECT company_id FROM owners WHERE id = $1', [id(req)])).rows[0];
    return { id: await O.saveOwner(db, r?.company_id ?? '', req.body ?? {}, id(req)) };
  }));
  app.post<{ Params: P; Body: O.HoldingsInput }>('/api/companies/:id/ownership/holdings', async (req) => as(req, async (db) => { await O.setHoldings(db, id(req), req.body ?? {}); return { ok: true }; }));
  app.post<{ Params: P; Body: O.MovementInput }>('/api/companies/:id/ownership/movements', async (req) => as(req, async (db) => ({ id: await O.record(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: O.SplitInput }>('/api/companies/:id/ownership/dividends', async (req) => as(req, (db) => O.declareDividend(db, id(req), req.body ?? {})));
  app.post<{ Params: P; Body: O.SplitInput }>('/api/companies/:id/ownership/profit-split', async (req) => as(req, (db) => O.allocateProfit(db, id(req), req.body ?? {})));
  app.get<{ Params: P; Querystring: { ownerId?: string; from?: string; to?: string } }>('/api/companies/:id/ownership/movements', async (req) => as(req, (db) =>
    O.movements(db, id(req), { ownerId: req.query.ownerId ? uuidParam(req.query.ownerId) : undefined, from: req.query.from, to: req.query.to })));
  app.get<{ Params: P; Querystring: { from?: string; to?: string } }>('/api/companies/:id/ownership/equity-statement', async (req) => as(req, (db) =>
    O.equityStatement(db, id(req), dateParam(req.query.from, `${today().slice(0, 4)}-01-01`), dateParam(req.query.to, today()))));
  app.get<{ Params: P; Querystring: { from?: string; to?: string } }>('/api/companies/:id/ownership/profit-suggestion', async (req) => as(req, (db) =>
    O.profitSuggestion(db, id(req), dateParam(req.query.from, `${today().slice(0, 4)}-01-01`), dateParam(req.query.to, today()))));
  app.post<{ Params: P; Body: { date?: string; memo?: string } }>('/api/ownership-movements/:id/reverse', async (req) => as(req, async (db) => ({ entryId: await O.reverse(db, id(req), req.body ?? {}) })));
}
