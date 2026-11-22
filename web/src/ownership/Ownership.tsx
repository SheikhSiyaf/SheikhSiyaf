// Ownership: who owns the company and how much, capital put in, drawings and dividends taken out, the partners' profit
// split, and the statement of changes in equity. What is shown follows the company's legal form: a sole establishment
// has one owner and drawings, a partnership has partners with percentages, drawings and a profit split, and a company
// with shares has shareholders, shares and dividends. Percentages and shares are text, never numbers with decimals.
import { useEffect, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, isAmount } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { bankAccounts } from '../sales/common.tsx';
import { accessTo } from '../../../src/books/modules.ts';

type Kind = 'sole' | 'partnership' | 'shares';
interface OwnerRow { id: string; name: string; nameAr: string | null; idNumber: string | null; isActive: boolean; shares: string | null; percent: string; since: string | null;
  capital: string; current: string; dividendsPayable: string }
interface Overview { kind: Kind; legalForm: string; asOf: string; owners: OwnerRow[]; totalPercent: string; totalShares: string }
interface Movement { id: string; ownerId: string; ownerName: string; ownerNameAr: string | null; kind: string; date: string; amount: string; memo: string | null; reversesId: string | null; reversed: boolean }
interface Statement { from: string; to: string; owners: { ownerId: string; name: string; nameAr: string | null; opening: string; contributions: string; profit: string; drawings: string; dividends: string; closing: string }[];
  totals: { opening: string; contributions: string; profit: string; drawings: string; dividends: string; closing: string } }

