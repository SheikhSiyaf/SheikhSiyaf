// Accountant tools routes: recurring sales invoices, statements, reminders, budgets, notifications, bulk actions, export.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { baseUrl, dateParam, today, uuidParam, type Ctx } from './context.js';
import * as T from '../books/toolsService.js';
import * as Mail from '../books/emailService.js';
import { issueDocument } from '../books/documentsService.js';
import * as A from '../books/approvalsService.js';
import { sendAfterIssue } from './einvoice.js';

type P = { id: string };
type Q = { Params: P; Querystring: Record<string, string | undefined> };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
/** Runs each item in its own savepoint, so one that fails does not undo the others. */
async function each(db: Db, ids: unknown, fn: (id: string) => Promise<unknown>) {
  const list = Array.isArray(ids) ? ids.slice(0, 100).map((x) => uuidParam(String(x))) : [];
  const results: { id: string; ok: boolean; error?: string; key?: string }[] = [];
  for (const id of list) {
    await db.query('SAVEPOINT bulk_item');
    try { await fn(id); await db.query('RELEASE SAVEPOINT bulk_item'); results.push({ id, ok: true }); }
    catch (e) { await db.query('ROLLBACK TO SAVEPOINT bulk_item'); const h = e as HttpError & { message: string }; results.push({ id, ok: false, error: h.message, key: h.key }); }
  }
  return results;
}

export function registerToolRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const ownerOf = async (db: Db, table: string, id: string) => (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [id])).rows[0]?.company_id
    ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();

  // recurring sales invoices
  app.get<Q>('/api/companies/:id/recurring-invoices', async (req) => inCompany(req, req.params.id, (db, c) => T.listRecurringInvoices(db, c)));
  app.post<{ Params: P; Body: T.RecurringInvoiceInput }>('/api/companies/:id/recurring-invoices', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await T.saveRecurringInvoice(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/recurring-invoices/:id', async (req) => as(req, (db) => T.getRecurringInvoice(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: T.RecurringInvoiceInput }>('/api/recurring-invoices/:id', async (req) =>
    as(req, async (db) => ({ id: await T.saveRecurringInvoice(db, await ownerOf(db, 'recurring_invoices', uuidParam(req.params.id)), req.body ?? {}, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/recurring-invoices/:id/make', async (req) => {
    const r = await as(req, async (db) => T.generateRecurringInvoices(db, await ownerOf(db, 'recurring_invoices', uuidParam(req.params.id)), { onlyId: uuidParam(req.params.id), base: baseUrl(req, opts) }));
    for (const id of r.issued) await sendAfterIssue(as, req, id);
    return r;
  });

  // statements and reminders
  app.get<Q>('/api/companies/:id/statement', async (req) => inCompany(req, req.params.id, (db, c) =>
    T.statement(db, c, uuidParam(String(req.query.contact ?? '')), dateParam(req.query.from, `${today().slice(0, 4)}-01-01`), dateParam(req.query.to, today()))));
  app.post<{ Params: P; Body: { contactId?: string; from?: string; to?: string; email?: string; message?: string } }>('/api/companies/:id/statement/email', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await T.emailStatement(db, c, uuidParam(String(req.body?.contactId ?? '')),
      { from: dateParam(req.body?.from, ''), to: dateParam(req.body?.to, today()), email: req.body?.email, message: req.body?.message }) })));
  app.get<Q>('/api/companies/:id/reminders', async (req) => inCompany(req, req.params.id, async (db, c) => ({ settings: await T.reminderSettings(db, c), open: await T.openInvoices(db, c, null) })));
  app.post<{ Params: P; Body: { auto?: boolean; days?: number[]; message?: string } }>('/api/companies/:id/reminders/settings', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await T.saveReminderSettings(db, c, req.body ?? {}); return { ok: true }; }));
  app.post<{ Params: P; Body: { ids?: string[] } }>('/api/companies/:id/reminders/send', async (req) =>
    inCompany(req, req.params.id, async (db) => ({ results: await each(db, req.body?.ids, (id) => T.sendReminder(db, id, baseUrl(req, opts))) })));

  // budgets
  app.get<Q>('/api/companies/:id/budgets', async (req) => inCompany(req, req.params.id, (db, c) => T.listBudgets(db, c)));
  app.post<{ Params: P; Body: T.BudgetInput }>('/api/companies/:id/budgets', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await T.saveBudget(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/budgets/:id', async (req) => as(req, (db) => T.budgetVsActual(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: T.BudgetInput }>('/api/budgets/:id', async (req) =>
    as(req, async (db) => ({ id: await T.saveBudget(db, await ownerOf(db, 'budgets', uuidParam(req.params.id)), req.body ?? {}, uuidParam(req.params.id)) })));

  // notifications
  app.get<{ Params: P }>('/api/companies/:id/notifications', async (req) => inCompany(req, req.params.id, (db, c) => T.notifications(db, c)));
  app.post<{ Params: P; Body: { keys?: string[] } }>('/api/companies/:id/notifications/read', async (req) =>
    inCompany(req, req.params.id, async (db, c) => { await T.markRead(db, c, (req.body?.keys ?? []).map(String)); return { ok: true }; }));

  // bulk actions
  app.post<{ Params: P; Body: { ids?: string[] } }>('/api/companies/:id/bulk/issue', async (req) => {
    const r = await inCompany(req, req.params.id, async (db, c) => ({ results: await each(db, req.body?.ids, async (id) => {
      if ((await db.query('SELECT company_id FROM documents WHERE id = $1', [id])).rows[0]?.company_id !== c) throw new HttpError(404, 'Not found.', 'err.notFound');
      await issueDocument(db, id);
    }) }));
    for (const x of r.results) if (x.ok) await sendAfterIssue(as, req, x.id);
    return r;
  });
  app.post<{ Params: P; Body: { ids?: string[] } }>('/api/companies/:id/bulk/email', async (req) =>
    inCompany(req, req.params.id, async (db) => ({ results: await each(db, req.body?.ids, (id) => Mail.emailDocument(db, id, {}, baseUrl(req, opts))) })));
  app.post<{ Params: P; Body: { ids?: string[]; decision?: string; reason?: string } }>('/api/companies/:id/bulk/approve', async (req) =>
    inCompany(req, req.params.id, async (db) => ({ results: await each(db, req.body?.ids, (id) => A.decide(db, id, req.body?.decision === 'rejected' ? 'rejected' : 'approved', req.body?.reason)) })));

  // export everything
  app.get<{ Params: P }>('/api/companies/:id/export', async (req, reply) => {
    const f = await inCompany(req, req.params.id, (db, c) => T.exportAll(db, c));
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${f.fileName}"`);
    return reply.send(Buffer.from(f.bytes));
  });
}
