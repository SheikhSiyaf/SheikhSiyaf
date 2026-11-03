// Administrator console: clients, client users, firm staff, access, suspension, invitations,
// activity log and firm settings. The Administrator never reaches the books (RLS + no memberships).
import { cleanModules, DEFAULT_MODULES, isIndustry, type Industry } from '../books/modules.js';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { CHART_TEMPLATE } from '../books/chartTemplate.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import { hashInviteToken } from './auth.js';

const STAFF_ROLES = ['partner', 'reviewer', 'staff_accountant'];
const CLIENT_ROLES = ['client_accountant', 'client_viewer'];
const COUNTRY_DEFAULTS: Record<string, { currency: string; vatRate: string }> = {
  SA: { currency: 'SAR', vatRate: '15.00' }, AE: { currency: 'AED', vatRate: '5.00' }, OM: { currency: 'OMR', vatRate: '5.00' },
};
const INVITE_DAYS = 7;

async function requireAdmin(db: Db) {
  const { rows } = await db.query('SELECT app_is_admin() AS a');
  if (!rows[0].a) throw new HttpError(403, 'Only the Administrator can do this.', 'err.adminOnly');
}

/** Creates a one-time invitation for the user. Returns the token: it is shown once and never stored. */
async function newInvite(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const { rowCount } = await db.query(
    `UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + make_interval(days => $3)
     WHERE id = $1 AND firm_id = app_firm_id()`, [userId, hashInviteToken(token), INVITE_DAYS]);
  if (!rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
  return token;
}

function text(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Registration fields shared by "Add client" and "Edit client". Country is fixed after registration. */
function companyValues(c: Record<string, unknown>, country: string) {
  const d = COUNTRY_DEFAULTS[country];
  if (!d) throw new HttpError(400, 'Choose the country.', 'err.country');
  const registered = text(c, 'vatStatus') !== 'unregistered';
  const fyEnd = text(c, 'fyEnd') ?? '12-31';
  if (!/^\d{2}-\d{2}$/.test(fyEnd)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
  const terms = text(c, 'paymentTermsDays');
  return {
    name: text(c, 'name'), name_ar: text(c, 'nameAr'), trade_name: text(c, 'tradeName'),
    cr_number: text(c, 'crNumber'), cr_expiry: text(c, 'crExpiry'), legal_form: text(c, 'legalForm'),
    vat_status: registered ? 'registered' : 'unregistered',
    vat_number: registered ? text(c, 'vatNumber') : null,
    vat_registration_date: registered ? text(c, 'vatRegistrationDate') : null,
    vat_rate: registered ? d.vatRate : '0',
    address: text(c, 'address'), city: text(c, 'city'),
    fy_end_month: Number(fyEnd.slice(0, 2)), fy_end_day: Number(fyEnd.slice(3)),
    phone: text(c, 'phone'), email: text(c, 'email'), website: text(c, 'website'),
    compliance_notes: text(c, 'complianceNotes'),
    invoice_prefix: text(c, 'invoicePrefix') ?? 'INV-',
    industry: isIndustry(c.industry) ? c.industry : (() => { throw new HttpError(400, 'Choose the industry.', 'err.industry'); })(),
    // The modules chosen; when none are sent, the industry's defaults.
    modules: Array.isArray(c.modules) ? cleanModules(c.modules) : DEFAULT_MODULES[c.industry as Industry],
    payment_terms_days: terms === null ? 30 : Number(terms),
  };
}

function person(b: Record<string, unknown> | undefined) {
  const name = String(b?.name ?? '').trim();
  const email = String(b?.email ?? '').trim();
  if (!name || !email) throw new HttpError(400, 'Enter the name and email.', 'err.nameEmail');
  return { name, email };
}

export function registerAdminRoutes(app: FastifyInstance, { as }: Ctx) {
  const admin = <T>(req: Parameters<Ctx['as']>[0], fn: (db: Db) => Promise<T>) =>
    as(req, async (db) => { await requireAdmin(db); return fn(db); });

  // ------------------------------------------------------------ clients
  app.get('/api/admin/companies', async (req) => admin(req, async (db) => (await db.query(
    `SELECT c.id, c.name, c.name_ar AS "nameAr", c.country, c.currency, c.cr_number AS "crNumber",
            c.vat_status AS "vatStatus", c.vat_number AS "vatNumber", c.vat_rate AS "vatRate", c.city, c.status, c.industry,
            c.created_at AS "createdAt",
            (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.company_id = c.id AND u.kind = 'client' AND u.status = 'active')::int AS "clientUsers",
            (SELECT coalesce(json_agg(u.full_name ORDER BY u.full_name), '[]') FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.company_id = c.id AND u.kind = 'firm_staff' AND u.status = 'active') AS staff
     FROM companies c WHERE c.firm_id = app_firm_id() ORDER BY c.name`)).rows));

  app.get<{ Params: { id: string } }>('/api/admin/companies/:id', async (req) => admin(req, async (db) => {
    const id = uuidParam(req.params.id);
    const { rows } = await db.query(
      `SELECT id, name, name_ar AS "nameAr", trade_name AS "tradeName", country, currency, cr_number AS "crNumber",
              cr_expiry::text AS "crExpiry", legal_form AS "legalForm", vat_status AS "vatStatus", vat_number AS "vatNumber",
              vat_registration_date::text AS "vatRegistrationDate", vat_rate AS "vatRate", address, city,
              lpad(fy_end_month::text, 2, '0') || '-' || lpad(fy_end_day::text, 2, '0') AS "fyEnd",
              phone, email, website, compliance_notes AS "complianceNotes", invoice_prefix AS "invoicePrefix",
              payment_terms_days::text AS "paymentTermsDays", industry, modules, status, created_at AS "createdAt"
       FROM companies WHERE id = $1 AND firm_id = app_firm_id()`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
    const users = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, m.role, u.status,
              (u.invite_expires_at > now()) AS "invitePending", (u.password_hash IS NOT NULL) AS "passwordSet",
              (u.totp_enabled_at IS NOT NULL) AS "twoFactor"
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1 AND u.kind = 'client' ORDER BY u.full_name`, [id]);
    const staff = await db.query(
      `SELECT u.id, u.full_name AS name, u.staff_role AS role, u.status,
              EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.company_id = $1) AS assigned
       FROM users u WHERE u.firm_id = app_firm_id() AND u.kind = 'firm_staff' ORDER BY u.full_name`, [id]);
    return { company: rows[0], users: users.rows, staff: staff.rows };
  }));

  interface NewClient { company: Record<string, unknown>; firstUser: Record<string, unknown>; staffIds?: string[] }
  app.post<{ Body: NewClient }>('/api/admin/companies', async (req) => {
    const b = req.body ?? ({} as NewClient);
    const c = b.company ?? {};
    const country = text(c, 'country') ?? '';
    const v = companyValues(c, country);
    let first: { name: string; email: string };
    try { first = person(b.firstUser); } catch { throw new HttpError(400, 'Add the first client user (name and email).', 'err.firstClientUser'); }
    const firstRole = b.firstUser?.role === 'client_viewer' ? 'client_viewer' : 'client_accountant';
    const staffIds = (b.staffIds ?? []).map((x) => uuidParam(String(x)));

    return admin(req, async (db) => {
      const cols = Object.keys(v);
      const { rows } = await db.query(
        `INSERT INTO companies (firm_id, country, currency, ${cols.join(', ')})
         VALUES (app_firm_id(), $1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
        [country, COUNTRY_DEFAULTS[country]!.currency, ...Object.values(v)]);
      const companyId: string = rows[0].id;
      const u = await db.query(
        `INSERT INTO users (firm_id, kind, full_name, email) VALUES (app_firm_id(), 'client', $1, $2) RETURNING id`,
        [first.name, first.email]);
      await db.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)', [u.rows[0].id, companyId, firstRole]);
      for (const staffId of staffIds) {
        await db.query(
          `INSERT INTO memberships (user_id, company_id, role)
           SELECT id, $2, staff_role FROM users WHERE id = $1 AND kind = 'firm_staff' AND firm_id = app_firm_id()`, [staffId, companyId]);
      }
      await db.query('SELECT setup_company_books($1, $2, $3)', [companyId, JSON.stringify(CHART_TEMPLATE), new Date().getFullYear()]);
      const token = await newInvite(db, u.rows[0].id);
      return { id: companyId, invite: { userId: u.rows[0].id, name: first.name, email: first.email, token } };
    });
  });

  app.post<{ Params: { id: string }; Body: { company?: Record<string, unknown> } }>('/api/admin/companies/:id', async (req) => {
    const id = uuidParam(req.params.id);
    return admin(req, async (db) => {
      const cur = await db.query('SELECT country FROM companies WHERE id = $1 AND firm_id = app_firm_id()', [id]);
      if (!cur.rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
      const v = companyValues(req.body?.company ?? {}, cur.rows[0].country);
      const cols = Object.keys(v);
      await db.query(
        `UPDATE companies SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...Object.values(v)]);
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string }; Body: { active?: boolean } }>('/api/admin/companies/:id/status', async (req) => {
    const id = uuidParam(req.params.id);
    return admin(req, async (db) => {
      const { rowCount } = await db.query('UPDATE companies SET status = $2 WHERE id = $1 AND firm_id = app_firm_id()',
        [id, req.body?.active ? 'active' : 'suspended']);
      if (!rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; email?: string; role?: string } }>('/api/admin/companies/:id/users', async (req) => {
    const id = uuidParam(req.params.id);
    const p = person(req.body);
    const role = CLIENT_ROLES.includes(String(req.body?.role)) ? String(req.body?.role) : 'client_accountant';
    return admin(req, async (db) => {
      const c = await db.query('SELECT 1 FROM companies WHERE id = $1 AND firm_id = app_firm_id()', [id]);
      if (!c.rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
      const u = await db.query(
        `INSERT INTO users (firm_id, kind, full_name, email) VALUES (app_firm_id(), 'client', $1, $2) RETURNING id`, [p.name, p.email]);
      await db.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)', [u.rows[0].id, id, role]);
      return { invite: { userId: u.rows[0].id, name: p.name, email: p.email, token: await newInvite(db, u.rows[0].id) } };
    });
  });

  app.post<{ Params: { id: string }; Body: { userId?: string; assigned?: boolean } }>('/api/admin/companies/:id/staff', async (req) => {
    const id = uuidParam(req.params.id);
    const userId = uuidParam(String(req.body?.userId ?? ''));
    return admin(req, async (db) => setAssignment(db, userId, id, Boolean(req.body?.assigned)));
  });

  // ------------------------------------------------------------ firm staff
  app.get('/api/admin/staff', async (req) => admin(req, async (db) => (await db.query(
    `SELECT u.id, u.full_name AS name, u.email, u.staff_role AS role, u.status,
            (u.totp_enabled_at IS NOT NULL) AS "twoFactor", (u.invite_expires_at > now()) AS "invitePending",
            (u.password_hash IS NOT NULL) AS "passwordSet",
            (SELECT coalesce(json_agg(m.company_id), '[]') FROM memberships m WHERE m.user_id = u.id) AS "clientIds",
            (SELECT coalesce(json_agg(c.name ORDER BY c.name), '[]') FROM memberships m JOIN companies c ON c.id = m.company_id
               WHERE m.user_id = u.id) AS clients
     FROM users u WHERE u.firm_id = app_firm_id() AND u.kind = 'firm_staff' ORDER BY u.full_name`)).rows));

  app.post<{ Body: { name?: string; email?: string; role?: string; clientIds?: string[] } }>('/api/admin/staff', async (req) => {
    const p = person(req.body);
    const role = String(req.body?.role ?? '');
    if (!STAFF_ROLES.includes(role)) throw new HttpError(400, 'Choose the role.', 'err.role');
    const clientIds = (req.body?.clientIds ?? []).map((x) => uuidParam(String(x)));
    return admin(req, async (db) => {
      const u = await db.query(
        `INSERT INTO users (firm_id, kind, full_name, email, staff_role) VALUES (app_firm_id(), 'firm_staff', $1, $2, $3) RETURNING id`,
        [p.name, p.email, role]);
      for (const cid of clientIds) await setAssignment(db, u.rows[0].id, cid, true);
      return { invite: { userId: u.rows[0].id, name: p.name, email: p.email, token: await newInvite(db, u.rows[0].id) } };
    });
  });

  // ------------------------------------------------------------ any user in the firm
  app.post<{ Params: { id: string }; Body: { active?: boolean } }>('/api/admin/users/:id/status', async (req) => {
    const id = uuidParam(req.params.id);
    if (id === req.userId) throw new HttpError(400, 'You cannot suspend yourself.', 'err.selfSuspend');
    return admin(req, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE users SET status = $2 WHERE id = $1 AND firm_id = app_firm_id() AND kind <> 'admin'`,
        [id, req.body?.active ? 'active' : 'suspended']);
      if (!rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/invite', async (req) => {
    const id = uuidParam(req.params.id);
    return admin(req, async (db) => {
      const { rows } = await db.query(`SELECT full_name AS name, email, status FROM users WHERE id = $1 AND firm_id = app_firm_id()`, [id]);
      if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
      if (rows[0].status !== 'active') throw new HttpError(400, 'Reactivate this person first.', 'err.inviteSuspended');
      return { invite: { userId: id, name: rows[0].name, email: rows[0].email, token: await newInvite(db, id) } };
    });
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-two-factor', async (req) => {
    const id = uuidParam(req.params.id);
    return admin(req, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1 AND firm_id = app_firm_id()`, [id]);
      if (!rowCount) throw new HttpError(404, 'Not found.', 'err.notFound');
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ activity log
  app.get('/api/admin/activity', async (req) => admin(req, async (db) => {
    const { rows } = await db.query('SELECT * FROM admin_activity(300)');
    const names = new Map<string, string>((await db.query(
      `SELECT id, full_name FROM users WHERE firm_id = app_firm_id()`)).rows.map((r) => [r.id, r.full_name]));
    return rows.map((r) => {
      const before = r.detail.before ?? {};
      const after = r.detail.after ?? r.detail.row ?? {};
      const changed = (k: string) => JSON.stringify(before[k]) !== JSON.stringify(after[k]);
      const params: Record<string, string> = {};
      let key = 'act.other';
      if (r.table_name === 'companies') {
        params.client = after.name;
        key = r.action === 'insert' ? 'act.clientAdded'
          : changed('status') ? (after.status === 'active' ? 'act.clientReactivated' : 'act.clientSuspended')
          : 'act.clientUpdated';
      } else if (r.table_name === 'users') {
        params.name = after.full_name;
        if (r.action === 'insert') { key = 'act.userAdded'; params.role = after.staff_role ?? (after.kind === 'client' ? 'client' : after.kind); }
        else if (changed('status')) key = after.status === 'active' ? 'act.userReactivated' : 'act.userSuspended';
        else if (changed('password_set_at')) key = 'act.passwordSet';
        else if (changed('totp_enabled_at')) key = after.totp_enabled_at ? 'act.twoFactorOn' : 'act.twoFactorReset';
        else if (changed('invite_expires_at') && after.invite_expires_at) key = 'act.inviteSent';
        else key = 'act.userUpdated';
      } else if (r.table_name === 'memberships') {
        params.name = names.get(after.user_id) ?? '—';
        params.client = r.company ?? '—';
        params.role = after.role;
        key = r.action === 'delete' ? 'act.accessRemoved' : 'act.accessGiven';
      } else if (r.table_name === 'firms') {
        params.name = after.name;
        key = r.action === 'insert' ? 'act.firmCreated' : 'act.firmRenamed';
      }
      return { id: String(r.id), at: r.at, actor: r.actor, key, params };
    });
  }));

  // ------------------------------------------------------------ settings
  app.get('/api/admin/settings', async (req) => admin(req, async (db) => {
    const firm = await db.query('SELECT name FROM firms WHERE id = app_firm_id()');
    const users = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE status = 'active' AND totp_enabled_at IS NOT NULL)::int AS "twoFactor",
              count(*) FILTER (WHERE status = 'active' AND invite_expires_at > now())::int AS "invitesPending",
              count(*) FILTER (WHERE status = 'active' AND password_hash IS NULL)::int AS "neverSignedIn"
       FROM users WHERE firm_id = app_firm_id()`);
    return { firmName: firm.rows[0]?.name ?? '', users: users.rows[0] };
  }));

  app.post<{ Body: { firmName?: string } }>('/api/admin/settings', async (req) => {
    const name = String(req.body?.firmName ?? '').trim();
    if (!name) throw new HttpError(400, 'Enter the firm name.', 'err.firmName');
    return admin(req, async (db) => {
      await db.query('UPDATE firms SET name = $1 WHERE id = app_firm_id()', [name.slice(0, 200)]);
      return { ok: true };
    });
  });
}

async function setAssignment(db: Db, userId: string, companyId: string, assigned: boolean) {
  const u = await db.query(
    `SELECT staff_role FROM users WHERE id = $1 AND kind = 'firm_staff' AND firm_id = app_firm_id()`, [userId]);
  const c = await db.query('SELECT 1 FROM companies WHERE id = $1 AND firm_id = app_firm_id()', [companyId]);
  if (!u.rows[0] || !c.rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
  if (assigned) {
    await db.query(
      `INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, company_id) DO NOTHING`,
      [userId, companyId, u.rows[0].staff_role]);
  } else {
    await db.query('DELETE FROM memberships WHERE user_id = $1 AND company_id = $2', [userId, companyId]);
  }
  return { ok: true };
}