/** 60.0000 shows as 60 and 33.3333 stays 33.3333: trailing zeros are noise on screen (the stored value is exact). */
const trim = (v: string | null) => (v === null ? '' : v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const isoToday = () => new Date().toISOString().slice(0, 10);
const isPercentText = (s: string) => /^\d{1,3}(\.\d{1,4})?$/.test(s.trim()) && Number(s) <= 100;
const isSharesText = (s: string) => /^\d+(\.\d{1,4})?$/.test(s.replace(/,/g, '').trim());

function useRun() {
  const { t, has } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); setMsg({ ok }); after?.(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const note = (<>{msg.ok && <div className="notice" role="status" id="own-msg">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</>);
  return { busy, run, note };
}

export function Ownership({ books, sub }: { books: CompanyBooks; sub?: string }) {
  const canEdit = books.canPost && accessTo(books.access?.permissions, 'Ownership') === 'edit';
  if (sub === 'owner-movements') return <Movements books={books} canEdit={canEdit} />;
  if (sub === 'equity-statement') return <EquityStatement books={books} />;
  return <Owners books={books} canEdit={canEdit} />;
}

function Owners({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const ov = useApi<Overview>(`/api/companies/${books.company.id}/ownership`);
  const { busy, run, note } = useRun();
  const [add, setAdd] = useState({ name: '', nameAr: '', idNumber: '' });
  const [from, setFrom] = useState(isoToday());
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState(false);
  if (ov.error) return <ErrorNote error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const d = ov.data;
  const useShares = d.kind === 'shares';
  const startChange = () => { setEdit(Object.fromEntries(d.owners.map((o) => [o.id, useShares ? trim(o.shares) : trim(o.percent)]))); setFrom(isoToday()); setChanging(true); };
  const editOk = d.owners.length > 0 && d.owners.every((o) => (useShares ? isSharesText(edit[o.id] ?? '') : isPercentText(edit[o.id] ?? '')));
  return (
    <>
      <p className="mut small">{t(`ownr.hint.${d.kind}` as Key)}</p>
      {note}
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('ownr.owners')}</h2><span className="spacer" />
          {canEdit && !changing && d.owners.length > 0 && <button className="b small" id="own-change" onClick={startChange}>{t('ownr.changeHoldings')}</button>}
          {canEdit && !adding && <button className="b small p" id="own-add" onClick={() => setAdding(true)}>{t('ownr.addOwner')}</button>}</div>
        {d.owners.length === 0 ? <p className="mut">{t('ownr.none')}</p> : (
          <div className="wrap"><table className="stack" id="own-table">
            <thead><tr><th>{t('ownr.name')}</th>{d.kind !== 'sole' && useShares && <th className="num">{t('ownr.shares')}</th>}<th className="num">{t('ownr.percent')}</th>
              <th className="num">{t('ownr.capital')}</th>{!useShares && <th className="num">{t('ownr.current')}</th>}{useShares && <th className="num">{t('ownr.payable')}</th>}<th /></tr></thead>
            <tbody>{d.owners.map((o) => (
              <tr key={o.id}>
                <td data-label={t('ownr.name')}>{local(o.name, o.nameAr)}{!o.isActive && <span className="badge"> {t('ownr.inactive')}</span>}{o.idNumber && <div className="small mut ltr">{o.idNumber}</div>}</td>
                {d.kind !== 'sole' && useShares && <td className="num ltr" data-label={t('ownr.shares')}>{o.shares === null ? '—' : trim(o.shares)}</td>}
                <td className="num ltr" data-label={t('ownr.percent')}>{trim(o.percent)}%</td>
                <td className="num ltr" data-label={t('ownr.capital')}>{fmt(o.capital)}</td>
                {!useShares && <td className="num ltr" data-label={t('ownr.current')}>{fmt(o.current)}</td>}
                {useShares && <td className="num ltr" data-label={t('ownr.payable')}>{fmt(o.dividendsPayable)}</td>}
                <td className="num">{canEdit && o.isActive && <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/owners/${o.id}`, { body: { name: o.name, nameAr: o.nameAr, idNumber: o.idNumber, isActive: false } }), t('ownr.deactivated'), ov.reload)}>{t('ownr.deactivate')}</button>}
                  {canEdit && !o.isActive && <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/owners/${o.id}`, { body: { name: o.name, nameAr: o.nameAr, idNumber: o.idNumber, isActive: true } }), t('ownr.activated'), ov.reload)}>{t('ownr.activate')}</button>}</td>
              </tr>))}</tbody>
            <tfoot><tr><th>{t('ownr.total')}</th>{d.kind !== 'sole' && useShares && <th className="num ltr">{trim(d.totalShares)}</th>}<th className={`num ltr ${d.totalPercent === '100.0000' ? '' : 'bad'}`}>{trim(d.totalPercent)}%</th><th colSpan={3} /></tr></tfoot>
          </table></div>)}
        <div className="small mut">{t('ownr.asOf', { date: d.asOf })}</div>
      </div>

      {adding && canEdit && (
        <form className="card" id="own-add-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/owners`, { body: add }), t('ownr.added'), () => { setAdd({ name: '', nameAr: '', idNumber: '' }); setAdding(false); ov.reload(); }); }}>
          <h3>{t('ownr.addOwner')}</h3>
          <div className="row">
            <label className="f">{t('ownr.name')}<input id="own-name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
            <label className="f">{t('ownr.nameAr')}<input id="own-name-ar" dir="rtl" value={add.nameAr} onChange={(e) => setAdd({ ...add, nameAr: e.target.value })} /></label>
            <label className="f">{t('ownr.idNumber')}<input id="own-id" className="ltr" value={add.idNumber} onChange={(e) => setAdd({ ...add, idNumber: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="own-add-save" disabled={busy || !add.name.trim()}>{t('save')}</button><button type="button" className="b" onClick={() => setAdding(false)}>{t('cancel')}</button></div>
        </form>)}

      {changing && canEdit && (
        <form className="card" id="own-change-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/ownership/holdings`, { body: { effectiveFrom: from,
            holdings: d.owners.map((o) => (useShares ? { ownerId: o.id, shares: edit[o.id] } : { ownerId: o.id, percent: edit[o.id] })) } }), t('ownr.holdingsSaved'), () => { setChanging(false); ov.reload(); }); }}>
          <h3>{t('ownr.changeHoldings')}</h3>
          <p className="small mut">{t(useShares ? 'ownr.changeHintShares' : 'ownr.changeHintPercent')}</p>
          <label className="f">{t('ownr.effectiveFrom')}<input id="own-from" type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <div className="wrap"><table className="stack"><thead><tr><th>{t('ownr.name')}</th><th className="num">{t(useShares ? 'ownr.shares' : 'ownr.percent')}</th></tr></thead>
            <tbody>{d.owners.map((o) => (
              <tr key={o.id}><td data-label={t('ownr.name')}>{local(o.name, o.nameAr)}</td>
                <td className="num" data-label={t(useShares ? 'ownr.shares' : 'ownr.percent')}><input className="num" inputMode="decimal" aria-label={local(o.name, o.nameAr)} value={edit[o.id] ?? ''} onChange={(e) => setEdit({ ...edit, [o.id]: e.target.value })} /></td></tr>))}</tbody></table></div>
          <div className="actions"><button className="b p" id="own-change-save" disabled={busy || !editOk || !from}>{t('save')}</button><button type="button" className="b" onClick={() => setChanging(false)}>{t('cancel')}</button></div>
        </form>)}
    </>
  );
}

