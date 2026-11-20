// The ZATCA monitor: one place that says whether a company's e-invoicing is healthy, what needs attention, and what to
// do about it. It reads what is already recorded (devices, certificates, the e-invoices and their answers from ZATCA,
// the automatic sender's last run) and never calls ZATCA itself: a monitor that sends traffic to the authority every
// time someone looks at a screen would be a fault of its own. The judgement is a pure function (assess) so every rule
// is tested without a database; monitor() only gathers the facts.
import type { Db } from '../db/session.js';
import { JOB } from './einvoiceSender.js';
import { getSettings, productionAllowed } from './einvoiceService.js';
import { assess, CERT_WARN_DAYS, SENDER_GAP_MINUTES } from './einvoiceAssess.js';
export { assess, SENDER_GAP_MINUTES } from './einvoiceAssess.js';
export type { Facts, Finding, FindingAction, MonitorState, Severity } from './einvoiceAssess.js';

/** Everything the ZATCA screen shows for one company. Reads only. */
export async function monitor(db: Db, companyId: string, now: Date = new Date()) {
  const country: string = (await db.query('SELECT country FROM companies WHERE id = $1', [companyId])).rows[0]?.country ?? '';
  const settings = await getSettings(db, companyId);
  const devices = (await db.query(
    `SELECT id, name, environment, status, created_at AS "createdAt", activated_at AS "activatedAt", cert_valid_to AS "certValidTo", renewed_at AS "renewedAt",
            CASE WHEN status = 'active' AND cert_valid_to IS NOT NULL THEN ceil(extract(epoch FROM cert_valid_to - now()) / 86400)::int END AS "certDaysLeft"
     FROM einvoice_devices WHERE company_id = $1 ORDER BY created_at DESC`, [companyId])).rows;

  const waitRows = (await db.query(
    `SELECT kind, count(*)::int AS n, min(created_at) AS oldest FROM einvoices WHERE company_id = $1 AND scheme = 'zatca' AND status = 'pending' GROUP BY kind`, [companyId])).rows;
  const waiting = { simplified: { count: 0, oldestAt: null as string | null }, standard: { count: 0, oldestAt: null as string | null } };
  for (const r of waitRows) waiting[r.kind as 'simplified' | 'standard'] = { count: r.n, oldestAt: new Date(r.oldest).toISOString() };

  // Rejected, and not sent again since: a corrected invoice replaces the rejected one (einvoices_one_per_document).
  const rejectedRows = (await db.query(
    `SELECT e.id, e.document_id AS "documentId", d.number, d.type AS "docType", d.issue_date::text AS "issueDate", d.gross_total::text AS total,
            e.kind, e.errors, e.warnings, e.http_status AS "httpStatus", e.attempts, e.created_at AS "createdAt"
     FROM einvoices e JOIN documents d ON d.id = e.document_id
     WHERE e.company_id = $1 AND e.scheme = 'zatca' AND e.status = 'rejected'
       AND NOT EXISTS (SELECT 1 FROM einvoices n WHERE n.document_id = e.document_id AND n.status <> 'rejected')
     ORDER BY e.created_at DESC`, [companyId])).rows;
  const loginRefused: number = (await db.query(
    `SELECT count(*)::int AS n FROM einvoices WHERE company_id = $1 AND scheme = 'zatca' AND status = 'pending' AND http_status IN (401, 403)`, [companyId])).rows[0].n;
  const waitingList = (await db.query(
    `SELECT e.id, d.number, d.type AS "docType", e.kind, e.http_status AS "httpStatus", e.attempts, e.created_at AS "createdAt"
     FROM einvoices e JOIN documents d ON d.id = e.document_id
     WHERE e.company_id = $1 AND e.scheme = 'zatca' AND e.status = 'pending' ORDER BY e.created_at LIMIT 10`, [companyId])).rows;
  const week = (await db.query(
    `SELECT count(*) FILTER (WHERE status = 'cleared')::int AS cleared, count(*) FILTER (WHERE status = 'reported')::int AS reported,
            max(submitted_at) FILTER (WHERE status IN ('cleared', 'reported')) AS "lastAcceptedAt"
     FROM einvoices WHERE company_id = $1 AND scheme = 'zatca' AND created_at > now() - interval '7 days'`, [companyId])).rows[0];
  const job = (await db.query(`SELECT last_finished_at, last_ok, last_error FROM job_status() WHERE job = $1`, [JOB])).rows[0];

  const sender = { lastFinishedAt: job?.last_finished_at ? new Date(job.last_finished_at).toISOString() : null, lastOk: job?.last_ok ?? null, lastError: job?.last_error ?? null };
  const verdict = assess({
    country, enabled: settings.enabled, productionAllowed: productionAllowed(),
    devices: devices.map((d) => ({ id: d.id, environment: d.environment, status: d.status, certDaysLeft: d.certDaysLeft })),
    waiting, rejected: rejectedRows.length, loginRefused, sender, now,
  });
  return {
    ...verdict, country, enabled: settings.enabled, productionAllowed: productionAllowed(), certWarnDays: CERT_WARN_DAYS, senderGapMinutes: SENDER_GAP_MINUTES,
    devices, waiting, waitingList, rejected: rejectedRows.slice(0, 20), sender,
    lastSevenDays: { cleared: week.cleared, reported: week.reported, lastAcceptedAt: week.lastAcceptedAt ? new Date(week.lastAcceptedAt).toISOString() : null },
    checkedAt: now.toISOString(),
  };
}
