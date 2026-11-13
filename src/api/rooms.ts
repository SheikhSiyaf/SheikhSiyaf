// Rooms: front desk, calendar, bookings with check-in and check-out, extras, the guest bill, and the setup (room
// types, rooms, seasons). Billing and checking out make a sales invoice; an issued one goes to ZATCA as usual.
import type { FastifyInstance } from 'fastify';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import { sendAfterIssue } from './einvoice.js';
import * as R from '../books/roomService.js';

type P = { id: string };
export function registerRoomRoutes(app: FastifyInstance, { as }: Ctx) {
  const ok = { ok: true };
  const id = (req: { params: P }) => uuidParam(req.params.id);
  app.get<{ Params: P; Querystring: { day?: string } }>('/api/companies/:id/rooms/front-desk', async (req) => as(req, (db) => R.frontDesk(db, id(req), dateParam(req.query.day, today()))));
  app.get<{ Params: P; Querystring: { from?: string; days?: string } }>('/api/companies/:id/rooms/calendar', async (req) =>
    as(req, (db) => R.calendar(db, id(req), dateParam(req.query.from, today()), Number(req.query.days ?? 14) || 14)));
  // setup
  app.get<{ Params: P }>('/api/companies/:id/room-types', async (req) => as(req, (db) => R.listTypes(db, id(req))));
  app.post<{ Params: P; Body: R.TypeInput }>('/api/companies/:id/room-types', async (req) => as(req, async (db) => ({ id: await R.saveType(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: R.TypeInput }>('/api/room-types/:id', async (req) => as(req, async (db) => {
    const t = (await db.query('SELECT company_id FROM room_types WHERE id = $1', [id(req)])).rows[0];
    return { id: await R.saveType(db, t?.company_id, req.body ?? {}, id(req)) };
  }));
  app.post<{ Params: P; Body: R.SeasonInput }>('/api/companies/:id/room-rates', async (req) => as(req, async (db) => ({ id: await R.saveSeason(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P }>('/api/room-rates/:id/delete', async (req) => as(req, async (db) => { await R.deleteSeason(db, id(req)); return ok; }));
  app.get<{ Params: P }>('/api/companies/:id/rooms', async (req) => as(req, (db) => R.listRooms(db, id(req))));
  app.post<{ Params: P; Body: R.RoomInput }>('/api/companies/:id/rooms', async (req) => as(req, async (db) => ({ id: await R.saveRoom(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: R.RoomInput }>('/api/rooms/:id', async (req) => as(req, async (db) => {
    const r = (await db.query('SELECT company_id FROM rooms WHERE id = $1', [id(req)])).rows[0];
    return { id: await R.saveRoom(db, r?.company_id, req.body ?? {}, id(req)) };
  }));
  // bookings
  app.get<{ Params: P; Querystring: { from?: string; to?: string; status?: string } }>('/api/companies/:id/bookings', async (req) =>
    as(req, (db) => R.listBookings(db, id(req), { from: req.query.from, to: req.query.to, status: req.query.status })));
  app.post<{ Params: P; Body: R.BookingInput }>('/api/companies/:id/bookings', async (req) => as(req, async (db) => ({ id: await R.createBooking(db, id(req), req.body ?? {}) })));
  app.get<{ Params: P }>('/api/bookings/:id', async (req) => as(req, (db) => R.getBooking(db, id(req))));
  app.post<{ Params: P; Body: R.BookingInput }>('/api/bookings/:id', async (req) => as(req, async (db) => { await R.updateBooking(db, id(req), req.body ?? {}); return ok; }));
  app.post<{ Params: P }>('/api/bookings/:id/check-in', async (req) => as(req, async (db) => { await R.checkIn(db, id(req)); return ok; }));
  app.post<{ Params: P }>('/api/bookings/:id/cancel', async (req) => as(req, async (db) => { await R.cancel(db, id(req)); return ok; }));
  app.post<{ Params: P }>('/api/bookings/:id/no-show', async (req) => as(req, async (db) => { await R.noShow(db, id(req)); return ok; }));
  app.post<{ Params: P; Body: R.ExtraInput }>('/api/bookings/:id/extras', async (req) => as(req, async (db) => ({ id: await R.addExtra(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P }>('/api/booking-extras/:id/delete', async (req) => as(req, async (db) => { await R.deleteExtra(db, id(req)); return ok; }));
  // refundable security deposits: taken, returned, or used to pay the guest's invoice
  app.post<{ Params: P; Body: R.DepositInput }>('/api/bookings/:id/deposit/take', async (req) => as(req, async (db) => ({ id: await R.takeDeposit(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: R.DepositInput }>('/api/bookings/:id/deposit/return', async (req) => as(req, async (db) => ({ id: await R.returnDeposit(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: R.DepositInput }>('/api/bookings/:id/deposit/apply', async (req) => as(req, async (db) => ({ id: await R.applyDeposit(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: { upTo?: string; issue?: boolean } }>('/api/bookings/:id/bill', async (req) => {
    const documentId = await as(req, (db) => R.bill(db, id(req), { upTo: req.body?.upTo || undefined, issue: req.body?.issue === true }));
    if (req.body?.issue === true) await sendAfterIssue(as, req, documentId);
    return { documentId };
  });
  app.post<{ Params: P; Body: { issue?: boolean } }>('/api/bookings/:id/check-out', async (req) => {
    const issue = req.body?.issue !== false;
    const documentId = await as(req, (db) => R.checkOut(db, id(req), { issue }));
    if (documentId && issue) await sendAfterIssue(as, req, documentId);
    return { documentId };
  });
}
