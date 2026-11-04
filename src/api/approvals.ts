// Approvals and the cash flow forecast. Who may do what is enforced in the database (0026_approvals_forecast.sql).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { baseUrl, today, uuidParam, type Ctx } from './context.js';
import { notifyApprovers } from '../books/emailService.js';
import * as A from '../books/approvalsService.js';
import * as F from '../books/forecastService.js';
import type { PaymentInput } from '../books/documentsService.js';

type Id = { id: string };
type Q = Record<string, string | undefined>;
const ok = { ok: true };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1 AND id = ANY (app_company_ids())', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerApprovalRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const byId = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, id: string) => Promise<T>) => { const x = uuidParam(id); return as(req, (db) => fn(db, x)); };

  // ---------------------------------------------------------------- approvals
  app.get('/api/approvals/my-clients', async (req) => as(req, async (db) => (await db.query(
    `SELECT c AS "companyId", (SELECT count(*) FROM approval_requests r WHERE r.company_id = c AND r.status = 'pending' AND r.requested_by <> app_user_id() AND app_can_approve(c))::int AS "toDecide"
     FROM unnest(app_company_ids()) c`)).rows));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/approvals', async (req) => inCompany(req, req.params.id, (db, c) => A.list(db, c, req.query.status || undefined)));
  app.get<{ Params: Id }>('/api/companies/:id/approvals/waiting', async (req) => inCompany(req, req.params.id, (db, c) => A.waiting(db, c)));
  app.get<{ Params: Id }>('/api/companies/:id/approvals/rules', async (req) => inCompany(req, req.params.id, (db, c) => A.rules(db, c)));
  app.post<{ Params: Id; Body: { kind?: string; threshold?: string; active?: boolean } }>('/api/companies/:id/approvals/rules', async (req) => inCompany(req, req.params.id, async (db, c) => { await A.saveRule(db, c, req.body ?? {}); return ok; }));
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/approvals/needed', async (req) => inCompany(req, req.params.id, async (db, c) =>
    ({ needed: /^\d+(\.\d{1,2})?$/.test(String(req.query.amount)) ? await A.needed(db, c, String(req.query.kind), String(req.query.amount)) : false })));
  app.post<{ Params: Id; Body: PaymentInput & { note?: string } }>('/api/companies/:id/approvals/payments', async (req) => inCompany(req, req.params.id, async (db, c) => {
    const id = await A.requestPayment(db, c, req.body ?? {});
    await notifyApprovers(db, c, 'a supplier payment', baseUrl(req, opts));
    return { id };
  }));
  app.get<{ Params: Id }>('/api/documents/:id/approval', async (req) => byId(req, req.params.id, (db, id) => A.forDocument(db, id)));
  app.post<{ Params: Id; Body: { note?: string } }>('/api/documents/:id/approval', async (req) => byId(req, req.params.id, async (db, id) => {
    const rid = await A.requestDocument(db, id, req.body?.note);
    const d = (await db.query(`SELECT company_id, type FROM documents WHERE id = $1`, [id])).rows[0];
    await notifyApprovers(db, d.company_id, d.type === 'bill' ? 'a supplier bill' : 'a credit note', baseUrl(req, opts));
    return { id: rid };
  }));
  app.post<{ Params: Id; Body: { decision?: string; reason?: string } }>('/api/approvals/:id/decide', async (req) => byId(req, req.params.id, async (db, id) => { await A.decide(db, id, String(req.body?.decision), req.body?.reason); return ok; }));
  app.post<{ Params: Id }>('/api/approvals/:id/withdraw', async (req) => byId(req, req.params.id, async (db, id) => { await A.withdraw(db, id); return ok; }));
  app.post<{ Params: Id; Body: { date?: string } }>('/api/approvals/:id/pay', async (req) => byId(req, req.params.id, async (db, id) => ({ id: await A.payApproved(db, id, req.body?.date) })));

  // ---------------------------------------------------------------- cash flow forecast
  app.get<{ Params: Id; Querystring: Q }>('/api/companies/:id/forecast', async (req) => inCompany(req, req.params.id, (db, c) =>
    F.forecast(db, c, today(), { grain: req.query.grain, count: Number(req.query.count) || undefined, delayDays: Number(req.query.delay) || 0 })));
  app.get<{ Params: Id }>('/api/companies/:id/forecast/items', async (req) => inCompany(req, req.params.id, (db, c) => F.items(db, c)));
  app.post<{ Params: Id; Body: F.ItemInput }>('/api/companies/:id/forecast/items', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await F.saveItem(db, c, req.body ?? {}) })));
  app.post<{ Params: Id; Body: F.ItemInput }>('/api/forecast/items/:id', async (req) => byId(req, req.params.id, async (db, id) => {
    const c = (await db.query('SELECT company_id FROM forecast_items WHERE id = $1', [id])).rows[0]?.company_id ?? (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })();
    return { id: await F.saveItem(db, c, req.body ?? {}, id) };
  }));
  app.post<{ Params: Id; Body: { minimumCash?: string } }>('/api/companies/:id/forecast/settings', async (req) => inCompany(req, req.params.id, async (db, c) => { await F.saveSettings(db, c, req.body?.minimumCash); return ok; }));
}

