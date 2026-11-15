// Demo data only: a self-signed certificate for a demo e-invoicing device that is not connected to ZATCA, so the demo
// can show e-invoices made by the real XML, hash chain and QR code. ZATCA never issued it and would refuse it.
import { createPublicKey, sign } from 'node:crypto';
import * as D from '../der.js';
import { keyFrom } from './crypto.js';

const utcTime = (d: Date) => D.tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));

/** A self-signed X.509 certificate (base64 DER) for the key, valid for five years from now. */
export function demoCertificate(privatePem: string, commonName: string, now = new Date()): string {
  const key = keyFrom(privatePem);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const name = D.seq(D.set(D.seq(D.oid('2.5.4.10'), D.utf8('Nusuh Books demo, not issued by ZATCA'))), D.set(D.seq(D.oid('2.5.4.3'), D.utf8(commonName))));
  const alg = D.seq(D.oid('1.2.840.10045.4.3.2'));   // ecdsa-with-SHA256
  const tbs = D.seq(D.ctx(0, D.int(2)), D.int(1), alg, name, D.seq(utcTime(now), utcTime(new Date(now.getTime() + 5 * 365 * 86400000))), name, spki);
  return D.seq(tbs, alg, D.bits(sign('sha256', tbs, key))).toString('base64');
}
