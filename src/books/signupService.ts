// Self-service sign-up (db/migrations/0077_signup.sql, rules in signupRules.ts).
// begin: checks the request, remembers it, e-mails a link. Nothing exists until the link is opened.
// verify: opens the link once, then in ONE transaction makes the customer, its company, its books, its only user (job title Owner, who can
// also manage users) and its 15-day trial. The server does the work as the platform owner would, so the same rules and audit trail apply.
import { intentHash, TERMS_VERSION } from './orderIntent.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { withUser } from '../db/session.js';
import { companyValues, insertCompany, setupCompanyBooks } from '../api/admin.js';
import { hashPassword } from '../auth/password.js';
import { ROLE_MODULES } from './modules.js';
import { saveSubscription } from './billingService.js';
import { queue } from './emailService.js';
import { riyadhDate } from './trialRules.js';
import { SUPPORT } from './trialEmails.js';
import { comparisonForm, isDisposable, normalizeEmail, parseGoogleSignup, parseSignup } from './signupRules.js';

export interface SignupConfig { enabled: boolean; pepper: string }
export const signupConfig = (env: NodeJS.ProcessEnv, fallbackSecret: string): SignupConfig => ({
  enabled: env.SIGNUP === 'on',
  // a secret kept in the host's settings, so a leaked database cannot be used to guess who signed up; the fallback is for development only
  pepper: env.SIGNUP_PEPPER || createHmac('sha256', fallbackSecret).update('signup-pepper').digest('hex'),
});
const keyed = (cfg: SignupConfig, kind: string, value: string) => createHmac('sha256', cfg.pepper).update(`${kind}:${value}`).digest('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function mail(lang: 'en' | 'ar', parts: { enSubject: string; arSubject: string; en: string[]; ar: string[]; link?: string; enButton?: string; arButton?: string }) {
  const ar = lang === 'ar';
  const subject = ar ? parts.arSubject : parts.enSubject, paras = ar ? parts.ar : parts.en;
  const button = ar ? parts.arButton : parts.enButton;
  const foot = ar ? `هل تحتاج مساعدة؟ راسلنا على ${SUPPORT.email} أو اتصل على ${SUPPORT.phone}.` : `Questions? Write to ${SUPPORT.email} or call ${SUPPORT.phone}.`;
  const text = [...paras, ...(parts.link ? [parts.link] : []), foot, '— Nusuh Books'].join('\n\n');
  const html = `<!doctype html><html dir="${ar ? 'rtl' : 'ltr'}"><body style="font-family:Segoe UI,Tahoma,Arial,sans-serif;color:#14213d;line-height:1.6;max-width:600px">${paras.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('')}${parts.link && button ? `<p style="margin:18px 0"><a href="${esc(parts.link)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">${esc(button)}</a></p><p style="font-size:12px;color:#5b6b7b;word-break:break-all">${esc(parts.link)}</p>` : ''}<p style="color:#5b6b7b;font-size:13px">${esc(foot)}</p><p style="color:#5b6b7b">— Nusuh Books</p></body></html>`;
  return { subject, text, html };
}

