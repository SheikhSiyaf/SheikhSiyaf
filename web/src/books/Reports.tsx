import { useState } from 'react';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { Aged } from '../sales/Aged.tsx';
import { AccountLink, PnlStatement } from './Statements.tsx';

interface TB { asOf: string; rows: { accountId: string; code: string; name: string; nameAr: string | null; debit: string; credit: string }[] }
interface PnlRow { income: string; expense: string; profit: string }
type Group = 'revenue' | 'cost_of_sales' | 'indirect_expense' | 'other_income';
interface PNL { from: string; to: string; total: PnlRow; byCostCentre: (PnlRow & { costCentreId: string | null; name: string | null; nameAr: string | null; kind: string | null })[];
  statement: { lines: { accountId: string; name: string; nameAr: string | null; group: Group; amount: string }[]; revenue: string; costOfSales: string; grossProfit: string;
    indirectExpenses: string; otherIncome: string; netProfit: string } }

export function Reports({ books, sub }: { books: CompanyBooks; sub: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const id = books.company.id;
  const [asOf, setAsOf] = useState(today());
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const tb = useApi<TB>(sub === 'trial-balance' && asOf ? `/api/companies/${id}/reports/trial-balance?asOf=${asOf}` : null);
  const pnl = useApi<PNL>(sub !== 'trial-balance' && from && to ? `/api/companies/${id}/reports/profit-and-loss?from=${from}&to=${to}` : null);

  const dr = tb.data?.rows.reduce((s, r) => s + toMinor(r.debit), 0n) ?? 0n;
  const cr = tb.data?.rows.reduce((s, r) => s + toMinor(r.credit), 0n) ?? 0n;
  const ccSum = pnl.data?.byCostCentre.reduce((s, r) => s + toMinor(r.profit), 0n);

  if (sub === 'aged-receivables' || sub === 'aged-payables') return <Aged books={books} side={sub === 'aged-receivables' ? 'sales' : 'purchases'} />;
  const byCc = sub === 'cost-centres';
  return (
    <>
      {sub === 'trial-balance' && <div className="card">
        <div className="actions" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('reports.tb')} ({books.company.currency})</h2>
          <span className="spacer" />
          <label className="f">{t('asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        </div>
        {tb.error && <ErrorNote error={tb.error} onRetry={tb.reload} />}
        {!tb.data ? <Loading /> : (
          <div className="wrap">
            <table>
              <thead><tr><th>{t('journal.account')}</th><th className="num">{t('debit')}</th><th className="num">{t('credit')}</th></tr></thead>
              <tbody>
                {tb.data.rows.map((r) => (
                  <tr key={r.accountId}>
                    <td><AccountLink books={books} l={r} /></td>
                    <td className="num ltr">{toMinor(r.debit) ? fmt(r.debit) : ''}</td>
                    <td className="num ltr">{toMinor(r.credit) ? fmt(r.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(fromMinor(dr))}</td><td className="num ltr">{fmt(fromMinor(cr))}</td></tr>
              </tbody>
            </table>
            <div className={dr === cr ? 'mut small' : 'bad small'}>{dr === cr ? t('reports.balances') : t('reports.outOfBalance')}</div>
          </div>
        )}
      </div>}

      {sub !== 'trial-balance' && <div className="card">
        <div className="actions" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{byCc ? t('reports.byCostCentre') : t('reports.pnl')}</h2>
          <span className="spacer" />
          <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {pnl.error && <ErrorNote error={pnl.error} onRetry={pnl.reload} />}
        {!pnl.data ? <Loading /> : (
          <>
            {!byCc && <PnlStatement books={books} from={from} to={to} />}
            {byCc && (() => {
              // Branches and departments here; projects have their own report, shown as one line so the total still agrees.
              const rows = pnl.data!.byCostCentre.filter((r) => r.kind !== 'project');
              const proj = pnl.data!.byCostCentre.filter((r) => r.kind === 'project');
              const sum = (k: 'income' | 'expense' | 'profit') => fromMinor(proj.reduce((x, r) => x + toMinor(r[k]), 0n));
              return pnl.data!.byCostCentre.length === 0 ? <div className="mut">{t('reports.noActivity')}</div> : (
                <div className="wrap">
                  <table>
                    <thead><tr><th>{t('journal.costCentre')}</th><th className="num">{t('reports.income')}</th><th className="num">{t('reports.expenses')}</th><th className="num">{t('reports.netProfit')}</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.costCentreId ?? 'none'}>
                          <td>{r.costCentreId ? local(r.name, r.nameAr) : <span className="mut">{t('reports.unassigned')}</span>}</td>
                          <td className="num ltr">{fmt(r.income)}</td><td className="num ltr">{fmt(r.expense)}</td><td className="num ltr">{fmt(r.profit)}</td>
                        </tr>
                      ))}
                      {proj.length > 0 && (
                        <tr className="mut"><td>{t('reports.onProjects', { n: proj.length })}</td><td className="num ltr">{fmt(sum('income'))}</td><td className="num ltr">{fmt(sum('expense'))}</td><td className="num ltr">{fmt(sum('profit'))}</td></tr>
                      )}
                      <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(pnl.data!.total.income)}</td><td className="num ltr">{fmt(pnl.data!.total.expense)}</td><td className="num ltr">{fmt(pnl.data!.total.profit)}</td></tr>
                    </tbody>
                  </table>
                  {ccSum === toMinor(pnl.data!.total.profit) && <div className="mut small no-export">{t('reports.sumCheck')}</div>}
                  {proj.length > 0 && <p className="mut small">{t('reports.projectsApart')}</p>}
                </div>
              );
            })()}
          </>
        )}
      </div>}
    </>
  );
}
