// ZATCA e-invoice QR code, phase 1 (generation): five TLV fields, base64 encoded.
//   1 seller name, 2 seller VAT number, 3 time stamp (ISO 8601), 4 invoice total with VAT, 5 VAT total.
// Phase 2 (integration with Fatoora: XML, cryptographic stamp, clearance) adds more fields and is built in the
// ZATCA adapter once the technical specs are confirmed with ZATCA (CLAUDE.md).
const enc = new TextEncoder();

export interface ZatcaQrFields { sellerName: string; vatNumber: string; timestamp: string; total: string; vatTotal: string }

function tlv(tag: number, value: string): number[] {
  const bytes = [...enc.encode(value)];
  if (bytes.length > 255) throw new Error(`QR field ${tag} is too long`);
  return [tag, bytes.length, ...bytes];
}

export function zatcaQrPayload(f: ZatcaQrFields): string {
  const bytes = [...tlv(1, f.sellerName), ...tlv(2, f.vatNumber), ...tlv(3, f.timestamp), ...tlv(4, f.total), ...tlv(5, f.vatTotal)];
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Reads the fields back (for tests and for checking a printed code). */
export function readZatcaQr(base64: string): Record<number, string> {
  const bin = atob(base64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const out: Record<number, string> = {};
  for (let i = 0; i < bytes.length;) {
    const tag = bytes[i]!, len = bytes[i + 1]!;
    out[tag] = new TextDecoder().decode(bytes.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}

/** ZATCA time stamp: the moment the invoice was issued, in UTC without milliseconds. */
export const zatcaTimestamp = (issuedAt: string | null | undefined, issueDate: string) =>
  issuedAt ? new Date(issuedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : `${issueDate}T00:00:00Z`;
