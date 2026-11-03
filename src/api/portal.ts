// Compliance calendar and client portal routes. Who may do what is enforced in the database (0024_calendar_portal.sql).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { today, uuidParam, type Ctx } from './context.js';
import * as K from '../books/calendarService.js';
import * as P from '../books/portalService.js';

type Id = { id: string };
type Q = Record<string, string | undefined>;
const ok = { ok: true };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerPortalRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const byId = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, id: string) => Promise<T>) => {
    const x = uuidParam(id);
    return as(req, (db) => fn(db, x));
  };

  // ---------------------------------------------------------------- calendar
  app.get('/api/calendar/my-clients', async (req) => as(req, (db) => K.myClients(db, today())));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/calendar', async (req) => inCompany(req, req.params.id, (db, c) => K.calendar(db, c, today(), { from: req.query.from, to: req.query.to })));
  app.get<{ Params: Id }>('/api/companies/:id/calendar/settings', async (req) => inCompany(req, req.params.id, async (db, c) => ({
    ...(await K.getSettings(db, c)), canEdit: (await db.query('SELECT app_has_role($1, calendar_roles()) AS e', [c])).rows[0].e,
  })));
  app.post<{ Params: Id; Body: Record<string, unknown> }>('/api/companies/:id/calendar/settings', async (req) => inCompany(req, req.params.id, async (db, c) => { await K.saveSettings(db, c, req.body ?? {}); return ok; }));
  app.post<{ Params: Id; Body: { key?: string; reference?: string; note?: string } }>('/api/companies/:id/calendar/done', async (req) => inCompany(req, req.params.id, async (db, c) => {
    await K.markDone(db, c, req.body?.key, req.body ?? {}); return ok;
  }));
  app.post<{ Params: Id; Body: { key?: string } }>('/api/companies/:id/calendar/undo', async (req) => inCompany(req, req.params.id, async (db, c) => { await K.undoDone(db, c, req.body?.key); return ok; }));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/calendar/custom', async (req) => inCompany(req, req.params.id, (db, c) => K.listCustom(db, c, req.query.all === '1')));
  app.post<{ Params: Id; Body: K.CustomInput }>('/api/companies/:id/calendar/custom', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await K.saveCustom(db, c, req.body ?? {}) })));
  app.post<{ Params: Id; Body: K.CustomInput }>('/api/calendar/custom/:id', async (req) => byId(req, req.params.id, async (db, id) => {
    const c = (await db.query('SELECT company_id FROM compliance_custom WHERE id = $1', [id])).rows[0]?.company_id ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();
    return { id: await K.saveCustom(db, c, req.body ?? {}, id) };
  }));

  // ---------------------------------------------------------------- portal
  app.get('/api/portal/my-clients', async (req) => as(req, async (db) => (await db.query(
    `SELECT company_id AS "companyId", new_uploads AS "newUploads", open_requests AS "openRequests", answered_requests AS "answeredRequests", unread_letters AS "unreadLetters"
     FROM portal_my_clients()`)).rows));
  app.get<{ Params: Id }>('/api/companies/:id/portal/overview', async (req) => inCompany(req, req.params.id, (db, c) => P.overview(db, c)));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/portal/requests', async (req) => inCompany(req, req.params.id, (db, c) => P.listRequests(db, c, req.query.status)));
  app.post<{ Params: Id; Body: P.RequestInput }>('/api/companies/:id/portal/requests', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await P.createRequest(db, c, req.body ?? {}) })));
  app.post<{ Params: Id; Body: { status?: string } }>('/api/portal/requests/:id/status', async (req) => byId(req, req.params.id, async (db, id) => { await P.setRequestStatus(db, id, String(req.body?.status)); return ok; }));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/portal/uploads', async (req) => inCompany(req, req.params.id, (db, c) =>
    P.listUploads(db, c, { status: req.query.status, requestId: req.query.request && /^[0-9a-f-]{36}$/.test(req.query.request) ? req.query.request : undefined })));
  app.post<{ Params: Id; Body: P.UploadInput }>('/api/companies/:id/portal/uploads', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await P.createUpload(db, c, req.body ?? {}) })));
  app.post<{ Params: Id; Body: { status?: string } }>('/api/portal/uploads/:id/status', async (req) => byId(req, req.params.id, async (db, id) => { await P.setUploadStatus(db, id, String(req.body?.status)); return ok; }));
  app.post<{ Params: Id }>('/api/portal/uploads/:id/delete', async (req) => byId(req, req.params.id, async (db, id) => { await P.removeUpload(db, id); return ok; }));
  app.get<{ Params: Id }>('/api/companies/:id/portal/letters', async (req) => inCompany(req, req.params.id, (db, c) => P.listLetters(db, c)));
  app.post<{ Params: Id; Body: { periodEnd?: string; commentary?: string } }>('/api/companies/:id/portal/letters', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await P.publishLetter(db, c, req.body ?? {}) })));
  app.post<{ Params: Id }>('/api/portal/letters/:id/read', async (req) => byId(req, req.params.id, async (db, id) => { await P.markLetterRead(db, id); return ok; }));
}
