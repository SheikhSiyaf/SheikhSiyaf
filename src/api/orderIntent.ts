// The website's Order button lands on the software's /order page. These routes keep the visitor's module selection on the server (src/books/orderIntent.ts).
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import type { Ctx } from './context.js';
import { signupConfig } from '../books/signupService.js';
import { claimIntent, createIntent, peekIntent } from '../books/orderIntent.js';

export function registerOrderIntentRoutes(app: FastifyInstance, { pool, opts, as }: Ctx) {
  const cfg = opts.signup ?? signupConfig({}, opts.sessionSecret);

  /** Public. Reads only the module names and the clean-up flag; any price, amount, plan or user field in the request is never looked at. */
  app.post<{ Body: Record<string, unknown> }>('/api/public/order-intent', async (req) => createIntent(pool, cfg, req.body, req.ip));

  /** Public. What a token holds, so the /order page can show it. An unknown or expired token is a plain 404. */
  app.get<{ Params: { token: string } }>('/api/public/order-intent/:token', async (req) => {
    const r = await peekIntent(pool, req.params.token);
    if (!r) throw new HttpError(404, 'This link is not valid any more.', 'err.notFound');
    return r;
  });

  /** A signed-in customer claims the selection they arrived with. */
  app.post<{ Body: { token?: unknown } }>('/api/pay/intent/claim', async (req) => as(req, async (db) => {
    const r = await claimIntent(db, req.body?.token);
    if (!r) throw new HttpError(404, 'This link is not valid any more.', 'err.notFound');
    return r;
  }));
}
