// Rooms (db/migrations/0044): room types, rooms, seasons, bookings with check-in and check-out, extras, and the guest
// bill into an ordinary invoice. The database prevents double booking, billing a night twice and changing what has
// been billed. Rates and extras are prices with VAT (src/books/rooms.ts works the invoice prices back from them).
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { addDays as addDaysDoc } from './documents.js';
import { issueDocument, nextNumber, recordPayment, saveContact, saveDraft } from './documentsService.js';
import { postEntry } from '../ledger/ledger.js';
import * as Adv from './advanceService.js';
import { addDays, extraLine, groupNights, nights, nightsLine, type Season } from './rooms.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => new Date().toISOString().slice(0, 10);
const txt = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const money = (v: unknown, key = 'err.roomRate'): string | null => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s) return null;
  try { if (toMinor(s) > 0n) return fromMinor(toMinor(s)); } catch { /* below */ }
  return bad('Enter an amount above 0 (with VAT).', key);
};
const date = (v: unknown, what = 'date'): string => (DATE.test(String(v ?? '')) ? String(v) : bad(`Enter the ${what}.`, 'err.date'));
const whole = (v: unknown, min: number, max: number, dflt: number) => {
  const n = v === undefined || v === null || v === '' ? dflt : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : bad(`Enter a whole number from ${min} to ${max}.`, 'err.roomGuests');
};

// ------------------------------------------------------------------ room types, rooms and seasons
export interface TypeInput { code?: string; name?: string; nameAr?: string | null; capacity?: number | string; rate?: string; incomeAccountId?: string | null;
  status?: 'active' | 'retired'; notes?: string | null }
export async function saveType(db: Db, companyId: string, x: TypeInput, id?: string): Promise<string> {
  const code = txt(x.code, 20) ?? bad('Give the room type a short code.', 'err.roomCode');
  const name = txt(x.name) ?? bad('Enter the room type name.', 'err.roomName');
  const rate = money(x.rate) ?? bad('Enter the nightly rate with VAT.', 'err.roomRate');
  const income = x.incomeAccountId || (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '4200'`, [companyId])).rows[0]?.id
    || bad("This client's chart of accounts has no account 4200 Room revenue.", 'err.chart');
  const vals = [code, name, txt(x.nameAr), whole(x.capacity, 1, 50, 2), rate, income, x.status === 'retired' ? 'retired' : 'active', txt(x.notes, 1000)];
  if (id) return (await db.query(`UPDATE room_types SET code = $2, name = $3, name_ar = $4, capacity = $5, rate = $6, income_account_id = $7, status = $8, notes = $9
    WHERE id = $1 RETURNING id`, [id, ...vals])).rows[0]?.id ?? notFound();
  if ((await db.query('SELECT 1 FROM room_types WHERE company_id = $1 AND lower(code) = lower($2)', [companyId, code])).rows[0]) bad('Another room type has this code.', 'err.roomCodeTaken');
  return (await db.query(`INSERT INTO room_types (company_id, code, name, name_ar, capacity, rate, income_account_id, status, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [companyId, ...vals])).rows[0].id;
}
export async function listTypes(db: Db, companyId: string) {
  const types = (await db.query(`SELECT t.id, t.code, t.name, t.name_ar AS "nameAr", t.capacity, t.rate::text AS rate, t.income_account_id AS "incomeAccountId",
      a.code AS "incomeAccountCode", t.status, t.notes, (SELECT count(*)::int FROM rooms r WHERE r.room_type_id = t.id AND r.status <> 'retired') AS rooms
    FROM room_types t JOIN accounts a ON a.id = t.income_account_id WHERE t.company_id = $1 ORDER BY t.status, t.code`, [companyId])).rows;
  const rates = (await db.query(`SELECT id, room_type_id AS "typeId", name, from_date::text AS "from", to_date::text AS "to", rate::text AS rate
    FROM room_rates WHERE company_id = $1 ORDER BY from_date`, [companyId])).rows;
  return types.map((t) => ({ ...t, seasons: rates.filter((r) => r.typeId === t.id) }));
}

