// E-invoicing routes: settings, ZATCA onboarding, the e-invoices and sending them. Who may do what is enforced in
// the database (0025_einvoicing.sql); the books team (those who post) sets it up and sends.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as E from '../books/einvoiceService.js';

type Id = { id: string };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerEInvoiceRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  app.get<{ Params: Id }>('/api/companies/:id/einvoicing', async (req) => inCompany(req, req.params.id, (db, c) => E.overview(db, c)));
  app.post<{ Params: Id; Body: Partial<E.Settings> }>('/api/companies/:id/einvoicing/settings', async (req) => inCompany(req, req.params.id, async (db, c) => { await E.saveSettings(db, c, req.body ?? {}); return { ok: true }; }));
  app.post<{ Params: Id; Body: E.OnboardInput }>('/api/companies/:id/einvoicing/devices', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await E.onboard(db, c, req.body ?? {}) })));
  app.post<{ Params: Id }>('/api/einvoicing/devices/:id/finish', async (req) => as(req, (db) => E.finishOnboarding(db, uuidParam(req.params.id))));
  app.get<{ Params: Id; Querystring: { status?: string } }>('/api/companies/:id/einvoices', async (req) => inCompany(req, req.params.id, (db, c) => E.list(db, c, req.query.status || undefined)));
  app.post<{ Params: Id }>('/api/companies/:id/einvoices/send-pending', async (req) => inCompany(req, req.params.id, (db, c) => E.submitPending(db, c)));
  app.post<{ Params: Id }>('/api/einvoices/:id/submit', async (req) => as(req, (db) => E.submit(db, uuidParam(req.params.id))));
  app.get<{ Params: Id; Querystring: { json?: string } }>('/api/einvoices/:id/xml', async (req, reply) => {
    const f = await as(req, (db) => E.xmlOf(db, uuidParam(req.params.id)));
    if (req.query.json === '1') return f;   // the web app saves it as a file
    return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${f.fileName}"`).send(f.xml);
  });
  app.get<{ Params: Id }>('/api/documents/:id/einvoice', async (req) => as(req, (db) => E.forDocument(db, uuidParam(req.params.id))));
  app.post<{ Params: Id }>('/api/documents/:id/einvoice/again', async (req) => {
    const id = uuidParam(req.params.id);
    const eid = await as(req, (db) => E.prepareAgain(db, id));
    if (eid) await as(req, (db) => E.submit(db, eid)).catch(() => undefined);
    return { id: eid };
  });
}

/** After an invoice is issued (in its own transaction), its e-invoice is sent to ZATCA straight away; if ZATCA
 *  cannot be reached it stays pending and is sent again from Sales > E-invoicing. */
export async function sendAfterIssue(as: Ctx['as'], req: Parameters<Ctx['as']>[0], documentId: string) {
  await as(req, async (db) => {
    const e = (await db.query(`SELECT id FROM einvoices WHERE document_id = $1 AND scheme = 'zatca' AND status = 'pending'`, [documentId])).rows[0];
    if (e) await E.submit(db, e.id);
  }).catch(() => undefined);
}
