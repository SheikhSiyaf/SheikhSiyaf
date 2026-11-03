// Printing and exports.
//   * PDF: the document is drawn as a clean A4 page (web/src/print/Pdf.tsx) and the browser's print window opens,
//     where "Save as PDF" keeps it as a PDF. The file name is the document title (e.g. "INV-0007 Gulf Steel").
//     Arabic is drawn by the browser, so it is always shaped and right to left.
//   * Excel: the tables on a report page are written to an .xlsx file (src/export/xlsx.ts), numbers as numbers.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n.tsx';
import { toCell, writeXlsx, type Cell } from '../../../src/export/xlsx.ts';
import type { CompanyBooks } from '../api.ts';
import { ReportSheet } from './Pdf.tsx';

let show: ((x: { node: ReactNode; title: string } | null) => void) | null = null;

/** Mounted once at the top of the app; holds the page being printed. */
export function PrintHost() {
  const [job, setJob] = useState<{ node: ReactNode; title: string } | null>(null);
  useEffect(() => { show = setJob; return () => { show = null; }; }, []);
  useEffect(() => {
    if (!job) return;
    const oldTitle = document.title;
    document.title = job.title.replace(/[\\/:*?"<>|]/g, '-');
    document.body.classList.add('printing');
    let cancelled = false;
    const done = () => { document.body.classList.remove('printing'); document.title = oldTitle; setJob(null); };
    window.addEventListener('afterprint', done, { once: true });
    // Wait for pictures (QR code, attached receipts) before opening the print window.
    const imgs = [...document.querySelectorAll<HTMLImageElement>('#print-root img')];
    void Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; })))).then(() => {
      if (!cancelled) setTimeout(() => window.print(), 50);
    });
    return () => { cancelled = true; window.removeEventListener('afterprint', done); };
  }, [job]);
  return job ? createPortal(<div id="print-root">{job.node}</div>, document.body) : null;
}

/** Opens the print window for a document; build() may load what it needs first (QR code, attachments). */
export async function printPdf(title: string, build: () => ReactNode | Promise<ReactNode>) {
  const node = await build();
  show?.({ node, title });
}

function download(bytes: Uint8Array, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = fileName.replace(/[\\/:*?"<>|]/g, '-');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Reads the tables inside an element: header cells, then body and footer rows, as text. */
function readTables(root: HTMLElement): { header: string[]; rows: Cell[][] } {
  const tables = [...root.querySelectorAll('table')].filter((t) => !t.closest('.no-export'));
  let header: string[] = [];
  const rows: Cell[][] = [];
  tables.forEach((t, n) => {
    const head = [...t.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim());
    if (n === 0) header = head;
    else { rows.push([]); if (head.length) rows.push(head); }
    for (const tr of t.querySelectorAll('tbody tr, tfoot tr')) {
      const cells = [...tr.querySelectorAll('td, th')].map((c) => toCell((c as HTMLElement).innerText.replace(/\s+/g, ' ')));
      if (cells.some((c) => c !== '' && c !== null)) rows.push(cells);
    }
  });
  return { header, rows };
}

/** "PDF" and "Excel" buttons for a report: both take the tables shown inside `target`. */
export function ExportBar({ books, title, period: fixed, target }: { books: CompanyBooks; title: string; period?: string; target: RefObject<HTMLElement | null> }) {
  const { t, lang } = useI18n();
  const company = lang === 'ar' && books.company.nameAr ? books.company.nameAr : books.company.name;
  /** The dates the report shows, read from its date boxes when not given: one date is "as of", two are a range. */
  const periodOf = (el: HTMLElement) => {
    if (fixed) return fixed;
    const d = [...el.querySelectorAll<HTMLInputElement>('input[type=date]')].map((i) => i.value).filter(Boolean);
    return d.length >= 2 ? `${d[0]} – ${d[1]}` : d.length === 1 ? t('pdf.asOfDate', { date: d[0]! }) : new Date().toISOString().slice(0, 10);
  };
  const pdf = () => {
    const el = target.current; if (!el) return;
    const period = periodOf(el); const name = `${title} ${period} - ${company}`;
    const html = [...el.querySelectorAll('table')].filter((x) => !x.closest('.no-export')).map((x) => x.outerHTML).join('');
    void printPdf(name, () => <ReportSheet books={books} title={title} period={period} html={html} />);
  };
  const excel = () => {
    const el = target.current; if (!el) return;
    const period = periodOf(el); const name = `${title} ${period} - ${company}`;
    const { header, rows } = readTables(el);
    download(writeXlsx({ title: [company, `${title} · ${period}`, `${t('pdf.printedOn')} ${new Date().toISOString().slice(0, 10)}`], header, rows,
      rightToLeft: lang === 'ar', sheetName: title }), `${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  return (
    <span className="export-bar no-print">
      <button className="b small" onClick={pdf} title={t('pdf.pdfHint')}>{t('pdf.pdf')}</button>
      <button className="b small" onClick={excel}>{t('pdf.excel')}</button>
    </span>
  );
}

/** A report page with its PDF and Excel buttons. */
export function ReportFrame({ books, title, children }: { books: CompanyBooks; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <div className="report-export no-print"><ExportBar books={books} title={title} target={ref} /></div>
      {children}
    </div>
  );
}