export interface RoomInput { number?: string; typeId?: string; floor?: string | null; status?: 'active' | 'out_of_service' | 'retired'; notes?: string | null }
export async function saveRoom(db: Db, companyId: string, x: RoomInput, id?: string): Promise<string> {
  const number = txt(x.number, 20) ?? bad('Enter the room number.', 'err.roomNumber');
  if (!x.typeId) bad('Choose the room type.', 'err.roomType');
  const status = ['active', 'out_of_service', 'retired'].includes(String(x.status)) ? x.status : 'active';
  const vals = [number, x.typeId, txt(x.floor, 20), status, txt(x.notes, 1000)];
  if (id) return (await db.query(`UPDATE rooms SET number = $2, room_type_id = $3, floor = $4, status = $5, notes = $6 WHERE id = $1 RETURNING id`, [id, ...vals])).rows[0]?.id ?? notFound();
  if ((await db.query('SELECT 1 FROM rooms WHERE company_id = $1 AND lower(number) = lower($2)', [companyId, number])).rows[0]) bad('Another room has this number.', 'err.roomNumberTaken');
  return (await db.query(`INSERT INTO rooms (company_id, number, room_type_id, floor, status, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [companyId, ...vals])).rows[0].id;
}
export async function listRooms(db: Db, companyId: string) {
  return (await db.query(`SELECT r.id, r.number, r.room_type_id AS "typeId", t.code AS "typeCode", t.name AS "typeName", t.name_ar AS "typeNameAr", t.capacity,
      t.rate::text AS rate, r.floor, r.status, r.notes
    FROM rooms r JOIN room_types t ON t.id = r.room_type_id WHERE r.company_id = $1 ORDER BY (r.status = 'retired'), r.floor NULLS LAST, r.number`, [companyId])).rows;
}

export interface SeasonInput { typeId?: string; name?: string | null; from?: string; to?: string; rate?: string }
export async function saveSeason(db: Db, companyId: string, x: SeasonInput): Promise<string> {
  if (!x.typeId) bad('Choose the room type.', 'err.roomType');
  const from = date(x.from, 'first day'), to = date(x.to, 'last day');
  if (to < from) bad('The last day cannot be before the first day.', 'err.dateOrder');
  const rate = money(x.rate) ?? bad('Enter the nightly rate with VAT.', 'err.roomRate');
  return (await db.query(`INSERT INTO room_rates (company_id, room_type_id, name, from_date, to_date, rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [companyId, x.typeId, txt(x.name, 80), from, to, rate])).rows[0].id;
}
export async function deleteSeason(db: Db, id: string) {
  if (!(await db.query('DELETE FROM room_rates WHERE id = $1 RETURNING id', [id])).rowCount) notFound();
}

// ------------------------------------------------------------------ bookings
export interface GuestInput { name?: string; phone?: string; email?: string; vatNumber?: string; address?: string; buildingNumber?: string; district?: string;
  city?: string; postalCode?: string }
export interface BookingInput { contactId?: string | null; guest?: GuestInput | null; roomId?: string; arrival?: string; departure?: string; adults?: number | string;
  children?: number | string; agreedRate?: string | null; source?: string | null; reference?: string | null; notes?: string | null }

async function guestFor(db: Db, companyId: string, x: BookingInput): Promise<string> {
  if (x.contactId) return x.contactId;
  const g = x.guest ?? {};
  if (!txt(g.name)) bad("Enter the guest's name or choose a customer.", 'err.roomGuest');
  return saveContact(db, companyId, { isCustomer: true, name: g.name, phone: g.phone, email: g.email, vatNumber: g.vatNumber, address: g.address,
    buildingNumber: g.buildingNumber, district: g.district, city: g.city, postalCode: g.postalCode });
}
function dates(x: BookingInput) {
  const arrival = date(x.arrival, 'arrival date'), departure = date(x.departure, 'departure date');
  if (departure <= arrival) bad('The departure is after the arrival: at least one night.', 'err.roomNights');
  return { arrival, departure };
}

export async function createBooking(db: Db, companyId: string, x: BookingInput): Promise<string> {
  if (!x.roomId) bad('Choose the room.', 'err.roomChoose');
  const { arrival, departure } = dates(x);
  const contactId = await guestFor(db, companyId, x);
  const number = await nextNumber(db, companyId, 'booking', 'BKG-');
  return (await db.query(`INSERT INTO bookings (company_id, number, contact_id, room_id, arrival, departure, adults, children, agreed_rate, source, reference, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, app_user_id()) RETURNING id`,
    [companyId, number, contactId, x.roomId, arrival, departure, whole(x.adults, 1, 50, 1), whole(x.children, 0, 50, 0), money(x.agreedRate),
      txt(x.source, 40), txt(x.reference, 80), txt(x.notes, 1000)])).rows[0].id;
}

export async function updateBooking(db: Db, id: string, x: BookingInput): Promise<void> {
  const b = (await db.query(`SELECT company_id, contact_id, room_id, arrival::text, departure::text, adults, children, agreed_rate::text, source, reference, notes
    FROM bookings WHERE id = $1`, [id])).rows[0] ?? notFound();
  const { arrival, departure } = dates({ arrival: x.arrival ?? b.arrival, departure: x.departure ?? b.departure });
  await db.query(`UPDATE bookings SET contact_id = $2, room_id = $3, arrival = $4, departure = $5, adults = $6, children = $7, agreed_rate = $8, source = $9,
      reference = $10, notes = $11 WHERE id = $1`,
    [id, x.contactId || b.contact_id, x.roomId || b.room_id, arrival, departure, whole(x.adults ?? b.adults, 1, 50, 1), whole(x.children ?? b.children, 0, 50, 0),
      x.agreedRate === undefined ? b.agreed_rate : money(x.agreedRate), x.source === undefined ? b.source : txt(x.source, 40),
      x.reference === undefined ? b.reference : txt(x.reference, 80), x.notes === undefined ? b.notes : txt(x.notes, 1000)]);
}

async function setStatus(db: Db, id: string, from: string[], to: string, msg: string, key: string) {
  const r = await db.query(`UPDATE bookings SET status = $2 WHERE id = $1 AND status = ANY ($3) RETURNING id`, [id, to, from]);
  if (!r.rowCount) bad(msg, key);
}
/** The guest arrives: on or after the arrival day, into a room in service. */
export async function checkIn(db: Db, id: string, day = today()): Promise<void> {
  const b = (await db.query(`SELECT b.arrival::text AS arrival, b.departure::text AS departure, b.status, r.status AS "roomStatus" FROM bookings b JOIN rooms r ON r.id = b.room_id
    WHERE b.id = $1`, [id])).rows[0] ?? notFound();
  if (b.status !== 'reserved') bad('Only a reserved booking is checked in.', 'err.roomNotReserved');
  if (b.arrival > day) bad('The guest can check in from the arrival day. Change the arrival date first if they came early.', 'err.roomEarly');
  if (day >= b.departure) bad('The stay is already over: change the departure date first.', 'err.roomLate');
  if (b.roomStatus !== 'active') bad('This room is not in service: move the booking to another room.', 'err.roomOutOfService');
  await setStatus(db, id, ['reserved'], 'in_house', 'Only a reserved booking is checked in.', 'err.roomNotReserved');
}
export async function cancel(db: Db, id: string) { await setStatus(db, id, ['reserved'], 'cancelled', 'Only a reserved booking is cancelled.', 'err.roomNotReserved'); }
export async function noShow(db: Db, id: string, day = today()) {
  const b = (await db.query(`SELECT arrival::text AS arrival FROM bookings WHERE id = $1`, [id])).rows[0] ?? notFound();
  if (b.arrival > day) bad('A guest is a no-show only from the arrival day.', 'err.roomEarly');
  await setStatus(db, id, ['reserved'], 'no_show', 'Only a reserved booking is a no-show.', 'err.roomNotReserved');
}

// ------------------------------------------------------------------ extras
export interface ExtraInput { date?: string; description?: string; quantity?: string | number; unitPrice?: string; accountId?: string | null }
export async function addExtra(db: Db, bookingId: string, x: ExtraInput): Promise<string> {
  const b = (await db.query('SELECT company_id, arrival::text AS arrival FROM bookings WHERE id = $1', [bookingId])).rows[0] ?? notFound();
  const description = txt(x.description) ?? bad('Say what the extra is (for example Laundry).', 'err.roomExtra');
  const q = String(x.quantity ?? '1').trim();
  if (!/^\d{1,8}(\.\d{1,3})?$/.test(q) || Number(q) <= 0) bad('Enter the quantity, more than 0.', 'err.quantity');
  const price = money(x.unitPrice) ?? bad('Enter the price with VAT.', 'err.roomRate');
  const account = x.accountId || (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '4200'`, [b.company_id])).rows[0]?.id;
  return (await db.query(`INSERT INTO booking_extras (company_id, booking_id, extra_date, description, quantity, unit_price, account_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7, app_user_id()) RETURNING id`, [b.company_id, bookingId, x.date ? date(x.date) : today(), description, q, price, account])).rows[0].id;
}
export async function deleteExtra(db: Db, id: string) {
  if (!(await db.query('DELETE FROM booking_extras WHERE id = $1 RETURNING id', [id])).rowCount) notFound();
}

// ------------------------------------------------------------------ the guest bill
interface Charge { description: string; quantity: string; unitPrice: string; accountId: string; quoted: string; total: string; difference: string }
/** What the next bill would hold: the nights not yet billed before `upTo` (not included) and every unbilled extra. */
async function charges(db: Db, bookingId: string, upTo?: string) {
  const b = (await db.query(`SELECT b.id, b.company_id, b.room_id, b.arrival::text AS arrival, b.departure::text AS departure, b.agreed_rate::text AS "agreedRate",
      r.number AS room, t.id AS "typeId", t.name AS "typeName", t.rate::text AS "typeRate", t.income_account_id AS "accountId", co.vat_rate::text AS "vatRate",
      (SELECT max(nights_to)::text FROM booking_bills x WHERE x.booking_id = b.id) AS "billedTo"
    FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN room_types t ON t.id = r.room_type_id JOIN companies co ON co.id = b.company_id WHERE b.id = $1`, [bookingId])).rows[0] ?? notFound();
  const seasons: Season[] = (await db.query(`SELECT from_date::text AS "from", to_date::text AS "to", rate::text AS rate FROM room_rates WHERE room_type_id = $1 ORDER BY from_date`,
    [b.typeId])).rows;
  const from = b.billedTo ?? b.arrival;
  const to = upTo && upTo < b.departure ? (upTo > from ? upTo : from) : b.departure;
  const out: Charge[] = [];
  for (const g of groupNights(from, to, b.typeRate, seasons, b.agreedRate)) {
    const p = nightsLine(g.nights, g.rate, b.vatRate);
    out.push({ description: `Room ${b.room} (${b.typeName}), ${g.nights} night${g.nights > 1 ? 's' : ''} ${g.from} to ${addDays(g.to, 1)}, ${g.rate} a night incl. VAT`,
      quantity: String(g.nights), unitPrice: p.unitPrice, accountId: b.accountId, quoted: p.quoted, total: p.total, difference: p.difference });
  }
  const extras = (await db.query(`SELECT id, extra_date::text AS date, description, quantity::text AS quantity, unit_price::text AS price, account_id AS "accountId"
    FROM booking_extras WHERE booking_id = $1 AND bill_id IS NULL ORDER BY extra_date, created_at`, [bookingId])).rows;
  for (const e of extras) {
    const p = extraLine(e.quantity, e.price, b.vatRate);
    out.push({ description: `${e.description}, ${e.date}`, quantity: p.quantityText, unitPrice: p.unitPrice, accountId: e.accountId, quoted: p.quoted, total: p.total, difference: p.difference });
  }
  return { booking: b, from, to, charges: out, extraIds: extras.map((e) => e.id as string) };
}

/** Bills the nights up to `upTo` (not included; the departure by default) and all unbilled extras into one invoice
 *  for the guest: a draft, or issued straight away. Returns the invoice. */
export async function bill(db: Db, bookingId: string, o: { upTo?: string; issueDate?: string; issue?: boolean } = {}): Promise<string> {
  const st = (await db.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0] ?? notFound();
  if (!['reserved', 'in_house'].includes(st.status)) bad('This booking is finished and no longer changes.', 'err.roomFinished');
  const c = await charges(db, bookingId, o.upTo ? date(o.upTo) : undefined);
  if (!c.charges.length) bad('Nothing to bill: every night and extra is billed.', 'err.roomNothing');
  const b = c.booking;
  const k = (await db.query(`SELECT b.contact_id, b.number, b.reference, coalesce(ct.payment_terms_days, co.payment_terms_days) AS terms
    FROM bookings b JOIN contacts ct ON ct.id = b.contact_id JOIN companies co ON co.id = b.company_id WHERE b.id = $1`, [bookingId])).rows[0];
  const issued = o.issueDate ? date(o.issueDate) : today();
  const documentId = await saveDraft(db, b.company_id, {
    type: 'invoice', contactId: k.contact_id, issueDate: issued, dueDate: addDaysDoc(issued, Number(k.terms)), reference: k.reference || k.number,
    notes: `Booking ${k.number}, room ${b.room}, ${b.arrival} to ${b.departure}`,
    lines: c.charges.map((x) => ({ description: x.description, quantity: x.quantity, unitPrice: x.unitPrice, accountId: x.accountId, vatCode: 'standard' as const })),
  });
  const billId = (await db.query(`INSERT INTO booking_bills (company_id, booking_id, document_id, nights_from, nights_to) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.company_id, bookingId, documentId, c.from, c.to])).rows[0].id;
  if (c.extraIds.length) await db.query('UPDATE booking_extras SET bill_id = $1 WHERE id = ANY ($2)', [billId, c.extraIds]);
  // Advances paid for this booking come off the bill (0046), oldest first, as far as the bill goes.
  for (const a of await bookingAdvances(db, bookingId)) {
    if (toMinor(a.leftNet) <= 0n) continue;
    const room = (await db.query(`SELECT gross_total - coalesce((SELECT sum(net_amount + vat_amount) FROM advance_deductions WHERE document_id = $1), 0) AS r FROM documents WHERE id = $1`,
      [documentId])).rows[0].r;
    if (Number(room) <= 0) break;
    await Adv.deduct(db, documentId, a.documentId);
  }
  if (o.issue) await issueDocument(db, documentId);
  return documentId;
}