function Movements({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const ov = useApi<Overview>(`/api/companies/${books.company.id}/ownership`);
  const mv = useApi<Movement[]>(`/api/companies/${books.company.id}/ownership/movements`);
  const { busy, run, note } = useRun();
  const banks = bankAccounts(books);
  const [f, setF] = useState({ kind: 'contribution', ownerId: '', date: isoToday(), amount: '', accountId: banks[0]?.id ?? '', memo: '' });
  const [sp, setSp] = useState({ date: isoToday(), amount: '', memo: '', from: `${isoToday().slice(0, 4)}-01-01`, to: isoToday() });
  const [why, setWhy] = useState<{ id: string; memo: string }>();
  useEffect(() => { if (!f.ownerId && ov.data?.owners[0]) setF((x) => ({ ...x, ownerId: ov.data!.owners.find((o) => o.isActive)?.id ?? '' })); }, [ov.data, f.ownerId]);
  if (ov.error) return <ErrorNote error={ov.error} onRetry={ov.reload} />;
  if (!ov.data || !mv.data) return <Loading />;
  const d = ov.data;
  const kinds = d.kind === 'shares' ? ['contribution', 'dividend_paid'] : ['contribution', 'drawing'];
  const after = () => { ov.reload(); mv.reload(); };
  const suggest = async () => { try { const r = await api<{ netProfit: string }>(`/api/companies/${books.company.id}/ownership/profit-suggestion?from=${sp.from}&to=${sp.to}`); setSp((x) => ({ ...x, amount: r.netProfit.startsWith('-') ? '' : r.netProfit })); } catch { /* the amount can be typed */ } };
  return (
    <>
      {note}
      {d.owners.length === 0 && <div className="notice">{t('ownr.needOwners')}</div>}
      {canEdit && d.owners.length > 0 && (
        <form className="card" id="own-move-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/ownership/movements`, { body: { ...f, amount: f.amount } }), t('ownr.moveSaved'), () => { setF({ ...f, amount: '', memo: '' }); after(); }); }}>
          <h3>{t('ownr.newMovement')}</h3>
          <div className="row">
            <label className="f">{t('ownr.type')}<select id="own-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{t(`ownr.k.${k}` as Key)}</option>)}</select></label>
            <label className="f">{t('ownr.owner')}<select id="own-owner" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>{d.owners.filter((o) => o.isActive || f.kind === 'dividend_paid').map((o) => <option key={o.id} value={o.id}>{local(o.name, o.nameAr)}</option>)}</select></label>
            <label className="f">{t('ownr.date')}<input id="own-date" type="date" className="ltr" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
            <label className="f">{t('ownr.amount')}<input id="own-amount" inputMode="decimal" className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
            <label className="f">{t('ownr.bank')}<select id="own-bank" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {local(a.name, a.nameAr)}</option>)}</select></label>
          </div>
          <label className="f">{t('ownr.memo')}<input id="own-memo" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></label>
          <div className="actions"><button className="b p" id="own-move-save" disabled={busy || !f.ownerId || !f.accountId || !isAmount(f.amount) || Number(f.amount) <= 0}>{t('ownr.record')}</button></div>
        </form>)}

      {canEdit && d.owners.length > 0 && d.kind !== 'shares' && (
        <form className="card" id="own-split-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/ownership/profit-split`, { body: { date: sp.date, amount: sp.amount, memo: sp.memo } }), t('ownr.splitSaved'), () => { setSp({ ...sp, amount: '', memo: '' }); after(); }); }}>
          <h3>{t('ownr.splitTitle')}</h3><p className="small mut">{t('ownr.splitHint')}</p>
          <div className="row">
            <label className="f">{t('ownr.periodFrom')}<input type="date" className="ltr" value={sp.from} onChange={(e) => setSp({ ...sp, from: e.target.value })} /></label>
            <label className="f">{t('ownr.periodTo')}<input type="date" className="ltr" value={sp.to} onChange={(e) => setSp({ ...sp, to: e.target.value })} /></label>
            <button type="button" className="b small" onClick={() => void suggest()}>{t('ownr.suggest')}</button>
          </div>
          <div className="row">
            <label className="f">{t('ownr.date')}<input id="split-date" type="date" className="ltr" value={sp.date} onChange={(e) => setSp({ ...sp, date: e.target.value })} /></label>
            <label className="f">{t('ownr.profitToShare')}<input id="split-amount" inputMode="decimal" className="num" value={sp.amount} onChange={(e) => setSp({ ...sp, amount: e.target.value })} /></label>
            <label className="f">{t('ownr.memo')}<input value={sp.memo} onChange={(e) => setSp({ ...sp, memo: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="split-save" disabled={busy || !isAmount(sp.amount) || Number(sp.amount) <= 0 || d.totalPercent !== '100.0000'}>{t('ownr.shareProfit')}</button></div>
        </form>)}

      {canEdit && d.owners.length > 0 && d.kind === 'shares' && (
        <form className="card" id="own-div-form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/ownership/dividends`, { body: { date: sp.date, amount: sp.amount, memo: sp.memo } }), t('ownr.divSaved'), () => { setSp({ ...sp, amount: '', memo: '' }); after(); }); }}>
          <h3>{t('ownr.divTitle')}</h3><p className="small mut">{t('ownr.divHint')}</p>
          <div className="row">
            <label className="f">{t('ownr.date')}<input id="div-date" type="date" className="ltr" value={sp.date} onChange={(e) => setSp({ ...sp, date: e.target.value })} /></label>
            <label className="f">{t('ownr.divAmount')}<input id="div-amount" inputMode="decimal" className="num" value={sp.amount} onChange={(e) => setSp({ ...sp, amount: e.target.value })} /></label>
            <label className="f">{t('ownr.memo')}<input value={sp.memo} onChange={(e) => setSp({ ...sp, memo: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="div-save" disabled={busy || !isAmount(sp.amount) || Number(sp.amount) <= 0 || d.totalPercent !== '100.0000'}>{t('ownr.declare')}</button></div>
        </form>)}

      <div className="card">
        <h3>{t('ownr.history')}</h3>
        {mv.data.length === 0 ? <p className="mut">{t('ownr.noMovements')}</p> : (
          <div className="wrap"><table className="stack" id="own-history"><thead><tr><th>{t('ownr.date')}</th><th>{t('ownr.owner')}</th><th>{t('ownr.type')}</th><th className="num">{t('ownr.amount')}</th><th>{t('ownr.memo')}</th><th /></tr></thead>
            <tbody>{mv.data.map((m) => (
              <tr key={m.id} className={m.reversesId || m.reversed ? 'mut' : ''}>
                <td className="ltr" data-label={t('ownr.date')}>{m.date}</td><td data-label={t('ownr.owner')}>{local(m.ownerName, m.ownerNameAr)}</td>
                <td data-label={t('ownr.type')}>{t(`ownr.k.${m.kind}` as Key)}{m.reversesId && <span className="badge"> {t('ownr.reversal')}</span>}{m.reversed && <span className="badge"> {t('ownr.reversed')}</span>}</td>
                <td className="num ltr" data-label={t('ownr.amount')}>{m.reversesId ? '−' : ''}{fmt(m.amount)}</td><td className="small" data-label={t('ownr.memo')}>{m.memo ?? ''}</td>
                <td className="num">{canEdit && !m.reversesId && !m.reversed && (why?.id === m.id ? <span className="actions" style={{ justifyContent: 'flex-end' }}>
                  <input aria-label={t('ownr.reverseWhy')} placeholder={t('ownr.reverseWhy')} value={why.memo} onChange={(e) => setWhy({ id: m.id, memo: e.target.value })} />
                  <button className="b small" disabled={busy || !why.memo.trim()} onClick={() => void run(() => api(`/api/ownership-movements/${m.id}/reverse`, { body: { memo: why.memo } }), t('ownr.reverseDone'), () => { setWhy(undefined); after(); })}>{t('ownr.reverse')}</button>
                  <button className="b small" onClick={() => setWhy(undefined)}>{t('cancel')}</button></span>
                  : <button className="b small" onClick={() => setWhy({ id: m.id, memo: '' })}>{t('ownr.reverse')}</button>)}</td>
              </tr>))}</tbody></table></div>)}
      </div>
    </>
  );
}

function EquityStatement({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const y = isoToday().slice(0, 4);
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(isoToday());
  const st = useApi<Statement>(`/api/companies/${books.company.id}/ownership/equity-statement?from=${from}&to=${to}`);
  return (
    <>
      <p className="mut small">{t('ownr.stmtHint')}</p>
      <div className="row">
        <label className="f">{t('ownr.periodFrom')}<input id="stmt-from" type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">{t('ownr.periodTo')}<input id="stmt-to" type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {st.error ? <ErrorNote error={st.error} onRetry={st.reload} /> : !st.data ? <Loading /> : st.data.owners.length === 0 ? <p className="mut">{t('ownr.none')}</p> : (
        <div className="card wrap"><table className="stack" id="own-statement">
          <thead><tr><th>{t('ownr.owner')}</th><th className="num">{t('ownr.opening')}</th><th className="num">{t('ownr.contributions')}</th><th className="num">{t('ownr.profitShare')}</th>
            <th className="num">{t('ownr.k.drawing')}</th><th className="num">{t('ownr.dividendsDeclared')}</th><th className="num">{t('ownr.closing')}</th></tr></thead>
          <tbody>{st.data.owners.map((o) => (
            <tr key={o.ownerId}><td data-label={t('ownr.owner')}>{local(o.name, o.nameAr)}</td>
              <td className="num ltr" data-label={t('ownr.opening')}>{fmt(o.opening)}</td><td className="num ltr" data-label={t('ownr.contributions')}>{fmt(o.contributions)}</td><td className="num ltr" data-label={t('ownr.profitShare')}>{fmt(o.profit)}</td>
              <td className="num ltr" data-label={t('ownr.k.drawing')}>{fmt(o.drawings)}</td><td className="num ltr" data-label={t('ownr.dividendsDeclared')}>{fmt(o.dividends)}</td><td className="num ltr" data-label={t('ownr.closing')}><b>{fmt(o.closing)}</b></td></tr>))}</tbody>
          <tfoot><tr><th>{t('ownr.total')}</th>{(['opening', 'contributions', 'profit', 'drawings', 'dividends', 'closing'] as const).map((k) => <th key={k} className="num ltr">{fmt(st.data!.totals[k])}</th>)}</tr></tfoot>
        </table></div>)}
    </>
  );
}
