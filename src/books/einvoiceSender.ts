// The server's ZATCA sender: reports simplified e-invoices automatically (ZATCA allows 24 hours from issue), retries
// while ZATCA cannot be reached, and warns the customer's Administrators and the company's sales people at 12, 20 and
// 24 hours, on a rejection and when ZATCA refuses the device's login. Warnings carry counts and invoice numbers only.
//   * One sender per device (a lease in the database), so two servers never send the same invoice.
//   * Each device sends in invoice-counter order; one that cannot be reached holds back the ones after it, a rejected
//     one does not.
//   * Each answer is saved in its own transaction, so a crash loses nothing: what was not answered is sent again.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withUser } from '../db/session.js';
import { bilingual } from '../email/templates.js';
import { queue } from './emailService.js';
import { submit } from './einvoiceService.js';

export const JOB = 'einvoice_sender';
const LEASE_SECONDS = 300;

export interface SenderResult { reported: number; rejected: number; waiting: number; skippedDevices: number; warnings: number }

/** One run. `all` sends everything waiting, ignoring the retry times (used when the server starts). */
export async function runEInvoiceSender(pool: pg.Pool, o: { now?: Date; all?: boolean; base?: string; companyIds?: string[] } = {}): Promise<SenderResult> {
  const now = o.now ?? new Date();
  const out: SenderResult = { reported: 0, rejected: 0, waiting: 0, skippedDevices: 0, warnings: 0 };
  await pool.query('SELECT job_started($1)', [JOB]);
  let problem: string | null = null;
  try {
    const only = (id: string) => !o.companyIds || o.companyIds.includes(id);   // tests limit a run to their own companies
    const devices = ((await pool.query('SELECT device_id, company_id, run_as FROM einvoices_to_send($1, $2)', [now, !!o.all])).rows as { device_id: string; company_id: string; run_as: string }[])
      .filter((d) => only(d.company_id));
    for (const d of devices) {
      const lease = randomUUID();
      if (!(await pool.query('SELECT einvoice_lease($1, $2, $3) AS ok', [d.device_id, lease, LEASE_SECONDS])).rows[0].ok) { out.skippedDevices++; continue; }
      try { await sendDevice(pool, d.device_id, d.run_as, now, !!o.all, out); }
      catch (e) { problem = `device ${d.device_id}: ${(e as Error).message}`; }
      finally { await pool.query('SELECT einvoice_release($1, $2)', [d.device_id, lease]); }
    }
    out.warnings = await sendWarnings(pool, now, o.base, only);
  } catch (e) { problem = (e as Error).message; }
  await pool.query('SELECT job_finished($1, $2)', [JOB, problem]);
  if (problem) throw new Error(problem);
  return out;
}

async function sendDevice(pool: pg.Pool, deviceId: string, runAs: string, now: Date, all: boolean, out: SenderResult) {
  const waiting = await withUser(pool, runAs, async (db) => (await db.query(
    `SELECT id, next_attempt_at FROM einvoices WHERE device_id = $1 AND status = 'pending' AND kind = 'simplified' ORDER BY icv`, [deviceId])).rows) as { id: string; next_attempt_at: Date | null }[];
  for (const [i, e] of waiting.entries()) {
    if (!all && e.next_attempt_at && e.next_attempt_at > now) { out.waiting += waiting.length - i; return; }   // keep the order: wait for this one
    const r = await withUser(pool, runAs, (db) => submit(db, e.id));
    if (r.status === 'reported') out.reported++;
    else if (r.status === 'rejected') out.rejected++;                           // its own warning; the next ones go on
    else if (r.status === 'pending') { out.waiting += waiting.length - i; return; }   // ZATCA not reached: try again later, in order
  }
}

// ------------------------------------------------------------------ warnings
type Stage = 'h12' | 'h20' | 'h24' | 'rejected' | 'login';
interface Due { einvoice_id: string; company_id: string; company: string; number: string; created_at: Date; status: string; http_status: number | null; warned: Stage[] }

