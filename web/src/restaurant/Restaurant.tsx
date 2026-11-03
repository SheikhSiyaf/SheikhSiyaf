// Restaurant: food sales (each sale issues a tax invoice, uses the recipe materials and records the payment),
// the menu with recipes and food cost. Materials, materials in, waste and their value reuse the inventory screens.
import { useMemo, useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { isLocked } from '../books/Workspace.tsx';
import type { Item } from '../inventory/Inventory.tsx';
import { qty as showQty } from '../inventory/Inventory.tsx';
import type { BankAccount } from '../bank/Bank.tsx';
import { divRoundHalfUp } from '../../../src/money.ts';
import { netFromGross, priceLine, quantityToMilli, type VatCode } from '../../../src/books/documents.ts';

interface RecipeLine { itemId: string; quantity: string; sku: string; name: string; nameAr: string | null; unit: string; cost: string }
export interface Recipe {
  id: string; name: string; nameAr: string | null; category: string | null; salePrice: string; vatCode: VatCode; incomeAccountId: string; status: string;
  lines: RecipeLine[]; cost: string; margin: string; foodCostPct: number | null;
}
type Method = 'cash' | 'card' | 'bank_transfer' | 'on_account';
const METHODS: Method[] = ['cash', 'card', 'bank_transfer', 'on_account'];
const toMilli = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };

/** Price with VAT for one portion, exactly as the invoice will work it out. */
function withVat(net: string, vatCode: VatCode, rate: string): bigint {
  const p = priceLine({ description: 'x', quantity: '1', unitPrice: net, accountId: 'x', vatCode }, rate);
  return p.net + p.vat;
}
const FoodCost = ({ pct }: { pct: number | null }) =>
  pct === null ? <span className="mut">—</span> : <span className={`badge ${pct > 40 ? 'bad' : pct > 32 ? 'warn' : 'good'}`}>{pct}%</span>;

// ------------------------------------------------------------------ food sales
interface SaleRow {
  id: string; method: Method; invoiceId: string; number: string; date: string; contactName: string; contactNameAr: string | null; items: string | null;
  netTotal: string; vatTotal: string; grossTotal: string; foodCost: string; amountDue: string;
}

