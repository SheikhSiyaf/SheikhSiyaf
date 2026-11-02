// Fixed asset register: assets with cost, depreciation and book value; monthly straight-line depreciation runs;
// disposal (sale or scrapping) with its gain or loss. Every amount is worked out by the system, never typed.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { bankAccounts, useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { isLocked } from '../books/Workspace.tsx';
import { disposalResult, monthEnd, previousMonthEnd } from '../../../src/books/assets.ts';

export interface Asset {
  id: string; number: string; name: string; nameAr: string | null; assetAccountId: string; assetAccountCode: string; assetAccountName: string; assetAccountNameAr: string | null;
  expenseAccountId: string; costCentreId: string | null; costCentre: string | null; costCentreAr: string | null; contactId: string | null; supplierName: string | null;
  purchaseDate: string; depreciationStart: string; cost: string; residualValue: string; usefulLifeMonths: number; openingDepreciation: string;
  serialNo: string | null; location: string | null; reference: string | null; notes: string | null; status: 'active' | 'disposed'; disposedOn: string | null;
  disposalProceeds: string | null; accumulated: string; bookValue: string;
}
interface Summary {
  cost: string; accumulated: string; bookValue: string; accumulatedInBooks: string;
  accounts: { accountId: string; code: string; name: string; nameAr: string | null; cost: string; books: string }[]; nextRun: { periodEnd: string; first: boolean };
}

