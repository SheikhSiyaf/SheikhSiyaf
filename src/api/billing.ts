// Billing and subscriptions. Owner console: plans, each customer's subscription, invoices, billing run, seller settings.
// Admin console: the customer's own plan, usage and invoices (read only).
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { baseUrl, dateParam, today, uuidParam, type Ctx } from './context.js';
import * as B from '../books/billingService.js';

export function registerBillingRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  app.get('/api/owner/billing', async (req) => as(req, async (db) => ({ customers: await B.overview(db), plans: await B.listPlans(db), settings: await B.settings(db) })));
  app.get('/api/owner/plans', async (req) => as(req, (db) => B.listPlans(db)));
  app.post<{ Body: B.PlanInput }>('/api/owner/plans', async (req) => as(req, (db) => B.savePlan(db, null, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: B.PlanInput }>('/api/owner/plans/:id', async (req) => as(req, (db) => B.savePlan(db, uuidParam(req.params.id), req.body ?? {})));
  app.post<{ Body: Parameters<typeof B.saveSettings>[1] }>('/api/owner/billing/settings', async (req) => as(req, async (db) => { await B.saveSettings(db, req.body ?? {}); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: B.SubscriptionInput }>('/api/owner/tenants/:id/subscription', async (req) =>
    as(req, (db) => B.saveSubscription(db, uuidParam(req.params.id), req.body ?? {})));
  app.post<{ Params: { id: string }; Body: { cancel?: boolean } }>('/api/owner/tenants/:id/subscription/cancel', async (req) =>
    as(req, async (db) => { await B.setCancel(db, uuidParam(req.params.id), req.body?.cancel !== false); return { ok: true }; }));
  app.get<{ Querystring: { firm?: string } }>('/api/owner/billing/invoices', async (req) => as(req, async (db) => {
    if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
    return B.invoices(db, req.query.firm ? uuidParam(req.query.firm) : undefined);
  }));
  app.post<{ Body: { day?: string } }>('/api/owner/billing/run', async (req) => as(req, async (db) => {
    const made = await B.runAsOwner(db, dateParam(req.body?.day, today()), baseUrl(req, opts) || undefined);
    return { made: made.length };
  }));
  app.post<{ Params: { id: string }; Body: { paidOn?: string; reference?: string } }>('/api/owner/billing/invoices/:id/paid', async (req) =>
    as(req, async (db) => { await B.markPaid(db, uuidParam(req.params.id), req.body ?? {}); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/owner/billing/invoices/:id/void', async (req) =>
    as(req, async (db) => { await B.voidInvoice(db, uuidParam(req.params.id), req.body?.reason); return { ok: true }; }));

  // Owner, or the customer's own Administrator (row-level security keeps each customer to its own invoices).
  app.get<{ Params: { id: string } }>('/api/billing/invoices/:id', async (req) => as(req, (db) => B.invoice(db, uuidParam(req.params.id))));
  app.get('/api/admin/billing', async (req) => as(req, async (db) => {
    if (!(await db.query('SELECT app_is_admin() AS a')).rows[0].a) throw new HttpError(403, 'Only the Administrator can do this.', 'err.adminOnly');
    return B.mine(db);
  }));
}