/** The guest leaves: an early departure shortens the stay to today; what is left is billed (issued, by default);
 *  then the booking is departed. Returns the invoice made, if any. */
export async function checkOut(db: Db, id: string, o: { day?: string; issue?: boolean } = {}): Promise<string | null> {
  const day = o.day ?? today();
  const b = (await db.query(`SELECT status, arrival::text AS arrival, departure::text AS departure FROM bookings WHERE id = $1`, [id])).rows[0] ?? notFound();
  if (b.status !== 'in_house') bad('Only a guest in house checks out.', 'err.roomNotInHouse');
  if (day < b.departure) {
    const leave = day > b.arrival ? day : addDays(b.arrival, 1);   // at least one night
    if (leave < b.departure) await updateBooking(db, id, { departure: leave });
  }
  const c = await charges(db, id);
  const documentId = c.charges.length ? await bill(db, id, { issue: o.issue !== false, issueDate: day }) : null;
  await setStatus(db, id, ['in_house'], 'departed', 'Only a guest in house checks out.', 'err.roomNotInHouse');
  return documentId;
}

// ------------------------------------------------------------------ reading
const BOOKING_COLS = `b.id, b.number, b.status, b.contact_id AS "contactId", c.name AS guest, c.name_ar AS "guestAr", c.phone, c.vat_number AS "guestVat",
  b.room_id AS "roomId", r.number AS room, t.name AS "typeName", t.name_ar AS "typeNameAr", b.arrival::text AS arrival, b.departure::text AS departure,
  (b.departure - b.arrival) AS nights, b.adults, b.children, b.agreed_rate::text AS "agreedRate", b.source, b.reference, b.notes,
  b.checked_in_at AS "checkedInAt", b.checked_out_at AS "checkedOutAt", (SELECT max(nights_to)::text FROM booking_bills x WHERE x.booking_id = b.id) AS "billedTo",
  booking_deposit_held(b.id)::text AS "depositHeld"`;