const fixedAssetAccounts = (b: CompanyBooks) => b.accounts.filter((a) => a.type === 'asset' && !a.isBank && !['1100', '1200', '1300', '1590'].includes(a.code));
const monthLabel = (end: string, lang: string) =>
  new Date(`${end}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ------------------------------------------------------------------ register
export function AssetRegister({ books }: { books: CompanyBooks }) {
  const { t, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<Asset[]>(`/api/companies/${books.company.id}/assets?q=${encodeURIComponent(q)}`);
  const sum = useApi<Summary>(`/api/companies/${books.company.id}/asset-summary`);
  return (
    <>
      {sum.data && (
        <div className="grid" style={{ marginBottom: 12 }}>
          <div className="card fig"><small>{t('fa.cost')}</small><b className="ltr">{fmt(sum.data.cost)}</b></div>
          <div className="card fig"><small>{t('fa.accumulated')}</small><b className="ltr">{fmt(sum.data.accumulated)}</b></div>
          <div className="card fig"><small>{t('fa.bookValue')}</small><b className="ltr">{fmt(sum.data.bookValue)}</b></div>
          <button className="card fig tile" onClick={() => go('Assets', 'depreciation')}><small>{t('fa.nextRun')}</small><b>{monthLabel(sum.data.nextRun.periodEnd, lang)}</b></button>
        </div>
      )}
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('fa.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go('Assets', 'register', 'new')}>{t('fa.newPlus')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('fa.none')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('doc.number')}</th><th>{t('fa.asset')}</th><th>{t('fa.bought')}</th><th className="num">{t('fa.cost')}</th><th className="num">{t('fa.accumulated')}</th><th className="num">{t('fa.bookValue')}</th></tr></thead>
            <tbody>{list.data.map((a) => (
              <tr key={a.id} className={a.status === 'disposed' ? 'mut' : ''}>
                <td className="ltr small">{a.number}</td>
                <td><button className="link" onClick={() => go('Assets', 'register', a.id)}>{local(a.name, a.nameAr)}</button>
                  <div className="small mut">{a.assetAccountCode} {local(a.assetAccountName, a.assetAccountNameAr)}{a.status === 'disposed' && <> · <span className="badge">{t('fa.disposed')}</span></>}</div></td>
                <td className="ltr" data-label={t('fa.bought')}>{a.purchaseDate}</td>
                <td className="num ltr" data-label={t('fa.cost')}>{fmt(a.cost)}</td>
                <td className="num ltr" data-label={t('fa.accumulated')}>{fmt(a.accumulated)}</td>
                <td className="num ltr" data-label={t('fa.bookValue')}>{fmt(a.bookValue)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {sum.data && sum.data.accounts.length > 0 && (
        <div className="card">
          <h3>{t('fa.againstBooks')}</h3>
          <table className="mini"><tbody>
            {sum.data.accounts.map((a) => (
              <tr key={a.accountId}><td>{a.code} {local(a.name, a.nameAr)}</td><td className="num ltr small mut">{t('fa.register')}: {fmt(a.cost)}</td>
                <td className={`num ltr small ${a.cost === a.books ? 'good' : 'bad'}`}>{t('fa.books')}: {fmt(a.books)}</td></tr>
            ))}
            <tr><td>1590 {t('fa.accumulated')}</td><td className="num ltr small mut">{t('fa.register')}: {fmt(sum.data.accumulated)}</td>
              <td className={`num ltr small ${sum.data.accumulated === sum.data.accumulatedInBooks ? 'good' : 'mut'}`}>{t('fa.books')}: {fmt(sum.data.accumulatedInBooks)}</td></tr>
          </tbody></table>
          <p className="small mut">{t('fa.againstBooksHint')}</p>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ one asset
export function AssetPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const a = useApi<Asset & { history: { periodEnd: string; amount: string }[] }>(isNew ? null : `/api/assets/${id}`);
  const suppliers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=supplier`);
  const accounts = fixedAssetAccounts(books);
  const expenseAccounts = books.accounts.filter((x) => x.type === 'expense');
  type F = { name: string; nameAr: string; assetAccountId: string; expenseAccountId: string; costCentreId: string; contactId: string; purchaseDate: string; startMonth: string;
    cost: string; residualValue: string; years: string; months: string; openingDepreciation: string; serialNo: string; location: string; reference: string; notes: string };
  const [f, setF] = useState<F>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (!f && (isNew || a.data)) {
    const x = a.data;
    const life = x?.usefulLifeMonths ?? 60;
    setF({ name: x?.name ?? '', nameAr: x?.nameAr ?? '', assetAccountId: x?.assetAccountId ?? accounts.find((c) => c.code === '1500')?.id ?? accounts[0]?.id ?? '',
      expenseAccountId: x?.expenseAccountId ?? expenseAccounts.find((c) => c.code === '5050')?.id ?? '', costCentreId: x?.costCentreId ?? '', contactId: x?.contactId ?? '',
      purchaseDate: x?.purchaseDate ?? today(), startMonth: (x?.depreciationStart ?? today()).slice(0, 7), cost: x?.cost ?? '', residualValue: x && toMinor(x.residualValue) ? x.residualValue : '',
      years: String(Math.floor(life / 12)), months: String(life % 12), openingDepreciation: x && toMinor(x.openingDepreciation) ? x.openingDepreciation : '',
      serialNo: x?.serialNo ?? '', location: x?.location ?? '', reference: x?.reference ?? '', notes: x?.notes ?? '' });
  }
  if (a.error) return <ErrorNote error={a.error} onRetry={a.reload} />;
  if (!f) return <Loading />;
  const set = (k: keyof F, v: string) => {
    const next = { ...f, [k]: v };
    if (k === 'purchaseDate' && v.slice(0, 7) > f.startMonth) next.startMonth = v.slice(0, 7);   // never before the purchase
    setF(next);
  };
  const x = a.data;
  const locked = Boolean(x && x.history.length > 0);    // depreciation booked: cost, life and accounts are fixed
  const disposed = x?.status === 'disposed';
  const life = Number(f.years || 0) * 12 + Number(f.months || 0);
  const money = (s: string) => (s.trim() ? (isAmount(s) ? toMinor(normalise(s)) : null) : 0n);
  const cost = money(f.cost), residual = money(f.residualValue), opening = money(f.openingDepreciation);
  const problems = [
    !f.name.trim() && 'fa.needName', (cost === null || cost <= 0n) && 'fa.needCost', residual === null || (cost !== null && residual !== null && residual >= cost) ? 'fa.needResidual' : '',
    (!Number.isInteger(life) || life < 1 || life > 1200) && 'fa.needLife', (opening === null || (cost !== null && residual !== null && opening !== null && opening > cost - residual)) && 'fa.needOpening',
    !f.assetAccountId && 'fa.needAccount', f.startMonth < f.purchaseDate.slice(0, 7) && 'fa.needStart',
  ].filter(Boolean) as string[];
  const monthly = cost !== null && residual !== null && life > 0 && cost > residual ? (cost - residual) / BigInt(life) : null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length) { setMsg({ bad: t(problems[0] as never) }); return; }
    setBusy(true); setMsg({});
    try {
      const body = { ...f, cost: normalise(f.cost), residualValue: f.residualValue.trim() ? normalise(f.residualValue) : '0', openingDepreciation: f.openingDepreciation.trim() ? normalise(f.openingDepreciation) : '0',
        usefulLifeMonths: life, depreciationStart: `${f.startMonth}-01`, costCentreId: f.costCentreId || null, contactId: f.contactId || null, expenseAccountId: f.expenseAccountId || null };
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/assets` : `/api/assets/${id}`, { body });
      if (isNew) { go('Assets', 'register', r.id); return; }
      setMsg({ ok: t('admin.saved') }); a.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Assets', 'register')}>{t('fa.back')}</button>
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {x && (
        <div className="grid" style={{ marginBottom: 12 }}>
          <div className="card fig"><small>{t('fa.cost')}</small><b className="ltr">{fmt(x.cost)}</b></div>
          <div className="card fig"><small>{t('fa.accumulated')}</small><b className="ltr">{fmt(x.accumulated)}</b></div>
          <div className="card fig"><small>{t('fa.bookValue')}</small><b className="ltr">{fmt(x.bookValue)}</b></div>
          {disposed && <div className="card fig"><small>{t('fa.disposedOn')}</small><b className="ltr">{x.disposedOn}</b></div>}
        </div>
      )}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('fa.new') : <>{local(f.name, f.nameAr)} <span className="small mut ltr">{x?.number}</span></>}</h2>
        <fieldset disabled={!books.canPost || disposed} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('fa.name')}<input id="fa-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, nameAr: followArabic(f.name, e.target.value, f.nameAr) })} /></label>
            <label className="f">{t('ar.nameAr')}<input id="fa-name-ar" dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} /><ArabicHint english={f.name} arabic={f.nameAr} /></label>
          </div>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="row">
              <label className="f">{t('fa.account')}
                <select id="fa-account" value={f.assetAccountId} onChange={(e) => set('assetAccountId', e.target.value)}>
                  {accounts.map((c) => <option key={c.id} value={c.id}>{c.code} {local(c.name, c.nameAr)}</option>)}
                </select>
              </label>
              <label className="f">{t('fa.purchaseDate')}<input id="fa-date" type="date" value={f.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} /></label>
              <label className="f">{t('fa.cost')} ({books.company.currency})<input id="fa-cost" inputMode="decimal" className="num ltr amount" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></label>
            </div>
            <div className="row">
              <label className="f">{t('fa.life')}
                <span className="actions"><input id="fa-years" inputMode="numeric" className="num ltr" style={{ width: 80 }} value={f.years} onChange={(e) => set('years', e.target.value.replace(/\D/g, ''))} aria-label={t('fa.years')} /> {t('fa.years')}
                  <input inputMode="numeric" className="num ltr" style={{ width: 70 }} value={f.months} onChange={(e) => set('months', e.target.value.replace(/\D/g, ''))} aria-label={t('fa.months')} /> {t('fa.months')}</span>
              </label>
              <label className="f">{t('fa.residual')} ({books.company.currency})<input inputMode="decimal" className="num ltr amount" value={f.residualValue} placeholder="0.00" onChange={(e) => set('residualValue', e.target.value)} /></label>
              <label className="f">{t('fa.startMonth')}<input type="month" value={f.startMonth} min={f.purchaseDate.slice(0, 7)} onChange={(e) => set('startMonth', e.target.value)} /></label>
            </div>
            <div className="row">
              <label className="f">{t('fa.expenseAccount')}
                <select value={f.expenseAccountId} onChange={(e) => set('expenseAccountId', e.target.value)}>
                  {expenseAccounts.map((c) => <option key={c.id} value={c.id}>{c.code} {local(c.name, c.nameAr)}</option>)}
                </select>
              </label>
              <label className="f">{t('fa.opening')}<input inputMode="decimal" className="num ltr amount" value={f.openingDepreciation} placeholder="0.00" onChange={(e) => set('openingDepreciation', e.target.value)} />
                <span className="small mut">{t('fa.openingHint')}</span></label>
            </div>
          </fieldset>
          {monthly !== null && <div className="notice">{t('fa.monthly', { amount: fmt(fromMinor(monthly)), months: life })}</div>}
          {locked && <p className="small mut">{t('fa.lockedNote')}</p>}
          <div className="row">
            <label className="f">{t('journal.costCentre')}
              <select value={f.costCentreId} onChange={(e) => set('costCentreId', e.target.value)}>
                <option value="">—</option>
                {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
            <label className="f">{t('contact.supplier')}
              <select value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
                <option value="">—</option>
                {(suppliers.data ?? []).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
            <label className="f">{t('fa.serial')}<input dir="ltr" value={f.serialNo} onChange={(e) => set('serialNo', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('fa.location')}<input value={f.location} onChange={(e) => set('location', e.target.value)} /></label>
            <label className="f">{t('inv.reference')}<input value={f.reference} placeholder={t('fa.refHint')} onChange={(e) => set('reference', e.target.value)} /></label>
          </div>
          <label className="f">{t('doc.notes')}<textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          {isNew && <p className="small mut">{t('fa.purchaseNote')}</p>}
          {books.canPost && !disposed && <button className="b p" type="submit" disabled={busy}>{isNew ? t('fa.add') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {x && x.history.length > 0 && (
        <div className="card">
          <h3>{t('fa.history')}</h3>
          <table className="mini"><tbody>
            {x.history.map((h) => <tr key={h.periodEnd}><td className="ltr">{h.periodEnd}</td><td className="num ltr">{fmt(h.amount)}</td></tr>)}
          </tbody></table>
        </div>
      )}
      {x && !disposed && books.canPost && <Dispose books={books} asset={x} onDone={a.reload} />}
      {x && disposed && <div className="notice">{t('fa.disposedNote', { date: x.disposedOn ?? '', amount: fmt(x.disposalProceeds ?? '0') })}</div>}
    </>
  );
}

function Dispose({ books, asset, onDone }: { books: CompanyBooks; asset: Asset; onDone: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const [open, setOpen] = useState(false);
  const banks = bankAccounts(books);
  const [f, setF] = useState({ date: today(), proceeds: '', bankAccountId: banks[0]?.id ?? '' });
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const proceeds = f.proceeds.trim() ? (isAmount(f.proceeds) ? toMinor(normalise(f.proceeds)) : null) : 0n;
  const result = proceeds === null ? null : disposalResult(toMinor(asset.cost), toMinor(asset.accumulated), proceeds);
  const locked = isLocked(books, f.date);
  if (!open) return <button className="b" onClick={() => setOpen(true)}>{t('fa.dispose')}</button>;
  const go = async () => {
    setBusy(true); setErr(undefined);
    try { await api(`/api/assets/${asset.id}/dispose`, { body: { ...f, proceeds: proceeds === null ? '' : fromMinor(proceeds) } }); onDone(); }
    catch (e) { setErr(errorText(t, has, e)); setConfirm(false); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h3>{t('fa.dispose')}</h3>
      <p className="small mut">{t('fa.disposeHint', { month: previousMonthEnd(f.date) })}</p>
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="row">
        <label className="f">{t('doc.date')}<input type="date" value={f.date} min={asset.purchaseDate} onChange={(e) => setF({ ...f, date: e.target.value })} />
          {locked && <span className="small bad">{t('err.periodLocked')}</span>}</label>
        <label className="f">{t('fa.proceeds')} ({books.company.currency})<input inputMode="decimal" className="num ltr amount" value={f.proceeds} placeholder="0.00" onChange={(e) => setF({ ...f, proceeds: e.target.value })} /></label>
        {proceeds !== null && proceeds > 0n && (
          <label className="f">{t('fa.receivedInto')}
            <select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{local(b.name, b.nameAr)}</option>)}
            </select>
          </label>
        )}
      </div>
      {result !== null && (
        <table className="totals"><tbody>
          <tr><td>{t('fa.bookValue')}</td><td className="num ltr">{fmt(asset.bookValue)}</td></tr>
          <tr><td>{t('fa.proceeds')}</td><td className="num ltr">{fmt(fromMinor(proceeds!))}</td></tr>
          <tr className="total"><td>{result >= 0n ? t('fa.gain') : t('fa.loss')}</td><td className={`num ltr ${result < 0n ? 'bad' : 'good'}`}>{fmt(fromMinor(result < 0n ? -result : result))}</td></tr>
        </tbody></table>
      )}
      <p className="small mut">{t('fa.vatNote')}</p>
      {confirm ? <ConfirmBar message={t('fa.confirmDispose')} busy={busy} onYes={go} onNo={() => setConfirm(false)} /> : (
        <div className="actions">
          <button className="b p" disabled={result === null || locked} onClick={() => setConfirm(true)}>{t('fa.disposeNow')}</button>
          <button className="b" onClick={() => setOpen(false)}>{t('cancel')}</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ depreciation runs
export function Depreciation({ books }: { books: CompanyBooks }) {
  const { t, has, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const info = useApi<{ next: { periodEnd: string; first: boolean }; runs: { id: string; periodEnd: string; total: string; assets: number; runBy: string; runAt: string }[] }>(
    `/api/companies/${books.company.id}/depreciation`);
  const [month, setMonth] = useState<string>();
  const periodEnd = month ? monthEnd(`${month}-01`) : info.data?.next.periodEnd;
  const preview = useApi<{ lines: { assetId: string; number: string; name: string; nameAr: string | null; amount: string }[]; total: string }>(
    periodEnd ? `/api/companies/${books.company.id}/depreciation/preview?periodEnd=${periodEnd}` : null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (info.error) return <ErrorNote error={info.error} onRetry={info.reload} />;
  if (!info.data || !periodEnd) return <Loading />;
  const future = periodEnd > monthEnd(today());
  const locked = isLocked(books, periodEnd);
  const run = async () => {
    setBusy(true); setMsg({});
    try {
      const r = await api<{ total: string }>(`/api/companies/${books.company.id}/depreciation/run`, { body: { periodEnd } });
      setMsg({ ok: t('fa.ran', { month: monthLabel(periodEnd, lang), amount: fmt(r.total) }) }); setMonth(undefined); setConfirm(false); info.reload(); preview.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); setConfirm(false); } finally { setBusy(false); }
  };
  return (
    <>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        <h2>{t('fa.runFor', { month: monthLabel(periodEnd, lang) })}</h2>
        {info.data.next.first ? (
          <label className="f" style={{ maxWidth: 260 }}>{t('fa.firstMonth')}<input type="month" value={periodEnd.slice(0, 7)} max={today().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
            <span className="small mut">{t('fa.firstHint')}</span></label>
        ) : <p className="small mut">{t('fa.inOrder')}</p>}
        {!preview.data ? <Loading /> : preview.data.lines.length === 0 ? <p className="mut">{t('fa.nothingDue')}</p> : (
          <table className="mini"><tbody>
            {preview.data.lines.map((l) => <tr key={l.assetId}><td className="ltr small">{l.number}</td><td><button className="link" onClick={() => go('Assets', 'register', l.assetId)}>{local(l.name, l.nameAr)}</button></td><td className="num ltr">{fmt(l.amount)}</td></tr>)}
            <tr className="total"><td /><td>{t('inv.total')}</td><td className="num ltr">{fmt(preview.data.total)}</td></tr>
          </tbody></table>
        )}
        <p className="small mut">{t('fa.entryNote')}</p>
        {future && <p className="small bad">{t('err.depFuture')}</p>}
        {locked && <p className="small bad">{t('err.periodLocked')}</p>}
        {books.canPost && (confirm ? <ConfirmBar message={t('fa.confirmRun', { month: monthLabel(periodEnd, lang), amount: fmt(preview.data?.total ?? '0') })} busy={busy} onYes={run} onNo={() => setConfirm(false)} /> : (
          <button id="dep-run" className="b p" disabled={busy || future || locked || !preview.data} onClick={() => setConfirm(true)}>{t('fa.runNow', { month: monthLabel(periodEnd, lang) })}</button>
        ))}
      </div>
      <div className="card">
        <h3>{t('fa.runs')}</h3>
        {info.data.runs.length === 0 ? <p className="mut small">{t('fa.noRuns')}</p> : (
          <table className="mini"><tbody>
            {info.data.runs.map((r) => <tr key={r.id}><td>{monthLabel(r.periodEnd, lang)}</td><td className="small mut">{t('fa.assetsN', { n: r.assets })} · {r.runBy}</td><td className="num ltr">{fmt(r.total)}</td></tr>)}
          </tbody></table>
        )}
      </div>
    </>
  );
}
