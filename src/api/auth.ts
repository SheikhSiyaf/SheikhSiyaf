import { baseUrl, encryptionKeyOf } from './context.js';
// Sign-in, two-factor, invitations and the signed-in person's own account.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import { HttpError } from './errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { accessForUser } from '../books/trialService.js';
import { clearedCookie, sessionCookie, signSession, signToken, verifyToken } from '../auth/session.js';
import { newTotpSecret, otpauthUri, totpStep } from '../auth/totp.js';
import { decryptSecret, encryptSecret } from '../auth/secretBox.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../db/demoData.js';
import { LOGIN_LIMITS, Throttle, accountKey } from '../auth/throttle.js';
import * as E from '../books/emailService.js';
import { emailChangeConfirm, emailChangedAlert } from '../email/templates.js';
import { randomBytes } from 'node:crypto';
import { googleAvailable, registerGoogleRoutes } from './google.js';

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
  const key = encryptionKeyOf(opts);
  // Never in production, whatever was passed (the server also refuses to start with DEMO_LOGINS=true there).
  const demo = Boolean(opts.demoLogins) && !opts.production;
  /** The sign-in cookie carries the person's current session version (db/migrations/0053). */
  const sessionFor = async (userId: string) => {
    const v = (await pool.query('SELECT session_version_of($1) AS v', [userId])).rows[0]?.v;
    if (v === null || v === undefined) throw new HttpError(403, 'This account is suspended. Contact the Administrator.', 'err.suspended');
    pool.query('SELECT record_login($1)', [userId]).catch(() => {});   // best effort: the owner's Trials view shows when somebody last signed in
    return sessionCookie(signSession(opts.sessionSecret, userId, Number(v)), secure);
  };
  /** A code from the person's authenticator, accepted once (the same code again is refused). */
  const useCode = async (userId: string, secret: string, code: string) => {
    const step = totpStep(secret, code);
    return step !== null && Boolean((await pool.query('SELECT totp_use($1, $2) AS ok', [userId, step])).rows[0].ok);
  };

  app.get('/api/config', async () => ({
    demoLogins: demo,
    demoSite: Boolean(opts.demoSite),
    demoPassword: demo ? DEMO_PASSWORD : undefined,
    minPassword: MIN_PASSWORD,
    publicUrl: opts.publicUrl || '',
    googleClientId: googleAvailable(opts.google) ? opts.google!.clientId : undefined,   // public by design: it only says which app asks Google
  }));
  registerGoogleRoutes(app, ctx, sessionFor);

  app.get('/api/demo-users', async () => {
    if (!demo) throw new HttpError(404, 'Not found.', 'err.notFound');
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
    // A customer closed after an unpaid trial, past its export window, cannot sign in at all.
    if ((await accessForUser(pool, u.id, opts.now?.())).level === 'closed') throw new HttpError(403, 'This account is closed. Contact Nusuh Books.', 'err.accountClosed');
    await accounts.clear(email);
    if (u.totp_secret_enc) {
      return { twoFactor: true, ticket: signToken(opts.sessionSecret, 'mfa', b64(`${u.id}:${email}`), 300) };
    }
    reply.header('set-cookie', await sessionFor(u.id));
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
      good = Boolean(u && u.id === userId && u.totp_secret_enc && await useCode(userId, decryptSecret(key, u.totp_secret_enc), String(req.body?.code ?? '')));
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
    reply.header('set-cookie', await sessionFor(userId));
    return { ok: true };
  });

  // Signing out ends every sign-in of this person (all devices), not only this browser's cookie.
  app.post('/api/logout', async (req, reply) => {
    if (req.userId) await as(req, (db) => db.query('SELECT end_own_sessions()')).catch(() => undefined);
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
    // A client user of a company that runs its own books may manage its users and job titles (db/migrations/0063).
    const canManageUsers = user.kind === 'client' && (await db.query('SELECT app_is_admin() AS a')).rows[0].a === true;
    const access = user.kind === 'owner' ? (await db.query('SELECT my_staff_access() AS a')).rows[0].a : undefined;   // the staff role and what it may open
    return { user, companies: user.kind === 'admin' || user.kind === 'owner' ? [] : companies.rows, canManageUsers, access };
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

  // Replacing an authenticator already in use needs a code from it, so a borrowed or stolen session cannot swap it.
  app.post<{ Body: { ticket?: string; code?: string; currentCode?: string } }>('/api/me/two-factor/confirm', async (req, reply) => {
    const payload = verifyToken(opts.sessionSecret, 'totp-setup', req.body?.ticket);
    const [userId, secret] = payload ? (unb64(payload).split(':') as [string, string]) : [];
    if (!userId || userId !== req.userId || !secret) throw new HttpError(400, 'Start the set-up again: it timed out.', 'err.ticket');
    const current = (await as(req, (db) => db.query('SELECT totp_secret_enc FROM users WHERE id = app_user_id()'))).rows[0]?.totp_secret_enc as string | null;
    if (current) {
      await codes.check(userId);
      let good = false;
      try { good = await useCode(userId, decryptSecret(key, current), String(req.body?.currentCode ?? '')); } catch { good = false; }
      if (!good) {
        await codes.fail(userId);
        throw new HttpError(400, 'Enter the current code from the authenticator app you use now.', 'err.currentCode');
      }
      await codes.clear(userId);
    }
    const step = totpStep(secret, String(req.body?.code ?? ''));
    if (step === null) throw new HttpError(400, 'That code is not right. Use the latest code from your authenticator app.', 'err.code');
    await as(req, (db) => db.query('SELECT set_own_totp($1)', [encryptSecret(key, secret)]));
    await pool.query('SELECT totp_use($1, $2)', [userId, step]);   // the code that turned it on is used up too
    // The new secret ends every older sign-in (0053); this browser gets a fresh cookie.
    reply.header('set-cookie', await sessionFor(userId));
    return { ok: true };
  });

  // -------------------------------------------------------------- your own sign-in email
  // The sign-in email is the account. It changes only through a link sent to the NEW address, after the person proves who
  // they are (password, and the two-factor code when it is on). A changed sign-in email ends every older sign-in.
  app.get('/api/me/email-settings', async (req) => as(req, async (db) => {
    const r = (await db.query('SELECT * FROM own_email_settings()')).rows[0];
    if (!r) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    const pending = (await db.query('SELECT purpose, new_email AS "newEmail", expires_at AS "expiresAt" FROM own_pending_email_changes()')).rows;
    const tf = (await db.query('SELECT (totp_enabled_at IS NOT NULL) AS t FROM users WHERE id = app_user_id()')).rows[0]?.t === true;
    return { email: r.email, backupEmail: r.kind === 'owner' ? r.backup_email : null, backupVerified: r.kind === 'owner' ? r.backup_verified : false, kind: r.kind, twoFactor: tf, pending };
  }));

  app.post<{ Body: { purpose?: string; newEmail?: string; password?: string; code?: string } }>('/api/me/email-change', async (req) => {
    const purpose = req.body?.purpose === 'backup' ? 'backup' : req.body?.purpose === 'main' ? 'main' : null;
    const newEmail = String(req.body?.newEmail ?? '').trim().toLowerCase();
    if (!purpose) throw new HttpError(400, 'Choose which email to change.', 'err.format');
    if (!E.EMAIL.test(newEmail)) throw new HttpError(400, 'Enter a valid email address.', 'err.email');
    const me = (await as(req, (db) => db.query('SELECT u.id, u.email, u.full_name AS name, u.firm_id AS "firmId", u.kind FROM users u WHERE u.id = app_user_id() AND u.status = \'active\''))).rows[0];
    if (!me) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    if (purpose === 'backup' && me.kind !== 'owner') throw new HttpError(403, 'Only the platform owner has a backup email.', 'err.backupOwnerOnly');
    // Proof of identity: the password (counted like a sign-in, so it cannot be guessed here) and the two-factor code when it is on.
    const acct = accountKey(me.email);
    await accounts.check(acct);
    const a = (await pool.query('SELECT id, password_hash, totp_secret_enc FROM auth_user_by_email($1)', [me.email])).rows[0];
    if (!a || !(await verifyPassword(String(req.body?.password ?? ''), a.password_hash))) {
      await accounts.fail(acct);
      throw new HttpError(401, 'The password is not right.', 'err.passwordWrong');
    }
    if (a.totp_secret_enc) {
      await codes.check(me.id);
      let good = false;
      try { good = await useCode(me.id, decryptSecret(key, a.totp_secret_enc), String(req.body?.code ?? '')); } catch { good = false; }
      if (!good) { await codes.fail(me.id); throw new HttpError(400, 'Enter the current code from your authenticator app.', 'err.currentCode'); }
      await codes.clear(me.id);
    }
    await accounts.clear(acct);
    const token = randomBytes(32).toString('base64url');
    await as(req, (db) => db.query('SELECT * FROM email_change_request($1, $2, $3)', [purpose, newEmail, hashInviteToken(token)]));
    // The link goes to the NEW address: only someone who can read it can finish the change.
    await E.queue(pool, { firmId: me.firmId, kind: 'notice', to: newEmail, toName: me.name, mail: emailChangeConfirm(me.name, purpose, newEmail, `${baseUrl(req, opts)}/confirm-email/${token}`) });
    return { ok: true, sentTo: newEmail };
  });

  // The link in the email. Opening it only shows what it would do; pressing the button confirms (so a mail scanner that
  // opens links cannot confirm by itself).
  app.get<{ Params: { token: string } }>('/api/email-change/:token', async (req) => {
    const r = (await pool.query('SELECT purpose, new_email AS "newEmail" FROM email_change_info($1)', [hashInviteToken(req.params.token)])).rows[0];
    if (!r) throw new HttpError(404, 'This link has expired or was already used. Ask for a new one from Settings.', 'err.changeLinkInvalid');
    return r;
  });
  app.post<{ Params: { token: string } }>('/api/email-change/:token', async (req) => {
    const r = (await pool.query('SELECT * FROM email_change_confirm($1)', [hashInviteToken(req.params.token)])).rows[0];
    if (!r?.ok) throw new HttpError(404, 'This link has expired or was already used. Ask for a new one from Settings.', 'err.changeLinkInvalid');
    // Tell the old address (and the verified backup) what changed, in case it was not them.
    const alert = emailChangedAlert(r.full_name, r.purpose, r.old_email, r.new_email);
    const to = r.purpose === 'main' ? [r.old_email, r.backup_email] : [r.old_email];
    for (const addr of to.filter((x: string | null): x is string => Boolean(x))) {
      await E.queue(pool, { kind: 'notice', to: addr, toName: r.full_name, mail: alert }).catch(() => undefined);
    }
    return { ok: true, purpose: r.purpose };
  });
}
