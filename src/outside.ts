// OUTSIDE_CALLS=off: the server never contacts an outside service (ZATCA, the online-payment provider, the exchange-rate
// provider, the email provider). For demo and test sites, where anyone signed in could otherwise press "connect".
import { HttpError } from './api/errors.js';

export const outsideCallsOff = () => process.env.OUTSIDE_CALLS === 'off';

export const OUTSIDE_OFF_MESSAGE = 'Connections to outside services (ZATCA, online payment, exchange rates, email) are switched off on this site.';

export function assertOutsideCalls(): void {
  if (outsideCallsOff()) throw new HttpError(403, OUTSIDE_OFF_MESSAGE, 'err.outsideOff');
}

/** Wraps a fetch so it refuses, before any request leaves the server, while outside calls are off. */
export function guardFetch<F extends (...a: never[]) => unknown>(f: F): F {
  return ((...a: Parameters<F>) => { assertOutsideCalls(); return f(...a); }) as F;
}
