// The invoice Nusuh Books sends to its customers, laid out as a ZATCA standard tax invoice: bilingual (Arabic and English) headings, the seller and the
// buyer with VAT number and registration number, a line table with quantity, unit price, discount, taxable amount, VAT rate, VAT and total per line,
// the totals, the QR code in the ZATCA format (seller, VAT number, time stamp, total, VAT) and, while it is unpaid, where to pay.
// The rows come from src/books/billingInvoiceView.ts, which shares the discount and the VAT over the lines so every column adds up to the stored totals.
// The page makes no claim of approval or clearance by ZATCA: it is a printable invoice with the QR content ZATCA asks for.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApi } from '../api.ts';
import { DICTS, useI18n, type Key, type Lang, type T } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, TopControls } from '../ui.tsx';
import { NusuhMark } from '../brand.tsx';
import { invoiceQr, layoutInvoice, validSellerVat } from '../../../src/books/billingInvoiceView.ts';
import { lineText, type BillInvoice, type Settings } from './Billing.tsx';

type Bank = { accountName: string; bank: string; iban: string; swift: string } | null;
type Full = BillInvoice & { seller: Settings; bank: Bank };

/** A translator for one language, whatever language the person reads the screen in (the invoice always shows both). */
const tFor = (lang: Lang): T => (k, v) => (DICTS[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? ''));
const EN = tFor('en'), AR = tFor('ar');

/** A label in both languages, the reader's own first. */
function Bi({ k, vars, className }: { k: Key; vars?: Record<string, string | number>; className?: string }) {
  const { lang } = useI18n();
  const first = lang === 'ar' ? AR(k, vars) : EN(k, vars), second = lang === 'ar' ? EN(k, vars) : AR(k, vars);
  return (
    <span className={`bi ${className ?? ''}`}>
      <span lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>{first}</span>
      <span className="bi2" lang={lang === 'ar' ? 'en' : 'ar'} dir={lang === 'ar' ? 'ltr' : 'rtl'}>{second}</span>
    </span>
  );
}

