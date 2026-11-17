// What a ZATCA e-invoice file is called.
//
// ZATCA Electronic Invoice XML Implementation Standard v1.2, section 14 "File Name Specification":
//
//   Seller Identification + "_" + Date + "T" + Time + "_" + IRN.xml
//
//   Seller Identification  BT-31    the seller's VAT number
//   Date                   BT-2     the invoice issue date with dashes removed
//   Time                   KSA-25   the invoice issue time with colons removed
//   Invoice number         BT-1     the invoice number with all non-alphanumeric characters replaced by a dash
//
// Their example: 3xxxxxxxxx1xxx3_20210526T132400_2021-05-26-23555.xml
// (the invoice number keeps its dashes, because a dash is itself replaced by a dash).

export interface FileNameParts {
  /** The seller's VAT number (BT-31). */
  sellerVatNumber: string;
  /** The issue date as it is in the invoice: YYYY-MM-DD. */
  issueDate: string;
  /** The issue time as it is in the invoice: HH:mm:ss. */
  issueTime: string;
  /** The invoice number (BT-1). */
  number: string;
}

export function zatcaFileName(p: FileNameParts): string {
  const date = p.issueDate.replace(/-/g, '');
  const time = p.issueTime.replace(/:/g, '');
  // One dash for each non-alphanumeric character, not one for a run of them: that is what the rule says, and it is
  // what keeps their own example (2021-05-26-23555) unchanged.
  const irn = p.number.replace(/[^0-9A-Za-z]/g, '-');
  return `${p.sellerVatNumber}_${date}T${time}_${irn}.xml`;
}

/** The four parts, read out of the stamped invoice itself, so the name always matches the file's own contents. */
export function fileNamePartsFromXml(xml: string): FileNameParts | null {
  const number = /<cbc:ID>([^<]*)<\/cbc:ID>/.exec(xml)?.[1];
  const issueDate = /<cbc:IssueDate>([^<]*)<\/cbc:IssueDate>/.exec(xml)?.[1];
  const issueTime = /<cbc:IssueTime>([^<]*)<\/cbc:IssueTime>/.exec(xml)?.[1];
  // The seller is the FIRST PartyTaxScheme in the document: AccountingSupplierParty comes before the customer.
  const sellerVatNumber = /<cac:AccountingSupplierParty>[\s\S]*?<cac:PartyTaxScheme>[\s\S]*?<cbc:CompanyID>([^<]*)<\/cbc:CompanyID>/.exec(xml)?.[1];
  if (!number || !issueDate || !issueTime || !sellerVatNumber) return null;
  return { sellerVatNumber, issueDate, issueTime, number };
}
