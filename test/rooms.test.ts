// Rooms (db/migrations/0044, src/books/roomService.ts): room types with VAT-inclusive rates and seasons, rooms,
// bookings never twice on the same night, check-in and check-out, extras, and the guest bill into an ordinary invoice
// on 4200 Room revenue, each night and extra billed once. Company A is Saudi (15% VAT).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as R from '../src/books/roomService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let dlx: string, std: string, r101: string, r102: string, r103: string, guest: string, stay: string;
const bal = async (code: string) => (await owner.query(`SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l
  JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.code = $2`, [f.a.id, code])).rows[0].v;
const doc = async (id: string) => (await owner.query(`SELECT d.status, d.net_total::text AS net, d.vat_total::text AS vat, d.gross_total::text AS gross, d.issue_date::text AS date,
  (SELECT json_agg(json_build_object('d', l.description, 'q', l.quantity::text, 'p', l.unit_price::text) ORDER BY l.line_no) FROM document_lines l WHERE l.document_id = d.id) AS lines
  FROM documents d WHERE d.id = $1`, [id])).rows[0];

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['4200', 'Room revenue', 'income']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
});

describe('Setup', () => {
  it('room types carry a nightly rate with VAT and go to 4200 Room revenue; rooms have a number and a type', async () => {
    await expect(as(f.staff, (db) => R.saveType(db, f.a.id, { code: 'DLX', name: 'Deluxe' }))).rejects.toThrow(/nightly rate/);
    dlx = await as(f.staff, (db) => R.saveType(db, f.a.id, { code: 'DLX', name: 'Deluxe', nameAr: 'ديلوكس', capacity: 2, rate: '575.00' }));
    std = await as(f.staff, (db) => R.saveType(db, f.a.id, { code: 'STD', name: 'Standard', capacity: 3, rate: '450.00' }));
    r101 = await as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '101', typeId: dlx, floor: '1' }));
    r102 = await as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '102', typeId: std, floor: '1' }));
    r103 = await as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '103', typeId: std, floor: '1' }));
    await expect(as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '101', typeId: std }))).rejects.toThrow(/Another room/);
    const types = await as(f.staff, (db) => R.listTypes(db, f.a.id));
    expect(types.find((t) => t.id === dlx)).toMatchObject({ rate: '575.00', incomeAccountCode: '4200', rooms: 1 });
    await expect(as(f.a.clientViewer, (db) => R.saveRoom(db, f.a.id, { number: '999', typeId: std }))).rejects.toThrow();
  });

  it('seasons change the rate between two dates and never overlap for a room type', async () => {
    await as(f.staff, (db) => R.saveSeason(db, f.a.id, { typeId: std, name: 'Winter', from: '2027-01-10', to: '2027-01-20', rate: '690.00' }));
    await expect(as(f.staff, (db) => R.saveSeason(db, f.a.id, { typeId: std, from: '2027-01-15', to: '2027-01-25', rate: '700.00' }))).rejects.toThrow(/exclusion/);
  });
});

