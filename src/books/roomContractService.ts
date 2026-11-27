// Rooms contract options (db/migrations/0095): the settings, the optional extra charge lines, the guest identity check of a short
// stay (details only, never a copy of an ID), the rental contract of a long-term booking (Ejar status, signing, addenda, renewal
// notice, rent schedule) and the registration record. No government system is called: this builds the data and the export.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { fromMinor, toMinor } from '../money.js';
import { addDays as addDaysDoc } from './documents.js';
import { issueDocument, saveDraft } from './documentsService.js';
import * as C from './roomContracts.js';
import type { RegistrationRow } from './roomContractCsv.js';
export { registrationCsv, type RegistrationRow } from './roomContractCsv.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => new Date().toISOString().slice(0, 10);
const txt = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const amount = (v: unknown, what: string, allowZero = false): string => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  try { const m = toMinor(s); if (m > 0n || (allowZero && m === 0n && s !== '')) return fromMinor(m); } catch { /* below */ }
  return bad(`Enter ${what}.`, 'err.amount');
};
const missing = (fields: string[]): never => bad(`Complete these details first: ${fields.join(', ')}.`, 'err.roomContractMissing', fields);

// ------------------------------------------------------------------ who may see identity details
/** Guest and tenant identity (and guest names and room numbers) are for people who can post AND whose job title edits Rooms.
 *  Viewers and reviewers see the booking as restricted. */
export async function canSeeIdentity(db: Db, companyId: string): Promise<boolean> {
  const ok = (await db.query('SELECT app_has_role($1, posting_roles()) AS ok', [companyId])).rows[0]?.ok === true;
  if (!ok) return false;
  const r = (await db.query('SELECT permissions FROM app_client_role($1)', [companyId])).rows[0];
  return !r || r.permissions?.Rooms === 'edit';
}

// ------------------------------------------------------------------ settings and extra charge lines (administrator only)
export interface SettingsInput { maxStayDays?: number | string | null; governingLanguage?: string; frozenCities?: string[]; termsEn?: string | null; termsAr?: string | null;
  cancellationEn?: string | null; cancellationAr?: string | null }
export async function getSettings(db: Db, companyId: string) {
  const s = (await db.query(`SELECT max_stay_days AS "maxStayDays", governing_language AS "governingLanguage", frozen_cities AS "frozenCities", terms_en AS "termsEn", terms_ar AS "termsAr",
      cancellation_en AS "cancellationEn", cancellation_ar AS "cancellationAr" FROM room_settings WHERE company_id = $1`, [companyId])).rows[0]
    ?? { maxStayDays: null, governingLanguage: 'ar', frozenCities: C.DEFAULT_FROZEN_CITIES, termsEn: null, termsAr: null, cancellationEn: null, cancellationAr: null };
  return { ...s, charges: await listCharges(db, companyId) };
}
/** Settings, extra charge lines and contract types are changed only by the company administrator. */
export async function requireAdmin(db: Db, companyId: string): Promise<void> {
  if (!(await db.query('SELECT app_is_company_admin($1) AS ok', [companyId])).rows[0]?.ok) throw new HttpError(403, 'Only an administrator can change this.', 'err.roomAdminOnly');
}
export async function saveSettings(db: Db, companyId: string, x: SettingsInput): Promise<void> {
  await requireAdmin(db, companyId);
  const cur = await getSettings(db, companyId);
  const max = x.maxStayDays === undefined ? cur.maxStayDays : (x.maxStayDays === null || x.maxStayDays === '' || Number(x.maxStayDays) === 0 ? null : Number(x.maxStayDays));
  if (max !== null && !(Number.isInteger(max) && max >= 1 && max <= 3650)) bad('Enter the maximum stay as a whole number of days, or leave it empty for no limit.', 'err.roomMaxStay');
  const lang = x.governingLanguage === undefined ? cur.governingLanguage : x.governingLanguage;
  if (!['ar', 'en'].includes(String(lang))) bad('Choose the language that governs: Arabic or English.', 'err.roomLang');
  const cities = x.frozenCities === undefined ? cur.frozenCities : [...new Set(x.frozenCities.map((c) => String(c).trim()).filter(Boolean))].slice(0, 100);
  const pick = (k: keyof SettingsInput, max2: number) => (x[k] === undefined ? (cur as Record<string, unknown>)[k] as string | null : txt(x[k], max2));
  await db.query(`INSERT INTO room_settings (company_id, max_stay_days, governing_language, frozen_cities, terms_en, terms_ar, cancellation_en, cancellation_ar, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
    ON CONFLICT (company_id) DO UPDATE SET max_stay_days = $2, governing_language = $3, frozen_cities = $4, terms_en = $5, terms_ar = $6, cancellation_en = $7, cancellation_ar = $8, updated_at = now()`,
    [companyId, max, lang, cities, pick('termsEn', 20000), pick('termsAr', 20000), pick('cancellationEn', 5000), pick('cancellationAr', 5000)]);
}

