// Expenses at a glance: spent this month vs last month, top categories, drafts and recurring expenses due.
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';

export interface Category { id: string; code: string; name: string; nameAr: string | null; costCentreRequired: boolean; spent: string }
interface Data { spentThisMonth: string; spentLastMonth: string; drafts: number; recurringDue: number; recurringActive: number; topCategories: Category[] }

export function ExpensesOverview({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const d = useApi<Data>(`/api/companies/${books.company.id}/expense-overview`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const cur = books.company.currency;
  const createDue = async () => {
    setBusy(true); setMsg({});
    try {
      const r = await api<{ created: string[] }>(`/api/companies/${books.company.id}/recurring/generate`, { body: {} });
      setMsg({ ok: t('rec.created', { n: r.created.length }) }); d.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return (
    <>
      {books.canPost && (
        <div className="card">
          <div className="actions">
            <button className="b p" onClick={() => go('Expenses', 'expenses', 'new')}>{t('exp.record')}</button>
            <button className="b" onClick={() => go('Expenses', 'recurring', 'new')}>{t('rec.new')}</button>
            <button className="b" onClick={() => go('Purchases', 'bills', 'new')}>{t('ov.newBill')}</button>
          </div>
        </div>
      )}
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad">{msg.bad}</div>}
      <div className="grid">
        <button className="card fig tile" onClick={() => go('Reports', 'expenses-by-category')}><small>{t('exp.spentMonth')}</small><b className="ltr">{fmt(x.spentThisMonth)}</b><small>{cur} · {t('ov.exclVat')}</small></button>
        <button className="card fig tile" onClick={() => go('Reports', 'expenses-by-category')}><small>{t('exp.spentLastMonth')}</small><b className="ltr">{fmt(x.spentLastMonth)}</b><small>{cur}</small></button>
        <button className="card fig tile" onClick={() => go('Expenses', 'expenses', undefined, 'draft')}><small>{t('exp.drafts')}</small><b>{x.drafts}</b><small>{t('exp.toCheck')}</small></button>
        <button className="card fig tile" onClick={() => go('Expenses', 'recurring')}><small>{t('rec.title')}</small><b>{x.recurringActive}</b><small>{t('rec.dueNow', { n: x.recurringDue })}</small></button>
      </div>
      {x.recurringDue > 0 && books.canPost && (
        <div className="notice warn actions">
          <span>{t('rec.dueNotice', { n: x.recurringDue })}</span>
          <button className="b p small" disabled={busy} onClick={() => void createDue()}>{t('rec.createDue')}</button>
        </div>
      )}
      <div className="card">
        <h2>{t('exp.topCategories')}</h2>
        {x.topCategories.length === 0 ? <div className="mut">{t('exp.nothingThisMonth')}</div> : <Bars rows={x.topCategories} cur={cur} />}
      </div>
    </>
  );
}

/** Horizontal bars, longest first; widths are proportional to the largest amount. */
export function Bars({ rows, cur }: { rows: { id?: string; name: string; nameAr: string | null; spent: string; code?: string }[]; cur: string }) {
  const local = useLocalName();
  const max = rows.reduce((m, r) => (toMinor(r.spent) > m ? toMinor(r.spent) : m), 1n);
  return (
    <div className="bars">
      {rows.map((r) => {
        const pct = Number((toMinor(r.spent) * 1000n) / max) / 10;   // display width only, not money
        return (
          <div key={r.id ?? r.name} className="bar-row">
            <div className="bar-label">{r.code ? `${r.code} ` : ''}{local(r.name, r.nameAr)}</div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(pct, 1)}%` }} /></div>
            <div className="bar-value num ltr">{fmt(r.spent)} <span className="mut small">{cur}</span></div>
          </div>
        );
      })}
    </div>
  );
}
