// ZATCA phase 2 building blocks, checked offline: CSR, certificate details, invoice XML, hash, stamp and QR.
// A throwaway secp256k1 certificate made with openssl stands in for the CSID ZATCA issues; xmllint gives an
// independent canonical form (C14N 1.1) to compare the hash input against.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import * as Z from '../src/einvoice/zatca/crypto.js';
import * as X from '../src/einvoice/zatca/xml.js';
import type { EInvoiceData } from '../src/einvoice/invoiceData.js';
import * as A from '../src/einvoice/pintAe.js';

const dir = mkdtempSync(path.join(tmpdir(), 'zatca-'));
let key: string;
let cert: Z.CertInfo;

const seller = { name: 'Al Noor Trading', vatNumber: '310122393500003', crNumber: '1010010000', street: 'Prince Sultan', building: '2322', district: 'Al-Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' };
const buyer = { name: 'Gulf Steel & Sons', vatNumber: '300075588700003', street: 'King Fahd Road', building: '1111', district: 'Al-Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' };
const data = (over: Partial<EInvoiceData> = {}): EInvoiceData => ({
  number: 'INV-0001', uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', type: 'invoice', issueDate: '2026-11-03', issueTime: '14:40:40', supplyDate: '2026-11-03',
  currency: 'SAR', seller, buyer, paymentMeans: '10',
  lines: [
    { no: 1, description: 'Steel pipes <2">', quantity: '2.000', unitPrice: '500.00', net: '1000.00', vat: '150.00', vatCode: 'standard', vatRate: '15.00' },
    { no: 2, description: 'Export packing', quantity: '1.000', unitPrice: '100.00', net: '100.00', vat: '0.00', vatCode: 'zero', vatRate: '0.00' },
  ],
  netTotal: '1100.00', vatTotal: '150.00', grossTotal: '1250.00',
  exemption: { zero: { code: 'VATEX-SA-32', text: 'Export of goods' }, exempt: { code: 'VATEX-SA-29', text: 'Financial services' }, out_of_scope: { code: 'VATEX-SA-OOS', text: 'Not subject to VAT' } },
  ...over,
});

beforeAll(() => {
  key = Z.newKey().privatePem;
  writeFileSync(path.join(dir, 'key.pem'), key);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(dir, 'key.pem'), '-subj', '/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1', '-days', '30', '-out', path.join(dir, 'cert.pem')]);
  const pem = readFileSync(path.join(dir, 'cert.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, '');
  cert = Z.certInfo(Buffer.from(pem).toString('base64'));   // as ZATCA sends it: base64 of the base64 certificate
});