// ---------------------------------------------------------------- bulk import (rows read from the file in the browser)
import * as Imp from '../books/importService.js';
type ImportBody = { rows?: unknown; date?: string; balanceToEquity?: boolean };
export function registerImportRoutes(app: FastifyInstance, { as }: Ctx) {
  const opts = { bodyLimit: 8 * 1024 * 1024 };
  app.post<{ Params: { id: string; kind: string }; Body: ImportBody }>('/api/companies/:id/import/:kind/preview', opts, async (req) => {
    const c = uuidParam(req.params.id); const kind = Imp.kindOf(req.params.kind);
    return as(req, async (db) => { await member(db, c); return Imp.preview(db, c, kind, req.body?.rows, req.body ?? {}); });
  });
  app.post<{ Params: { id: string; kind: string }; Body: ImportBody }>('/api/companies/:id/import/:kind/run', opts, async (req) => {
    const c = uuidParam(req.params.id); const kind = Imp.kindOf(req.params.kind);
    return as(req, async (db) => { await member(db, c); return Imp.run(db, c, kind, req.body?.rows, req.body ?? {}); });
  });
}

// ---------------------------------------------------------------- quick search (menu search box)
import { accessTo } from '../books/modules.js';
export function registerSearchRoutes(app: FastifyInstance, { as }: Ctx) {
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/companies/:id/search', async (req) => {
    const c = uuidParam(req.params.id);
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    return as(req, async (db) => {
      await member(db, c);
      if (q.length < 2) return { contacts: [], documents: [], items: [] };
      const perms = (await db.query('SELECT permissions FROM app_client_role($1)', [c])).rows[0]?.permissions ?? null;
      const can = (m: string) => accessTo(perms, m) !== 'none';
      const like = `%${q.replace(/[%_\\]/g, (x) => `\\${x}`)}%`;
      const contacts = (await db.query(
        `SELECT id, name, name_ar AS "nameAr", vat_number AS "vatNumber", CASE WHEN is_employee THEN 'employee' WHEN is_customer THEN 'customer' ELSE 'supplier' END AS kind
         FROM contacts WHERE company_id = $1 AND status = 'active' AND (name ILIKE $2 OR coalesce(name_ar, '') ILIKE $2 OR coalesce(vat_number, '') LIKE $2 OR coalesce(employee_no, '') ILIKE $2)
         ORDER BY name LIMIT 8`, [c, like])).rows.filter((x) => (x.kind === 'customer' ? can('Sales') : x.kind === 'supplier' ? can('Purchases') : can('HRM') || can('Expenses')));
      const types = [...(can('Sales') ? ['invoice', 'credit_note', 'quotation'] : []), ...(can('Purchases') ? ['bill', 'supplier_credit'] : []), ...(can('Expenses') ? ['expense', 'claim'] : [])];
      const documents = types.length ? (await db.query(
        `SELECT d.id, d.type, d.number, d.status, d.issue_date::text AS date, d.gross_total::text AS total, coalesce(ct.name, d.payee) AS contact
         FROM documents d LEFT JOIN contacts ct ON ct.id = d.contact_id
         WHERE d.company_id = $1 AND d.type = ANY ($3::doc_type[]) AND (d.number ILIKE $2 OR coalesce(d.reference, '') ILIKE $2 OR coalesce(ct.name, d.payee, '') ILIKE $2)
         ORDER BY d.issue_date DESC LIMIT 8`, [c, like, types])).rows : [];
      const items = can('Inventory') || can('Restaurant') ? (await db.query(
        `SELECT id, sku, name, name_ar AS "nameAr" FROM items WHERE company_id = $1 AND (sku ILIKE $2 OR name ILIKE $2 OR coalesce(name_ar, '') ILIKE $2) ORDER BY name LIMIT 6`, [c, like])).rows : [];
      return { contacts, documents, items };
    });
  });
}

