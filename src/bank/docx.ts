// Reads the first usable table of a Word (.docx) file into rows of text, in the browser or in Node, with no library and no AI:
// a .docx is a zip, and its tables are plain XML. Used to bring a customer's own list (contacts, items, accounts, balances) into
// the ordinary import, whose preview shows every row before anything is saved. Text outside tables is ignored.
import { unzip } from './xlsx.js';

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] === '#') { const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return entities[e.toLowerCase()] ?? '';
});
/** Text of one cell: its paragraphs joined by a space, tabs and line breaks as spaces. */
const cellText = (xml: string) => {
  const paras = xml.split(/<\/w:p>/).map((p) => decode(p.replace(/<w:(?:tab|br)\b[^>]*\/>/g, ' ').replace(/<(?!w:t[ >\/])[^>]*>/g, '').replace(/<w:t\b[^>]*>/g, '').replace(/<\/w:t>/g, '')).replace(/\s+/g, ' ').trim());
  return paras.filter(Boolean).join(' ');
};

export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

export async function readDocx(data: Uint8Array): Promise<string[][]> {
  if (data.length > MAX_DOCX_BYTES) throw new Error('file too large');
  const files = await unzip(data);
  const entry = files.get('word/document.xml');
  if (!entry) throw new Error('not a Word file');
  if (entry.length > 40 * 1024 * 1024) throw new Error('file too large');
  const xml = new TextDecoder().decode(entry);
  const tables = [...xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)].map((m) => m[0]);
  const parsed = tables.map((tbl) => [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) => cellText(tc[0]))).filter((r) => r.some(Boolean)));
  // the biggest table is the list; a Word file with no table cannot be read this way
  const best = parsed.filter((r) => r.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!best) throw new Error('no table found');
  return best;
}
