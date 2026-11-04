// The warehouse counter: goods in and goods out the way a till works. Scan a barcode (or type the item code and
// press Enter; "5*code" adds five), tap tiles, change quantities in the basket, then one button records and posts
// the goods received or delivery note. After goods in, labels can be printed for everything received.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { isLocked } from '../books/Workspace.tsx';
import { issueCost, milliToString, quantityToMilli, receivedValue } from '../../../src/books/inventory.ts';
import { cleanBarcode } from '../../../src/books/barcode.ts';
import { CameraScan, canScanWithCamera, usePrintLabels, type LabelItem } from './Barcode.tsx';
import { qty, type Item, type StockModule } from './Inventory.tsx';

type Way = 'in' | 'out';
interface Line { itemId: string; quantity: string; unitCost: string }
interface Done { id: string; number: string; totalValue: string; way: Way; labels: { item: LabelItem; copies: number }[] }

const milli = (q: string): bigint | null => { try { return quantityToMilli(q.trim()); } catch { return null; } };
const stockMilli = (q: string) => { const [w, f = ''] = q.split('.'); return BigInt(w!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3)); };
/** The quantity one up or one down (never below nothing): "2.5" + 1 = "3.5". */
const plus = (q: string, d: number) => { const n = (milli(q) ?? 0n) + BigInt(d) * 1000n; return n <= 0n ? '0' : qty(milliToString(n)); };

