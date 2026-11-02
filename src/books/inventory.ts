// Stock at weighted average cost. Pure functions shared by the API and the demo build.
// The database re-checks the same maths when a goods note is posted (db/migrations/0011_inventory.sql).
import { divRoundHalfUp, type Minor } from '../money.js';
import { milliToString, quantityToMilli } from './documents.js';

export type NoteType = 'grn' | 'gdn';
export const notePrefix = (t: NoteType) => (t === 'grn' ? 'GRN-' : 'GDN-');

/** Value of goods received: quantity x cost per unit, rounded half away from zero. */
export const receivedValue = (qtyMilli: bigint, unitCost: Minor): Minor => divRoundHalfUp(qtyMilli * unitCost, 1000n);

/** Cost of goods going out at the average cost; all the value when all the stock goes (no rounding left behind). */
export function issueCost(onHandMilli: bigint, onHandValue: Minor, qtyMilli: bigint): Minor {
  if (qtyMilli > onHandMilli) throw new Error('not enough stock');
  if (qtyMilli === onHandMilli) return onHandValue;
  return divRoundHalfUp(onHandValue * qtyMilli, onHandMilli);
}

/** Average cost per unit for display (2 decimals). */
export const averageCost = (onHandMilli: bigint, onHandValue: Minor): Minor =>
  onHandMilli > 0n ? divRoundHalfUp(onHandValue * 1000n, onHandMilli) : 0n;

export { quantityToMilli, milliToString };
