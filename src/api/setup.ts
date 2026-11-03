// Chart of accounts, cost centres and attachments.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as U from '../books/setupService.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
type P = { id: string };
const UPLOAD = { bodyLimit: 15 * 1024 * 1024 };   // 10 MB file, sent as base64

export function registerSetupRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const companyOf = async (db: Db, table: 'accounts' | 'cost_centres', id: string) => {
    const r = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [uuidParam(id)])).rows[0];
    if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
    return r.company_id as string;
  };

  // The client's details printed at the top of its PDFs.
  app.get<{ Params: P }>('/api/companies/:id/print-header', async (req) => inCompany(req, req.params.id, async (db, c) => ({ seller: (await db.query(
    `SELECT c.name, c.name_ar AS "nameAr", c.vat_number AS "vatNumber", c.cr_number AS "crNumber", c.address, c.city, c.country, c.currency, c.phone, c.email,
            b.bank_name AS "bankName", b.iban
     FROM companies c LEFT JOIN LATERAL (SELECT bank_name, iban FROM bank_accounts WHERE company_id = c.id AND kind = 'bank' AND status = 'active' AND iban IS NOT NULL
                                         ORDER BY created_at LIMIT 1) b ON true WHERE c.id = $1`, [c])).rows[0] })));
  app.get<{ Params: P }>('/api/companies/:id/chart', async (req) => inCompany(req, req.params.id, (db, c) => U.chart(db, c)));
  app.get<{ Params: P; Querystring: { type?: string } }>('/api/companies/:id/chart/next-code', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ code: await U.nextCode(db, c, (U.ACCOUNT_TYPES as readonly string[]).includes(String(req.query.type)) ? req.query.type as 'asset' : 'expense') })));
  app.post<{ Params: P; Body: U.AccountInput }>('/api/companies/:id/accounts', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await U.saveAccount(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: U.AccountInput }>('/api/accounts/:id', async (req) => as(req, async (db) => ({ id: await U.saveAccount(db, await companyOf(db, 'accounts', req.params.id), req.body ?? {}, req.params.id) })));

  app.get<{ Params: P }>('/api/companies/:id/cost-centres', async (req) => inCompany(req, req.params.id, (db, c) => U.costCentres(db, c)));
  app.post<{ Params: P; Body: U.CostCentreInput }>('/api/companies/:id/cost-centres', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await U.saveCostCentre(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: U.CostCentreInput }>('/api/cost-centres/:id', async (req) =>
    as(req, async (db) => ({ id: await U.saveCostCentre(db, await companyOf(db, 'cost_centres', req.params.id), req.body ?? {}, req.params.id) })));

  // attachments of a document or a goods note
  for (const [path, key] of [['documents', 'documentId'], ['stock-notes', 'stockNoteId']] as const) {
    app.get<{ Params: P }>(`/api/${path}/:id/attachments`, async (req) => as(req, (db) => U.listAttachments(db, { [key]: uuidParam(req.params.id) })));
    app.post<{ Params: P; Body: U.AttachmentInput }>(`/api/${path}/:id/attachments`, UPLOAD, async (req) =>
      as(req, async (db) => ({ id: await U.addAttachment(db, { [key]: uuidParam(req.params.id) }, req.body ?? {}) })));
  }
  app.get<{ Params: P }>('/api/attachments/:id', async (req, reply) => {
    const f = await as(req, (db) => U.getAttachment(db, uuidParam(req.params.id)));
    return reply.header('content-type', f.contentType).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`).send(f.data);
  });
  app.post<{ Params: P }>('/api/attachments/:id/delete', async (req) => as(req, async (db) => { await U.removeAttachment(db, uuidParam(req.params.id)); return { ok: true }; }));
}
