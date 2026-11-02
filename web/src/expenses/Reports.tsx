// Expense reports: by category (from the ledger) and by supplier or payee (from bills and expenses).
import { useState } from 'react';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { Bars, type Category } from './Overview.tsx';

function Range({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </>
  );
}

export function ExpensesByCategory({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const r = useApi<{ rows: Category[]; total: string }>(`/api/companies/${books.company.id}/reports/expenses-by-category?from=${from}&to=${to}`);
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('sub.expenses-by-category')} ({books.company.currency})</h2>
        <span className="spacer" />
        <Range from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </div>
      <p className="mut small">{t('exp.byCategoryHint')}</p>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data ? <Loading /> : r.data.rows.length === 0 ? <div className="mut">{t('reports.noActivity')}</div> : (
        <>
          <Bars rows={[...r.data.rows].sort((a, b) => (toMinor(b.spent) > toMinor(a.spent) ? 1 : -1))} cur={books.company.currency} />
          <table className="totals"><tbody><tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(r.data.total)}</td></tr></tbody></table>
        </>
      )}
    </div>
  );
}

interface PayeeRow { name: string; nameAr: string | null; contactId: string | null; documents: number; net: string; vat: string; gross: string }

export function ExpensesByPayee({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const r = useApi<{ rows: PayeeRow[]; total: { net: string; vat: string; gross: string } }>(`/api/companies/${books.company.id}/reports/expenses-by-payee?from=${from}&to=${to}`);
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('sub.expenses-by-payee')} ({books.company.currency})</h2>
        <span className="spacer" />
        <Range from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </div>
      <p className="mut small">{t('exp.byPayeeHint')}</p>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data ? <Loading /> : r.data.rows.length === 0 ? <div className="mut">{t('reports.noActivity')}</div> : (
        <div className="wrap">
          <table className="stack">
            <thead><tr><th>{t('exp.paidTo')}</th><th className="num">{t('exp.documents')}</th><th className="num">{t('doc.subtotal')}</th><th className="num">{t('doc.vatTotal')}</th><th className="num">{t('doc.total')}</th></tr></thead>
            <tbody>
              {r.data.rows.map((x) => (
                <tr key={`${x.contactId}-${x.name}`}>
                  <td>{x.contactId ? <button className="link" onClick={() => go('Purchases', 'suppliers', x.contactId!)}>{local(x.name, x.nameAr)}</button> : x.name}</td>
                  <td className="num" data-label={t('exp.documents')}>{x.documents}</td>
                  <td className="num ltr" data-label={t('doc.subtotal')}>{fmt(x.net)}</td>
                  <td className="num ltr" data-label={t('doc.vatTotal')}>{fmt(x.vat)}</td>
                  <td className="num ltr" data-label={t('doc.total')}>{fmt(x.gross)}</td>
                </tr>
              ))}
              <tr className="total"><td>{t('total')}</td><td /><td className="num ltr">{fmt(r.data.total.net)}</td><td className="num ltr">{fmt(r.data.total.vat)}</td><td className="num ltr">{fmt(r.data.total.gross)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
