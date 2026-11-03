// Platform owner (the seller of Nusuh Books): customer accounts (accounting firms and companies that run their own
// books) and their first Administrator. The owner adds companies by working inside a customer's Administrator console
// (header x-acting-tenant); like an Administrator, the owner never sees books.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import { newInvite } from './admin.js';

async function requireOwner(db: Db) {
  if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function registerOwnerRoutes(app: FastifyInstance, { as }: Ctx) {
  const owner = <T>(req: Parameters<Ctx['as']>[0], fn: (db: Db) => Promise<T>) => as(req, async (db) => { await requireOwner(db); return fn(db); });

  app.get('/api/owner/tenants', async (req) => owner(req, async (db) => (await db.query(
    `SELECT id, name, kind, status, created_at AS "createdAt", companies, users, admins FROM owner_tenants()`)).rows));

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
      return { id, invite: { userId: u, name: adminName, email: adminEmail, token: await newInvite(db, u) } };
    });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; status?: string } }>('/api/owner/tenants/:id', async (req) => owner(req, async (db) => {
    await db.query('SELECT owner_update_tenant($1, $2, $3)', [uuidParam(req.params.id), String(req.body?.name ?? ''), String(req.body?.status ?? 'active')]);
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
    return { invite: { userId: u, name, email, token: await newInvite(db, u) } };
  }));
}
