// The module selection a visitor arrives with from the website's Order button. The secret token for it is kept in this browser only (never in the
// address after the first step), and sent with the sign-up so it follows the person through the e-mail link.
const KEY = 'nb_order_intent';
export const getIntentToken = (): string | null => { try { const v = window.localStorage.getItem(KEY); return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null; } catch { return null; } };
export const setIntentToken = (t: string) => { try { window.localStorage.setItem(KEY, t); } catch { /* private window: the selection then only lives for this visit */ } };
export const clearIntentToken = () => { try { window.localStorage.removeItem(KEY); } catch { /* nothing to clear */ } };