export interface ChargeInput { name?: string; nameAr?: string | null; rate?: string; active?: boolean; accountId?: string | null; vatCode?: string }
export async function listCharges(db: Db, companyId: string) {
  return (await db.query(`SELECT id, name, name_ar AS "nameAr", rate::text AS rate, active, account_id AS "accountId", vat_code AS "vatCode"
    FROM room_charge_lines WHERE company_id = $1 ORDER BY name`, [companyId])).rows;
}
export async function saveCharge(db: Db, companyId: string, x: ChargeInput, id?: string): Promise<string> {
  await requireAdmin(db, companyId);
  const name = txt(x.name, 80) ?? bad('Name the charge (for example Tourism charge).', 'err.roomChargeName');
  const rate = String(x.rate ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(rate) || Number(rate) > 100) bad('Enter the rate as a percent from 0 to 100, with up to 3 decimals.', 'err.roomChargeRate');
  const active = x.active === true;
  if (active && !x.accountId) bad('Choose the account this charge posts to before switching it on.', 'err.roomChargeAccount');
  const vat = ['standard', 'zero', 'exempt', 'out_of_scope'].includes(String(x.vatCode)) ? x.vatCode : 'out_of_scope';
  const vals = [name, txt(x.nameAr, 80), rate, active, x.accountId || null, vat];
  if (id) return (await db.query(`UPDATE room_charge_lines SET name = $2, name_ar = $3, rate = $4, active = $5, account_id = $6, vat_code = $7 WHERE id = $1 RETURNING id`, [id, ...vals])).rows[0]?.id ?? notFound();
  return (await db.query(`INSERT INTO room_charge_lines (company_id, name, name_ar, rate, active, account_id, vat_code) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [companyId, ...vals])).rows[0].id;
}
/** The active extra charges, for the guest price and the bill. */
export async function activeCharges(db: Db, companyId: string) {
  return (await db.query(`SELECT id, name, name_ar AS "nameAr", rate::text AS rate, account_id AS "accountId", vat_code AS "vatCode" FROM room_charge_lines
    WHERE company_id = $1 AND active ORDER BY name`, [companyId])).rows as { id: string; name: string; nameAr: string | null; rate: string; accountId: string; vatCode: string }[];
}

/** What a booking agreed to, copied from the settings when it is made (changing the settings later never rewrites it). */
export async function termsSnapshot(db: Db, companyId: string) {
  const s = await getSettings(db, companyId);
  return { termsEn: s.termsEn as string | null, termsAr: s.termsAr as string | null, cancellationEn: s.cancellationEn as string | null, cancellationAr: s.cancellationAr as string | null,
    governingLanguage: s.governingLanguage as string };
}

// ------------------------------------------------------------------ Type A: the guest identity check
export interface GuestCheckInput { idType?: string; idNumber?: string; nationality?: string; verifiedBy?: string; verifiedAt?: string | null }
const KINDS = { short_stay: 'short_stay', long_term: 'long_term' } as const;

async function bookingFor(db: Db, bookingId: string) {
  return (await db.query(`SELECT company_id AS "companyId", contract_type AS "contractType", arrival::text AS arrival, departure::text AS departure, adults, children, status, number
    FROM bookings WHERE id = $1`, [bookingId])).rows[0] as { companyId: string; contractType: string; arrival: string; departure: string; adults: number; children: number; status: string; number: string } ?? notFound();
}

/** Saves the identity details of a short stay. Every detail is needed: the ID type, the number, the nationality, who verified and
 *  when (now, unless given). Nothing is uploaded or copied. */
export async function saveGuestCheck(db: Db, bookingId: string, x: GuestCheckInput): Promise<string> {
  const b = await bookingFor(db, bookingId);
  if (b.contractType !== KINDS.short_stay) bad('A guest identity check belongs to a short stay.', 'err.roomNotShortStay');
  const verifiedAt = x.verifiedAt ? new Date(x.verifiedAt).toISOString() : new Date().toISOString();
  const gaps = C.missingShortStay({ idType: x.idType, idNumber: x.idNumber, nationality: x.nationality, checkIn: b.arrival, checkOut: b.departure, guests: b.adults + b.children,
    verifiedBy: x.verifiedBy, verifiedAt });
  if (gaps.length) missing(gaps);
  const vals = [x.idType, txt(x.idNumber, 40), txt(x.nationality, 60), txt(x.verifiedBy, 120), verifiedAt];
  const r = await db.query(`INSERT INTO booking_guest_checks (company_id, booking_id, id_type, id_number, nationality, verified_by, verified_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7, app_user_id())
    ON CONFLICT (booking_id) DO UPDATE SET id_type = $3, id_number = $4, nationality = $5, verified_by = $6, verified_at = $7 RETURNING id`, [b.companyId, bookingId, ...vals]);
  return r.rows[0].id;
}
export async function getGuestCheck(db: Db, bookingId: string) {
  const b = await bookingFor(db, bookingId);
  if (!(await canSeeIdentity(db, b.companyId))) return { restricted: true as const };
  const r = (await db.query(`SELECT id_type AS "idType", id_number AS "idNumber", nationality, verified_by AS "verifiedBy", verified_at AS "verifiedAt"
    FROM booking_guest_checks WHERE booking_id = $1`, [bookingId])).rows[0] ?? null;
  if (r) await db.query('SELECT room_log_identity_access($1, $2, $3::jsonb)', [b.companyId, 'view', JSON.stringify({ booking: b.number })]);
  return { restricted: false as const, check: r };
}
/** A short stay checks in only once the identity check is saved. */
export async function requireGuestCheck(db: Db, bookingId: string): Promise<void> {
  const b = await bookingFor(db, bookingId);
  if (b.contractType !== KINDS.short_stay) return;
  if (!(await db.query('SELECT 1 FROM booking_guest_checks WHERE booking_id = $1', [bookingId])).rows[0]) {
    bad('Check the guest identity before check-in: ID type, number, nationality and who verified it. Do not copy or upload the ID.', 'err.roomNeedGuestCheck');
  }
}

// ------------------------------------------------------------------ Type B: the rental contract
export interface RentalInput {
  landlordName?: string; landlordIdType?: string; landlordIdNumber?: string; tenantIdType?: string; tenantIdNumber?: string; property?: string; city?: string;
  rent?: string; rentPeriod?: string; deposit?: string; vatCode?: string; incomeAccountId?: string | null; ejarStatus?: string; ejarNumber?: string | null;
}
async function rentalGaps(db: Db, bookingId: string, x: RentalInput): Promise<string[]> {
  const b = (await db.query(`SELECT b.arrival::text AS arrival, b.departure::text AS departure, c.name AS tenant, r.number AS unit FROM bookings b JOIN contacts c ON c.id = b.contact_id
    JOIN rooms r ON r.id = b.room_id WHERE b.id = $1`, [bookingId])).rows[0] ?? notFound();
  return C.missingLongTerm({ ...x, tenantName: b.tenant, unit: b.unit, startDate: b.arrival, endDate: b.departure });
}
/** Saves the rental contract details of a long-term booking (before signing). The booking's dates are the contract's start and end. */
export async function saveRental(db: Db, bookingId: string, x: RentalInput): Promise<string> {
  const b = await bookingFor(db, bookingId);
  if (b.contractType !== KINDS.long_term) bad('A rental contract belongs to a long-term booking.', 'err.roomNotLongTerm');
  const gaps = await rentalGaps(db, bookingId, x);
  if (gaps.length) missing(gaps);
  const account = x.incomeAccountId || (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '4200'`, [b.companyId])).rows[0]?.id
    || bad("This client's chart of accounts has no account 4200 Room revenue: choose the income account for the rent.", 'err.chart');
  const cur = (await db.query('SELECT signed_at FROM booking_tenancies WHERE booking_id = $1', [bookingId])).rows[0];
  if (cur?.signed_at) bad('A signed contract does not change. Make the change by addendum.', 'err.roomSigned');
  const vals = [txt(x.landlordName), x.landlordIdType, txt(x.landlordIdNumber, 40), x.tenantIdType, txt(x.tenantIdNumber, 40), txt(x.property), txt(x.city, 60),
    amount(x.rent, 'the rent'), x.rentPeriod, amount(x.deposit ?? '0', 'the deposit', true), x.vatCode, account, x.ejarStatus, x.ejarStatus === 'registered' ? txt(x.ejarNumber, 40) : txt(x.ejarNumber, 40)];
  const r = await db.query(`INSERT INTO booking_tenancies (company_id, booking_id, landlord_name, landlord_id_type, landlord_id_number, tenant_id_type, tenant_id_number, property, city, rent,
      rent_period, deposit, vat_code, income_account_id, ejar_status, ejar_number, last_registered_rent, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $15 = 'registered' THEN $10::numeric END, app_user_id())
    ON CONFLICT (booking_id) DO UPDATE SET landlord_name = $3, landlord_id_type = $4, landlord_id_number = $5, tenant_id_type = $6, tenant_id_number = $7, property = $8, city = $9, rent = $10,
      rent_period = $11, deposit = $12, vat_code = $13, income_account_id = $14, ejar_status = $15, ejar_number = $16,
      last_registered_rent = CASE WHEN $15 = 'registered' THEN $10::numeric END RETURNING id`, [b.companyId, bookingId, ...vals]);
  return r.rows[0].id;
}

