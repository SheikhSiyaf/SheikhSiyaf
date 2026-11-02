// Small fetch wrapper. Errors carry the server's message and translation key.
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public key?: string, public details?: string[]) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
  user: { id: string; name: string; email: string; kind: 'admin' | 'firm_staff' | 'client'; staffRole: Role | null; firmName: string };
  companies: { id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string; role: Role }[];
}
export interface Account { id: string; code: string; name: string; nameAr: string | null; type: string; costCentreRequired: boolean }
export interface CostCentre { id: string; name: string; nameAr: string | null; kind: string }
export interface Period { startDate: string; endDate: string; lockedAt: string | null }
export interface CompanyBooks {
  company: { id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; vatRate: string; vatStatus: string };
  role: Role; canPost: boolean; canLock: boolean;
  accounts: Account[]; costCentres: CostCentre[]; periods: Period[];
}
export interface EntryLine { id: string; accountCode: string; accountName: string; accountNameAr: string | null; costCentre: string | null; costCentreAr: string | null; debit: string; credit: string }
export interface Entry { id: string; date: string; memo: string | null; createdBy: string | null; reversesEntryId: string | null; reversedById: string | null; lines: EntryLine[] }
