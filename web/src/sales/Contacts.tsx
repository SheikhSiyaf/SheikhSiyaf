// Customers and suppliers: list with balances, and one page per contact (details, documents, payments).
import { ActivityPanel } from '../crm/Crm.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';
import { StateBadge, moduleOfSide, useGo, type Contact, type DocRow, type PaymentRow, type Side } from './common.tsx';

const pageOf = (side: Side) => (side === 'sales' ? 'customers' : 'suppliers');

export function ContactList({ books, side }: { books: CompanyBooks; side: Side }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [q, setQ] = useState('');
  const list = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=${side === 'sales' ? 'customer' : 'supplier'}&q=${encodeURIComponent(q)}`);
  const m = moduleOfSide(side);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('contact.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {books.canPost && <button className="b p" onClick={() => go(m, pageOf(side), 'new')}>{t(side === 'sales' ? 'contact.newCustomer' : 'contact.newSupplier')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <div className="mut">{q ? t('admin.noMatch') : t(side === 'sales' ? 'contact.noCustomers' : 'contact.noSuppliers')}</div>
        ) : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('col.name')}</th><th>{t('contact.vatNumber')}</th><th>{t('contact.phone')}</th><th className="num">{t(side === 'sales' ? 'contact.theyOwe' : 'contact.weOwe')}</th></tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id} className={c.status !== 'active' ? 'mut' : ''}>
                    <td>
                      <button className="link" onClick={() => go(m, pageOf(side), c.id)}>{local(c.name, c.nameAr)}</button>
                      {c.status !== 'active' && <> <span className="badge">{t('contact.archived')}</span></>}
                    </td>
                    <td className="ltr small" data-label={t('contact.vatNumber')}>{c.vatNumber ?? '—'}</td>
                    <td className="ltr small" data-label={t('contact.phone')}>{c.phone ?? '—'}</td>
                    <td className="num ltr" data-label={t(side === 'sales' ? 'contact.theyOwe' : 'contact.weOwe')}>
                      {fmt(c.balanceDue ?? '0')} {toMinor(c.overdue ?? '0') > 0n && <span className="badge bad">{t('state.overdue')} {fmt(c.overdue)}</span>}
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

type Form = Record<string, string | boolean>;

export function ContactPage({ books, side, id }: { books: CompanyBooks; side: Side; id: string }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const c = useApi<Contact>(isNew ? null : `/api/contacts/${id}`);
  const m = moduleOfSide(side);
  const docs = useApi<DocRow[]>(isNew ? null : `/api/companies/${books.company.id}/documents?type=${side === 'sales' ? 'invoice' : 'bill'}&contactId=${id}`);
  const pays = useApi<PaymentRow[]>(isNew ? null : `/api/companies/${books.company.id}/payments?direction=${side === 'sales' ? 'received' : 'made'}&contactId=${id}`);
  const [f, setF] = useState<Form>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);

  if (!isNew && c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  if (!isNew && !c.data) return <Loading />;
  const base: Form = isNew
    ? { isCustomer: side === 'sales', isSupplier: side === 'purchases', country: books.company.country, name: '', nameAr: '', vatNumber: '', crNumber: '', email: '', phone: '', address: '', city: '', paymentTermsDays: '', buildingNumber: '', district: '', postalCode: '' }
    : Object.fromEntries(Object.entries(c.data!).map(([k, v]) => [k, typeof v === 'boolean' ? v : v === null || v === undefined ? '' : String(v)]));
  const form = f ?? base;
  const v = (k: string) => String(form[k] ?? '');
  const set = (k: string, val: string | boolean) => setF({ ...form, [k]: val });
  const readOnly = !books.canPost;

  const problem = (): string | undefined => {
    if (!v('name').trim()) return t('err.contactName');
    if (!form.isCustomer && !form.isSupplier) return t('err.contactRole');
    const vat = v('vatNumber').replace(/\s/g, '');
    if (vat && v('country') === 'SA' && !/^3\d{13}3$/.test(vat)) return t('v.saVat');
    if (vat && v('country') === 'AE' && !/^\d{15}$/.test(vat)) return t('v.aeTrn');
    if (v('email').trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email').trim())) return t('v.email');
    return undefined;
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const p = problem();
    if (p) { setMsg({ bad: p }); return; }
    setBusy(true); setMsg({});
    try {
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/contacts` : `/api/contacts/${id}`, { body: form });
      if (isNew) { go(m, pageOf(side), r.id); return; }
      setF(undefined); setMsg({ ok: t('admin.saved') }); c.reload();
    } catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };

  const balance = docs.data?.reduce((s, d) => s + (d.status === 'issued' ? toMinor(d.amountDue) : 0n), 0n) ?? 0n;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go(m, pageOf(side))}>{t(side === 'sales' ? 'contact.allCustomers' : 'contact.allSuppliers')}</button>
        <span className="spacer" />
        {!isNew && books.canPost && (
          <>
            <button className="b p" onClick={() => go(m, side === 'sales' ? 'invoices' : 'bills', 'new', id)}>{t(side === 'sales' ? 'ov.newInvoice' : 'ov.newBill')}</button>
            <button className="b" onClick={() => go(m, side === 'sales' ? 'payments-received' : 'payments-made', 'new', id)}>{t(side === 'sales' ? 'ov.recordReceipt' : 'ov.recordPayment')}</button>
          </>
        )}
      </div>
      {!isNew && (
        <div className="grid">
          <div className="card fig"><small>{t(side === 'sales' ? 'contact.theyOwe' : 'contact.weOwe')}</small><b className="ltr">{fmt(fromMinor(balance))}</b><small>{books.company.currency}</small></div>
        </div>
      )}
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t(side === 'sales' ? 'contact.newCustomerTitle' : 'contact.newSupplierTitle') : t('contact.details')}</h2>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('contact.name')}<input id="ct-name" value={v('name')}
              onChange={(e) => setF({ ...form, name: e.target.value, nameAr: followArabic(v('name'), e.target.value, v('nameAr')) })} /></label>
            <label className="f">{t('ar.nameAr')}<input id="ct-name-ar" dir="rtl" value={v('nameAr')} onChange={(e) => set('nameAr', e.target.value)} />
              <ArabicHint english={v('name')} arabic={v('nameAr')} /></label>
          </div>
          <div className="check-list" style={{ marginBottom: 10 }}>
            <label><input type="checkbox" checked={Boolean(form.isCustomer)} onChange={(e) => set('isCustomer', e.target.checked)} />{t('contact.customer')}</label>
            <label><input type="checkbox" checked={Boolean(form.isSupplier)} onChange={(e) => set('isSupplier', e.target.checked)} />{t('contact.supplier')}</label>
          </div>
          <div className="row">
            <label className="f">{t('col.country')}
              <select id="ct-country" value={v('country')} onChange={(e) => set('country', e.target.value)}>
                {['SA', 'AE', 'OM'].map((x) => <option key={x} value={x}>{t(`country.${x}` as 'country.SA')}</option>)}
                <option value="">{t('contact.otherCountry')}</option>
              </select>
            </label>
            <label className="f">{t('contact.vatNumber')}<input id="ct-vat" dir="ltr" value={v('vatNumber')} onChange={(e) => set('vatNumber', e.target.value)} placeholder={v('country') === 'SA' ? t('reg.vatHintSA') : v('country') === 'AE' ? t('reg.vatHintAE') : ''} /></label>
            <label className="f">{t('contact.crNumber')}<input id="ct-cr" dir="ltr" value={v('crNumber')} onChange={(e) => set('crNumber', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('reg.email')}<input id="ct-email" type="email" dir="ltr" value={v('email')} onChange={(e) => set('email', e.target.value)} /></label>
            <label className="f">{t('contact.phone')}<input id="ct-phone" type="tel" dir="ltr" value={v('phone')} onChange={(e) => set('phone', e.target.value)} /></label>
            <label className="f">{t('reg.paymentTerms')}<input id="ct-terms" type="number" min={0} max={365} value={v('paymentTermsDays')} placeholder={String(books.company.paymentTermsDays ?? 30)} onChange={(e) => set('paymentTermsDays', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f" style={{ flex: '2 1 260px' }}>{t('contact.address')}<input id="ct-address" value={v('address')} onChange={(e) => set('address', e.target.value)} /></label>
            <label className="f">{t('contact.city')}<input id="ct-city" value={v('city')} onChange={(e) => set('city', e.target.value)} /></label>
          </div>
          {v('country') === 'SA' && (
            <div className="row">
              <label className="f">{t('einv.building')}<input id="ct-building" dir="ltr" inputMode="numeric" maxLength={4} value={v('buildingNumber')} onChange={(e) => set('buildingNumber', e.target.value.replace(/\D/g, ''))} /></label>
              <label className="f">{t('einv.district')}<input id="ct-district" value={v('district')} onChange={(e) => set('district', e.target.value)} /></label>
              <label className="f">{t('einv.postal')}<input id="ct-postal" dir="ltr" inputMode="numeric" maxLength={5} value={v('postalCode')} onChange={(e) => set('postalCode', e.target.value.replace(/\D/g, ''))} /></label>
            </div>
          )}
          {v('country') === 'SA' && v('vatNumber') && !(v('buildingNumber') && v('district') && v('postalCode') && v('address') && v('city')) && <div className="notice small">{t('einv.addressHint')}</div>}
          {!isNew && (
            <label className="actions" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={v('status') === 'archived'} onChange={(e) => set('status', e.target.checked ? 'archived' : 'active')} />
              <span>{t('contact.archive')}</span>
            </label>
          )}
          {!readOnly && <button className="b p" type="submit" disabled={busy || (!isNew && !f)}>{isNew ? t('contact.create') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {!isNew && (
        <>
          <div className="card">
            <h2>{t(side === 'sales' ? 'sub.invoices' : 'sub.bills')}</h2>
            {!docs.data ? <Loading /> : docs.data.length === 0 ? <div className="mut">{t('none')}</div> : (
              <div className="wrap">
                <table className="stack">
                  <tbody>
                    {docs.data.map((d) => (
                      <tr key={d.id}>
                        <td><button className="link" onClick={() => go(m, side === 'sales' ? 'invoices' : 'bills', d.id)}>{d.number ?? t('state.draft')}</button></td>
                        <td data-label={t('doc.date')}>{d.issueDate}</td>
                        <td className="num ltr" data-label={t('doc.total')}>{fmt(d.grossTotal)}</td>
                        <td className="num ltr" data-label={t('doc.amountDue')}>{d.status === 'issued' ? fmt(d.amountDue) : ''}</td>
                        <td><StateBadge state={d.state} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card">
            <h2>{t(side === 'sales' ? 'sub.payments-received' : 'sub.payments-made')}</h2>
            {!pays.data ? <Loading /> : pays.data.length === 0 ? <div className="mut">{t('none')}</div> : (
              <div className="wrap">
                <table className="stack">
                  <tbody>
                    {pays.data.map((p) => (
                      <tr key={p.id}>
                        <td><button className="link" onClick={() => go(m, side === 'sales' ? 'payments-received' : 'payments-made', p.id)}>{p.number}</button></td>
                        <td data-label={t('doc.date')}>{p.date}</td>
                        <td className="num ltr" data-label={t('pay.amount')}>{fmt(p.amount)}</td>
                        <td>{p.voidedAt ? <StateBadge state="voided" /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {side === 'sales' && (books.company.modules ?? []).includes('CRM') && accessTo(books.access?.permissions, 'CRM') !== 'none' && <ActivityPanel books={{ ...books, canPost: books.canPost && accessTo(books.access?.permissions, 'CRM') === 'edit' }} link={{ contactId: id }} />}
        </>
      )}
    </>
  );
}
