// Self-service sign-up: what a request must look like, and how an e-mail address is compared so that one person cannot get a second trial by
// spelling it differently (Gmail ignores dots and "+tag", most others ignore "+tag"). Pure rules, no database, tested in test/signup.test.ts.
import { domainToASCII } from 'node:url';

export const COUNTRIES = ['SA', 'AE'] as const;
export type SignupCountry = (typeof COUNTRIES)[number];

/** Well-known throwaway-mailbox domains. A list never catches them all, so this is one layer: the e-mail link and the one-trial rules do the real work. */
export const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '10minutemail.co.uk', '20minutemail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'tempail.com',
  'throwawaymail.com', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.org', 'getnada.com', 'nada.email',
  'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mintemail.com', 'mohmal.com', 'dispostable.com', 'fakeinbox.com', 'fakemail.net', 'emailondeck.com', 'burnermail.io',
  'discard.email', 'discardmail.com', 'spamgourmet.com', 'getairmail.com', 'moakt.com', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'mytemp.email', 'mailpoof.com',
  'inboxkitten.com', 'emailfake.com', 'fakemailgenerator.com', 'anonaddy.me', 'harakirimail.com', 'mail.tm', 'internxt.com', 'dropmail.me', 'minuteinbox.com', 'tempinbox.com',
  'spambox.us', 'mailforspam.com', 'linshiyouxiang.net', 'owlymail.com', 'luxusmail.org', 'emltmp.com', 'tmails.net', 'tempr.email', 'vomoto.com', 'gufum.com', 'tmpeml.com',
]);

export type Problem =
  | 'err.signupName' | 'err.signupCompany' | 'err.signupEmail' | 'err.signupPassword' | 'err.signupCountry' | 'err.signupCr' | 'err.signupCity' | 'err.signupTerms' | 'err.signupDisposable';

/** The address as typed, cleaned: trimmed, Unicode-normalised, lower-case, with an ASCII (punycode) domain. Null if it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').trim().toLowerCase();
  if (s.length < 6 || s.length > 254 || /[\s\u0000-\u001f<>(),;:"\\]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return null;
  const local = s.slice(0, at), domain = domainToASCII(s.slice(at + 1));
  if (!domain || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || !/[a-z]{2,}$/.test(domain) || domain.length > 253) return null;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null;
  return `${local}@${domain}`;
}

/** The form used ONLY to decide "is this the same mailbox as one that already had a trial": "+tag" removed everywhere, dots removed for Gmail. */
export function comparisonForm(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at), domain = email.slice(at + 1);
  local = local.split('+')[0]!;
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return `${local}@${domain}`;
}

export const isDisposable = (email: string) => {
  const d = email.slice(email.lastIndexOf('@') + 1);
  const parts = d.split('.');
  return parts.some((_, i) => DISPOSABLE.has(parts.slice(i).join('.')));   // also subdomains of a listed domain
};

const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'password1234', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'qwerty123456', 'iloveyou123',
  'admin12345', 'administrator', 'welcome123', 'welcome1234', 'letmein123', 'letmein1234', 'abc1234567', 'abcd123456', 'asdfghjkl1', 'p@ssw0rd123', 'passw0rd123', '1q2w3e4r5t',
  'nusuhbooks', 'nusuhbooks1', 'nusuhbooks123', 'nusuh12345', 'accounting1', 'accounting123', 'saudiarabia1', 'riyadh12345', '0123456789', '9876543210', 'changeme123']);

export function passwordProblem(password: unknown, email?: string): boolean {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return true;
  if (!/[a-zA-Z\u0600-\u06FF]/.test(password) || !/[0-9\W_]/.test(password)) return true;   // a letter, and a digit or symbol
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return true;
  const local = email ? email.slice(0, email.lastIndexOf('@')).replace(/[^a-z0-9]/g, '') : '';
  return local.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(local);
}

const clean = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return s.length >= min && s.length <= max && !/[\u0000-\u001f<>]/.test(s) ? s : null;
};

/** The registration number cleaned, or null if it is not plausible. A Saudi commercial registration is exactly 10 digits; a UAE trade licence number varies: letters, digits and slashes, 4 to 20 characters. */
const crOf = (raw: unknown, country: SignupCountry): string | null => {
  const cr = typeof raw === 'string' ? raw.normalize('NFKC').replace(/[\s-]/g, '') : '';
  return (country === 'SA' ? /^[0-9]{10}$/.test(cr) : /^[A-Za-z0-9/]{4,20}$/.test(cr)) ? cr : null;
};

export interface SignupInput { fullName: string; email: string; password: string; companyName: string; country: SignupCountry; crNumber: string; city: string; lang: 'en' | 'ar' }

/** Every value is checked here; anything unexpected is refused with a plain key, never silently changed. */
export function parseSignup(b: Record<string, unknown>): { ok: true; value: SignupInput } | { ok: false; problem: Problem } {
  const fullName = clean(b.fullName, 2, 120);
  if (!fullName) return { ok: false, problem: 'err.signupName' };
  const companyName = clean(b.companyName, 2, 160);
  if (!companyName) return { ok: false, problem: 'err.signupCompany' };
  const email = normalizeEmail(b.email);
  if (!email) return { ok: false, problem: 'err.signupEmail' };
  if (isDisposable(email)) return { ok: false, problem: 'err.signupDisposable' };
  if (typeof b.country !== 'string' || !(COUNTRIES as readonly string[]).includes(b.country)) return { ok: false, problem: 'err.signupCountry' };
  const country = b.country as SignupCountry;
  const cr = crOf(b.crNumber, country);
  if (cr === null) return { ok: false, problem: 'err.signupCr' };
  const city = clean(b.city, 2, 60);
  if (!city) return { ok: false, problem: 'err.signupCity' };
  if (passwordProblem(b.password, email)) return { ok: false, problem: 'err.signupPassword' };
  if (b.acceptTerms !== true) return { ok: false, problem: 'err.signupTerms' };
  return { ok: true, value: { fullName, email, password: b.password as string, companyName, country, crNumber: cr, city, lang: b.lang === 'ar' ? 'ar' : 'en' } };
}

export interface GoogleSignupInput { fullName: string; companyName: string; country: SignupCountry; crNumber: string; city: string; lang: 'en' | 'ar' }

/** The company step after Google confirmed who the person is: the same checks as the e-mail form, without e-mail and password (Google gave the e-mail). */
export function parseGoogleSignup(b: Record<string, unknown>): { ok: true; value: GoogleSignupInput } | { ok: false; problem: Problem } {
  const fullName = clean(b.fullName, 2, 120);
  if (!fullName) return { ok: false, problem: 'err.signupName' };
  const companyName = clean(b.companyName, 2, 160);
  if (!companyName) return { ok: false, problem: 'err.signupCompany' };
  if (typeof b.country !== 'string' || !(COUNTRIES as readonly string[]).includes(b.country)) return { ok: false, problem: 'err.signupCountry' };
  const country = b.country as SignupCountry;
  const cr = crOf(b.crNumber, country);
  if (cr === null) return { ok: false, problem: 'err.signupCr' };
  const city = clean(b.city, 2, 60);
  if (!city) return { ok: false, problem: 'err.signupCity' };
  if (b.acceptTerms !== true) return { ok: false, problem: 'err.signupTerms' };
  return { ok: true, value: { fullName, companyName, country, crNumber: cr, city, lang: b.lang === 'ar' ? 'ar' : 'en' } };
}