async function tenancy(db: Db, bookingId: string) {
  return (await db.query(`SELECT t.*, t.rent::text AS rent_text, t.last_registered_rent::text AS last_text, t.signed_at IS NOT NULL AS signed, b.arrival::text AS start, b.departure::text AS "end",
      b.number, b.company_id AS cid FROM booking_tenancies t JOIN bookings b ON b.id = t.booking_id WHERE t.booking_id = $1`, [bookingId])).rows[0] ?? notFound();
}

/** The rent and end date now in force: the latest addendum that sets each, else the contract's own. */
export async function effectiveTerms(db: Db, bookingId: string) {
  const t = await tenancy(db, bookingId);
  const ad = (await db.query(`SELECT no, effective_date::text AS effective, new_rent::text AS "newRent", new_end::text AS "newEnd" FROM booking_addenda WHERE booking_id = $1 ORDER BY no`, [bookingId])).rows;
  const rent = [...ad].reverse().find((a) => a.newRent)?.newRent ?? t.rent_text;
  return { rent: fromMinor(toMinor(rent)), end: t.end as string, addenda: ad };
}

async function syncInstalments(db: Db, bookingId: string): Promise<void> {
  const t = await tenancy(db, bookingId);
  const ad = (await db.query(`SELECT effective_date::text AS effective, new_rent::text AS "newRent" FROM booking_addenda WHERE booking_id = $1 AND new_rent IS NOT NULL ORDER BY no`, [bookingId])).rows;
  const wanted = C.instalments(t.start, t.end, t.rent_text, t.rent_period).map((i) => {
    const hit = [...ad].reverse().find((a) => a.effective <= i.due);
    return { ...i, amount: hit ? fromMinor(toMinor(hit.newRent)) : i.amount };
  });
  const have = (await db.query(`SELECT id, no, document_id FROM booking_instalments WHERE booking_id = $1`, [bookingId])).rows as { id: string; no: number; document_id: string | null }[];
  for (const h of have) {
    const w = wanted.find((x) => x.no === h.no);
    if (h.document_id) continue;                               // billed: stays as it is
    if (!w) await db.query('DELETE FROM booking_instalments WHERE id = $1', [h.id]);
    else await db.query('UPDATE booking_instalments SET due_date = $2, amount = $3 WHERE id = $1', [h.id, w.due, w.amount]);
  }
  for (const w of wanted) if (!have.some((h) => h.no === w.no)) {
    await db.query('INSERT INTO booking_instalments (company_id, booking_id, no, due_date, amount) VALUES ($1,$2,$3,$4,$5)', [t.company_id, bookingId, w.no, w.due, w.amount]);
  }
}

