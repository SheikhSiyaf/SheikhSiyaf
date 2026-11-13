// ZATCA phase 2 (integration): the UBL 2.1 invoice XML, its hash, the cryptographic stamp (XAdES, ECDSA on
// secp256k1) and the phase 2 QR code. Follows ZATCA's "E-Invoice XML Implementation Standard" and "Security
// Features Implementation Standard" as used by the Fatoora SDK:
//   * invoice hash = SHA-256 of the canonical XML (C14N 1.1) without ext:UBLExtensions, cac:Signature and the QR
//     reference; DigestValue is that hash in base64.
//   * the signature is ECDSA over the invoice hash; the signed properties and certificate digests are base64 of
//     the hex SHA-256 (ZATCA's convention).
//   * the chain: ICV (invoice counter) and PIH (previous invoice hash; the first is the hash of "0").
// The XML is written without indentation, so removing the excluded elements leaves no stray whitespace.
import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { C14nCanonicalization, ExclusiveCanonicalization } from 'xml-crypto';
import { fromCents, toCents, type EInvoiceData } from '../invoiceData.js';
import type { CertInfo } from './crypto.js';

import { FIRST_PIH, NS, el, esc, invoiceXml, kindFor, text, type Chain, type ZatcaKind } from './ubl.js';
export { FIRST_PIH, TYPE_CODE, invoiceXml, kindFor, type Chain, type ZatcaKind } from './ubl.js';

// ------------------------------------------------------------------ hash
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');
/** The invoice hash: SHA-256 of the canonical invoice without the stamp, the signature reference and the QR. */
export function invoiceHash(xml: string): { hash: Buffer; base64: string; canonical: string } {
  const doc = parse(xml);
  const root = doc.documentElement!;
  const drop: Element[] = [];
  for (const n of Array.from(root.childNodes) as Element[]) {
    if (n.nodeType !== 1) continue;
    if (n.localName === 'UBLExtensions' && n.namespaceURI === NS.ext) drop.push(n);
    if (n.localName === 'Signature' && n.namespaceURI === NS.cac) drop.push(n);
    if (n.localName === 'AdditionalDocumentReference' && n.namespaceURI === NS.cac) {
      const id = Array.from(n.childNodes).find((c) => (c as Element).localName === 'ID') as Element | undefined;
      if (id?.textContent === 'QR') drop.push(n);
    }
  }
  for (const n of drop) root.removeChild(n);
  const canonical = new C14nCanonicalization().process(root as unknown as Element, {}) as string;
  const hash = createHash('sha256').update(canonical, 'utf8').digest();
  return { hash, base64: hash.toString('base64'), canonical };
}
const hexB64 = (s: string | Buffer) => Buffer.from(createHash('sha256').update(s).digest('hex')).toString('base64');

// ------------------------------------------------------------------ QR (phase 2: tags 1-9)
function tlv(tag: number, value: Buffer): Buffer {
  if (value.length > 255) throw new Error(`QR field ${tag} is too long`);
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}
export interface QrInput { sellerName: string; vatNumber: string; timestamp: string; total: string; vatTotal: string; hash: string; signature: string; publicKey: Buffer; certSignature?: Buffer }
/** Tags 1-5 as in phase 1; 6 invoice hash, 7 ECDSA signature, 8 public key; 9 the certificate's signature (simplified invoices). */
export function qrCode(q: QrInput): string {
  const u = (s: string) => Buffer.from(s, 'utf8');
  return Buffer.concat([tlv(1, u(q.sellerName)), tlv(2, u(q.vatNumber)), tlv(3, u(q.timestamp)), tlv(4, u(q.total)), tlv(5, u(q.vatTotal)),
    tlv(6, u(q.hash)), tlv(7, u(q.signature)), tlv(8, q.publicKey), ...(q.certSignature ? [tlv(9, q.certSignature)] : [])]).toString('base64');
}
export function readQr(base64: string): Record<number, Buffer> {
  const b = Buffer.from(base64, 'base64'); const out: Record<number, Buffer> = {};
  for (let i = 0; i < b.length;) { const tag = b[i]!, len = b[i + 1]!; out[tag] = b.subarray(i + 2, i + 2 + len); i += 2 + len; }
  return out;
}

