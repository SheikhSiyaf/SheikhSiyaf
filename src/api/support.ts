// Support chat: a customer's people raise issues with Nusuh Books; the owner answers from the owner console.
// The same routes serve both sides: the database decides who sees what and who writes as Nusuh Books.
import type { FastifyInstance } from 'fastify';
import { baseUrl, uuidParam, type Ctx } from './context.js';
import * as Sup from '../books/supportService.js';

type P = { id: string };
export function registerSupportRoutes(app: FastifyInstance, { as, opts }: Ctx) {
  app.get('/api/support/threads', async (req) => as(req, (db) => Sup.list(db)));
  app.get('/api/support/unread', async (req) => as(req, async (db) => ({ unread: await Sup.unread(db) })));
  app.post<{ Body: { subject?: string; category?: string; companyId?: string | null; body?: string } }>('/api/support/threads', async (req) =>
    as(req, async (db) => ({ id: await Sup.open(db, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/support/threads/:id', async (req) => as(req, (db) => Sup.get(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { body?: string } }>('/api/support/threads/:id/messages', async (req) =>
    as(req, async (db) => ({ id: await Sup.post(db, uuidParam(req.params.id), String(req.body?.body ?? ''), baseUrl(req, opts)) })));
  app.post<{ Params: P }>('/api/support/threads/:id/close', async (req) => as(req, async (db) => { await Sup.close(db, uuidParam(req.params.id)); return { ok: true }; }));
}
