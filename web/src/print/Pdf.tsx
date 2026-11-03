// A4 layouts for PDFs: tax invoice (ZATCA phase 1 layout and QR code in Saudi Arabia), credit note, quotation,
// purchase bill, supplier credit, expense voucher, expense claim, goods received / delivery notes, and reports.
// Every label is shown in English and Arabic, as tax invoices in Saudi Arabia and the UAE usually are.
import type { ReactNode } from 'react';
import type { CompanyBooks } from '../api.ts';
import { translate, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';

export interface Attachment { id: string; fileName: string; contentType: string; size: number; uploadedAt: string; uploadedBy: string; dataUrl?: string }
export const fileUrl = (a: Attachment) => a.dataUrl ?? `/api/attachments/${a.id}`;

const en = (k: Key, v?: Record<string, string | number>) => translate('en', k, v);
const ar = (k: Key, v?: Record<string, string | number>) => translate('ar', k, v);
/** A label in both languages: English, then Arabic. */
export const Bi = ({ k, v }: { k: Key; v?: Record<string, string | number> }) => <span className="bi"><span>{en(k, v)}</span><span className="ar" dir="rtl" lang="ar">{ar(k, v)}</span></span>;
const Name = ({ n, a }: { n: string; a?: string | null }) => <>{n}{a && a !== n && <div className="ar" dir="rtl" lang="ar">{a}</div>}</>;
const Num = ({ v }: { v: string | null | undefined }) => <span className="num">{v == null || v === '' ? '' : fmt(v)}</span>;
const qtyText = (q: string) => (q.includes('.') ? q.replace(/\.?0+$/, '') : q);
const today = () => new Date().toISOString().slice(0, 10);

interface Seller { name: string; nameAr: string | null; vatNumber: string | null; crNumber: string; address: string; city: string; country: string; currency: string;
  phone?: string | null; email?: string | null; bankName?: string | null; iban?: string | null }

function Head({ seller, title, number, status, children }: { seller: Seller; title: Key; number: string | null; status?: string; children?: ReactNode }) {
  return (
    <>
      {status === 'draft' && <div className="pdf-watermark"><Bi k="pdf.draft" /></div>}
      <header className="pdf-head">
        <div className="pdf-seller">
          <div className="pdf-company">{seller.name}</div>
          <div className="pdf-small">{seller.address}{seller.city ? `, ${seller.city}` : ''}</div>
          {seller.vatNumber && <div className="pdf-small">{en(seller.country === 'SA' ? 'pdf.vatNo' : 'pdf.trn')}: <b>{seller.vatNumber}</b></div>}
          <div className="pdf-small">{en(seller.country === 'AE' ? 'pdf.licence' : 'pdf.crNo')}: <b>{seller.crNumber}</b></div>
          {(seller.phone || seller.email) && <div className="pdf-small">{[seller.phone, seller.email].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="pdf-seller ar-side" dir="rtl" lang="ar">
          <div className="pdf-company">{seller.nameAr ?? seller.name}</div>
          {seller.vatNumber && <div className="pdf-small">{ar(seller.country === 'SA' ? 'pdf.vatNo' : 'pdf.trn')}: <b>{seller.vatNumber}</b></div>}
          <div className="pdf-small">{ar(seller.country === 'AE' ? 'pdf.licence' : 'pdf.crNo')}: <b>{seller.crNumber}</b></div>
        </div>
      </header>
      <div className="pdf-title">
        <div><div className="pdf-title-en">{en(title)}</div><div className="pdf-title-ar" dir="rtl" lang="ar">{ar(title)}</div></div>
        <div className="pdf-number">{number ?? en('pdf.draft')}</div>
      </div>
      {children}
    </>
  );
}

const Meta = ({ rows }: { rows: [Key, ReactNode][] }) => (
  <table className="pdf-meta"><tbody>{rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
    <tr key={k}><th><Bi k={k} /></th><td>{v}</td></tr>
  ))}</tbody></table>
);

function Party({ label, name, nameAr, lines }: { label: Key; name: string; nameAr?: string | null; lines: [Key, string | null | undefined][] }) {
  return (
    <div className="pdf-party">
      <div className="pdf-party-label"><Bi k={label} /></div>
      <div className="pdf-party-name"><Name n={name} a={nameAr} /></div>
      {lines.filter(([, v]) => v).map(([k, v]) => <div key={k} className="pdf-small">{en(k)} · <span dir="rtl" lang="ar">{ar(k)}</span>: <b>{v}</b></div>)}
    </div>
  );
}

function Footer({ number, note }: { number: string | null; note?: ReactNode }) {
  return (
    <footer className="pdf-foot">
      {note}
      <div className="pdf-foot-line"><span>{number ?? ''}</span><span>{en('pdf.printedOn')} {today()} · Nusuh Books</span></div>
    </footer>
  );
}

function Totals({ rows, currency }: { rows: [Key, string, boolean?][]; currency: string }) {
  return (
    <table className="pdf-totals"><tbody>{rows.map(([k, v, strong]) => (
      <tr key={k} className={strong ? 'strong' : ''}><th><Bi k={k} /></th><td><Num v={v} /> <span className="cur">{currency}</span></td></tr>
    ))}</tbody></table>
  );
}

// ------------------------------------------------------------------ sales: tax invoice, credit note, quotation
export interface SaleDoc {
  type: string; status: string; number: string | null; issueDate: string; dueDate: string | null; reference: string | null; notes: string | null;
  netTotal: string; vatTotal: string; grossTotal: string; amountDue: string;
  contact: { name: string; nameAr: string | null; vatNumber: string | null; crNumber: string | null; address: string | null; city: string | null } | null;
  seller: Seller & { originalNumber?: string | null };
  lines: { lineNo: number; description: string; quantity: string; unitPrice: string; vatCode: string; vatRate: string; net: string; vat: string }[];
  payments: { voidedAt: string | null; amount: string }[];
}

/** Standard tax invoice when the buyer is VAT registered, simplified tax invoice otherwise (Saudi Arabia). */
export function saleTitle(d: SaleDoc): Key {
  if (d.type === 'quotation') return 'pdf.quotation';
  if (d.type === 'credit_note') return 'pdf.creditNote';
  return d.seller.country === 'SA' && !d.contact?.vatNumber ? 'pdf.simplifiedInvoice' : 'pdf.taxInvoice';
}

export function SalePdf({ d, qr }: { d: SaleDoc; qr?: string | null }) {
  const c = d.contact;
  const due = d.type === 'invoice' && d.status === 'issued';
  return (
    <div className="pdf" dir="ltr">
      <Head seller={d.seller} title={saleTitle(d)} number={d.number} status={d.status}>
        <div className="pdf-row">
          <Party label="pdf.buyer" name={c?.name ?? ''} nameAr={c?.nameAr} lines={[['pdf.vatNo', c?.vatNumber], ['pdf.crNo', c?.crNumber], ['pdf.address', [c?.address, c?.city].filter(Boolean).join(', ')]]} />
          <Meta rows={[
            [d.type === 'quotation' ? 'pdf.quoteNo' : d.type === 'credit_note' ? 'pdf.creditNo' : 'pdf.invoiceNo', <b>{d.number ?? en('pdf.draft')}</b>],
            ['pdf.issueDate', d.issueDate], [d.type === 'quotation' ? 'pdf.validUntil' : 'pdf.supplyDate', d.type === 'quotation' ? d.dueDate : d.issueDate],
            ['pdf.dueDate', d.type === 'invoice' ? d.dueDate : null], ['pdf.originalInvoice', d.type === 'credit_note' ? d.seller.originalNumber ?? d.reference : null],
            ['pdf.customerRef', d.type !== 'credit_note' ? d.reference : null], ['pdf.currency', d.seller.currency],
          ]} />
        </div>
      </Head>
      <table className="pdf-lines">
        <thead><tr><th>#</th><th className="desc"><Bi k="pdf.description" /></th><th><Bi k="pdf.qty" /></th><th><Bi k="pdf.unitPrice" /></th>
          <th><Bi k="pdf.taxable" /></th><th><Bi k="pdf.vatRate" /></th><th><Bi k="pdf.vatAmount" /></th><th><Bi k="pdf.lineTotal" /></th></tr></thead>
        <tbody>{d.lines.map((l) => (
          <tr key={l.lineNo}><td>{l.lineNo}</td><td className="desc">{l.description}</td><td className="num">{qtyText(l.quantity)}</td><td><Num v={l.unitPrice} /></td>
            <td><Num v={l.net} /></td><td className="num">{l.vatCode === 'standard' ? `${Number(l.vatRate)}%` : <Bi k={`vat.${l.vatCode}` as Key} v={{ rate: Number(l.vatRate) }} />}</td>
            <td><Num v={l.vat} /></td><td><Num v={addMoney(l.net, l.vat)} /></td></tr>
        ))}</tbody>
      </table>
      <div className="pdf-row bottom">
        <div className="pdf-left">
          {qr && <div className="pdf-qr"><img src={qr} alt="ZATCA QR" /><div className="pdf-small"><Bi k="pdf.qrNote" /></div></div>}
          {d.type === 'invoice' && d.seller.iban && (
            <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.payTo" /></div>
              <div className="pdf-small">{d.seller.bankName} · IBAN <b>{d.seller.iban.replace(/(.{4})/g, '$1 ').trim()}</b></div></div>
          )}
          {d.notes && <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.notes" /></div><div className="pdf-small pre">{d.notes}</div></div>}
        </div>
        <Totals currency={d.seller.currency} rows={[
          ['pdf.totalExVat', d.netTotal], ['pdf.totalVat', d.vatTotal], ['pdf.totalIncVat', d.grossTotal, true],
          ...(due ? [['pdf.amountDue', d.amountDue] as [Key, string]] : []),
        ]} />
      </div>
      <Footer number={d.number} />
    </div>
  );
}

/** Adds two decimal amounts exactly (as strings). */
function addMoney(a: string, b: string): string {
  const toM = (s: string) => { const neg = s.startsWith('-'); const [w, f = ''] = s.replace('-', '').split('.'); const v = BigInt(w!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)); return neg ? -v : v; };
  const v = toM(a) + toM(b); const n = v < 0n; const x = n ? -v : v;
  return `${n ? '-' : ''}${x / 100n}.${(x % 100n).toString().padStart(2, '0')}`;
}

// ------------------------------------------------------------------ purchases: bill, supplier credit, expense, claim
export interface PurchaseDoc extends Omit<SaleDoc, 'lines'> {
  contactName: string; payee?: string | null; paidFromName?: string | null; submittedByName?: string | null; decidedByName?: string | null; journalEntryId: string | null;
  lines: (SaleDoc['lines'][number] & { accountCode: string; accountName: string; costCentre: string | null })[];
}
const purchaseTitle = (t: string): Key => (t === 'supplier_credit' ? 'pdf.supplierCredit' : t === 'expense' ? 'pdf.expenseVoucher' : t === 'claim' ? 'pdf.expenseClaim' : 'pdf.purchaseBill');

export function PurchasePdf({ d, attachments }: { d: PurchaseDoc; attachments: Attachment[] }) {
  const c = d.contact;
  const images = attachments.filter((a) => a.contentType.startsWith('image/'));
  return (
    <div className="pdf" dir="ltr">
      <Head seller={d.seller} title={purchaseTitle(d.type)} number={d.number} status={d.status}>
        <div className="pdf-row">
          <Party label={d.type === 'claim' ? 'pdf.employee' : d.type === 'expense' ? 'pdf.paidTo' : 'pdf.supplier'} name={c?.name ?? d.payee ?? d.contactName} nameAr={c?.nameAr}
            lines={[['pdf.vatNo', c?.vatNumber], ['pdf.crNo', c?.crNumber], ['pdf.address', [c?.address, c?.city].filter(Boolean).join(', ')]]} />
          <Meta rows={[
            ['pdf.ourNo', <b>{d.number ?? en('pdf.draft')}</b>], ['pdf.supplierInvoiceNo', d.reference], ['pdf.issueDate', d.issueDate], ['pdf.dueDate', d.dueDate],
            ['pdf.paidFrom', d.paidFromName ?? null], ['pdf.currency', d.seller.currency],
          ]} />
        </div>
      </Head>
      <table className="pdf-lines">
        <thead><tr><th>#</th><th className="desc"><Bi k="pdf.description" /></th><th className="desc"><Bi k="pdf.account" /></th><th><Bi k="pdf.qty" /></th>
          <th><Bi k="pdf.unitPrice" /></th><th><Bi k="pdf.taxable" /></th><th><Bi k="pdf.vatAmount" /></th><th><Bi k="pdf.lineTotal" /></th></tr></thead>
        <tbody>{d.lines.map((l) => (
          <tr key={l.lineNo}><td>{l.lineNo}</td><td className="desc">{l.description}</td>
            <td className="desc small">{l.accountCode} {l.accountName}{l.costCentre && <div className="pdf-small">{l.costCentre}</div>}</td>
            <td className="num">{qtyText(l.quantity)}</td><td><Num v={l.unitPrice} /></td><td><Num v={l.net} /></td><td><Num v={l.vat} /></td><td><Num v={addMoney(l.net, l.vat)} /></td></tr>
        ))}</tbody>
      </table>
      <div className="pdf-row bottom">
        <div className="pdf-left">
          {attachments.length > 0 && (
            <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.attachments" /></div>
              {attachments.map((a, i) => <div key={a.id} className="pdf-small">{i + 1}. {a.fileName}{a.contentType.startsWith('image/') ? ` — ${en('pdf.seeAppendix')}` : ''}</div>)}</div>
          )}
          {d.notes && <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.notes" /></div><div className="pdf-small pre">{d.notes}</div></div>}
        </div>
        <Totals currency={d.seller.currency} rows={[['pdf.totalExVat', d.netTotal], ['pdf.totalVat', d.vatTotal], ['pdf.totalIncVat', d.grossTotal, true],
          ...(['bill', 'claim'].includes(d.type) && d.status === 'issued' ? [['pdf.amountDue', d.amountDue] as [Key, string]] : [])]} />
      </div>
      <div className="pdf-signs">
        <div><Bi k={d.type === 'claim' ? 'pdf.submittedBy' : 'pdf.preparedBy'} /><span>{d.submittedByName ?? ''}</span></div>
        <div><Bi k="pdf.approvedBy" /><span>{d.decidedByName ?? ''}</span></div>
        <div><Bi k="pdf.postedInBooks" /><span>{d.journalEntryId ? '✓' : ''}</span></div>
      </div>
      <Footer number={d.number} />
      {images.map((a, i) => (
        <div key={a.id} className="pdf-appendix">
          <div className="pdf-appendix-title"><Bi k="pdf.attachmentN" v={{ n: attachments.indexOf(a) + 1 }} /> · {a.fileName}</div>
          <img src={fileUrl(a)} alt={a.fileName} />
          {i === images.length - 1 && <Footer number={d.number} />}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ goods received / delivery notes
export interface NotePrint {
  type: 'grn' | 'gdn'; status: string; number: string | null; date: string; reference: string | null; notes: string | null; contactName: string | null; contactNameAr: string | null;
  otherAccountCode: string; otherAccountName: string; totalValue: string;
  lines: { lineNo?: number; sku: string; name: string; nameAr: string | null; unit: string; quantity: string; unitCost: string | null; value: string; costCentre: string | null }[];
}

export function NotePdf({ n, seller, attachments, restaurant }: { n: NotePrint; seller: Seller; attachments: Attachment[]; restaurant?: boolean }) {
  const title: Key = n.type === 'grn' ? (restaurant ? 'pdf.materialsIn' : 'pdf.grn') : (restaurant && !n.contactName ? 'pdf.waste' : 'pdf.gdn');
  const images = attachments.filter((a) => a.contentType.startsWith('image/'));
  return (
    <div className="pdf" dir="ltr">
      <Head seller={seller} title={title} number={n.number} status={n.status}>
        <div className="pdf-row">
          <Party label={n.type === 'grn' ? 'pdf.receivedFrom' : 'pdf.deliveredTo'} name={n.contactName ?? `${n.otherAccountCode} ${n.otherAccountName}`} nameAr={n.contactNameAr} lines={[]} />
          <Meta rows={[['pdf.noteNo', <b>{n.number ?? en('pdf.draft')}</b>], ['pdf.date', n.date], ['pdf.reference', n.reference],
            ['pdf.account', `${n.otherAccountCode} ${n.otherAccountName}`], ['pdf.currency', seller.currency]]} />
        </div>
      </Head>
      <table className="pdf-lines">
        <thead><tr><th>#</th><th className="desc"><Bi k="pdf.code" /></th><th className="desc"><Bi k="pdf.item" /></th><th><Bi k="pdf.unit" /></th><th><Bi k="pdf.qty" /></th>
          {n.type === 'grn' && <th><Bi k="pdf.unitCost" /></th>}<th><Bi k="pdf.value" /></th></tr></thead>
        <tbody>{n.lines.map((l, i) => (
          <tr key={i}><td>{i + 1}</td><td className="desc">{l.sku}</td><td className="desc"><Name n={l.name} a={l.nameAr} />{l.costCentre && <div className="pdf-small">{l.costCentre}</div>}</td>
            <td>{l.unit}</td><td className="num">{qtyText(l.quantity)}</td>{n.type === 'grn' && <td><Num v={l.unitCost} /></td>}<td><Num v={n.status === 'posted' ? l.value : null} /></td></tr>
        ))}</tbody>
      </table>
      <div className="pdf-row bottom">
        <div className="pdf-left">
          {attachments.length > 0 && <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.attachments" /></div>
            {attachments.map((a, i) => <div key={a.id} className="pdf-small">{i + 1}. {a.fileName}</div>)}</div>}
          {n.notes && <div className="pdf-box"><div className="pdf-party-label"><Bi k="pdf.notes" /></div><div className="pdf-small pre">{n.notes}</div></div>}
        </div>
        {n.status === 'posted' && <Totals currency={seller.currency} rows={[['pdf.totalValue', n.totalValue, true]]} />}
      </div>
      <div className="pdf-signs">
        <div><Bi k={n.type === 'grn' ? 'pdf.deliveredBy' : 'pdf.issuedBy'} /><span /></div>
        <div><Bi k="pdf.receivedBy" /><span /></div>
        <div><Bi k="pdf.checkedBy" /><span /></div>
      </div>
      <Footer number={n.number} />
      {images.map((a) => (
        <div key={a.id} className="pdf-appendix">
          <div className="pdf-appendix-title"><Bi k="pdf.attachmentN" v={{ n: attachments.indexOf(a) + 1 }} /> · {a.fileName}</div>
          <img src={fileUrl(a)} alt={a.fileName} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ reports
export function ReportSheet({ books, title, period, html }: { books: CompanyBooks; title: string; period: string; html: string }) {
  const c = books.company;
  return (
    <div className="pdf report" dir={document.documentElement.dir || 'ltr'}>
      <header className="pdf-report-head">
        <div>
          <div className="pdf-company">{document.documentElement.lang === 'ar' && c.nameAr ? c.nameAr : c.name}</div>
          <div className="pdf-report-title">{title}</div>
          <div className="pdf-small">{period} · {c.currency}</div>
        </div>
        <div className="pdf-small">{c.vatNumber && <>{en(c.country === 'SA' ? 'pdf.vatNo' : 'pdf.trn')}: <b>{c.vatNumber}</b></>}</div>
      </header>
      <div className="pdf-report-body" dangerouslySetInnerHTML={{ __html: html }} />
      <Footer number={null} />
    </div>
  );
}
