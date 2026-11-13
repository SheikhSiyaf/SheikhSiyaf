// Room charges, as pure functions shared by the API and the demo build (db/migrations/0044). Money is in minor units.
// A stay is counted in nights: from the arrival day up to, not including, the departure day.
// Nightly rates (and extras) are prices WITH VAT, as hotels quote them. The invoice carries the price before VAT per
// night, worked back from the price with VAT and rounded to the halala; VAT is then worked out as on any invoice line.
// So a bill can differ from the quoted price by a halala or two: the difference is shown, never hidden.
import { divRoundHalfUp, fromMinor, toMinor, type Minor } from '../money.js';
import { rateToBasisPoints, vatForLine } from '../vat/vat.js';

const dayNo = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const iso = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(dayNo(d) + n);

/** Nights from arrival to departure (the departure day is not charged). */
export const nights = (arrival: string, departure: string) => Math.max(0, dayNo(departure) - dayNo(arrival));
/** The date of each night of a stay. */
export const nightDates = (arrival: string, departure: string) => Array.from({ length: nights(arrival, departure) }, (_, i) => addDays(arrival, i));

/** The price before VAT of a price with VAT, rounded half away from zero to the halala. */
export function netFromGross(gross: Minor, vatRate: string): Minor {
  const bp = rateToBasisPoints(vatRate);
  return divRoundHalfUp(gross * 10_000n, 10_000n + bp);
}

export interface Season { from: string; to: string; rate: string }
/** The rate with VAT for a night: a season covering it (both days included), else the room type's rate. */
export function rateForNight(night: string, baseRate: string, seasons: Season[]): string {
  return seasons.find((s) => night >= s.from && night <= s.to)?.rate ?? baseRate;
}

export interface NightGroup { from: string; to: string; nights: number; rate: string }
/** The nights from `from` up to (not including) `to`, in runs of consecutive nights at the same rate.
 *  An agreed rate on the booking replaces every other rate. `to` in each group is the last night. */
export function groupNights(from: string, to: string, baseRate: string, seasons: Season[], agreedRate?: string | null): NightGroup[] {
  const out: NightGroup[] = [];
  for (const night of nightDates(from, to)) {
    const rate = agreedRate || rateForNight(night, baseRate, seasons);
    const last = out[out.length - 1];
    if (last && last.rate === rate && addDays(last.to, 1) === night) { last.to = night; last.nights++; }
    else out.push({ from: night, to: night, nights: 1, rate });
  }
  return out;
}

export interface PricedNights { quantity: number; unitPrice: string; net: string; vat: string; total: string; quoted: string; difference: string }
/** An invoice line for `quantity` nights (or units of an extra) at a price with VAT: the price before VAT per unit,
 *  the line's VAT as the invoice will work it out, the bill total, the quoted total and the difference. */
export function nightsLine(quantity: number, grossRate: string, vatRate: string): PricedNights {
  const unit = netFromGross(toMinor(grossRate), vatRate);
  const net = unit * BigInt(quantity);
  const vat = vatForLine(net, vatRate);
  const quoted = toMinor(grossRate) * BigInt(quantity);
  return { quantity, unitPrice: fromMinor(unit), net: fromMinor(net), vat: fromMinor(vat), total: fromMinor(net + vat), quoted: fromMinor(quoted), difference: fromMinor(net + vat - quoted) };
}

export type BookingStatus = 'reserved' | 'in_house' | 'departed' | 'cancelled' | 'no_show';
/** Whether a booking holds its room on a day (cancelled and no-show bookings free it). */
export const occupies = (b: { status: BookingStatus; arrival: string; departure: string }, day: string) =>
  ['reserved', 'in_house', 'departed'].includes(b.status) && day >= b.arrival && day < b.departure;

/** An extra (laundry, minibar ...): a quantity with up to 3 decimals at a price with VAT, worked out as the invoice
 *  line will be (price before VAT per unit, then quantity x price rounded, then VAT). */
export function extraLine(quantity: string, grossPrice: string, vatRate: string): PricedNights & { quantityText: string } {
  const m = /^(\d{1,8})(?:\.(\d{1,3}))?$/.exec(quantity.trim());
  if (!m) throw new Error(`Not a valid quantity: "${quantity}"`);
  const q = BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));   // thousandths
  const unit = netFromGross(toMinor(grossPrice), vatRate);
  const net = divRoundHalfUp(unit * q, 1000n);
  const vat = vatForLine(net, vatRate);
  const quoted = divRoundHalfUp(toMinor(grossPrice) * q, 1000n);
  return { quantity: Number(quantity), quantityText: quantity.trim(), unitPrice: fromMinor(unit), net: fromMinor(net), vat: fromMinor(vat), total: fromMinor(net + vat),
    quoted: fromMinor(quoted), difference: fromMinor(net + vat - quoted) };
}
