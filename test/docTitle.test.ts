// The invoice screen names the document as the PDF and ZATCA do: a Saudi invoice to a buyer without a VAT number is
// a simplified tax invoice; with one, a tax invoice (web/src/print/Pdf.tsx docTitle).
import { describe, it, expect } from 'vitest';

// The web files are JSX, which the server's type check does not compile; Vitest loads them at run time.
type Title = (d: { type: string; isAdvance?: boolean; seller?: { country: string } | null; contact?: { vatNumber: string | null } | null }) => string;
const web = (p: string) => import(p);
const { docTitle } = (await web('../web/src/print/Pdf.tsx')) as { docTitle: Title };
const { translate } = (await web('../web/src/i18n.tsx')) as { translate: (lang: string, key: string) => string };

const sa = { country: 'SA' };
describe('The invoice heading on screen', () => {
  it('says "Simplified tax invoice" for a Saudi invoice to a buyer without a VAT number', () => {
    expect(translate('en', docTitle({ type: 'invoice', seller: sa, contact: { vatNumber: null } }))).toBe('Simplified tax invoice');
    expect(translate('ar', docTitle({ type: 'invoice', seller: sa, contact: null }))).toBe('فاتورة ضريبية مبسطة');
  });
  it('says "Tax invoice" for a business buyer with a VAT number, and in the UAE', () => {
    expect(translate('en', docTitle({ type: 'invoice', seller: sa, contact: { vatNumber: '310000000000003' } }))).toBe('Tax invoice');
    expect(translate('en', docTitle({ type: 'invoice', seller: { country: 'AE' }, contact: null }))).toBe('Tax invoice');
  });
  it('names advance invoices the same way, and leaves other documents alone', () => {
    expect(translate('en', docTitle({ type: 'invoice', isAdvance: true, seller: sa, contact: null }))).toBe('Simplified advance payment tax invoice');
    expect(translate('en', docTitle({ type: 'bill', seller: sa, contact: null }))).toBe(translate('en', 'doc.title.bill'));
  });
});
