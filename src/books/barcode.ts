// Barcodes for items: EAN-13 (the codes Nusuh makes for an item, starting with 2, the range for a shop's own use,
// and the codes on most goods from suppliers) and Code 128 for any other code a client already uses.
// Pure functions: the bars come out as a list of 0/1 modules that the screen draws as SVG.

/** EAN-13 / EAN-8 / UPC-A check digit for the digits before it. */
export function checkDigit(body: string): number {
  let sum = 0;
  // Weights run 3,1,3,1... from the digit next to the check digit.
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

/** True when an all-digit code of a retail length (8, 12, 13 or 14) has the wrong last digit: almost always a typing mistake. */
export function badCheckDigit(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  return checkDigit(code.slice(0, -1)) !== Number(code.at(-1));
}

/** Cleans a code typed or scanned: spaces removed. Empty means "make one for me". */
export function cleanBarcode(code: string | null | undefined): string {
  return String(code ?? '').replace(/\s+/g, '');
}

/** A code the label printer can print: printable characters only, up to 48. */
export function validBarcode(code: string): boolean {
  return /^[!-~]{1,48}$/.test(code) && !badCheckDigit(code);
}

/** The code Nusuh gives an item: 2 + 11 digits from a running number + check digit. */
export function internalEan(n: number | bigint): string {
  const body = `2${String(n).padStart(11, '0')}`;
  if (body.length !== 12) throw new Error('Barcode number out of range.');
  return body + checkDigit(body);
}

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** EAN-13 modules (95 of them: guard, 6 left digits, centre, 6 right digits, guard). */
export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code) || badCheckDigit(code)) throw new Error('Not an EAN-13 code.');
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  let s = '101';
  for (let i = 1; i <= 6; i++) s += (parity[i - 1] === 'L' ? L : G)[d[i]!];
  s += '01010';
  for (let i = 7; i <= 12; i++) s += R[d[i]!];
  return s + '101';
}

// Code 128 patterns (bar/space widths) for values 0..106; 106 is the stop (with its final bar).
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** Code 128 (set B) modules for any printable code, with a check symbol. */
export function code128Modules(code: string): string {
  if (!/^[ -~]{1,48}$/.test(code)) throw new Error('Code 128 takes printable characters only.');
  const values = [104, ...[...code].map((c) => c.charCodeAt(0) - 32)];
  const check = values.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0) % 103;
  let s = '';
  for (const v of [...values, check, 106]) {
    [...C128[v]!].forEach((w, i) => { s += (i % 2 === 0 ? '1' : '0').repeat(Number(w)); });
  }
  return s;
}

/** The modules for a code: EAN-13 when it is one, otherwise Code 128. */
export function barcodeModules(code: string): { kind: 'ean13' | 'code128'; modules: string } {
  return /^\d{13}$/.test(code) && !badCheckDigit(code) ? { kind: 'ean13', modules: ean13Modules(code) } : { kind: 'code128', modules: code128Modules(code) };
}
