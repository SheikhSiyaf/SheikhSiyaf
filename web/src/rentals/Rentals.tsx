// Rentals: renting out equipment or anything else (cranes, vehicles, scaffolding, generators, rooms) as income.
// The board (what is out, booked, idle and not yet billed), the equipment list with rates, and rental contracts:
// items out and back, hours for items rented by the hour, and billing into the customer's invoice.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { accessTo } from '../../../src/books/modules.ts';

type Basis = 'hour' | 'day' | 'week' | 'month';
const BASES: Basis[] = ['day', 'hour', 'week', 'month'];
interface Item { id: string; code: string; name: string; nameAr: string | null; category: string | null; identifier: string | null; units: number;
  hourRate: string | null; dayRate: string | null; weekRate: string | null; monthRate: string | null; incomeAccountId: string; incomeAccountCode: string;
  fixedAssetId: string | null; fixedAssetNumber: string | null; status: 'active' | 'retired'; notes: string | null; out: number; nextBooking: string | null }
interface ContractRow { id: string; number: string; status: 'open' | 'closed' | 'cancelled'; site: string | null; reference: string | null; customer: string; customerAr: string | null;
  from: string | null; lines: number; onHire: number; items: string | null; billedTo: string | null }
interface Line { id: string; itemId: string; code: string; name: string; nameAr: string | null; identifier: string | null; units: number; basis: Basis; rate: string;
  outDate: string; returnDate: string | null; billedTo: string | null; hours: string; state: 'booked' | 'on_hire' | 'returned' }
interface Contract { id: string; number: string; status: ContractRow['status']; contactId: string; customer: string; customerAr: string | null; costCentreId: string | null;
  costCentre: string | null; site: string | null; reference: string | null; notes: string | null; lines: Line[];
  usage: { lineId: string; date: string; hours: string; note: string | null; billed: boolean }[];
  bills: { id: string; documentId: string; periodTo: string; number: string | null; status: string; total: string }[]; unbilledToday: string }
interface Board { onHire: number; booked: number; startingThisWeek: number; idle: number; items: number; utilisation: number; unbilled: string; openContracts: number;
  unbilledByContract: { id: string; amount: string }[] }

const rateOf = (i: Item, b: Basis) => ({ hour: i.hourRate, day: i.dayRate, week: i.weekRate, month: i.monthRate })[b];
function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); after?.(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return { run, busy, note: <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</> };
}

export function Rentals({ books, sub, item }: { books: CompanyBooks; sub?: string; item?: string }) {
  const canEdit = books.canPost && accessTo(books.access?.permissions, 'Rentals') === 'edit';
  if (sub === 'equipment') return <Equipment books={books} canEdit={canEdit} />;
  if (sub === 'rental-contracts') return item ? <ContractPage key={item} books={books} id={item} canEdit={canEdit} /> : <Contracts books={books} canEdit={canEdit} />;
  return <RentalBoard books={books} />;
}