export type BeginResult = { status: 'sent' };
/** Takes a sign-up request. The answer is the same whether or not the address already has an account (nobody can use this form to find out who is a customer). */
export async function beginSignup(pool: pg.Pool, cfg: SignupConfig, body: Record<string, unknown>, ip: string, appUrl: string): Promise<BeginResult> {
  const ipKey = keyed(cfg, 'ip', ip || 'unknown');
  // a hidden field no person fills in: robots do. They are told "sent" and nothing happens.
  if (typeof body.website === 'string' && body.website.trim() !== '') { await pool.query('SELECT signup_log_event($1, NULL, NULL, NULL, NULL, $2)', ['honeypot', ipKey]); return { status: 'sent' }; }
  const parsed = parseSignup(body);
  if (!parsed.ok) {
    if (parsed.problem === 'err.signupDisposable' || parsed.problem === 'err.signupPassword') {
      const e = typeof body.email === 'string' ? body.email.toLowerCase().slice(0, 254) : null;
      await pool.query('SELECT signup_log_event($1, $2, NULL, NULL, NULL, $3)', [parsed.problem === 'err.signupDisposable' ? 'blocked_disposable' : 'blocked_password', e, ipKey]).catch(() => undefined);
    }
    throw new HttpError(400, 'Please check what you entered.', parsed.problem);
  }
  const v = parsed.value;
  if (isDisposable(v.email)) throw new HttpError(400, 'Please use your work e-mail address.', 'err.signupDisposable');
  const passwordHash = await hashPassword(v.password);   // always done, so a refused request takes as long as an accepted one
  const token = randomBytes(32).toString('base64url');
  const emailKey = keyed(cfg, 'email', comparisonForm(v.email));
  const crKey = keyed(cfg, 'cr', `${v.country}:${v.crNumber.toUpperCase()}`);
  const outcome = (await pool.query('SELECT signup_begin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r',
    [v.email, emailKey, crKey, v.fullName, v.companyName, v.country, v.crNumber, passwordHash, sha(token), ipKey, v.lang, v.city])).rows[0].r as string;
  if (outcome === 'org_used') throw new HttpError(409, 'This company already has an account or a trial.', 'err.signupOrgUsed');
  if (outcome === 'throttled') throw new HttpError(429, 'Too many requests. Wait a few minutes and try again.', 'err.tooMany');
  if (outcome === 'quiet') return { status: 'sent' };
  const base = appUrl.replace(/\/+$/, '');
  if (outcome === 'sent') {
    const link = `${base}/verify/${token}`;
    const id1 = await queue(pool, { kind: 'signup', to: v.email, toName: v.fullName, replyTo: SUPPORT.email, mail: mail(v.lang, {
      enSubject: 'Confirm your e-mail to start your Nusuh Books free trial', arSubject: 'أكّد بريدك الإلكتروني لبدء تجربتك المجانية في نصوح بوكس',
      en: [`Hello ${v.fullName},`, `Thank you for choosing Nusuh Books. Confirm your e-mail address to create ${v.companyName} and start your 15-day free trial. The link works once and for 24 hours.`, 'If you did not ask for this, you can ignore this e-mail: nothing is created until the link is opened.'],
      ar: [`مرحبًا ${v.fullName}،`, `شكرًا لاختيارك نصوح بوكس. أكّد بريدك الإلكتروني لإنشاء ${v.companyName} وبدء تجربتك المجانية لمدة 15 يومًا. الرابط يعمل مرة واحدة ولمدة 24 ساعة.`, 'إذا لم تطلب ذلك فتجاهل هذه الرسالة: لا يُنشأ شيء قبل فتح الرابط.'],
      link, enButton: 'Confirm my e-mail', arButton: 'تأكيد بريدي الإلكتروني' }) });
    await pool.query('SELECT signup_mail_log($1, $2)', [emailKey, id1]);
  } else {   // email_used: tell the owner of the mailbox, without saying anything on the screen
    const id2 = await queue(pool, { kind: 'signup', to: v.email, toName: v.fullName, replyTo: SUPPORT.email, mail: mail(v.lang, {
      enSubject: 'You already have a Nusuh Books account', arSubject: 'لديك حساب في نصوح بوكس بالفعل',
      en: [`Hello,`, 'Someone (we hope you) tried to start a free trial with this e-mail address, but it already has a Nusuh Books account or has already used its free trial.', 'Sign in, or use "Forgot password" on the sign-in page if you do not remember your password. To talk about your account, write to us.'],
      ar: ['مرحبًا،', 'حاول شخص (نأمل أنك أنت) بدء تجربة مجانية بهذا البريد الإلكتروني، لكن لديه حساب في نصوح بوكس بالفعل أو استخدم تجربته المجانية سابقًا.', 'سجّل الدخول، أو استخدم «نسيت كلمة المرور» في صفحة الدخول إن لم تتذكرها. وللحديث عن حسابك راسلنا.'],
      link: `${base}/`, enButton: 'Go to sign in', arButton: 'الذهاب إلى تسجيل الدخول' }) });
    await pool.query('SELECT signup_mail_log($1, $2)', [emailKey, id2]);
  }
  if (outcome === 'sent') await pool.query('SELECT signup_attach_meta($1, $2, $3)', [emailKey, intentHash(body.intent), TERMS_VERSION]).catch(() => undefined);   // never lets a problem here stop the sign-up
  return { status: 'sent' };
}

