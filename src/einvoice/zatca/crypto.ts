// ZATCA phase 2 keys and certificates: the device's secp256k1 key, the certificate signing request (CSR) sent to
// ZATCA with the one-time password, and the details of the certificate (CSID) ZATCA sends back.
// CSR fields follow ZATCA's "Developer Portal Manual" and the Fatoora SDK's csr-config template.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import * as D from '../der.js';

export type ZatcaEnv = 'sandbox' | 'simulation' | 'production';
/** The certificate template ZATCA expects in the CSR for each environment. */
export const TEMPLATE: Record<ZatcaEnv, string> = { sandbox: 'TSTZATCA-Code-Signing', simulation: 'PREZATCA-Code-Signing', production: 'ZATCA-Code-Signing' };

export function newKey(): { privatePem: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
export const keyFrom = (privatePem: string): KeyObject => createPrivateKey(privatePem);

export interface CsrInput {
  env: ZatcaEnv;
  /** CN: the device (EGS unit) name, unique for the taxpayer. */
  commonName: string;
  /** SN in the SAN: "1-<solution>|2-<version>|3-<device serial>". */
  serialNumber: string;
  /** Organisation (taxpayer) name and unit (branch name, or the 10-digit TIN for VAT groups). */
  organisation: string; organisationUnit: string;
  vatNumber: string;
  /** "1100": standard and simplified invoices; "1000" standard only; "0100" simplified only. */
  invoiceTypes: string;
  address: string; industry: string;
}

/** The CSR as ZATCA wants it in the onboarding call: the PEM text, base64 encoded. */
export function makeCsr(privatePem: string, f: CsrInput): { pem: string; base64: string } {
  const key = keyFrom(privatePem);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const rdn = (o: string, value: D.Der) => D.set(D.seq(D.oid(o), value));
  const subject = D.seq(rdn('2.5.4.6', D.printable('SA')), rdn('2.5.4.11', D.utf8(f.organisationUnit)), rdn('2.5.4.10', D.utf8(f.organisation)), rdn('2.5.4.3', D.utf8(f.commonName)));
  const dirName = D.seq(
    rdn('2.5.4.4', D.utf8(f.serialNumber)),                       // SN
    rdn('0.9.2342.19200300.100.1.1', D.utf8(f.vatNumber)),       // UID
    rdn('2.5.4.12', D.utf8(f.invoiceTypes)),                      // title
    rdn('2.5.4.26', D.utf8(f.address)),                           // registeredAddress
    rdn('2.5.4.15', D.utf8(f.industry)),                          // businessCategory
  );
  const extensions = D.seq(
    D.seq(D.oid('1.3.6.1.4.1.311.20.2'), D.octets(D.printable(TEMPLATE[f.env]))),   // certificate template name
    D.seq(D.oid('2.5.29.17'), D.octets(D.seq(D.ctx(4, dirName)))),                    // subjectAltName: directoryName
  );
  const attributes = D.ctx(0, D.seq(D.oid('1.2.840.113549.1.9.14'), D.set(extensions)));   // extensionRequest
  const info = D.seq(D.int(0), subject, spki, attributes);
  const signature = sign('sha256', info, key);   // ECDSA, DER encoded
  const der = D.seq(info, D.seq(D.oid('1.2.840.10045.4.3.2')), D.bits(signature));
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  return { pem, base64: Buffer.from(pem).toString('base64') };
}

export interface CertInfo {
  /** The certificate as base64 DER (what goes into ds:X509Certificate). */
  base64: string;
  /** Issuer as written in the signature: "CN=..., DC=..., ..." (last RDN first, as ZATCA's samples show). */
  issuer: string;
  /** Serial number in decimal. */
  serial: string;
  publicKeyDer: Buffer;
  /** The certificate's own signature (by ZATCA's CA): QR tag 9. */
  signature: Buffer;
  validTo: string;
}

/** Does the certificate carry this private key's public key? Signing with a key the certificate does not name makes
 *  every invoice fail ZATCA's checks (the QR public key and the signature no longer match the certificate). */
export function certMatchesKey(cert: CertInfo, key: KeyObject): boolean {
  return cert.publicKeyDer.equals(createPublicKey(key).export({ type: 'spki', format: 'der' }));
}

/** Reads the certificate from ZATCA's binarySecurityToken (base64 of the base64 DER), or from base64 DER itself. */
export function certInfo(tokenOrBase64: string): CertInfo {
  const inner = Buffer.from(tokenOrBase64, 'base64').toString('latin1');
  const base64 = /^MI[A-Za-z0-9+/=\s]+$/.test(inner) ? inner.replace(/\s+/g, '') : tokenOrBase64.replace(/\s+/g, '');
  const der = Buffer.from(base64, 'base64');
  const x = new X509Certificate(der);
  const top = D.read(der);
  const [, , sig] = D.children(der, top);
  return {
    base64,
    issuer: x.issuer.split('\n').reverse().join(', '),
    serial: BigInt(`0x${x.serialNumber}`).toString(10),
    publicKeyDer: x.publicKey.export({ type: 'spki', format: 'der' }),
    signature: der.subarray(sig!.start + 1, sig!.end),   // skip the "unused bits" byte of the BIT STRING
    validTo: new Date(x.validTo).toISOString(),
  };
}
