// Attachments on a document or goods note (the supplier's bill, receipts, delivery notes), and the PDF buttons.
import { useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { errorText } from '../ui.tsx';
import { zatcaQrPayload, zatcaTimestamp } from '../../../src/einvoice/zatcaQr.ts';
import { printPdf } from './Print.tsx';
import { NotePdf, PurchasePdf, SalePdf, fileUrl, type Attachment, type NotePrint, type PurchaseDoc, type SaleDoc } from './Pdf.tsx';

export const MAX = 10 * 1024 * 1024;
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';

export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
export const sizeText = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function AttachmentsCard({ owner, id, canAdd, canRemove, hint }: { owner: 'documents' | 'stock-notes' | 'hr-documents'; id: string; canAdd: boolean; canRemove: boolean; hint?: string }) {
  const { t, has } = useI18n();
  const list = useApi<Attachment[]>(`/api/${owner}/${id}/attachments`);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const add = async (files: FileList | null) => {
    setErr(undefined);
    for (const f of [...(files ?? [])]) {
      if (!/\.(pdf|png|jpe?g|webp)$/i.test(f.name)) { setErr(t('err.attachmentType')); continue; }
      if (f.size > MAX) { setErr(t('err.attachmentSize')); continue; }
      setBusy(true);
      try { await api(`/api/${owner}/${id}/attachments`, { body: { fileName: f.name, contentType: f.type, data: await toBase64(f) } }); }
      catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
    }
    if (input.current) input.current.value = '';
    if (camera.current) camera.current.value = '';
    list.reload();
  };
  const remove = async (a: Attachment) => {
    try { await api(`/api/attachments/${a.id}/delete`, { body: {} }); list.reload(); } catch (e) { setErr(errorText(t, has, e)); }
  };
  return (
    <div className="card no-print">
      <div className="actions" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{t('att.title')}</h3>
        <span className="spacer" />
        {canAdd && <>
          <input ref={input} id="att-file" type="file" accept={ACCEPT} multiple hidden onChange={(e) => void add(e.target.files)} />
          <button className="b small" disabled={busy} onClick={() => input.current?.click()}>{busy ? t('loading') : t('att.add')}</button>
          {/* On a phone this opens the camera, to photograph a receipt straight onto the document. */}
          <input ref={camera} id="att-camera" type="file" accept="image/*" capture="environment" hidden onChange={(e) => void add(e.target.files)} />
          <button className="b small" disabled={busy} onClick={() => camera.current?.click()}>{t('att.photo')}</button>
        </>}
      </div>
      {err && <div className="notice bad small" role="alert">{err}</div>}
      {!list.data || list.data.length === 0 ? <p className="mut small" style={{ margin: 0 }}>{hint ?? t('att.none')}</p> : (
        <table className="mini"><tbody>{list.data.map((a) => (
          <tr key={a.id}>
            <td><a className="link" href={fileUrl(a)} target="_blank" rel="noreferrer" download={a.dataUrl ? a.fileName : undefined}>{a.contentType === 'application/pdf' ? '📄' : '🖼'} {a.fileName}</a></td>
            <td className="small mut">{sizeText(a.size)} · {a.uploadedBy}</td>
            <td>{canRemove && <button className="link small bad" onClick={() => void remove(a)}>{t('att.remove')}</button>}</td>
          </tr>
        ))}</tbody></table>
      )}
    </div>
  );
}

/** Opens the PDF of a sales or purchase document. Saudi invoices and credit notes carry the ZATCA QR code. */
export async function printDocument(books: CompanyBooks, id: string) {
  const d = await api<SaleDoc & PurchaseDoc & { issuedAt: string | null; contactName: string }>(`/api/documents/${id}`);
  const name = `${d.number ?? 'Draft'} ${d.contact?.name ?? d.payee ?? ''}`.trim();
  if (['invoice', 'credit_note', 'quotation'].includes(d.type)) {
    let qr: string | null = null;
    // Phase 2: the QR of the e-invoice (ZATCA's for cleared invoices); phase 1 fields when there is no e-invoice.
    const einvoice = books.company.country === 'SA' && d.status === 'issued' && d.type !== 'quotation'
      ? (await api<{ printQr: string | null; status: string }[]>(`/api/documents/${id}/einvoice`).catch(() => []))[0] : undefined;
    if (einvoice?.printQr) qr = await QRCode.toDataURL(einvoice.printQr, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    else if (books.company.country === 'SA' && d.status === 'issued' && d.type !== 'quotation' && d.seller.vatNumber) {
      qr = await QRCode.toDataURL(zatcaQrPayload({ sellerName: d.seller.name, vatNumber: d.seller.vatNumber, timestamp: zatcaTimestamp(d.issuedAt, d.issueDate),
        total: d.grossTotal, vatTotal: d.vatTotal }), { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    }
    return printPdf(name, () => <SalePdf d={d} qr={qr} />);
  }
  const attachments = await api<Attachment[]>(`/api/documents/${id}/attachments`);
  return printPdf(name, () => <PurchasePdf d={d} attachments={attachments} />);
}

export async function printNote(books: CompanyBooks, id: string, restaurant: boolean) {
  const [n, attachments, seller] = await Promise.all([
    api<NotePrint>(`/api/stock-notes/${id}`), api<Attachment[]>(`/api/stock-notes/${id}/attachments`), api<{ seller: SaleDoc['seller'] }>(`/api/companies/${books.company.id}/print-header`)]);
  return printPdf(`${n.number ?? 'Draft'} ${n.contactName ?? ''}`.trim(), () => <NotePdf n={n} seller={seller.seller} attachments={attachments} restaurant={restaurant} />);
}

export function PdfButton({ onPrint, id }: { onPrint: () => Promise<unknown>; id?: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button id={id} className="b" disabled={busy} title={t('pdf.pdfHint')} onClick={() => { setBusy(true); void onPrint().finally(() => setBusy(false)); }}>
      {t('pdf.pdf')}
    </button>
  );
}
