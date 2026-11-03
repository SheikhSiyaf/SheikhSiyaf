// HRM > Employees: everyone on the payroll; their HR details, documents and final settlement are on their page.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { HrDetails } from './HrDetails.tsx';
import type { HrEmp } from './Hrm.tsx';

type Emp = Contact & { isEmployee: boolean; employeeNo: string | null; jobTitle: string | null; defaultCostCentreId: string | null };

export function EmployeeList({ books }: { books: CompanyBooks }) {
  const { t, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<Emp[]>(`/api/companies/${books.company.id}/contacts?role=employee&q=${encodeURIComponent(q)}`);
  const hr = useApi<HrEmp[]>(`/api/companies/${books.company.id}/hr/employees`);
  const hrOf = (id: string) => hr.data?.find((x) => x.id === id);
  const country = (c: string | null) => (c ? new Intl.DisplayNames([lang], { type: 'region' }).of(c) : '—');
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('emp.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go('HRM', 'employees', 'new')}>{t('emp.newPlus')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('emp.none')}</div> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('col.name')}</th><th>{t('emp.no')}</th><th>{t('emp.jobTitle')}</th><th>{t('hr.nationality')}</th><th>{t('hr.joinDate')}</th><th className="num">{t('hr.monthlyWage')}</th><th className="num">{t('emp.owed')}</th></tr></thead>
              <tbody>
                {list.data.map((e) => (
                  <tr key={e.id} className={e.status !== 'active' ? 'mut' : ''}>
                    <td><button className="link" onClick={() => go('HRM', 'employees', e.id)}>{local(e.name, e.nameAr)}</button></td>
                    <td className="ltr small" data-label={t('emp.no')}>{e.employeeNo ?? '—'}</td>
                    <td className="small" data-label={t('emp.jobTitle')}>{e.jobTitle ?? '—'}</td>
                    <td className="small" data-label={t('hr.nationality')}>{hrOf(e.id)?.hasProfile ? country(hrOf(e.id)!.nationality) : <span className="badge warn">{t('hr.noDetails')}</span>}</td>
                    <td className="small ltr" data-label={t('hr.joinDate')}>{hrOf(e.id)?.joinDate ?? '—'}{hrOf(e.id)?.settled && <span className="badge"> {t('hr.left')}</span>}</td>
                    <td className="num ltr" data-label={t('hr.monthlyWage')}>{hrOf(e.id)?.hasProfile ? fmt(hrOf(e.id)!.wage) : '—'}</td>
                    <td className="num ltr" data-label={t('emp.owed')}>
                      {toMinor(e.balanceDue ?? '0') > 0n ? <button className="link" onClick={() => go('Ledger', 'employee-ledger', e.id)}>{fmt(e.balanceDue)}</button> : fmt(e.balanceDue ?? '0')}
                    </td>
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

export function EmployeePage({ books, id, extra }: { books: CompanyBooks; id: string; extra?: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const e = useApi<Emp>(isNew ? null : `/api/contacts/${id}`);
  const [f, setF] = useState<Record<string, string>>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (!f && (isNew || e.data)) {
    const x = e.data;
    setF({ name: x?.name ?? '', nameAr: x?.nameAr ?? '', employeeNo: x?.employeeNo ?? '', jobTitle: x?.jobTitle ?? '', email: x?.email ?? '', phone: x?.phone ?? '',
      defaultCostCentreId: x?.defaultCostCentreId ?? '', status: x?.status ?? 'active' });
  }
  if (e.error) return <ErrorNote error={e.error} onRetry={e.reload} />;
  if (!f) return <Loading />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!f.name!.trim()) { setMsg({ bad: t('err.contactName') }); return; }
    setBusy(true); setMsg({});
    try {
      const body = { ...f, isEmployee: true, defaultCostCentreId: f.defaultCostCentreId || null };
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/contacts` : `/api/contacts/${id}`, { body });
      if (isNew) { go('HRM', 'employees', r.id); return; }
      setMsg({ ok: t('admin.saved') }); e.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('HRM', 'employees')}>{t('emp.back')}</button>
        <span className="spacer" />
        {!isNew && books.canPost && <button className="b" onClick={() => go('Expenses', 'claims', 'new', id)}>{t('claim.new')}</button>}
        {!isNew && <button className="b" onClick={() => go('Ledger', 'employee-ledger', id)}>{t('emp.ledger')}</button>}
        {!isNew && books.canPost && extra !== 'settlement' && <button className="b" id="em-settle" onClick={() => go('HRM', 'employees', id, 'settlement')}>{t('hr.finalSettlement')}</button>}
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('emp.new') : local(f.name!, f.nameAr!)}</h2>
        <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('contact.name')}<input id="em-name" value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value, nameAr: followArabic(f.name!, ev.target.value, f.nameAr!) })} /></label>
            <label className="f">{t('ar.nameAr')}<input id="em-name-ar" dir="rtl" value={f.nameAr} onChange={(ev) => set('nameAr', ev.target.value)} /><ArabicHint english={f.name!} arabic={f.nameAr!} /></label>
          </div>
          <div className="row">
            <label className="f">{t('emp.no')}<input id="em-no" dir="ltr" value={f.employeeNo} onChange={(ev) => set('employeeNo', ev.target.value)} /></label>
            <label className="f">{t('emp.jobTitle')}<input id="em-job" value={f.jobTitle} onChange={(ev) => set('jobTitle', ev.target.value)} /></label>
            <label className="f">{t('emp.costCentre')}
              <select id="em-cc" value={f.defaultCostCentreId} onChange={(ev) => set('defaultCostCentreId', ev.target.value)}>
                <option value="">—</option>
                {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="f">{t('reg.email')}<input id="em-email" type="email" dir="ltr" value={f.email} onChange={(ev) => set('email', ev.target.value)} /></label>
            <label className="f">{t('contact.phone')}<input id="em-phone" type="tel" dir="ltr" value={f.phone} onChange={(ev) => set('phone', ev.target.value)} /></label>
          </div>
          {!isNew && <label className="actions" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.status === 'archived'} onChange={(ev) => set('status', ev.target.checked ? 'archived' : 'active')} /><span>{t('emp.left')}</span></label>}
          {books.canPost && <button className="b p" type="submit" disabled={busy}>{isNew ? t('contact.create') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {!isNew && <HrDetails books={books} id={id} settling={extra === 'settlement'} />}
    </>
  );
}