describe('Bookings', () => {
  it('a new guest is made a customer; numbered BKG-; a room is never booked twice on the same night', async () => {
    stay = await as(f.staff, (db) => R.createBooking(db, f.a.id, { guest: { name: 'Ahmed Saleh', phone: '0500000000' }, roomId: r102, arrival: '2027-01-08', departure: '2027-01-12', adults: 2 }));
    const b = await as(f.staff, (db) => R.getBooking(db, stay));
    expect(b).toMatchObject({ number: 'BKG-0001', status: 'reserved', guest: 'Ahmed Saleh', room: '102', nights: 4 });
    guest = b.contactId;
    await expect(as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r102, arrival: '2027-01-11', departure: '2027-01-13' }))).rejects.toThrow(/exclusion/);
    // Departure day is free for the next guest; another room is free too.
    const next = await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r102, arrival: '2027-01-12', departure: '2027-01-13' }));
    await as(f.staff, (db) => R.cancel(db, next));
    // A cancelled booking frees the room.
    await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r102, arrival: '2027-01-12', departure: '2027-01-14' }));
    await expect(as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r101, arrival: '2027-01-12', departure: '2027-01-12' }))).rejects.toThrow(/at least one night/);
    await expect(as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r101, arrival: '2027-02-01', departure: '2027-02-02', adults: 3 }))).rejects.toThrow(/at most 2 guests/);
  });

  it('the bill preview prices each night from the rate with VAT, seasons included, and shows the difference to the quoted price', async () => {
    const b = await as(f.staff, (db) => R.getBooking(db, stay));
    // 8 and 9 January at 450.00, 10 and 11 January at the winter 690.00.
    expect(b.unbilled.lines.map((l: { quantity: string; unitPrice: string }) => [l.quantity, l.unitPrice])).toEqual([['2', '391.30'], ['2', '600.00']]);
    expect(b.unbilled).toMatchObject({ quoted: '2280.00', total: '2279.99', difference: '-0.01' });
  });

  it('check-in from the arrival day only; a room out of service refuses it', async () => {
    await expect(as(f.staff, (db) => R.checkIn(db, stay, '2027-01-07'))).rejects.toThrow(/from the arrival day/);
    await as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '102', typeId: std, floor: '1', status: 'out_of_service' }, r102));
    await expect(as(f.staff, (db) => R.checkIn(db, stay, '2027-01-08'))).rejects.toThrow(/not in service/);
    await as(f.staff, (db) => R.saveRoom(db, f.a.id, { number: '102', typeId: std, floor: '1', status: 'active' }, r102));
    await as(f.staff, (db) => R.checkIn(db, stay, '2027-01-08'));
    expect((await as(f.staff, (db) => R.getBooking(db, stay))).status).toBe('in_house');
    await expect(as(f.staff, (db) => R.cancel(db, stay))).rejects.toThrow(/Only a reserved booking/);
  });
});

describe('The guest bill', () => {
  let first: string;
  it('billing part of a stay makes a draft invoice for those nights and the extras; nothing is billed twice', async () => {
    await as(f.staff, (db) => R.addExtra(db, stay, { date: '2027-01-09', description: 'Laundry', quantity: '3', unitPrice: '23.00' }));
    first = await as(f.staff, (db) => R.bill(db, stay, { upTo: '2027-01-10', issueDate: '2027-01-10' }));
    const d = await doc(first);
    expect(d).toMatchObject({ status: 'draft', net: '842.60', vat: '126.39', gross: '968.99' });   // 2 x 391.30 + 3 x 20.00
    expect(d.lines.map((l: { q: string; p: string }) => [l.q, l.p])).toEqual([['2.000', '391.30'], ['3.000', '20.00']]);
    expect(d.lines[0].d).toContain('Room 102 (Standard), 2 nights 2027-01-08 to 2027-01-10, 450.00 a night incl. VAT');
    const b = await as(f.staff, (db) => R.getBooking(db, stay));
    expect(b.billedTo).toBe('2027-01-10');
    expect(b.extras[0].billed).toBe(true);
    expect(b.unbilled.lines).toHaveLength(1);                 // only the winter nights are left
    await expect(as(f.staff, (db) => R.deleteExtra(db, b.extras[0].id))).rejects.toThrow(/has been billed/);
    await expect(as(f.staff, (db) => R.updateBooking(db, stay, { departure: '2027-01-09' }))).rejects.toThrow(/before the nights already billed/);
  });

  it('deleting the draft invoice frees its nights and extras again', async () => {
    await as(f.staff, (db) => S.deleteDraft(db, first));
    const b = await as(f.staff, (db) => R.getBooking(db, stay));
    expect(b.billedTo).toBeNull();
    expect(b.extras[0].billed).toBe(false);
    expect(b.unbilled.lines).toHaveLength(3);
  });

  it('checking out early shortens the stay, bills the rest, issues the invoice and posts it to 4200 Room revenue and VAT', async () => {
    const before = { rev: await bal('4200'), vat: await bal('2100') };
    const reserved = await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r103, arrival: '2027-03-01', departure: '2027-03-02' }));
    await expect(as(f.staff, (db) => R.checkOut(db, reserved))).rejects.toThrow(/Only a guest in house/);
    const inv = await as(f.staff, (db) => R.checkOut(db, stay, { day: '2027-01-11' }));   // planned to leave on the 12th
    const b = await as(f.staff, (db) => R.getBooking(db, stay));
    expect(b).toMatchObject({ status: 'departed', departure: '2027-01-11', nights: 3, billedTo: '2027-01-11' });
    const d = await doc(inv!);
    // 2 x 391.30 + 1 x 600.00 (winter) + 3 x 20.00 laundry = 1,442.60 + VAT 216.39 (117.39 + 90.00 + 9.00)
    expect(d).toMatchObject({ status: 'issued', date: '2027-01-11', net: '1442.60', vat: '216.39', gross: '1658.99' });
    expect(Number(await bal('4200')) - Number(before.rev)).toBeCloseTo(1442.6, 2);
    expect(Number(await bal('2100')) - Number(before.vat)).toBeCloseTo(216.39, 2);
    await expect(as(f.staff, (db) => R.addExtra(db, stay, { description: 'Minibar', unitPrice: '10.00' }))).rejects.toThrow(/finished/);
    await expect(as(f.staff, (db) => R.updateBooking(db, stay, { notes: 'x' }))).rejects.toThrow(/finished/);
  });

  it('the database refuses checking out with nights or extras not billed', async () => {
    const id = await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r101, arrival: '2027-04-01', departure: '2027-04-03' }));
    await as(f.staff, (db) => R.checkIn(db, id, '2027-04-01'));
    await expect(as(f.staff, (db) => db.query(`UPDATE bookings SET status = 'departed' WHERE id = $1`, [id]))).rejects.toThrow(/Bill every night/);
    await as(f.staff, (db) => R.bill(db, id, { issueDate: '2027-04-01' }));
    await as(f.staff, (db) => R.addExtra(db, id, { description: 'Minibar', unitPrice: '11.50' }));
    await expect(as(f.staff, (db) => db.query(`UPDATE bookings SET status = 'departed' WHERE id = $1`, [id]))).rejects.toThrow(/Bill every extra/);
    const inv = await as(f.staff, (db) => R.checkOut(db, id, { day: '2027-04-03', issue: false }));
    expect((await doc(inv!)).status).toBe('draft');           // the extra only, left as a draft when asked
  });
});

