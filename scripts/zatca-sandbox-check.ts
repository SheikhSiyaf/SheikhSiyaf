// ZATCA sandbox check (Stage 1). Runs our own ZATCA code end to end against ZATCA's developer-portal SANDBOX with dummy
// data: a new key and CSR, the compliance CSID, the compliance checks for each invoice type, the production CSID, then
// clearance (standard) and reporting (simplified) of each type. It never talks to simulation or production.
//   npx tsx scripts/zatca-sandbox-check.ts [output folder]
// The sandbox accepts ZATCA's published test one-time password 123345 (ZATCA_SANDBOX_OTP overrides it). Nothing is
// written to the database. Every request and response body is saved to the output folder as evidence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Z from '../src/einvoice/zatca/crypto.js';
import * as X from '../src/einvoice/zatca/xml.js';
import { ZatcaClient, BASE, type Fetch, type Result } from '../src/einvoice/zatca/api.js';
import type { EInvoiceData, EParty } from '../src/einvoice/invoiceData.js';

const ENV = 'sandbox' as const;
if (!BASE[ENV].endsWith('/developer-portal')) throw new Error('Refusing to run: the sandbox address is not the developer portal.');
const out = process.argv[2] ?? 'zatca-sandbox-run';
mkdirSync(out, { recursive: true });
let seq = 0;
const save = (name: string, body: string) => writeFileSync(join(out, `${String(++seq).padStart(2, '0')}-${name}`), body);

// A fetch that records every exchange.
const recording: Fetch = async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  const text = await r.text();
  const step = url.replace(BASE[ENV], '').replace(/\//g, '_');
  save(`${step}.request.json`, JSON.stringify({ url, headers: { ...init.headers, Authorization: init.headers.Authorization ? '(hidden)' : undefined, OTP: init.headers.OTP ? '(sandbox OTP)' : undefined }, body: init.body ? JSON.parse(init.body) : null }, null, 2));
  save(`${step}.response.txt`, `HTTP ${r.status}\n${text}`);
  return { status: r.status, text: async () => text };
};
const client = new ZatcaClient(ENV, recording, 60_000);

// Dummy taxpayer: ZATCA's sample VAT number format (15 digits, starts and ends with 3).
const seller: EParty = { name: 'Nusuh Books Sandbox Test Co', vatNumber: '399999999900003', crNumber: '1010010000', street: 'Prince Sultan Street', building: '2322',
  district: 'Al Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' };
const buyer: EParty = { name: 'Sandbox Buyer Co', vatNumber: '399999999800003', crNumber: '1010020000', street: 'King Fahd Road', building: '1234', district: 'Al Olaya',
  city: 'Riyadh', postalCode: '12345', country: 'SA' };

function local() { const s = new Date(Date.now() + 3 * 3600_000).toISOString(); return { date: s.slice(0, 10), time: s.slice(11, 19) }; }
function doc(n: string, type: EInvoiceData['type'], b: EParty | null, original?: string): EInvoiceData {
  const at = local();
  return { number: n, uuid: randomUUID(), type, issueDate: at.date, issueTime: at.time, supplyDate: at.date, currency: 'SAR', seller, buyer: b,
    lines: [{ no: 1, description: 'Consulting service', quantity: '2.000', unitPrice: '50.00', net: '100.00', vat: '15.00', vatCode: 'standard', vatRate: '15.00' }],
    netTotal: '100.00', vatTotal: '15.00', grossTotal: '115.00', original: original ? { number: original, issueDate: at.date } : null,
    reason: type === 'invoice' ? null : (type === 'credit_note' ? 'Returned goods' : 'Price increase'), paymentMeans: '10',
    exemption: { zero: { code: 'VATEX-SA-32', text: 'Export of goods' }, exempt: { code: 'VATEX-SA-29', text: 'Financial services' }, out_of_scope: { code: 'VATEX-SA-OOS', text: 'Out of scope' } } };
}
const cases = (prefix: string) => [
  doc(`${prefix}-1`, 'invoice', buyer), doc(`${prefix}-2`, 'credit_note', buyer, `${prefix}-1`), doc(`${prefix}-3`, 'debit_note', buyer, `${prefix}-1`),
  doc(`${prefix}-4`, 'invoice', null), doc(`${prefix}-5`, 'credit_note', null, `${prefix}-4`), doc(`${prefix}-6`, 'debit_note', null, `${prefix}-4`),
];
const label = (d: EInvoiceData) => `${d.buyer ? 'standard' : 'simplified'} ${d.type.replace('_', ' ')}`;

