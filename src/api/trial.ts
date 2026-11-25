// The free trial in the API: the lock, the customer's own trial status, and the platform owner's actions.
//
// The lock: on every request from a signed-in person the API reads their customer's trial facts and the clock
// (src/books/trialRules.ts accessOf). After the trial ends the customer can only reach the "trial has ended" screen,
// its own billing, support and a data export; after it is closed only an export, for 60 days; after that nothing.
// The platform owner is never locked. Row-level security is not touched: this decides whether a request is let in at all.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { routePath, uuidParam, type Ctx } from './context.js';
import * as T from '../books/trialService.js';
import type { Access, Level, SubState } from '../books/trialRules.js';
import { accessOf } from '../books/trialRules.js';
import { SUPPORT } from '../books/trialEmails.js';

type Allow = [method: string, path: RegExp];
const UUID = '[0-9a-f-]{36}';
const ALWAYS: Allow[] = [['GET', /^\/api\/config$/], ['POST', /^\/api\/logout$/]];
const EXPORT: Allow = ['GET', new RegExp(`^/api/companies/${UUID}/export$`)];
const ABOUT_ME: Allow[] = [['GET', /^\/api\/me$/], ['GET', /^\/api\/trial$/]];
/** What a customer can still reach while its trial has ended and it is waiting to buy. */
const WHEN_LOCKED: Allow[] = [...ABOUT_ME, EXPORT,
  ['GET', /^\/api\/admin\/billing$/], ['GET', new RegExp(`^/api/billing/invoices/${UUID}$`)],
  ['*', /^\/api\/support(\/.*)?$/]];
/** After closing: only getting the data out. */
const WHEN_EXPORT_ONLY: Allow[] = [...ABOUT_ME, EXPORT];

const allowed = (list: Allow[], method: string, path: string) => list.some(([m, re]) => (m === '*' || m === method) && re.test(path));

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function registerTrialRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const now = () => opts.now?.() ?? new Date();
  const ttl = opts.lockCacheMs ?? 15_000;
  const cache = new Map<string, { at: number; state: SubState | null }>();

  /** The signed-in person's customer's trial facts. Kept for a few seconds so a busy screen does not ask the database every time. */
  async function stateFor(req: FastifyRequest): Promise<SubState | null> {
    const key = req.userId!;
    const hit = cache.get(key);
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.state;
    const state = await as(req, async (db) => T.stateOf((await db.query('SELECT * FROM my_access_state()')).rows[0]));
    if (ttl > 0) { if (cache.size > 5000) cache.clear(); cache.set(key, { at: Date.now(), state }); }
    return state;
  }

  // Registered before the role check, so a locked customer is told so before anything else.
  app.addHook('preHandler', async (req) => {
    if (!req.userId) return;   // signed out: the route answers "please sign in"
    const path = routePath(req);
    if (!path.startsWith('/api/') || allowed(ALWAYS, req.method, path)) return;
    const a = accessOf(await stateFor(req), now());
    if (a.level === 'full') return;
    if (a.level === 'locked' && allowed(WHEN_LOCKED, req.method, path)) return;
    if (a.level === 'export_only' && allowed(WHEN_EXPORT_ONLY, req.method, path)) return;
    if (a.level === 'locked') throw new HttpError(403, 'Your free trial has ended. Buy to continue: your data is kept.', 'err.trialEnded');
    throw new HttpError(403, 'This account is closed. You can still export your data for a limited time.', 'err.accountClosed');
  });

  const summary = (a: Access) => ({
    level: a.level satisfies Level, trialing: a.trialing, daysLeft: a.daysLeft,
    trialEndsAt: iso(a.trialEndsAt), graceEndsAt: iso(a.graceEndsAt), exportUntil: iso(a.exportUntil), deleteNotBefore: iso(a.deleteNotBefore),
  });

  /** Anyone signed in: where their customer stands (the app header's "X days left" and the trial-ended screen read this). While the
   *  trial is not open, it also carries what that screen shows: the optional modules switched on, the prices as set in Payment
   *  settings, and how to reach us. */
  app.get('/api/trial', async (req) => {
    if (!req.userId) throw new HttpError(401, 'Please sign in.', 'err.signIn');
    const a = accessOf(await stateFor(req), now());
    if (a.level === 'full' && !a.trialing) return summary(a);   // a paying customer, or none with a trial: nothing more to say
    const more = await as(req, async (db) => ({
      modules: (await db.query('SELECT my_trial_modules() AS m')).rows[0].m as string[],
      prices: (await db.query('SELECT public_site_data() AS d')).rows[0].d as { currency: string; lines: { key: string; name: string; nameAr: string; amount: number | string }[]; testimonials: { items: unknown[] } },
    }));
    // the customers' own words that the owner has added in Owner > Website (none until there are real ones): up to three
    return { ...summary(a), modules: more.modules, prices: { currency: more.prices.currency, lines: more.prices.lines }, testimonials: more.prices.testimonials.items.slice(0, 3), support: SUPPORT,
      buyUrl: `${SUPPORT.website}/order/` };
  });

  // The platform owner: every action needs a reason and is recorded (subscription_events and the audit log).
  type P = { Params: { id: string }; Body: { reason?: string; days?: number } };
  app.post<P>('/api/owner/tenants/:id/trial/extend', async (req) =>
    as(req, async (db) => { await T.extendTrial(db, uuidParam(req.params.id), Number(req.body?.days), req.body?.reason, now()); cache.clear(); return { ok: true }; }));
  app.post<P>('/api/owner/tenants/:id/trial/convert', async (req) =>
    as(req, async (db) => { await T.convertTrial(db, uuidParam(req.params.id), req.body?.reason, now()); cache.clear(); return { ok: true }; }));
  app.post<P>('/api/owner/tenants/:id/trial/cancel', async (req) =>
    as(req, async (db) => { await T.cancelTrial(db, uuidParam(req.params.id), req.body?.reason, now()); cache.clear(); return { ok: true }; }));
  /** Run the trial job now (it also runs by itself every hour). */
  app.post('/api/owner/trials/advance', async (req) =>
    as(req, async (db) => {
      if (!(await db.query('SELECT app_is_owner() AS o')).rows[0].o) throw new HttpError(403, 'Only the platform owner can do this.', 'err.ownerOnly');
      const moved = await T.advance(db, now()); cache.clear(); return { moved: moved.length };
    }));
}
