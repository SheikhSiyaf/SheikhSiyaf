// A small ASN.1 DER encoder and reader: enough for the ZATCA certificate signing request and for reading the
// certificate ZATCA issues (its public key and signature go into the phase 2 QR code).

export type Der = Buffer;

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export const tlv = (tag: number, body: Buffer): Der => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
export const seq = (...items: Der[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Der[]) => tlv(0x31, Buffer.concat(items));
export const int = (n: number) => tlv(0x02, Buffer.from([n]));
export const octets = (b: Buffer) => tlv(0x04, b);
export const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
/** Context-specific tag [n], constructed (explicit or a constructed choice). */
export const ctx = (n: number, body: Buffer) => tlv(0xa0 | n, body);

export function oid(dotted: string): Der {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0]! + p[1]!];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift((x & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

/** One element read from DER: its tag, where its content starts and ends. */
export interface Node { tag: number; start: number; end: number; header: number }
export function read(buf: Buffer, at = 0): Node {
  const tag = buf[at]!;
  let n = buf[at + 1]!, header = 2;
  if (n & 0x80) {
    const k = n & 0x7f; n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + buf[at + 2 + i]!;
    header = 2 + k;
  }
  return { tag, start: at + header, end: at + header + n, header };
}
/** The child elements of a constructed element. */
export function children(buf: Buffer, node: Node): Node[] {
  const out: Node[] = [];
  for (let at = node.start; at < node.end;) { const c = read(buf, at); out.push(c); at = c.end; }
  return out;
}
