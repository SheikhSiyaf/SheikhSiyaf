// Sign in with Google (src/auth/googleToken.ts checks the token; db/migrations/0083 remembers the Google account).
// Off unless GOOGLE_CLIENT_ID is set. An existing person signs in (two-step code still asked for if they have it); a new person is asked for
// their company details and goes through the same sign-up rules as the e-mail way.
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import type { Ctx } from './context.js';
import { sessionCookie, signSession, signToken, verifyToken } from '../auth/session.js';
import { GoogleTokenError, fetchGoogleKeys, googleKeyCache, verifyGoogleToken, type GoogleIdentity } from '../auth/googleToken.js';
import { LOGIN_LIMITS, Throttle } from '../auth/throttle.js';
import { accessForUser } from '../books/trialService.js';
import { googleSignup, signupConfig } from '../books/signupService.js';
import { outsideCallsOff } from '../outside.js';
import { createHash, randomBytes } from 'node:crypto';

/** Is the Google button offered? Only with a Client ID, and (for the real call to Google) only while outside calls are allowed. */
export const googleAvailable = (g: Ctx['opts']['google']) => Boolean(g?.clientId) && (Boolean(g?.fetchKeys) || !outsideCallsOff());

const PROBLEM_KEY: Record<string, [number, string, string]> = {
  bad_token: [401, 'Google sign-in did not work. Please try again.', 'err.googleBad'],
  wrong_app: [401, 'Google sign-in did not work. Please try again.', 'err.googleBad'],
  expired: [401, 'Google sign-in took too long. Please try again.', 'err.googleExpired'],
  wrong_nonce: [401, 'Google sign-in took too long. Please try again.', 'err.googleExpired'],
  email_unverified: [403, 'Google has not confirmed this e-mail address, so we cannot use it.', 'err.googleUnverified'],
  unavailable: [503, 'Google cannot be reached right now. Try again in a minute, or use your e-mail and password.', 'err.googleDown'],
};

export function registerGoogleRoutes(app: FastifyInstance, { pool, opts }: Ctx, sessionFor: (userId: string) => Promise<string>) {
  const g = opts.google;
  const cfg = opts.signup ?? signupConfig({}, opts.sessionSecret);
  const addresses = new Throttle(pool, LOGIN_LIMITS.ip);
  const getKey = googleKeyCache(g?.fetchKeys ?? fetchGoogleKeys);
  const on = () => { if (!g || !googleAvailable(g)) throw new HttpError(404, 'Google sign-in is not switched on.', 'err.googleOff'); return g; };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unb64 = <T>(s: string): T | null => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()) as T; } catch { return null; } };

  /** A one-time value the browser puts into its Google request; Google writes it into the token, and we check it came from us (and is recent). */
  app.get('/api/google/nonce', async () => {
    on();
    return { nonce: signToken(opts.sessionSecret, 'gnonce', randomBytes(16).toString('base64url'), 600) };
  });

  const identityOf = async (credential: unknown, nonce: unknown, ip: string): Promise<GoogleIdentity> => {
    const gg = on();
    await addresses.check(ip);
    try {
      if (typeof nonce !== 'string' || !verifyToken(opts.sessionSecret, 'gnonce', nonce)) throw new GoogleTokenError('wrong_nonce');
      const who = await verifyGoogleToken(credential, { clientId: gg.clientId, nonce, getKey, now: () => (opts.now?.() ?? new Date()).getTime() });
      // each one-time value works for one sign-in only: a captured token cannot be replayed
      if (!(await pool.query('SELECT google_nonce_take($1) AS ok', [createHash('sha256').update(nonce).digest('hex')])).rows[0].ok) throw new GoogleTokenError('wrong_nonce');
      return who;
    } catch (e) {
      if (e instanceof GoogleTokenError) {
        if (e.problem !== 'unavailable') await addresses.fail(ip);
        const [status, message, key] = PROBLEM_KEY[e.problem]!;
        throw new HttpError(status, message, key);
      }
      throw e;
    }
  };

  /** Sign in, or (a new person) get a short-lived ticket for the company step. */
  app.post<{ Body: { credential?: unknown; nonce?: unknown } }>('/api/login/google', async (req, reply) => {
    const who = await identityOf(req.body?.credential, req.body?.nonce, req.ip);
    const r = (await pool.query('SELECT user_id, user_email, outcome FROM google_sign_in_user($1, $2)', [who.sub, who.email])).rows[0];
    if (r.outcome === 'other') throw new HttpError(409, 'This e-mail address is already used with a different Google account. Sign in with your password, or use that Google account.', 'err.googleOther');
    if (r.outcome === 'none') {
      if (!cfg.enabled) throw new HttpError(403, 'Sign-up is not open yet. Write to us and we will set you up.', 'err.signupOff');
      return { needsCompany: true, ticket: signToken(opts.sessionSecret, 'gsignup', b64({ sub: who.sub, email: who.email, name: who.name }), 900), email: who.email, name: who.name };
    }
    const u = (await pool.query('SELECT id, status, totp_secret_enc, firm_status FROM auth_user_by_email($1)', [r.user_email])).rows[0];
    if (!u) throw new HttpError(401, 'Google sign-in did not work. Please try again.', 'err.googleBad');
    if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact the Administrator.', 'err.suspended');
    if (u.firm_status !== 'active') throw new HttpError(403, 'This organisation\'s access is suspended. Contact Nusuh Books.', 'err.tenantSuspended');
    if ((await accessForUser(pool, u.id, opts.now?.())).level === 'closed') throw new HttpError(403, 'This account is closed. Contact Nusuh Books.', 'err.accountClosed');
    if (u.totp_secret_enc) {
      return { twoFactor: true, ticket: signToken(opts.sessionSecret, 'mfa', Buffer.from(`${u.id}:${String(r.user_email).toLowerCase()}`).toString('base64url'), 300) };
    }
    reply.header('set-cookie', await sessionFor(u.id));
    return { ok: true };
  });

  /** The company step of a Google sign-up. The ticket proves Google vouched for the e-mail a few minutes ago. */
  app.post<{ Body: Record<string, unknown> }>('/api/signup/google', async (req, reply) => {
    on();
    if (!cfg.enabled) throw new HttpError(403, 'Sign-up is not open yet. Write to us and we will set you up.', 'err.signupOff');
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    // a hidden field no person fills in: robots do
    if (typeof body.website === 'string' && body.website.trim() !== '') throw new HttpError(400, 'Please check what you entered.', 'err.signupName');
    const payload = verifyToken(opts.sessionSecret, 'gsignup', typeof body.ticket === 'string' ? body.ticket : undefined);
    const who = payload ? unb64<GoogleIdentity>(payload) : null;
    if (!who?.sub || !who.email) throw new HttpError(401, 'Google sign-in took too long. Please try again.', 'err.googleExpired');
    const { userId } = await googleSignup(pool, cfg, who, body, req.ip);
    reply.header('set-cookie', await sessionFor(userId));
    return { ok: true };
  });
}