/** Signs the contract: it no longer changes (changes are by addendum), the payment schedule is made, and the terms are fixed as they read now.
 *  An unregistered contract can be signed, with the Ejar warning still showing. */
export async function signRental(db: Db, bookingId: string): Promise<void> {
  const t = await tenancy(db, bookingId);
  if (t.signed) bad('This contract is already signed.', 'err.roomSigned');
  const gaps = await rentalGaps(db, bookingId, { landlordName: t.landlord_name, landlordIdType: t.landlord_id_type, landlordIdNumber: t.landlord_id_number, tenantIdType: t.tenant_id_type,
    tenantIdNumber: t.tenant_id_number, property: t.property, city: t.city, rent: t.rent_text, rentPeriod: t.rent_period, deposit: String(t.deposit), vatCode: t.vat_code, ejarStatus: t.ejar_status, ejarNumber: t.ejar_number });
  if (gaps.length) missing(gaps);
  await db.query('UPDATE booking_tenancies SET signed_at = now() WHERE booking_id = $1', [bookingId]);
  await syncInstalments(db, bookingId);
}

/** The Ejar registration moves on after signing: pending, then registered with its number. Registering fixes the rent now in force as the
 *  last registered rent (the figure a frozen city compares increases with). */
export async function setEjar(db: Db, bookingId: string, x: { status?: string; number?: string | null }): Promise<void> {
  const t = await tenancy(db, bookingId);
  if (!C.EJAR_STATUSES.includes(x.status as C.EjarStatus)) bad('Choose the Ejar status: not registered, pending or registered.', 'err.roomEjarStatus');
  const number = txt(x.number, 40);
  if (x.status === 'registered' && !number) bad('Enter the Ejar contract number to mark the contract registered.', 'err.roomEjarNumber');
  const eff = await effectiveTerms(db, bookingId);
  await db.query(`UPDATE booking_tenancies SET ejar_status = $2, ejar_number = $3, last_registered_rent = CASE WHEN $2 = 'registered' THEN $4::numeric ELSE last_registered_rent END WHERE booking_id = $1`,
    [bookingId, x.status, number, eff.rent]);
}

