// Small fetch wrapper. Errors carry the server's message and translation key.
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public key?: string, public details?: string[]) {
    super(message);
  }
}

/** The customer the platform owner is working in (sent on every request; the server honours it for the owner only). */
let actingTenant: string | null = (() => { try { return sessionStorage.getItem('nb_acting_tenant'); } catch { return null; } })();
export const getActingTenant = () => actingTenant;
export function setActingTenant(id: string | null) {
  actingTenant = id;
  try { if (id) sessionStorage.setItem('nb_acting_tenant', id); else sessionStorage.removeItem('nb_acting_tenant'); } catch { /* private window: kept in memory only */ }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  if (import.meta.env.VITE_DEMO === '1') {
    // Demo build: the same rules, run in the browser against sample data (web/src/demo/mockApi.ts).
    const { handle } = await import('./demo/mockApi.ts');
    const r = handle(init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'), path, init?.body, actingTenant);
    if (r.status >= 400) {
      const e = r.data as { error: string; key?: string; details?: string[] };
      throw new ApiError(r.status, e.error, e.key, e.details);
    }
    return r.data as T;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(actingTenant ? { 'x-acting-tenant': actingTenant } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server.', 'err.network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.key, data.details);
  return data as T;
}

export interface Loaded<T> { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void }

export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((error: ApiError) => live && setState({ error, loading: false }));
    return () => { live = false; };
  }, [path, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

// ------------------------------------------------------------------ types returned by the API
export type Role = 'partner' | 'reviewer' | 'staff_accountant' | 'client_accountant' | 'client_viewer';
export interface Me {
  user: { id: string; name: string; email: string; kind: 'owner' | 'admin' | 'firm_staff' | 'client'; staffRole: Role | null; firmName: string; firmKind?: 'platform' | 'firm' | 'company'; twoFactor: boolean };
  companies: { id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string; role: Role }[];
}
export interface Account { id: string; code: string; name: string; nameAr: string | null; type: string; costCentreRequired: boolean; isBank?: boolean; currency?: string | null }
export interface CostCentre { id: string; name: string; nameAr: string | null; kind: string }
export interface Period { startDate: string; endDate: string; lockedAt: string | null }
export interface CompanyBooks {
  company: { id: string; name: string; nameAr: string | null; city?: string; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string; vatStatus: string; invoicePrefix?: string; paymentTermsDays?: number; industry?: string; modules?: string[]; vatNumber?: string | null };
  role: Role; canPost: boolean; canLock: boolean;
  /** The person's client role, when they have one: access per module. Null = full access for their role. */
  access?: { name: string; nameAr?: string | null; permissions: Record<string, string>; canApprove: boolean; canReview?: boolean; canSignOff?: boolean; posMode?: boolean } | null;
  /** Review rights here: firm staff by their role, client users by their role's review and sign-off rights. */
  review?: { canReview: boolean; canSignOff: boolean };
  /** Firm staff on this client (the portal's firm side), whether this person keeps the calendar, and the customer's kind. */
  portal?: { firm: boolean; calendarEdit: boolean; tenantKind: 'firm' | 'company' | 'platform' | null };
  accounts: Account[]; costCentres: CostCentre[]; periods: Period[];
  /** The latest month the accounting firm signed off ("reviewed by your accountant"). */
  reviewedUpTo?: { periodEnd: string; signedBy: string; signedAt: string } | null;
}
export interface EntryLine { id: string; accountCode: string; accountName: string; accountNameAr: string | null; costCentre: string | null; costCentreAr: string | null; debit: string; credit: string;
  currency?: string | null; fxAmount?: string | null; fxRate?: string | null }
export interface Entry { id: string; date: string; memo: string | null; createdBy: string | null; reversesEntryId: string | null; reversedById: string | null; lines: EntryLine[] }
