// The website connection. Owner: Payment settings and testimonials. Public: one read-only answer the website asks for.
import type { FastifyInstance } from 'fastify';
import { uuidParam, type Ctx } from './context.js';
import * as W from '../books/websiteService.js';

export function registerWebsiteRoutes(app: FastifyInstance, { as, pool }: Ctx) {
  app.get('/api/owner/payment-settings', async (req) => as(req, (db) => W.paymentSettings(db)));
  app.post<{ Body: W.PaymentInput }>('/api/owner/payment-settings', async (req) => as(req, async (db) => {
    const r = await W.savePaymentSettings(db, req.body ?? {}); W.forgetPublicSiteData(); return r;
  }));

  app.get('/api/owner/website', async (req) => as(req, (db) => W.websiteEdits(db)));
  app.post<{ Body: W.TestimonialInput }>('/api/owner/website/testimonials', async (req) => as(req, async (db) => { const r = await W.addTestimonial(db, req.body ?? {}); W.forgetPublicSiteData(); return r; }));
  app.post<{ Body: { ids?: unknown } }>('/api/owner/website/testimonials/order', async (req) => as(req, async (db) => { await W.orderTestimonials(db, req.body?.ids); W.forgetPublicSiteData(); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: W.TestimonialInput }>('/api/owner/website/testimonials/:id', async (req) => as(req, async (db) => { await W.saveTestimonial(db, uuidParam(req.params.id), req.body ?? {}); W.forgetPublicSiteData(); return { ok: true }; }));
  app.post<{ Params: { id: string } }>('/api/owner/website/testimonials/:id/delete', async (req) => as(req, async (db) => { await W.deleteTestimonial(db, uuidParam(req.params.id)); W.forgetPublicSiteData(); return { ok: true }; }));
  app.post<{ Body: { limit?: unknown } }>('/api/owner/website/settings', async (req) => as(req, async (db) => { await W.setTestimonialLimit(db, req.body?.limit); W.forgetPublicSiteData(); return { ok: true }; }));

  /** The public website's read-only answer: prices, names, visible testimonials. No sign-in, nothing private, cached for a minute. */
  app.get('/api/public/site-data', async (req, reply) => {
    const { body, version } = await W.publicSiteData(pool);
    reply.header('etag', `"${version}"`).header('cache-control', 'public, max-age=60, stale-while-revalidate=300').header('content-type', 'application/json; charset=utf-8');
    if (req.headers['if-none-match'] === `"${version}"`) return reply.status(304).send();
    return reply.send(body);
  });
}
