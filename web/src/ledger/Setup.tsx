// Ledger > Chart of accounts (add and rename ledger accounts) and Ledger > Cost centres (branches and departments;
// projects are kept apart, in Projects).
import { useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { ExportBar } from '../print/Print.tsx';
import { today } from '../router.ts';

type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
const START: Record<AccountType, string> = { asset: '1', liability: '2', equity: '3', income: '4', expense: '5-9' };
interface ChartRow { id: string; code: string; name: string; nameAr: string | null; type: AccountType; costCentreRequired: boolean; isBank: boolean; balance: string; postings: number; pnlGroup: string | null }

export function ChartOfAccounts({ books, onChanged }: { books: CompanyBooks; onChanged: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useApi<ChartRow[]>(`/api/companies/${books.company.id}/chart`);
  const ref = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; nameAr: string; type: AccountType; costCentreRequired: boolean; used: boolean; pnlGroup: string }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const open = async (type: AccountType, r?: ChartRow) => {
    setMsg({});
    if (r) { setEdit({ id: r.id, code: r.code, name: r.name, nameAr: r.nameAr ?? '', type: r.type, costCentreRequired: r.costCentreRequired, used: r.postings > 0, pnlGroup: r.pnlGroup ?? '' }); return; }
    const { code } = await api<{ code: string }>(`/api/companies/${books.company.id}/chart/next-code?type=${type}`);
    setEdit({ code, name: '', nameAr: '', type, costCentreRequired: false, used: false, pnlGroup: '' });
  };
  const codeOk = (e: NonNullable<typeof edit>) => /^[1-9]\d{3}$/.test(e.code) && (e.type === 'expense' ? '56789'.includes(e.code[0]!) : e.code[0] === START[e.type]);
  const taken = (e: NonNullable<typeof edit>) => (list.data ?? []).some((a) => a.code === e.code && a.id !== e.id);
  const save = async () => {
    if (!edit || !edit.name.trim() || !codeOk(edit) || taken(edit)) return;
    setBusy(true); setMsg({});
    try {
      await api(edit.id ? `/api/accounts/${edit.id}` : `/api/companies/${books.company.id}/accounts`, { body: { ...edit, pnlGroup: edit.pnlGroup || null } });
      setMsg({ ok: t('admin.saved') }); setEdit(undefined); list.reload(); onChanged();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const form = edit && (
        <div className="card no-print inset">
          <h3>{edit.id ? t('coa.edit') : t('coa.new', { type: t(`coa.type.${edit.type}` as Key) })}</h3>
          <div className="row">
            <label className="f">{t('coa.code')}<input id="coa-code" dir="ltr" className="num" value={edit.code} disabled={edit.used} onChange={(e) => setEdit({ ...edit, code: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
              {!codeOk(edit) && <span className="small bad">{t('coa.codeRule', { start: START[edit.type] })}</span>}
              {taken(edit) && <span className="small bad">{t('err.accountCodeTaken')}</span>}
              {edit.used && <span className="small mut">{t('coa.usedNote')}</span>}</label>
            <label className="f">{t('coa.name')}<input id="coa-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, nameAr: followArabic(edit.name, e.target.value, edit.nameAr) })} /></label>
            <label className="f">{t('ar.nameAr')}<input dir="rtl" value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} /><ArabicHint english={edit.name} arabic={edit.nameAr} /></label>
          </div>
          <div className="row">
            <label className="f">{t('coa.type')}
              <select value={edit.type} disabled={edit.used} onChange={(e) => setEdit({ ...edit, type: e.target.value as AccountType })}>
                {TYPES.map((x) => <option key={x} value={x}>{t(`coa.type.${x}` as Key)}</option>)}
              </select>
            </label>
            {(edit.type === 'income' || edit.type === 'expense') && (
              <label className="f">{t('coa.pnlLine')}
                <select id="coa-pnl" value={edit.pnlGroup} onChange={(e) => setEdit({ ...edit, pnlGroup: e.target.value })}>
                  <option value="">{t('coa.pnlAuto')}</option>
                  {(edit.type === 'income' ? ['revenue', 'other_income'] : ['cost_of_sales', 'indirect_expense']).map((g) => <option key={g} value={g}>{t(`coa.pnl.${g}` as Key)}</option>)}
                </select>
              </label>
            )}
            <label className="actions small" style={{ alignSelf: 'end', paddingBottom: 10 }}>
              <input type="checkbox" checked={edit.costCentreRequired} onChange={(e) => setEdit({ ...edit, costCentreRequired: e.target.checked })} />{t('coa.ccRequired')}
            </label>
          </div>
          <div className="actions">
            <button id="coa-save" className="b p" disabled={busy || !edit.name.trim() || !codeOk(edit) || taken(edit)} onClick={() => void save()}>{edit.id ? t('admin.saveDetails') : t('coa.add')}</button>
            <button className="b" onClick={() => setEdit(undefined)}>{t('cancel')}</button>
          </div>
        </div>
  );
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 300px', margin: 0 }}>{t('coa.hint')}</p>
        <ExportBar books={books} title={t('sub.chart-of-accounts')} period={today()} target={ref} />
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {books.canPost && <div className="actions no-print" style={{ marginBottom: 8 }}><span className="spacer" />
        <button className="b" onClick={() => go('Ledger', 'import-data', 'accounts')}>{t('imp.fromExcel')}</button>
        <button className="b" onClick={() => go('Ledger', 'import-data', 'opening')}>{t('imp.openingButton')}</button></div>}
      <div ref={ref}>
        {TYPES.map((type) => {
          const rows = list.data!.filter((a) => a.type === type);
          return (
            <div key={type} className="card">
              <div className="actions" style={{ marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>{t(`coa.types.${type}` as Key)}</h3>
                <span className="spacer" />
                {books.canPost && <button className="b small no-print" onClick={() => void open(type)}>{t('coa.addPlus')}</button>}
              </div>
              {edit?.type === type && form}
              <div className="wrap"><table className="stack coa">
                <thead><tr><th>{t('coa.code')}</th><th>{t('coa.name')}</th><th className="num">{t('led.balance')}</th><th className="no-print" /></tr></thead>
                <tbody>{rows.map((a) => (
                  <tr key={a.id}>
                    <td className="ltr">{a.code}</td>
                    <td><button className="link" onClick={() => go('Ledger', 'general-ledger', a.id)}>{local(a.name, a.nameAr)}</button>
                      {a.costCentreRequired && <span className="badge" style={{ marginInlineStart: 6 }}>{t('coa.ccBadge')}</span>}
                      {a.isBank && <span className="badge" style={{ marginInlineStart: 6 }}>{t('coa.bankBadge')}</span>}
                      {a.pnlGroup && <div className="small mut">{t(`coa.pnl.${a.pnlGroup}` as Key)}</div>}</td>
                    <td className="num ltr" data-label={t('led.balance')}>{toMinor(a.balance) === 0n ? '—' : fmt(a.balance)}</td>
                    <td className="no-print">{books.canPost && <button className="link small" onClick={() => void open(type, a)}>{t('coa.editLink')}</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          );
        })}
      </div>
    </>
  );
}

interface CcRow { id: string; name: string; nameAr: string | null; kind: string; status: string; parentId: string | null; parentName: string | null; parentNameAr: string | null; postings: number }

export function CostCentres({ books, onChanged }: { books: CompanyBooks; onChanged: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useApi<CcRow[]>(`/api/companies/${books.company.id}/cost-centres`);
  const [edit, setEdit] = useState<{ id?: string; name: string; nameAr: string; kind: string; parentId: string; status: string }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const centres = list.data.filter((c) => c.kind !== 'project');
  const projects = list.data.filter((c) => c.kind === 'project');
  const taken = edit && list.data.some((c) => c.id !== edit.id && c.name.trim().toLowerCase() === edit.name.trim().toLowerCase());
  const save = async () => {
    if (!edit || !edit.name.trim() || taken) return;
    setBusy(true); setMsg({});
    try {
      await api(edit.id ? `/api/cost-centres/${edit.id}` : `/api/companies/${books.company.id}/cost-centres`, { body: { ...edit, parentId: edit.parentId || null } });
      setMsg({ ok: t('admin.saved') }); setEdit(undefined); list.reload(); onChanged();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 300px', margin: 0 }}>{t('cc.hint')}</p>
        {books.canPost && <button className="b p" onClick={() => setEdit({ name: '', nameAr: '', kind: 'branch', parentId: '', status: 'active' })}>{t('cc.addPlus')}</button>}
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {edit && (
        <div className="card">
          <h3>{edit.id ? t('cc.edit') : t('cc.new')}</h3>
          <div className="row">
            <label className="f">{t('cc.name')}<input id="cc-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, nameAr: followArabic(edit.name, e.target.value, edit.nameAr) })} />
              {taken && <span className="small bad">{t('err.costCentreTaken')}</span>}</label>
            <label className="f">{t('ar.nameAr')}<input dir="rtl" value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} /><ArabicHint english={edit.name} arabic={edit.nameAr} /></label>
          </div>
          <div className="row">
            <label className="f">{t('cc.kind')}
              <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                <option value="branch">{t('cc.kind.branch')}</option><option value="department">{t('cc.kind.department')}</option>
              </select>
            </label>
            <label className="f">{t('cc.parent')}
              <select value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })}>
                <option value="">—</option>
                {centres.filter((c) => c.id !== edit.id).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
          </div>
          {edit.id && <label className="actions small" style={{ marginBottom: 10 }}><input type="checkbox" checked={edit.status === 'closed'} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? 'closed' : 'active' })} />{t('cc.closed')}</label>}
          <div className="actions">
            <button id="cc-save" className="b p" disabled={busy || !edit.name.trim() || Boolean(taken)} onClick={() => void save()}>{edit.id ? t('admin.saveDetails') : t('cc.add')}</button>
            <button className="b" onClick={() => setEdit(undefined)}>{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="card">
        <div className="wrap"><table className="stack">
          <thead><tr><th>{t('cc.name')}</th><th>{t('cc.kind')}</th><th>{t('cc.parent')}</th><th className="num">{t('cc.postings')}</th><th /></tr></thead>
          <tbody>{centres.map((c) => (
            <tr key={c.id} className={c.status === 'closed' ? 'mut' : ''}>
              <td><button className="link" onClick={() => go('Ledger', 'cost-centre-ledger', c.id)}>{local(c.name, c.nameAr)}</button></td>
              <td data-label={t('cc.kind')}>{t(`cc.kind.${c.kind}` as Key)}</td>
              <td data-label={t('cc.parent')}>{c.parentName ? local(c.parentName, c.parentNameAr) : '—'}</td>
              <td className="num" data-label={t('cc.postings')}>{c.postings}</td>
              <td>{books.canPost && <button className="link small" onClick={() => setEdit({ id: c.id, name: c.name, nameAr: c.nameAr ?? '', kind: c.kind, parentId: c.parentId ?? '', status: c.status ?? 'active' })}>{t('coa.editLink')}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      {projects.length > 0 && (
        <p className="mut small">{t('cc.projectsApart', { n: projects.length })} {books.company.modules?.includes('Projects') && <button className="link small" onClick={() => go('Projects', 'projects')}>{t('cc.openProjects')}</button>}</p>
      )}
    </>
  );
}
