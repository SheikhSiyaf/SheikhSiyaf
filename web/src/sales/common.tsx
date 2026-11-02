// Shared types and small pieces for the Sales and Purchases screens.
import type { CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';

export type DocType = 'quotation' | 'invoice' | 'credit_note' | 'bill' | 'supplier_credit';
export type Side = 'sales' | 'purchases';
export type Direction = 'received' | 'made';

export interface Contact {
  id: string; isCustomer: boolean; isSupplier: boolean; name: string; nameAr: string | null; vatNumber: string | null; crNumber: string | null;
  email: string | null; phone: string | null; address: string | null; city: string | null; country: string | null;
  paymentTermsDays: number | null; status: string; balanceDue?: string; overdue?: string;
}
export interface DocRow {
  id: string; type: DocType; status: string; state: string; number: string | null; contactId: string; contactName: string; contactNameAr: string | null;
  issueDate: string; dueDate: string | null; reference: string | null; notes: string | null; originalId: string | null; journalEntryId: string | null;
  netTotal: string; vatTotal: string; grossTotal: string; amountDue: string;
}
export interface DocLine {
  id: string; lineNo: number; description: string; quantity: string; unitPrice: string; accountId: string; accountCode: string; accountName: string;
  accountNameAr: string | null; costCentreId: string | null; costCentre: string | null; costCentreAr: string | null; vatCode: string; vatRate: string; net: string; vat: string;
}
export interface DocDetail extends DocRow {
  lines: DocLine[];
  payments: { id: string; number: string; date: string; amount: string; method: string; voidedAt: string | null }[];
  related: { id: string; type: DocType; status: string; number: string | null; issueDate: string; grossTotal: string }[];
  contact: Contact;
  seller: { name: string; nameAr: string | null; vatNumber: string | null; crNumber: string; address: string; city: string; country: string; currency: string };
}
export interface PaymentRow {
  id: string; direction: Direction; number: string; contactId: string; contactName: string; date: string; amount: string; accountId: string;
  accountName: string; accountNameAr: string | null; method: string; reference: string | null; voidedAt: string | null; unallocated: string;
}

export const sideOf = (t: DocType): Side => (t === 'quotation' || t === 'invoice' || t === 'credit_note' ? 'sales' : 'purchases');
export const moduleOfSide = (s: Side) => (s === 'sales' ? 'Sales' : 'Purchases');

/** Navigates inside a client's books: /c/<company>/<module>/<sub>/<item>/<extra> */
export function useGo(companyId: string) {
  return (module: string, sub?: string, item?: string, extra?: string, extra2?: string) =>
    navigate(`/${['c', companyId, module, sub, item, extra, extra2].filter((x) => x !== undefined && x !== '').join('/')}`);
}

const STATE_CLASS: Record<string, string> = {
  draft: '', sent: '', accepted: 'good', declined: 'bad', invoiced: 'good', issued: 'good',
  paid: 'good', partly_paid: 'warn', unpaid: 'warn', overdue: 'bad', credit: 'good', voided: 'bad',
};

export function StateBadge({ state }: { state: string }) {
  const { t } = useI18n();
  return <span className={`badge ${STATE_CLASS[state] ?? ''}`}>{t(`state.${state}` as Key)}</span>;
}

export const bankAccounts = (b: CompanyBooks) => b.accounts.filter((a) => a.isBank);
export const lineAccounts = (b: CompanyBooks, side: Side) =>
  b.accounts.filter((a) => (side === 'sales' ? a.type === 'income' : (a.type === 'expense' || (a.type === 'asset' && !a.isBank && !['1100', '1200'].includes(a.code)))));
