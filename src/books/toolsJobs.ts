// Hourly jobs for the accountant tools, run by the server with nobody signed in; each piece of work runs as the person
// who set it up: recurring sales invoices that are due, and automatic payment reminders. Links in emails start with
// PUBLIC_URL; without it, invoices are still made and issued but not emailed.
import type pg from 'pg';
import { withUser } from '../db/session.js';
import * as T from './toolsService.js';
import * as EI from './einvoiceService.js';

export async function runRecurringInvoices(pool: pg.Pool, day = new Date().toISOString().slice(0, 10), base = process.env.PUBLIC_URL ?? '') {
  const due = (await pool.query('SELECT id, company_id, run_as FROM recurring_invoices_due($1)', [day])).rows as { id: string; company_id: string; run_as: string }[];
  const out: { id: string; created: number; problem: string | null }[] = [];
  for (const d of due) {
    try {
      const r = await withUser(pool, d.run_as, (db) => T.generateRecurringInvoices(db, d.company_id, { onlyId: d.id, upTo: day, base: base.replace(/\/+$/, '') || undefined }));
      // Issued invoices go to ZATCA as usual (reported or cleared); a problem there shows on the invoice.
      for (const id of r.issued) {
        await withUser(pool, d.run_as, async (db) => {
          const e = (await db.query(`SELECT id FROM einvoices WHERE document_id = $1 AND scheme = 'zatca' AND status = 'pending'`, [id])).rows[0];
          if (e) await EI.submit(db, e.id);
        }).catch(() => undefined);
      }
      out.push({ id: d.id, created: r.created.length, problem: null });
    } catch (e) {
      await pool.query('SELECT recurring_invoice_note($1, $2)', [d.id, (e as Error).message]);
      out.push({ id: d.id, created: 0, problem: (e as Error).message });
    }
  }
  return out;
}

export async function runAutoReminders(pool: pg.Pool, day = new Date().toISOString().slice(0, 10), base = process.env.PUBLIC_URL ?? '') {
  if (!base) return [];
  const rows = (await pool.query('SELECT company_id, run_as FROM reminders_auto()')).rows as { company_id: string; run_as: string }[];
  const out: { companyId: string; sent: number; problem: string | null }[] = [];
  for (const r of rows) {
    try { out.push({ companyId: r.company_id, sent: (await withUser(pool, r.run_as, (db) => T.runReminders(db, r.company_id, base.replace(/\/+$/, ''), day))).length, problem: null }); }
    catch (e) { out.push({ companyId: r.company_id, sent: 0, problem: (e as Error).message }); }
  }
  return out;
}

export function startToolJobs(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.TOOL_JOBS === 'off') return () => undefined;
  const run = async () => {
    try {
      for (const r of await runRecurringInvoices(pool)) log(`Recurring invoice ${r.id}: ${r.problem ?? `${r.created} made`}`);
      for (const r of await runAutoReminders(pool)) if (r.sent || r.problem) log(`Reminders ${r.companyId}: ${r.problem ?? `${r.sent} sent`}`);
    } catch (e) { log(`Accountant tools job failed: ${(e as Error).message}`); }
  };
  const first = setTimeout(() => void run(), 20_000);
  const every = setInterval(() => void run(), 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