/** The warning an e-invoice needs now (the highest time stage it reached), if it has not had it. */
export function stageFor(e: Pick<Due, 'created_at' | 'status' | 'http_status' | 'warned'>, now: Date): { stage: Stage; mark: Stage[] } | null {
  if (e.status === 'rejected') return e.warned.includes('rejected') ? null : { stage: 'rejected', mark: ['rejected'] };
  const hours = (now.getTime() - new Date(e.created_at).getTime()) / 3_600_000;
  const reached: Stage[] = hours >= 24 ? ['h12', 'h20', 'h24'] : hours >= 20 ? ['h12', 'h20'] : hours >= 12 ? ['h12'] : [];
  const top = reached[reached.length - 1];
  if (top && !e.warned.includes(top)) return { stage: top, mark: reached };
  if ((e.http_status === 401 || e.http_status === 403) && !e.warned.includes('login')) return { stage: 'login', mark: ['login'] };
  return null;
}

const list = (xs: string[]) => xs.join(', ');
function warningMail(stage: Stage, company: string, numbers: string[], oldestHours: number, link: string) {
  const n = numbers.length;
  const left = Math.max(0, 24 - oldestHours);
  const where = link ? [`See Sales > E-invoicing: ${link}`] : ['See Sales > E-invoicing in Nusuh Books.'];
  const whereAr = link ? [`راجع المبيعات > الفوترة الإلكترونية: ${link}`] : ['راجع المبيعات > الفوترة الإلكترونية في نُصح.'];
  switch (stage) {
    case 'h12': return bilingual(`ZATCA: ${n} simplified invoice(s) not yet reported · ${n} فاتورة مبسطة لم تُبلَّغ بعد`,
      [`${company}: ${n} simplified invoice(s) are not yet reported to ZATCA: ${list(numbers)}.`, `The oldest was issued ${oldestHours} hours ago. ZATCA allows 24 hours from issue. Nusuh Books keeps trying.`, ...where],
      [`${company}: لم تُبلَّغ الهيئة بعد عن ${n} فاتورة مبسطة: ${list(numbers)}.`, `أقدمها صدرت قبل ${oldestHours} ساعة. تسمح الهيئة بـ 24 ساعة من الإصدار. يواصل نُصح المحاولة.`, ...whereAr], 'Nusuh Books');
    case 'h20': return bilingual(`Urgent: ${left} hours left to report ${n} invoice(s) to ZATCA · عاجل: بقيت ${left} ساعات للإبلاغ`,
      [`${company}: ${n} simplified invoice(s) are still not reported to ZATCA: ${list(numbers)}.`, `About ${left} hours are left of the 24 hours ZATCA allows.`, ...where],
      [`${company}: ما زالت ${n} فاتورة مبسطة دون إبلاغ الهيئة: ${list(numbers)}.`, `بقيت قرابة ${left} ساعات من مهلة الـ 24 ساعة.`, ...whereAr], 'Nusuh Books');
    case 'h24': return bilingual(`Overdue: ${n} invoice(s) not reported to ZATCA within 24 hours · متأخرة: ${n} فاتورة لم تُبلَّغ خلال 24 ساعة`,
      [`${company}: ${n} simplified invoice(s) were not reported to ZATCA within 24 hours: ${list(numbers)}.`, 'ZATCA asks you to notify them through the form on its website. Nusuh Books keeps trying to send them.', ...where],
      [`${company}: لم تُبلَّغ الهيئة خلال 24 ساعة عن ${n} فاتورة مبسطة: ${list(numbers)}.`, 'تطلب الهيئة إشعارها عبر النموذج المخصص في موقعها. يواصل نُصح محاولة الإرسال.', ...whereAr], 'Nusuh Books');
    case 'rejected': return bilingual(`ZATCA rejected ${n} simplified invoice(s) · رفضت الهيئة ${n} فاتورة مبسطة`,
      [`${company}: ZATCA rejected ${n} simplified invoice(s): ${list(numbers)}.`, 'Correct the problem and prepare the e-invoice again.', ...where],
      [`${company}: رفضت الهيئة ${n} فاتورة مبسطة: ${list(numbers)}.`, 'صحّح المشكلة ثم أعد إعداد الفاتورة الإلكترونية.', ...whereAr], 'Nusuh Books');
    case 'login': return bilingual(`ZATCA refused the e-invoicing device's login · رفضت الهيئة دخول جهاز الفوترة`,
      [`${company}: ZATCA refused the login of the e-invoicing device, so ${n} simplified invoice(s) are waiting: ${list(numbers)}.`, 'Connect the device again in Sales > E-invoicing. Nusuh Books keeps trying.', ...where],
      [`${company}: رفضت الهيئة دخول جهاز الفوترة، لذلك تنتظر ${n} فاتورة مبسطة: ${list(numbers)}.`, 'اربط الجهاز من جديد من المبيعات > الفوترة الإلكترونية. يواصل نُصح المحاولة.', ...whereAr], 'Nusuh Books');
  }
}