/** A non-renewal notice: the date it was given and who gave it. It counts only if given at least 60 days before the end date. */
export async function recordNonRenewal(db: Db, bookingId: string, x: { date?: string; by?: string }): Promise<void> {
  const eff = await effectiveTerms(db, bookingId);
  if (x.date && !DATE.test(x.date)) bad('Enter the date the notice was given.', 'err.date');
  const p = C.noticeProblem(eff.end, { date: x.date, by: x.by });
  if (p === 'incomplete') bad('Record the date the notice was given and who gave it.', 'err.roomNoticeIncomplete');
  if (p === 'late') bad(`A non-renewal notice must be given at least ${C.NOTICE_DAYS} days before the end date (${eff.end}), so this contract renews automatically.`, 'err.roomNoticeLate');
  await db.query('UPDATE booking_tenancies SET nonrenewal_date = $2, nonrenewal_by = $3 WHERE booking_id = $1', [bookingId, x.date, txt(x.by, 120)]);
}

export interface AddendumInput { effectiveDate?: string; newRent?: string | null; newEnd?: string | null; reason?: string }
/** A change to a signed rental: a new rent from a date, or a new end date. Appended, never edited. In a frozen city a rent above the last
 *  registered rent is refused, with the reason. */
export async function addAddendum(db: Db, bookingId: string, x: AddendumInput): Promise<string> {
  const t = await tenancy(db, bookingId);
  if (!t.signed) bad('Sign the contract first: an unsigned contract is edited directly.', 'err.roomNotSigned');
  const reason = txt(x.reason, 500) ?? bad('Say why the contract changes.', 'err.roomAddendumReason');
  const effective = DATE.test(String(x.effectiveDate ?? '')) ? String(x.effectiveDate) : bad('Enter the date the change starts.', 'err.date');
  const newRent = x.newRent ? amount(x.newRent, 'the new rent') : null;
  const newEnd = x.newEnd ? (DATE.test(x.newEnd) ? x.newEnd : bad('Enter the new end date.', 'err.date')) : null;
  if (!newRent && !newEnd) bad('Change the rent, the end date, or both.', 'err.roomAddendumEmpty');
  if (newRent) {
    const settings = await getSettings(db, t.company_id);
    const why = C.rentIncreaseBlock({ city: t.city, frozenCities: settings.frozenCities, lastRegisteredRent: t.last_text, newRent });
    if (why) bad(why, 'err.roomRentFrozen');
  }
  const no = (await db.query('SELECT coalesce(max(no), 0) + 1 AS n FROM booking_addenda WHERE booking_id = $1', [bookingId])).rows[0].n;
  const id = (await db.query(`INSERT INTO booking_addenda (company_id, booking_id, no, effective_date, new_rent, new_end, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7, app_user_id()) RETURNING id`,
    [t.company_id, bookingId, no, effective, newRent, newEnd, reason])).rows[0].id as string;
  await syncInstalments(db, bookingId);
  return id;
}

