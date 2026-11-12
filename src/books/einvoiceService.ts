// E-invoicing in the books: per-company settings, ZATCA onboarding of a device (EGS unit), the e-invoice made
// when an invoice or credit note is issued, and sending it to ZATCA. UAE companies get the PINT AE XML ready for
// their accredited service provider. Runs inside withUser(); 0025_einvoicing.sql guards the chain and the rules.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../auth/secretBox.js';
import type { EInvoiceData, EParty, VatCode } from '../einvoice/invoiceData.js';
import * as Z from '../einvoice/zatca/crypto.js';
import * as X from '../einvoice/zatca/xml.js';
import { ZatcaClient, type Fetch, type Result } from '../einvoice/zatca/api.js';
import { pintAeInScope, pintAeXml } from '../einvoice/pintAe.js';

const bad = (message: string, key?: string, details?: string[]): never => { throw new HttpError(400, message, key, details); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const text = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ------------------------------------------------------------------ configuration
let encryptionKey = config.encryptionKey || config.sessionSecret;
let fetchFn: Fetch | undefined;
let clock = () => new Date();
/** Set by the server (encryption key) and by tests (a stand-in for ZATCA, a fixed clock). */
export function configureEInvoicing(o: { encryptionKey?: string; fetch?: Fetch; now?: () => Date }) {
  if (o.encryptionKey) encryptionKey = o.encryptionKey;
  if (o.fetch) fetchFn = o.fetch;
  if (o.now) clock = o.now;
}
const client = (env: Z.ZatcaEnv) => new ZatcaClient(env, fetchFn);
/** Local date and time for the company's country (Saudi Arabia UTC+3, UAE and Oman UTC+4). */
function localParts(at: Date, country: string) {
  const s = new Date(at.getTime() + (country === 'SA' ? 3 : 4) * 3600_000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}

// ------------------------------------------------------------------ settings
export interface Settings { enabled: boolean; street: string | null; buildingNumber: string | null; district: string | null; postalCode: string | null;
  zeroReasonCode: string; zeroReason: string; exemptReasonCode: string; exemptReason: string; oosReason: string }
const SETTINGS_COLS = `enabled, street, building_number AS "buildingNumber", district, postal_code AS "postalCode", zero_reason_code AS "zeroReasonCode",
  zero_reason AS "zeroReason", exempt_reason_code AS "exemptReasonCode", exempt_reason AS "exemptReason", oos_reason AS "oosReason"`;
const DEFAULTS: Settings = { enabled: false, street: null, buildingNumber: null, district: null, postalCode: null, zeroReasonCode: 'VATEX-SA-32', zeroReason: 'Export of goods',
  exemptReasonCode: 'VATEX-SA-29', exemptReason: 'Financial services mentioned in Article 29 of the VAT Regulations', oosReason: 'Not subject to VAT' };

export async function getSettings(db: Db, companyId: string): Promise<Settings> {
  return (await db.query(`SELECT ${SETTINGS_COLS} FROM einvoice_settings WHERE company_id = $1`, [companyId])).rows[0] ?? { ...DEFAULTS };
}
export async function saveSettings(db: Db, companyId: string, b: Partial<Settings>): Promise<void> {
  const v = { ...(await getSettings(db, companyId)), ...b };
  const co = (await db.query('SELECT country FROM companies WHERE id = $1', [companyId])).rows[0] ?? notFound();
  const building = text(v.buildingNumber, 4), postal = text(v.postalCode, 5);
  if (co.country === 'SA' && v.enabled) {
    const missing = [!text(v.street) && 'street', !building && 'buildingNumber', !text(v.district) && 'district', !postal && 'postalCode'].filter(Boolean) as string[];
    if (missing.length) bad('Enter the full national address: street, building number, district and postal code.', 'err.einvAddress', missing);
  }
  if (co.country === 'SA' && v.enabled && !(await db.query(`SELECT 1 FROM einvoice_devices WHERE company_id = $1 AND status = 'active'`, [companyId])).rows[0]) {
    bad('Connect a device to ZATCA first; e-invoicing turns on when it is connected.', 'err.einvNoDevice');
  }
  if (building && !/^\d{4}$/.test(building)) bad('The building number has 4 digits.', 'err.buildingNumber');
  if (postal && !/^\d{5}$/.test(postal)) bad('The postal code has 5 digits.', 'err.postalCode');
  await db.query(
    `INSERT INTO einvoice_settings (company_id, enabled, street, building_number, district, postal_code, zero_reason_code, zero_reason, exempt_reason_code, exempt_reason, oos_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, street = $3, building_number = $4, district = $5, postal_code = $6, zero_reason_code = $7, zero_reason = $8,
       exempt_reason_code = $9, exempt_reason = $10, oos_reason = $11`,
    [companyId, Boolean(v.enabled), text(v.street), building, text(v.district), postal, text(v.zeroReasonCode, 20) ?? DEFAULTS.zeroReasonCode, text(v.zeroReason) ?? DEFAULTS.zeroReason,
     text(v.exemptReasonCode, 20) ?? DEFAULTS.exemptReasonCode, text(v.exemptReason) ?? DEFAULTS.exemptReason, text(v.oosReason) ?? DEFAULTS.oosReason]);
}

// ------------------------------------------------------------------ the invoice data from the books
async function company(db: Db, id: string) {
  return (await db.query(`SELECT id, name, name_ar AS "nameAr", country, currency, vat_number AS "vatNumber", vat_status AS "vatStatus", cr_number AS "crNumber",
    address, city, email, industry FROM companies WHERE id = $1`, [id])).rows[0] ?? notFound();
}
export async function invoiceData(db: Db, documentId: string, uuid: string): Promise<{ data: EInvoiceData; companyId: string; country: string }> {
  const d = (await db.query(
    `SELECT d.id, d.company_id, d.type, d.status, d.number, d.issue_date::text AS issue_date, d.due_date::text AS due_date, d.issued_at, d.notes,
            d.net_total::text AS net, d.vat_total::text AS vat, d.gross_total::text AS gross, o.number AS orig_number, o.issue_date::text AS orig_date,
            c.name, c.name_ar, c.vat_number, c.cr_number, c.address, c.city, c.country, c.email, c.building_number, c.district, c.postal_code,
            EXISTS (SELECT 1 FROM payment_allocations a WHERE a.document_id = d.id) AS paid
     FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN documents o ON o.id = d.original_id WHERE d.id = $1`, [documentId])).rows[0] ?? notFound();
  const co = await company(db, d.company_id);
  const s = await getSettings(db, d.company_id);
  const lines = (await db.query(
    `SELECT line_no, description, quantity::text, unit_price::text, net_amount::text AS net, vat_amount::text AS vat, vat_code, vat_rate::text
     FROM document_lines WHERE document_id = $1 ORDER BY line_no`, [documentId])).rows;
  const at = localParts(d.issued_at ? new Date(d.issued_at) : clock(), co.country);
  const seller: EParty = { name: co.name, nameAr: co.nameAr, vatNumber: co.vatNumber, crNumber: co.crNumber, street: s.street ?? co.address, building: s.buildingNumber,
    district: s.district, city: co.city, postalCode: s.postalCode, country: co.country, email: co.email };
  const walkIn = !d.vat_number && /walk-?in/i.test(d.name ?? '');
  const buyer: EParty | null = !d.name || walkIn ? null : { name: d.name, nameAr: d.name_ar, vatNumber: d.vat_number, crNumber: d.cr_number, street: d.address, building: d.building_number,
    district: d.district, city: d.city, postalCode: d.postal_code, country: d.country ?? co.country, email: d.email };
  const data: EInvoiceData = {
    number: d.number, uuid, type: d.type === 'credit_note' ? 'credit_note' : d.type === 'debit_note' ? 'debit_note' : 'invoice', issueDate: d.issue_date, issueTime: at.time, supplyDate: d.issue_date, dueDate: d.due_date,
    currency: co.currency, seller, buyer,
    lines: lines.map((l) => ({ no: l.line_no, description: l.description, quantity: l.quantity, unitPrice: l.unit_price, net: l.net, vat: l.vat, vatCode: l.vat_code as VatCode, vatRate: l.vat_rate })),
    netTotal: d.net, vatTotal: d.vat, grossTotal: d.gross,
    original: d.orig_number ? { number: d.orig_number, issueDate: d.orig_date } : null, reason: d.type === 'credit_note' ? (text(d.notes, 300) ?? 'Correction of the invoice') : d.type === 'debit_note' ? (text(d.notes, 300) ?? 'Additional charge on the invoice') : null,
    paymentMeans: d.paid ? '10' : '30',
    exemption: { zero: { code: s.zeroReasonCode, text: s.zeroReason }, exempt: { code: s.exemptReasonCode, text: s.exemptReason }, out_of_scope: { code: 'VATEX-SA-OOS', text: s.oosReason } },
  };
  return { data, companyId: d.company_id, country: co.country };
}

/** What a standard (B2B) tax invoice to a Saudi buyer still needs. */
export function buyerAddressMissing(b: EParty | null): string[] {
  if (!b?.vatNumber || (b.country && b.country !== 'SA')) return [];
  return [!b.street && 'street', !b.building && 'buildingNumber', !b.district && 'district', !b.city && 'city', !b.postalCode && 'postalCode'].filter(Boolean) as string[];
}

// ------------------------------------------------------------------ devices and onboarding
const secret = (v: string) => encryptSecret(encryptionKey, v);
const unbox = (v: string) => decryptSecret(encryptionKey, v);
export interface OnboardInput { environment?: string; otp?: string; name?: string; branch?: string; invoiceTypes?: string }

/** Step 1: a new key and CSR; ZATCA gives the compliance CSID for the one-time password from the Fatoora portal. */
export async function onboard(db: Db, companyId: string, b: OnboardInput): Promise<string> {
  const env = (['sandbox', 'simulation', 'production'] as const).find((e) => e === b.environment) ?? bad('Choose where to connect.', 'err.format');
  const otp = text(b.otp, 10) ?? bad('Enter the one-time password from the Fatoora portal.', 'err.einvOtp');
  if (!/^\d{6}$/.test(otp)) bad('The one-time password has 6 digits.', 'err.einvOtp');
  const co = await company(db, companyId);
  if (co.country !== 'SA') bad('ZATCA e-invoicing is for Saudi companies.', 'err.einvCountry');
  if (!co.vatNumber) bad('Enter the company\'s VAT number first.', 'err.vatNumber');
  const s = await getSettings(db, companyId);
  if (!s.street || !s.buildingNumber || !s.district || !s.postalCode) bad('Enter the full national address first.', 'err.einvAddress');
  const types = ['1100', '1000', '0100'].includes(String(b.invoiceTypes)) ? String(b.invoiceTypes) : '1100';
  const serial = randomUUID();
  const name = text(b.name, 60) ?? `EGS-${co.crNumber}`;
  const branch = text(b.branch, 60) ?? co.city;
  const { privatePem } = Z.newKey();
  const csr = Z.makeCsr(privatePem, { env, commonName: name, serialNumber: `1-NusuhBooks|2-1.0|3-${serial}`, organisation: co.name, organisationUnit: branch,
    vatNumber: co.vatNumber, invoiceTypes: types, address: `${s.buildingNumber} ${s.street}, ${s.district}, ${co.city} ${s.postalCode}`, industry: co.industry ?? 'Trading' });
  const r = await client(env).complianceCsid(csr.base64, otp);
  if ('error' in r) bad(r.error === 'unreachable' ? 'ZATCA could not be reached. Try again in a moment.' : 'ZATCA did not accept the request. Check the one-time password (it works once, for one hour).',
    r.error === 'unreachable' ? 'err.zatcaUnreachable' : 'err.zatcaOtp', [r.error]);
  const ok = r as { requestId: string; token: string; secret: string };
  return (await db.query(
    `INSERT INTO einvoice_devices (company_id, environment, name, serial, branch, invoice_types, private_key_enc, csr, compliance_request_id, compliance_token, compliance_secret_enc,
                                   cert_valid_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id()) RETURNING id`,
    [companyId, env, name, serial, branch, types, secret(privatePem), csr.pem, ok.requestId, ok.token, secret(ok.secret), Z.certInfo(ok.token).validTo])).rows[0].id;
}

async function device(db: Db, id: string) {
  return (await db.query('SELECT * FROM einvoice_devices WHERE id = $1', [id])).rows[0] ?? notFound();
}

/** The sample invoices ZATCA checks before giving the production CSID: each type the device makes. */
function samples(co: { name: string; vatNumber: string; crNumber: string; city: string; currency: string }, s: Settings, types: string, at: { date: string; time: string }): EInvoiceData[] {
  const seller: EParty = { name: co.name, vatNumber: co.vatNumber, crNumber: co.crNumber, street: s.street, building: s.buildingNumber, district: s.district, city: co.city, postalCode: s.postalCode, country: 'SA' };
  const buyer: EParty = { name: 'Compliance check buyer', vatNumber: '399999999800003', street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12345', country: 'SA' };
  const base = (n: number, b: EParty | null, type: EInvoiceData['type']): EInvoiceData => ({
    number: `CMP-${n}`, uuid: randomUUID(), type, issueDate: at.date, issueTime: at.time, supplyDate: at.date, currency: co.currency, seller, buyer: b,
    lines: [{ no: 1, description: 'Compliance check item', quantity: '1.000', unitPrice: '100.00', net: '100.00', vat: '15.00', vatCode: 'standard', vatRate: '15.00' }],
    netTotal: '100.00', vatTotal: '15.00', grossTotal: '115.00', original: type === 'invoice' ? null : { number: `CMP-${b ? 1 : 4}`, issueDate: at.date },
    reason: type === 'invoice' ? null : 'Compliance check', paymentMeans: '10',
    exemption: { zero: { code: s.zeroReasonCode, text: s.zeroReason }, exempt: { code: s.exemptReasonCode, text: s.exemptReason }, out_of_scope: { code: 'VATEX-SA-OOS', text: s.oosReason } },
  });
  const out: EInvoiceData[] = [];
  if (types[0] === '1') out.push(base(1, buyer, 'invoice'), base(2, buyer, 'credit_note'), base(3, buyer, 'debit_note'));
  if (types[1] === '1') out.push(base(4, null, 'invoice'), base(5, null, 'credit_note'), base(6, null, 'debit_note'));
  return out;
}

/** Step 2: the compliance checks, then the production CSID. The device is active when both pass. */
export async function finishOnboarding(db: Db, deviceId: string): Promise<{ status: string; checks: { type: string; outcome: string; warnings: string[]; errors: string[] }[] }> {
  const dev = await device(db, deviceId);
  if (dev.status === 'active' || dev.status === 'retired') bad('This device is already set up.', 'err.einvDeviceDone');
  const co = await company(db, dev.company_id);
  const s = await getSettings(db, dev.company_id);
  const creds = { token: dev.compliance_token, secret: unbox(dev.compliance_secret_enc) };
  let checks = dev.checks as { type: string; outcome: string; warnings: string[]; errors: string[] }[];
  if (dev.status !== 'checks_passed') {
    const key = Z.keyFrom(unbox(dev.private_key_enc));
    const cert = Z.certInfo(dev.compliance_token);
    const at = localParts(clock(), 'SA');
    let pih = X.FIRST_PIH;
    checks = [];
    for (const [i, d] of samples(co, s, dev.invoice_types, at).entries()) {
      const st = X.stampInvoice(d, { icv: i + 1, pih }, key, cert, `${at.date}T${at.time}`);
      pih = st.hash;
      const r = await client(dev.environment).complianceCheck(creds, { invoiceHash: st.hash, uuid: d.uuid, xml: st.xml });
      checks.push({ type: `${st.kind}:${d.type}`, outcome: r.outcome, warnings: r.warnings, errors: r.errors });
      if (r.outcome === 'unreachable') break;
    }
    const passed = checks.length === samples(co, s, dev.invoice_types, at).length && checks.every((c) => c.outcome === 'accepted');
    await db.query(`UPDATE einvoice_devices SET checks = $2, status = $3 WHERE id = $1`, [deviceId, JSON.stringify(checks), passed ? 'checks_passed' : 'checks_failed']);
    if (!passed) return { status: 'checks_failed', checks };
  }
  const p = await client(dev.environment).productionCsid(creds, dev.compliance_request_id);
  if ('error' in p) return { status: 'checks_passed', checks };
  const prod = p as { token: string; secret: string };
  // Never switch a device on with a certificate that is not for its own key: every invoice would be rejected.
  if (!Z.certMatchesKey(Z.certInfo(prod.token), Z.keyFrom(unbox(dev.private_key_enc))))
    bad('The certificate ZATCA sent does not belong to this device, so the device was not switched on. Connect the device again with a new one-time password.', 'err.einvCertMismatch');
  // Only one active device per company: the earlier one is retired.
  await db.query(`UPDATE einvoice_devices SET status = 'retired' WHERE company_id = $1 AND status = 'active'`, [dev.company_id]);
  await db.query(`UPDATE einvoice_devices SET status = 'active', production_token = $2, production_secret_enc = $3, cert_valid_to = $4 WHERE id = $1`,
    [deviceId, prod.token, secret(prod.secret), Z.certInfo(prod.token).validTo]);
  await db.query(`UPDATE einvoice_settings SET enabled = true WHERE company_id = $1`, [dev.company_id]);   // from now on every invoice is e-invoiced
  return { status: 'active', checks };
}

export async function devices(db: Db, companyId: string) {
  return (await db.query(
    `SELECT id, environment, name, branch, invoice_types AS "invoiceTypes", status, checks, icv::int, cert_valid_to AS "certValidTo", created_at AS "createdAt", activated_at AS "activatedAt",
            person_name(created_by) AS "createdBy"
     FROM einvoice_devices WHERE company_id = $1 ORDER BY created_at DESC`, [companyId])).rows;
}

// ------------------------------------------------------------------ the e-invoice for an issued document
/** Called when an invoice or credit note is issued: makes its e-invoice if the company e-invoices. */
export async function afterIssue(db: Db, documentId: string): Promise<string | null> {
  const doc = (await db.query(`SELECT d.company_id, d.type, c.country FROM documents d JOIN companies c ON c.id = d.company_id WHERE d.id = $1`, [documentId])).rows[0];
  if (!doc || !['invoice', 'credit_note', 'debit_note'].includes(doc.type)) return null;
  const s = await getSettings(db, doc.company_id);
  if (!s.enabled) return null;
  return makeEInvoice(db, documentId);
}

export async function makeEInvoice(db: Db, documentId: string): Promise<string | null> {
  const uuid = randomUUID();
  const { data, companyId, country } = await invoiceData(db, documentId, uuid);
  if (country === 'AE') {
    if (!pintAeInScope(data)) return null;   // sales to consumers are outside UAE e-invoicing
    return (await db.query(
      `INSERT INTO einvoices (company_id, document_id, scheme, kind, uuid, xml, status, created_by) VALUES ($1, $2, 'pint_ae', 'standard', $3, $4, 'ready', app_user_id()) RETURNING id`,
      [companyId, documentId, uuid, pintAeXml(data)])).rows[0].id;
  }
  if (country !== 'SA') return null;
  const dev = (await db.query(`SELECT * FROM einvoice_devices WHERE company_id = $1 AND status = 'active' FOR UPDATE`, [companyId])).rows[0];
  if (!dev) bad('E-invoicing is on, but no device is connected to ZATCA yet. Connect one in Sales > E-invoicing.', 'err.einvNoDevice');
  const missing = buyerAddressMissing(data.buyer);
  if (missing.length) bad('The customer\'s national address is needed for a tax invoice: building number, street, district, city and postal code.', 'err.buyerAddress', missing);
  const at = localParts(clock(), 'SA');
  const st = X.stampInvoice(data, { icv: Number(dev.icv) + 1, pih: dev.last_hash }, Z.keyFrom(unbox(dev.private_key_enc)), Z.certInfo(dev.production_token), `${at.date}T${at.time}`);
  return (await db.query(
    `INSERT INTO einvoices (company_id, document_id, scheme, device_id, kind, uuid, icv, pih, invoice_hash, xml, qr, status, created_by)
     VALUES ($1, $2, 'zatca', $3, $4, $5, $6, $7, $8, $9, $10, 'pending', app_user_id()) RETURNING id`,
    [companyId, documentId, dev.id, st.kind, uuid, Number(dev.icv) + 1, dev.last_hash, st.hash, st.xml, st.qr])).rows[0].id;
}

/** Minutes before the next try after the 1st, 2nd, ... failed attempt to reach ZATCA; the last repeats. */
export const RETRY_MINUTES = [2, 5, 10, 15, 30];

/** Sends a pending ZATCA e-invoice: clearance (standard) or reporting (simplified). */
export async function submit(db: Db, id: string): Promise<{ status: string; warnings: string[]; errors: string[] }> {
  const e = (await db.query(`SELECT e.*, d.environment, d.production_token, d.production_secret_enc FROM einvoices e JOIN einvoice_devices d ON d.id = e.device_id WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0] ?? notFound();
  if (e.status !== 'pending') return { status: e.status, warnings: e.warnings, errors: e.errors };
  const creds = { token: e.production_token, secret: unbox(e.production_secret_enc) };
  const c = client(e.environment);
  const sub = { invoiceHash: e.invoice_hash, uuid: e.uuid, xml: e.xml };
  const r: Result = e.kind === 'standard' ? await c.clearance(creds, sub) : await c.reporting(creds, sub);
  const status = r.outcome === 'accepted' ? (e.kind === 'standard' ? 'cleared' : 'reported') : r.outcome === 'rejected' ? 'rejected' : 'pending';
  // Still waiting (ZATCA not reached, or its login refused): the next try after 2, 5, 10, 15, then every 30 minutes.
  const wait = RETRY_MINUTES[e.attempts] ?? RETRY_MINUTES[RETRY_MINUTES.length - 1]!;
  await db.query(
    `UPDATE einvoices SET status = $2, cleared_xml = $3, warnings = $4, errors = $5, http_status = $6, attempts = attempts + 1, submitted_at = now(),
       last_attempt_at = now(), next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(mins => $7) END WHERE id = $1`,
    [id, status, r.clearedXml ?? null, JSON.stringify(r.warnings), JSON.stringify(r.errors), r.httpStatus, wait]);
  return { status, warnings: r.warnings, errors: r.errors };
}
export async function submitPending(db: Db, companyId: string, limit = 50) {
  const ids = (await db.query(`SELECT id FROM einvoices WHERE company_id = $1 AND scheme = 'zatca' AND status = 'pending' ORDER BY icv LIMIT $2`, [companyId, limit])).rows.map((r) => r.id as string);
  const out = [];
  for (const id of ids) out.push({ id, ...(await submit(db, id)) });
  return out;
}

/** A rejected invoice is corrected (for example the customer's address) and prepared again: a new e-invoice in the chain. */
export async function prepareAgain(db: Db, documentId: string): Promise<string | null> {
  const open = (await db.query(`SELECT status FROM einvoices WHERE document_id = $1 AND status <> 'rejected'`, [documentId])).rows[0];
  if (open) bad('This invoice already has an e-invoice that is not rejected.', 'err.einvExists');
  if (!(await db.query(`SELECT 1 FROM einvoices WHERE document_id = $1 AND status = 'rejected'`, [documentId])).rows[0]) bad('Only rejected e-invoices are prepared again.', 'err.einvNotRejected');
  return makeEInvoice(db, documentId);
}

// ------------------------------------------------------------------ lists
const ROW = `e.id, e.document_id AS "documentId", d.type AS "docType", d.number, d.issue_date::text AS "issueDate", d.gross_total::text AS total, c.name AS customer,
  e.scheme, e.kind, e.uuid, e.icv::int, e.status, e.warnings, e.errors, e.http_status AS "httpStatus", e.attempts, e.submitted_at AS "submittedAt", e.created_at AS "createdAt"`;
export async function list(db: Db, companyId: string, status?: string) {
  return (await db.query(`SELECT ${ROW} FROM einvoices e JOIN documents d ON d.id = e.document_id LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE e.company_id = $1 AND ($2::text IS NULL OR e.status = $2) ORDER BY e.created_at DESC LIMIT 500`, [companyId, status ?? null])).rows;
}
export async function forDocument(db: Db, documentId: string) {
  const rows = (await db.query(`SELECT ${ROW}, e.qr, e.cleared_xml FROM einvoices e JOIN documents d ON d.id = e.document_id LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE e.document_id = $1 ORDER BY e.created_at DESC`, [documentId])).rows;
  // The QR printed on the invoice: ZATCA's (from the cleared XML) for standard invoices, our stamp's for simplified ones.
  return rows.map(({ cleared_xml, qr, ...r }) => ({ ...r, printQr: (cleared_xml && qrFromXml(cleared_xml)) || qr || null }));
}
/** The XML to download: the cleared one from ZATCA when there is one. */
export async function xmlOf(db: Db, id: string): Promise<{ fileName: string; xml: string }> {
  const r = (await db.query(`SELECT e.xml, e.cleared_xml, e.scheme, d.number FROM einvoices e JOIN documents d ON d.id = e.document_id WHERE e.id = $1`, [id])).rows[0] ?? notFound();
  return { fileName: `${String(r.number).replace(/[^\w-]+/g, '_')}${r.scheme === 'pint_ae' ? '-pint-ae' : ''}.xml`, xml: r.cleared_xml ?? r.xml };
}
/** QR for the printed invoice: from the cleared XML (standard) or our own stamp (simplified). */
export function qrFromXml(xml: string): string | null {
  return /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(xml)?.[1] ?? null;
}
export async function overview(db: Db, companyId: string) {
  const co = await company(db, companyId);
  const counts = (await db.query(`SELECT status, count(*)::int AS n FROM einvoices WHERE company_id = $1 GROUP BY status`, [companyId])).rows;
  return { country: co.country, vatStatus: co.vatStatus, settings: await getSettings(db, companyId), devices: await devices(db, companyId),
    counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) as Record<string, number> };
}
