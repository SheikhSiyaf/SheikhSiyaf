// The sign-in links made when a customer is added are shown ONCE, on the customer's page that opens straight after. This is
// the hand-over between the two screens, held in memory only (never saved in the browser or sent anywhere).
import type { Invite } from '../ui.tsx';

let held: { companyId: string; invites: Invite[] } | undefined;

export function holdInvites(companyId: string, invites: Invite[]): void { held = { companyId, invites }; }

/** The links for this company. Reading does not clear them (React may render twice in development); the page clears them
 *  once it is on screen with {@link clearPendingInvites}. */
export function takePendingInvites(companyId: string): Invite[] {
  return held && held.companyId === companyId ? held.invites : [];
}
export function clearPendingInvites(): void { held = undefined; }
