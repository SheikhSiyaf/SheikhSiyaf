// Rooms: front desk, calendar, bookings with check-in and check-out, extras, the guest bill, and the setup (room
// types, rooms, seasons). Billing and checking out make a sales invoice; an issued one goes to ZATCA as usual.
import type { FastifyInstance } from 'fastify';
import { dateParam, today, uuidParam, type Ctx } from './context.js';
import { sendAfterIssue } from './einvoice.js';
import * as R from '../books/roomService.js';
import * as RC from '../books/roomContractService.js';

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
  // advance payments: an advance-payment invoice (ZATCA 386), issued and paid, deducted from the guest bill
  app.post<{ Params: P; Body: { amount?: string; date?: string; accountId?: string; method?: string; reference?: string } }>('/api/bookings/:id/advance', async (req) => {
    const documentId = await as(req, (db) => R.takeAdvance(db, id(req), req.body ?? {}));
    await sendAfterIssue(as, req, documentId);
    return { documentId };
  });
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

  // contract options (0095): settings, extra charge lines, guest identity check, rental contract, renewals, registration record, receipt
  app.get<{ Params: P }>('/api/companies/:id/room-settings', async (req) => as(req, (db) => RC.getSettings(db, id(req))));
  app.post<{ Params: P; Body: RC.SettingsInput }>('/api/companies/:id/room-settings', async (req) => as(req, async (db) => { await RC.saveSettings(db, id(req), req.body ?? {}); return ok; }));
  app.post<{ Params: P; Body: RC.ChargeInput }>('/api/companies/:id/room-charges', async (req) => as(req, async (db) => ({ id: await RC.saveCharge(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: RC.ChargeInput }>('/api/room-charges/:id', async (req) => as(req, async (db) => {
    const t = (await db.query('SELECT company_id FROM room_charge_lines WHERE id = $1', [id(req)])).rows[0];
    return { id: await RC.saveCharge(db, t?.company_id, req.body ?? {}, id(req)) };
  }));
  app.post<{ Params: P; Body: { contractType?: string } }>('/api/bookings/:id/contract-type', async (req) => as(req, async (db) => { await RC.changeContractType(db, id(req), String(req.body?.contractType ?? '')); return ok; }));
  app.get<{ Params: P }>('/api/bookings/:id/guest-check', async (req) => as(req, (db) => RC.getGuestCheck(db, id(req))));
  app.post<{ Params: P; Body: RC.GuestCheckInput }>('/api/bookings/:id/guest-check', async (req) => as(req, async (db) => ({ id: await RC.saveGuestCheck(db, id(req), req.body ?? {}) })));
  app.get<{ Params: P }>('/api/bookings/:id/contract', async (req) => as(req, (db) => RC.getContract(db, id(req))));
  app.post<{ Params: P; Body: RC.RentalInput }>('/api/bookings/:id/contract', async (req) => as(req, async (db) => ({ id: await RC.saveRental(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P }>('/api/bookings/:id/contract/sign', async (req) => as(req, async (db) => { await RC.signRental(db, id(req)); return ok; }));
  app.post<{ Params: P; Body: { status?: string; number?: string | null } }>('/api/bookings/:id/contract/ejar', async (req) => as(req, async (db) => { await RC.setEjar(db, id(req), req.body ?? {}); return ok; }));
  app.post<{ Params: P; Body: { date?: string; by?: string } }>('/api/bookings/:id/contract/non-renewal', async (req) => as(req, async (db) => { await RC.recordNonRenewal(db, id(req), req.body ?? {}); return ok; }));
  app.post<{ Params: P; Body: RC.AddendumInput }>('/api/bookings/:id/contract/addenda', async (req) => as(req, async (db) => ({ id: await RC.addAddendum(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: { fileName?: string; data?: string } }>('/api/bookings/:id/contract/file', { bodyLimit: 15 * 1024 * 1024 }, async (req) =>
    as(req, async (db) => ({ id: await RC.addContractFile(db, id(req), req.body ?? {}) })));
  app.post<{ Params: P; Body: { issue?: boolean } }>('/api/booking-instalments/:id/bill', async (req) => {
    const documentId = await as(req, (db) => RC.billInstalment(db, id(req), { issue: req.body?.issue === true }));
    if (req.body?.issue === true) await sendAfterIssue(as, req, documentId);
    return { documentId };
  });
  app.get<{ Params: P }>('/api/companies/:id/rooms/renewals', async (req) => as(req, (db) => RC.renewals(db, id(req))));
  app.get<{ Params: P; Querystring: { from?: string; to?: string; format?: string } }>('/api/companies/:id/rooms/registration-record', async (req, reply) => {
    const r = await as(req, (db) => RC.registrationRecord(db, id(req), { from: req.query.from, to: req.query.to }));
    if (req.query.format !== 'csv') return r;
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="registration-record.csv"').header('x-content-type-options', 'nosniff').send(RC.registrationCsv(r.rows));
  });
  app.get<{ Params: P }>('/api/bookings/:id/receipt', async (req) => as(req, (db) => R.guestReceipt(db, id(req))));
}
