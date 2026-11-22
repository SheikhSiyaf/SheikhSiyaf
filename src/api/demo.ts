// The demo site (this server runs with DEMO_SITE=true against its own database of fictional companies).
// The platform owner presses Demo mode in the live app, which opens /demo?t=<signed link> here. The link is exchanged for
// a pass cookie; the pass lets the browser list the client types and enter one as that company's demo owner. Nothing
// here exists on the live app (the routes are not registered), and every request re-checks that the database is a demo
// database with no real customer in it (demo_database_ok, db/migrations/0064).
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import type { Ctx } from './context.js';
import { sessionCookie, signSession } from '../auth/session.js';
import { signDemoToken, verifyDemoToken } from '../demo/demoLink.js';

const PASS_COOKIE = 'nb_demo';
const PASS_HOURS = 12;

export function registerDemoRoutes(app: FastifyInstance, { pool, opts }: Ctx) {
  const ds = opts.demoSite;
  if (!ds) return;   // the live app has none of these routes
  const secure = Boolean(opts.cookieSecure);

  const guard = async () => {
    if (!(await pool.query('SELECT demo_database_ok() AS ok')).rows[0].ok) throw new HttpError(403, 'This is not a demo database.', 'err.demoNotDemo');
  };
  const hasPass = (cookieHeader: string | undefined) => {
    const m = new RegExp(`(?:^|;\\s*)${PASS_COOKIE}=([^;]+)`).exec(cookieHeader ?? '');
    return Boolean(m) && verifyDemoToken(ds.linkSecret, m![1], 'pass');
  };
  const needPass = (cookieHeader: string | undefined) => {
    if (!hasPass(cookieHeader)) throw new HttpError(403, 'Open the demo from your Nusuh Books account (Demo mode).', 'err.demoNoPass');
  };

  app.post<{ Body: { token?: string } }>('/api/demo/open', async (req, reply) => {
    await guard();
    if (!verifyDemoToken(ds.linkSecret, req.body?.token, 'link')) throw new HttpError(403, 'This demo link has expired. Press Demo mode in your Nusuh Books account again.', 'err.demoLink');
    reply.header('set-cookie', `${PASS_COOKIE}=${signDemoToken(ds.linkSecret, 'pass', PASS_HOURS * 3600)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PASS_HOURS * 3600}${secure ? '; Secure' : ''}`);
    return { ok: true };
  });

  app.get('/api/demo/entries', async (req) => {
    needPass(req.headers.cookie);
    await guard();
    return (await pool.query('SELECT key, title, "titleAr", industry, blurb, "blurbAr", sort FROM demo_entries_list()')).rows;
  });

  app.post<{ Body: { key?: unknown } }>('/api/demo/enter', async (req, reply) => {
    needPass(req.headers.cookie);
    await guard();
    const key = req.body?.key;
    if (typeof key !== 'string' || !/^[a-z]{2,20}$/.test(key)) throw new HttpError(400, 'Choose a client type.', 'err.format');
    const e = (await pool.query('SELECT user_id, company_id FROM demo_entry_user($1)', [key])).rows[0];
    if (!e) throw new HttpError(404, 'Not found.', 'err.notFound');
    const v = (await pool.query('SELECT session_version_of($1) AS v', [e.user_id])).rows[0]?.v;
    if (v === null || v === undefined) throw new HttpError(403, 'This demo account is suspended.', 'err.suspended');
    reply.header('set-cookie', sessionCookie(signSession(opts.sessionSecret, e.user_id, Number(v)), secure));
    return { path: e.company_id ? `/c/${e.company_id}/Home` : '/' };
  });
}
