import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { fmt, neg } from '../money.ts';
import { toMinor, fromMinor } from '../money.ts';
import { ErrorNote, Loading } from '../ui.tsx';

interface Summary {
  asOf: string; cash: string; receivables: string; payables: string; inputVat: string; outputVat: string;
  monthIncome: string; monthExpense: string; monthProfit: string; entries: number; entriesThisMonth: number; lockedUpTo: string | null;
}

export function Home({ books, go }: { books: CompanyBooks; go: (m: string) => void }) {
  const { t } = useI18n();
  const s = useApi<Summary>(`/api/companies/${books.company.id}/summary`);
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const cur = books.company.currency;
  const vatDue = fromMinor(-toMinor(d.outputVat) - toMinor(d.inputVat));
  const figs: [string, string, string][] = [
    [t('home.cash'), d.cash, t('home.fromLedger')],
    [t('home.receivables'), d.receivables, t('home.fromLedger')],
    [t('home.payables'), neg(d.payables), t('home.fromLedger')],
    [t('home.profit'), d.monthProfit, t('home.salesLessExpenses')],
  ];
  return (
    <>
      <div className="grid">
        {figs.map(([label, value, note]) => (
          <div key={label} className="card fig">
            <small>{label}</small>
            <b className="ltr">{fmt(value)}</b>
            <small>{cur} · {note}</small>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>{t('home.todo')}</h2>
        <table>
          <tbody>
            <tr><td>{t('home.vatDue')}</td><td className="num ltr">{fmt(vatDue)} {cur}</td></tr>
            <tr><td>{t('home.entriesThisMonth')}</td><td className="num">{d.entriesThisMonth}</td></tr>
            <tr><td>{t('home.lockedUpTo')}</td><td className="num">{d.lockedUpTo ?? <span className="mut">{t('home.notLocked')}</span>}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>{t('home.quick')}</h2>
        <div className="actions">
          {books.canPost && <button className="b p" onClick={() => go('Journal')}>{t('home.newEntry')}</button>}
          <button className="b" onClick={() => go('Reports')}>{t('home.trialBalance')}</button>
          <button className="b" onClick={() => go('VAT')}>{t('home.vatSummary')}</button>
        </div>
      </div>
    </>
  );
}
