// Platform staff (the people of Nusuh Books itself): the Internal users page. Everything is a database function that checks the caller's
// role (db/migrations/0088_staff_roles.sql); this file only carries the request in, sends the invitation, and tells the other Owners.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { baseUrl, uuidParam, type Ctx } from './context.js';
import { randomBytes } from 'node:crypto';
import { hashInviteToken } from './auth.js';
import { queue as queueEmail } from '../books/emailService.js';
import { bilingual, invitation } from '../email/templates.js';

/** A one-time invitation (shown once, e-mailed too; only its hash is kept). Valid for 7 days. */
async function staffInvite(db: Db, userId: string, base: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('SELECT staff_member_invite($1, $2, 7)', [userId, hashInviteToken(token)]);
  const u = (await db.query('SELECT full_name AS name, email FROM staff_members() WHERE id = $1', [userId])).rows[0];
  const firmId = (await db.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0]?.id as string;
  if (u) await queueEmail(db, { firmId, kind: 'invitation', to: u.email, toName: u.name, mail: invitation(u.name, `${base}/invite/${token}`, 'Nusuh Books') });
  return token;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const perms = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 40) : []);

async function overview(db: Db) {
  const people = (await db.query(`SELECT id, full_name AS name, email, status, role_id AS "roleId", role_name AS "roleName", is_full AS "full", is_me AS "me", created_at AS "createdAt" FROM staff_members()`)).rows;
  return { people, ...(await db.query('SELECT staff_roles_list() AS l')).rows[0].l };
}

/** Every other active Owner gets an e-mail about a change to staff or roles, so nothing happens silently. */
async function tellOwners(db: Db, what: { en: string; ar: string }) {
  const me = (await db.query('SELECT full_name AS name FROM users WHERE id = app_user_id()')).rows[0]?.name ?? '';
  const owners = (await db.query(`SELECT id, full_name AS name, email FROM staff_members() WHERE is_full AND status = 'active' AND NOT is_me`)).rows as { name: string; email: string }[];
  const platform = (await db.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0]?.id as string | undefined;
  for (const o of owners) {
    const mail = bilingual('Staff change on Nusuh Books / تغيير في فريق نصوح بوكس',
      [`Hello ${o.name},`, `${me}: ${what.en}`, 'If you did not expect this, sign in and check Internal users now.'],
      [`مرحباً ${o.name}،`, `${me}: ${what.ar}`, 'إن لم تكن تتوقع ذلك، سجّل الدخول وراجع المستخدمين الداخليين الآن.'], 'Nusuh Books');
    await queueEmail(db, { firmId: platform ?? null, kind: 'notice', to: o.email, toName: o.name, mail });
  }
}

export function registerStaffRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  app.get('/api/owner/staff', async (req) => as(req, (db) => overview(db)));

  app.post<{ Body: { name?: unknown; email?: unknown; roleId?: unknown } }>('/api/owner/staff', async (req) => as(req, async (db) => {
    const name = str(req.body?.name, 120), email = str(req.body?.email, 200), role = uuidParam(str(req.body?.roleId, 40));
    const id = (await db.query('SELECT staff_member_add($1, $2, $3) AS id', [name, email, role])).rows[0].id as string;
    const token = await staffInvite(db, id, baseUrl(req, opts));
    const roleName = (await db.query('SELECT role_name FROM staff_members() WHERE id = $1', [id])).rows[0]?.role_name as string;
    await tellOwners(db, { en: `added ${name} (${email}) with the role ${roleName}.`, ar: `أضاف ${name} (${email}) بدور ${roleName}.` });
    return { id, invite: { userId: id, name, email, token } };
  }));

  app.post<{ Params: { id: string }; Body: { name?: unknown; email?: unknown } }>('/api/owner/staff/:id', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id), name = str(req.body?.name, 120), email = str(req.body?.email, 200);
    await db.query('SELECT staff_member_update($1, $2, $3)', [id, name, email]);
    await tellOwners(db, { en: `changed the details of ${name} (${email}).`, ar: `عدّل بيانات ${name} (${email}).` });
    return { ok: true };
  }));

  app.post<{ Params: { id: string }; Body: { roleId?: unknown } }>('/api/owner/staff/:id/role', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    await db.query('SELECT staff_member_set_role($1, $2)', [id, uuidParam(str(req.body?.roleId, 40))]);
    const p = (await db.query('SELECT full_name AS name, role_name AS "roleName" FROM staff_members() WHERE id = $1', [id])).rows[0];
    await tellOwners(db, { en: `changed the role of ${p?.name} to ${p?.roleName}.`, ar: `غيّر دور ${p?.name} إلى ${p?.roleName}.` });
    return { ok: true };
  }));

  app.post<{ Params: { id: string }; Body: { status?: unknown } }>('/api/owner/staff/:id/status', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id), status = str(req.body?.status, 12);
    await db.query('SELECT staff_member_set_status($1, $2)', [id, status]);
    const p = (await db.query('SELECT full_name AS name FROM staff_members() WHERE id = $1', [id])).rows[0];
    await tellOwners(db, status === 'suspended' ? { en: `suspended ${p?.name}.`, ar: `أوقف ${p?.name}.` } : { en: `restored ${p?.name}.`, ar: `أعاد تفعيل ${p?.name}.` });
    return { ok: true };
  }));

  /** A new sign-in link for someone who has not set a password yet (the old link stops working). */
  app.post<{ Params: { id: string } }>('/api/owner/staff/:id/invite', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    const p = (await db.query('SELECT full_name AS name, email FROM staff_members() WHERE id = $1', [id])).rows[0];
    if (!p) throw new HttpError(404, 'Not found.', 'err.notFound');
    const pending = (await db.query('SELECT password_hash IS NULL AS p FROM users WHERE id = $1', [id])).rows[0]?.p;
    if (pending !== true) throw new HttpError(400, 'This person has signed in already.', 'err.staffNoInvite');
    return { invite: { userId: id, name: p.name, email: p.email, token: await staffInvite(db, id, baseUrl(req, opts)) } };
  }));

  app.post<{ Body: { name?: unknown; description?: unknown; permissions?: unknown } }>('/api/owner/staff-roles', async (req) => as(req, async (db) => {
    const name = str(req.body?.name, 60);
    const id = (await db.query('SELECT staff_role_save(NULL, $1, $2, $3) AS id', [name, str(req.body?.description, 300), perms(req.body?.permissions)])).rows[0].id as string;
    await tellOwners(db, { en: `created the role ${name}.`, ar: `أنشأ الدور ${name}.` });
    return { id };
  }));

  app.post<{ Params: { id: string }; Body: { name?: unknown; description?: unknown; permissions?: unknown } }>('/api/owner/staff-roles/:id', async (req) => as(req, async (db) => {
    const name = str(req.body?.name, 60);
    await db.query('SELECT staff_role_save($1, $2, $3, $4)', [uuidParam(req.params.id), name, str(req.body?.description, 300), perms(req.body?.permissions)]);
    await tellOwners(db, { en: `changed what the role ${name} may do.`, ar: `عدّل صلاحيات الدور ${name}.` });
    return { ok: true };
  }));

  app.post<{ Params: { id: string } }>('/api/owner/staff-roles/:id/archive', async (req) => as(req, async (db) => {
    await db.query('SELECT staff_role_archive($1)', [uuidParam(req.params.id)]);
    await tellOwners(db, { en: 'removed a role.', ar: 'حذف دوراً.' });
    return { ok: true };
  }));
}
