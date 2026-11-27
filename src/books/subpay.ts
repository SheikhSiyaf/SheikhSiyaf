// Manual bank-transfer payments (db/migrations/0089_subpay.sql). The browser never decides a price, an amount, a status or who approves: the
// customer sends only what they transferred; everything else is worked out and checked in the database.
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { TYPES, ownerMarkPaid } from './trialOrders.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };

/** "10350.50" -> 1035050 (halalas). Exact: only digits and at most two decimals; never a float. */
export function toHalalas(v: unknown): bigint {
  const s = String(v ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) bad('Enter the amount you transferred, for example 10350.00.', 'err.payAmount');
  const [whole, frac = ''] = s.split('.');
  const h = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  if (h <= 0n) bad('Enter the amount you transferred.', 'err.payAmount');
  return h;
}
/** 1035050n -> "10350.50" */
export const fromHalalas = (h: bigint | number | string): string => { const n = BigInt(h); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`; };

export interface SubmitInput { amount?: unknown; date?: unknown; senderBank?: unknown; bankRef?: unknown; note?: unknown; fileName?: unknown; fileType?: unknown; fileBase64?: unknown }

export const enabled = async (db: Db) => (await db.query('SELECT subpay.enabled() AS e')).rows[0].e === true;
export const myOrder = async (db: Db) => (await db.query('SELECT subpay.my_order() AS o')).rows[0].o ?? null;
export const placeOrder = async (db: Db) => { const id = (await db.query('SELECT subpay.place_order() AS id')).rows[0].id as string; return { id, order: await myOrder(db) }; };

export async function submit(db: Db, orderId: string, x: SubmitInput) {
  const amount = toHalalas(x.amount);
  const date = String(x.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Enter the date of the transfer.', 'err.payDate');
  const text = (v: unknown, max: number) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
  let proof: Buffer | null = null, name: string | null = null, type: string | null = null;
  if (x.fileBase64 !== undefined && x.fileBase64 !== null && x.fileBase64 !== '') {
    if (typeof x.fileBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(x.fileBase64)) bad('The proof of payment could not be read.', 'err.payFile');
    proof = Buffer.from(x.fileBase64 as string, 'base64');
    type = String(x.fileType ?? '');
    if (proof.length === 0 || proof.length > 5 * 1024 * 1024) bad('The proof of payment must be up to 5 MB.', 'err.payFileSize');
    if (!TYPES[type] || !TYPES[type]!(proof)) bad('The proof of payment must be a PDF, PNG, JPG or WebP file.', 'err.payFileType');
    name = String(x.fileName ?? 'slip').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'slip';
  }
  await db.query('SELECT subpay.submit($1, $2, $3, $4, $5, $6, $7, $8, $9)', [orderId, amount.toString(), date, text(x.senderBank, 120), text(x.bankRef, 80), text(x.note, 1000), name, type, proof]);
  return { order: await myOrder(db) };
}

export const queue = async (db: Db) => (await db.query('SELECT subpay.queue() AS q')).rows[0].q;
export const detail = async (db: Db, id: string) => (await db.query('SELECT subpay.order_detail($1) AS d', [id])).rows[0].d;
export async function file(db: Db, submissionId: string) {
  const r = (await db.query('SELECT * FROM subpay.file_get($1)', [submissionId])).rows[0] as { name: string; type: string; bytes: Buffer } | undefined;
  if (!r) throw new HttpError(404, 'No slip was sent with this payment.', 'err.notFound');
  return r;
}
export const recommend = (db: Db, id: string, note: unknown) => db.query('SELECT subpay.recommend($1, $2)', [id, String(note ?? '')]);
export const reject = (db: Db, id: string, reason: unknown) => db.query('SELECT subpay.reject($1, $2)', [id, String(reason ?? '')]);
export const needInfo = (db: Db, id: string, message: unknown) => db.query('SELECT subpay.need_info($1, $2)', [id, String(message ?? '')]);

/** Approve (Owner role only). In ONE transaction: check, run the existing conversion (the customer becomes a paying one, the first invoice is made and
 *  marked paid), record the approval. Any failure and nothing at all changes. */
export async function approve(db: Db, id: string, x: { override?: unknown }, now: Date = new Date(), appUrl?: string) {
  const override = x.override === undefined || x.override === null ? null : String(x.override).slice(0, 500);
  const info = (await db.query('SELECT subpay.begin_approve($1, $2) AS i', [id, override])).rows[0].i as { firmId: string; modules: string[]; cleanup: boolean; reference: string; paidOn: string };
  const r = await ownerMarkPaid(db, info.firmId, { modules: info.modules, cleanup: info.cleanup, reference: info.reference, paidOn: String(info.paidOn).slice(0, 10), reason: `Bank transfer approved (${info.reference})` }, now, appUrl);
  await db.query('SELECT subpay.finish_approve($1, $2, $3)', [id, r.invoice.number, override]);
  return { ok: true, invoice: r.invoice, differs: r.differs };
}

export const settings = async (db: Db) => (await db.query('SELECT subpay.settings_get() AS s')).rows[0].s;
export async function saveSettings(db: Db, x: { enabled?: unknown; reviewTargetHours?: unknown; orderOpenDays?: unknown; bankChangeDelayHours?: unknown }) {
  const h = Number(x.reviewTargetHours), d = Number(x.orderOpenDays), delay = x.bankChangeDelayHours === undefined ? NaN : Number(x.bankChangeDelayHours);
  if (typeof x.enabled !== 'boolean' || !Number.isInteger(h) || !Number.isInteger(d)) bad('Check the settings.', 'err.invalid');
  const keep = Number.isNaN(delay) ? Number((await settings(db)).bankChangeDelayHours) : delay;
  if (!Number.isInteger(keep)) bad('Check the settings.', 'err.invalid');
  await db.query('SELECT subpay.settings_set($1, $2, $3, $4)', [x.enabled, h, d, keep]);
}

export interface BankInput { accountName?: unknown; bank?: unknown; iban?: unknown; swift?: unknown }
export const bankGet = async (db: Db) => (await db.query('SELECT subpay.bank_get() AS b')).rows[0].b;
export async function bankRequest(db: Db, x: BankInput) {
  const t = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  return (await db.query('SELECT subpay.bank_request($1, $2, $3, $4) AS r', [t(x.accountName, 200), t(x.bank, 200), t(x.iban, 60), t(x.swift, 30)])).rows[0].r as { immediate: boolean; id: string; effectiveAt: string };
}
export const bankCancel = (db: Db, id: string) => db.query('SELECT subpay.bank_cancel($1)', [id]);
