// What a ZATCA e-invoice file is called: ZATCA Electronic Invoice XML Implementation Standard v1.2, section 14.
// Until now the download was named after the invoice number alone, which is not the convention ZATCA sets out.
import { describe, it, expect } from 'vitest';
import { zatcaFileName, fileNamePartsFromXml } from '../src/einvoice/zatca/fileName.js';
import * as X from '../src/einvoice/zatca/xml.js';
import type { EInvoiceData } from '../src/einvoice/invoiceData.js';

describe('The e-invoice file name', () => {
  it('is ZATCA\'s own example, exactly', () => {
    // From section 14: Seller Identification + "_" + Date + "T" + Time + "_" + IRN.xml
    expect(zatcaFileName({ sellerVatNumber: '311111111101113', issueDate: '2021-05-26', issueTime: '13:24:00', number: '2021-05-26-23555' }))
      .toBe('311111111101113_20210526T132400_2021-05-26-23555.xml');
  });

  it('drops the dashes from the date and the colons from the time', () => {
    const n = zatcaFileName({ sellerVatNumber: '310122393500003', issueDate: '2026-11-03', issueTime: '09:05:07', number: 'INV0001' });
    expect(n).toBe('310122393500003_20261103T090507_INV0001.xml');
  });

  it('replaces every non-alphanumeric character of the invoice number with one dash each', () => {
    const n = (number: string) => zatcaFileName({ sellerVatNumber: '3', issueDate: '2026-01-02', issueTime: '00:00:00', number });
    expect(n('INV/2026 #12')).toBe('3_20260102T000000_INV-2026--12.xml');     // the space and the # are each a dash
    expect(n('ANN-0001')).toBe('3_20260102T000000_ANN-0001.xml');             // a dash stays a dash
    expect(n('فاتورة-7')).toBe('3_20260102T000000_-------7.xml');             // non-Latin letters are not alphanumeric here
  });

  it('is read out of the stamped invoice, so the name always matches the file', () => {
    const seller = { name: 'Al Noor Trading', vatNumber: '310122393500003', crNumber: '1010010000', street: 'Prince Sultan', building: '2322', district: 'Al-Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' };
    const buyer = { name: 'Gulf Steel', vatNumber: '300075588700003', street: 'King Fahd Road', building: '1111', district: 'Al-Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' };
    const data: EInvoiceData = {
      number: 'RSC-0042', uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', type: 'invoice', issueDate: '2026-11-03', issueTime: '14:40:40',
      supplyDate: '2026-11-03', currency: 'SAR', seller, buyer, paymentMeans: '10',
      lines: [{ no: 1, description: 'Steel pipes', quantity: '2.000', unitPrice: '500.00', net: '1000.00', vat: '150.00', vatCode: 'standard', vatRate: '15.00' }],
      netTotal: '1000.00', vatTotal: '150.00', grossTotal: '1150.00',
      exemption: { zero: { code: 'VATEX-SA-32', text: 'Export' }, exempt: { code: 'VATEX-SA-29', text: 'Financial' }, out_of_scope: { code: 'VATEX-SA-OOS', text: 'Not subject' } },
    };
    const xml = X.invoiceXml(data, { icv: 7, pih: X.FIRST_PIH });
    const parts = fileNamePartsFromXml(xml);
    // The SELLER's VAT number, not the buyer's: both appear in the invoice.
    expect(parts).toEqual({ sellerVatNumber: '310122393500003', issueDate: '2026-11-03', issueTime: '14:40:40', number: 'RSC-0042' });
    expect(zatcaFileName(parts!)).toBe('310122393500003_20261103T144040_RSC-0042.xml');
  });

  it('says so rather than guessing when the invoice does not carry what the name needs', () => {
    expect(fileNamePartsFromXml('<Invoice><cbc:ID>X</cbc:ID></Invoice>')).toBeNull();
  });
});