/** One instalment becomes an ordinary invoice for the tenant (a draft, or issued): rent on the contract's income account with the contract's VAT code.
 *  The rent amount is the price before VAT. */
export async function billInstalment(db: Db, instalmentId: string, o: { issue?: boolean } = {}): Promise<string> {
  const i = (await db.query(`SELECT i.id, i.booking_id AS "bookingId", i.no, i.due_date::text AS due, i.amount::text AS amount, i.document_id AS "documentId", b.company_id AS "companyId", b.contact_id AS "contactId",
      b.number, r.number AS unit, t.income_account_id AS "accountId", t.vat_code AS "vatCode", t.signed_at IS NOT NULL AS signed, b.status, co.payment_terms_days AS terms
    FROM booking_instalments i JOIN bookings b ON b.id = i.booking_id JOIN rooms r ON r.id = b.room_id JOIN booking_tenancies t ON t.booking_id = b.id JOIN companies co ON co.id = b.company_id
    WHERE i.id = $1`, [instalmentId])).rows[0] ?? notFound();
  if (i.documentId) bad('This instalment is already billed.', 'err.roomInstalmentBilled');
  if (!i.signed) bad('Sign the contract before billing rent.', 'err.roomNotSigned');
  if (['cancelled', 'no_show'].includes(i.status)) bad('This booking is cancelled.', 'err.roomFinished');
  const documentId = await saveDraft(db, i.companyId, { type: 'invoice', contactId: i.contactId, issueDate: i.due, dueDate: addDaysDoc(i.due, Number(i.terms)), reference: `${i.number}-${i.no}`,
    notes: `Rent ${i.no}, unit ${i.unit}, due ${i.due}`, lines: [{ description: `Rent, unit ${i.unit}, instalment ${i.no} due ${i.due}`, quantity: '1', unitPrice: i.amount, accountId: i.accountId, vatCode: i.vatCode }] });
  await db.query('UPDATE booking_instalments SET document_id = $2 WHERE id = $1', [instalmentId, documentId]);
  if (o.issue) await issueDocument(db, documentId);
  return documentId;
}

