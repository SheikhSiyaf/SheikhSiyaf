// Production hardening for every response and request (registered first in buildServer):
// - security headers (content security policy, no framing, no sniffing, no referrer outside the site, HTTPS only
//   when served over HTTPS) and no caching of API answers;
// - requests that change something with the sign-in cookie must come from this site (Origin), against cross-site
//   requests in addition to SameSite=Lax;
// - rate limits per address on what works without signing in (sign-in, invitations, password resets, customer
//   invoice links and payments), on top of the database sign-in throttle (0040);
// - /health for uptime monitoring: database and background job status, no customer data.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from './errors.js';
import { routePath } from './context.js';
import { JOBS } from '../jobs/runJob.js';

const csp = (google: boolean) => {
  // Sign in with Google loads Google's button script, frame and style from these exact addresses, and nothing else of Google's.
  const g = (extra: string) => (google ? ` ${extra}` : '');
  return [
    "default-src 'self'", `script-src 'self'${g('https://accounts.google.com/gsi/client')}`, `style-src 'self' 'unsafe-inline'${g('https://accounts.google.com/gsi/style')}`,
    "img-src 'self' data: blob:", "font-src 'self' data:", `connect-src 'self'${g('https://accounts.google.com/gsi/')}`, "media-src 'self' blob:", "worker-src 'self' blob:",
    `frame-src 'self' blob:${g('https://accounts.google.com/gsi/')}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
};
export const CSP = csp(false);

/** Requests per minute per address for routes that work without signing in. */
export const LIMITS: [RegExp, number][] = [
  [/^\/api\/google\//, 60],   // the one-time value the Google button asks for
  [/^\/api\/pay\//, 40],   // the customer's order and "I paid" form
  [/^\/api\/signup/, 20],   // sign-up and its confirmation: the database also limits requests per address and per e-mail
  [/^\/api\/google\//, 60],   // the one-time value the Google button asks for
  [/^\/api\/login/, 60],   // the database throttle (0040) is the main guard: 5 per account, 30 per address
  [/^\/api\/invite\//, 20],
  [/^\/api\/email-change\//, 20],
  [/^\/api\/password-reset$/, 10],   // the database also allows 3 an hour per email and 20 per sender's address
  [/^\/api\/me\/two-factor\//, 30],
  [/^\/api\/public\/order-intent/, 20],   // the website's hand-over: the database also allows 20 an hour per address
  [/^\/api\/public\//, 120],
  [/^\/api\/demo\//, 60],
  [/^\/health$/, 120],
];

class Window {
  private hits = new Map<string, { start: number; n: number }>();
  take(key: string, max: number, now = Date.now()): boolean {
    if (this.hits.size > 50_000) this.hits.clear();   // a flood of addresses cannot grow memory without end
    const h = this.hits.get(key);
    if (!h || now - h.start >= 60_000) { this.hits.set(key, { start: now, n: 1 }); return true; }
    return ++h.n <= max;
  }
}

export function registerHardening(app: FastifyInstance, o: { pool: pg.Pool; https: boolean; publicUrl?: string; redirectOldAddress?: boolean; google?: boolean }) {
  const policy = csp(Boolean(o.google));
  const limits = new Window();
  const publicHost = (() => { try { return o.publicUrl ? new URL(o.publicUrl).host : ''; } catch { return ''; } })();

  // After the move to its own domain, page loads on the old Render address (*.onrender.com) go on to the new one.
  // Off until REDIRECT_OLD_ADDRESS=on; only GET and HEAD move (a changing request is never silently re-sent); /health stays.
  const moveFromRender = Boolean(o.redirectOldAddress && o.publicUrl && publicHost && !publicHost.endsWith('.onrender.com'));

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    if (moveFromRender && ['GET', 'HEAD'].includes(req.method) && /\.onrender\.com$/i.test(String(req.headers.host ?? '').replace(/:\d+$/, '')) && !/^\/health(\?|$)/.test(req.url)) {
      return reply.redirect(`${o.publicUrl!.replace(/\/+$/, '')}${req.url}`, 308);
    }
    const path = routePath(req);
    const rule = LIMITS.find(([re]) => re.test(path));
    if (rule && !limits.take(`${rule[0].source}|${req.ip}`, rule[1])) throw new HttpError(429, 'Too many requests. Wait a minute and try again.', 'err.tooMany');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.cookie && req.headers.origin) {
      let host = '';
      try { host = new URL(String(req.headers.origin)).host; } catch { /* not a URL */ }
      if (!host || (host !== req.headers.host && host !== publicHost)) throw new HttpError(403, 'This request did not come from this site.', 'err.crossSite');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('content-security-policy', policy);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    reply.header('cross-origin-opener-policy', o.google ? 'same-origin-allow-popups' : 'same-origin');   // Google's sign-in window needs to talk back to this page
    if (o.https) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Uptime monitoring: 200 when the database answers and no switched-on job is late or failing, 503 otherwise.
  app.get('/health', async (_req, reply) => {
    const now = Date.now();
    let database = 'ok';
    let rows: { job: string; last_started_at: Date | null; last_finished_at: Date | null; last_ok: boolean | null }[] = [];
    try { rows = (await o.pool.query('SELECT job, last_started_at, last_finished_at, last_ok FROM job_status()')).rows; } catch { database = 'down'; }
    const jobs = Object.entries(JOBS).map(([job, j]) => {
      const on = process.env[j.off] !== 'off';
      const r = rows.find((x) => x.job === job);
      const last = r?.last_finished_at ? new Date(r.last_finished_at).getTime() : null;
      const late = on && last !== null && now - last > (j.everyMinutes * 3 + 5) * 60_000;
      return { job, on, lastRunAt: r?.last_finished_at ?? null, ok: r ? r.last_ok : null, late };
    });
    const healthy = database === 'ok' && !jobs.some((j) => j.on && (j.late || j.ok === false));
    reply.status(database === 'ok' ? (healthy ? 200 : 503) : 503);
    return { status: healthy ? 'ok' : database === 'ok' ? 'degraded' : 'down', database, time: new Date(now).toISOString(), jobs };
  });
}
