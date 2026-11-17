// VAT calculation. Same invoice layout for every country; country e-invoicing is a separate adapter.
//
// ROUNDING, settled against ZATCA's Electronic Invoice XML Implementation Standard v1.2, section 10:
// half-up to 2 decimals, and a VAT CATEGORY's tax amount is rounded once on the document, never added up from
// rounded line amounts. vatForLine below rounds one amount; a document with several lines in the same category
// goes through roundVatByCategory (src/books/documents.ts), which works the category total out and then shares it
// over the lines. Change the rule only here and there, with tests.
import { divRoundHalfUp, type Minor } from '../money.js';

export const VAT_ROUNDING_RULE =
  'half-up to 2 decimals; a VAT category is rounded once on the document total, then shared over its lines'
  + ' (ZATCA XML Implementation Standard v1.2, section 10)';

/** "15.00" -> 1500 (hundredths of a percent). */
export function rateToBasisPoints(rate: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(rate.trim());
  if (!m) throw new Error(`Not a valid VAT rate: "${rate}"`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

export function vatForLine(netMinor: Minor, rate: string): Minor {
  return divRoundHalfUp(netMinor * rateToBasisPoints(rate), 10_000n);
}

export interface InvoiceLine { description: string; netMinor: Minor }
export interface PricedLine extends InvoiceLine { vatMinor: Minor; grossMinor: Minor }
export interface PricedDocument { vatRate: string; lines: PricedLine[]; netMinor: Minor; vatMinor: Minor; grossMinor: Minor }

function totals(vatRate: string, lines: PricedLine[]): PricedDocument {
  const sum = (f: (l: PricedLine) => Minor) => lines.reduce((a, l) => a + f(l), 0n);
  return { vatRate, lines, netMinor: sum((l) => l.netMinor), vatMinor: sum((l) => l.vatMinor), grossMinor: sum((l) => l.grossMinor) };
}

export function priceInvoice(lines: InvoiceLine[], vatRate: string): PricedDocument {
  return totals(
    vatRate,
    lines.map((l) => {
      const vatMinor = vatForLine(l.netMinor, vatRate);
      return { ...l, vatMinor, grossMinor: l.netMinor + vatMinor };
    }),
  );
}

/**
 * Full credit note: copies the invoice's own net and VAT per line and negates them.
 * VAT is never recomputed, so the credit note reverses the original VAT exactly even if
 * the company's rate or the rounding rule has changed since the invoice was issued.
 */
export function creditNoteFor(invoice: PricedDocument): PricedDocument {
  return totals(
    invoice.vatRate,
    invoice.lines.map((l) => ({ ...l, netMinor: -l.netMinor, vatMinor: -l.vatMinor, grossMinor: -l.grossMinor })),
  );
}
