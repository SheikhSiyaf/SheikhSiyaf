// Online payment of invoices: the company's settings and list (signed in), and the customer's side (no sign-in):
// pay from an invoice link, come back, the provider's webhook, and the sandbox checkout page.
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { baseUrl, uuidParam, type Ctx } from './context.js';
import { Throttle } from './auth.js';
import * as O from '../books/onlinePayService.js';
import { sandboxCheckout, sandboxDecide } from '../payments/providers.js';
import { fromMinor } from '../money.js';

type P = { id: string };
export function registerPaymentRoutes(app: FastifyInstance, { as, pool, opts }: Ctx) {
  app.get<{ Params: P }>('/api/companies/:id/online-payments', async (req) => as(req, async (db) => {
    const id = uuidParam(req.params.id);
    return { settings: await O.settings(db, id), payments: await O.list(db, id) };
  }));
  app.post<{ Params: P; Body: O.SettingsInput }>('/api/companies/:id/online-payments', async (req) =>
    as(req, async (db) => { await O.saveSettings(db, uuidParam(req.params.id), req.body ?? {}); return { ok: true }; }));

  // ---------------------------------------------------------------- public
  const throttle = new Throttle(20, 60 * 60_000);
  app.post<{ Params: { token: string } }>('/api/public/documents/:token/pay', async (req) => {
    const token = String(req.params.token);
    throttle.check(`pay:${token}`); throttle.fail(`pay:${token}`);
    return O.start(pool, token, baseUrl(req, opts));
  });
  app.get<{ Params: P }>('/api/public/payments/:id', async (req) => ({ status: await O.confirm(pool, { id: uuidParam(req.params.id) }) }));
  // The provider tells us something changed; we ask it ourselves (the body is never trusted).
  app.post<{ Params: { provider: string }; Body: Record<string, unknown> }>('/api/public/payments/webhook/:provider', async (req) => {
    const b = (req.body ?? {}) as { id?: string; invoice_id?: string; data?: { id?: string; invoice_id?: string } };
    const ref = b.data?.invoice_id ?? b.invoice_id ?? b.data?.id ?? b.id;
    if (typeof ref === 'string' && ref) await O.confirm(pool, { ref }).catch((e) => req.log.warn(`Online payment ${ref}: ${(e as Error).message}`));
    return { ok: true };
  });
  // The sandbox checkout (no money moves).
  app.get<{ Params: { ref: string } }>('/api/public/payments/sandbox/:ref', async (req) => {
    const s = sandboxCheckout(String(req.params.ref));
    if (!s) throw new HttpError(404, 'This checkout has ended. Go back to the invoice and press Pay online again.', 'err.payCheckoutGone');
    return { amount: fromMinor(s.amountMinor), currency: s.currency, outcome: s.outcome, returnUrl: s.returnUrl };
  });
  app.post<{ Params: { ref: string }; Body: { outcome?: string } }>('/api/public/payments/sandbox/:ref', async (req) => {
    const ref = String(req.params.ref);
    const s = sandboxDecide(ref, req.body?.outcome === 'paid' ? 'paid' : 'failed');
    if (!s) throw new HttpError(404, 'This checkout has ended. Go back to the invoice and press Pay online again.', 'err.payCheckoutGone');
    await O.confirm(pool, { ref });
    return { returnUrl: s.returnUrl };
  });
}