describe('Front desk, calendar and separation', () => {
  it('front desk lists arrivals, guests in house and occupancy; the calendar shows the bookings of the rooms', async () => {
    const a = await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r101, arrival: '2027-05-01', departure: '2027-05-04' }));
    const fd = await as(f.staff, (db) => R.frontDesk(db, f.a.id, '2027-05-01'));
    expect(fd.arrivals.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(fd.notArrived.map((x: { arrival: string }) => x.arrival).sort()).toEqual(['2027-01-12', '2027-03-01']);   // earlier reservations never checked in
    expect(fd).toMatchObject({ rooms: 3, occupied: 1, occupancy: 33 });
    const cal = await as(f.staff, (db) => R.calendar(db, f.a.id, '2027-04-28', 7));
    expect(cal.rooms.map((r: { number: string }) => r.number)).toEqual(['101', '102', '103']);
    expect(cal.bookings.map((x: { id: string }) => x.id)).toContain(a);
  });

  it('no-show only from the arrival day; other companies see nothing; view-only people change nothing', async () => {
    const id = await as(f.staff, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r103, arrival: '2027-06-01', departure: '2027-06-02' }));
    await expect(as(f.staff, (db) => R.noShow(db, id, '2027-05-31'))).rejects.toThrow(/from the arrival day/);
    await as(f.staff, (db) => R.noShow(db, id, '2027-06-01'));
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM bookings'))).rows).toHaveLength(0);
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM room_types'))).rows).toHaveLength(0);
    await expect(as(f.a.clientViewer, (db) => R.createBooking(db, f.a.id, { contactId: guest, roomId: r103, arrival: '2027-07-01', departure: '2027-07-02' }))).rejects.toThrow();
    await expect(as(f.staff, (db) => db.query('DELETE FROM bookings WHERE id = $1', [id]))).rejects.toThrow();
  });
});
