// ZATCA Fatoora API: onboarding (compliance CSID, compliance checks, production CSID) and sending invoices
// (clearance for standard invoices, reporting for simplified ones within 24 hours). Version 2 of the API.
import type { ZatcaEnv } from './crypto.js';

export const BASE: Record<ZatcaEnv, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface Messages { type?: string; code?: string; category?: string; message?: string; status?: string }
export interface Validation { status?: string; infoMessages?: Messages[] | Messages; warningMessages?: Messages[]; errorMessages?: Messages[] }
export interface Result {
  /** What happened: accepted (with or without warnings), rejected by the rules, or not reached (network, outage, login). */
  outcome: 'accepted' | 'rejected' | 'unreachable';
  httpStatus: number;
  clearedXml?: string;
  warnings: string[]; errors: string[];
  raw: unknown;
}
export interface Credentials { token: string; secret: string }
export interface InvoiceSubmission { invoiceHash: string; uuid: string; xml: string }

const auth = (c: Credentials) => `Basic ${Buffer.from(`${c.token}:${c.secret}`).toString('base64')}`;
const list = (m?: Messages[] | Messages) => (Array.isArray(m) ? m : m ? [m] : []).map((x) => [x.code, x.message].filter(Boolean).join(': '));

export class ZatcaClient {
  constructor(private env: ZatcaEnv, private fetchFn: Fetch = fetch as unknown as Fetch, private timeoutMs = 20_000) {}

  private async call(path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchFn(`${BASE[this.env]}${path}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Accept-Version': 'V2', 'Accept-Language': 'en', Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: r.status, json, text };
    } finally { clearTimeout(t); }
  }

  /** Step 1: the CSR and the one-time password from the Fatoora portal give the compliance CSID. */
  async complianceCsid(csrBase64: string, otp: string): Promise<{ requestId: string; token: string; secret: string } | { error: string }> {
    const r = await this.call('/compliance', { csr: csrBase64 }, { OTP: otp }).catch((e) => ({ status: 0, json: null, text: String(e) }));
    const j = r.json as { requestID?: unknown; binarySecurityToken?: string; secret?: string; errors?: unknown } | null;
    if (r.status === 200 && j?.binarySecurityToken && j.secret) return { requestId: String(j.requestID), token: j.binarySecurityToken, secret: j.secret };
    return { error: r.status === 0 ? 'unreachable' : JSON.stringify(j?.errors ?? j ?? r.text).slice(0, 500) };
  }
  /** Step 2: sample invoices of each kind are checked with the compliance CSID. */
  complianceCheck(c: Credentials, inv: InvoiceSubmission) { return this.send('/compliance/invoices', c, inv, {}); }
  /** Step 3: the production CSID, once the checks passed. */
  async productionCsid(c: Credentials, complianceRequestId: string): Promise<{ requestId: string; token: string; secret: string } | { error: string }> {
    const r = await this.call('/production/csids', { compliance_request_id: complianceRequestId }, { Authorization: auth(c) }).catch((e) => ({ status: 0, json: null, text: String(e) }));
    const j = r.json as { requestID?: unknown; binarySecurityToken?: string; secret?: string; errors?: unknown } | null;
    if (r.status === 200 && j?.binarySecurityToken && j.secret) return { requestId: String(j.requestID), token: j.binarySecurityToken, secret: j.secret };
    return { error: r.status === 0 ? 'unreachable' : JSON.stringify(j?.errors ?? j ?? r.text).slice(0, 500) };
  }
  /** Standard (B2B) invoices: cleared by ZATCA before they are given to the buyer. */
  clearance(c: Credentials, inv: InvoiceSubmission) { return this.send('/invoices/clearance/single', c, inv, { 'Clearance-Status': '1' }); }
  /** Simplified (B2C) invoices: reported within 24 hours. */
  reporting(c: Credentials, inv: InvoiceSubmission) { return this.send('/invoices/reporting/single', c, inv, { 'Clearance-Status': '0' }); }

  private async send(path: string, c: Credentials, inv: InvoiceSubmission, headers: Record<string, string>): Promise<Result> {
    let r: { status: number; json: Record<string, unknown> | null; text: string };
    try {
      r = await this.call(path, { invoiceHash: inv.invoiceHash, uuid: inv.uuid, invoice: Buffer.from(inv.xml, 'utf8').toString('base64') }, { Authorization: auth(c), ...headers });
    } catch (e) {
      return { outcome: 'unreachable', httpStatus: 0, warnings: [], errors: [String((e as Error).message ?? e)], raw: null };
    }
    const j = (r.json ?? {}) as { validationResults?: Validation; clearedInvoice?: string; clearanceStatus?: string; reportingStatus?: string };
    const v = j.validationResults ?? {};
    const warnings = list(v.warningMessages), errors = list(v.errorMessages);
    const passed = (j.clearanceStatus === 'CLEARED' || j.reportingStatus === 'REPORTED' || v.status === 'PASS' || v.status === 'WARNING') && !errors.length;
    // 200 accepted; 202 accepted with warnings; 400 rejected; 401 credentials; 5xx and 0 not reached (send again later).
    const outcome = (r.status === 200 || r.status === 202) && passed ? 'accepted' : r.status === 400 || ((r.status === 200 || r.status === 202) && !passed) ? 'rejected' : 'unreachable';
    return { outcome, httpStatus: r.status, clearedXml: j.clearedInvoice ? Buffer.from(j.clearedInvoice, 'base64').toString('utf8') : undefined,
      warnings, errors: errors.length || outcome !== 'unreachable' ? errors : [`HTTP ${r.status}`], raw: r.json ?? r.text.slice(0, 2000) };
  }
}
