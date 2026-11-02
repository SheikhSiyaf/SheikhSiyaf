// Payments received (from customers) and made (to suppliers): list, record, view and void.
import { useEffect, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { isLocked, lockedUpTo } from '../books/Workspace.tsx';
import { autoAllocate } from '../../../src/books/documents.ts';
import { StateBadge, bankAccounts, moduleOfSide, useGo, type Contact, type Direction, type PaymentRow } from './common.tsx';

const METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;
const pageOf = (d: Direction) => (d === 'received' ? 'payments-received' : 'payments-made');
const sideOfDir = (d: Direction): 'sales' | 'purchases' => (d === 'received' ? 'sales' : 'purchases');

export function PaymentList({ books, direction }: { books: CompanyBooks; direction: Direction }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<PaymentRow[]>(`/api/companies/${books.company.id}/payments?direction=${direction}&q=${encodeURIComponent(q)}`);
  const m = moduleOfSide(sideOfDir(direction));
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('pay.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go(m, pageOf(direction), 'new')}>{t(direction === 'received' ? 'ov.recordReceipt' : 'ov.recordPayment')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('pay.noneYet')}</div> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('doc.number')}</th><th>{t(direction === 'received' ? 'contact.customer' : 'contact.supplier')}</th><th>{t('doc.date')}</th><th>{t('pay.method')}</th><th className="num">{t('pay.amount')}</th><th /></tr></thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id} className={p.voidedAt ? 'mut' : ''}>
                    <td><button className="link" onClick={() => go(m, pageOf(direction), p.id)}>{p.number}</button>{p.reference && <div className="mut small ltr">{p.reference}</div>}</td>
                    <td>{p.contactName}</td>
                    <td data-label={t('doc.date')}>{p.date}</td>
                    <td className="small" data-label={t('pay.method')}>{t(`method.${p.method}` as Key)} · {local(p.accountName, p.accountNameAr)}</td>
                    <td className="num ltr" data-label={t('pay.amount')}>{fmt(p.amount)}</td>
                    <td>{p.voidedAt ? <StateBadge state="voided" /> : toMinor(p.unallocated) > 0n ? <span className="badge warn">{t('pay.onAccount')} {fmt(p.unallocated)}</span> : null}</td>
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

interface OpenDoc { id: string; number: string; issueDate: string; dueDate: string | null; grossTotal: string; amountDue: string }

export function PaymentForm({ books, direction, presetContactId, presetDocId }: { books: CompanyBooks; direction: Direction; presetContactId?: string; presetDocId?: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const m = moduleOfSide(sideOfDir(direction));
  const contacts = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=${direction === 'received' ? 'customer' : 'payee'}`);
  const banks = bankAccounts(books);
  const [contactId, setContactId] = useState(presetContactId ?? '');
  const open = useApi<OpenDoc[]>(contactId ? `/api/companies/${books.company.id}/open-documents?contactId=${contactId}&direction=${direction}` : null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(banks[0]?.id ?? '');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('bank_transfer');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tried, setTried] = useState(false);

  // Coming from an invoice: pay exactly what is due on it.
  useEffect(() => {
    if (!open.data) return;
    const preset = presetDocId && open.data.find((d) => d.id === presetDocId);
    if (preset && !amount) { setAmount(preset.amountDue); setAlloc({ [preset.id]: preset.amountDue }); setManual(true); }
  }, [open.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settle oldest first as the amount is typed, until the person changes a line themselves.
  const autoFill = (amt: string) => {
    if (!open.data || !isAmount(amt)) { setAlloc({}); return; }
    const parts = autoAllocate(toMinor(normalise(amt)), open.data.map((d) => ({ id: d.id, due: toMinor(d.amountDue) })));
    setAlloc(Object.fromEntries(parts.map((p) => [p.id, fromMinor(p.amount)])));
  };
  const onAmount = (v: string) => { setAmount(v); if (!manual) autoFill(v); };
  const onContact = (id: string) => { setContactId(id); setAlloc({}); setManual(false); setAmount(''); };

  const toEmployee = Boolean(contacts.data?.find((c) => c.id === contactId)?.isEmployee);
  const amt = isAmount(amount) ? toMinor(normalise(amount)) : null;
  const allocated = Object.values(alloc).reduce((s, v) => s + (isAmount(v) ? toMinor(normalise(v)) : 0n), 0n);
  const problems: string[] = [];
  if (!contactId) problems.push(t(direction === 'received' ? 'doc.pickCustomer' : 'doc.pickSupplier'));
  if (!amt || amt <= 0n) problems.push(t('err.amount'));
  if (!accountId) problems.push(t('err.bankAccount'));
  if (date && isLocked(books, date)) problems.push(t('journal.dateLocked', { date: lockedUpTo(books) ?? '' }));
  for (const d of open.data ?? []) {
    const v = alloc[d.id];
    if (v && (!isAmount(v) || toMinor(normalise(v)) > toMinor(d.amountDue))) problems.push(t('pay.tooMuchOn', { number: d.number, due: fmt(d.amountDue) }));
  }
  if (amt !== null && allocated > amt) problems.push(t('err.overAllocated'));
  const onAccount = amt !== null && allocated <= amt ? amt - allocated : 0n;

  const save = async () => {
    setTried(true);
    if (problems.length) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ id: string }>(`/api/companies/${books.company.id}/payments`, { body: {
        direction, contactId, date, amount: normalise(amount), accountId, method, reference,
        allocations: Object.entries(alloc).filter(([, v]) => isAmount(v) && toMinor(normalise(v)) > 0n).map(([documentId, v]) => ({ documentId, amount: normalise(v) })),
      } });
      go(m, pageOf(direction), r.id);
    } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };

  const cur = books.company.currency;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go(m, pageOf(direction))}>{t(direction === 'received' ? 'pay.backReceived' : 'pay.backMade')}</button>
        <h2 style={{ margin: 0 }}>{t(direction === 'received' ? 'ov.recordReceipt' : 'ov.recordPayment')}</h2>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <div className="card">
        <div className="row">
          <label className="f" style={{ flex: '2 1 240px' }}>{t(direction === 'received' ? 'pay.from' : 'pay.to')}
            <select id="pay-contact" value={contactId} onChange={(e) => onContact(e.target.value)}>
              <option value="">{t(direction === 'received' ? 'doc.pickCustomer' : 'doc.pickSupplier')}</option>
              {(contacts.data ?? []).filter((c) => c.status === 'active').map((c) => (
                <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}{c.balanceDue && toMinor(c.balanceDue) > 0n ? ` · ${fmt(c.balanceDue)}` : ''}</option>
              ))}
            </select>
          </label>
          <label className="f">{t('pay.amount')} ({cur})<input id="pay-amount" inputMode="decimal" className="num ltr" value={amount} onChange={(e) => onAmount(e.target.value)} placeholder="0.00" /></label>
          <label className="f">{t('doc.date')}<input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <div className="row">
          <label className="f">{t(direction === 'received' ? 'pay.intoAccount' : 'pay.fromAccount')}
            <select id="pay-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {banks.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
            </select>
          </label>
          <label className="f">{t('pay.method')}
            <select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
              {METHODS.map((x) => <option key={x} value={x}>{t(`method.${x}` as Key)}</option>)}
            </select>
          </label>
          <label className="f">{t('pay.reference')}<input id="pay-ref" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('pay.referenceHint')} /></label>
        </div>
      </div>

      {contactId && (
        <div className="card">
          <div className="actions" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{t(direction === 'received' ? 'pay.whichInvoices' : toEmployee ? 'pay.whichClaims' : 'pay.whichBills')}</h2>
            <span className="spacer" />
            {open.data && open.data.length > 0 && <button className="link small" onClick={() => { setManual(false); autoFill(amount); }}>{t('pay.oldestFirst')}</button>}
          </div>
          {!open.data ? <Loading /> : open.data.length === 0 ? <div className="mut">{t(direction === 'received' ? 'pay.nothingOpenSales' : toEmployee ? 'pay.nothingOpenClaims' : 'pay.nothingOpenPurchases')}</div> : (
            <div className="wrap">
              <table className="stack">
                <thead><tr><th>{t('doc.number')}</th><th>{t('doc.dueDate')}</th><th className="num">{t('doc.amountDue')}</th><th className="num">{t('pay.settle')}</th></tr></thead>
                <tbody>
                  {open.data.map((d) => (
                    <tr key={d.id}>
                      <td>{d.number}<div className="mut small">{d.issueDate}</div></td>
                      <td data-label={t('doc.dueDate')} className={d.dueDate && d.dueDate < today() ? 'bad' : ''}>{d.dueDate ?? '—'}</td>
                      <td className="num ltr" data-label={t('doc.amountDue')}>{fmt(d.amountDue)}</td>
                      <td className="num" data-label={t('pay.settle')}>
                        <input inputMode="decimal" className="num ltr amount" style={{ width: 160 }} value={alloc[d.id] ?? ''} aria-label={`${t('pay.settle')} ${d.number}`}
                          onChange={(e) => { setManual(true); setAlloc({ ...alloc, [d.id]: e.target.value }); }} placeholder="0.00" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <table className="totals">
            <tbody>
              <tr><td>{t('pay.settling')}</td><td className="num ltr">{fmt(fromMinor(allocated))}</td></tr>
              {onAccount > 0n && <tr><td>{t('pay.onAccount')}</td><td className="num ltr">{fmt(fromMinor(onAccount))}</td></tr>}
            </tbody>
          </table>
          {onAccount > 0n && <p className="mut small">{t(direction === 'received' ? 'pay.onAccountHintSales' : 'pay.onAccountHintPurchases')}</p>}
        </div>
      )}

      {tried && problems.length > 0 && <ul className="bad small" style={{ margin: '0 0 10px', paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="actions">
        <button className="b p" disabled={busy || (tried && problems.length > 0)} onClick={() => void save()}>{t('pay.save')}</button>
        <span className="mut small">{t('pay.saveHint')}</span>
      </div>
    </>
  );
}

interface PaymentDetail extends PaymentRow {
  allocations: { documentId: string; number: string; type: string; issueDate: string; grossTotal: string; amount: string }[];
}

export function PaymentView({ books, direction, id }: { books: CompanyBooks; direction: Direction; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const p = useApi<PaymentDetail>(`/api/payments/${id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (p.error) return <ErrorNote error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const x = p.data;
  const m = moduleOfSide(sideOfDir(direction));
  const todayLocked = isLocked(books, today());
  const voidIt = async () => {
    setConfirm(false); setBusy(true); setError(undefined);
    try { await api(`/api/payments/${id}/void`, { body: { date: today() } }); p.reload(); } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go(m, pageOf(direction))}>{t(direction === 'received' ? 'pay.backReceived' : 'pay.backMade')}</button>
        <span className="spacer" />
        {books.canPost && !x.voidedAt && <button className="b" disabled={busy || todayLocked} title={todayLocked ? t('journal.reverseLocked') : undefined} onClick={() => setConfirm(true)}>{t('pay.void')}</button>}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {confirm && <ConfirmBar message={t('pay.voidConfirm')} busy={busy} onYes={() => void voidIt()} onNo={() => setConfirm(false)} />}
      <div className="card paper">
        <div className="paper-head">
          <div>
            <div className="paper-title">{t(direction === 'received' ? 'pay.receiptTitle' : 'pay.paymentTitle')}</div>
            <div className="paper-no ltr">{x.number}</div>
          </div>
          {x.voidedAt && <StateBadge state="voided" />}
        </div>
        <table>
          <tbody>
            <tr><td className="mut">{t(direction === 'received' ? 'pay.from' : 'pay.to')}</td><td><button className="link" onClick={() => (x.allocations.some((a) => a.type === 'claim') ? go('Ledger', 'employee-ledger', x.contactId) : go(m, direction === 'received' ? 'customers' : 'suppliers', x.contactId))}>{x.contactName}</button></td></tr>
            <tr><td className="mut">{t('doc.date')}</td><td>{x.date}</td></tr>
            <tr><td className="mut">{t('pay.amount')}</td><td className="ltr"><b>{fmt(x.amount)} {books.company.currency}</b></td></tr>
            <tr><td className="mut">{t(direction === 'received' ? 'pay.intoAccount' : 'pay.fromAccount')}</td><td>{local(x.accountName, x.accountNameAr)} · {t(`method.${x.method}` as Key)}</td></tr>
            {x.reference && <tr><td className="mut">{t('pay.reference')}</td><td className="ltr">{x.reference}</td></tr>}
            {toMinor(x.unallocated) > 0n && <tr><td className="mut">{t('pay.onAccount')}</td><td className="ltr">{fmt(x.unallocated)}</td></tr>}
          </tbody>
        </table>
        {x.allocations.length > 0 && (
          <>
            <h2 style={{ fontSize: 15, marginTop: 14 }}>{t(direction === 'received' ? 'pay.settledInvoices' : x.allocations.some((a) => a.type === 'claim') ? 'pay.settledClaims' : 'pay.settledBills')}</h2>
            <table className="stack"><tbody>
              {x.allocations.map((a) => (
                <tr key={a.documentId}>
                  <td><button className="link" onClick={() => (a.type === 'claim' ? go('Expenses', 'claims', a.documentId) : go(m, direction === 'received' ? 'invoices' : 'bills', a.documentId))}>{a.number}</button></td>
                  <td>{a.issueDate}</td>
                  <td className="num ltr">{fmt(a.amount)}</td>
                </tr>
              ))}
            </tbody></table>
          </>
        )}
        <p className="mut small">{x.voidedAt ? t('pay.voidedNote') : t('pay.postedNote')}</p>
      </div>
    </>
  );
}