/** One email per company and warning stage, to its Administrators and sales people. Returns the emails queued. */
async function sendWarnings(pool: pg.Pool, now: Date, base: string | undefined, only: (companyId: string) => boolean): Promise<number> {
  const due = ((await pool.query('SELECT * FROM einvoice_warnings_due($1)', [now])).rows as Due[]).filter((e) => only(e.company_id));
  const groups = new Map<string, { company_id: string; company: string; stage: Stage; items: Due[]; mark: Map<string, Stage[]> }>();
  for (const e of due) {
    const s = stageFor(e, now);
    if (!s) continue;
    const g = groups.get(`${e.company_id}:${s.stage}`) ?? { company_id: e.company_id, company: e.company, stage: s.stage, items: [] as Due[], mark: new Map<string, Stage[]>() };
    g.items.push(e); g.mark.set(e.einvoice_id, s.mark);
    groups.set(`${e.company_id}:${s.stage}`, g);
  }
  let sent = 0;
  for (const g of groups.values()) {
    const numbers = g.items.map((e) => e.number);
    const oldest = Math.floor(Math.max(...g.items.map((e) => (now.getTime() - new Date(e.created_at).getTime()) / 3_600_000)));
    const mail = warningMail(g.stage, g.company, numbers, oldest, base ? `${base.replace(/\/+$/, '')}/c/${g.company_id}/Sales/e-invoicing` : '');
    const people = (await pool.query('SELECT name, email FROM einvoice_warning_recipients($1)', [g.company_id])).rows as { name: string; email: string }[];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of people) {
        try { await queue(client, { companyId: g.company_id, kind: 'notice', to: p.email, toName: p.name, mail }); sent++; } catch { /* no valid address: skip */ }
      }
      for (const [id, stages] of g.mark) await client.query('SELECT einvoice_warned($1, $2)', [[id], stages]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  return sent;
}

/** Every 2 minutes; at start everything waiting is sent (EINVOICE_JOBS=off turns it off). */
export function startEInvoiceSender(pool: pg.Pool, base: string, log: (m: string) => void = console.log) {
  if (process.env.EINVOICE_JOBS === 'off') return () => undefined;
  let busy = false;
  const go = async (all: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const r = await runEInvoiceSender(pool, { all, base });
      if (r.reported || r.rejected || r.warnings) log(`ZATCA sender: ${r.reported} reported, ${r.rejected} rejected, ${r.waiting} waiting, ${r.warnings} warnings`);
    } catch (e) { log(`ZATCA sender failed: ${(e as Error).message}`); }
    finally { busy = false; }
  };
  const first = setTimeout(() => void go(true), 15_000);
  const every = setInterval(() => void go(false), 2 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