export type VerifyResult = { outcome: 'ok'; userId: string; firmId: string; companyId: string } | { outcome: 'bad' | 'expired' | 'used' };
export async function verifySignup(pool: pg.Pool, cfg: SignupConfig, token: unknown, ip: string): Promise<VerifyResult> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) { await pool.query('SELECT signup_log_event($1, NULL, NULL, NULL, NULL, $2)', ['bad_token', keyed(cfg, 'ip', ip || 'unknown')]).catch(() => undefined); return { outcome: 'bad' }; }
  const ownerId = (await pool.query('SELECT signup_platform_owner() AS id')).rows[0].id as string | null;
  if (!ownerId) throw new HttpError(500, 'Something went wrong. Please try again.', 'err.server');
  const ipKey = keyed(cfg, 'ip', ip || 'unknown');
  try {
  return await withUser(pool, ownerId, async (db) => {
    const r = (await db.query('SELECT * FROM signup_take($1)', [sha(token)])).rows[0];
    if (!r || r.outcome !== 'ok') return { outcome: (r?.outcome ?? 'bad') as 'bad' | 'expired' | 'used' };
    const firmId = (await db.query('SELECT owner_create_tenant($1, $2) AS id', [r.company_name, 'company'])).rows[0].id as string;
    await db.query("SELECT set_config('app.acting_firm', $1, true)", [firmId]);
    const values = companyValues({ name: r.company_name, crNumber: r.cr_number, legalForm: 'Not yet stated', vatStatus: 'unregistered', address: 'To be completed in company settings', city: r.city, industry: 'other', modules: [] }, r.country);
    const companyId = await insertCompany(db, r.country, values);
    const role = (await db.query(`SELECT id, default_for FROM client_roles WHERE firm_id = app_firm_id() AND status = 'active' AND name = 'Owner' ORDER BY default_for NULLS FIRST LIMIT 1`)).rows[0];
    if (!role) throw new HttpError(500, 'Something went wrong. Please try again.', 'err.server');
    // one person runs the whole company: the Owner title of THIS customer gets full access to every module, approvals, review and sign-off
    await db.query(`UPDATE client_roles SET permissions = $2::jsonb, can_approve = true, can_review = true, can_sign_off = true, can_manage_users = true WHERE id = $1`,
      [role.id, JSON.stringify(Object.fromEntries(ROLE_MODULES.map((m) => [m, 'edit'])))]);
    const userId = (await db.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash, password_set_at) VALUES (app_firm_id(), 'client', $1, $2, $3, now()) RETURNING id`, [r.full_name, r.email, r.password_hash])).rows[0].id as string;
    await db.query('INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1, $2, $3, $4)', [userId, companyId, role.default_for ?? 'client_accountant', role.id]);
    await setupCompanyBooks(db, companyId);
    const planId = (await db.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0]?.id as string | undefined;
    if (!planId) throw new HttpError(500, 'Something went wrong. Please try again.', 'err.server');
    await saveSubscription(db, firmId, { planId, cycle: 'yearly', startOn: riyadhDate(new Date()), trial: true, notes: 'Self-service sign-up' });
    await db.query('SELECT signup_done($1, $2, $3, $4, $5, $6)', [r.email_key, firmId, r.email, r.company_name, r.country, ipKey]);
    await db.query('SELECT signup_finish_meta($1, $2, $3)', [r.email_key, firmId, userId]);
    return { outcome: 'ok' as const, userId, firmId, companyId };
  });
  } catch (e) {
    // a last-moment clash on the company number or address (a unique rule): the same answer as "already used", never a crash
    if ((e as { code?: string }).code === '23505') return { outcome: 'used' };
    throw e;
  }
}

/**
 * Sign-up with a Google account. Google has already proved the e-mail address is the person's, so no e-mail link is needed; every other rule is the
 * same as the e-mail way (one trial per mailbox in any spelling, one per registration number, no throwaway domains, limits per address), because it
 * goes through the same two steps in the database. The password is random and nobody knows it (they can ask for a new one with "Forgot password").
 */
export async function googleSignup(pool: pg.Pool, cfg: SignupConfig, who: { sub: string; email: string; name: string }, body: Record<string, unknown>, ip: string): Promise<{ userId: string }> {
  const parsed = parseGoogleSignup({ ...body, fullName: typeof body.fullName === 'string' && body.fullName.trim() ? body.fullName : who.name });
  if (!parsed.ok) throw new HttpError(400, 'Please check what you entered.', parsed.problem);
  const v = parsed.value;
  const email = normalizeEmail(who.email);
  if (!email) throw new HttpError(400, 'Please check what you entered.', 'err.signupEmail');
  const ipKey = keyed(cfg, 'ip', ip || 'unknown');
  if (isDisposable(email)) {
    await pool.query('SELECT signup_log_event($1, $2, NULL, NULL, NULL, $3)', ['blocked_disposable', email, ipKey]).catch(() => undefined);
    throw new HttpError(400, 'Please use your work e-mail address.', 'err.signupDisposable');
  }
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const token = randomBytes(32).toString('base64url');
  const emailKey = keyed(cfg, 'email', comparisonForm(email));
  const crKey = keyed(cfg, 'cr', `${v.country}:${v.crNumber.toUpperCase()}`);
  const outcome = (await pool.query('SELECT signup_begin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r',
    [email, emailKey, crKey, v.fullName, v.companyName, v.country, v.crNumber, passwordHash, sha(token), ipKey, v.lang, v.city])).rows[0].r as string;
  if (outcome === 'org_used') throw new HttpError(409, 'This company already has an account or a trial.', 'err.signupOrgUsed');
  if (outcome === 'email_used') throw new HttpError(409, 'This e-mail address already has an account or has used its free trial. Write to us if you need help.', 'err.signupEmailUsed');
  if (outcome === 'throttled' || outcome === 'quiet') throw new HttpError(429, 'Too many requests. Wait a few minutes and try again.', 'err.tooMany');
  const r = await verifySignup(pool, cfg, token, ip);
  if (r.outcome !== 'ok') throw new HttpError(409, 'This company already has an account or a trial.', 'err.signupOrgUsed');
  await pool.query('SELECT google_link_user($1, $2)', [who.sub, r.userId]);
  return { userId: r.userId };
}
