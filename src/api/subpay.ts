// Manual bank-transfer payments: the customer's order and "I paid" form, the staff review queue, and the Owner's approval. See src/books/subpay.ts.
import type { FastifyInstance } from 'fastify';
import { uuidParam, type Ctx } from './context.js';
import * as P from '../books/subpay.js';
import { identityChecker } from './identity.js';
import { tellOwners } from './staff.js';

export function registerSubpayRoutes(app: FastifyInstance, ctx: Ctx) {
  const { as, opts } = ctx;
  const confirmIdentity = identityChecker(ctx);
  // The customer
  app.get('/api/pay/order', async (req) => as(req, async (db) => ({ enabled: await P.enabled(db), order: await P.myOrder(db) })));
  app.post('/api/pay/order', async (req) => as(req, (db) => P.placeOrder(db)));   // sends nothing: the order is worked out from the customer's waiting order
  app.post<{ Params: { id: string }; Body: P.SubmitInput }>('/api/pay/order/:id/submit', { bodyLimit: 8 * 1024 * 1024 }, async (req) => as(req, (db) => P.submit(db, uuidParam(req.params.id), req.body ?? {})));

  // Staff (each call is checked in the database against the person's role)
  app.get('/api/staff/payments', async (req) => as(req, (db) => P.queue(db)));
  app.get<{ Params: { id: string } }>('/api/staff/payments/:id', async (req) => as(req, (db) => P.detail(db, uuidParam(req.params.id))));
  app.get<{ Params: { id: string } }>('/api/staff/payments/slip/:id', async (req, reply) => {
    const f = await as(req, (db) => P.file(db, uuidParam(req.params.id)));
    reply.header('content-type', f.type).header('content-disposition', `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store');
    return reply.send(f.bytes);
  });
  app.post<{ Params: { id: string }; Body: { note?: unknown } }>('/api/staff/payments/:id/recommend', async (req) => as(req, async (db) => { await P.recommend(db, uuidParam(req.params.id), req.body?.note); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/api/staff/payments/:id/reject', async (req) => as(req, async (db) => { await P.reject(db, uuidParam(req.params.id), req.body?.reason); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: { message?: unknown } }>('/api/staff/payments/:id/need-info', async (req) => as(req, async (db) => { await P.needInfo(db, uuidParam(req.params.id), req.body?.message); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: { override?: unknown } }>('/api/staff/payments/:id/approve', async (req) => as(req, (db) => P.approve(db, uuidParam(req.params.id), req.body ?? {}, new Date(), opts.publicUrl)));
  app.get('/api/staff/payments-settings', async (req) => as(req, (db) => P.settings(db)));
  app.post<{ Body: { enabled?: unknown; reviewTargetHours?: unknown; orderOpenDays?: unknown; bankChangeDelayHours?: unknown } }>('/api/staff/payments-settings', async (req) => as(req, async (db) => { await P.saveSettings(db, req.body ?? {}); return { ok: true }; }));

  // The bank details customers are told to pay into. Only the Owner role changes them, after confirming who they are; a change waits (a setting)
  // before customers see it, every Owner is e-mailed, and any Owner may cancel it.
  app.get('/api/staff/payments/bank', async (req) => as(req, (db) => P.bankGet(db)));
  app.post<{ Body: P.BankInput & { password?: unknown; code?: unknown } }>('/api/staff/payments/bank', async (req) => {
    await confirmIdentity(req, req.body);
    return as(req, async (db) => {
      const r = await P.bankRequest(db, req.body ?? {});
      const hours = Number((await P.settings(db)).bankChangeDelayHours);
      await tellOwners(db, r.immediate
        ? { en: 'entered the bank details customers pay into.', ar: 'أدخل البيانات البنكية التي يدفع إليها العملاء.' }
        : { en: `asked to CHANGE the bank details customers pay into. They show to customers in ${hours} hours. If this was not you or another Owner, sign in and cancel it now in Owner > Payments.`,
            ar: `طلب تغيير البيانات البنكية التي يدفع إليها العملاء. ستظهر للعملاء بعد ${hours} ساعة. إن لم يكن ذلك منك أو من مالك آخر، سجّل الدخول وألغِه الآن من المالك > المدفوعات.` });
      return { ok: true, ...r };
    });
  });
  app.post<{ Params: { id: string } }>('/api/staff/payments/bank/:id/cancel', async (req) => as(req, async (db) => {
    await P.bankCancel(db, uuidParam(req.params.id));
    await tellOwners(db, { en: 'cancelled a waiting change of the bank details.', ar: 'ألغى طلب تغيير البيانات البنكية.' });
    return { ok: true };
  }));
}
