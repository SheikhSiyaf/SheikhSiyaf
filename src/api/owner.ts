// Platform owner (the seller of Nusuh Books): customer accounts (accounting firms and companies that run their own
// books) and their first Administrator. The owner adds companies by working inside a customer's Administrator console
// (header x-acting-tenant); like an Administrator, the owner never sees books.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { signDemoToken } from '../demo/demoLink.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { baseUrl, uuidParam, type Ctx } from './context.js';
import { companyValues, insertCompany, newInvite, person, setupCompanyBooks, text } from './admin.js';

/** The job titles every customer starts with (db/migrations/0062_department_roles.sql); a new company's people are given one. */
/** The one kind of person in a company's people list who is not a job title: the separate Administrator login. */
export const ADMINISTRATOR = 'Administrator';
export const COMPANY_JOB_TITLES = ['Owner', 'Finance', 'Sales', 'Commercial', 'Client accountant', 'Client management'] as const;

async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function registerOwnerRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const owner = <T>(req: Parameters<Ctx['as']>[0], fn: (db: Db) => Promise<T>) => as(req, async (db) => { await requireOwner(db); return fn(db); });

  app.get('/api/owner/tenants', async (req) => owner(req, async (db) => (await db.query(
    `SELECT id, name, kind, status, created_at AS "createdAt", companies, users, admins, removed_at AS "removedAt" FROM owner_tenants()`)).rows));

  /** A new customer with its first Administrator; returns the Administrator's sign-in link token. */
  app.post<{ Body: { name?: string; kind?: string; adminName?: string; adminEmail?: string } }>('/api/owner/tenants', async (req) => {
    const name = String(req.body?.name ?? '').trim(), adminName = String(req.body?.adminName ?? '').trim(), adminEmail = String(req.body?.adminEmail ?? '').trim();
    if (!name) throw new HttpError(400, 'Enter the customer\'s name.', 'err.tenantName');
    if (req.body?.kind !== 'firm' && req.body?.kind !== 'company') throw new HttpError(400, 'Choose an accounting firm or a company.', 'err.tenantKind');
    if (!adminName || !EMAIL.test(adminEmail)) throw new HttpError(400, 'Enter the Administrator\'s name and email.', 'err.nameEmail');
    return owner(req, async (db) => {
      const id = (await db.query('SELECT owner_create_tenant($1, $2) AS id', [name, req.body!.kind])).rows[0].id as string;
      await db.query("SELECT set_config('app.acting_firm', $1, true)", [id]);   // work inside the new customer for the rest
      const u = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'admin', $2, $3) RETURNING id`, [id, adminName, adminEmail])).rows[0].id;
      return { id, invite: { userId: u, name: adminName, email: adminEmail, token: await newInvite(db, u, baseUrl(req, opts)) } };
    });
  });

  /**
   * "Company own accounts": ONE customer with ONE company, created in a single save with its people. Nothing here asks for
   * more companies: that belongs to accounting firms only. Everything happens in one database transaction, so either the
   * customer, its company, its books and all its people exist, or nothing does. There are two kinds of person: the
   * Administrator (at least one) manages the company's users, job titles and access, raises issues with Nusuh Books and
   * never sees the books; the others use the books, and each has one job title that sets what they can open.
   */
  app.post<{ Body: { company?: Record<string, unknown>; users?: { name?: string; email?: string; jobTitle?: string }[] } }>('/api/owner/customers/company', async (req) => {
    const c = req.body?.company ?? {};
    const country = text(c, 'country') ?? '';
    const v = companyValues(c, country);
    const name = v.name;
    if (!name) throw new HttpError(400, 'Enter the company name.', 'err.tenantName');
    const raw = Array.isArray(req.body?.users) ? req.body!.users! : [];
    if (!raw.length) throw new HttpError(400, 'Add the Administrator and at least one person who will use the books.', 'err.companyUsers');
    const people = raw.map((u) => {
      const p = person(u as Record<string, unknown>);
      const title = String(u?.jobTitle ?? '');
      if (title !== ADMINISTRATOR && !(COMPANY_JOB_TITLES as readonly string[]).includes(title)) throw new HttpError(400, 'Choose a job title for each person.', 'err.roleChoose');
      return { ...p, title };
    });
    if (new Set(people.map((p) => p.email.toLowerCase())).size !== people.length) throw new HttpError(400, 'Each person needs a different email.', 'err.sameEmail');
    if (!people.some((p) => p.title === ADMINISTRATOR)) throw new HttpError(400, 'Add an Administrator: the person who manages the company\'s users, roles and permissions.', 'err.companyAdmin');
    if (!people.some((p) => p.title !== ADMINISTRATOR)) throw new HttpError(400, 'Add at least one person who will use the books (for example the Owner).', 'err.companyUsers');
    return owner(req, async (db) => {
      const customerId = (await db.query('SELECT owner_create_tenant($1, $2) AS id', [name, 'company'])).rows[0].id as string;
      await db.query("SELECT set_config('app.acting_firm', $1, true)", [customerId]);   // work inside the new customer for the rest
      const titles = new Map((await db.query(`SELECT name, id, default_for FROM client_roles WHERE firm_id = app_firm_id() AND status = 'active'`)).rows.map((r) => [r.name as string, r]));
      const companyId = await insertCompany(db, country, v);
      const invites = [];
      // the company's first user of the books must exist in this same transaction (a deferred database rule), so books people go first
      for (const p of [...people.filter((x) => x.title !== ADMINISTRATOR), ...people.filter((x) => x.title === ADMINISTRATOR)]) {
        const isAdmin = p.title === ADMINISTRATOR;
        const t = isAdmin ? undefined : titles.get(p.title);
        if (!isAdmin && !t) throw new HttpError(500, 'Something went wrong. Please try again.', 'err.server');
        const u = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES (app_firm_id(), $1, $2, $3) RETURNING id`, [isAdmin ? 'admin' : 'client', p.name, p.email])).rows[0].id as string;
        if (t) await db.query('INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, $3, $4)', [u, companyId, t.default_for ?? 'client_accountant', t.id]);
        invites.push({ userId: u, name: p.name, email: p.email, jobTitle: p.title, token: await newInvite(db, u, baseUrl(req, opts)) });
      }
      await setupCompanyBooks(db, companyId);
      return { id: customerId, companyId, invites };
    });
  });

  /** The platform owner's Demo mode button: a short-lived signed link to the demo site (src/demo/demoLink.ts). */
  app.get('/api/owner/demo-link', async (req) => owner(req, async () => {
    const d = opts.demoLink;
    // No separate demo site: open the built-in preview (sample data held in the browser page, no database) when this build has it.
    if (!d && opts.staticDir && existsSync(path.join(opts.staticDir, 'preview', 'index.html'))) return { url: '/preview/index.html', minutes: 0 };
    if (!d) throw new HttpError(400, 'The demo site is not set up yet. Ask your developer to finish the demo site settings.', 'err.demoNotSet');
    return { url: `${d.url.replace(/\/+$/, '')}/demo?t=${signDemoToken(d.secret, 'link', 900)}`, minutes: 15 };
  }));

  app.post<{ Params: { id: string }; Body: { name?: string; status?: string } }>('/api/owner/tenants/:id', async (req) => owner(req, async (db) => {
    await db.query('SELECT owner_update_tenant($1, $2, $3)', [uuidParam(req.params.id), String(req.body?.name ?? ''), String(req.body?.status ?? 'active')]);
    return { ok: true };
  }));

  /**
   * Remove a customer from the owner's list, or restore it. Its books and history are never deleted (posted entries and the
   * audit log are permanent): removing locks everyone out, cancels the subscription and hides it; restoring undoes the lock.
   */
  app.post<{ Params: { id: string }; Body: { removed?: boolean } }>('/api/owner/tenants/:id/remove', async (req) => owner(req, async (db) => {
    await db.query('SELECT owner_remove_tenant($1, $2)', [uuidParam(req.params.id), req.body?.removed !== false]);
    return { ok: true };
  }));

  /** Another Administrator for a customer (for example when theirs has left). */
  app.post<{ Params: { id: string }; Body: { name?: string; email?: string } }>('/api/owner/tenants/:id/admins', async (req) => owner(req, async (db) => {
    const id = uuidParam(req.params.id);
    const name = String(req.body?.name ?? '').trim(), email = String(req.body?.email ?? '').trim();
    if (!name || !EMAIL.test(email)) throw new HttpError(400, 'Enter the Administrator\'s name and email.', 'err.nameEmail');
    await db.query("SELECT set_config('app.acting_firm', $1, true)", [id]);
    if ((await db.query('SELECT app_firm_id() AS f')).rows[0].f !== id) throw new HttpError(404, 'Not found.', 'err.notFound');
    const u = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'admin', $2, $3) RETURNING id`, [id, name, email])).rows[0].id;
    return { invite: { userId: u, name, email, token: await newInvite(db, u, baseUrl(req, opts)) } };
  }));
}
