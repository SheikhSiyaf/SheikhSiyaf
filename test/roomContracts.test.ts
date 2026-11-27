// Rooms contract options (db/migrations/0095, src/books/roomContractService.ts): Type A short stay (guest identity checked and kept as
// details only, never a copy of an ID; restricted to people who may see it; registration record export; maximum stay; extra charge lines;
// cancellation terms) and Type B long-term rental (Ejar status and warning, signing, addenda, renewal alerts and notice, rent freeze,
// payment schedule billed as ordinary invoices, the registered contract PDF). Company A is Saudi (15% VAT).
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as R from '../src/books/roomService.js';
import * as RC from '../src/books/roomContractService.js';

let f: Fixture;
let std: string, r1: string, r2: string, r3: string, r4: string, r5: string, r6: string;
const ID = { idType: 'iqama', idNumber: '2123456789', nationality: 'Egyptian', verifiedBy: 'Huda (front desk)' };
const guest = { name: 'Contract Guest', phone: '0500000001' };
const RENTAL = { landlordName: 'Tower Owner Co', landlordIdType: 'national_id', landlordIdNumber: '1000000001', tenantIdType: 'iqama', tenantIdNumber: '2000000002',
  property: 'Tower 1', city: 'Riyadh', rent: '3000.00', rentPeriod: 'monthly', deposit: '3000.00', vatCode: 'exempt', ejarStatus: 'not_registered', ejarNumber: undefined as string | undefined };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64');
const staff = <T>(fn: (db: Parameters<Parameters<typeof as>[1]>[0]) => Promise<T>) => as(f.staff, fn);
const partner = <T>(fn: (db: Parameters<Parameters<typeof as>[1]>[0]) => Promise<T>) => as(f.partner, fn);
const stay = (roomId: string, arrival: string, departure: string, more: Partial<R.BookingInput> = {}) =>
  staff((db) => R.createBooking(db, f.a.id, { guest, roomId, arrival, departure, ...more }));
const rental = (roomId: string, arrival: string, departure: string, rent: Partial<typeof RENTAL> = {}) =>
  staff((db) => R.createBooking(db, f.a.id, { guest: { name: 'Tenant ' + roomId.slice(0, 4) }, roomId, arrival, departure, contractType: 'long_term', rental: { ...RENTAL, ...rent } }));

beforeAll(async () => {
  f = await seed();
  for (const [code, name, type] of [['1100', 'Receivables', 'asset'], ['1200', 'Input VAT', 'asset'], ['2000', 'Payables', 'liability'], ['4200', 'Room revenue', 'income']]) {
    if (!(await owner.query('SELECT 1 FROM accounts WHERE company_id = $1 AND code = $2', [f.a.id, code])).rows[0]) await owner.query('INSERT INTO accounts (company_id, code, name, type) VALUES ($1,$2,$3,$4)', [f.a.id, code, name, type]);
  }
  std = await staff((db) => R.saveType(db, f.a.id, { code: 'STD', name: 'Standard', capacity: 4, rate: '575.00' }));
  const rooms = await Promise.all(['301', '302', '303', '304', '305', '306'].map((n) => staff((db) => R.saveRoom(db, f.a.id, { number: n, typeId: std }))));
  [r1, r2, r3, r4, r5, r6] = rooms as [string, string, string, string, string, string];
});