/** The contract page: the details (identity only for those who may see it), the warning, alerts, notice, addenda, schedule and the registered PDF. */
export async function getContract(db: Db, bookingId: string, day = today()) {
  const b = await bookingFor(db, bookingId);
  if (b.contractType !== KINDS.long_term) return null;
  const see = await canSeeIdentity(db, b.companyId);
  if (!see) return { restricted: true as const, saved: true as const, warning: null };   // the contract holds identity details: closed to this role
  const rows = (await db.query(`SELECT t.landlord_name AS "landlordName", t.landlord_id_type AS "landlordIdType", t.landlord_id_number AS "landlordIdNumber", t.tenant_id_type AS "tenantIdType",
      t.tenant_id_number AS "tenantIdNumber", t.property, t.city, t.rent::text AS rent, t.rent_period AS "rentPeriod", t.deposit::text AS deposit, t.vat_code AS "vatCode",
      t.income_account_id AS "incomeAccountId", t.ejar_status AS "ejarStatus", t.ejar_number AS "ejarNumber", t.last_registered_rent::text AS "lastRegisteredRent",
      t.nonrenewal_date::text AS "nonrenewalDate", t.nonrenewal_by AS "nonrenewalBy", t.signed_at AS "signedAt"
    FROM booking_tenancies t WHERE t.booking_id = $1`, [bookingId])).rows[0];
  if (!rows) return { saved: false as const, warning: C.EJAR_WARNING };
  const eff = await effectiveTerms(db, bookingId);
  const instal = (await db.query(`SELECT i.id, i.no, i.due_date::text AS due, i.amount::text AS amount, i.document_id AS "documentId", d.number AS "documentNumber", d.status AS "documentStatus"
    FROM booking_instalments i LEFT JOIN documents d ON d.id = i.document_id WHERE i.booking_id = $1 ORDER BY i.no`, [bookingId])).rows;
  const files = (await db.query(`SELECT id, file_name AS "fileName", size_bytes AS size, uploaded_at AS "uploadedAt" FROM attachments WHERE booking_id = $1 ORDER BY uploaded_at`, [bookingId])).rows;
  const notice = { date: rows.nonrenewalDate, by: rows.nonrenewalBy };
  const out = { saved: true as const, ...rows, signed: !!rows.signedAt, effectiveRent: eff.rent, end: eff.end, addenda: eff.addenda, instalments: instal, files,
    warning: C.ejarWarning(rows.ejarStatus), alert: C.renewalAlert(day, eff.end), daysLeft: C.daysLeft(day, eff.end), renewsAutomatically: C.renewsAutomatically(eff.end, notice) };
  return { ...out, restricted: false as const };
}

/** Long-term contracts ending soon (90 or 60 days) or already ended, for the alert list. */
export async function renewals(db: Db, companyId: string, day = today()) {
  const rows = (await db.query(`SELECT b.id, b.number, b.status, c.name AS tenant, r.number AS unit, b.departure::text AS "end", t.ejar_status AS "ejarStatus", t.nonrenewal_date::text AS "nonrenewalDate", t.nonrenewal_by AS "nonrenewalBy"
    FROM bookings b JOIN booking_tenancies t ON t.booking_id = b.id JOIN contacts c ON c.id = b.contact_id JOIN rooms r ON r.id = b.room_id
    WHERE b.company_id = $1 AND b.contract_type = 'long_term' AND b.status IN ('reserved', 'in_house') AND t.signed_at IS NOT NULL ORDER BY b.departure`, [companyId])).rows;
  const see = await canSeeIdentity(db, companyId);
  return rows.map((r) => ({ ...r, tenant: see ? r.tenant : null, unit: see ? r.unit : null, daysLeft: C.daysLeft(day, r.end), alert: C.renewalAlert(day, r.end),
    renewsAutomatically: C.renewsAutomatically(r.end, { date: r.nonrenewalDate, by: r.nonrenewalBy }) })).filter((r) => r.alert !== null || r.daysLeft < 0);
}

