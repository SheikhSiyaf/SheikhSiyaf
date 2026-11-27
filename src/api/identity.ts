// "Confirm it is you" for sensitive owner actions: the person's own password (counted like a sign-in, so it cannot be guessed here) and, when they
// use an authenticator app, a current code that works once. Same rules as changing an e-mail address (src/api/auth.ts).
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { encryptionKeyOf, type Ctx } from './context.js';
import { verifyPassword } from '../auth/password.js';
import { totpStep } from '../auth/totp.js';
import { decryptSecret } from '../auth/secretBox.js';
import { LOGIN_LIMITS, Throttle, accountKey } from '../auth/throttle.js';

export function identityChecker({ pool, opts, as }: Ctx) {
  const accounts = new Throttle(pool, LOGIN_LIMITS.account);
  const codes = new Throttle(pool, LOGIN_LIMITS.mfa);
  const key = encryptionKeyOf(opts);
  return async (req: FastifyRequest, body: { password?: unknown; code?: unknown } | undefined): Promise<void> => {
    const me = (await as(req, (db) => db.query(`SELECT u.id, u.email FROM users u WHERE u.id = app_user_id() AND u.status = 'active'`))).rows[0] as { id: string; email: string } | undefined;
    if (!me) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    const acct = accountKey(me.email);
    await accounts.check(acct);
    const a = (await pool.query('SELECT id, password_hash, totp_secret_enc FROM auth_user_by_email($1)', [me.email])).rows[0];
    if (!a || !(await verifyPassword(String(body?.password ?? ''), a.password_hash))) {
      await accounts.fail(acct);
      throw new HttpError(401, 'The password is not right.', 'err.passwordWrong');
    }
    if (a.totp_secret_enc) {
      await codes.check(me.id);
      let good = false;
      try {
        const step = totpStep(decryptSecret(key, a.totp_secret_enc), String(body?.code ?? ''));
        good = step !== null && Boolean((await pool.query('SELECT totp_use($1, $2) AS ok', [me.id, step])).rows[0].ok);
      } catch { good = false; }
      if (!good) { await codes.fail(me.id); throw new HttpError(400, 'Enter the current code from your authenticator app.', 'err.currentCode'); }
      await codes.clear(me.id);
    }
    await accounts.clear(acct).catch(() => undefined);
  };
}