// ---------------------------------------------------------------- getting started (Home): what is set up for this client
export function registerSetupStatusRoutes(app: FastifyInstance, { as }: Ctx) {
  app.get<{ Params: { id: string } }>('/api/companies/:id/setup-status', async (req) => {
    const c = uuidParam(req.params.id);
    return as(req, async (db) => {
      await member(db, c);
      const r = (await db.query(
        `SELECT co.country, co.vat_status::text AS vat, co.modules,
          EXISTS (SELECT 1 FROM bank_accounts WHERE company_id = $1 AND kind = 'bank') AS bank,
          EXISTS (SELECT 1 FROM contacts WHERE company_id = $1 AND is_customer) AS customers,
          EXISTS (SELECT 1 FROM contacts WHERE company_id = $1 AND is_supplier) AS suppliers,
          EXISTS (SELECT 1 FROM items WHERE company_id = $1) AS items,
          EXISTS (SELECT 1 FROM journal_entries WHERE company_id = $1) AS opening,
          EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND type = 'invoice' AND status = 'issued') AS invoice,
          EXISTS (SELECT 1 FROM einvoice_devices WHERE company_id = $1 AND status = 'active') OR coalesce((SELECT enabled FROM einvoice_settings WHERE company_id = $1), false) AS einvoicing,
          EXISTS (SELECT 1 FROM approval_rules WHERE company_id = $1 AND active) AS approvals
         FROM companies co WHERE co.id = $1`, [c])).rows[0];
      const steps: { key: string; done: boolean; go: [string, string?, string?] }[] = [
        { key: 'bank', done: r.bank, go: ['Bank', 'accounts', 'new'] },
        { key: 'customers', done: r.customers, go: ['Sales', 'customers', 'import'] },
        { key: 'suppliers', done: r.suppliers, go: ['Purchases', 'suppliers', 'import'] },
        ...((r.modules ?? []).includes('Inventory') ? [{ key: 'items', done: r.items, go: ['Inventory', 'items', 'import'] as [string, string, string] }] : []),
        { key: 'opening', done: r.opening, go: ['Ledger', 'import-data', 'opening'] },
        ...(r.vat === 'registered' && r.country !== 'OM' ? [{ key: 'einvoicing', done: r.einvoicing, go: ['Sales', 'e-invoicing'] as [string, string] }] : []),
        { key: 'approvals', done: r.approvals, go: ['Approvals', 'approval-rules'] },
        { key: 'invoice', done: r.invoice, go: ['Sales', 'invoices', 'new'] },
      ];
      return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
    });
  });
}
