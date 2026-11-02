// Ledger, projects and employee-claim routes.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as L from '../books/ledgerService.js';
import * as S from '../books/documentsService.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
type P = { id: string };
type Q = { from?: string; to?: string; asOf?: string };
const range = (q: Q) => { const to = dateParam(q.to, today()); return { from: dateParam(q.from, `${to.slice(0, 4)}-01-01`), to }; };
const ROLES = ['customer', 'supplier', 'employee'] as const;

export function registerLedgerRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };

  // ledgers
  app.get<{ Params: P & { accountId: string }; Querystring: Q }>('/api/companies/:id/ledger/account/:accountId', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return L.accountLedger(db, c, uuidParam(req.params.accountId), r.from, r.to); }));
  app.get<{ Params: P & { ccId: string }; Querystring: Q }>('/api/companies/:id/ledger/cost-centre/:ccId', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return L.costCentreLedger(db, c, uuidParam(req.params.ccId), r.from, r.to); }));
  app.get<{ Params: P & { contactId: string }; Querystring: Q }>('/api/companies/:id/ledger/contact/:contactId', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const r = range(req.query); return L.contactLedger(db, c, uuidParam(req.params.contactId), r.from, r.to); }));
  app.get<{ Params: P & { role: string }; Querystring: Q }>('/api/companies/:id/ledger/balances/:role', async (req) =>
    inCompany(req, req.params.id, (db, c) => {
      const role = ROLES.find((x) => x === req.params.role) ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();
      return L.contactBalances(db, c, role, dateParam(req.query.asOf, today()));
    }));

  // projects
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/projects', async (req) =>
    inCompany(req, req.params.id, (db, c) => L.listProjects(db, c, req.query.from ? dateParam(req.query.from, '') : undefined, req.query.to ? dateParam(req.query.to, '') : undefined)));
  app.post<{ Params: P; Body: L.ProjectInput }>('/api/companies/:id/projects', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await L.saveProject(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/projects/:id', async (req) => as(req, (db) => L.getProject(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: L.ProjectInput }>('/api/projects/:id', async (req) => as(req, async (db) => {
    const p = await L.getProject(db, uuidParam(req.params.id));
    return { id: await L.saveProject(db, p.companyId, req.body ?? {}, p.id) };
  }));

  // employee claims: submit, back to draft, approve, reject
  app.post<{ Params: P }>('/api/documents/:id/submit', async (req) => as(req, async (db) => { await S.submitClaim(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.post<{ Params: P }>('/api/documents/:id/reopen', async (req) => as(req, async (db) => { await S.reopenClaim(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.post<{ Params: P }>('/api/documents/:id/approve', async (req) => as(req, async (db) => { await S.approveClaim(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.post<{ Params: P; Body: { reason?: string } }>('/api/documents/:id/reject', async (req) =>
    as(req, async (db) => { await S.rejectClaim(db, uuidParam(req.params.id), String(req.body?.reason ?? '')); return { ok: true }; }));
}