/** The time the invoice was made, as Riyadh time (what a Saudi customer expects on a tax invoice). */
function riyadh(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function Party({ title, name, nameAr, address, addressAr, vat, cr, vatKey }: { title: Key; name: string; nameAr?: string | null; address?: string | null; addressAr?: string | null; vat?: string | null; cr?: string | null; vatKey?: boolean }) {
  return (
    <div className="zi-party">
      <h3><Bi k={title} /></h3>
      <div className="zi-name">{name}</div>
      {nameAr && <div className="zi-name ar" dir="rtl" lang="ar">{nameAr}</div>}
      {(address || addressAr) && <div className="zi-line"><small><Bi k="zi.address" /></small><span>{address && <span className="zi-addr">{address}</span>}{addressAr && <span className="zi-addr" dir="rtl" lang="ar">{addressAr}</span>}</span></div>}
      <div className="zi-line"><small><Bi k="zi.vatNo" /></small>{vat ? <span className="ltr">{vat}</span> : <span className="mut"><Bi k="zi.notProvided" /></span>}</div>
      {(cr || vatKey) && <div className="zi-line"><small><Bi k="zi.crNo" /></small>{cr ? <span className="ltr">{cr}</span> : <span className="mut"><Bi k="zi.notProvided" /></span>}</div>}
    </div>
  );
}

export function BillingInvoicePage({ id, back }: { id: string; back: string }) {
  const { t, lang } = useI18n();
  const d = useApi<Full>(`/api/billing/invoices/${id}`);
  const [qr, setQr] = useState<{ payload: string; url: string }>();
  const x = d.data;
  const payload = x ? invoiceQr({ sellerNameAr: x.seller.sellerNameAr ?? null, sellerName: x.seller.sellerName, sellerVat: x.seller.sellerVat, createdAt: x.createdAt ?? null, issuedOn: x.issuedOn, total: x.total, vat: x.vat }) : null;
  useEffect(() => {
    let live = true;
    if (!payload) { setQr(undefined); return; }
    void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 }).then((url) => live && setQr({ payload, url }));
    return () => { live = false; };
  }, [payload]);
  if (d.error) return <main className="public-doc"><ErrorNote error={d.error} onRetry={d.reload} /></main>;
  if (!x) return <main className="public-doc"><Loading /></main>;
  const lay = layoutInvoice(x);
  const unpaid = x.status === 'open' || x.status === 'overdue';
  const cur = x.currency;
  const lineBi = (l: BillInvoice['lines'][number]) => {
    const first = lineText(lang === 'ar' ? AR : EN, l, x.cycle), second = lineText(lang === 'ar' ? EN : AR, l, x.cycle);
    return <><div lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>{first}</div><div className="mut small" lang={lang === 'ar' ? 'en' : 'ar'} dir={lang === 'ar' ? 'ltr' : 'rtl'}>{second}</div></>;
  };
  return (
    <main className="public-doc">
      <div className="public-actions no-print">
        <div><b>{x.number}</b><div className="small">{x.customer}</div></div>
        <span className="spacer" />
        <button className="b" id="bill-back" onClick={() => navigate(back)}>{t('pub.back')}</button>
        <button className="b" id="bill-print" onClick={() => window.print()}>{t('pub.print')}</button>
        <TopControls />
      </div>
      {!validSellerVat(x.seller.sellerVat) && <div className="notice warn no-print" id="inv-no-vat">{t('zi.noVat')}</div>}
      <div className="public-page binv zinv" id="tax-invoice">
        <header className="zi-head">
          <div className="zi-brand">
            <NusuhMark size={44} />
            <div>
              <div className="zi-seller">{x.seller.sellerName}</div>
              {x.seller.sellerNameAr && <div className="zi-seller ar" dir="rtl" lang="ar">{x.seller.sellerNameAr}</div>}
            </div>
          </div>
          <div className="zi-title">
            <h1><Bi k="zi.title" /></h1>
            <span className={`binv-stamp ${x.status}`}>{t(`bill.st.${x.status}`)}</span>
          </div>
        </header>

        <section className="zi-meta">
          <div><small><Bi k="zi.number" /></small><b className="ltr" id="inv-number">{x.number}</b></div>
          <div><small><Bi k="zi.issued" /></small><span className="ltr">{riyadh(x.createdAt, x.issuedOn)}</span></div>
          <div><small><Bi k="zi.due" /></small><span className="ltr">{x.dueOn}</span></div>
          <div><small><Bi k="zi.supply" /></small><span className="ltr">{x.periodStart} → {x.periodEnd}</span></div>
        </section>

        <section className="zi-parties">
          <Party title="zi.seller" name={x.seller.sellerName} nameAr={x.seller.sellerNameAr} address={x.seller.sellerAddress} addressAr={x.seller.sellerAddressAr} vat={x.seller.sellerVat} cr={x.seller.sellerCr} vatKey />
          <Party title="zi.buyer" name={x.customer} nameAr={x.buyerNameAr} address={x.buyerAddress} vat={x.buyerVat} cr={x.buyerCr} vatKey />
        </section>

        <table className="zi-lines" id="inv-lines">
          <thead>
            <tr>
              <th className="n">#</th><th><Bi k="zi.col.desc" /></th><th className="num"><Bi k="zi.col.qty" /></th><th className="num"><Bi k="zi.col.unit" /></th>
              <th className="num"><Bi k="zi.col.disc" /></th><th className="num"><Bi k="zi.col.taxable" /></th><th className="num"><Bi k="zi.col.vatPct" /></th>
              <th className="num"><Bi k="zi.col.vat" /></th><th className="num"><Bi k="zi.col.total" /></th>
            </tr>
          </thead>
          <tbody>
            {lay.rows.map((r) => (
              <tr key={r.index}>
                <td className="n">{r.index}</td><td className="desc">{lineBi(r.line as BillInvoice['lines'][number])}</td>
                <td className="num ltr" data-label={t('zi.col.qty')}>{r.quantity}</td><td className="num ltr" data-label={t('zi.col.unit')}>{fmt(r.unitPrice)}</td><td className="num ltr" data-label={t('zi.col.disc')}>{fmt(r.discount)}</td>
                <td className="num ltr" data-label={t('zi.col.taxable')}>{fmt(r.taxable)}</td><td className="num ltr" data-label={t('zi.col.vatPct')}>{r.vatRate}%</td><td className="num ltr" data-label={t('zi.col.vat')}>{fmt(r.vat)}</td><td className="num ltr tot" data-label={t('zi.col.total')}>{fmt(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="zi-bottom">
          <div className="zi-left">
            {qr ? (
              <figure className="zi-qr">
                <img src={qr.url} width={132} height={132} alt={t('zi.qrAlt')} id="inv-qr" data-payload={qr.payload} />
                <figcaption className="small mut"><Bi k="zi.qr" /></figcaption>
              </figure>
            ) : null}
            {unpaid && (
              <div className="zi-pay">
                <h3><Bi k="zi.pay" /></h3>
                {x.bank ? (
                  <dl>
                    <dt><Bi k="buy.bank.account" /></dt><dd>{x.bank.accountName}</dd>
                    <dt><Bi k="buy.bank.bank" /></dt><dd>{x.bank.bank}</dd>
                    <dt>IBAN</dt><dd className="ltr">{x.bank.iban}</dd>
                    <dt>SWIFT</dt><dd className="ltr">{x.bank.swift}</dd>
                  </dl>
                ) : <p className="small mut">{t('zi.payAsk')}</p>}
                <p className="small"><Bi k="zi.payRef" vars={{ number: x.number }} /></p>
              </div>
            )}
          </div>
          <table className="zi-totals" id="inv-totals"><tbody>
            <tr><td><Bi k="zi.t.gross" /></td><td className="num ltr">{fmt(lay.totals.gross)}</td></tr>
            {Number(lay.totals.discount) > 0 && <tr><td><Bi k="zi.t.discount" /></td><td className="num ltr">−{fmt(lay.totals.discount)}</td></tr>}
            <tr><td><Bi k="zi.t.taxable" /></td><td className="num ltr">{fmt(lay.totals.taxable)}</td></tr>
            <tr><td><Bi k="zi.t.vat" vars={{ rate: String(Number(x.vatRate)) }} /></td><td className="num ltr">{fmt(lay.totals.vat)}</td></tr>
            <tr className="grand"><td><Bi k="zi.t.total" /></td><td className="num ltr" id="inv-grand">{cur} {fmt(lay.totals.total)}</td></tr>
          </tbody></table>
        </section>
        {!lay.adds && <div className="notice bad no-print" role="alert" id="inv-mismatch">{t('zi.mismatch')}</div>}
        {(x.paidOn || x.voidReason) && <div className="binv-note">{x.paidOn && <><Bi k="zi.paidOn" vars={{ date: x.paidOn }} />{x.paidRef ? ` · ${x.paidRef}` : ''}</>}{x.voidReason}</div>}
        <footer className="binv-foot">
          <div>{t('bill.invoiceThanks', { seller: x.seller.sellerName })}</div>
          <div className="small"><Bi k="zi.generated" vars={{ cur }} /></div>
        </footer>
      </div>
    </main>
  );
}
