// UAE e-invoicing: the invoice as Peppol PINT AE (UBL 2.1), which the accredited service provider (ASP) sends
// through the Peppol network and reports to the FTA. Nusuh Books prepares the XML; the ASP is chosen later
// (docs/DECISIONS.md), so the XML is checked with that ASP's validator before go-live (1 January 2027 for
// AED 50 million revenue and above, 1 July 2027 for the rest).
import type { EInvoiceData, EParty, VatCode } from './invoiceData.js';
import { fromCents, toCents } from './invoiceData.js';

export const PINT_AE = { customization: 'urn:peppol:pint:billing-1@ae-1', profile: 'urn:peppol:bis:billing' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function el(name: string, attrs: Record<string, string> | null, ...kids: (string | null | undefined | false)[]): string {
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
  return `<${name}${a}>${kids.filter((k) => k !== null && k !== undefined && k !== false).join('')}</${name}>`;
}
const CAT: Record<VatCode, string> = { standard: 'S', zero: 'Z', exempt: 'E', out_of_scope: 'O' };
/** The participant identifier on the Peppol network: scheme 0235 (UAE TIN), the first 10 digits of the TRN. */
export const endpointOf = (trn: string) => trn.replace(/\D/g, '').slice(0, 10);

function party(p: EParty): string {
  return el('cac:Party', null,
    p.vatNumber && el('cbc:EndpointID', { schemeID: '0235' }, endpointOf(p.vatNumber)),
    el('cac:PostalAddress', null, p.street && el('cbc:StreetName', null, esc(p.street)), p.city && el('cbc:CityName', null, esc(p.city)),
      el('cac:Country', null, el('cbc:IdentificationCode', null, esc(p.country || 'AE')))),
    p.vatNumber && el('cac:PartyTaxScheme', null, el('cbc:CompanyID', null, esc(p.vatNumber)), el('cac:TaxScheme', null, el('cbc:ID', null, 'VAT'))),
    el('cac:PartyLegalEntity', null, el('cbc:RegistrationName', null, esc(p.name)), p.crNumber && el('cbc:CompanyID', null, esc(p.crNumber))),
    p.email && el('cac:Contact', null, el('cbc:ElectronicMail', null, esc(p.email))));
}

/** UAE e-invoicing covers business buyers (B2B) and government (B2G): a buyer with a TRN. Sales to consumers stay as they are. */
export const pintAeInScope = (d: Pick<EInvoiceData, 'buyer'>) => Boolean(d.buyer?.vatNumber);

export function pintAeXml(d: EInvoiceData): string {
  const credit = d.type === 'credit_note';
  const root = credit ? 'CreditNote' : 'Invoice';
  const cur = d.currency, amt = { currencyID: cur };
  const groups = new Map<string, { code: VatCode; rate: string; net: bigint; vat: bigint }>();
  for (const l of d.lines) {
    const k = `${l.vatCode}|${l.vatRate}`; const g = groups.get(k) ?? { code: l.vatCode, rate: l.vatRate, net: 0n, vat: 0n };
    g.net += toCents(l.net); g.vat += toCents(l.vat); groups.set(k, g);
  }
  const pct = (r: string) => Number(r).toFixed(2);
  const body = [
    el('cbc:CustomizationID', null, PINT_AE.customization),
    el('cbc:ProfileID', null, PINT_AE.profile),
    el('cbc:ID', null, esc(d.number)),
    el('cbc:UUID', null, d.uuid),
    el('cbc:IssueDate', null, d.issueDate),
    el('cbc:IssueTime', null, d.issueTime),
    !credit && d.dueDate && el('cbc:DueDate', null, d.dueDate),
    el(credit ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', null, credit ? '381' : '380'),
    credit && d.reason && el('cbc:Note', null, esc(d.reason)),
    el('cbc:DocumentCurrencyCode', null, cur),
    el('cbc:TaxCurrencyCode', null, 'AED'),
    d.original && el('cac:BillingReference', null, el('cac:InvoiceDocumentReference', null, el('cbc:ID', null, esc(d.original.number)), el('cbc:IssueDate', null, d.original.issueDate))),
    el('cac:AccountingSupplierParty', null, party(d.seller)),
    el('cac:AccountingCustomerParty', null, d.buyer ? party(d.buyer) : ''),
    el('cac:Delivery', null, el('cbc:ActualDeliveryDate', null, d.supplyDate)),
    el('cac:PaymentMeans', null, el('cbc:PaymentMeansCode', null, esc(d.paymentMeans))),
    el('cac:TaxTotal', null, el('cbc:TaxAmount', amt, d.vatTotal),
      ...[...groups.values()].map((g) => el('cac:TaxSubtotal', null, el('cbc:TaxableAmount', amt, fromCents(g.net)), el('cbc:TaxAmount', amt, fromCents(g.vat)),
        el('cac:TaxCategory', null, el('cbc:ID', null, CAT[g.code]), el('cbc:Percent', null, pct(g.rate)), el('cac:TaxScheme', null, el('cbc:ID', null, 'VAT')))))),
    el('cac:LegalMonetaryTotal', null, el('cbc:LineExtensionAmount', amt, d.netTotal), el('cbc:TaxExclusiveAmount', amt, d.netTotal),
      el('cbc:TaxInclusiveAmount', amt, d.grossTotal), el('cbc:PayableAmount', amt, d.grossTotal)),
    ...d.lines.map((l) => el(credit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine', null,
      el('cbc:ID', null, String(l.no)),
      el(credit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity', { unitCode: 'C62' }, l.quantity),
      el('cbc:LineExtensionAmount', amt, l.net),
      el('cac:Item', null, el('cbc:Name', null, esc(l.description)),
        el('cac:ClassifiedTaxCategory', null, el('cbc:ID', null, CAT[l.vatCode]), el('cbc:Percent', null, pct(l.vatRate)), el('cac:TaxScheme', null, el('cbc:ID', null, 'VAT')))),
      el('cac:Price', null, el('cbc:PriceAmount', amt, l.unitPrice)))),
  ];
  const ns = credit ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${el(root, { xmlns: ns, 'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2' }, ...body)}`;
}
