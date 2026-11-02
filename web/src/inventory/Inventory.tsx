// Inventory: items, goods received notes (GRN, inbound), goods delivery notes (GDN, outbound) and stock value.
// Stock is valued at weighted average cost; every posted note moves the value in the books (1300 Inventory).
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { isLocked } from '../books/Workspace.tsx';
import { issueCost, quantityToMilli, receivedValue } from '../../../src/books/inventory.ts';

export interface Item {
  id: string; sku: string; name: string; nameAr: string | null; unit: string; salePrice: string | null; reorderLevel: string | null;
  qtyOnHand: string; valueOnHand: string; averageCost: string; low: boolean; status: string;
}
type NoteType = 'grn' | 'gdn';
interface NoteRow {
  id: string; type: NoteType; status: 'draft' | 'posted'; number: string | null; date: string; contactId: string | null; contactName: string | null; contactNameAr: string | null;
  reference: string | null; notes: string | null; otherAccountId: string; otherAccountCode: string; otherAccountName: string; otherAccountNameAr: string | null;
  totalValue: string; journalEntryId: string | null; lineCount: number;
}
interface NoteLine { id: string; itemId: string; sku: string; name: string; nameAr: string | null; unit: string; quantity: string; unitCost: string | null; value: string;
  costCentreId: string | null; costCentre: string | null; costCentreAr: string | null }

/** Quantities show without trailing zeros: 12.500 -> 12.5, 3.000 -> 3. */
export const qty = (q: string) => (q.includes('.') ? q.replace(/\.?0+$/, '') : q);
const milli = (q: string): bigint | null => { try { return quantityToMilli(q.trim()); } catch { return null; } };
const stockMilli = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };
const subOf = (t: NoteType) => (t === 'grn' ? 'grn' : 'gdn');

