// Rentals: the board, items rented out, contracts with their lines, hours, billing into an invoice, close and cancel.
import type { FastifyInstance } from 'fastify';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import * as R from '../books/rentalService.js';

type P = { id: string };
export function registerRentalRoutes(app: FastifyInstance, { as }: Ctx) {
  const ok = { ok: true };
  app.get<{ Params: P; Querystring: { day?: string } }>('/api/companies/:id/rentals/board', async (req) =>
    as(req, (db) => R.board(db, uuidParam(req.params.id), dateParam(req.query.day, today()))));
  app.get<{ Params: P; Querystring: { day?: string } }>('/api/companies/:id/rental-items', async (req) =>
    as(req, (db) => R.listItems(db, uuidParam(req.params.id), dateParam(req.query.day, today()))));
  app.post<{ Params: P; Body: R.ItemInput }>('/api/companies/:id/rental-items', async (req) =>
    as(req, async (db) => ({ id: await R.saveItem(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.get<{ Params: P }>('/api/rental-items/:id', async (req) => as(req, (db) => R.getItem(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: R.ItemInput }>('/api/rental-items/:id', async (req) => as(req, async (db) => {
    const it = await R.getItem(db, uuidParam(req.params.id));
    return { id: await R.saveItem(db, it.companyId, req.body ?? {}, it.id) };
  }));
  app.get<{ Params: P; Querystring: { status?: string } }>('/api/companies/:id/rental-contracts', async (req) =>
    as(req, (db) => R.listContracts(db, uuidParam(req.params.id), req.query.status)));
  app.post<{ Params: P; Body: R.ContractInput }>('/api/companies/:id/rental-contracts', async (req) =>
    as(req, async (db) => ({ id: await R.saveContract(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.get<{ Params: P; Querystring: { day?: string } }>('/api/rental-contracts/:id', async (req) =>
    as(req, (db) => R.getContract(db, uuidParam(req.params.id), dateParam(req.query.day, today()))));
  app.post<{ Params: P; Body: R.ContractInput }>('/api/rental-contracts/:id', async (req) => as(req, async (db) => {
    const k = await R.getContract(db, uuidParam(req.params.id));
    return { id: await R.saveContract(db, k.companyId, req.body ?? {}, k.id) };
  }));
  app.post<{ Params: P; Body: R.LineInput }>('/api/rental-contracts/:id/lines', async (req) =>
    as(req, async (db) => ({ id: await R.addLine(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.post<{ Params: P; Body: { upTo?: string; issueDate?: string } }>('/api/rental-contracts/:id/bill', async (req) =>
    as(req, async (db) => ({ documentId: await R.bill(db, uuidParam(req.params.id), dateParam(req.body?.upTo, today()), req.body?.issueDate) })));
  app.post<{ Params: P }>('/api/rental-contracts/:id/close', async (req) => as(req, async (db) => { await R.closeContract(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P }>('/api/rental-contracts/:id/cancel', async (req) => as(req, async (db) => { await R.cancelContract(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P; Body: R.LineInput }>('/api/rental-lines/:id', async (req) => as(req, async (db) => { await R.updateLine(db, uuidParam(req.params.id), req.body ?? {}); return ok; }));
  app.post<{ Params: P }>('/api/rental-lines/:id/delete', async (req) => as(req, async (db) => { await R.deleteLine(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P; Body: { date?: string } }>('/api/rental-lines/:id/return', async (req) =>
    as(req, async (db) => { await R.returnLine(db, uuidParam(req.params.id), String(req.body?.date ?? '')); return ok; }));
  app.post<{ Params: P; Body: { date?: string; hours?: string; note?: string } }>('/api/rental-lines/:id/hours', async (req) =>
    as(req, async (db) => { await R.recordHours(db, uuidParam(req.params.id), String(req.body?.date ?? ''), String(req.body?.hours ?? ''), req.body?.note); return ok; }));
}