// ------------------------------------------------------------------ the stamp
const SP_ID = 'xadesSignedProperties';
function signedProperties(signingTime: string, cert: CertInfo, declareNs: boolean): string {
  const ds = { 'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#' };
  return el('xades:SignedProperties', declareNs ? { 'xmlns:xades': 'http://uri.etsi.org/01903/v1.3.2#', Id: SP_ID } : { Id: SP_ID },
    el('xades:SignedSignatureProperties', null,
      el('xades:SigningTime', null, signingTime),
      el('xades:SigningCertificate', null, el('xades:Cert', null,
        el('xades:CertDigest', null, el('ds:DigestMethod', { ...(declareNs ? ds : {}), Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }), el('ds:DigestValue', declareNs ? ds : null, hexB64(cert.base64))),
        el('xades:IssuerSerial', null, el('ds:X509IssuerName', declareNs ? ds : null, text(cert.issuer)), el('ds:X509SerialNumber', declareNs ? ds : null, cert.serial))))));
}
function signatureBlock(hash: string, signature: string, cert: CertInfo, signingTime: string, spDigest: string): string {
  const xpath = (x: string) => el('ds:Transform', { Algorithm: 'http://www.w3.org/TR/1999/REC-xpath-19991116' }, el('ds:XPath', null, text(x)));
  return el('ext:UBLExtensions', null, el('ext:UBLExtension', null,
    el('ext:ExtensionURI', null, 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'),
    el('ext:ExtensionContent', null, el('sig:UBLDocumentSignatures', {
      'xmlns:sig': 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
      'xmlns:sac': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
      'xmlns:sbc': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2' },
    el('sac:SignatureInformation', null,
      el('cbc:ID', null, 'urn:oasis:names:specification:ubl:signature:1'),
      el('sbc:ReferencedSignatureID', null, 'urn:oasis:names:specification:ubl:signature:Invoice'),
      el('ds:Signature', { 'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#', Id: 'signature' },
        el('ds:SignedInfo', null,
          el('ds:CanonicalizationMethod', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
          el('ds:SignatureMethod', { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
          el('ds:Reference', { Id: 'invoiceSignedData', URI: '' },
            el('ds:Transforms', null,
              xpath('not(//ancestor-or-self::ext:UBLExtensions)'), xpath('not(//ancestor-or-self::cac:Signature)'),
              xpath("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
              el('ds:Transform', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' })),
            el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }), el('ds:DigestValue', null, hash)),
          el('ds:Reference', { Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties', URI: `#${SP_ID}` },
            el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }), el('ds:DigestValue', null, spDigest))),
        el('ds:SignatureValue', null, signature),
        el('ds:KeyInfo', null, el('ds:X509Data', null, el('ds:X509Certificate', null, cert.base64))),
        el('ds:Object', null, el('xades:QualifyingProperties', { 'xmlns:xades': 'http://uri.etsi.org/01903/v1.3.2#', Target: 'signature' },
          signedProperties(signingTime, cert, false)))))))));
}

/** The signed-properties digest: exclusive canonical form of the element, SHA-256 in hex, base64 (ZATCA's convention). */
export function signedPropertiesDigest(signingTime: string, cert: CertInfo): string {
  const doc = parse(signedProperties(signingTime, cert, true));
  const canonical = new ExclusiveCanonicalization().process(doc.documentElement as unknown as Element, {}) as string;
  return hexB64(canonical);
}

/** QR tag 4: the amount due (BT-115), i.e. the total with VAT less any advances deducted (ZATCA warns otherwise). */
const payable = (d: EInvoiceData) => fromCents(toCents(d.grossTotal) - (d.prepayments ?? []).reduce((t, p) => t + toCents(p.net) + toCents(p.vat), 0n));

export interface Stamped { xml: string; hash: string; signature: string; qr: string; kind: ZatcaKind }
/** Builds, hashes, signs and stamps an invoice. `signingTime` is local time yyyy-MM-ddTHH:mm:ss. */
export function stampInvoice(d: EInvoiceData, chain: Chain, key: KeyObject, cert: CertInfo, signingTime: string): Stamped {
  const kind = kindFor(d.buyer);
  const { hash, base64: hashB64 } = invoiceHash(invoiceXml(d, chain));
  const signature = sign('sha256', hash, key).toString('base64');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const qr = qrCode({ sellerName: d.seller.name, vatNumber: d.seller.vatNumber ?? '', timestamp: `${d.issueDate}T${d.issueTime}`, total: payable(d), vatTotal: d.vatTotal,
    hash: hashB64, signature, publicKey, certSignature: kind === 'simplified' ? cert.signature : undefined });
  const block = signatureBlock(hashB64, signature, cert, signingTime, signedPropertiesDigest(signingTime, cert));
  return { xml: invoiceXml(d, chain, qr, block), hash: hashB64, signature, qr, kind };
}
