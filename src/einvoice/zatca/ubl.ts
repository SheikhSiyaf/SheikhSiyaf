// ZATCA phase 2: the UBL 2.1 invoice XML (no signing here, so it also runs in the browser for the demo).
// See xml.ts for the hash, the stamp and the QR.
import { addMoney, fromCents, toCents, type EInvoiceData, type EParty, type VatCode } from '../invoiceData.js';

/** PIH of the very first invoice of a device: base64 of the hex SHA-256 of "0". */
export const FIRST_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
export type ZatcaKind = 'standard' | 'simplified';
export const TYPE_CODE = { invoice: '388', credit_note: '381', debit_note: '383' } as const;
/** Standard (B2B) when the buyer has a VAT number; simplified (B2C) otherwise. */
export const kindFor = (buyer: EParty | null): ZatcaKind => (buyer?.vatNumber ? 'standard' : 'simplified');

export const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
};
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#xD;');
/** An element: attributes in the order given, children as strings (already XML) or text (escaped). */
export function el(name: string, attrs: Record<string, string> | null, ...kids: (string | number | null | undefined | false)[]): string {
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
  return `<${name}${a}>${kids.filter((k) => k !== null && k !== undefined && k !== false).join('')}</${name}>`;
}
export const text = (s: string) => esc(s);
const amt = (cur: string) => ({ currencyID: cur });
const CAT: Record<VatCode, string> = { standard: 'S', zero: 'Z', exempt: 'E', out_of_scope: 'O' };

function party(p: EParty): string {
  const addr = p.street || p.city ? el('cac:PostalAddress', null,
    p.street && el('cbc:StreetName', null, text(p.street)),
    p.building && el('cbc:BuildingNumber', null, text(p.building)),
    p.district && el('cbc:CitySubdivisionName', null, text(p.district)),
    p.city && el('cbc:CityName', null, text(p.city)),
    p.postalCode && el('cbc:PostalZone', null, text(p.postalCode)),
    el('cac:Country', null, el('cbc:IdentificationCode', null, text(p.country || 'SA')))) : null;
  return el('cac:Party', null,
    p.crNumber && el('cac:PartyIdentification', null, el('cbc:ID', { schemeID: 'CRN' }, text(p.crNumber))),
    addr,
    p.vatNumber && el('cac:PartyTaxScheme', null, el('cbc:CompanyID', null, text(p.vatNumber)), el('cac:TaxScheme', null, el('cbc:ID', null, 'VAT'))),
    el('cac:PartyLegalEntity', null, el('cbc:RegistrationName', null, text(p.name))));
}

export interface Chain { icv: number; pih: string }

