// HTTP API for the web front end. Every request that touches data runs inside withUser(), so the
// database's row-level security and role rules decide what the signed-in user can see and do.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { withUser, type Db } from '../db/session.js';
import { checkEntry, postEntry, reverseEntry, setPeriodLock, trialBalance, type EntryInput } from '../ledger/ledger.js';
import { SESSION_COOKIE, readCookie, verifySession } from '../auth/session.js';
import { SYSTEM_ACCOUNTS } from '../books/chartTemplate.js';
import { HttpError, toHttpError } from './errors.js';
import { dateParam, today, uuidParam, type Ctx, type ServerOptions } from './context.js';
import { registerAuthRoutes } from './auth.js';
import { registerAdminRoutes } from './admin.js';
import { registerSalesRoutes } from './sales.js';
import { registerExpenseRoutes } from './expenses.js';
import { registerLedgerRoutes } from './ledger.js';
import { registerBankRoutes } from './bank.js';
import { registerStockRoutes } from './stock.js';
import { registerHrmRoutes } from './hrm.js';
import { registerCrmRoutes } from './crm.js';
import { registerReviewRoutes } from './review.js';
import { registerOwnerRoutes } from './owner.js';
import { registerReportRoutes } from './reports.js';
import { registerPortalRoutes } from './portal.js';
import { registerEInvoiceRoutes } from './einvoice.js';
import { registerApprovalRoutes, registerImportRoutes, registerSearchRoutes, registerSetupStatusRoutes } from './approvals.js';
import { registerFxRoutes, registerYearEndRoutes } from './fx.js';
import { registerEmailRoutes } from './email.js';
import { registerToolRoutes } from './tools.js';
import { registerBillingRoutes } from './billing.js';
import { registerPaymentRoutes } from './payments.js';
import { configurePayments } from '../books/onlinePayService.js';
import { configureEInvoicing } from '../books/einvoiceService.js';
import { reviewedUpTo } from '../books/reviewService.js';
import { registerSetupRoutes } from './setup.js';
import { profitAndLoss } from '../books/reportsService.js';
import { registerPermissionCheck } from './permissions.js';

export type { ServerOptions } from './context.js';
const POSTING_ROLES = ['partner', 'staff_accountant', 'client_accountant'];