// ------------------------------------------------------------------ the registration record (guest reporting)
/** The data guest reporting needs, for stays that overlap the dates: who stayed, how identified, when. Reading it is logged. No live integration:
 *  this is the data and the export, ready for the day an integration is built. */
export async function registrationRecord(db: Db, companyId: string, f: { from?: string; to?: string } = {}): Promise<{ rows: RegistrationRow[] }> {
  if (!(await canSeeIdentity(db, companyId))) throw new HttpError(403, 'Your role does not allow this.', 'err.roleNoAccess');
  const rows = (await db.query(`SELECT b.number AS booking, b.arrival::text AS "checkIn", b.departure::text AS "checkOut", (b.adults + b.children)::int AS guests, c.name AS guest, r.number AS room,
      g.id_type AS "idType", g.id_number AS "idNumber", g.nationality, g.verified_by AS "verifiedBy", g.verified_at::text AS "verifiedAt"
    FROM bookings b JOIN booking_guest_checks g ON g.booking_id = b.id JOIN contacts c ON c.id = b.contact_id JOIN rooms r ON r.id = b.room_id
    WHERE b.company_id = $1 AND b.contract_type = 'short_stay' AND b.status IN ('reserved', 'in_house', 'departed')
      AND ($2::date IS NULL OR b.departure > $2) AND ($3::date IS NULL OR b.arrival <= $3) ORDER BY b.arrival, r.number LIMIT 5000`, [companyId, f.from || null, f.to || null])).rows;
  await db.query('SELECT room_log_identity_access($1, $2, $3::jsonb)', [companyId, 'export', JSON.stringify({ from: f.from ?? null, to: f.to ?? null, rows: rows.length })]);
  return { rows };
}

/** Changes a reserved booking's contract type, before any contract details are saved. Administrators only. */
export async function changeContractType(db: Db, bookingId: string, type: string): Promise<void> {
  const b = await bookingFor(db, bookingId);
  await requireAdmin(db, b.companyId);
  if (!C.CONTRACT_TYPES.includes(type as C.ContractType)) bad('Choose the contract type: short stay or long-term rental.', 'err.roomContractType');
  await db.query('UPDATE bookings SET contract_type = $2 WHERE id = $1', [bookingId, type]);
}

/** The registered Ejar contract, as a PDF (never a picture, so never a copy of an ID). Kept for good, with the booking. */
export async function addContractFile(db: Db, bookingId: string, f: { fileName?: string; data?: string }): Promise<string> {
  const b = await bookingFor(db, bookingId);
  if (b.contractType !== KINDS.long_term) bad('Only a long-term rental takes the registered contract. Never attach a copy of an ID or passport.', 'err.roomNotLongTerm');
  const fileName = String(f.fileName ?? '').trim().slice(-200);
  if (!/\.pdf$/i.test(fileName)) bad('Attach the registered Ejar contract as a PDF.', 'err.roomContractPdf');
  const data = Buffer.from(String(f.data ?? ''), 'base64');
  if (!data.length) bad('The file is empty.', 'err.attachmentEmpty');
  if (data.length > 10 * 1024 * 1024) bad('Files can be up to 10 MB.', 'err.attachmentSize');
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') bad('This file is not a real PDF.', 'err.attachmentType');
  const id = (await db.query(`INSERT INTO attachments (company_id, booking_id, file_name, content_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,'application/pdf',$4, app_user_id()) RETURNING id`,
    [b.companyId, bookingId, fileName, data.length])).rows[0].id as string;
  await db.query('INSERT INTO attachment_files (attachment_id, company_id, data) VALUES ($1, $2, $3)', [id, b.companyId, data]);
  return id;
}
