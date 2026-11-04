// Sales and purchases routes: customers, suppliers, quotations, invoices, credit notes, bills,
// supplier credits and payments. Row-level security decides what each person can see and do.
import { sendAfterIssue } from './einvoice.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import { DOC_TYPES, type DocType, type Direction } from '../books/documents.js';
import * as S from '../books/documentsService.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);   // RLS: members of active clients only
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
const docType = (v: unknown): DocType => {
  if (!DOC_TYPES.includes(v as DocType)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
  return v as DocType;
};
const direction = (v: unknown): Direction => (v === 'made' ? 'made' : v === 'received' ? 'received'
  : (() => { throw new HttpError(400, 'Some values are not in the right format.', 'err.format'); })());

type P = { id: string };
export function registerSalesRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };

  // ---------------------------------------------------------------- contacts
  app.get<{ Params: P; Querystring: { role?: string; q?: string } }>('/api/companies/:id/contacts', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.listContacts(db, c, (['supplier', 'employee', 'payee'] as const).find((r) => r === req.query.role) ?? 'customer', req.query.q ?? '')));
  app.post<{ Params: P; Body: S.ContactInput }>('/api/companies/:id/contacts', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await S.saveContact(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/contacts/:id', async (req) => as(req, (db) => S.getContact(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: S.ContactInput }>('/api/contacts/:id', async (req) => as(req, async (db) => {
    const c = await S.getContact(db, uuidParam(req.params.id));
    return { id: await S.saveContact(db, c.companyId, req.body ?? {}, c.id) };
  }));

  // ---------------------------------------------------------------- documents
  app.get<{ Params: P; Querystring: { type?: string; status?: string; q?: string; contactId?: string } }>('/api/companies/:id/documents', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.listDocuments(db, c, docType(req.query.type), {
      status: req.query.status, q: req.query.q, contactId: req.query.contactId ? uuidParam(req.query.contactId) : undefined })));
  app.post<{ Params: P; Body: S.DocumentInput }>('/api/companies/:id/documents', async (req) =>
    inCompany(req, req.params.id, async (db, c) => {
      const b = req.body ?? {};
      if (b.type === 'credit_note' || b.type === 'supplier_credit') throw new HttpError(400, 'Create credit notes from the invoice or bill.', 'err.format');
      return { id: await S.saveDraft(db, c, { ...b, originalId: null }) };
    }));
  app.get<{ Params: P }>('/api/documents/:id', async (req) => as(req, (db) => S.getDocument(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: S.DocumentInput }>('/api/documents/:id', async (req) => as(req, async (db) => {
    const d = await S.getDocument(db, uuidParam(req.params.id));
    return { id: await S.saveDraft(db, d.companyId, { ...req.body, type: d.type, originalId: d.originalId }, d.id) };
  }));
  app.post<{ Params: P }>('/api/documents/:id/delete', async (req) => as(req, async (db) => { await S.deleteDraft(db, uuidParam(req.params.id)); return { ok: true }; }));
  app.post<{ Params: P }>('/api/documents/:id/issue', async (req) => {
    const id = uuidParam(req.params.id);
    await as(req, (db) => S.issueDocument(db, id));
    await sendAfterIssue(as, req, id);   // ZATCA clearance or reporting, outside the issuing transaction
    return { ok: true };
  });
  app.post<{ Params: P; Body: { status?: string } }>('/api/documents/:id/quotation-status', async (req) => as(req, async (db) => {
    const st = req.body?.status;
    if (st !== 'sent' && st !== 'accepted' && st !== 'declined' && st !== 'received' && st !== 'cancelled') throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
    await S.setQuotationStatus(db, uuidParam(req.params.id), st);
    return { ok: true };
  }));
  app.post<{ Params: P }>('/api/documents/:id/convert', async (req) => as(req, async (db) => ({ id: await S.convertQuotation(db, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/documents/:id/convert-po', async (req) => as(req, async (db) => ({ id: await S.convertPurchaseOrder(db, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/documents/:id/debit', async (req) => as(req, async (db) => ({ id: await S.createDebit(db, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/documents/:id/credit', async (req) => as(req, async (db) => ({ id: await S.createCredit(db, uuidParam(req.params.id)) })));

  // ---------------------------------------------------------------- payments
  app.get<{ Params: P; Querystring: { direction?: string; q?: string; contactId?: string } }>('/api/companies/:id/payments', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.listPayments(db, c, direction(req.query.direction), {
      q: req.query.q, contactId: req.query.contactId ? uuidParam(req.query.contactId) : undefined })));
  app.post<{ Params: P; Body: S.PaymentInput }>('/api/companies/:id/payments', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await S.recordPayment(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/payments/:id', async (req) => as(req, (db) => S.getPayment(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { date?: string } }>('/api/payments/:id/void', async (req) => as(req, async (db) => {
    await S.voidPayment(db, uuidParam(req.params.id), dateParam(req.body?.date, today()));
    return { ok: true };
  }));
  app.get<{ Params: P; Querystring: { contactId?: string; direction?: string } }>('/api/companies/:id/open-documents', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.openDocuments(db, c, uuidParam(String(req.query.contactId ?? '')), direction(req.query.direction))));

  // ---------------------------------------------------------------- overview and ageing
  app.get<{ Params: P; Querystring: { side?: string } }>('/api/companies/:id/overview', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.overview(db, c, req.query.side === 'purchases' ? 'purchases' : 'sales')));
  app.get<{ Params: P; Querystring: { side?: string; asOf?: string } }>('/api/companies/:id/reports/aged', async (req) =>
    inCompany(req, req.params.id, (db, c) => S.aged(db, c, req.query.side === 'purchases' ? 'purchases' : 'sales', dateParam(req.query.asOf, today()))));
}
