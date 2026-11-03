// CRM routes: leads, pipeline and deals, activities, campaigns.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as C from '../books/crmService.js';

type P = { id: string };
type B = Record<string, unknown>;
type Q = Record<string, string | undefined>;
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
const companyOf = async (db: Db, table: 'crm_leads' | 'crm_deals' | 'crm_activities' | 'crm_campaigns', id: string) => {
  const r = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [uuidParam(id)])).rows[0];
  if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
  return r.company_id as string;
};

export function registerCrmRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const ok = { ok: true };
  const uuidOrNull = (v?: string) => (v ? uuidParam(v) : undefined);

  app.get<{ Params: P }>('/api/companies/:id/crm/people', async (req) => inCompany(req, req.params.id, (db, c) => C.people(db, c)));
  // campaigns
  app.get<{ Params: P }>('/api/companies/:id/crm/campaigns', async (req) => inCompany(req, req.params.id, (db, c) => C.listCampaigns(db, c)));
  app.post<{ Params: P; Body: B }>('/api/companies/:id/crm/campaigns', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await C.saveCampaign(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: B }>('/api/crm/campaigns/:id', async (req) => as(req, async (db) => ({ id: await C.saveCampaign(db, await companyOf(db, 'crm_campaigns', req.params.id), req.body ?? {}, uuidParam(req.params.id)) })));
  // leads
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/crm/leads', async (req) => inCompany(req, req.params.id, (db, c) =>
    C.listLeads(db, c, { status: req.query.status, q: req.query.q, ownerId: uuidOrNull(req.query.owner) })));
  app.post<{ Params: P; Body: B }>('/api/companies/:id/crm/leads', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await C.saveLead(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/crm/leads/:id', async (req) => as(req, (db) => C.getLead(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: B }>('/api/crm/leads/:id', async (req) => as(req, async (db) => ({ id: await C.saveLead(db, await companyOf(db, 'crm_leads', req.params.id), req.body ?? {}, uuidParam(req.params.id)) })));
  app.post<{ Params: P; Body: { contactId?: string; dealTitle?: string; dealValue?: string } }>('/api/crm/leads/:id/convert', async (req) =>
    as(req, (db) => C.convertLead(db, uuidParam(req.params.id), req.body ?? {})));
  // deals
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/crm/pipeline', async (req) => inCompany(req, req.params.id, (db, c) =>
    C.pipeline(db, c, { ownerId: uuidOrNull(req.query.owner), from: req.query.from, to: req.query.to })));
  app.post<{ Params: P; Body: B }>('/api/companies/:id/crm/deals', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await C.saveDeal(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/crm/deals/:id', async (req) => as(req, (db) => C.getDeal(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: B }>('/api/crm/deals/:id', async (req) => as(req, async (db) => ({ id: await C.saveDeal(db, await companyOf(db, 'crm_deals', req.params.id), req.body ?? {}, uuidParam(req.params.id)) })));
  app.post<{ Params: P; Body: { stage?: string; lostReason?: string } }>('/api/crm/deals/:id/stage', async (req) => as(req, async (db) => {
    await C.moveDeal(db, uuidParam(req.params.id), String(req.body?.stage ?? ''), req.body?.lostReason); return ok;
  }));
  app.post<{ Params: P }>('/api/crm/deals/:id/quotation', async (req) => as(req, async (db) => ({ id: await C.quoteDeal(db, uuidParam(req.params.id)) })));
  // activities
  app.get<{ Params: P; Querystring: Q }>('/api/companies/:id/crm/activities', async (req) => inCompany(req, req.params.id, (db, c) =>
    C.listActivities(db, c, { show: req.query.show, ownerId: uuidOrNull(req.query.owner), leadId: uuidOrNull(req.query.lead), dealId: uuidOrNull(req.query.deal), contactId: uuidOrNull(req.query.contact) })));
  app.post<{ Params: P; Body: B }>('/api/companies/:id/crm/activities', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await C.saveActivity(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: B }>('/api/crm/activities/:id', async (req) => as(req, async (db) => ({ id: await C.saveActivity(db, await companyOf(db, 'crm_activities', req.params.id), req.body ?? {}, uuidParam(req.params.id)) })));
  app.post<{ Params: P; Body: { done?: boolean } }>('/api/crm/activities/:id/done', async (req) => as(req, async (db) => { await C.setActivityDone(db, uuidParam(req.params.id), req.body?.done !== false); return ok; }));
  app.post<{ Params: P }>('/api/crm/activities/:id/delete', async (req) => as(req, async (db) => { await C.deleteActivity(db, uuidParam(req.params.id)); return ok; }));
}
