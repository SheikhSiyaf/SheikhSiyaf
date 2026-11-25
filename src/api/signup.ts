// Self-service sign-up: the form's settings, the request, the confirmation link, and the owner's record of every attempt.
// Off unless SIGNUP=on. Nothing is created until the e-mail link is opened (src/books/signupService.ts).
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { baseUrl, type Ctx } from './context.js';
import { sessionCookie, signSession } from '../auth/session.js';
import { beginSignup, signupConfig, verifySignup } from '../books/signupService.js';

export function registerSignupRoutes(app: FastifyInstance, { pool, opts, as }: Ctx) {
  const cfg = opts.signup ?? signupConfig({}, opts.sessionSecret);
  const off = () => { if (!cfg.enabled) throw new HttpError(403, 'Sign-up is not open yet. Write to us and we will set you up.', 'err.signupOff'); };

  /** What the sign-up page needs to know: is it open, and is Google sign-in available (not yet). */
  app.get('/api/signup/config', async () => ({ enabled: cfg.enabled, google: false }));

  app.post<{ Body: Record<string, unknown> }>('/api/signup', async (req) => {
    off();
    return beginSignup(pool, cfg, (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>, req.ip, baseUrl(req, opts));
  });

  /** The link in the e-mail. A separate POST (not the page load) so a mail scanner that only opens links cannot use the link up. */
  app.post<{ Body: { token?: unknown } }>('/api/signup/verify', async (req, reply) => {
    off();
    const r = await verifySignup(pool, cfg, req.body?.token, req.ip);
    if (r.outcome !== 'ok') {
      const key = r.outcome === 'expired' ? 'err.signupExpired' : r.outcome === 'used' ? 'err.signupOrgUsed' : 'err.signupBadLink';
      throw new HttpError(400, 'This link is not valid any more. Start again from the sign-up page.', key);
    }
    const v = (await pool.query('SELECT session_version_of($1) AS v', [r.userId])).rows[0]?.v;
    reply.header('set-cookie', sessionCookie(signSession(opts.sessionSecret, r.userId, Number(v)), Boolean(opts.cookieSecure)));
    return { ok: true };
  });

  /** The platform owner: recent sign-up activity, allowed and refused. */
  app.get('/api/owner/signups', async (req) => as(req, async (db) => {
    if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
    const rows = (await db.query('SELECT * FROM owner_signup_activity(300)')).rows;
    return { enabled: cfg.enabled, events: rows.map((r) => ({ id: String(r.id), at: r.at.toISOString(), kind: r.kind, emailDomain: r.email_domain, company: r.company_name, country: r.country, firmId: r.firm_id, flags: r.flags, attempts: r.same_key_attempts, mail: r.mail_status ? { status: r.mail_status, error: r.mail_error, attempts: r.mail_attempts } : null })) };
  }));
}
