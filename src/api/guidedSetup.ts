// The guided setup in the API: where a customer stands, saving a step, adding a kind of business's accounts, which page guides were opened,
// and reading a PDF or picture into import rows (switched off unless DOC_EXTRACT=on). Counts for the owner are in the Trials view.
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { uuidParam, type Ctx } from './context.js';
import * as S from '../books/guidedSetup.js';
import { extractConfig, extractRows, Limiter } from '../books/documentExtract.js';

export function registerGuidedSetupRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  const perHour = new Limiter(10, 60 * 60 * 1000);
  const perDay = new Limiter(30, 24 * 60 * 60 * 1000);
  let running = 0;

  app.get('/api/setup', async (req) => as(req, async (db) => ({ setup: await S.mySetup(db), extractEnabled: extractConfig().enabled })));
  app.post<{ Body: S.SaveInput }>('/api/setup', async (req) => as(req, async (db) => ({ setup: await S.saveStep(db, req.body ?? {}) })));
  app.post<{ Body: { page?: unknown } }>('/api/setup/tour', async (req) => as(req, async (db) => { await S.tourSeen(db, req.body?.page); return { ok: true }; }));
  app.post<{ Params: { id: string }; Body: { businessType?: unknown } }>('/api/companies/:id/setup/chart', async (req) =>
    as(req, (db) => S.applyChart(db, uuidParam(req.params.id), req.body?.businessType)));

  // A PDF or picture read into draft rows. Needs the customer's tick, is limited per person and in total, and keeps nothing.
  app.post<{ Params: { id: string }; Body: { kind?: unknown; fileBase64?: unknown; fileType?: unknown; consent?: unknown } }>(
    '/api/companies/:id/import/extract', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
      const companyId = uuidParam(req.params.id);
      const cfg = extractConfig();
      if (!cfg.enabled) throw new HttpError(400, 'Reading a PDF or picture is not switched on yet. Use an Excel or CSV file.', 'err.extractOff');
      await as(req, (db) => S.requireCompany(db, companyId));   // before the file goes anywhere
      if (!perHour.take(req.userId ?? 'x') || !perDay.take(req.userId ?? 'x')) throw new HttpError(429, 'Too many files read just now. Try again later, or use an Excel or CSV file.', 'err.rateLimited');
      if (running >= 3) throw new HttpError(429, 'The reader is busy. Try again in a minute.', 'err.rateLimited');
      running++;
      try {
        const rows = await extractRows(cfg, req.body ?? {}, opts.extractFetch);
        await as(req, (db) => db.query('SELECT setup_extract_used()'));
        return { rows };
      } finally { running--; }
    });
}