export function WarehouseDesk({ books, mod = 'Inventory' }: { books: CompanyBooks; mod?: StockModule }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const printLabels = usePrintLabels(books);
  const items = useApi<(Item & { barcode: string })[]>(`/api/companies/${books.company.id}/items`);
  const suppliers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=supplier`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const [way, setWay] = useState<Way>('in');
  const [basket, setBasket] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [find, setFind] = useState('');
  const [contactId, setContactId] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad?: string; unknown?: string; added?: string }>({});
  const [done, setDone] = useState<Done>();
  const [newName, setNewName] = useState('');
  const scanBox = useRef<HTMLInputElement>(null);
  useEffect(() => { scanBox.current?.focus(); }, [way]);

  const active = useMemo(() => (items.data ?? []).filter((i) => i.status === 'active'), [items.data]);
  const byId = useMemo(() => new Map(active.map((i) => [i.id, i])), [active]);
  const unitCostOf = (i: Item) => (toMinor(i.averageCost) > 0n ? i.averageCost : '');

  const add = (i: Item, n = 1) => {
    setDone(undefined);
    setBasket((b) => {
      const at = b.findIndex((l) => l.itemId === i.id);
      if (at < 0) return [{ itemId: i.id, quantity: String(n), unitCost: unitCostOf(i) }, ...b];
      return b.map((l, k) => (k === at ? { ...l, quantity: plus(l.quantity, n) } : l));
    });
    setMsg({ added: local(i.name, i.nameAr) });
  };
  const setLine = (id: string, p: Partial<Line>) => setBasket((b) => b.map((l) => (l.itemId === id ? { ...l, ...p } : l)));
  const remove = (id: string) => setBasket((b) => b.filter((l) => l.itemId !== id));

  /** A scan or a typed code: "5*4006381333931" adds five. Looks in the list first, then asks the server. */
  const onScan = async (raw: string) => {
    const m = /^\s*(\d{1,4})\s*[*xX×]\s*(.+)$/.exec(raw);
    const n = m ? Math.max(1, Number(m[1])) : 1;
    const code = cleanBarcode(m ? m[2] : raw);
    setScan('');
    if (!code) return;
    const hit = active.find((i) => i.barcode === code) ?? active.find((i) => i.sku.toLowerCase() === code.toLowerCase());
    if (hit) { add(hit, n); return; }
    try {
      const r = await api<{ item: (Item & { barcode: string }) | null }>(`/api/companies/${books.company.id}/items/by-code?code=${encodeURIComponent(code)}`);
      if (r.item) { add(r.item, n); items.reload(); return; }
    } catch { /* shown below as not found */ }
    setMsg({ unknown: code }); setNewName('');
  };

  /** A code nobody knows yet, on goods in: make the item with this barcode, then add it. */
  const createUnknown = async () => {
    if (!msg.unknown || !newName.trim()) return;
    setBusy(true);
    try {
      const sku = msg.unknown.slice(0, 24).toUpperCase();
      const r = await api<{ id: string }>(`/api/companies/${books.company.id}/items`, { body: { sku, barcode: msg.unknown, name: newName.trim(), unit: 'pcs' } });
      const i = await api<Item & { barcode: string }>(`/api/items/${r.id}`);
      items.reload(); add(i);
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); scanBox.current?.focus(); }
  };

  const rows = basket.map((l) => {
    const i = byId.get(l.itemId);
    const q = milli(l.quantity);
    const costOk = way === 'out' || isAmount(l.unitCost);
    const value = !i || q === null ? null : way === 'in' ? (costOk ? receivedValue(q, toMinor(normalise(l.unitCost))) : null) : (q <= stockMilli(i.qtyOnHand) ? issueCost(stockMilli(i.qtyOnHand), toMinor(i.valueOnHand), q) : null);
    const short = way === 'out' && i !== undefined && q !== null && q > stockMilli(i.qtyOnHand);
    return { l, i, q, costOk, value, short };
  }).filter((r) => r.i);
  const total = rows.reduce((s, r) => s + (r.value ?? 0n), 0n);
  const locked = isLocked(books, date);
  const problems = rows.some((r) => r.q === null || !r.costOk || r.short);
  const canPost = books.canPost && rows.length > 0 && !problems && !locked && !busy;

  const post = async () => {
    if (!canPost) return;
    setBusy(true); setMsg({});
    try {
      const r = await api<{ id: string; number: string; totalValue: string }>(`/api/companies/${books.company.id}/stock-notes/quick`, { body: {
        type: way === 'in' ? 'grn' : 'gdn', date, contactId: contactId || null, reference: reference.trim() || undefined,
        lines: rows.map((x) => ({ itemId: x.l.itemId, quantity: x.l.quantity.trim(), unitCost: way === 'in' ? normalise(x.l.unitCost) : null })) } });
      setDone({ ...r, way, labels: rows.map((x) => ({ item: x.i as LabelItem, copies: Math.ceil(Number(x.l.quantity)) })) });
      setBasket([]); setReference(''); items.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); scanBox.current?.focus(); }
  };

  if (items.error) return <ErrorNote error={items.error} onRetry={items.reload} />;
  if (!items.data) return <Loading />;
  const needle = find.trim().toLowerCase();
  const tiles = active.filter((i) => !needle || `${i.name} ${i.nameAr ?? ''} ${i.sku} ${i.barcode}`.toLowerCase().includes(needle)).slice(0, 60);
  const contacts = (way === 'in' ? suppliers.data : customers.data) ?? [];
  const word = (k: string) => t(`wh.${k}.${way}` as never);
  return (
    <>
      <div className="wh-way chips" role="radiogroup" aria-label={t('wh.way')}>
        {(['in', 'out'] as Way[]).map((w) => (
          <button key={w} id={`wh-${w}`} role="radio" aria-checked={way === w} className={`b ${way === w ? 'p' : ''}`}
            onClick={() => { if (w !== way) { setWay(w); setBasket([]); setContactId(''); setMsg({}); setDone(undefined); } }}>
            {t(`wh.way.${w}` as never)}
          </button>
        ))}
      </div>
      {done && (
        <div className="notice actions" id="wh-done" role="status">
          <span style={{ flex: 1 }}>{t(done.way === 'in' ? 'wh.doneIn' : 'wh.doneOut', { number: done.number, value: fmt(done.totalValue) })}</span>
          {done.way === 'in' && <button className="b small" id="wh-labels" onClick={() => printLabels(done.labels)}>{t('wh.printLabels')}</button>}
          {!books.access?.posMode && <button className="b small" onClick={() => go(mod, mod === 'Restaurant' ? (done.way === 'in' ? 'materials-in' : 'wastage') : done.way === 'in' ? 'grn' : 'gdn', done.id)}>{t('wh.openNote')}</button>}
        </div>
      )}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="pos">
        <div className="pos-menu">
          <div className="card">
            <div className="wh-scan">
              <input ref={scanBox} id="wh-scan" className="ltr" dir="ltr" value={scan} placeholder={t('wh.scanHere')} aria-label={t('wh.scanHere')} autoComplete="off"
                onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onScan(scan); } }} disabled={!books.canPost} />
              {canScanWithCamera() && <button className="b" id="wh-camera" onClick={() => setCamera(true)} disabled={!books.canPost}>{t('wh.camera')}</button>}
            </div>
            <p className="small mut" style={{ margin: '6px 0 0' }}>{t('wh.scanHint')}</p>
            {msg.added && !msg.unknown && <p className="small good" aria-live="polite" style={{ margin: '6px 0 0' }}>✓ {t('wh.added', { name: msg.added })}</p>}
            {msg.unknown && (
              <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
                {t('wh.unknown', { code: msg.unknown })}
                {way === 'in' && books.canPost && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <label className="f">{t('wh.newItemName')}<input id="wh-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createUnknown(); }} /></label>
                    <button className="b p" style={{ alignSelf: 'end', marginBottom: 12 }} disabled={busy || !newName.trim()} onClick={() => void createUnknown()}>{t('wh.createItem')}</button>
                  </div>
                )}
              </div>
            )}
            {camera && <CameraScan onCode={(c) => { setCamera(false); void onScan(c); }} onClose={() => setCamera(false)} />}
          </div>
          <div className="card">
            <input type="search" placeholder={t('wh.findItem')} aria-label={t('wh.findItem')} value={find} onChange={(e) => setFind(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
            {active.length === 0 ? <p className="mut small">{t('wh.noItems')}</p> : (
              <div className="menu-tiles">
                {tiles.map((i) => {
                  const inBasket = basket.find((l) => l.itemId === i.id);
                  const empty = way === 'out' && stockMilli(i.qtyOnHand) === 0n;
                  return (
                    <button key={i.id} className={`menu-tile ${inBasket ? 'on' : ''}`} onClick={() => add(i)} disabled={!books.canPost || empty}>
                      <b>{local(i.name, i.nameAr)}</b>
                      <span className="small mut ltr">{i.sku}</span>
                      <span className={`small ${i.low ? 'bad' : ''}`}>{t('wh.onHand', { n: qty(i.qtyOnHand), unit: i.unit })}</span>
                      {inBasket ? <span className="badge">× {qty(inBasket.quantity)}</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="card pos-order">
          <h3>{word('basket')}</h3>
          {rows.length === 0 ? <p className="mut small">{t('wh.empty')}</p> : (
            <div className="wh-basket">
              {rows.map(({ l, i, q, costOk, value, short }) => (
                <div key={l.itemId} className="wh-line">
                  <div className="wh-line-head">
                    <b>{local(i!.name, i!.nameAr)}</b>
                    <button className="link small" aria-label={t('wh.remove')} onClick={() => remove(l.itemId)}>{t('wh.remove')}</button>
                  </div>
                  <div className="small mut">{t('wh.onHand', { n: qty(i!.qtyOnHand), unit: i!.unit })}{short && <span className="bad"> · {t('wh.short')}</span>}</div>
                  <div className="wh-line-row">
                    <span className="qty-step">
                      <button className="b small" aria-label={t('rest.less')} onClick={() => { const n = plus(l.quantity, -1); if (n === '0') remove(l.itemId); else setLine(l.itemId, { quantity: n }); }}>−</button>
                      <input className="num ltr wh-qty" inputMode="decimal" value={l.quantity} aria-label={t('inv.qty')} aria-invalid={q === null || short} onChange={(e) => setLine(l.itemId, { quantity: e.target.value })} />
                      <button className="b small" aria-label={t('rest.more')} onClick={() => setLine(l.itemId, { quantity: plus(l.quantity, 1) })}>+</button>
                    </span>
                    {way === 'in' && (
                      <label className="small wh-cost">{t('wh.unitCost')}
                        <input inputMode="decimal" className="num ltr" value={l.unitCost} placeholder="0.00" onChange={(e) => setLine(l.itemId, { unitCost: e.target.value })} aria-invalid={l.unitCost.trim() !== '' && !costOk} />
                      </label>
                    )}
                    <b className="num ltr wh-value">{value === null ? '—' : fmt(fromMinor(value))}</b>
                  </div>
                  {way === 'in' && !l.unitCost.trim() && <div className="small mut">{t('wh.enterCost')}</div>}
                </div>
              ))}
            </div>
          )}
          <table className="totals"><tbody>
            <tr className="total"><td>{word('total')} ({books.company.currency})</td><td className="num ltr" id="wh-total">{fmt(fromMinor(total))}</td></tr>
          </tbody></table>
          <label className="f">{t(way === 'in' ? 'contact.supplier' : 'contact.customer')}
            <select id="wh-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">{t('wh.noContact')}</option>
              {contacts.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
            </select>
          </label>
          <div className="row">
            <label className="f">{t('doc.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />{locked && <span className="small bad">{t('err.periodLocked')}</span>}</label>
            <label className="f">{t('wh.reference')}<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t(`wh.refHint.${way}` as never)} /></label>
          </div>
          {books.canPost && <button id="wh-post" className="b p wide" disabled={!canPost} onClick={() => void post()}>{t(way === 'in' ? 'wh.postIn' : 'wh.postOut', { n: rows.length })}</button>}
          <p className="small mut">{word('note')}</p>
        </div>
      </div>
    </>
  );
}
