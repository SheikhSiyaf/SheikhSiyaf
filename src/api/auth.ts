// Sign-in, two-factor, invitations and the signed-in person's own account.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { HttpError } from './errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { clearedCookie, sessionCookie, signSession, signToken, verifyToken } from '../auth/session.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { decryptSecret, encryptSecret } from '../auth/secretBox.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../db/demoData.js';
import { LOGIN_LIMITS, Throttle, accountKey } from '../auth/throttle.js';

export const MIN_PASSWORD = 10;
export const hashInviteToken = (token: string) => createHash('sha256').update(token).digest('hex');
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString();

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  const { pool, opts, as } = ctx;
  // Counted in the database: per account, per address and per person for two-factor codes (db/migrations/0040).
  const accounts = new Throttle(pool, LOGIN_LIMITS.account);
  const addresses = new Throttle(pool, LOGIN_LIMITS.ip);
  const codes = new Throttle(pool, LOGIN_LIMITS.mfa);
  const secure = Boolean(opts.cookieSecure);
  const key = opts.encryptionKey || opts.sessionSecret;

  app.get('/api/config', async () => ({
    demoLogins: Boolean(opts.demoLogins),
    demoPassword: opts.demoLogins ? DEMO_PASSWORD : undefined,
    minPassword: MIN_PASSWORD,
    publicUrl: opts.publicUrl || '',
  }));

  app.get('/api/demo-users', async () => {
    if (!opts.demoLogins) throw new HttpError(404, 'Not found.', 'err.notFound');
    return DEMO_USERS.map(({ name, email, kind, role, company, clientRole }) => ({ name, email, kind, role, company, clientRole }));
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/login', async (req, reply) => {
    const email = accountKey(String(req.body?.email ?? ''));
    const password = String(req.body?.password ?? '');
    await addresses.check(req.ip);
    await accounts.check(email);
    const { rows } = await pool.query('SELECT id, status, password_hash, totp_secret_enc, firm_status FROM auth_user_by_email($1)', [email]);
    const u = rows[0];
    // Unknown emails are checked against a dummy hash, so they take as long and count the same as a wrong password.
    const ok = await verifyPassword(password, u?.password_hash);
    if (!ok || !u) {
      await accounts.fail(email);
      await addresses.fail(req.ip);
      throw new HttpError(401, 'The email or password is not right.', 'err.login');
    }
    if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact the Administrator.', 'err.suspended');
    if (u.firm_status !== 'active') throw new HttpError(403, 'This organisation\'s access is suspended. Contact Nusuh Books.', 'err.tenantSuspended');
    await accounts.clear(email);
    if (u.totp_secret_enc) {
      return { twoFactor: true, ticket: signToken(opts.sessionSecret, 'mfa', b64(`${u.id}:${email}`), 300) };
    }
    reply.header('set-cookie', sessionCookie(signSession(opts.sessionSecret, u.id), secure));
    return { ok: true };
  });

  app.post<{ Body: { ticket?: string; code?: string } }>('/api/login/two-factor', async (req, reply) => {
    const payload = verifyToken(opts.sessionSecret, 'mfa', req.body?.ticket);
    if (!payload) throw new HttpError(401, 'Sign in again: the code step timed out.', 'err.ticket');
    const [userId, email] = unb64(payload).split(':') as [string, string];
    await addresses.check(req.ip);
    await codes.check(userId);
    const { rows } = await pool.query('SELECT id, status, totp_secret_enc FROM auth_user_by_email($1)', [email]);
    const u = rows[0];
    let good = false;
    try {
      good = Boolean(u && u.id === userId && u.totp_secret_enc && verifyTotp(decryptSecret(key, u.totp_secret_enc), String(req.body?.code ?? '')));
    } catch {
      good = false;
    }
    if (!good) {
      await codes.fail(userId);
      await addresses.fail(req.ip);
      throw new HttpError(401, 'That code is not right. Use the latest code from your authenticator app.', 'err.code');
    }
    if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact the Administrator.', 'err.suspended');
    await codes.clear(userId);
    reply.header('set-cookie', sessionCookie(signSession(opts.sessionSecret, userId), secure));
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', clearedCookie(secure));
    return { ok: true };
  });

  app.get('/api/me', async (req) => as(req, async (db) => {
    const u = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, u.kind, u.staff_role AS "staffRole", u.status,
              (u.totp_enabled_at IS NOT NULL) AS "twoFactor", f.name AS "firmName", f.kind AS "firmKind"
       FROM users u LEFT JOIN firms f ON f.id = u.firm_id WHERE u.id = app_user_id()`);
    const user = u.rows[0];
    if (!user || user.status !== 'active') throw new HttpError(401, 'Please sign in.', 'err.signIn');
    delete user.status;
    const companies = await db.query(
      `SELECT c.id, c.name, c.name_ar AS "nameAr", c.country, c.currency, c.vat_rate AS "vatRate", m.role
       FROM companies c JOIN memberships m ON m.company_id = c.id AND m.user_id = app_user_id()
       WHERE c.status = 'active'
       ORDER BY c.name`);
    return { user, companies: user.kind === 'admin' || user.kind === 'owner' ? [] : companies.rows };
  }));

  // -------------------------------------------------------------- invitations
  app.get<{ Params: { token: string } }>('/api/invite/:token', async (req) => {
    const { rows } = await pool.query('SELECT full_name AS name, email FROM invite_info($1)', [hashInviteToken(req.params.token)]);
    if (!rows[0]) throw new HttpError(404, 'This invitation link has expired or was already used. Ask the Administrator for a new one.', 'err.inviteInvalid');
    return rows[0];
  });

  app.post<{ Params: { token: string }; Body: { password?: string } }>('/api/invite/:token', async (req) => {
    const password = String(req.body?.password ?? '');
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters.`, 'err.passwordShort');
    const { rows } = await pool.query('SELECT accept_invite($1, $2) AS ok', [hashInviteToken(req.params.token), await hashPassword(password)]);
    if (!rows[0].ok) throw new HttpError(404, 'This invitation link has expired or was already used. Ask the Administrator for a new one.', 'err.inviteInvalid');
    return { ok: true };
  });

  // -------------------------------------------------------------- two-factor set-up for yourself
  app.post('/api/me/two-factor/start', async (req) => as(req, async (db) => {
    const { rows } = await db.query('SELECT email FROM users WHERE id = app_user_id()');
    if (!rows[0]) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    const secret = newTotpSecret();
    return {
      secret,
      uri: otpauthUri(secret, rows[0].email),
      ticket: signToken(opts.sessionSecret, 'totp-setup', b64(`${req.userId}:${secret}`), 600),
    };
  }));

  app.post<{ Body: { ticket?: string; code?: string } }>('/api/me/two-factor/confirm', async (req) => {
    const payload = verifyToken(opts.sessionSecret, 'totp-setup', req.body?.ticket);
    const [userId, secret] = payload ? (unb64(payload).split(':') as [string, string]) : [];
    if (!userId || userId !== req.userId || !secret) throw new HttpError(400, 'Start the set-up again: it timed out.', 'err.ticket');
    if (!verifyTotp(secret, String(req.body?.code ?? ''))) throw new HttpError(400, 'That code is not right. Use the latest code from your authenticator app.', 'err.code');
    await as(req, (db) => db.query('SELECT set_own_totp($1)', [encryptSecret(key, secret)]));
    return { ok: true };
  });
}