// ------------------------------------------------------------------ items
export function ItemList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<Item[]>(`/api/companies/${books.company.id}/items?q=${encodeURIComponent(q)}`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('inv.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b" onClick={() => go('Inventory', 'grn', 'new')}>{t('inv.newGrn')}</button>}
        {books.canPost && <button className="b p" onClick={() => go('Inventory', 'items', 'new')}>{t('inv.newItemPlus')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('inv.noItems')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('inv.sku')}</th><th>{t('inv.item')}</th><th className="num">{t('inv.onHand')}</th><th className="num">{t('inv.avgCost')}</th><th className="num">{t('inv.value')}</th></tr></thead>
            <tbody>{list.data.map((i) => (
              <tr key={i.id} className={i.status !== 'active' ? 'mut' : ''}>
                <td className="ltr small">{i.sku}</td>
                <td><button className="link" onClick={() => go('Inventory', 'items', i.id)}>{local(i.name, i.nameAr)}</button>{i.low && <span className="badge warn" style={{ marginInlineStart: 6 }}>{t('inv.low')}</span>}</td>
                <td className="num ltr" data-label={t('inv.onHand')}>{qty(i.qtyOnHand)} <span className="small mut">{i.unit}</span></td>
                <td className="num ltr" data-label={t('inv.avgCost')}>{fmt(i.averageCost)}</td>
                <td className="num ltr" data-label={t('inv.value')}>{fmt(i.valueOnHand)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function ItemPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const item = useApi<Item & { movements: { noteId: string; type: NoteType; number: string; date: string; contactName: string | null; quantity: string; value: string; qtyAfter: string; valueAfter: string }[] }>(
    isNew ? null : `/api/items/${id}`);
  const [f, setF] = useState<Record<string, string>>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (!f && (isNew || item.data)) {
    const x = item.data;
    setF({ sku: x?.sku ?? '', name: x?.name ?? '', nameAr: x?.nameAr ?? '', unit: x?.unit ?? 'pcs', salePrice: x?.salePrice ?? '', reorderLevel: x?.reorderLevel ? qty(x.reorderLevel) : '', status: x?.status ?? 'active' });
  }
  if (item.error) return <ErrorNote error={item.error} onRetry={item.reload} />;
  if (!f) return <Loading />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const priceOk = !f.salePrice!.trim() || isAmount(f.salePrice!);
  const canSave = books.canPost && f.sku!.trim() !== '' && f.name!.trim() !== '' && priceOk && (!f.reorderLevel!.trim() || milli(f.reorderLevel!) !== null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true); setMsg({});
    try {
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/items` : `/api/items/${id}`,
        { body: { ...f, salePrice: f.salePrice!.trim() ? normalise(f.salePrice!) : null, reorderLevel: f.reorderLevel!.trim() || null } });
      if (isNew) { go('Inventory', 'items', r.id); return; }
      setMsg({ ok: t('admin.saved') }); item.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  const x = item.data;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Inventory', 'items')}>{t('inv.back')}</button>
        <span className="spacer" />
        {!isNew && books.canPost && <button className="b" onClick={() => go('Inventory', 'grn', 'new', id)}>{t('inv.receive')}</button>}
        {!isNew && books.canPost && x && toMinor(x.valueOnHand) >= 0n && stockMilli(x.qtyOnHand) > 0n && <button className="b" onClick={() => go('Inventory', 'gdn', 'new', id)}>{t('inv.deliver')}</button>}
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {x && (
        <div className="grid" style={{ marginBottom: 12 }}>
          <div className="card fig"><small>{t('inv.onHand')}</small><b className="ltr">{qty(x.qtyOnHand)} {x.unit}</b></div>
          <div className="card fig"><small>{t('inv.avgCost')}</small><b className="ltr">{fmt(x.averageCost)}</b></div>
          <div className="card fig"><small>{t('inv.value')}</small><b className="ltr">{fmt(x.valueOnHand)}</b></div>
        </div>
      )}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('inv.newItem') : local(f.name!, f.nameAr!)}</h2>
        <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('inv.sku')}<input id="it-sku" dir="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value.toUpperCase())} /></label>
            <label className="f">{t('inv.name')}<input id="it-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, nameAr: followArabic(f.name!, e.target.value, f.nameAr!) })} /></label>
            <label className="f">{t('ar.nameAr')}<input id="it-name-ar" dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} /><ArabicHint english={f.name!} arabic={f.nameAr!} /></label>
          </div>
          <div className="row">
            <label className="f">{t('inv.unit')}
              <select value={f.unit} onChange={(e) => set('unit', e.target.value)}>
                {['pcs', 'box', 'kg', 'g', 'l', 'm', 'm2', 'ton', 'carton', 'set'].map((u) => <option key={u} value={u}>{t(`unit.${u}` as never)}</option>)}
              </select>
            </label>
            <label className="f">{t('inv.salePrice')} ({books.company.currency})<input inputMode="decimal" className="num ltr amount" value={f.salePrice} onChange={(e) => set('salePrice', e.target.value)} />
              {!priceOk && <span className="small bad">{t('err.amountFormat')}</span>}</label>
            <label className="f">{t('inv.reorder')}<input inputMode="decimal" className="num ltr amount" value={f.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} /></label>
          </div>
          {!isNew && <label className="actions" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.status === 'archived'} onChange={(e) => set('status', e.target.checked ? 'archived' : 'active')} /><span>{t('inv.archive')}</span></label>}
          <p className="small mut">{isNew ? t('inv.newItemNote') : t('inv.stockNote')}</p>
          {books.canPost && <button className="b p" type="submit" disabled={busy || !canSave}>{isNew ? t('inv.createItem') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {x && (
        <div className="card">
          <h3>{t('inv.movements')}</h3>
          {x.movements.length === 0 ? <p className="mut small">{t('inv.noMovements')}</p> : (
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('doc.date')}</th><th>{t('inv.note')}</th><th className="num">{t('inv.in')}</th><th className="num">{t('inv.out')}</th><th className="num">{t('inv.value')}</th><th className="num">{t('inv.onHand')}</th><th className="num">{t('inv.stockValue')}</th></tr></thead>
              <tbody>{x.movements.map((m, i) => (
                <tr key={i}>
                  <td className="ltr">{m.date}</td>
                  <td><button className="link" onClick={() => go('Inventory', subOf(m.type), m.noteId)}>{m.number}</button>{m.contactName && <span className="small mut"> · {m.contactName}</span>}</td>
                  <td className="num ltr" data-label={t('inv.in')}>{m.type === 'grn' ? qty(m.quantity) : ''}</td>
                  <td className="num ltr" data-label={t('inv.out')}>{m.type === 'gdn' ? qty(m.quantity) : ''}</td>
                  <td className="num ltr" data-label={t('inv.value')}>{m.type === 'gdn' ? '-' : ''}{fmt(m.value)}</td>
                  <td className="num ltr" data-label={t('inv.onHand')}>{qty(m.qtyAfter)}</td>
                  <td className="num ltr" data-label={t('inv.stockValue')}>{fmt(m.valueAfter)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ goods notes (GRN / GDN)
export function NoteList({ books, type }: { books: CompanyBooks; type: NoteType }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<NoteRow[]>(`/api/companies/${books.company.id}/stock-notes?type=${type}&q=${encodeURIComponent(q)}`);
  return (
    <>
      <p className="mut small">{t(type === 'grn' ? 'inv.grnHint' : 'inv.gdnHint')}</p>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('inv.searchNotes')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go('Inventory', subOf(type), 'new')}>{t(type === 'grn' ? 'inv.newGrnPlus' : 'inv.newGdnPlus')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('none')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('doc.number')}</th><th>{t(type === 'grn' ? 'inv.from' : 'inv.to')}</th><th>{t('doc.date')}</th><th>{t('inv.reference')}</th><th className="num">{t('inv.value')}</th><th /></tr></thead>
            <tbody>{list.data.map((n) => (
              <tr key={n.id}>
                <td><button className="link" onClick={() => go('Inventory', subOf(type), n.id)}>{n.number ?? t('doc.draftNo')}</button></td>
                <td data-label={t(type === 'grn' ? 'inv.from' : 'inv.to')}>{n.contactName ? local(n.contactName, n.contactNameAr) : <span className="mut">{local(n.otherAccountName, n.otherAccountNameAr)}</span>}</td>
                <td className="ltr" data-label={t('doc.date')}>{n.date}</td>
                <td className="small" data-label={t('inv.reference')}>{n.reference ?? ''}</td>
                <td className="num ltr" data-label={t('inv.value')}>{n.status === 'posted' ? fmt(n.totalValue) : '—'}</td>
                <td><span className={`badge ${n.status === 'posted' ? 'good' : ''}`}>{t(n.status === 'posted' ? 'inv.posted' : 'state.draft')}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

type FormLine = { itemId: string; quantity: string; unitCost: string; costCentreId: string };

export function NoteEditor({ books, type, id, presetItemId }: { books: CompanyBooks; type: NoteType; id?: string; presetItemId?: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const note = useApi<NoteRow & { lines: NoteLine[] }>(id ? `/api/stock-notes/${id}` : null);
  const items = useApi<Item[]>(`/api/companies/${books.company.id}/items`);
  const contacts = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=${type === 'grn' ? 'supplier' : 'customer'}`);
  const blankLine = (itemId = ''): FormLine => ({ itemId, quantity: '', unitCost: '', costCentreId: '' });
  const [f, setF] = useState<{ date: string; contactId: string; reference: string; notes: string; otherAccountId: string; lines: FormLine[] }>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const others = books.accounts.filter((a) => (type === 'grn' ? ['liability', 'equity'].includes(a.type) : a.type === 'expense') && a.code !== '1300');
  const defaultOther = others.find((a) => a.code === (type === 'grn' ? '2050' : '5000'))?.id ?? others[0]?.id ?? '';
  if (!f && (!id || note.data)) {
    const n = note.data;
    setF({ date: n?.date ?? today(), contactId: n?.contactId ?? '', reference: n?.reference ?? '', notes: n?.notes ?? '', otherAccountId: n?.otherAccountId ?? defaultOther,
      lines: n ? n.lines.map((l) => ({ itemId: l.itemId, quantity: qty(l.quantity), unitCost: l.unitCost ?? '', costCentreId: l.costCentreId ?? '' })) : [blankLine(presetItemId), blankLine()] });
  }
  if (note.error) return <ErrorNote error={note.error} onRetry={note.reload} />;
  if (!f || !items.data) return <Loading />;
  if (note.data && note.data.status === 'posted') return <NoteView books={books} note={note.data} />;

  const byId = new Map(items.data.map((i) => [i.id, i]));
  const setLine = (i: number, p: Partial<FormLine>) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  // Work out each line's value as the database will: cost x quantity in, average cost out (following the stock line by line).
  const left = new Map(items.data.map((i) => [i.id, { q: stockMilli(i.qtyOnHand), v: toMinor(i.valueOnHand) }]));
  const priced = f.lines.map((l) => {
    if (!l.itemId) return { empty: !l.quantity.trim(), problem: l.quantity.trim() ? 'item' : null, value: null as bigint | null };
    const q = milli(l.quantity);
    if (q === null) return { empty: false, problem: 'qty', value: null };
    if (type === 'grn') {
      if (!isAmount(l.unitCost)) return { empty: false, problem: 'cost', value: null };
      return { empty: false, problem: null, value: receivedValue(q, toMinor(normalise(l.unitCost))) };
    }
    const s = left.get(l.itemId)!;
    if (q > s.q) return { empty: false, problem: 'stock', value: null, have: s.q };
    const v = issueCost(s.q, s.v, q);
    s.q -= q; s.v -= v;
    return { empty: false, problem: null, value: v };
  });
  const used = priced.filter((p) => !p.empty);
  const total = used.reduce((s, p) => s + (p.value ?? 0n), 0n);
  const locked = isLocked(books, f.date);
  const canSave = books.canPost && used.length > 0 && used.every((p) => !p.problem) && !locked;

  const save = async (andPost: boolean) => {
    setBusy(true); setErr(undefined);
    try {
      const body = { type, ...f, contactId: f.contactId || null, lines: f.lines.filter((l) => l.itemId).map((l) => ({ ...l, unitCost: type === 'grn' ? normalise(l.unitCost) : null, costCentreId: l.costCentreId || null })) };
      const r = await api<{ id: string }>(id ? `/api/stock-notes/${id}` : `/api/companies/${books.company.id}/stock-notes`, { body });
      if (andPost) await api(`/api/stock-notes/${r.id}/post`, { body: {} });
      go('Inventory', subOf(type), r.id);
      if (id) note.reload();
    } catch (e) { setErr(errorText(t, has, e)); setConfirm(false); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!id) return;
    try { await api(`/api/stock-notes/${id}/delete`, { body: {} }); go('Inventory', subOf(type)); } catch (e) { setErr(errorText(t, has, e)); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Inventory', subOf(type))}>{t(type === 'grn' ? 'inv.backGrn' : 'inv.backGdn')}</button>
      </div>
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="card">
        <h2>{t(type === 'grn' ? 'inv.newGrn' : 'inv.newGdn')}{id && <span className="badge" style={{ marginInlineStart: 8 }}>{t('state.draft')}</span>}</h2>
        <div className="row">
          <label className="f">{t('doc.date')}<input id="nt-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            {locked && <span className="small bad">{t('err.periodLocked')}</span>}</label>
          <label className="f">{t(type === 'grn' ? 'contact.supplier' : 'contact.customer')}
            <select id="nt-contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">{t(type === 'grn' ? 'inv.noContact' : 'inv.noCustomer')}</option>
              {(contacts.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
            </select>
          </label>
          <label className="f">{t('inv.reference')}<input value={f.reference} placeholder={t(type === 'grn' ? 'inv.refGrn' : 'inv.refGdn')} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
        </div>
        <label className="f">{t(type === 'grn' ? 'inv.creditTo' : 'inv.chargeTo')}
          <select id="nt-other" value={f.otherAccountId} onChange={(e) => setF({ ...f, otherAccountId: e.target.value })}>
            {others.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
          </select>
          <span className="small mut">{t(type === 'grn' ? 'inv.creditToHint' : 'inv.chargeToHint')}</span>
        </label>
      </div>
      <div className="card">
        {items.data.length === 0 ? <p className="mut">{t('inv.addItemsFirst')} <button className="link" onClick={() => go('Inventory', 'items', 'new')}>{t('inv.newItem')}</button></p> : (
          <div className="wrap">
            <table className="doclines notelines">
              <thead><tr><th>{t('inv.item')}</th><th className="num">{t('inv.qty')}</th>{type === 'grn' && <th className="num">{t('inv.unitCost')}</th>}<th>{t('journal.costCentre')}</th><th className="num">{t('inv.value')}</th><th /></tr></thead>
              <tbody>{f.lines.map((l, i) => {
                const it = byId.get(l.itemId); const p = priced[i]!;
                return (
                  <tr key={i}>
                    <td className="dl-desc">
                      <select value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })} aria-label={t('inv.item')}>
                        <option value="">{t('inv.chooseItem')}</option>
                        {items.data!.filter((x) => x.status === 'active' || x.id === l.itemId).map((x) => <option key={x.id} value={x.id}>{x.sku} · {local(x.name, x.nameAr)}{type === 'gdn' ? ` (${qty(x.qtyOnHand)} ${x.unit})` : ''}</option>)}
                      </select>
                    </td>
                    <td className="dl-qty"><input inputMode="decimal" className="num ltr" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={t('inv.qty')} placeholder={it?.unit ?? t('inv.qty')} />
                      {p.problem === 'stock' && <span className="small bad">{t('inv.onlyInStock', { n: qty(it!.qtyOnHand) })}</span>}</td>
                    {type === 'grn' && <td className="dl-price"><input inputMode="decimal" className="num ltr" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} aria-label={t('inv.unitCost')} placeholder={t('inv.unitCost')} /></td>}
                    <td className="dl-cc">
                      <select value={l.costCentreId} onChange={(e) => setLine(i, { costCentreId: e.target.value })} aria-label={t('journal.costCentre')}>
                        <option value="">—</option>
                        {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
                      </select>
                    </td>
                    <td className="num ltr dl-amt">{p.value !== null ? fmt(fromMinor(p.value)) : '—'}</td>
                    <td className="dl-x"><button className="b small" disabled={f.lines.length <= 1} onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })} aria-label={t('journal.removeLine')}>×</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="b" onClick={() => setF({ ...f, lines: [...f.lines, blankLine()] })}>{t('journal.addLine')}</button>
          <span className="spacer" />
          <b>{t('inv.total')}: <span className="ltr">{fmt(fromMinor(total))}</span></b>
        </div>
        {type === 'gdn' && <p className="small mut">{t('inv.avgNote')}</p>}
        <label className="f">{t('doc.notes')}<textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      </div>
      {books.canPost && (confirm ? (
        <ConfirmBar message={t(type === 'grn' ? 'inv.confirmGrn' : 'inv.confirmGdn', { amount: fmt(fromMinor(total)) })} busy={busy} onYes={() => save(true)} onNo={() => setConfirm(false)} />
      ) : (
        <div className="actions">
          <button className="b" disabled={busy || !canSave} onClick={() => save(false)}>{t('doc.saveDraft')}</button>
          <button id="nt-post" className="b p" disabled={busy || !canSave} onClick={() => setConfirm(true)}>{t(type === 'grn' ? 'inv.postGrn' : 'inv.postGdn')}</button>
          {id && <><span className="spacer" /><button className="b" onClick={remove}>{t('doc.deleteDraft')}</button></>}
        </div>
      ))}
    </>
  );
}

function NoteView({ books, note }: { books: CompanyBooks; note: NoteRow & { lines: NoteLine[] } }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const type = note.type;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Inventory', subOf(type))}>{t(type === 'grn' ? 'inv.backGrn' : 'inv.backGdn')}</button>
        <span className="spacer" />
        <button className="b" onClick={() => window.print()}>{t('inv.print')}</button>
      </div>
      <div className="card paper">
        <div className="paper-head">
          <div><div className="paper-title">{t(type === 'grn' ? 'inv.grnTitle' : 'inv.gdnTitle')}</div><div className="paper-no ltr">{note.number}</div></div>
          <span className="badge good">{t('inv.posted')}</span>
        </div>
        <div className="row small">
          <div>{t('doc.date')}: <b className="ltr">{note.date}</b></div>
          {note.contactName && <div>{t(type === 'grn' ? 'contact.supplier' : 'contact.customer')}: <b>{local(note.contactName, note.contactNameAr)}</b></div>}
          {note.reference && <div>{t('inv.reference')}: <b>{note.reference}</b></div>}
        </div>
        <div className="wrap"><table className="stack">
          <thead><tr><th>{t('inv.sku')}</th><th>{t('inv.item')}</th><th className="num">{t('inv.qty')}</th>{type === 'grn' && <th className="num">{t('inv.unitCost')}</th>}<th className="num">{t('inv.value')}</th></tr></thead>
          <tbody>{note.lines.map((l) => (
            <tr key={l.id}><td className="ltr small">{l.sku}</td><td><button className="link" onClick={() => go('Inventory', 'items', l.itemId)}>{local(l.name, l.nameAr)}</button>
              {l.costCentre && <span className="small mut"> · {local(l.costCentre, l.costCentreAr)}</span>}</td>
              <td className="num ltr" data-label={t('inv.qty')}>{qty(l.quantity)} {l.unit}</td>
              {type === 'grn' && <td className="num ltr" data-label={t('inv.unitCost')}>{fmt(l.unitCost)}</td>}
              <td className="num ltr" data-label={t('inv.value')}>{fmt(l.value)}</td></tr>
          ))}</tbody>
          <tfoot><tr className="total"><td colSpan={type === 'grn' ? 4 : 3}>{t('inv.total')}</td><td className="num ltr">{fmt(note.totalValue)}</td></tr></tfoot>
        </table></div>
        <p className="small mut">{t(type === 'grn' ? 'inv.postedGrn' : 'inv.postedGdn', { account: `${note.otherAccountCode} ${local(note.otherAccountName, note.otherAccountNameAr)}` })}</p>
        {note.notes && <p className="small">{note.notes}</p>}
      </div>
      <p className="mut small">{t('inv.correctNote')}</p>
    </>
  );
}

// ------------------------------------------------------------------ stock value
export function StockValue({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const r = useApi<{ items: Item[]; total: string; booksValue: string; difference: string }>(`/api/companies/${books.company.id}/stock-value`);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const ok = toMinor(r.data.difference) === 0n;
  return (
    <>
      <div className="grid" style={{ marginBottom: 12 }}>
        <div className="card fig"><small>{t('inv.stockValue')}</small><b className="ltr">{fmt(r.data.total)}</b></div>
        <div className="card fig"><small>{t('inv.inBooks')}</small><b className="ltr">{fmt(r.data.booksValue)}</b></div>
        <div className="card fig"><small>{t('bank.difference')}</small><b className={`ltr ${ok ? 'good' : 'bad'}`}>{fmt(r.data.difference)}</b></div>
      </div>
      <div className={`notice ${ok ? '' : 'warn'}`}>{ok ? t('inv.agrees') : t('inv.disagrees')}</div>
      <div className="card">
        <div className="wrap"><table className="stack">
          <thead><tr><th>{t('inv.sku')}</th><th>{t('inv.item')}</th><th className="num">{t('inv.onHand')}</th><th className="num">{t('inv.avgCost')}</th><th className="num">{t('inv.value')}</th></tr></thead>
          <tbody>{r.data.items.map((i) => (
            <tr key={i.id}><td className="ltr small">{i.sku}</td><td><button className="link" onClick={() => go('Inventory', 'items', i.id)}>{local(i.name, i.nameAr)}</button>{i.low && <span className="badge warn" style={{ marginInlineStart: 6 }}>{t('inv.low')}</span>}</td>
              <td className="num ltr" data-label={t('inv.onHand')}>{qty(i.qtyOnHand)} {i.unit}</td>
              <td className="num ltr" data-label={t('inv.avgCost')}>{fmt(i.averageCost)}</td>
              <td className="num ltr" data-label={t('inv.value')}>{fmt(i.valueOnHand)}</td></tr>
          ))}</tbody>
          <tfoot><tr className="total"><td colSpan={4}>{t('inv.total')}</td><td className="num ltr">{fmt(r.data.total)}</td></tr></tfoot>
        </table></div>
      </div>
    </>
  );
}
