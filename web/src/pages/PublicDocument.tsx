// Opened from the link in an emailed invoice, credit note or quotation (no sign-in): the document as its PDF looks,
// with Print / Save as PDF, and Pay online when the company takes online payments (db/migrations/0037).
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, useApi } from '../api.ts';
import { backPath, navigate } from '../router.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote, Loading, TopControls, errorText } from '../ui.tsx';
import { SalePdf, type SaleDoc } from '../print/Pdf.tsx';
import { zatcaQrPayload, zatcaTimestamp } from '../../../src/einvoice/zatcaQr.ts';
import { fmt, toMinor } from '../money.ts';

interface PublicDoc { id: string; type: string; status: string; issuedAt: string | null; number: string | null; issueDate: string; dueDate: string | null; reference: string | null;
  notes: string | null; netTotal: string; vatTotal: string; grossTotal: string; amountDue: string; qr: string | null; payOnline?: boolean;
  seller: { name: string; nameAr: string | null; vatNumber: string | null; crNumber: string; address: string; city: string; country: string; currency: string };
  buyer: { name: string; nameAr: string | null; vatNumber: string | null; address: string | null; city: string | null };
  lines: { description: string; quantity: string; unitPrice: string; vatRate: string; netAmount: string; vatAmount: string }[] }

/** Goes to a checkout or back: inside the app (the demo) or to another address. */
export function goTo(url: string) {
  if (url.startsWith('/')) navigate(url); else window.location.href = url;
}

export function PublicDocument({ token, paid, extra }: { token: string; paid?: string | null; extra?: (d: PublicDoc) => React.ReactNode }) {
  const { t, has } = useI18n();
  const r = useApi<PublicDoc>(`/api/public/documents/${encodeURIComponent(token)}`);
  const [pay, setPay] = useState<{ busy?: boolean; bad?: string; result?: 'paid' | 'failed' | 'created' }>({});
  // Back from the checkout: ask the server (which asks the provider) until it is settled, then show the invoice again.
  useEffect(() => {
    if (!paid) return;
    let live = true; let tries = 0;
    const ask = async () => {
      try {
        const s = await api<{ status: 'paid' | 'failed' | 'created' }>(`/api/public/payments/${encodeURIComponent(paid)}`);
        if (!live) return;
        setPay({ result: s.status });
        if (s.status === 'created' && ++tries < 10) setTimeout(() => void ask(), 2000); else r.reload();
      } catch { if (live) setPay({}); }
    };
    void ask();
    return () => { live = false; };
  }, [paid]);
  const payNow = async () => {
    setPay({ busy: true });
    try { goTo((await api<{ url: string }>(`/api/public/documents/${encodeURIComponent(token)}/pay`, { method: 'POST' })).url); }
    catch (e) { setPay({ bad: errorText(t, has, e) }); }
  };
  const [qr, setQr] = useState<string | null>(null);
  const d = r.data;
  useEffect(() => {
    if (!d || d.type === 'quotation' || d.seller.country !== 'SA') return;
    const payload = d.qr ?? (d.seller.vatNumber ? zatcaQrPayload({ sellerName: d.seller.name, vatNumber: d.seller.vatNumber, timestamp: zatcaTimestamp(d.issuedAt, d.issueDate), total: d.grossTotal, vatTotal: d.vatTotal }) : null);
    if (payload) void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 }).then(setQr);
  }, [d]);
  if (r.error) return <main className="public-doc"><div className="card"><ErrorNote error={r.error} /></div></main>;
  if (!d) return <main className="public-doc"><Loading /></main>;
  const sale: SaleDoc = {
    type: d.type, status: d.status, number: d.number, issueDate: d.issueDate, dueDate: d.dueDate, reference: d.reference, notes: d.notes,
    netTotal: d.netTotal, vatTotal: d.vatTotal, grossTotal: d.grossTotal, amountDue: d.amountDue,
    contact: { name: d.buyer.name, nameAr: d.buyer.nameAr, vatNumber: d.buyer.vatNumber, crNumber: null, address: d.buyer.address, city: d.buyer.city },
    seller: d.seller, payments: [],
    lines: d.lines.map((l, i) => ({ lineNo: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vatCode: toMinor(l.vatRate) > 0n ? 'standard' : 'zero',
      vatRate: l.vatRate, net: l.netAmount, vat: l.vatAmount })),
  };
  const due = d.type === 'invoice' && toMinor(d.amountDue) > 0n;
  return (
    <main className="public-doc">
      <div className="public-actions no-print">
        <div><b>{d.seller.name}</b>{due && <div className="small">{t('pub.due', { amount: fmt(d.amountDue), currency: d.seller.currency, date: d.dueDate ?? '' })}</div>}
          {d.type === 'invoice' && !due && <div className="small good">{t('pub.paid')}</div>}</div>
        <span className="spacer" />
        {d.payOnline && <button className="b p" id="pub-pay" disabled={pay.busy} onClick={() => void payNow()}>{t('pub.payOnline', { amount: fmt(d.amountDue), currency: d.seller.currency })}</button>}
        {extra?.(d)}
        {backPath() && <button className="b" id="pub-back" onClick={() => navigate(backPath()!)}>{t('pub.back')}</button>}
        <button className="b" id="pub-print" onClick={() => window.print()}>{t('pub.print')}</button>
        <TopControls />
      </div>
      {pay.result === 'paid' && <div className="notice no-print" role="status" id="pub-paid">{t('pub.thanks')}</div>}
      {pay.result === 'failed' && <div className="notice bad no-print" role="alert">{t('pub.payFailed')}</div>}
      {pay.result === 'created' && <div className="notice no-print" role="status">{t('pub.payWaiting')}</div>}
      {pay.bad && <div className="notice bad no-print" role="alert">{pay.bad}</div>}
      <div className="public-page"><SalePdf d={sale} qr={qr} /></div>
    </main>
  );
}
