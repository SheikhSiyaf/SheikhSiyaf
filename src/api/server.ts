// HTTP API for the web front end. Every request that touches data runs inside withUser(), so the
// database's row-level security and role rules decide what the signed-in user can see and do.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser, type Db } from '../db/session.js';
import { checkEntry, postEntry, reverseEntry, setPeriodLock, trialBalance, type EntryInput } from '../ledger/ledger.js';
import { verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, clearedCookie, readCookie, sessionCookie, signSession, verifySession } from '../auth/session.js';
import { CHART_TEMPLATE, SYSTEM_ACCOUNTS } from '../books/chartTemplate.js';
import { HttpError, toHttpError } from './errors.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../db/demoData.js';

export interface ServerOptions {
  pool: pg.Pool;
  sessionSecret: string;
  cookieSecure?: boolean;
  demoLogins?: boolean;
  /** Folder with the built front end (web/dist). Served with a fallback to index.html. */
  staticDir?: string;
  logger?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSTING_ROLES = ['partner', 'staff_accountant', 'client_accountant'];


function uuidParam(v: string): string {
  if (!UUID.test(v)) throw new HttpError(404, 'Not found.', 'err.notFound');
  return v;
}
function dateParam(v: unknown, fallback: string): string {
  if (v === undefined || v === '') return fallback;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
  return v;
}
const today = () => new Date().toISOString().slice(0, 10);

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
    return withUser(pool, req.userId, fn);
  };

  async function companyRole(db: Db, companyId: string): Promise<string> {
    const { rows } = await db.query(
      'SELECT role FROM memberships WHERE user_id = app_user_id() AND company_id = $1', [companyId]);
    if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
    return rows[0].role;
  }

  // ---------------------------------------------------------------- auth
  app.get('/api/config', async () => ({ demoLogins: Boolean(opts.demoLogins), demoPassword: opts.demoLogins ? DEMO_PASSWORD : undefined }));

  app.get('/api/demo-users', async () => {
    if (!opts.demoLogins) throw new HttpError(404, 'Not found.', 'err.notFound');
    return DEMO_USERS.map(({ name, email, kind, role, company }) => ({ name, email, kind, role, company }));
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/login', async (req, reply) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    const { rows } = await pool.query('SELECT id, password_hash FROM auth_user_by_email($1)', [email]);
    const ok = await verifyPassword(password, rows[0]?.password_hash);
    if (!ok || !rows[0]) throw new HttpError(401, 'The email or password is not right.', 'err.login');
    reply.header('set-cookie', sessionCookie(signSession(opts.sessionSecret, rows[0].id), Boolean(opts.cookieSecure)));
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', clearedCookie(Boolean(opts.cookieSecure)));
    return { ok: true };
  });

  app.get('/api/me', async (req) => as(req, async (db) => {
    const u = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, u.kind, u.staff_role AS "staffRole", f.name AS "firmName"
       FROM users u LEFT JOIN firms f ON f.id = u.firm_id WHERE u.id = app_user_id()`);
    if (!u.rows[0]) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    const companies = await db.query(
      `SELECT c.id, c.name, c.name_ar AS "nameAr", c.country, c.currency, c.vat_rate AS "vatRate", m.role
       FROM companies c JOIN memberships m ON m.company_id = c.id AND m.user_id = app_user_id()
       ORDER BY c.name`);
    return { user: u.rows[0], companies: companies.rows };
  }));

  // ---------------------------------------------------------------- books
  app.get<{ Params: { id: string } }>('/api/companies/:id', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    const role = await companyRole(db, id);
    const { rows } = await db.query(
      `SELECT id, name, name_ar AS "nameAr", country, currency, vat_rate AS "vatRate", vat_status AS "vatStatus",
              vat_number AS "vatNumber", cr_number AS "crNumber", city, invoice_prefix AS "invoicePrefix",
              payment_terms_days AS "paymentTermsDays"
       FROM companies WHERE id = $1`, [id]);
    const accounts = await db.query(
      `SELECT id, code, name, name_ar AS "nameAr", type, cost_centre_required AS "costCentreRequired"
       FROM accounts WHERE company_id = $1 ORDER BY code`, [id]);
    const costCentres = await db.query(
      `SELECT id, name, name_ar AS "nameAr", kind FROM cost_centres WHERE company_id = $1 ORDER BY name`, [id]);
    const periods = await db.query(
      `SELECT start_date::text AS "startDate", end_date::text AS "endDate", locked_at AS "lockedAt"
       FROM periods WHERE company_id = $1 ORDER BY start_date`, [id]);
    return {
      company: rows[0], role,
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
                  'debit', l.debit::text, 'credit', l.credit::text) ORDER BY l.debit DESC, a.code)
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
      `SELECT p.cost_centre_id AS "costCentreId", p.cost_centre_name AS name, cc.name_ar AS "nameAr",
              p.income::text, p.expense::text, p.profit::text
       FROM profit_and_loss_by_cost_centre($1,$2,$3) p LEFT JOIN cost_centres cc ON cc.id = p.cost_centre_id`, [id, from, to]);
    return { from, to, total: total.rows[0], byCostCentre: byCc.rows };
  }));

  // ---------------------------------------------------------------- admin console
  const requireAdmin = async (db: Db) => {
    const { rows } = await db.query('SELECT app_is_admin() AS a');
    if (!rows[0].a) throw new HttpError(403, 'Only the Administrator can do this.', 'err.adminOnly');
  };

  app.get('/api/admin/companies', async (req) => as(req, async (db) => {
    await requireAdmin(db);
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.name_ar AS "nameAr", c.country, c.currency, c.cr_number AS "crNumber",
              c.vat_status AS "vatStatus", c.vat_number AS "vatNumber", c.vat_rate AS "vatRate", c.city,
              c.created_at AS "createdAt",
              (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
                 WHERE m.company_id = c.id AND u.kind = 'client')::int AS "clientUsers",
              (SELECT coalesce(json_agg(u.full_name ORDER BY u.full_name), '[]') FROM memberships m JOIN users u ON u.id = m.user_id
                 WHERE m.company_id = c.id AND u.kind = 'firm_staff') AS staff
       FROM companies c WHERE c.firm_id = app_firm_id() ORDER BY c.name`);
    return rows;
  }));

  app.get('/api/admin/staff', async (req) => as(req, async (db) => {
    await requireAdmin(db);
    const { rows } = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, u.staff_role AS role,
              (u.totp_secret_enc IS NOT NULL) AS "twoFactor",
              (SELECT coalesce(json_agg(c.name ORDER BY c.name), '[]') FROM memberships m JOIN companies c ON c.id = m.company_id
                 WHERE m.user_id = u.id) AS clients
       FROM users u WHERE u.firm_id = app_firm_id() AND u.kind = 'firm_staff' ORDER BY u.full_name`);
    return rows;
  }));

  interface NewClient {
    company: Record<string, unknown>;
    firstUser: { name?: string; email?: string; role?: string };
    staffIds?: string[];
  }

  app.post<{ Body: NewClient }>('/api/admin/companies', async (req) => {
    const b = req.body ?? ({} as NewClient);
    const c = b.company ?? {};
    const s = (k: string) => (typeof c[k] === 'string' && (c[k] as string).trim() !== '' ? (c[k] as string).trim() : null);
    const country = s('country');
    const defaults: Record<string, { currency: string; vatRate: string }> = {
      SA: { currency: 'SAR', vatRate: '15.00' }, AE: { currency: 'AED', vatRate: '5.00' }, OM: { currency: 'OMR', vatRate: '5.00' },
    };
    const d = defaults[country ?? ''];
    if (!d) throw new HttpError(400, 'Choose the country.', 'err.country');
    const registered = s('vatStatus') !== 'unregistered';
    const fyEnd = s('fyEnd') ?? '12-31';
    if (!/^\d{2}-\d{2}$/.test(fyEnd)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
    const firstName = String(b.firstUser?.name ?? '').trim();
    const firstEmail = String(b.firstUser?.email ?? '').trim();
    if (!firstName || !firstEmail) throw new HttpError(400, 'Add the first client user (name and email).', 'err.firstClientUser');
    const firstRole = b.firstUser?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant';
    const staffIds = (b.staffIds ?? []).map((x) => uuidParam(String(x)));

    const id = await as(req, async (db) => {
      await requireAdmin(db);
      const { rows } = await db.query(
        `INSERT INTO companies (firm_id, name, name_ar, trade_name, country, currency, cr_number, cr_expiry, legal_form,
            vat_status, vat_number, vat_registration_date, vat_rate, address, city, fy_end_month, fy_end_day,
            phone, email, website, compliance_notes, invoice_prefix, payment_terms_days)
         VALUES (app_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 coalesce($21, 'INV-'), coalesce($22::int, 30))
         RETURNING id`,
        [s('name'), s('nameAr'), s('tradeName'), country, d.currency, s('crNumber'), s('crExpiry'), s('legalForm'),
         registered ? 'registered' : 'unregistered', registered ? s('vatNumber') : null, registered ? s('vatRegistrationDate') : null,
         registered ? d.vatRate : '0', s('address'), s('city'), Number(fyEnd.slice(0, 2)), Number(fyEnd.slice(3)),
         s('phone'), s('email'), s('website'), s('complianceNotes'), s('invoicePrefix'), s('paymentTermsDays')]);
      const companyId: string = rows[0].id;
      const u = await db.query(
        `INSERT INTO users (firm_id, kind, full_name, email) VALUES (app_firm_id(), 'client', $1, $2) RETURNING id`,
        [firstName, firstEmail]);
      await db.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)', [u.rows[0].id, companyId, firstRole]);
      for (const staffId of staffIds) {
        await db.query(
          `INSERT INTO memberships (user_id, company_id, role)
           SELECT id, $2, staff_role FROM users WHERE id = $1 AND kind = 'firm_staff'`, [staffId, companyId]);
      }
      await db.query('SELECT setup_company_books($1, $2, $3)',
        [companyId, JSON.stringify(CHART_TEMPLATE), new Date().getFullYear()]);
      return companyId;
    });
    return { id };
  });

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