describe('Contract type', () => {
  it('a booking is a short stay by default; an unknown type is refused; a rental needs its contract details', async () => {
    const id = await stay(r1, '2028-01-10', '2028-01-12');
    expect((await staff((db) => R.getBooking(db, id))).contractType).toBe('short_stay');
    await expect(stay(r1, '2028-02-10', '2028-02-12', { contractType: 'timeshare' })).rejects.toThrow(/contract type/);
    await expect(stay(r1, '2028-02-10', '2028-02-12', { contractType: 'long_term' })).rejects.toThrow(/contract details/);
  });
  it('only an administrator changes the contract type, and only before contract details are saved', async () => {
    const id = await stay(r1, '2028-03-01', '2028-03-03');
    await expect(staff((db) => RC.changeContractType(db, id, 'long_term'))).rejects.toThrow(/administrator/);
    await partner((db) => RC.changeContractType(db, id, 'long_term'));
    await partner((db) => RC.changeContractType(db, id, 'short_stay'));
    await staff((db) => RC.saveGuestCheck(db, id, ID));
    await expect(partner((db) => RC.changeContractType(db, id, 'long_term'))).rejects.toThrow(/contract details are saved/);
  });
});

describe('Short stay: the guest identity check', () => {
  it('a booking can be reserved before arrival; check-in needs the identity details', async () => {
    const id = await stay(r2, '2028-01-10', '2028-01-12');
    await expect(staff((db) => R.checkIn(db, id, '2028-01-10'))).rejects.toThrow(/Check the guest identity/);
    await staff((db) => RC.saveGuestCheck(db, id, ID));
    await staff((db) => R.checkIn(db, id, '2028-01-10'));
    expect((await staff((db) => R.getBooking(db, id))).status).toBe('in_house');
  });
  it('every detail is needed: type, number, nationality and who verified it (the time is taken when saved)', async () => {
    const id = await stay(r2, '2028-02-10', '2028-02-12');
    const gaps = async (x: RC.GuestCheckInput) => (await staff((db) => RC.saveGuestCheck(db, id, x)).catch((e) => e)).details;
    expect(await gaps({})).toEqual(['idType', 'idNumber', 'nationality', 'verifiedBy']);
    expect(await gaps({ ...ID, idType: 'driving_licence' })).toEqual(['idType']);
    expect(await gaps({ ...ID, nationality: ' ' })).toEqual(['nationality']);
    for (const t of ['national_id', 'iqama', 'passport', 'moi_digital']) await staff((db) => RC.saveGuestCheck(db, id, { ...ID, idType: t }));
    const g = await staff((db) => RC.getGuestCheck(db, id));
    expect(g).toMatchObject({ restricted: false, check: { idType: 'moi_digital', idNumber: '2123456789', verifiedBy: 'Huda (front desk)' } });
    expect(new Date((g as { check: { verifiedAt: string } }).check.verifiedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
  it('identity given at booking time must be complete; a partial one blocks saving the booking', async () => {
    const before = (await owner.query('SELECT count(*)::int AS n FROM bookings WHERE company_id = $1', [f.a.id])).rows[0].n;
    await expect(stay(r3, '2028-01-10', '2028-01-12', { guestCheck: { idType: 'iqama' } })).rejects.toThrow(/Complete these details/);
    expect((await owner.query('SELECT count(*)::int AS n FROM bookings WHERE company_id = $1', [f.a.id])).rows[0].n).toBe(before);
    const ok = await stay(r3, '2028-01-10', '2028-01-12', { guestCheck: ID });
    expect((await staff((db) => RC.getGuestCheck(db, ok)))).toMatchObject({ check: { idNumber: '2123456789' } });
  });
  it('no copy of an ID is stored anywhere: no file column, no attachment on a short stay', async () => {
    const cols = (await owner.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'booking_guest_checks'`)).rows;
    expect(cols.some((c) => c.data_type === 'bytea' || /file|photo|image|scan|copy/i.test(c.column_name))).toBe(false);
    const id = await stay(r3, '2028-04-10', '2028-04-12');
    await expect(staff((db) => RC.addContractFile(db, id, { fileName: 'id.pdf', data: PDF }))).rejects.toThrow(/Never attach a copy of an ID/);
    await expect(owner.query(`INSERT INTO attachments (company_id, booking_id, file_name, content_type, size_bytes, uploaded_by) VALUES ($1,$2,'id.pdf','application/pdf',10,$3)`, [f.a.id, id, f.staff]))
      .rejects.toThrow(/Never attach a copy of an ID/);
  });
  it('the audit log keeps the identity details without the full ID number', async () => {
    const id = await stay(r3, '2028-05-10', '2028-05-12');
    await staff((db) => RC.saveGuestCheck(db, id, { ...ID, idNumber: '1098765432' }));
    const rows = (await owner.query(`SELECT detail::text AS d FROM audit_log WHERE table_name = 'booking_guest_checks' AND company_id = $1 AND detail::text LIKE '%5432%'`, [f.a.id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.d.includes('1098765432') && r.d.includes('****5432'))).toBe(true);
  });
  it('guest names, room numbers and identity are shown only to people allowed to see them', async () => {
    const id = await stay(r4, '2028-01-10', '2028-01-12');
    await staff((db) => RC.saveGuestCheck(db, id, ID));
    const seen = await staff((db) => R.getBooking(db, id));
    expect(seen).toMatchObject({ guest: 'Contract Guest', room: '304' });
    const hidden = await as(f.a.clientViewer, (db) => R.getBooking(db, id));
    expect(hidden).toMatchObject({ guest: null, room: null, restricted: true });
    const list = await as(f.a.clientViewer, (db) => R.listBookings(db, f.a.id, {}));
    expect(list.every((b) => b.guest === null && b.room === null)).toBe(true);
    expect(await as(f.a.clientViewer, (db) => RC.getGuestCheck(db, id))).toEqual({ restricted: true });
    expect((await owner.query('SELECT 1 FROM booking_guest_checks WHERE booking_id = $1', [id])).rowCount).toBe(1);   // it exists; the viewer's row-level security hides it
    expect((await as(f.a.clientViewer, (db) => db.query('SELECT id FROM booking_guest_checks'))).rowCount).toBe(0);
  });
});

describe('Registration record', () => {
  it('lists the stays with their identity details, logs the export, and is closed to people without permission', async () => {
    const rows = (await staff((db) => RC.registrationRecord(db, f.a.id, { from: '2028-01-01', to: '2028-01-31' }))).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ idType: expect.any(String), idNumber: expect.any(String), nationality: expect.any(String), verifiedBy: expect.any(String), guests: expect.any(Number) });
    expect((await owner.query(`SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'booking_guest_checks' AND action = 'export'`, [f.a.id])).rowCount).toBeGreaterThan(0);
    await expect(as(f.a.clientViewer, (db) => RC.registrationRecord(db, f.a.id))).rejects.toThrow(/does not allow/);
  });
  it('the CSV neutralises spreadsheet formulas and quotes commas', () => {
    const csv = RC.registrationCsv([{ booking: 'BKG-1', checkIn: '2028-01-10', checkOut: '2028-01-12', guests: 2, guest: '=HYPERLINK("x")', room: '1', idType: 'iqama', idNumber: '1', nationality: 'A, B', verifiedBy: 'x', verifiedAt: 'y' }]);
    expect(csv).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csv).toContain('"A, B"');
    expect(csv.startsWith('﻿')).toBe(true);
  });
});

describe('Short stay: settings', () => {
  it('the maximum stay is off by default, and only an administrator sets it', async () => {
    expect((await staff((db) => RC.getSettings(db, f.a.id))).maxStayDays).toBeNull();
    await stay(r5, '2028-06-01', '2028-08-01');   // 61 nights, no limit
    await expect(staff((db) => RC.saveSettings(db, f.a.id, { maxStayDays: 3 }))).rejects.toThrow(/administrator/);
    await partner((db) => RC.saveSettings(db, f.a.id, { maxStayDays: 3 }));
    await expect(stay(r6, '2028-06-01', '2028-06-05')).rejects.toThrow(/at most 3 days/);
    await stay(r6, '2028-06-01', '2028-06-04');
    await partner((db) => RC.saveSettings(db, f.a.id, { maxStayDays: null }));
    await stay(r6, '2028-07-01', '2028-07-20');
  });
  it('extra charge lines: administrator only, no rate built in, off until an account is chosen; the guest sees tax as its own line', async () => {
    expect((await staff((db) => RC.listCharges(db, f.a.id)))).toEqual([]);
    await expect(staff((db) => RC.saveCharge(db, f.a.id, { name: 'Tourism charge', rate: '2.5' }))).rejects.toThrow(/administrator/);
    await expect(partner((db) => RC.saveCharge(db, f.a.id, { name: 'Tourism charge', rate: '2.5', active: true }))).rejects.toThrow(/account/);
    await expect(partner((db) => RC.saveCharge(db, f.a.id, { name: 'Tourism charge', rate: '140' }))).rejects.toThrow(/0 to 100/);
    const payables = (await owner.query(`INSERT INTO accounts (company_id, code, name, type) VALUES ($1, '4210', 'Tourism charge', 'income') ON CONFLICT (company_id, code) DO UPDATE SET name = excluded.name RETURNING id`, [f.a.id])).rows[0].id;
    const cid = await partner((db) => RC.saveCharge(db, f.a.id, { name: 'Tourism charge', rate: '2.5', active: true, accountId: payables, vatCode: 'out_of_scope' }));
    const bk = await stay(r1, '2028-09-01', '2028-09-03');   // 2 nights at 575 with VAT
    const rc = await staff((db) => R.guestReceipt(db, bk));
    expect(rc.lines.map((l) => l.label)).toEqual(['Room price before tax', 'Tax (15.00%)', 'Tourism charge']);
    expect(rc.lines.map((l) => l.amount)).toEqual(['1000.00', '150.00', '25.00']);
    expect(rc.total).toBe('1175.00');
    await staff((db) => RC.saveGuestCheck(db, bk, ID));
    const doc = await staff((db) => R.bill(db, bk, {}));
    const lines = (await owner.query(`SELECT description, unit_price::text AS p FROM document_lines WHERE document_id = $1 ORDER BY line_no`, [doc])).rows;
    expect(lines.map((l) => l.description)).toEqual([expect.stringMatching(/Room 301/), 'Tourism charge (2.500%)']);
    expect(lines[1].p).toBe('25.00');
    await partner((db) => RC.saveCharge(db, f.a.id, { name: 'Tourism charge', rate: '2.5', active: false, accountId: payables }, cid));   // switched off again
    expect(await staff((db) => RC.activeCharges(db, f.a.id))).toEqual([]);
  });
  it('cancellation and refund terms are fixed on the booking when it is made and shown on the receipt; later changes do not rewrite them', async () => {
    await partner((db) => RC.saveSettings(db, f.a.id, { cancellationEn: 'Free until 48 hours before arrival.', cancellationAr: 'إلغاء مجاني قبل 48 ساعة من الوصول.', governingLanguage: 'ar' }));
    const bk = await stay(r2, '2028-10-01', '2028-10-02');
    await partner((db) => RC.saveSettings(db, f.a.id, { cancellationEn: 'No refund.' }));
    const rc = await staff((db) => R.guestReceipt(db, bk));
    expect(rc).toMatchObject({ cancellationEn: 'Free until 48 hours before arrival.', cancellationAr: 'إلغاء مجاني قبل 48 ساعة من الوصول.', governingLanguage: 'ar' });
    expect((await staff((db) => R.getBooking(db, bk)))).toMatchObject({ cancellationEn: 'Free until 48 hours before arrival.' });
  });
  it('the Arabic text governs unless the administrator changes it', async () => {
    expect((await staff((db) => RC.getSettings(db, f.a.id))).governingLanguage).toBe('ar');
    await expect(partner((db) => RC.saveSettings(db, f.a.id, { governingLanguage: 'fr' }))).rejects.toThrow(/Arabic or English/);
    await partner((db) => RC.saveSettings(db, f.a.id, { governingLanguage: 'en' }));
    expect((await staff((db) => RC.getSettings(db, f.a.id))).governingLanguage).toBe('en');
    await partner((db) => RC.saveSettings(db, f.a.id, { governingLanguage: 'ar' }));
  });
});

describe('Long-term rental', () => {
  let bk: string;
  it('needs every contract detail and names what is missing; a registered contract needs its Ejar number', async () => {
    const e = await rental(r1, '2029-01-01', '2029-07-01', { landlordName: '', tenantIdNumber: '' }).catch((x) => x);
    expect(e.details).toEqual(['landlordName', 'tenantIdNumber']);
    const e2 = await rental(r1, '2029-01-01', '2029-07-01', { ejarStatus: 'registered' }).catch((x) => x);
    expect(e2.details).toEqual(['ejarNumber']);
    expect((await owner.query(`SELECT count(*)::int AS n FROM bookings WHERE room_id = $1 AND contract_type = 'long_term'`, [r1])).rows[0].n).toBe(0);
    bk = await rental(r1, '2029-01-01', '2029-07-01');
    expect(bk).toBeTruthy();
  });
  it('shows the Ejar warning until the contract is registered', async () => {
    expect(await staff((db) => RC.getContract(db, bk))).toMatchObject({ saved: true, warning: 'Rental contracts must be registered in Ejar.', ejarStatus: 'not_registered', signed: false });
    await staff((db) => RC.setEjar(db, bk, { status: 'pending' }));
    expect((await staff((db) => RC.getContract(db, bk)))).toMatchObject({ warning: 'Rental contracts must be registered in Ejar.' });
    await expect(staff((db) => RC.setEjar(db, bk, { status: 'registered' }))).rejects.toThrow(/Ejar contract number/);
    await staff((db) => RC.setEjar(db, bk, { status: 'registered', number: '10234567' }));
    expect(await staff((db) => RC.getContract(db, bk))).toMatchObject({ warning: null, ejarNumber: '10234567', lastRegisteredRent: '3000.00' });
  });
  it('signing locks the contract and makes the payment schedule; changes after that are by addendum only', async () => {
    await staff((db) => RC.signRental(db, bk));
    const c = await staff((db) => RC.getContract(db, bk));
    expect(c).toMatchObject({ signed: true });
    expect((c as { instalments: { due: string; amount: string }[] }).instalments.map((i) => i.due)).toEqual(['2029-01-01', '2029-02-01', '2029-03-01', '2029-04-01', '2029-05-01', '2029-06-01']);
    await expect(staff((db) => RC.saveRental(db, bk, { ...RENTAL, rent: '9999.00' }))).rejects.toThrow(/signed contract does not change/);
    await expect(owner.query(`UPDATE booking_tenancies SET rent = 1 WHERE booking_id = $1`, [bk])).rejects.toThrow(/signed contract does not change/);
    await expect(staff((db) => RC.signRental(db, bk))).rejects.toThrow(/already signed/);
  });
  it('rent is billed by instalment as an ordinary invoice, once; nights and extras are not used', async () => {
    const c = await staff((db) => RC.getContract(db, bk)) as { instalments: { id: string }[] };
    const doc = await staff((db) => RC.billInstalment(db, c.instalments[0]!.id));
    const d = (await owner.query(`SELECT status, net_total::text AS net, vat_total::text AS vat FROM documents WHERE id = $1`, [doc])).rows[0];
    expect(d).toMatchObject({ status: 'draft', net: '3000.00', vat: '0.00' });   // exempt
    await expect(staff((db) => RC.billInstalment(db, c.instalments[0]!.id))).rejects.toThrow(/already billed/);
    await expect(staff((db) => R.bill(db, bk, {}))).rejects.toThrow(/by instalment/);
    await expect(staff((db) => R.addExtra(db, bk, { description: 'Laundry', unitPrice: '10' }))).rejects.toThrow(/by instalment/);
    await expect(owner.query(`UPDATE booking_instalments SET amount = 1 WHERE id = $1`, [c.instalments[0]!.id])).rejects.toThrow(/billed/);
  });
  it('alerts 90 and 60 days before the end; none far from it', async () => {
    const at = (day: string) => staff((db) => RC.renewals(db, f.a.id, day));
    expect((await at('2029-02-01')).find((r) => r.id === bk)).toBeUndefined();            // 150 days
    expect((await at('2029-04-05')).find((r) => r.id === bk)).toMatchObject({ alert: 90, daysLeft: 87 });
    expect((await at('2029-05-15')).find((r) => r.id === bk)).toMatchObject({ alert: 60, renewsAutomatically: true });
    expect((await at('2029-08-01')).find((r) => r.id === bk)).toMatchObject({ alert: null, daysLeft: -31 });   // ended: expired
  });
  it('renews automatically unless a notice was recorded 60 or more days before the end, with who gave it', async () => {
    await expect(staff((db) => RC.recordNonRenewal(db, bk, { date: '2029-05-15', by: 'Tenant' }))).rejects.toThrow(/at least 60 days/);
    await expect(staff((db) => RC.recordNonRenewal(db, bk, { date: '2029-04-01', by: '' }))).rejects.toThrow(/who gave it/);
    await staff((db) => RC.recordNonRenewal(db, bk, { date: '2029-04-01', by: 'Tenant: B' }));
    expect(await staff((db) => RC.getContract(db, bk))).toMatchObject({ renewsAutomatically: false, nonrenewalDate: '2029-04-01', nonrenewalBy: 'Tenant: B' });
    await expect(owner.query(`UPDATE booking_tenancies SET nonrenewal_date = '2029-03-01' WHERE booking_id = $1`, [bk])).rejects.toThrow(/does not change/);
  });
  it('in a frozen city a rent above the last registered rent is blocked and the reason is shown; the list of cities is a setting', async () => {
    const add = (rent: string) => staff((db) => RC.addAddendum(db, bk, { effectiveDate: '2029-04-01', newRent: rent, reason: 'Yearly review' }));
    await expect(add('3000.01')).rejects.toThrow(/blocked in Riyadh.*3000\.00/);
    await add('2900.00');                                  // a lower rent is fine
    await expect(add('3000.01')).rejects.toThrow(/blocked in Riyadh/);
    await expect(partner((db) => RC.saveSettings(db, f.a.id, { frozenCities: ['Dammam'] }))).resolves.toBeUndefined();
    await add('3100.00');                                  // Riyadh is no longer on the list
    await partner((db) => RC.saveSettings(db, f.a.id, { frozenCities: ['Riyadh'] }));
    await expect(staff((db) => RC.saveSettings(db, f.a.id, { frozenCities: [] }))).rejects.toThrow(/administrator/);
  });
  it('a rent increase is also blocked by the database, not only the screen', async () => {
    const other = await rental(r2, '2029-01-01', '2029-04-01', { ejarStatus: 'registered', ejarNumber: '777' });
    await staff((db) => RC.signRental(db, other));
    await expect(owner.query(`INSERT INTO booking_addenda (company_id, booking_id, no, effective_date, new_rent, reason, created_by) VALUES ($1,$2,1,'2029-02-01',3500,'x',$3)`, [f.a.id, other, f.staff]))
      .rejects.toThrow(/Rent increases are blocked in Riyadh/);
    await expect(owner.query(`UPDATE booking_addenda SET reason = 'y' WHERE booking_id = $1`, [bk])).rejects.toThrow(/never changed/);
  });
  it('another city is not frozen, and an addendum that moves the end date moves the stay and the schedule', async () => {
    const jed = await rental(r3, '2029-01-01', '2029-04-01', { city: 'Jeddah', ejarStatus: 'registered', ejarNumber: '888' });
    await staff((db) => RC.signRental(db, jed));
    const first = (await staff((db) => RC.getContract(db, jed)) as { instalments: { id: string }[] }).instalments[0]!.id;
    await staff((db) => RC.billInstalment(db, first));
    await staff((db) => RC.addAddendum(db, jed, { effectiveDate: '2029-02-01', newRent: '4000.00', newEnd: '2029-06-01', reason: 'Extension and new rent' }));
    const c = await staff((db) => RC.getContract(db, jed)) as { instalments: { due: string; amount: string; documentId: string | null }[]; end: string; effectiveRent: string };
    expect(c.end).toBe('2029-06-01');
    expect(c.effectiveRent).toBe('4000.00');
    expect(c.instalments.map((i) => [i.due, i.amount])).toEqual([['2029-01-01', '3000.00'], ['2029-02-01', '4000.00'], ['2029-03-01', '4000.00'], ['2029-04-01', '4000.00'], ['2029-05-01', '4000.00']]);
    expect(c.instalments[0]!.documentId).toBeTruthy();      // the billed one stays as it was billed
    expect((await staff((db) => R.getBooking(db, jed))).departure).toBe('2029-06-01');
  });
  it('the registered Ejar contract is attached as a PDF only, and stays', async () => {
    await expect(staff((db) => RC.addContractFile(db, bk, { fileName: 'contract.png', data: PDF }))).rejects.toThrow(/as a PDF/);
    await expect(staff((db) => RC.addContractFile(db, bk, { fileName: 'contract.pdf', data: Buffer.from('not a pdf').toString('base64') }))).rejects.toThrow(/not a real PDF/);
    const fid = await staff((db) => RC.addContractFile(db, bk, { fileName: 'ejar-contract.pdf', data: PDF }));
    expect((await staff((db) => RC.getContract(db, bk)) as { files: { id: string }[] }).files.map((x) => x.id)).toContain(fid);
    await expect(owner.query('DELETE FROM attachments WHERE id = $1', [fid])).rejects.toThrow(/are kept/);
    await expect(owner.query(`INSERT INTO attachments (company_id, booking_id, file_name, content_type, size_bytes, uploaded_by) VALUES ($1,$2,'a.png','image/png',10,$3)`, [f.a.id, bk, f.staff])).rejects.toThrow(/attachments_booking_pdf_only/);
  });
  it('tenant and landlord identity is closed to people without permission; another company sees nothing', async () => {
    const hidden = await as(f.a.clientViewer, (db) => RC.getContract(db, bk)) as Record<string, unknown>;
    expect(hidden).toEqual({ restricted: true, saved: true, warning: null });   // no identity, no names, no figures
    expect((await as(f.a.clientViewer, (db) => db.query('SELECT id FROM booking_tenancies'))).rowCount).toBe(0);
    expect((await as(f.b.clientViewer, (db) => db.query('SELECT id FROM booking_tenancies'))).rowCount).toBe(0);
    expect((await as(f.b.clientViewer, (db) => db.query('SELECT id FROM booking_addenda'))).rowCount).toBe(0);
  });
  it('the audit log records tenancy changes with ID numbers cut to their last four characters', async () => {
    const rows = (await owner.query(`SELECT detail::text AS d FROM audit_log WHERE company_id = $1 AND table_name = 'booking_tenancies'`, [f.a.id])).rows;
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => !r.d.includes('2000000002') && !r.d.includes('1000000001'))).toBe(true);
    expect((await owner.query(`SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name IN ('booking_addenda', 'room_settings', 'room_charge_lines') GROUP BY table_name`, [f.a.id])).rowCount).toBe(3);
  });
  it('checking a rental out needs no nightly bill', async () => {
    const t = await rental(r4, '2029-01-01', '2029-03-01');
    await staff((db) => R.checkIn(db, t, '2029-01-01'));
    expect(await staff((db) => R.checkOut(db, t, { day: '2029-03-01' }))).toBeNull();
    expect((await staff((db) => R.getBooking(db, t))).status).toBe('departed');
  });
});
