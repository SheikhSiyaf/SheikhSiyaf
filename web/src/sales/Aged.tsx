// Aged receivables / payables: what is still due per customer or supplier, by days overdue.
import { useState } from 'react';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { moduleOfSide, useGo, type Side } from './common.tsx';

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
type Row = { contactId: string; name: string; nameAr: string | null; total: string } & Record<(typeof BUCKETS)[number], string>;

export function Aged({ books, side }: { books: CompanyBooks; side: Side }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [asOf, setAsOf] = useState(today());
  const r = useApi<{ asOf: string; rows: Row[] }>(`/api/companies/${books.company.id}/reports/aged?side=${side}&asOf=${asOf}`);
  const sum = (k: (typeof BUCKETS)[number] | 'total') => fmt(fromMinor((r.data?.rows ?? []).reduce((s, x) => s + toMinor(x[k]), 0n)));
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t(side === 'sales' ? 'aged.receivables' : 'aged.payables')} ({books.company.currency})</h2>
        <span className="spacer" />
        <label className="f">{t('asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      </div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('aged.hint')}</div>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data ? <Loading /> : r.data.rows.length === 0 ? <div className="mut">{t('aged.nothing')}</div> : (
        <div className="wrap">
          <table>
            <thead><tr><th>{t(side === 'sales' ? 'contact.customer' : 'contact.supplier')}</th>{BUCKETS.map((b) => <th key={b} className="num">{t(`aged.${b}` as Key)}</th>)}<th className="num">{t('total')}</th></tr></thead>
            <tbody>
              {r.data.rows.map((x) => (
                <tr key={x.contactId}>
                  <td><button className="link" onClick={() => go(moduleOfSide(side), side === 'sales' ? 'customers' : 'suppliers', x.contactId)}>{local(x.name, x.nameAr)}</button></td>
                  {BUCKETS.map((b) => <td key={b} className={`num ltr ${b !== 'current' && toMinor(x[b]) > 0n ? 'bad' : ''}`}>{toMinor(x[b]) ? fmt(x[b]) : ''}</td>)}
                  <td className="num ltr"><b>{fmt(x.total)}</b></td>
                </tr>
              ))}
              <tr className="total"><td>{t('total')}</td>{BUCKETS.map((b) => <td key={b} className="num ltr">{sum(b)}</td>)}<td className="num ltr">{sum('total')}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