/** The invoice XML before the stamp: no UBLExtensions and no QR yet. */
export function invoiceXml(d: EInvoiceData, chain: Chain, qr?: string, signatureBlock?: string): string {
  const kind = kindFor(d.buyer);
  const cur = d.currency;
  // VAT breakdown by category and rate, from the lines (the same amounts as the books).
  const groups = new Map<string, { code: VatCode; rate: string; net: bigint; vat: bigint }>();
  for (const l of d.lines) {
    const k = `${l.vatCode}|${l.vatRate}`;
    const g = groups.get(k) ?? { code: l.vatCode, rate: l.vatRate, net: 0n, vat: 0n };
    g.net += toCents(l.net); g.vat += toCents(l.vat); groups.set(k, g);
  }
  const pct = (r: string) => Number(r).toFixed(2);
  const category = (code: VatCode, rate: string, tag: 'cac:TaxCategory' | 'cac:ClassifiedTaxCategory') => el(tag, null,
    tag === 'cac:TaxCategory' ? el('cbc:ID', { schemeID: 'UN/ECE 5305', schemeAgencyID: '6' }, CAT[code]) : el('cbc:ID', null, CAT[code]),
    el('cbc:Percent', null, pct(rate)),
    tag === 'cac:TaxCategory' && code !== 'standard' && el('cbc:TaxExemptionReasonCode', null, text(d.exemption[code].code)),
    tag === 'cac:TaxCategory' && code !== 'standard' && el('cbc:TaxExemptionReason', null, text(d.exemption[code].text)),
    tag === 'cac:TaxCategory' ? el('cac:TaxScheme', null, el('cbc:ID', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }, 'VAT')) : el('cac:TaxScheme', null, el('cbc:ID', null, 'VAT')));
  const doc = (d.type === 'credit_note' || d.type === 'debit_note');
  const pre = d.prepayments ?? [];
  const prepaid = pre.reduce((t, p) => t + toCents(p.net) + toCents(p.vat), 0n);
  const body = [
    signatureBlock ?? null,
    el('cbc:ProfileID', null, 'reporting:1.0'),
    el('cbc:ID', null, text(d.number)),
    el('cbc:UUID', null, d.uuid),
    el('cbc:IssueDate', null, d.issueDate),
    el('cbc:IssueTime', null, d.issueTime),
    el('cbc:InvoiceTypeCode', { name: kind === 'standard' ? '0100000' : '0200000' }, d.advance ? '386' : TYPE_CODE[d.type]),
    el('cbc:DocumentCurrencyCode', null, cur),
    el('cbc:TaxCurrencyCode', null, cur),
    doc && d.original && el('cac:BillingReference', null, el('cac:InvoiceDocumentReference', null, el('cbc:ID', null, text(d.original.number)))),
    el('cac:AdditionalDocumentReference', null, el('cbc:ID', null, 'ICV'), el('cbc:UUID', null, String(chain.icv))),
    el('cac:AdditionalDocumentReference', null, el('cbc:ID', null, 'PIH'), el('cac:Attachment', null, el('cbc:EmbeddedDocumentBinaryObject', { mimeCode: 'text/plain' }, chain.pih))),
    qr && el('cac:AdditionalDocumentReference', null, el('cbc:ID', null, 'QR'), el('cac:Attachment', null, el('cbc:EmbeddedDocumentBinaryObject', { mimeCode: 'text/plain' }, qr))),
    el('cac:Signature', null, el('cbc:ID', null, 'urn:oasis:names:specification:ubl:signature:Invoice'), el('cbc:SignatureMethod', null, 'urn:oasis:names:specification:ubl:dsig:enveloped:xades')),
    el('cac:AccountingSupplierParty', null, party(d.seller)),
    el('cac:AccountingCustomerParty', null, d.buyer ? party(d.buyer) : ''),
    el('cac:Delivery', null, el('cbc:ActualDeliveryDate', null, d.supplyDate)),
    el('cac:PaymentMeans', null, el('cbc:PaymentMeansCode', null, text(d.paymentMeans)), doc && el('cbc:InstructionNote', null, text(d.reason || 'Correction'))),
    el('cac:TaxTotal', null, el('cbc:TaxAmount', amt(cur), d.vatTotal)),
    el('cac:TaxTotal', null, el('cbc:TaxAmount', amt(cur), d.vatTotal),
      ...[...groups.values()].map((g) => el('cac:TaxSubtotal', null, el('cbc:TaxableAmount', amt(cur), fromCents(g.net)), el('cbc:TaxAmount', amt(cur), fromCents(g.vat)), category(g.code, g.rate, 'cac:TaxCategory')))),
    el('cac:LegalMonetaryTotal', null,
      el('cbc:LineExtensionAmount', amt(cur), d.netTotal), el('cbc:TaxExclusiveAmount', amt(cur), d.netTotal), el('cbc:TaxInclusiveAmount', amt(cur), d.grossTotal),
      el('cbc:AllowanceTotalAmount', amt(cur), '0.00'), el('cbc:PrepaidAmount', amt(cur), fromCents(prepaid)),
      el('cbc:PayableAmount', amt(cur), fromCents(toCents(d.grossTotal) - prepaid))),
    ...d.lines.map((l) => el('cac:InvoiceLine', null,
      el('cbc:ID', null, String(l.no)),
      el('cbc:InvoicedQuantity', { unitCode: 'PCE' }, l.quantity),
      el('cbc:LineExtensionAmount', amt(cur), l.net),
      el('cac:TaxTotal', null, el('cbc:TaxAmount', amt(cur), l.vat), el('cbc:RoundingAmount', amt(cur), addMoney(l.net, l.vat))),
      el('cac:Item', null, el('cbc:Name', null, text(l.description)), category(l.vatCode, l.vatRate, 'cac:ClassifiedTaxCategory')),
      el('cac:Price', null, el('cbc:PriceAmount', amt(cur), l.unitPrice)))),
    // Advances deducted (section 9.5, BR-KSA-73 to 80): one zero-value line per advance invoice, with its reference and
    // the net and VAT taken off.
    ...pre.map((p, i) => el('cac:InvoiceLine', null,
      el('cbc:ID', null, String(d.lines.length + i + 1)),
      el('cbc:InvoicedQuantity', { unitCode: 'PCE' }, '0.00'),
      el('cbc:LineExtensionAmount', amt(cur), '0.00'),
      el('cac:DocumentReference', null, el('cbc:ID', null, text(p.number)), el('cbc:IssueDate', null, p.issueDate), el('cbc:IssueTime', null, p.issueTime),
        el('cbc:DocumentTypeCode', null, '386')),
      el('cac:TaxTotal', null, el('cbc:TaxAmount', amt(cur), '0.00'), el('cbc:RoundingAmount', amt(cur), '0.00'),
        el('cac:TaxSubtotal', null, el('cbc:TaxableAmount', amt(cur), p.net), el('cbc:TaxAmount', amt(cur), p.vat), category(p.vatCode, p.vatRate, 'cac:TaxCategory'))),
      el('cac:Item', null, el('cbc:Name', null, 'Prepayment adjustment'), category(p.vatCode, p.vatRate, 'cac:ClassifiedTaxCategory')),
      el('cac:Price', null, el('cbc:PriceAmount', amt(cur), '0.00')))),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n${el('Invoice', { xmlns: NS.inv, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext }, ...body)}`;
}