const BOOKING_FROM = `FROM bookings b JOIN contacts c ON c.id = b.contact_id JOIN rooms r ON r.id = b.room_id JOIN room_types t ON t.id = r.room_type_id`;

export async function listBookings(db: Db, companyId: string, f: { from?: string; to?: string; status?: string } = {}) {
  return (await db.query(`SELECT ${BOOKING_COLS} ${BOOKING_FROM}
    WHERE b.company_id = $1 AND ($2::date IS NULL OR b.departure > $2) AND ($3::date IS NULL OR b.arrival <= $3) AND ($4::text IS NULL OR b.status = $4)
    ORDER BY b.arrival DESC, r.number LIMIT 500`, [companyId, f.from || null, f.to || null, f.status || null])).rows;
}

export async function getBooking(db: Db, id: string) {
  const b = (await db.query(`SELECT ${BOOKING_COLS}, b.company_id AS "companyId" ${BOOKING_FROM} WHERE b.id = $1`, [id])).rows[0] ?? notFound();
  const extras = (await db.query(`SELECT e.id, e.extra_date::text AS date, e.description, e.quantity::text AS quantity, e.unit_price::text AS "unitPrice",
      e.account_id AS "accountId", e.bill_id IS NOT NULL AS billed FROM booking_extras e WHERE e.booking_id = $1 ORDER BY e.extra_date, e.created_at`, [id])).rows;
  const bills = (await db.query(`SELECT x.id, x.document_id AS "documentId", x.nights_from::text AS "nightsFrom", x.nights_to::text AS "nightsTo", d.number, d.status,
      d.gross_total::text AS total FROM booking_bills x JOIN documents d ON d.id = x.document_id WHERE x.booking_id = $1 ORDER BY x.nights_from, x.created_at`, [id])).rows;
  const open = ['reserved', 'in_house'].includes(b.status);
  const next = open ? await charges(db, id) : null;
  const sum = (k: 'quoted' | 'total' | 'difference') => fromMinor((next?.charges ?? []).reduce((s, x) => s + toMinor(x[k]), 0n));
  return { ...b, extras, bills, deposit: await deposits(db, id), advances: await bookingAdvances(db, id), unbilled: next ? { lines: next.charges, quoted: sum('quoted'), total: sum('total'), difference: sum('difference') } : null };
}