declare module 'fastify' {
  interface FastifyRequest { userId: string | null }
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });
  const { pool } = opts;
  app.decorateRequest('userId', null);

  app.addHook('onRequest', async (req) => {
    req.userId = verifySession(opts.sessionSecret, readCookie(req.headers.cookie, SESSION_COOKIE));
  });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    const isPg = typeof (err as { code?: unknown }).code === 'string' && 'severity' in (err as object);
    const e = err instanceof HttpError || isPg
      ? toHttpError(err)
      : status && status < 500
        ? new HttpError(status, 'Some values are not in the right format.', 'err.format')
        : toHttpError(err);
    if (e.status >= 500) req.log.error(err);
    reply.status(e.status).send({ error: e.message, key: e.key, details: e.details });
  });

  /** Runs fn as the signed-in user, inside one transaction. */
  const as = <T>(req: FastifyRequest, fn: (db: Db) => Promise<T>): Promise<T> => {
    if (!req.userId) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    // The platform owner names the customer they are working in (only the owner's requests honour it: 0023_tenants.sql).
    const acting = req.headers['x-acting-tenant'];
    return withUser(pool, req.userId, fn, typeof acting === 'string' && /^[0-9a-f-]{36}$/i.test(acting) ? acting : null);
  };
  const ctx: Ctx = { pool, opts, as };
  configureEInvoicing({ encryptionKey: opts.encryptionKey || opts.sessionSecret });
  configurePayments({ encryptionKey: opts.encryptionKey || opts.sessionSecret });
  registerPermissionCheck(app, ctx);

  async function companyRole(db: Db, companyId: string): Promise<string> {
    const { rows } = await db.query(
      `SELECT m.role FROM memberships m JOIN companies c ON c.id = m.company_id   -- suspended clients are hidden by RLS
       WHERE m.user_id = app_user_id() AND m.company_id = $1`, [companyId]);
    if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
    return rows[0].role;
  }

  registerAuthRoutes(app, ctx);

  // ---------------------------------------------------------------- books
  app.get<{ Params: { id: string } }>('/api/companies/:id', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    const role = await companyRole(db, id);
    const { rows } = await db.query(
      `SELECT id, name, name_ar AS "nameAr", country, currency, vat_rate AS "vatRate", vat_status AS "vatStatus",
              vat_number AS "vatNumber", cr_number AS "crNumber", city, invoice_prefix AS "invoicePrefix",
              payment_terms_days AS "paymentTermsDays", industry, modules
       FROM companies WHERE id = $1`, [id]);
    const accounts = await db.query(
      `SELECT id, code, name, name_ar AS "nameAr", type, cost_centre_required AS "costCentreRequired", is_bank AS "isBank", currency
       FROM accounts WHERE company_id = $1 ORDER BY code`, [id]);
    const costCentres = await db.query(
      `SELECT id, name, name_ar AS "nameAr", kind FROM cost_centres WHERE company_id = $1 ORDER BY name`, [id]);
    const periods = await db.query(
      `SELECT start_date::text AS "startDate", end_date::text AS "endDate", locked_at AS "lockedAt"
       FROM periods WHERE company_id = $1 ORDER BY start_date`, [id]);
    const access = (await db.query('SELECT permissions, can_approve AS "canApprove", name, name_ar AS "nameAr", can_review AS "canReview", can_sign_off AS "canSignOff", pos_mode AS "posMode" FROM app_client_role($1)', [id])).rows[0] ?? null;
    return {
      company: rows[0], role, access, reviewedUpTo: await reviewedUpTo(db, id),
      review: (await db.query('SELECT app_can_review($1) AS "canReview", app_can_sign($1) AS "canSignOff"', [id])).rows[0],
      // Firm staff on this client (the portal's firm side), whether this person keeps the calendar, and the customer's kind.
      portal: (await db.query('SELECT portal_is_firm($1) AS firm, app_has_role($1, calendar_roles()) AS "calendarEdit", app_firm_kind() AS "tenantKind"', [id])).rows[0],
      canPost: POSTING_ROLES.includes(role), canLock: role === 'partner',
      accounts: accounts.rows, costCentres: costCentres.rows, periods: periods.rows,
    };
  }));

  app.get<{ Params: { id: string } }>('/api/companies/:id/summary', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    await companyRole(db, id);
    const t = today();
    const balances = await db.query(
      `SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS balance
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= $2
       WHERE a.company_id = $1 AND (l.id IS NULL OR e.id IS NOT NULL)
       GROUP BY a.code`, [id, t]);
    const bal = (code: string) => balances.rows.find((r) => r.code === code)?.balance ?? '0.00';
    const monthStart = `${t.slice(0, 7)}-01`;
    const pnl = await db.query('SELECT income::text, expense::text, profit::text FROM profit_and_loss($1, $2, $3)', [id, monthStart, t]);
    const counts = await db.query(
      `SELECT count(*)::int AS entries,
              count(*) FILTER (WHERE entry_date >= $2)::int AS "entriesThisMonth"
       FROM journal_entries WHERE company_id = $1`, [id, monthStart]);
    const lock = await db.query(
      `SELECT max(end_date)::text AS "lockedUpTo" FROM periods WHERE company_id = $1 AND locked_at IS NOT NULL`, [id]);
    return {
      asOf: t,
      cash: bal(SYSTEM_ACCOUNTS.cash),
      receivables: bal(SYSTEM_ACCOUNTS.receivables),
      payables: bal(SYSTEM_ACCOUNTS.payables),
      inputVat: bal(SYSTEM_ACCOUNTS.inputVat),
      outputVat: bal(SYSTEM_ACCOUNTS.outputVat),
      monthIncome: pnl.rows[0].income,
      monthExpense: pnl.rows[0].expense,
      monthProfit: pnl.rows[0].profit,
      ...counts.rows[0],
      lockedUpTo: lock.rows[0].lockedUpTo,
    };
  }));

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/companies/:id/entries', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    await companyRole(db, id);
    const q = (req.query.q ?? '').trim();
    const { rows } = await db.query(
      `SELECT e.id, e.entry_date::text AS date, e.memo, e.source_type AS "sourceType", e.created_at AS "createdAt",
              u.full_name AS "createdBy",
              e.reverses_entry_id AS "reversesEntryId",
              (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS "reversedById",
              (SELECT json_agg(json_build_object(
                  'id', l.id, 'accountCode', a.code, 'accountName', a.name, 'accountNameAr', a.name_ar,
                  'costCentre', cc.name, 'costCentreAr', cc.name_ar,
                  'debit', l.debit::text, 'credit', l.credit::text, 'currency', a.currency, 'fxAmount', l.fx_amount::text, 'fxRate', l.fx_rate::text) ORDER BY l.debit DESC, a.code)
               FROM journal_lines l JOIN accounts a ON a.id = l.account_id
               LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
               WHERE l.entry_id = e.id) AS lines
       FROM journal_entries e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.company_id = $1
         AND ($2 = '' OR e.memo ILIKE '%' || $2 || '%'
              OR EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id
                         AND ($2 = l.debit::text OR $2 = l.credit::text)))
       ORDER BY e.entry_date DESC, e.created_at DESC
       LIMIT 200`, [id, q]);
    return rows;
  }));

  app.post<{ Params: { id: string }; Body: Omit<EntryInput, 'companyId'> }>('/api/companies/:id/entries', async (req) => {
    const id = uuidParam(req.params.id);
    const body = req.body ?? ({} as Omit<EntryInput, 'companyId'>);
    const input: EntryInput = {
      companyId: id,
      entryDate: dateParam(body.entryDate, ''),
      memo: typeof body.memo === 'string' ? body.memo.slice(0, 500) : undefined,
      sourceType: 'manual',
      lines: Array.isArray(body.lines) ? body.lines.map((l) => ({
        accountId: uuidParam(String(l.accountId ?? '')),
        costCentreId: l.costCentreId ? uuidParam(String(l.costCentreId)) : null,
        debit: l.debit ? String(l.debit) : undefined,
        credit: l.credit ? String(l.credit) : undefined,
        fxAmount: l.fxAmount ? String(l.fxAmount) : null,
        fxRate: l.fxRate ? String(l.fxRate) : null,
      })) : [],
    };
    if (!input.entryDate) throw new HttpError(400, 'Fill in all required fields.', 'err.required');
    let problems: string[];
    try {
      problems = checkEntry(input);
    } catch {
      throw new HttpError(400, 'Amounts must be numbers with at most 2 decimals.', 'err.amountFormat');
    }
    if (problems.length) throw new HttpError(400, problems[0]!, undefined, problems);
    const entryId = await as(req, (db) => postEntry(db, input));
    return { id: entryId };
  });

  app.post<{ Params: { id: string }; Body: { date?: string } }>('/api/entries/:id/reverse', async (req) => {
    const id = uuidParam(req.params.id);
    const date = dateParam(req.body?.date, today());
    return { id: await as(req, (db) => reverseEntry(db, id, date)) };
  });

  app.post<{ Params: { id: string; start: string }; Body: { locked?: boolean } }>(
    '/api/companies/:id/periods/:start/lock', async (req) => {
      const id = uuidParam(req.params.id);
      const start = dateParam(req.params.start, '');
      await as(req, async (db) => {
        await companyRole(db, id);
        try {
          await setPeriodLock(db, id, start, Boolean(req.body?.locked));
        } catch (e) {
          if ((e as { code?: string }).code) throw e;
          throw new HttpError(403, 'Only the Firm partner can lock or unlock periods.', 'err.lockPartner');
        }
      });
      return { ok: true };
    });

  app.get<{ Params: { id: string }; Querystring: { asOf?: string } }>('/api/companies/:id/reports/trial-balance', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    await companyRole(db, id);
    const asOf = dateParam(req.query.asOf, today());
    const rows = await trialBalance(db, id, asOf);
    const names = await db.query('SELECT id, name_ar AS "nameAr" FROM accounts WHERE company_id = $1', [id]);
    const ar = new Map(names.rows.map((r) => [r.id, r.nameAr]));
    return { asOf, rows: rows.map((r) => ({ ...r, nameAr: ar.get(r.accountId) ?? null })) };
  }));

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/companies/:id/reports/profit-and-loss', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    await companyRole(db, id);
    const to = dateParam(req.query.to, today());
    const from = dateParam(req.query.from, `${to.slice(0, 4)}-01-01`);
    const total = await db.query('SELECT income::text, expense::text, profit::text FROM profit_and_loss($1,$2,$3)', [id, from, to]);
    const byCc = await db.query(
      `SELECT p.cost_centre_id AS "costCentreId", p.cost_centre_name AS name, cc.name_ar AS "nameAr", cc.kind,
              p.income::text, p.expense::text, p.profit::text
       FROM profit_and_loss_by_cost_centre($1,$2,$3) p LEFT JOIN cost_centres cc ON cc.id = p.cost_centre_id`, [id, from, to]);
    return { from, to, total: total.rows[0], byCostCentre: byCc.rows, statement: await profitAndLoss(db, id, from, to) };
  }));

  registerAdminRoutes(app, ctx);
  registerSalesRoutes(app, ctx);
  registerExpenseRoutes(app, ctx);
  registerLedgerRoutes(app, ctx);
  registerBankRoutes(app, ctx);
  registerStockRoutes(app, ctx);
  registerHrmRoutes(app, ctx);
  registerCrmRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerOwnerRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerPortalRoutes(app, ctx);
  registerEInvoiceRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerFxRoutes(app, ctx);
  registerYearEndRoutes(app, ctx);
  registerEmailRoutes(app, ctx);
  registerToolRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerSetupStatusRoutes(app, ctx);
  registerSetupRoutes(app, ctx);

  app.all('/api/*', async () => { throw new HttpError(404, 'Not found.', 'err.notFound'); });

  // ---------------------------------------------------------------- built front end
  if (opts.staticDir && existsSync(opts.staticDir)) {
    const root = path.resolve(opts.staticDir);
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
    };
    app.get('/*', async (req, reply) => {
      const rel = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
      let file = path.resolve(root, rel || 'index.html');
      if (!file.startsWith(root + path.sep) || !existsSync(file) || !path.extname(file)) file = path.join(root, 'index.html');
      const ext = path.extname(file);
      reply.header('content-type', types[ext] ?? 'application/octet-stream');
      if (ext !== '.html') reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(await readFile(file));
    });
  }

  return app;
}

export const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
