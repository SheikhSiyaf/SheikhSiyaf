// Sales (or Purchases) at a glance: what is owed, what is late, this month, and quick actions.
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { StateBadge, moduleOfSide, useGo, type DocRow, type Side } from './common.tsx';

interface Data {
  outstanding: string; outstandingCount: number; overdue: string; overdueCount: number;
  thisMonthNet: string; paidThisMonth: string; drafts: number; oldestOverdue: DocRow[];
}

export function Overview({ books, side }: { books: CompanyBooks; side: Side }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const m = moduleOfSide(side);
  const d = useApi<Data>(`/api/companies/${books.company.id}/overview?side=${side}`);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const cur = books.company.currency;
  const sales = side === 'sales';
  const docs = sales ? 'invoices' : 'bills';
  const figs: [string, string, string, () => void][] = [
    [t(sales ? 'ov.toCollect' : 'ov.toPay'), x.outstanding, t('ov.documents', { n: x.outstandingCount }), () => go(m, docs, undefined, 'unpaid')],
    [t('ov.overdue'), x.overdue, t('ov.documents', { n: x.overdueCount }), () => go(m, docs, undefined, 'overdue')],
    [t(sales ? 'ov.salesMonth' : 'ov.purchasesMonth'), x.thisMonthNet, t('ov.exclVat'), () => go(m, docs)],
    [t(sales ? 'ov.receivedMonth' : 'ov.paidMonth'), x.paidThisMonth, cur, () => go(m, sales ? 'payments-received' : 'payments-made')],
  ];
  return (
    <>
      {books.canPost && (
        <div className="card">
          <div className="actions">
            {sales ? (
              <>
                <button className="b p" onClick={() => go('Sales', 'invoices', 'new')}>{t('ov.newInvoice')}</button>
                <button className="b" onClick={() => go('Sales', 'payments-received', 'new')}>{t('ov.recordReceipt')}</button>
                <button className="b" onClick={() => go('Sales', 'quotations', 'new')}>{t('ov.newQuotation')}</button>
                <button className="b" onClick={() => go('Sales', 'customers', 'new')}>{t('ov.newCustomer')}</button>
              </>
            ) : (
              <>
                <button className="b p" onClick={() => go('Purchases', 'bills', 'new')}>{t('ov.newBill')}</button>
                <button className="b" onClick={() => go('Purchases', 'payments-made', 'new')}>{t('ov.recordPayment')}</button>
                <button className="b" onClick={() => go('Purchases', 'suppliers', 'new')}>{t('ov.newSupplier')}</button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="grid">
        {figs.map(([label, value, note, onClick]) => (
          <button key={label} className="card fig tile" onClick={onClick}>
            <small>{label}</small>
            <b className="ltr">{fmt(value)}</b>
            <small>{note}</small>
          </button>
        ))}
      </div>
      {x.drafts > 0 && (
        <div className="notice actions">
          <span>{t(sales ? 'ov.draftInvoices' : 'ov.draftBills', { n: x.drafts })}</span>
          <button className="link" onClick={() => go(m, docs, undefined, 'draft')}>{t('ov.open')}</button>
        </div>
      )}
      <div className="card">
        <h2>{t('ov.oldestOverdue')}</h2>
        {x.oldestOverdue.length === 0 ? <div className="mut">{t('ov.nothingOverdue')}</div> : (
          <div className="wrap">
            <table className="stack">
              <tbody>
                {x.oldestOverdue.map((r) => (
                  <tr key={r.id}>
                    <td><button className="link" onClick={() => go(m, docs, r.id)}>{r.number}</button> · {local(r.contactName, r.contactNameAr)}</td>
                    <td data-label={t('doc.dueDate')}>{r.dueDate}</td>
                    <td className="num ltr" data-label={t('doc.amountDue')}>{fmt(r.amountDue)} {cur}</td>
                    <td><StateBadge state={r.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