interface Row { stage: string; invoice: string; number: string; icv: number; httpStatus: number; outcome: string; warnings: string[]; errors: string[]; status?: string }
const rows: Row[] = [];
const report = (stage: string, d: EInvoiceData, icv: number, r: Result) => {
  const raw = r.raw as { clearanceStatus?: string; reportingStatus?: string; validationResults?: { status?: string } } | null;
  rows.push({ stage, invoice: label(d), number: d.number, icv, httpStatus: r.httpStatus, outcome: r.outcome, warnings: r.warnings, errors: r.errors,
    status: raw && typeof raw === 'object' ? (raw.clearanceStatus ?? raw.reportingStatus ?? raw.validationResults?.status) : undefined });
};

async function main() {
  const otp = process.env.ZATCA_SANDBOX_OTP ?? '123345';
  const { privatePem } = Z.newKey();
  const csr = Z.makeCsr(privatePem, { env: ENV, commonName: 'EGS-SANDBOX-TEST', serialNumber: `1-NusuhBooks|2-1.0|3-${randomUUID()}`, organisation: seller.name,
    organisationUnit: 'Riyadh Branch', vatNumber: seller.vatNumber!, invoiceTypes: '1100', address: 'RRRD2929', industry: 'Services' });
  save('csr.pem', csr.pem);
  const key = Z.keyFrom(privatePem);

  const ccsid = await client.complianceCsid(csr.base64, otp);
  console.log('Compliance CSID:', 'error' in ccsid ? `FAILED ${ccsid.error}` : `issued (request ${ccsid.requestId})`);
  if ('error' in ccsid) return finish({ complianceCsid: ccsid.error });
  const cCreds = { token: ccsid.token, secret: ccsid.secret };
  const cCert = Z.certInfo(ccsid.token);

  let icv = 0, pih = X.FIRST_PIH;
  const stamp = (d: EInvoiceData, cert: Z.CertInfo) => { const at = local(); const st = X.stampInvoice(d, { icv: ++icv, pih }, key, cert, `${at.date}T${at.time}`); pih = st.hash; save(`${d.number}.xml`, st.xml); return st; };

  for (const d of cases('CMP')) {
    const st = stamp(d, cCert);
    const r = await client.complianceCheck(cCreds, { invoiceHash: st.hash, uuid: d.uuid, xml: st.xml });
    report('compliance check', d, icv, r);
  }

  const pcsid = await client.productionCsid(cCreds, ccsid.requestId);
  console.log('Production CSID:', 'error' in pcsid ? `FAILED ${pcsid.error}` : 'issued');
  if ('error' in pcsid) return finish({ complianceCsid: 'issued', productionCsid: pcsid.error });
  const pCreds = { token: pcsid.token, secret: pcsid.secret };
  let pCert: Z.CertInfo | null = null;
  try { pCert = Z.certInfo(pcsid.token); } catch (e) { console.log('Production certificate could not be read:', (e as Error).message); }
  if (!pCert) return finish({ complianceCsid: 'issued', productionCsid: 'issued but its certificate could not be read' });

  for (const d of cases('INV')) {
    const st = stamp(d, pCert);
    const r = d.buyer ? await client.clearance(pCreds, { invoiceHash: st.hash, uuid: d.uuid, xml: st.xml })
                      : await client.reporting(pCreds, { invoiceHash: st.hash, uuid: d.uuid, xml: st.xml });
    report(d.buyer ? 'clearance' : 'reporting', d, icv, r);
    if (r.clearedXml) save(`${d.number}.cleared.xml`, r.clearedXml);
  }
  return finish({ complianceCsid: 'issued', productionCsid: 'issued' });
}

function finish(onboarding: Record<string, string>) {
  const summary = { ranAt: new Date().toISOString(), environment: ENV, baseUrl: BASE[ENV], onboarding, results: rows };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const r of rows) console.log(`${r.stage.padEnd(17)} ${r.invoice.padEnd(24)} ICV ${String(r.icv).padStart(2)}  HTTP ${r.httpStatus}  ${r.outcome}${r.status ? ` (${r.status})` : ''}` +
    (r.errors.length ? `\n    errors: ${r.errors.join(' | ')}` : '') + (r.warnings.length ? `\n    warnings: ${r.warnings.join(' | ')}` : ''));
  console.log(`\nEvidence saved in ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
