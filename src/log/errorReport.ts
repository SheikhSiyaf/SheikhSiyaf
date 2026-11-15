// Error reporting: off unless ERROR_REPORT_URL is set (one setting). Server errors (500s), failed background jobs and
// crashes are posted as JSON to that address (for example a monitoring service's webhook), masked like the logs:
// no passwords, keys, tokens, one-time codes, amounts, request bodies or customer data. At most 30 a minute.
import { guardFetch } from '../outside.js';
import { redactText, redactUrl } from './redact.js';

type Post = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<unknown>;
let poster: Post = (u, i) => guardFetch(fetch as unknown as Post)(u, i);
export function configureErrorReport(o: { post?: Post }) { if (o.post) poster = o.post; }

let windowStart = 0, sent = 0;
export interface ErrorReport { where: string; message: string; stack?: string; method?: string; url?: string; status?: number }

/** Sends one error report when ERROR_REPORT_URL is set; never throws. Returns whether it was sent. */
export async function reportError(r: ErrorReport): Promise<boolean> {
  const url = process.env.ERROR_REPORT_URL;
  if (!url) return false;
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; sent = 0; }
  if (++sent > 30) return false;
  const body = { app: 'nusuh-books', env: process.env.NODE_ENV ?? 'development', time: new Date(now).toISOString(), where: r.where,
    message: redactText(r.message), stack: r.stack ? redactText(r.stack).slice(0, 4000) : undefined,
    method: r.method, url: r.url ? redactUrl(r.url) : undefined, status: r.status };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    await poster(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }).finally(() => clearTimeout(t));
    return true;
  } catch { return false; }
}
