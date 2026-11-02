// Expense categories = expense accounts in the chart. Shows this year's spending; posting roles can add one.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import type { Category } from './Overview.tsx';

export function Categories({ books, onAdded }: { books: CompanyBooks; onAdded: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const list = useApi<Category[]>(`/api/companies/${books.company.id}/expense-categories`);
  const [f, setF] = useState({ name: '', nameAr: '', costCentreRequired: false });
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { setMsg({ bad: t('exp.categoryName') }); return; }
    setBusy(true); setMsg({});
    try {
      await api(`/api/companies/${books.company.id}/expense-categories`, { body: f });
      setF({ name: '', nameAr: '', costCentreRequired: false }); setMsg({ ok: t('exp.categoryAdded') }); list.reload(); onAdded();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="card">
        <p className="mut small" style={{ marginTop: 0 }}>{t('exp.categoriesHint')}</p>
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('exp.category')}</th><th>{t('journal.costCentre')}</th><th className="num">{t('exp.spentYear')}</th></tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.code} {local(c.name, c.nameAr)}</td>
                    <td className="small" data-label={t('journal.costCentre')}>{c.costCentreRequired ? <span className="badge warn">{t('exp.ccRequired')}</span> : <span className="mut">{t('exp.ccOptional')}</span>}</td>
                    <td className="num ltr" data-label={t('exp.spentYear')}>{fmt(c.spent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {books.canPost && (
        <form className="card" onSubmit={add} noValidate>
          <h2>{t('exp.addCategory')}</h2>
          {msg.ok && <div className="notice">{msg.ok}</div>}
          {msg.bad && <div className="notice bad">{msg.bad}</div>}
          <div className="row">
            <label className="f">{t('exp.categoryNameLabel')}<input id="cat-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('exp.categoryPlaceholder')} /></label>
            <label className="f">{t('reg.nameAr')}<input id="cat-name-ar" dir="rtl" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></label>
          </div>
          <label className="actions" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={f.costCentreRequired} onChange={(e) => setF({ ...f, costCentreRequired: e.target.checked })} />
            <span>{t('exp.requireCc')}</span>
          </label>
          <button className="b p" type="submit" disabled={busy}>{t('admin.add')}</button>
        </form>
      )}
    </>
  );
}