export function FoodSales({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const r = useApi<{ sales: SaleRow[]; count: number; netTotal: string; grossTotal: string; foodCost: string; foodCostPct: number | null }>(
    `/api/companies/${books.company.id}/restaurant/sales?from=${from}&to=${to}`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="spacer" />
        {books.canPost && <button id="fs-new" className="b p" onClick={() => go('Restaurant', 'food-sales', 'new')}>{t('rest.newSalePlus')}</button>}
      </div>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data ? <Loading /> : (
        <>
          <div className="grid" style={{ marginBottom: 12 }}>
            <div className="card fig"><small>{t('rest.salesCount')}</small><b>{r.data.count}</b></div>
            <div className="card fig"><small>{t('rest.salesNet')}</small><b className="ltr">{fmt(r.data.netTotal)}</b></div>
            <div className="card fig"><small>{t('rest.foodCost')}</small><b className="ltr">{fmt(r.data.foodCost)}</b></div>
            <div className="card fig"><small>{t('rest.foodCostPct')}</small><b><FoodCost pct={r.data.foodCostPct} /></b></div>
          </div>
          <p className="mut small">{t('rest.salesHint')}</p>
          <div className="card">
            {r.data.sales.length === 0 ? <div className="mut">{t('rest.noSales')}</div> : (
              <div className="wrap"><table className="stack">
                <thead><tr><th>{t('doc.number')}</th><th>{t('doc.date')}</th><th>{t('rest.items')}</th><th>{t('contact.customer')}</th>
                  <th className="num">{t('rest.total')}</th><th className="num">{t('rest.foodCost')}</th><th>{t('rest.paidBy')}</th></tr></thead>
                <tbody>{r.data.sales.map((s) => (
                  <tr key={s.id}>
                    <td><button className="link" onClick={() => go('Restaurant', 'food-sales', s.invoiceId)}>{s.number}</button></td>
                    <td className="ltr" data-label={t('doc.date')}>{s.date}</td>
                    <td className="small" data-label={t('rest.items')}>{s.items}</td>
                    <td data-label={t('contact.customer')}>{local(s.contactName, s.contactNameAr)}</td>
                    <td className="num ltr" data-label={t('rest.total')}>{fmt(s.grossTotal)}</td>
                    <td className="num ltr" data-label={t('rest.foodCost')}>{fmt(s.foodCost)}</td>
                    <td data-label={t('rest.paidBy')}>{s.method === 'on_account' && toMinor(s.amountDue) > 0n
                      ? <span className="badge warn">{t('rest.method.on_account')}</span> : <span className="badge good">{t(`rest.method.${s.method}` as Key)}</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** The order pad: tap menu items, choose how the customer paid, sell. One click issues the invoice. */
export function FoodSale({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const rate = books.company.vatRate;
  const menu = useApi<Recipe[]>(`/api/companies/${books.company.id}/recipes`);
  const items = useApi<Item[]>(`/api/companies/${books.company.id}/items`);
  const banks = useApi<BankAccount[]>(`/api/companies/${books.company.id}/bank-accounts`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const [order, setOrder] = useState<Record<string, number>>({});
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<Method>('cash');
  const [accountId, setAccountId] = useState('');
  const [contactId, setContactId] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: { id: string; number: string; total: string }; bad?: string }>({});

  const active = (menu.data ?? []).filter((r) => r.status === 'active');
  const byId = new Map(active.map((r) => [r.id, r]));
  const lines = Object.entries(order).filter(([id, q]) => q > 0 && byId.has(id)).map(([id, q]) => ({ r: byId.get(id)!, q }));
  const totals = lines.reduce((s, l) => {
    const p = priceLine({ description: l.r.name, quantity: String(l.q), unitPrice: l.r.salePrice, accountId: l.r.incomeAccountId, vatCode: l.r.vatCode }, rate);
    return { net: s.net + p.net, vat: s.vat + p.vat };
  }, { net: 0n, vat: 0n });
  // Materials the order needs against what is in stock: a sale that would run out is stopped before it is made.
  const short = useMemo(() => {
    const need = new Map<string, bigint>();
    for (const l of lines) for (const m of l.r.lines) need.set(m.itemId, (need.get(m.itemId) ?? 0n) + toMilli(m.quantity) * BigInt(l.q));
    return [...need.entries()].map(([id, q]) => ({ item: (items.data ?? []).find((i) => i.id === id), q }))
      .filter((x) => x.item && x.q > toMilli(x.item.qtyOnHand));
  }, [lines, items.data]);
  const accounts = (banks.data ?? []).filter((b) => b.status === 'active' && (method === 'cash' ? b.kind === 'cash' : b.kind !== 'cash'));
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const locked = isLocked(books, date);
  const canSell = books.canPost && lines.length > 0 && short.length === 0 && !locked && (method === 'on_account' ? Boolean(contactId) : Boolean(account));
  const add = (id: string, d: number) => setOrder((o) => ({ ...o, [id]: Math.max(0, Math.min(999, (o[id] ?? 0) + d)) }));

  const sell = async () => {
    if (!canSell) return;
    setBusy(true); setMsg({});
    try {
      const r = await api<{ invoiceId: string; number: string }>(`/api/companies/${books.company.id}/restaurant/sales`, { body: {
        date, method, accountId: method === 'on_account' ? null : account!.accountId, contactId: contactId || null, costCentreId: costCentreId || null,
        lines: lines.map((l) => ({ recipeId: l.r.id, quantity: l.q })) } });
      setMsg({ ok: { id: r.invoiceId, number: r.number, total: fromMinor(totals.net + totals.vat) } });
      setOrder({}); items.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };

  if (menu.error) return <ErrorNote error={menu.error} onRetry={menu.reload} />;
  if (!menu.data || !items.data || !banks.data) return <Loading />;
  const categories = [...new Set(active.map((r) => r.category ?? ''))];
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Restaurant', 'food-sales')}>{t('rest.backSales')}</button>
      </div>
      {msg.ok && (
        <div className="notice actions">
          <span style={{ flex: 1 }}>{t('rest.sold', { number: msg.ok.number, total: fmt(msg.ok.total) })}</span>
          <button className="b small" onClick={() => go('Restaurant', 'food-sales', msg.ok!.id)}>{t('rest.openInvoice')}</button>
        </div>
      )}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {active.length === 0 ? (
        <div className="card mut">{t('rest.noMenu')} <button className="link" onClick={() => go('Restaurant', 'menu', 'new')}>{t('rest.newMenuItem')}</button></div>
      ) : (
        <div className="pos">
          <div className="pos-menu">
            {categories.map((c) => (
              <div key={c} className="card">
                {c && <h3>{c}</h3>}
                <div className="menu-tiles">
                  {active.filter((r) => (r.category ?? '') === c).map((r) => (
                    <button key={r.id} className={`menu-tile ${order[r.id] ? 'on' : ''}`} onClick={() => add(r.id, 1)} disabled={!books.canPost}>
                      <b>{local(r.name, r.nameAr)}</b>
                      <span className="ltr">{fmt(fromMinor(withVat(r.salePrice, r.vatCode, rate)))}</span>
                      {order[r.id] ? <span className="badge">× {order[r.id]}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="card pos-order">
            <h3>{t('rest.order')}</h3>
            {lines.length === 0 ? <p className="mut small">{t('rest.tapItems')}</p> : (
              <table className="mini"><tbody>
                {lines.map((l) => (
                  <tr key={l.r.id}>
                    <td>{local(l.r.name, l.r.nameAr)}</td>
                    <td className="qty-step">
                      <button className="b small" aria-label={t('rest.less')} onClick={() => add(l.r.id, -1)}>−</button>
                      <span className="ltr">{l.q}</span>
                      <button className="b small" aria-label={t('rest.more')} onClick={() => add(l.r.id, 1)}>+</button>
                    </td>
                    <td className="num ltr">{fmt(fromMinor(withVat(l.r.salePrice, l.r.vatCode, rate) * BigInt(l.q)))}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            <table className="totals"><tbody>
              <tr><td>{t('doc.subtotal')}</td><td className="num ltr">{fmt(fromMinor(totals.net))}</td></tr>
              <tr><td>{t('doc.vat')}</td><td className="num ltr">{fmt(fromMinor(totals.vat))}</td></tr>
              <tr className="total"><td>{t('rest.total')} ({books.company.currency})</td><td className="num ltr">{fmt(fromMinor(totals.net + totals.vat))}</td></tr>
            </tbody></table>
            {short.length > 0 && (
              <div className="notice warn small" role="alert">
                {t('rest.short')} {short.map((x) => `${local(x.item!.name, x.item!.nameAr)} (${t('rest.inStock', { n: showQty(x.item!.qtyOnHand), unit: x.item!.unit })})`).join(', ')}.{' '}
                <button className="link small" onClick={() => go('Restaurant', 'materials-in', 'new')}>{t('rest.receiveMaterials')}</button>
              </div>
            )}
            <div className="chips" role="radiogroup" aria-label={t('rest.paidBy')} style={{ margin: '10px 0' }}>
              {METHODS.map((m) => (
                <button key={m} role="radio" aria-checked={method === m} className={`b small ${method === m ? 'p' : ''}`} onClick={() => { setMethod(m); setAccountId(''); }}>{t(`rest.method.${m}` as Key)}</button>
              ))}
            </div>
            {method !== 'on_account' && (
              <label className="f">{t('rest.paidInto')}
                <select id="fs-account" value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{local(a.name, a.nameAr)}</option>)}
                </select>
                {!account && <span className="small bad">{t('rest.noAccount')}</span>}
              </label>
            )}
            <label className="f">{t('contact.customer')}
              <select id="fs-customer" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">{t('rest.walkIn')}</option>
                {(customers.data ?? []).filter((c) => c.status === 'active' && c.name !== 'Walk-in customer').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
              {method === 'on_account' && !contactId && <span className="small bad">{t('rest.onAccountNeeds')}</span>}
            </label>
            <div className="row">
              <label className="f">{t('doc.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />{locked && <span className="small bad">{t('err.periodLocked')}</span>}</label>
              <label className="f">{t('rest.branch')}
                <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
                  <option value="">—</option>
                  {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
                </select>
              </label>
            </div>
            {books.canPost && <button id="fs-sell" className="b p wide" disabled={busy || !canSell} onClick={sell}>{t('rest.sell', { total: fmt(fromMinor(totals.net + totals.vat)) })}</button>}
            <p className="small mut">{t('rest.sellNote')}</p>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ menu (recipes)
export function MenuList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<Recipe[]>(`/api/companies/${books.company.id}/recipes?q=${encodeURIComponent(q)}`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('rest.searchMenu')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go('Restaurant', 'menu', 'new')}>{t('rest.newMenuItemPlus')}</button>}
      </div>
      <p className="mut small">{t('rest.menuHint')}</p>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('rest.noMenu')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('rest.menuItem')}</th><th>{t('rest.category')}</th><th className="num">{t('rest.priceIncl')}</th><th className="num">{t('rest.costPortion')}</th>
              <th className="num">{t('rest.foodCostPct')}</th><th className="num">{t('rest.margin')}</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id} className={r.status !== 'active' ? 'mut' : ''}>
                <td><button className="link" onClick={() => go('Restaurant', 'menu', r.id)}>{local(r.name, r.nameAr)}</button>
                  {r.lines.length === 0 && <span className="badge warn" style={{ marginInlineStart: 6 }}>{t('rest.noRecipe')}</span>}
                  {r.status !== 'active' && <span className="badge" style={{ marginInlineStart: 6 }}>{t('rest.offMenu')}</span>}</td>
                <td className="small" data-label={t('rest.category')}>{r.category ?? ''}</td>
                <td className="num ltr" data-label={t('rest.priceIncl')}>{fmt(fromMinor(withVat(r.salePrice, r.vatCode, books.company.vatRate)))}</td>
                <td className="num ltr" data-label={t('rest.costPortion')}>{fmt(r.cost)}</td>
                <td className="num" data-label={t('rest.foodCostPct')}><FoodCost pct={r.foodCostPct} /></td>
                <td className="num ltr" data-label={t('rest.margin')}>{fmt(r.margin)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

type Line = { itemId: string; quantity: string };

export function RecipePage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const rate = books.company.vatRate;
  const rec = useApi<Recipe>(isNew ? null : `/api/recipes/${id}`);
  const all = useApi<Recipe[]>(`/api/companies/${books.company.id}/recipes`);
  const items = useApi<Item[]>(`/api/companies/${books.company.id}/items`);
  const incomeAccounts = books.accounts.filter((a) => a.type === 'income');
  const [f, setF] = useState<{ name: string; nameAr: string; category: string; priceIncl: string; vatCode: VatCode; incomeAccountId: string; status: string; lines: Line[] }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (!f && (isNew || rec.data)) {
    const r = rec.data;
    setF({ name: r?.name ?? '', nameAr: r?.nameAr ?? '', category: r?.category ?? '', priceIncl: r ? fromMinor(withVat(r.salePrice, r.vatCode, rate)) : '',
      vatCode: r?.vatCode ?? 'standard', incomeAccountId: r?.incomeAccountId ?? incomeAccounts.find((a) => a.code === '4000')?.id ?? incomeAccounts[0]?.id ?? '',
      status: r?.status ?? 'active', lines: r ? [...r.lines.map((l) => ({ itemId: l.itemId, quantity: showQty(l.quantity) })), { itemId: '', quantity: '' }] : [{ itemId: '', quantity: '' }, { itemId: '', quantity: '' }] });
  }
  if (rec.error) return <ErrorNote error={rec.error} onRetry={rec.reload} />;
  if (!f || !items.data) return <Loading />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const setLine = (i: number, p: Partial<Line>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const byId = new Map(items.data.map((i) => [i.id, i]));
  const lineCost = (l: Line): bigint | null => {
    const it = byId.get(l.itemId); if (!it) return null;
    let q: bigint; try { q = quantityToMilli(l.quantity.trim()); } catch { return null; }
    const onHand = toMilli(it.qtyOnHand);
    return onHand > 0n ? divRoundHalfUp(q * toMinor(it.valueOnHand), onHand) : divRoundHalfUp(q * toMinor(it.averageCost), 1000n);
  };
  const used = f.lines.filter((l) => l.itemId);
  const cost = used.reduce((s, l) => s + (lineCost(l) ?? 0n), 0n);
  const incl = isAmount(f.priceIncl) ? toMinor(normalise(f.priceIncl)) : null;
  const split = incl === null ? null : netFromGross(incl, rate, f.vatCode);
  const pct = split && split.net > 0n ? Number((cost * 1000n) / split.net) / 10 : null;
  const badLine = used.some((l) => lineCost(l) === null);
  const dup = new Set(used.map((l) => l.itemId)).size !== used.length;
  const nameTaken = (all.data ?? []).some((r) => r.id !== id && r.name.trim().toLowerCase() === f.name.trim().toLowerCase());
  const canSave = books.canPost && f.name.trim() !== '' && split !== null && !badLine && !dup && !nameTaken;
  const categories = [...new Set((all.data ?? []).map((r) => r.category).filter(Boolean))] as string[];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true); setMsg({});
    try {
      const body = { name: f.name, nameAr: f.nameAr, category: f.category, salePrice: fromMinor(split!.net), vatCode: f.vatCode, incomeAccountId: f.incomeAccountId, status: f.status,
        lines: used.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })) };
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/recipes` : `/api/recipes/${id}`, { body });
      if (isNew) { go('Restaurant', 'menu', r.id); return; }
      setMsg({ ok: t('admin.saved') }); rec.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Restaurant', 'menu')}>{t('rest.backMenu')}</button>
      </div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('rest.newMenuItem') : local(f.name, f.nameAr)}</h2>
        <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('rest.menuItem')}<input id="rc-name" value={f.name} onChange={(e) => set({ name: e.target.value, nameAr: followArabic(f.name, e.target.value, f.nameAr) })} />
              {nameTaken && <span className="small bad">{t('err.recipeNameTaken')}</span>}</label>
            <label className="f">{t('ar.nameAr')}<input id="rc-name-ar" dir="rtl" value={f.nameAr} onChange={(e) => set({ nameAr: e.target.value })} /><ArabicHint english={f.name} arabic={f.nameAr} /></label>
            <label className="f">{t('rest.category')}<input id="rc-cat" list="rc-cats" value={f.category} placeholder={t('rest.categoryHint')} onChange={(e) => set({ category: e.target.value })} />
              <datalist id="rc-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
          </div>
          <div className="row">
            <label className="f">{t('rest.priceIncl')} ({books.company.currency})<input id="rc-price" inputMode="decimal" className="num ltr amount" value={f.priceIncl} onChange={(e) => set({ priceIncl: e.target.value })} />
              {split && <span className="small mut">{t('rest.priceSplit', { net: fmt(fromMinor(split.net)), vat: fmt(fromMinor(split.vat)) })}</span>}
              {split && split.rounding > 0n && <span className="small mut">{t('rest.priceRounded', { price: fmt(fromMinor(split.net + split.vat)) })}</span>}</label>
            <label className="f">{t('doc.vat')}
              <select value={f.vatCode} onChange={(e) => set({ vatCode: e.target.value as VatCode })}>
                {(['standard', 'zero', 'exempt', 'out_of_scope'] as const).map((v) => <option key={v} value={v}>{t(`vat.${v}` as Key, { rate: Number(rate) })}</option>)}
              </select>
            </label>
            <label className="f">{t('rest.incomeAccount')}
              <select value={f.incomeAccountId} onChange={(e) => set({ incomeAccountId: e.target.value })}>
                {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
      </form>
      <div className="card">
        <h3>{t('rest.recipe')}</h3>
        <p className="small mut">{t('rest.recipeHint')}</p>
        {items.data.length === 0 ? <p className="mut">{t('rest.addMaterialsFirst')} <button className="link" onClick={() => go('Restaurant', 'materials', 'new')}>{t('rest.newMaterial')}</button></p> : (
          <div className="wrap"><table className="doclines notelines">
            <thead><tr><th>{t('rest.material')}</th><th className="num">{t('rest.perPortion')}</th><th className="num">{t('rest.lineCost')}</th><th /></tr></thead>
            <tbody>{f.lines.map((l, i) => {
              const it = byId.get(l.itemId); const c = lineCost(l);
              return (
                <tr key={i}>
                  <td className="dl-desc">
                    <select value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })} aria-label={t('rest.material')} disabled={!books.canPost}>
                      <option value="">{t('rest.chooseMaterial')}</option>
                      {items.data!.filter((x) => x.status === 'active' || x.id === l.itemId).map((x) => <option key={x.id} value={x.id}>{local(x.name, x.nameAr)} ({x.unit})</option>)}
                    </select>
                  </td>
                  <td className="dl-qty"><input inputMode="decimal" className="num ltr" value={l.quantity} placeholder={it?.unit ?? ''} aria-label={t('rest.perPortion')}
                    onChange={(e) => setLine(i, { quantity: e.target.value })} disabled={!books.canPost} /></td>
                  <td className="num ltr dl-amt">{c === null ? (l.itemId ? <span className="bad small">{t('err.recipeQty')}</span> : '—') : fmt(fromMinor(c))}</td>
                  <td className="dl-x"><button className="b small" disabled={!books.canPost} onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })} aria-label={t('journal.removeLine')}>×</button></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {dup && <p className="small bad">{t('err.recipeDuplicate')}</p>}
        {books.canPost && <button className="b" onClick={() => set({ lines: [...f.lines, { itemId: '', quantity: '' }] })}>{t('journal.addLine')}</button>}
        <table className="totals"><tbody>
          <tr><td>{t('rest.costPortion')}</td><td className="num ltr">{fmt(fromMinor(cost))}</td></tr>
          <tr><td>{t('rest.priceNet')}</td><td className="num ltr">{split ? fmt(fromMinor(split.net)) : '—'}</td></tr>
          <tr><td>{t('rest.foodCostPct')}</td><td className="num"><FoodCost pct={pct} /></td></tr>
          <tr className="total"><td>{t('rest.margin')}</td><td className="num ltr">{split ? fmt(fromMinor(split.net - cost)) : '—'}</td></tr>
        </tbody></table>
      </div>
      {books.canPost && (
        <div className="actions">
          <button id="rc-save" className="b p" disabled={busy || !canSave} onClick={save}>{isNew ? t('rest.addToMenu') : t('admin.saveDetails')}</button>
          {!isNew && <label className="actions small"><input type="checkbox" checked={f.status !== 'active'} onChange={(e) => set({ status: e.target.checked ? 'archived' : 'active' })} />{t('rest.takeOff')}</label>}
        </div>
      )}
    </>
  );
}