describe('Onboarding: key, CSR and certificate', () => {
  it('the CSR carries ZATCA\'s fields and verifies with openssl', () => {
    const csr = Z.makeCsr(key, { env: 'sandbox', commonName: 'TST-886431145-399999999900003', serialNumber: '1-Nusuh|2-1.0|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f',
      organisation: 'Al Noor Trading', organisationUnit: 'Riyadh Branch', vatNumber: '399999999900003', invoiceTypes: '1100', address: 'RRRD2929', industry: 'Trading' });
    expect(Buffer.from(csr.base64, 'base64').toString()).toBe(csr.pem);
    writeFileSync(path.join(dir, 'csr.pem'), csr.pem);
    const out = execFileSync('openssl', ['req', '-in', path.join(dir, 'csr.pem'), '-noout', '-verify', '-text'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    expect(out).toMatch(/Subject: C\s*=\s*SA, OU\s*=\s*Riyadh Branch, O\s*=\s*Al Noor Trading, CN\s*=\s*TST-886431145-399999999900003/);
    expect(out).toContain('TSTZATCA-Code-Signing');
    expect(out).toMatch(/SN\s*=\s*1-Nusuh\|2-1\.0\|3-ed22f1d8/);
    expect(out).toMatch(/UID\s*=\s*399999999900003/);
    expect(out).toMatch(/title\s*=\s*1100/);
    expect(out).toContain('secp256k1');
  });

  it('reads the certificate: issuer as ZATCA writes it, decimal serial, public key and CA signature', () => {
    expect(cert.issuer).toBe('CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local');
    expect(cert.serial).toMatch(/^\d+$/);
    expect(cert.publicKeyDer.equals(createPublicKey(Z.keyFrom(key)).export({ type: 'spki', format: 'der' }))).toBe(true);
    expect(cert.signature[0]).toBe(0x30);   // an ECDSA signature (DER sequence)
    expect(Z.certInfo(cert.base64).serial).toBe(cert.serial);   // plain base64 works too
  });
});

describe('Invoice XML', () => {
  it('standard invoice: type 0100000, chain references, buyer address, VAT breakdown with exemption reason', () => {
    const xml = X.invoiceXml(data(), { icv: 7, pih: X.FIRST_PIH });
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:ID>ICV</cbc:ID><cbc:UUID>7</cbc:UUID>');
    expect(xml).toContain(X.FIRST_PIH);
    expect(xml).toContain('<cbc:BuildingNumber>1111</cbc:BuildingNumber>');
    expect(xml).toContain('Steel pipes &lt;2&quot;&gt;');
    expect(xml).toMatch(/<cbc:TaxableAmount currencyID="SAR">1000.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">150.00<\/cbc:TaxAmount>/);
    expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>');
    expect(xml).toContain('<cbc:RoundingAmount currencyID="SAR">1150.00</cbc:RoundingAmount>');
    expect(xml).not.toContain('UBLExtensions');
    expect(X.FIRST_PIH).toBe(Buffer.from(createHash('sha256').update('0').digest('hex')).toString('base64'));
  });

  it('simplified credit note: 0200000 and 381, the original invoice and the reason', () => {
    const xml = X.invoiceXml(data({ type: 'credit_note', number: 'CN-0001', buyer: null, original: { number: 'INV-0001', issueDate: '2026-11-03' }, reason: 'Goods returned' }), { icv: 8, pih: X.FIRST_PIH });
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-0001</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>');
    expect(xml).toContain('<cbc:InstructionNote>Goods returned</cbc:InstructionNote>');
    expect(xml).toContain('<cac:AccountingCustomerParty></cac:AccountingCustomerParty>');
  });
});

describe('Advance payments (XML Implementation Standard 1.2, section 9.5)', () => {
  const advance = data({ number: 'INV-0005', advance: true, buyer: null,
    lines: [{ no: 1, description: 'Advance for booking BKG-0001', quantity: '1.000', unitPrice: '1000.00', net: '1000.00', vat: '150.00', vatCode: 'standard', vatRate: '15.00' }],
    netTotal: '1000.00', vatTotal: '150.00', grossTotal: '1150.00' });
  const final = data({ number: 'INV-0009', buyer: null,
    lines: [{ no: 1, description: 'Room 202, 4 nights', quantity: '4.000', unitPrice: '500.00', net: '2000.00', vat: '300.00', vatCode: 'standard', vatRate: '15.00' }],
    netTotal: '2000.00', vatTotal: '300.00', grossTotal: '2300.00',
    prepayments: [{ number: 'INV-0005', issueDate: '2026-11-01', issueTime: '09:15:00', net: '1000.00', vat: '150.00', vatCode: 'standard', vatRate: '15.00' }] });

  it('an advance invoice is type 386 (simplified 0200000, standard 0100000), with nothing prepaid', () => {
    expect(X.invoiceXml(advance, { icv: 9, pih: X.FIRST_PIH })).toContain('<cbc:InvoiceTypeCode name="0200000">386</cbc:InvoiceTypeCode>');
    expect(X.invoiceXml({ ...advance, buyer }, { icv: 9, pih: X.FIRST_PIH })).toContain('<cbc:InvoiceTypeCode name="0100000">386</cbc:InvoiceTypeCode>');
    expect(X.invoiceXml(advance, { icv: 9, pih: X.FIRST_PIH })).toContain('<cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="SAR">1150.00</cbc:PayableAmount>');
  });

  it('the final invoice: the whole supply and its VAT, prepaid = advance net + VAT (BT-113), payable = gross - prepaid (BR-CO-16)', () => {
    const xml = X.invoiceXml(final, { icv: 10, pih: X.FIRST_PIH });
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">2300.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">1150.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="SAR">1150.00</cbc:PayableAmount>');
    // The document VAT is the whole supply's (300), as in ZATCA's example.
    expect(xml).toMatch(/<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">300.00<\/cbc:TaxAmount><\/cac:TaxTotal>/);
  });

  it('one zero-value line per advance with its number, date, time and type 386, and the net and VAT taken off (BR-KSA-73 to 80)', () => {
    const xml = X.invoiceXml(final, { icv: 10, pih: X.FIRST_PIH });
    const line = xml.slice(xml.lastIndexOf('<cac:InvoiceLine>'));
    expect(line).toContain('<cbc:ID>2</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">0.00</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">0.00</cbc:LineExtensionAmount>');
    expect(line).toContain('<cac:DocumentReference><cbc:ID>INV-0005</cbc:ID><cbc:IssueDate>2026-11-01</cbc:IssueDate><cbc:IssueTime>09:15:00</cbc:IssueTime><cbc:DocumentTypeCode>386</cbc:DocumentTypeCode></cac:DocumentReference>');
    expect(line).toMatch(/<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">0.00<\/cbc:TaxAmount><cbc:RoundingAmount currencyID="SAR">0.00<\/cbc:RoundingAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="SAR">1000.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">150.00<\/cbc:TaxAmount><cac:TaxCategory>/);
    expect(line).toContain('<cbc:Name>Prepayment adjustment</cbc:Name>');
    expect(line).toContain('<cbc:PriceAmount currencyID="SAR">0.00</cbc:PriceAmount>');
    expect(execFileSync('xmllint', ['--noout', '-'], { input: xml }).toString()).toBe('');   // well formed
  });

  it('the stamp and QR still work: QR tag 4 is the amount due after the advance (BT-115), as ZATCA asks', () => {
    const st = X.stampInvoice(final, { icv: 10, pih: X.FIRST_PIH }, Z.keyFrom(key), cert, '2026-11-05T10:00:00');
    expect(X.readQr(st.qr)[4]!.toString()).toBe('1150.00');
    expect(st.xml).toContain('<cbc:PrepaidAmount currencyID="SAR">1150.00</cbc:PrepaidAmount>');
  });

  it('UAE (PINT AE): an advance is 386; a final invoice carries the prepaid amount and the amount due', () => {
    const ae = { currency: 'AED', seller: { name: 'Marina Café LLC', vatNumber: '100234567800003', city: 'Dubai', country: 'AE' }, buyer: { name: 'Jumeirah Hotels', vatNumber: '100998877600003', city: 'Dubai', country: 'AE' } };
    expect(A.pintAeXml({ ...advance, ...ae })).toContain('<cbc:InvoiceTypeCode>386</cbc:InvoiceTypeCode>');
    const xml = A.pintAeXml({ ...final, ...ae, prepayments: [{ ...final.prepayments![0]!, vat: '50.00', vatRate: '5.00' }] });
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="AED">1050.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="AED">1250.00</cbc:PayableAmount>');
  });
});

describe('Hash, stamp and QR', () => {
  it('the hash input is the canonical invoice without the stamp, the signature reference and the QR (checked with xmllint)', () => {
    const s = X.stampInvoice(data(), { icv: 1, pih: X.FIRST_PIH }, Z.keyFrom(key), cert, '2026-11-03T14:40:41');
    const { canonical, base64 } = X.invoiceHash(s.xml);
    expect(base64).toBe(s.hash);   // stamping does not change the hash
    const stripped = s.xml.replace(/<ext:UBLExtensions>.*<\/ext:UBLExtensions>/s, '').replace(/<cac:Signature>.*?<\/cac:Signature>/s, '')
      .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/s, '');
    writeFileSync(path.join(dir, 'stripped.xml'), stripped);
    const c14n = execFileSync('xmllint', ['--c14n11', path.join(dir, 'stripped.xml')]).toString();
    expect(canonical).toBe(c14n);
    expect(canonical).not.toMatch(/UBLExtensions|urn:oasis:names:specification:ubl:signature:Invoice|<cbc:ID>QR/);
    expect(s.xml).toContain(`<ds:DigestValue>${s.hash}</ds:DigestValue>`);
  });

  it('the signature verifies with the certificate key; the QR carries tags 1-9 for simplified invoices', () => {
    const s = X.stampInvoice(data({ buyer: null }), { icv: 2, pih: X.FIRST_PIH }, Z.keyFrom(key), cert, '2026-11-03T14:40:41');
    expect(s.kind).toBe('simplified');
    const pub = createPublicKey({ key: cert.publicKeyDer, format: 'der', type: 'spki' });
    expect(verify('sha256', Buffer.from(s.hash, 'base64'), pub, Buffer.from(s.signature, 'base64'))).toBe(true);
    const q = X.readQr(s.qr);
    expect([1, 2, 3, 4, 5].map((t) => q[t]!.toString())).toEqual(['Al Noor Trading', '310122393500003', '2026-11-03T14:40:40', '1250.00', '150.00']);
    expect(q[6]!.toString()).toBe(s.hash);
    expect(q[7]!.toString()).toBe(s.signature);
    expect(q[8]!.equals(cert.publicKeyDer)).toBe(true);
    expect(q[9]!.equals(cert.signature)).toBe(true);
    expect(X.readQr(X.stampInvoice(data(), { icv: 3, pih: s.hash }, Z.keyFrom(key), cert, '2026-11-03T14:40:41').qr)[9]).toBeUndefined();   // standard: ZATCA adds its own
  });

  it('the signed properties digest covers the signing time and certificate; the certificate digest is base64 of the hex SHA-256', () => {
    const a = X.signedPropertiesDigest('2026-11-03T14:40:41', cert), b = X.signedPropertiesDigest('2026-11-03T14:40:42', cert);
    expect(a).not.toBe(b);
    const s = X.stampInvoice(data(), { icv: 1, pih: X.FIRST_PIH }, Z.keyFrom(key), cert, '2026-11-03T14:40:41');
    expect(s.xml).toContain(`<ds:DigestValue>${a}</ds:DigestValue>`);
    expect(s.xml).toContain(Buffer.from(createHash('sha256').update(cert.base64).digest('hex')).toString('base64'));
    expect(s.xml).toContain(`<ds:X509IssuerName>${cert.issuer}</ds:X509IssuerName>`);
  });
});

describe('UAE: Peppol PINT AE', () => {
  const ae = (over: Partial<EInvoiceData> = {}) => data({ currency: 'AED', seller: { name: 'Marina Café LLC', vatNumber: '100234567800003', city: 'Dubai', country: 'AE' },
    buyer: { name: 'Jumeirah Hotels', vatNumber: '100998877600003', city: 'Dubai', country: 'AE' },
    lines: [{ no: 1, description: 'Catering', quantity: '1.000', unitPrice: '1000.00', net: '1000.00', vat: '50.00', vatCode: 'standard', vatRate: '5.00' }],
    netTotal: '1000.00', vatTotal: '50.00', grossTotal: '1050.00', ...over });
  it('an invoice carries the PINT AE customization, Peppol endpoints (scheme 0235) and the VAT breakdown', () => {
    const xml = A.pintAeXml(ae());
    expect(xml).toContain('<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:EndpointID schemeID="0235">1002345678</cbc:EndpointID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toMatch(/<cbc:TaxableAmount currencyID="AED">1000.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="AED">50.00<\/cbc:TaxAmount>/);
    expect(execFileSync('xmllint', ['--noout', '-'], { input: xml }).toString()).toBe('');   // well formed
  });
  it('a credit note is a CreditNote document pointing at the invoice; only buyers with a TRN are in scope', () => {
    const xml = A.pintAeXml(ae({ type: 'credit_note', number: 'CN-1', original: { number: 'INV-0001', issueDate: '2026-11-01' }, reason: 'Discount agreed' }));
    expect(xml).toMatch(/^<\?xml[^>]+>\n<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/);
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('<cac:CreditNoteLine>');
    expect(A.pintAeInScope(ae())).toBe(true);
    expect(A.pintAeInScope(ae({ buyer: { name: 'Walk-in', country: 'AE' } }))).toBe(false);
  });
});
