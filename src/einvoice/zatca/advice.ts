// What ZATCA's refusal most likely means, in words a customer can act on without calling us.
// ZATCA's own text is always shown as well: this only adds the likely cause and what to do about it.
// Each key is a sentence in web/src/i18n.tsx (English and Arabic).

/** Every sentence zatcaAdvice can return; each one must exist in English and Arabic (tested). */
export const ADVICE_KEYS = ['einv.why.unreachable', 'einv.why.otp', 'einv.why.signin', 'einv.why.vat', 'einv.why.exists',
  'einv.why.address', 'einv.why.notAllowed', 'einv.why.zatcaDown'] as const;

/** The advice key for what ZATCA said, or null when we have nothing useful to add beyond ZATCA's own words. */
export function zatcaAdvice(zatcaText: string): string | null {
  const s = String(zatcaText ?? '');
  if (!s.trim()) return null;
  if (/unreachable|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket/i.test(s)) return 'einv.why.unreachable';
  // The code is wrong, already used, or past its hour.
  if (/otp/i.test(s)) return 'einv.why.otp';
  // The device's own sign-in was refused: its certificate is not valid for this environment any more.
  if (/\b401\b|unauthorized|authentication|invalid[- ]?token/i.test(s)) return 'einv.why.signin';
  // The VAT number in our request does not match the taxpayer whose portal made the code (often a VAT group).
  if (/vat|taxpayer|tin\b|registration number/i.test(s)) return 'einv.why.vat';
  // A device is already registered for these details in this environment.
  if (/already|exists|duplicate/i.test(s)) return 'einv.why.exists';
  if (/address|street|district|postal|building/i.test(s)) return 'einv.why.address';
  if (/\b403\b|forbidden|not allowed|permission/i.test(s)) return 'einv.why.notAllowed';
  if (/\b5\d\d\b|internal server|service unavailable|gateway/i.test(s)) return 'einv.why.zatcaDown';
  return null;
}