/** The front desk on a day: arrivals, departures, guests in house, and how full the hotel is. */
export async function frontDesk(db: Db, companyId: string, day = today()) {
  const rows = (await db.query(`SELECT ${BOOKING_COLS} ${BOOKING_FROM}
    WHERE b.company_id = $1 AND ((b.status = 'reserved' AND b.arrival <= $2) OR (b.status = 'in_house')) ORDER BY r.number`, [companyId, day])).rows;
  const rooms = (await db.query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'out_of_service')::int AS out
    FROM rooms WHERE company_id = $1`, [companyId])).rows[0];
  const occupied = (await db.query(`SELECT count(*)::int AS n FROM bookings WHERE company_id = $1 AND status IN ('reserved', 'in_house', 'departed') AND arrival <= $2 AND departure > $2`,
    [companyId, day])).rows[0].n;
  return {
    day,
    arrivals: rows.filter((b) => b.status === 'reserved' && b.arrival === day),
    // Reserved, arrival day passed, guest not here: check in late, change the dates, or mark a no-show.
    notArrived: rows.filter((b) => b.status === 'reserved' && b.arrival < day),
    departures: rows.filter((b) => b.status === 'in_house' && b.departure <= day),
    inHouse: rows.filter((b) => b.status === 'in_house'),
    rooms: rooms.active, outOfService: rooms.out, occupied,
    occupancy: rooms.active ? Math.round((occupied / rooms.active) * 100) : 0,
  };
}

/** The calendar: every room and the bookings overlapping `days` days from `from`. */
export async function calendar(db: Db, companyId: string, from: string, days = 14) {
  const to = addDays(date(from), Math.min(Math.max(days, 1), 62));
  const rooms = await listRooms(db, companyId);
  const bookings = (await db.query(`SELECT b.id, b.number, b.status, b.room_id AS "roomId", c.name AS guest, b.arrival::text AS arrival, b.departure::text AS departure
    FROM bookings b JOIN contacts c ON c.id = b.contact_id
    WHERE b.company_id = $1 AND b.status IN ('reserved', 'in_house', 'departed') AND b.arrival < $3 AND b.departure > $2 ORDER BY b.arrival`, [companyId, from, to])).rows;
  return { from, to, nights: nights(from, to), rooms: rooms.filter((r) => r.status !== 'retired'), bookings };
}

// ------------------------------------------------------------------ refundable security deposits (0045)
// Held in 2150 Guest deposits held, no VAT, no invoice. Returned to the guest, or used to pay the guest's invoice.
const METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'];
export interface DepositInput { amount?: string; date?: string; accountId?: string; method?: string; reference?: string | null; documentId?: string }

async function depositContext(db: Db, bookingId: string) {
  const b = (await db.query(`SELECT b.company_id AS "companyId", b.contact_id AS "contactId", b.number, c.name AS guest,
      (SELECT id FROM accounts WHERE company_id = b.company_id AND code = '2150') AS "depositAccount", booking_deposit_held(b.id)::text AS held
    FROM bookings b JOIN contacts c ON c.id = b.contact_id WHERE b.id = $1`, [bookingId])).rows[0] ?? notFound();
  if (!b.depositAccount) bad("This client's chart of accounts has no account 2150 Guest deposits held.", 'err.chart');
  return b as { companyId: string; contactId: string; number: string; guest: string; depositAccount: string; held: string };
}
function depositAmount(v: unknown): bigint {
  const s = String(v ?? '').replace(/,/g, '').trim();
  try { const m = toMinor(s); if (m > 0n) return m; } catch { /* below */ }
  return bad('Enter the amount, above 0.', 'err.amount');
}
async function insertDeposit(db: Db, b: { companyId: string }, bookingId: string, kind: string, amount: bigint, date: string, x: DepositInput, entryId: string,
  extra: { documentId?: string; paymentId?: string } = {}) {
  return (await db.query(`INSERT INTO booking_deposits (company_id, booking_id, kind, amount, entry_date, account_id, method, reference, document_id, payment_id, journal_entry_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_user_id()) RETURNING id`,
    [b.companyId, bookingId, kind, fromMinor(amount), date, x.accountId, METHODS.includes(String(x.method)) ? x.method : 'cash', txt(x.reference, 80),
      extra.documentId ?? null, extra.paymentId ?? null, entryId])).rows[0].id as string;
}

/** The guest leaves a deposit: Dr bank or cash / Cr 2150 Guest deposits held. */
export async function takeDeposit(db: Db, bookingId: string, x: DepositInput): Promise<string> {
  const b = await depositContext(db, bookingId);
  const amount = depositAmount(x.amount), d = x.date ? date(x.date) : today();
  if (!x.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const a = fromMinor(amount);
  const entry = await postEntry(db, { companyId: b.companyId, entryDate: d, memo: `Deposit held · ${b.number} · ${b.guest}`, sourceType: 'booking_deposit', sourceId: bookingId,
    lines: [{ accountId: x.accountId!, debit: a }, { accountId: b.depositAccount, credit: a }] });
  return insertDeposit(db, b, bookingId, 'taken', amount, d, x, entry);
}

/** The deposit (or part) goes back to the guest: Dr 2150 / Cr bank or cash. */
export async function returnDeposit(db: Db, bookingId: string, x: DepositInput): Promise<string> {
  const b = await depositContext(db, bookingId);
  const amount = depositAmount(x.amount ?? b.held), d = x.date ? date(x.date) : today();
  if (amount > toMinor(b.held)) bad(`The booking holds only ${b.held} as deposit.`, 'err.depositTooMuch');
  if (!x.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const a = fromMinor(amount);
  const entry = await postEntry(db, { companyId: b.companyId, entryDate: d, memo: `Deposit returned · ${b.number} · ${b.guest}`, sourceType: 'booking_deposit', sourceId: bookingId,
    lines: [{ accountId: b.depositAccount, debit: a }, { accountId: x.accountId!, credit: a }] });
  return insertDeposit(db, b, bookingId, 'returned', amount, d, x, entry);
}

/** The deposit pays the guest's invoice: the deposit is returned from the account and, in the same step, received
 *  from the guest against the invoice (Dr 2150 / Cr bank, then Dr bank / Cr Receivables). At most what the invoice
 *  still owes and what the booking holds. */
export async function applyDeposit(db: Db, bookingId: string, x: DepositInput): Promise<string> {
  const b = await depositContext(db, bookingId);
  if (!x.documentId) bad('Choose the invoice the deposit pays.', 'err.depositInvoice');
  if (!x.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const inv = (await db.query(`SELECT d.status, d.type, d.contact_id, document_amount_due(d.id)::text AS due FROM documents d WHERE d.id = $1 AND d.company_id = $2`,
    [x.documentId, b.companyId])).rows[0] ?? notFound();
  if (inv.type !== 'invoice' || inv.status !== 'issued' || inv.contact_id !== b.contactId) bad("A deposit pays only an issued invoice of the same guest.", 'err.depositInvoice');
  const held = toMinor(b.held), due = toMinor(inv.due);
  const amount = x.amount ? depositAmount(x.amount) : (held < due ? held : due);
  if (amount <= 0n) bad('Nothing to pay: the invoice is paid or no deposit is held.', 'err.depositNothing');
  if (amount > held) bad(`The booking holds only ${b.held} as deposit.`, 'err.depositTooMuch');
  if (amount > due) bad(`The invoice owes only ${inv.due}.`, 'err.overAllocated');
  const d = x.date ? date(x.date) : today(), a = fromMinor(amount);
  const entry = await postEntry(db, { companyId: b.companyId, entryDate: d, memo: `Deposit used to pay the bill · ${b.number} · ${b.guest}`, sourceType: 'booking_deposit', sourceId: bookingId,
    lines: [{ accountId: b.depositAccount, debit: a }, { accountId: x.accountId!, credit: a }] });
  const paymentId = await recordPayment(db, b.companyId, { direction: 'received', contactId: b.contactId, date: d, amount: a, accountId: x.accountId, method: 'other',
    reference: `Deposit ${b.number}`, allocations: [{ documentId: x.documentId!, amount: a }] });
  return insertDeposit(db, b, bookingId, 'applied', amount, d, { ...x, method: 'other' }, entry, { documentId: x.documentId, paymentId });
}

export async function deposits(db: Db, bookingId: string) {
  const rows = (await db.query(`SELECT k.id, k.kind, k.amount::text AS amount, k.entry_date::text AS date, a.code AS "accountCode", a.name AS "accountName", k.method, k.reference,
      k.document_id AS "documentId", d.number AS "documentNumber" FROM booking_deposits k JOIN accounts a ON a.id = k.account_id LEFT JOIN documents d ON d.id = k.document_id
    WHERE k.booking_id = $1 ORDER BY k.created_at`, [bookingId])).rows;
  const held = (await db.query('SELECT booking_deposit_held($1)::text AS h', [bookingId])).rows[0].h as string;
  return { held, movements: rows };
}

// ------------------------------------------------------------------ advance payments (0046)
/** The guest pays part of the stay in advance: an advance-payment invoice (ZATCA 386, with VAT, on 2160 Customer
 *  advances) issued and paid at once. It comes off the guest bill when the stay is billed. Returns the invoice. */
export async function takeAdvance(db: Db, bookingId: string, x: { amount?: string; date?: string; accountId?: string; method?: string; reference?: string | null }): Promise<string> {
  const b = (await db.query(`SELECT b.company_id, b.contact_id, b.number, b.status, b.arrival::text AS arrival, b.departure::text AS departure, r.number AS room
    FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.id = $1`, [bookingId])).rows[0] ?? notFound();
  if (!['reserved', 'in_house'].includes(b.status)) bad('This booking is finished and no longer changes.', 'err.roomFinished');
  if (!x.accountId) bad('Choose the bank or cash account.', 'err.bankAccount');
  const doc = await Adv.createAdvance(db, b.company_id, { contactId: b.contact_id, amount: x.amount, date: x.date,
    description: `Advance for booking ${b.number}, room ${b.room}, ${b.arrival} to ${b.departure}`,
    payment: { accountId: x.accountId, method: x.method, reference: x.reference ?? `Advance ${b.number}` } });
  await db.query('INSERT INTO booking_advances (booking_id, document_id, company_id) VALUES ($1, $2, $3)', [bookingId, doc, b.company_id]);
  return doc;
}
/** The booking's advances: each advance invoice, its total with VAT, and what is left to deduct (with VAT). */
export async function bookingAdvances(db: Db, bookingId: string) {
  return (await db.query(`SELECT d.id AS "documentId", d.number, d.issue_date::text AS date, d.gross_total::text AS total, l.net::text AS "leftNet",
      (l.net + l.vat)::text AS "left", document_amount_due(d.id)::text AS due
    FROM booking_advances k JOIN documents d ON d.id = k.document_id CROSS JOIN LATERAL advance_left(d.id) l
    WHERE k.booking_id = $1 ORDER BY d.issue_date, d.number`, [bookingId])).rows as { documentId: string; number: string; date: string; total: string; leftNet: string; left: string; due: string }[];
}
