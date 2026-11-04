// Writes a one-sheet Excel (.xlsx) workbook: title lines, a bold header row, then rows of text and numbers.
// Numbers keep 2 decimals with thousands separators. Stored (uncompressed) zip, which Excel and LibreOffice open.
// Pure function: used by the web app for report exports and checked by the tests with readXlsx().
const enc = new TextEncoder();

export type Cell = string | { n: string } | null;    // { n: '1234.50' } is a number (decimal text, never a float in our code)
export interface SheetInput { title: string[]; header: string[]; rows: Cell[][]; rightToLeft?: boolean; sheetName?: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function sheetXml(x: SheetInput): string {
  const width = Math.max(x.header.length, ...x.rows.map((r) => r.length), 1);
  const cell = (c: Cell, ref: string, style: number) => {
    if (c === null || c === '') return '';
    if (typeof c === 'object') return `<c r="${ref}" s="${style === 1 ? 3 : 2}"><v>${esc(c.n)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
  };
  const rows: string[] = [];
  let r = 1;
  x.title.forEach((t, i) => { rows.push(`<row r="${r}">${cell(t, `A${r}`, i === 0 ? 4 : 0)}</row>`); r++; });
  if (x.title.length) r++;
  rows.push(`<row r="${r}">${x.header.map((h, i) => cell(h, `${col(i)}${r}`, 1)).join('')}</row>`); const headerRow = r; r++;
  for (const row of x.rows) {
    const bold = typeof row[0] === 'string' && /^(total|الإجمالي|net |صافي)/i.test(row[0]);
    rows.push(`<row r="${r}">${row.map((c, i) => cell(c, `${col(i)}${r}`, bold ? 1 : 0)).join('')}</row>`); r++;
  }
  const widths = Array.from({ length: width }, (_, i) => {
    const longest = Math.max(String(x.header[i] ?? '').length, ...x.rows.map((row) => { const c = row[i]; return c == null ? 0 : typeof c === 'object' ? c.n.length + 4 : c.length; }));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, longest + 2))}" customWidth="1"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${x.rightToLeft ? ' rightToLeft="1"' : ''}>`
    + `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${widths}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE1F2F0"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FF0F766E"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="5"><xf/><xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" applyNumberFormat="1" applyFont="1"/><xf fontId="2" applyFont="1"/></cellXfs></styleSheet>`;

export function writeXlsx(x: SheetInput): Uint8Array {
  const name = esc((x.sheetName ?? 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(x)],
  ];
  return zipStored(files.map(([n, t]) => [n, enc.encode(t)]));
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipStored(files: [string, Uint8Array][]): Uint8Array {
  const out: number[] = [], central: number[] = [];
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, data] of files) {
    const n = enc.encode(name), c = crc32(data), offset = out.length;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0), ...n);
    for (const b of data) out.push(b);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c), ...u32(data.length), ...u32(data.length),
      ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n);
  }
  const cd = out.length;
  return new Uint8Array([...out, ...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(cd), ...u16(0)]);
}

/** "1,234.50" or "-3,680.00" in a report cell becomes a number cell; anything else stays text. */
export function toCell(text: string): Cell {
  const t = text.trim();
  if (/^-?\(?[\d,]+\.\d{2}\)?$/.test(t)) {
    const neg = t.startsWith('-') || t.startsWith('(');
    return { n: `${neg ? '-' : ''}${t.replace(/[-(),]/g, '')}` };
  }
  return t;
}