// ------------------------------------------------------------------ board
function RentalBoard({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const b = useApi<Board>(`/api/companies/${books.company.id}/rentals/board`);
  const cs = useApi<ContractRow[]>(`/api/companies/${books.company.id}/rental-contracts?status=open`);
  if (b.error) return <ErrorNote error={b.error} onRetry={b.reload} />;
  if (!b.data) return <Loading />;
  const d = b.data;
  const fig = (label: string, value: string | number, sub: string, to?: () => void) => (
    <button className="card fig" onClick={to} disabled={!to} style={{ textAlign: 'start' }}><small>{label}</small><b>{value}</b><small>{sub}</small></button>);
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('rent.hint')}</div>
      <div className="grid">
        {fig(t('rent.onHire'), d.onHire, t('rent.bookedN', { n: d.booked, w: d.startingThisWeek }), () => go('Rentals', 'rental-contracts'))}
        {fig(t('rent.utilisation'), `${d.utilisation}%`, t('rent.idleN', { n: d.idle, total: d.items }), () => go('Rentals', 'equipment'))}
        {fig(t('rent.unbilled'), `${books.company.currency} ${fmt(d.unbilled)}`, t('rent.unbilledSub', { n: d.openContracts }), () => go('Rentals', 'rental-contracts'))}
      </div>
      <div className="card">
        <h2>{t('rent.toBill')}</h2>
        {!cs.data ? <Loading /> : d.unbilledByContract.length === 0 ? <div className="mut">{t('rent.nothingToBill')}</div> : (
          <div className="wrap"><table className="stack"><tbody>
            {d.unbilledByContract.map((x) => { const k = cs.data!.find((c) => c.id === x.id);
              return (<tr key={x.id}><td><button className="link" onClick={() => go('Rentals', 'rental-contracts', x.id)}>{k?.number}</button> <span className="small mut">{k?.customer}</span>
                <div className="small mut">{k?.items}</div></td><td className="num">{fmt(x.amount)}</td></tr>); })}
          </tbody></table></div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ equipment
const EMPTY: Partial<Item> & { units: number } = { code: '', name: '', nameAr: '', category: '', identifier: '', units: 1, hourRate: '', dayRate: '', weekRate: '', monthRate: '', notes: '' };
function Equipment({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const list = useApi<Item[]>(`/api/companies/${books.company.id}/rental-items`);
  const assets = useApi<{ id: string; number: string; name: string }[]>(books.company.modules?.includes('Assets') ? `/api/companies/${books.company.id}/assets` : null);
  const { run, busy, note } = useRun();
  const [f, setF] = useState<typeof EMPTY & { id?: string }>();
  const [q, setQ] = useState('');
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const income = books.accounts.filter((a) => a.type === 'income');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { id, ...body } = f!;
    void run(() => api(id ? `/api/rental-items/${id}` : `/api/companies/${books.company.id}/rental-items`, { body }), t('rent.itemSaved'), () => { setF(undefined); list.reload(); });
  };
  const set = (k: keyof typeof EMPTY, v: string | number) => setF({ ...f!, [k]: v });
  const needle = q.trim().toLowerCase();
  const rows = list.data.filter((i) => !needle || [i.code, i.name, i.nameAr, i.category, i.identifier].join(' ').toLowerCase().includes(needle));
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('rent.itemsHint')}</div>
      {note}
      <div className="actions" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('rent.find')} aria-label={t('rent.find')} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        {canEdit && !f && <button className="b p" id="rent-item-new" onClick={() => setF({ ...EMPTY })}>{t('rent.newItem')}</button>}
      </div>
      {f && (
        <form className="card inset" onSubmit={save}>
          <h2>{f.id ? f.name : t('rent.newItem')}</h2>
          <div className="row">
            <label className="f">{t('rent.code')}<input id="ri-code" dir="ltr" value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} /></label>
            <label className="f">{t('rent.name')}<input id="ri-name" value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder={t('rent.nameExample')} /></label>
            <label className="f">{t('rent.nameAr')}<input dir="rtl" value={f.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('rent.category')}<input id="ri-cat" value={f.category ?? ''} list="rent-cats" onChange={(e) => set('category', e.target.value)} placeholder={t('rent.categoryExample')} /></label>
            <datalist id="rent-cats">{[...new Set(list.data.map((i) => i.category).filter(Boolean))].map((c) => <option key={c!} value={c!} />)}</datalist>
            <label className="f">{t('rent.identifier')}<input value={f.identifier ?? ''} onChange={(e) => set('identifier', e.target.value)} placeholder={t('rent.identifierExample')} /></label>
            <label className="f">{t('rent.units')}<input id="ri-units" inputMode="numeric" value={String(f.units)} onChange={(e) => set('units', Number(e.target.value.replace(/\D/g, '') || 0))} /></label>
          </div>
          <div className="small mut" style={{ marginBottom: 6 }}>{t('rent.ratesHint', { cur: books.company.currency })}</div>
          <div className="row">
            {(['dayRate', 'hourRate', 'weekRate', 'monthRate'] as const).map((k) => (
              <label key={k} className="f">{t(`rent.${k}` as Key)}<input id={`ri-${k}`} inputMode="decimal" className="num" value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></label>))}
          </div>
          <div className="row">
            <label className="f">{t('rent.incomeAccount')}<select value={f.incomeAccountId ?? income.find((a) => a.code === '4100')?.id ?? ''} onChange={(e) => set('incomeAccountId', e.target.value)}>
              {income.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}</select></label>
            {assets.data && <label className="f">{t('rent.fixedAsset')}<select value={f.fixedAssetId ?? ''} onChange={(e) => set('fixedAssetId', e.target.value)}>
              <option value="">{t('rent.noAsset')}</option>{assets.data.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>}
            {f.id && <label className="f">{t('rent.status')}<select value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">{t('rent.st.active')}</option><option value="retired">{t('rent.st.retired')}</option></select></label>}
          </div>
          <div className="actions"><button className="b p" id="ri-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {rows.length === 0 ? <div className="mut">{t('rent.noItems')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rent.item')}</th><th>{t('rent.rates')}</th><th className="num">{t('rent.outOf')}</th><th /></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} className={i.status === 'retired' ? 'mut' : ''}>
                <td><b>{local(i.name, i.nameAr)}</b> <span className="small mut ltr">{i.code}</span>
                  <div className="small mut">{[i.category, i.identifier, i.fixedAssetNumber].filter(Boolean).join(' · ')}{i.status === 'retired' && ` · ${t('rent.st.retired')}`}</div></td>
                <td className="small" data-label={t('rent.rates')}>{BASES.filter((b) => rateOf(i, b)).map((b) => <div key={b}>{fmt(rateOf(i, b))} {t(`rent.per.${b}` as Key)}</div>)}</td>
                <td className="num" data-label={t('rent.outOf')}><span className={`badge ${i.out >= i.units ? 'warn' : 'good'}`}>{t('rent.outN', { n: i.out, units: i.units })}</span>
                  {i.nextBooking && <div className="small mut">{t('rent.nextBooking', { date: i.nextBooking })}</div>}</td>
                <td className="num">{canEdit && <button className="b small" onClick={() => setF({ ...i, nameAr: i.nameAr ?? '', category: i.category ?? '', identifier: i.identifier ?? '',
                  hourRate: i.hourRate ?? '', dayRate: i.dayRate ?? '', weekRate: i.weekRate ?? '', monthRate: i.monthRate ?? '', notes: i.notes ?? '' })}>{t('rent.edit')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ contracts
function Contracts({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const list = useApi<ContractRow[]>(`/api/companies/${books.company.id}/rental-contracts${status === 'open' ? '?status=open' : ''}`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const { run, busy, note } = useRun();
  const [f, setF] = useState<{ contactId: string; site: string; reference: string; costCentreId: string }>();
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('rent.contractsHint')}</div>
      {note}
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="seg" role="radiogroup">{(['open', 'all'] as const).map((k) => <button key={k} role="radio" aria-checked={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{t(`rent.filter.${k}` as Key)}</button>)}</div>
        <span className="spacer" />
        {canEdit && !f && <button className="b p" id="rent-new" onClick={() => setF({ contactId: '', site: '', reference: '', costCentreId: '' })}>{t('rent.newContract')}</button>}
      </div>
      {f && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await api<{ id: string }>(`/api/companies/${books.company.id}/rental-contracts`, { body: { ...f, costCentreId: f.costCentreId || null } });
          go('Rentals', 'rental-contracts', r.id); }); }}>
          <h2>{t('rent.newContract')}</h2>
          <div className="row">
            <label className="f">{t('contact.customer')}<select id="rc-customer" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">{t('rent.pickCustomer')}</option>{(customers.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>
            <label className="f">{t('rent.site')}<input id="rc-site" value={f.site} placeholder={t('rent.siteExample')} onChange={(e) => setF({ ...f, site: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('rent.reference')}<input value={f.reference} placeholder={t('rent.referenceExample')} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
            {books.costCentres.length > 0 && <label className="f">{t('rent.costCentre')}<select value={f.costCentreId} onChange={(e) => setF({ ...f, costCentreId: e.target.value })}>
              <option value="">—</option>{books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>}
          </div>
          <div className="actions"><button className="b p" id="rc-save" disabled={busy || !f.contactId}>{t('rent.create')}</button><button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('rent.noContracts')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rent.contract')}</th><th>{t('contact.customer')}</th><th>{t('rent.items')}</th><th>{t('rent.billedTo')}</th><th>{t('rent.status')}</th></tr></thead>
            <tbody>{list.data.map((k) => (
              <tr key={k.id}>
                <td><button className="link ltr" onClick={() => go('Rentals', 'rental-contracts', k.id)}>{k.number}</button>{k.site && <div className="small mut">{k.site}</div>}</td>
                <td data-label={t('contact.customer')}>{local(k.customer, k.customerAr)}</td>
                <td className="small" data-label={t('rent.items')}>{k.items ?? '—'}</td>
                <td className="ltr small" data-label={t('rent.billedTo')}>{k.billedTo ?? '—'}</td>
                <td data-label={t('rent.status')}><span className={`badge ${k.status === 'open' ? 'good' : ''}`}>{t(`rent.cst.${k.status}` as Key)}</span>{k.onHire > 0 && <span className="small"> {t('rent.onHireN', { n: k.onHire })}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

function ContractPage({ books, id, canEdit }: { books: CompanyBooks; id: string; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const d = useApi<Contract>(`/api/rental-contracts/${id}`);
  const items = useApi<Item[]>(`/api/companies/${books.company.id}/rental-items`);
  const { run, busy, note } = useRun();
  const [add, setAdd] = useState<{ itemId: string; basis: Basis; rate: string; units: string; outDate: string }>();
  const [ret, setRet] = useState<{ id: string; date: string }>();
  const [hours, setHours] = useState<{ lineId: string; date: string; hours: string }>();
  const [upTo, setUpTo] = useState(today());
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const k = d.data;
  const open = k.status === 'open' && canEdit;
  const reload = () => { d.reload(); items.reload(); };
  const pickItem = (itemId: string) => {
    const it = items.data?.find((i) => i.id === itemId);
    const basis = it ? (BASES.find((b) => rateOf(it, b)) ?? 'day') : 'day';
    setAdd({ ...add!, itemId, basis, rate: it ? rateOf(it, basis) ?? '' : '' });
  };
  const canSales = accessTo(books.access?.permissions, 'Sales') === 'edit';
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Rentals', 'rental-contracts')}>{t('rent.back')}</button>
        <span className="spacer" />
        {open && k.bills.length === 0 && <button className="b" onClick={() => void run(() => api(`/api/rental-contracts/${id}/cancel`, { body: {} }), t('rent.cancelled'), reload)}>{t('rent.cancel')}</button>}
        {open && <button className="b" id="rc-close" onClick={() => void run(() => api(`/api/rental-contracts/${id}/close`, { body: {} }), t('rent.closed'), reload)}>{t('rent.close')}</button>}
      </div>
      {note}
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }} className="ltr">{k.number}</h2><span className={`badge ${k.status === 'open' ? 'good' : ''}`}>{t(`rent.cst.${k.status}` as Key)}</span></div>
        <div className="small mut">{[local(k.customer, k.customerAr), k.site, k.reference, k.costCentre].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('rent.lines')}</h2><span className="spacer" />
          {open && !add && <button className="b p" id="rl-add" onClick={() => setAdd({ itemId: '', basis: 'day', rate: '', units: '1', outDate: today() })}>{t('rent.addItem')}</button>}</div>
        {add && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/rental-contracts/${id}/lines`, { body: add }), t('rent.lineAdded'), () => { setAdd(undefined); reload(); }); }}>
            <div className="row">
              <label className="f">{t('rent.item')}<select id="rl-item" value={add.itemId} onChange={(e) => pickItem(e.target.value)}>
                <option value="">{t('rent.pickItem')}</option>
                {(items.data ?? []).filter((i) => i.status === 'active').map((i) => <option key={i.id} value={i.id}>{i.code} · {local(i.name, i.nameAr)} ({t('rent.freeN', { n: i.units - i.out })})</option>)}</select></label>
              <label className="f">{t('rent.charged')}<select id="rl-basis" value={add.basis} onChange={(e) => { const b = e.target.value as Basis; const it = items.data?.find((i) => i.id === add.itemId);
                setAdd({ ...add, basis: b, rate: (it && rateOf(it, b)) || add.rate }); }}>{BASES.map((b) => <option key={b} value={b}>{t(`rent.by.${b}` as Key)}</option>)}</select></label>
              <label className="f">{t('rent.rate')}<input id="rl-rate" inputMode="decimal" className="num" value={add.rate} onChange={(e) => setAdd({ ...add, rate: e.target.value })} /></label>
            </div>
            <div className="row">
              <label className="f">{t('rent.units')}<input inputMode="numeric" value={add.units} onChange={(e) => setAdd({ ...add, units: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="f">{t('rent.outDate')}<input id="rl-out" type="date" value={add.outDate} onChange={(e) => setAdd({ ...add, outDate: e.target.value })} /></label>
            </div>
            <div className="actions"><button className="b p" id="rl-save" disabled={busy || !add.itemId}>{t('rent.addItem')}</button><button type="button" className="b" onClick={() => setAdd(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        {k.lines.length === 0 ? <div className="mut" style={{ marginTop: 8 }}>{t('rent.noLines')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rent.item')}</th><th>{t('rent.rate')}</th><th>{t('rent.dates')}</th><th>{t('rent.status')}</th><th /></tr></thead>
            <tbody>{k.lines.map((l) => (
              <tr key={l.id}>
                <td><b>{local(l.name, l.nameAr)}</b>{l.units > 1 && <> × {l.units}</>} <span className="small mut ltr">{l.code}</span>{l.identifier && <div className="small mut">{l.identifier}</div>}</td>
                <td className="small" data-label={t('rent.rate')}>{fmt(l.rate)} {t(`rent.per.${l.basis}` as Key)}{l.basis === 'hour' && <div className="mut">{t('rent.hoursN', { n: l.hours })}</div>}</td>
                <td className="ltr small" data-label={t('rent.dates')}>{l.outDate} → {l.returnDate ?? '…'}{l.billedTo && <div className="mut">{t('rent.billedToN', { date: l.billedTo })}</div>}</td>
                <td data-label={t('rent.status')}><span className={`badge ${l.state === 'on_hire' ? 'warn' : l.state === 'booked' ? '' : 'good'}`}>{t(`rent.ls.${l.state}` as Key)}</span></td>
                <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                  {open && l.basis === 'hour' && !l.returnDate && <button className="b small" onClick={() => setHours({ lineId: l.id, date: today(), hours: '' })}>{t('rent.logHours')}</button>}
                  {open && l.basis === 'hour' && l.returnDate && <button className="b small" onClick={() => setHours({ lineId: l.id, date: l.returnDate!, hours: '' })}>{t('rent.logHours')}</button>}
                  {open && !l.returnDate && (ret?.id === l.id ? (
                    <form className="actions" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/rental-lines/${l.id}/return`, { body: { date: ret.date } }), t('rent.returned'), () => { setRet(undefined); reload(); }); }}>
                      <input type="date" aria-label={t('rent.returnDate')} value={ret.date} onChange={(e) => setRet({ ...ret, date: e.target.value })} />
                      <button className="b small p" id="rl-return-save" disabled={busy}>{t('rent.return')}</button></form>
                  ) : <button className="b small" id={`rl-return-${l.code}`} onClick={() => setRet({ id: l.id, date: today() })}>{t('rent.return')}</button>)}
                  {open && !l.billedTo && <button className="b small" onClick={() => void run(() => api(`/api/rental-lines/${l.id}/delete`, { body: {} }), undefined, reload)}>{t('rent.remove')}</button>}
                </span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {hours && (
          <form className="inset actions" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/rental-lines/${hours.lineId}/hours`, { body: hours }), t('rent.hoursSaved'), () => { setHours(undefined); reload(); }); }}>
            <label className="f">{t('rent.workDate')}<input type="date" value={hours.date} onChange={(e) => setHours({ ...hours, date: e.target.value })} /></label>
            <label className="f">{t('rent.hours')}<input id="rh-hours" inputMode="decimal" className="num" value={hours.hours} placeholder="8" onChange={(e) => setHours({ ...hours, hours: e.target.value })} /></label>
            <button className="b p" id="rh-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setHours(undefined)}>{t('cancel')}</button>
          </form>
        )}
        {k.usage.length > 0 && (
          <details style={{ marginTop: 8 }}><summary className="small">{t('rent.timesheet', { n: k.usage.length })}</summary>
            <table><tbody>{k.usage.map((u) => <tr key={`${u.lineId}${u.date}`}><td className="ltr small">{u.date}</td><td className="small">{k.lines.find((l) => l.id === u.lineId)?.name}</td>
              <td className="num">{u.hours}</td><td className="small mut">{u.billed ? t('rent.billed') : ''}</td></tr>)}</tbody></table></details>
        )}
      </div>
      {k.status === 'open' && (
        <div className="card">
          <h2>{t('rent.billTitle')}</h2>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('rent.billHint')}</div>
          <div className="actions">
            <label className="f">{t('rent.billUpTo')}<input id="rb-upto" type="date" value={upTo} onChange={(e) => setUpTo(e.target.value)} /></label>
            {canEdit && canSales && <button className="b p" id="rb-bill" disabled={busy} onClick={() => void run(async () => {
              const r = await api<{ documentId: string }>(`/api/rental-contracts/${id}/bill`, { body: { upTo } }); go('Sales', 'invoices', r.documentId); })}>{t('rent.bill')}</button>}
            <span className="small mut">{t('rent.unbilledToday', { amount: fmt(k.unbilledToday), cur: books.company.currency })}</span>
          </div>
        </div>
      )}
      {k.bills.length > 0 && (
        <div className="card">
          <h2>{t('rent.invoices')}</h2>
          <table className="stack"><tbody>{k.bills.map((b) => (
            <tr key={b.id}><td><button className="link" onClick={() => go('Sales', 'invoices', b.documentId)}>{b.number ?? t('doc.draftNo')}</button></td>
              <td className="ltr small">{t('rent.upToN', { date: b.periodTo })}</td><td className="num">{fmt(b.total)}</td><td>{t(`state.${b.status}` as Key)}</td></tr>))}</tbody></table>
        </div>
      )}
    </>
  );
}
