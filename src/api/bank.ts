// Bank routes: bank accounts, statement import, matching, booking lines, reconciliation and rules.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as B from '../books/bankService.js';
import * as BF from '../books/bankFeedService.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
type P = { id: string };

export function registerBankRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const ok = { ok: true };

  app.get<{ Params: P }>('/api/companies/:id/bank-accounts', async (req) => inCompany(req, req.params.id, (db, c) => B.listBankAccounts(db, c)));
  app.post<{ Params: P; Body: B.BankAccountInput }>('/api/companies/:id/bank-accounts', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await B.saveBankAccount(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/bank-accounts/:id', async (req) => as(req, (db) => B.getBankAccount(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: B.BankAccountInput }>('/api/bank-accounts/:id', async (req) => as(req, async (db) => {
    const a = await B.getBankAccount(db, uuidParam(req.params.id));
    return { id: await B.saveBankAccount(db, a.companyId, req.body ?? {}, a.id) };
  }));

  // Direct bank feed (db/migrations/0038)
  app.get<{ Params: P }>('/api/bank-accounts/:id/feed', async (req) => as(req, (db) => BF.feedFor(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { provider?: string } }>('/api/bank-accounts/:id/feed', async (req) => as(req, (db) => BF.connect(db, uuidParam(req.params.id), String(req.body?.provider ?? ''))));
  app.post<{ Params: P }>('/api/bank-accounts/:id/feed/sync', async (req) => as(req, async (db) => {
    const f = (await BF.feedFor(db, uuidParam(req.params.id))).feed ?? (() => { throw new HttpError(400, 'This bank account is not connected.', 'err.feedNone'); })();
    return BF.sync(db, f.id);
  }));
  app.post<{ Params: P }>('/api/bank-accounts/:id/feed/disconnect', async (req) => as(req, async (db) => { await BF.disconnect(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.post<{ Params: P; Body: B.ImportInput }>('/api/bank-accounts/:id/import', async (req) => as(req, (db) => B.importStatement(db, uuidParam(req.params.id), req.body ?? {})));
  app.get<{ Params: P }>('/api/bank-accounts/:id/imports', async (req) => as(req, (db) => B.listImports(db, uuidParam(req.params.id))));
  app.post<{ Params: P }>('/api/bank-imports/:id/undo', async (req) => as(req, async (db) => ({ removed: await B.undoImport(db, uuidParam(req.params.id)) })));
  app.get<{ Params: P; Querystring: { status?: string; from?: string; to?: string } }>('/api/bank-accounts/:id/lines', async (req) =>
    as(req, (db) => B.statementLines(db, uuidParam(req.params.id), req.query)));
  app.get<{ Params: P }>('/api/bank-accounts/:id/reconciliation', async (req) => as(req, (db) => B.reconciliation(db, uuidParam(req.params.id))));
  app.post<{ Params: P }>('/api/bank-accounts/:id/apply-rules', async (req) => as(req, async (db) => ({ booked: await B.applyRules(db, uuidParam(req.params.id)) })));

  app.get<{ Params: P }>('/api/bank-lines/:id/candidates', async (req) => as(req, (db) => B.matchCandidates(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { journalLineId?: string } }>('/api/bank-lines/:id/match', async (req) =>
    as(req, async (db) => { await B.matchLine(db, uuidParam(req.params.id), uuidParam(String(req.body?.journalLineId ?? ''))); return ok; }));
  app.post<{ Params: P }>('/api/bank-lines/:id/unmatch', async (req) => as(req, async (db) => { await B.unmatchLine(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P }>('/api/bank-lines/:id/ignore', async (req) => as(req, async (db) => { await B.ignoreLine(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P; Body: B.BookInput }>('/api/bank-lines/:id/book', async (req) =>
    as(req, async (db) => ({ entryId: await B.bookLine(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.post<{ Params: P; Body: { contactId?: string } }>('/api/bank-lines/:id/pay', async (req) =>
    as(req, async (db) => ({ paymentId: await B.payFromLine(db, uuidParam(req.params.id), uuidParam(String(req.body?.contactId ?? ''))) })));

  app.get<{ Params: P }>('/api/companies/:id/bank-rules', async (req) => inCompany(req, req.params.id, (db, c) => B.listRules(db, c)));
  app.post<{ Params: P; Body: B.RuleInput }>('/api/companies/:id/bank-rules', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await B.saveRule(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: B.RuleInput }>('/api/bank-rules/:id', async (req) => as(req, async (db) => {
    const r = (await db.query('SELECT company_id FROM bank_rules WHERE id = $1', [uuidParam(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
    return { id: await B.saveRule(db, r.company_id, req.body ?? {}, req.params.id) };
  }));
  app.post<{ Params: P }>('/api/bank-rules/:id/delete', async (req) => as(req, async (db) => { await B.deleteRule(db, uuidParam(req.params.id)); return ok; }));
}
