// Projects: list with income, costs, profit and budget used; a page per project; a comparison report.
// A project is a cost centre of kind "project": tag invoice, bill, expense and claim lines with it.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';

interface ProjectRow {
  id: string; name: string; nameAr: string | null; status: string; budget: string | null; startDate: string | null; endDate: string | null;
  contactId: string | null; customerName: string | null; customerNameAr: string | null; income: string; expense: string; profit: string; budgetUsed: number | null;
}

function BudgetBar({ used }: { used: number | null }) {
  const { t } = useI18n();
  if (used === null) return <span className="mut small">{t('proj.noBudget')}</span>;
  return (
    <div className="budget">
      <div className="bar-track"><div className={`bar-fill ${used > 100 ? 'over' : used > 85 ? 'near' : ''}`} style={{ width: `${Math.min(used, 100)}%` }} /></div>
      <span className={`small ${used > 100 ? 'bad' : 'mut'}`}>{t('proj.used', { pct: used })}</span>
    </div>
  );
}

export function ProjectList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useApi<ProjectRow[]>(`/api/companies/${books.company.id}/projects`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 260px', margin: 0 }}>{t('proj.hint')}</p>
        {books.canPost && <button className="b p" onClick={() => go('Projects', 'projects', 'new')}>{t('proj.newPlus')}</button>}
      </div>
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="card mut">{t('proj.none')}</div> : (
        <div className="grid projects">
          {list.data.map((p) => (
            <button key={p.id} className={`card tile project ${p.status !== 'active' ? 'mut' : ''}`} onClick={() => go('Projects', 'projects', p.id)}>
              <div className="actions"><b style={{ flex: 1 }}>{local(p.name, p.nameAr)}</b>{p.status !== 'active' && <span className="badge">{t('proj.closed')}</span>}</div>
              {p.customerName && <div className="small mut">{local(p.customerName, p.customerNameAr)}</div>}
              <table className="mini"><tbody>
                <tr><td>{t('reports.income')}</td><td className="num ltr">{fmt(p.income)}</td></tr>
                <tr><td>{t('proj.costs')}</td><td className="num ltr">{fmt(p.expense)}</td></tr>
                <tr className="total"><td>{t('reports.netProfit')}</td><td className={`num ltr ${toMinor(p.profit) < 0n ? 'bad' : ''}`}>{fmt(p.profit)}</td></tr>
              </tbody></table>
              <BudgetBar used={p.budgetUsed} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function ProjectPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const p = useApi<ProjectRow & { description: string | null }>(isNew ? null : `/api/projects/${id}`);
  const all = useApi<ProjectRow[]>(isNew ? null : `/api/companies/${books.company.id}/projects`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const lines = useApi<{ rows: { date: string; memo: string | null; accountCode: string; accountName: string; accountNameAr: string | null; debit: string; credit: string }[] }>(
    isNew ? null : `/api/companies/${books.company.id}/ledger/cost-centre/${id}?from=2000-01-01&to=${today()}`);
  type F = { name: string; nameAr: string; contactId: string; budget: string; startDate: string; endDate: string; status: string; description: string };
  const [f, setF] = useState<F>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (!f && (isNew || p.data)) {
    const x = p.data;
    setF({ name: x?.name ?? '', nameAr: x?.nameAr ?? '', contactId: x?.contactId ?? '', budget: x?.budget ?? '', startDate: x?.startDate ?? today(),
      endDate: x?.endDate ?? '', status: x?.status ?? 'active', description: x?.description ?? '' });
  }
  if (p.error) return <ErrorNote error={p.error} onRetry={p.reload} />;
  if (!f) return <Loading />;
  const figures = all.data?.find((x) => x.id === id);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { setMsg({ bad: t('err.projectName') }); return; }
    if (f.budget && !isAmount(f.budget)) { setMsg({ bad: t('err.amountFormat') }); return; }
    setBusy(true); setMsg({});
    try {
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/projects` : `/api/projects/${id}`, { body: { ...f, budget: f.budget ? normalise(f.budget) : null } });
      if (isNew) { go('Projects', 'projects', r.id); return; }
      setMsg({ ok: t('admin.saved') }); p.reload(); all.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  const set = (k: keyof F, v: string) => setF({ ...f, [k]: v });
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Projects', 'projects')}>{t('proj.back')}</button>
        <h2 style={{ margin: 0 }}>{isNew ? t('proj.new') : local(f.name, f.nameAr)}</h2>
      </div>
      {figures && (
        <div className="grid">
          <div className="card fig"><small>{t('reports.income')}</small><b className="ltr">{fmt(figures.income)}</b></div>
          <div className="card fig"><small>{t('proj.costs')}</small><b className="ltr">{fmt(figures.expense)}</b></div>
          <div className="card fig"><small>{t('reports.netProfit')}</small><b className={`ltr ${toMinor(figures.profit) < 0n ? 'bad' : ''}`}>{fmt(figures.profit)}</b></div>
          <div className="card fig"><small>{t('proj.budget')}</small><b className="ltr">{figures.budget ? fmt(figures.budget) : '—'}</b><BudgetBar used={figures.budgetUsed} /></div>
        </div>
      )}
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <form className="card" onSubmit={save} noValidate>
        <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('proj.name')}<input id="pj-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, nameAr: followArabic(f.name, e.target.value, f.nameAr) })} /></label>
            <label className="f">{t('ar.nameAr')}<input id="pj-name-ar" dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} /><ArabicHint english={f.name} arabic={f.nameAr} /></label>
          </div>
          <div className="row">
            <label className="f">{t('proj.customer')}
              <select id="pj-customer" value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
                <option value="">—</option>
                {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
            <label className="f">{t('proj.budgetCosts')} ({books.company.currency})<input id="pj-budget" inputMode="decimal" className="ltr" value={f.budget} onChange={(e) => set('budget', e.target.value)} placeholder="0.00" /></label>
            <label className="f">{t('proj.start')}<input id="pj-start" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
            <label className="f">{t('proj.end')}<input id="pj-end" type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></label>
          </div>
          <label className="f" style={{ marginBottom: 10 }}>{t('proj.description')}<textarea id="pj-desc" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
          {!isNew && <label className="actions" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.status === 'closed'} onChange={(e) => set('status', e.target.checked ? 'closed' : 'active')} /><span>{t('proj.closedLabel')}</span></label>}
          {books.canPost && <button className="b p" type="submit" disabled={busy}>{isNew ? t('proj.create') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {!isNew && (
        <div className="card">
          <h2>{t('proj.transactions')}</h2>
          {!lines.data ? <Loading /> : lines.data.rows.length === 0 ? <div className="mut">{t('proj.noTransactions')}</div> : (
            <div className="wrap"><table className="stack"><tbody>
              {lines.data.rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td><td>{r.memo}</td>
                  <td className="small" data-label={t('journal.account')}>{r.accountCode} {local(r.accountName, r.accountNameAr)}</td>
                  <td className="num ltr" data-label={t('debit')}>{toMinor(r.debit) ? fmt(r.debit) : ''}</td>
                  <td className="num ltr" data-label={t('credit')}>{toMinor(r.credit) ? fmt(r.credit) : ''}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </div>
      )}
    </>
  );
}

export function ProjectReport({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const list = useApi<ProjectRow[]>(`/api/companies/${books.company.id}/projects?from=${from}&to=${to}`);
  const sum = (k: 'income' | 'expense' | 'profit') => (list.data ?? []).reduce((s, x) => s + toMinor(x[k]), 0n);
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, flex: '1 1 200px' }}>{t('sub.project-report')} ({books.company.currency})</h2>
        <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? <Loading /> : (
        <div className="wrap">
          <table className="stack">
            <thead><tr><th>{t('proj.project')}</th><th className="num">{t('reports.income')}</th><th className="num">{t('proj.costs')}</th><th className="num">{t('reports.netProfit')}</th><th>{t('proj.budget')}</th></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td><button className="link" onClick={() => go('Projects', 'projects', p.id)}>{local(p.name, p.nameAr)}</button></td>
                  <td className="num ltr" data-label={t('reports.income')}>{fmt(p.income)}</td>
                  <td className="num ltr" data-label={t('proj.costs')}>{fmt(p.expense)}</td>
                  <td className={`num ltr ${toMinor(p.profit) < 0n ? 'bad' : ''}`} data-label={t('reports.netProfit')}>{fmt(p.profit)}</td>
                  <td data-label={t('proj.budget')}><BudgetBar used={p.budgetUsed} /></td>
                </tr>
              ))}
              <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(fromMinor(sum('income')))}</td><td className="num ltr">{fmt(fromMinor(sum('expense')))}</td><td className="num ltr">{fmt(fromMinor(sum('profit')))}</td><td /></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
