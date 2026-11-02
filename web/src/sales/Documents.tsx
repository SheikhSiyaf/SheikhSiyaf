// Quotations, invoices, credit notes, bills and supplier credits: list, editor (drafts) and view.
import { useMemo, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { isLocked, lockedUpTo } from '../books/Workspace.tsx';
import { pageForType } from '../books/nav.ts';
import { documentTotals, priceLine, type VatCode } from '../../../src/books/documents.ts';
import { StateBadge, lineAccounts, moduleOfSide, sideOf, useGo, type Contact, type DocDetail, type DocRow, type DocType } from './common.tsx';

const FILTERS: Record<string, string[]> = {
  quotation: ['all', 'draft', 'sent', 'accepted', 'declined', 'invoiced'],
  invoice: ['all', 'draft', 'unpaid', 'overdue', 'paid'],
  bill: ['all', 'draft', 'unpaid', 'overdue', 'paid'],
  credit_note: ['all', 'draft', 'issued'],
  supplier_credit: ['all', 'draft', 'issued'],
};

// ------------------------------------------------------------------ list
export function DocList({ books, type, filter }: { books: CompanyBooks; type: DocType; filter?: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState(filter ?? 'all');
  const [q, setQ] = useState('');
  const side = sideOf(type);
  const m = moduleOfSide(side);
  const page = pageForType(type);
  const list = useApi<DocRow[]>(`/api/companies/${books.company.id}/documents?type=${type}&status=${status}&q=${encodeURIComponent(q)}`);
  const canCreate = books.canPost && (type === 'invoice' || type === 'quotation' || type === 'bill');
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('doc.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        {canCreate && <button className="b p" onClick={() => go(m, page, 'new')}>{t(`doc.new.${type}` as Key)}</button>}
      </div>
      <div className="chips" role="tablist" style={{ marginBottom: 10 }}>
        {FILTERS[type]!.map((s) => (
          <button key={s} role="tab" aria-selected={s === status} className={`b small ${s === status ? 'p' : ''}`} onClick={() => setStatus(s)}>
            {t(`filter.${s}` as Key)}
          </button>
        ))}
      </div>
      {(type === 'credit_note' || type === 'supplier_credit') && <p className="mut small">{t(type === 'credit_note' ? 'doc.creditHowTo' : 'doc.supplierCreditHowTo')}</p>}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('doc.noneYet')}</div> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('doc.number')}</th><th>{t(side === 'sales' ? 'contact.customer' : 'contact.supplier')}</th><th>{t('doc.date')}</th>
                {type !== 'quotation' && !type.includes('credit') && <th>{t('doc.dueDate')}</th>}<th className="num">{t('doc.total')}</th>
                {(type === 'invoice' || type === 'bill') && <th className="num">{t('doc.amountDue')}</th>}<th>{t('journal.status')}</th></tr></thead>
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id}>
                    <td><button className="link" onClick={() => go(m, page, d.id)}>{d.number ?? t('doc.draftNo')}</button>{d.reference && <div className="mut small ltr">{d.reference}</div>}</td>
                    <td>{local(d.contactName, d.contactNameAr)}</td>
                    <td data-label={t('doc.date')}>{d.issueDate}</td>
                    {type !== 'quotation' && !type.includes('credit') && <td data-label={t('doc.dueDate')}>{d.dueDate ?? '—'}</td>}
                    <td className="num ltr" data-label={t('doc.total')}>{fmt(d.grossTotal)}</td>
                    {(type === 'invoice' || type === 'bill') && <td className="num ltr" data-label={t('doc.amountDue')}>{d.status === 'issued' ? fmt(d.amountDue) : ''}</td>}
                    <td><StateBadge state={d.state} /></td>
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

// ------------------------------------------------------------------ editor
interface EditLine { description: string; quantity: string; unitPrice: string; accountId: string; costCentreId: string; vatCode: VatCode }

export function DocEditor({ books, type, id, presetContactId }: { books: CompanyBooks; type: DocType; id?: string; presetContactId?: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const side = sideOf(type);
  const m = moduleOfSide(side);
  const page = pageForType(type);
  const existing = useApi<DocDetail>(id ? `/api/documents/${id}` : null);
  const contacts = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=${side === 'sales' ? 'customer' : 'supplier'}`);
  const accounts = lineAccounts(books, side);
  const defaultAccount = accounts.find((a) => a.code === (side === 'sales' ? '4000' : '5400'))?.id ?? accounts[0]?.id ?? '';
  const registered = books.company.vatStatus !== 'unregistered';
  const blankLine = (): EditLine => ({ description: '', quantity: '1', unitPrice: '', accountId: defaultAccount, costCentreId: '', vatCode: registered ? 'standard' : 'out_of_scope' });

  const [form, setForm] = useState<{ contactId: string; issueDate: string; dueDate: string; dueTouched: boolean; reference: string; notes: string; lines: EditLine[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tried, setTried] = useState(false);

  const termsFor = (contactId: string) => contacts.data?.find((c) => c.id === contactId)?.paymentTermsDays ?? books.company.paymentTermsDays ?? 30;
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const hasDue = type === 'invoice' || type === 'bill' || type === 'quotation';

  // Fill the form once the draft (or contacts, for a new document) are loaded.
  if (!form && (id ? existing.data : contacts.data)) {
    const d = existing.data;
    const contactId = d?.contactId ?? presetContactId ?? '';
    setForm(d ? {
      contactId, issueDate: d.issueDate, dueDate: d.dueDate ?? '', dueTouched: true, reference: d.reference ?? '', notes: d.notes ?? '',
      lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity.replace(/\.?0+$/, ''), unitPrice: l.unitPrice, accountId: l.accountId, costCentreId: l.costCentreId ?? '', vatCode: l.vatCode as VatCode })),
    } : {
      contactId, issueDate: today(), dueDate: hasDue ? addDays(today(), contactId ? termsFor(contactId) : books.company.paymentTermsDays ?? 30) : '',
      dueTouched: false, reference: '', notes: '', lines: [blankLine()],
    });
  }

  const priced = useMemo(() => (form?.lines ?? []).map((l) => {
    try {
      return isAmount(l.unitPrice || '0') && /^\d+(\.\d{1,3})?$/.test(l.quantity) && Number(l.quantity) > 0
        ? priceLine({ ...l, unitPrice: normalise(l.unitPrice || '0') }, books.company.vatRate) : null;
    } catch { return null; }
  }), [form, books.company.vatRate]);
  const totals = documentTotals(priced.filter((x) => x !== null));

  if (id && existing.error) return <ErrorNote error={existing.error} onRetry={existing.reload} />;
  if (!form) return <Loading />;
  if (existing.data && existing.data.status !== 'draft') return <DocView books={books} id={id!} />;

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const setLine = (i: number, patch: Partial<EditLine>) => set({ lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setContact = (contactId: string) => set({ contactId, ...(form.dueTouched || !hasDue ? {} : { dueDate: addDays(form.issueDate, termsFor(contactId)) }) });
  const setIssueDate = (issueDate: string) => set({ issueDate, ...(form.dueTouched || !hasDue ? {} : { dueDate: addDays(issueDate, termsFor(form.contactId)) }) });

  // Everything the database would refuse, said first in plain words.
  const problems: string[] = [];
  if (!form.contactId) problems.push(t(side === 'sales' ? 'doc.pickCustomer' : 'doc.pickSupplier'));
  if (!form.issueDate) problems.push(t('err.date'));
  if (form.dueDate && form.issueDate && form.dueDate < form.issueDate) problems.push(t('err.dueDate'));
  if (form.lines.length === 0) problems.push(t('err.noLines'));
  form.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description.trim()) problems.push(t('doc.lineNeedsDescription', { n }));
    if (!priced[i]) problems.push(t('doc.lineNeedsNumbers', { n }));
    if (!l.accountId) problems.push(t('doc.lineNeedsAccount', { n }));
    const acct = books.accounts.find((a) => a.id === l.accountId);
    if (acct?.costCentreRequired && !l.costCentreId) problems.push(t('journal.needCostCentre', { account: `${acct.code} ${local(acct.name, acct.nameAr)}` }));
  });
  const willPost = type !== 'quotation';
  if (willPost && form.issueDate && isLocked(books, form.issueDate)) problems.push(t('journal.dateLocked', { date: lockedUpTo(books) ?? '' }));

  const body = () => ({
    type, contactId: form.contactId, issueDate: form.issueDate, dueDate: form.dueDate || null, reference: form.reference, notes: form.notes,
    lines: form.lines.map((l) => ({ ...l, unitPrice: normalise(l.unitPrice || '0'), costCentreId: l.costCentreId || null })),
  });
  const save = async (andIssue: boolean) => {
    setTried(true);
    if (andIssue && problems.length) return;
    if (!andIssue && (!form.contactId || !form.issueDate)) return;
    setBusy(true); setError(undefined);
    try {
      const saved = id ? await api<{ id: string }>(`/api/documents/${id}`, { body: body() })
        : await api<{ id: string }>(`/api/companies/${books.company.id}/documents`, { body: body() });
      if (andIssue) {
        if (type === 'quotation') await api(`/api/documents/${saved.id}/quotation-status`, { body: { status: 'sent' } });
        else await api(`/api/documents/${saved.id}/issue`, { body: {} });
      }
      go(m, page, saved.id);
      if (id === saved.id) existing.reload();
    } catch (e) { setError(errorText(t, has, e)); window.scrollTo(0, 0); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api(`/api/documents/${id}/delete`, { body: {} }); go(m, page); } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };

  const cur = books.company.currency;
  const isCreditDoc = type === 'credit_note' || type === 'supplier_credit';
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go(m, page)}>{t(`doc.back.${type}` as Key)}</button>
        <h2 style={{ margin: 0, flex: '1 1 auto' }}>{id ? t(`doc.edit.${type}` as Key) : t(`doc.new.${type}` as Key).replace(/^\+\s*/, '')}</h2>
        <StateBadge state="draft" />
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {isCreditDoc && <div className="notice">{t('doc.creditEditHint', { ref: form.reference })}</div>}

      <div className="card">
        <div className="row">
          <label className="f" style={{ flex: '2 1 240px' }}>{t(side === 'sales' ? 'contact.customer' : 'contact.supplier')}
            <select id="doc-contact" value={form.contactId} onChange={(e) => setContact(e.target.value)} disabled={isCreditDoc}
              style={tried && !form.contactId ? { borderColor: 'var(--bad)' } : undefined}>
              <option value="">{t(side === 'sales' ? 'doc.pickCustomer' : 'doc.pickSupplier')}</option>
              {(contacts.data ?? []).filter((c) => c.status === 'active' || c.id === form.contactId).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
            </select>
          </label>
          <label className="f">{t('doc.date')}<input id="doc-date" type="date" value={form.issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
          {hasDue && (
            <label className="f">{t(type === 'quotation' ? 'doc.validUntil' : 'doc.dueDate')}
              <input id="doc-due" type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value, dueTouched: true })} />
            </label>
          )}
          <label className="f">{t(side === 'sales' ? 'doc.referenceSales' : 'doc.referencePurchases')}
            <input id="doc-ref" value={form.reference} onChange={(e) => set({ reference: e.target.value })} dir="ltr" disabled={isCreditDoc} />
          </label>
        </div>
        {!isCreditDoc && books.canPost && (
          <button type="button" className="link small" onClick={() => go(m, side === 'sales' ? 'customers' : 'suppliers', 'new')}>
            {t(side === 'sales' ? 'doc.addCustomer' : 'doc.addSupplier')}
          </button>
        )}
      </div>

      <div className="card">
        <div className="wrap">
          <table className="doclines">
            <thead><tr><th>{t('doc.description')}</th><th className="num">{t('doc.qty')}</th><th className="num">{t('doc.price')}</th><th>{t('doc.vat')}</th><th>{t('journal.account')}</th><th>{t('journal.costCentre')}</th><th className="num">{t('doc.amount')}</th><th /></tr></thead>
            <tbody>
              {form.lines.map((l, i) => {
                const acct = books.accounts.find((a) => a.id === l.accountId);
                return (
                  <tr key={i}>
                    <td className="dl-desc"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder={t('doc.description')} aria-label={t('doc.description')} /></td>
                    <td className="dl-qty"><input inputMode="decimal" className="num ltr" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={t('doc.qty')} placeholder={t('doc.qty')} /></td>
                    <td className="dl-price"><input inputMode="decimal" className="num ltr" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} aria-label={t('doc.price')} placeholder={t('doc.price')} /></td>
                    <td className="dl-vat">
                      <select value={l.vatCode} onChange={(e) => setLine(i, { vatCode: e.target.value as VatCode })} aria-label={t('doc.vat')}>
                        {(['standard', 'zero', 'exempt', 'out_of_scope'] as const).map((c) => (
                          <option key={c} value={c}>{c === 'standard' ? t('vat.standard', { rate: Number(books.company.vatRate) }) : t(`vat.${c}` as Key)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="dl-acct">
                      <select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} aria-label={t('journal.account')}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}{a.costCentreRequired ? ' *' : ''}</option>)}
                      </select>
                    </td>
                    <td className="dl-cc">
                      <select value={l.costCentreId} onChange={(e) => setLine(i, { costCentreId: e.target.value })} aria-label={t('journal.costCentre')}
                        style={acct?.costCentreRequired && !l.costCentreId ? { borderColor: 'var(--bad)' } : undefined}>
                        <option value="">{t('journal.costCentre')}: —</option>
                        {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
                      </select>
                    </td>
                    <td className="num ltr dl-amt">{priced[i] ? fmt(fromMinor(priced[i]!.net)) : '—'}</td>
                    <td className="dl-x"><button className="b small" disabled={form.lines.length <= 1} onClick={() => set({ lines: form.lines.filter((_, j) => j !== i) })} aria-label={t('journal.removeLine')}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button className="b" style={{ marginTop: 8 }} onClick={() => set({ lines: [...form.lines, blankLine()] })}>{t('journal.addLine')}</button>
        <Totals net={fromMinor(totals.net)} vat={fromMinor(totals.vat)} gross={fromMinor(totals.gross)} cur={cur} />
        <label className="f" style={{ marginTop: 10 }}>{t('doc.notes')}<textarea id="doc-notes" rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder={t('doc.notesHint')} /></label>
      </div>

      {tried && problems.length > 0 && (
        <ul className="bad small" style={{ margin: '0 0 10px', paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      {confirmDelete && <ConfirmBar message={t('doc.deleteConfirm')} busy={busy} onYes={() => void remove()} onNo={() => setConfirmDelete(false)} />}
      <div className="actions">
        <button className="b p" disabled={busy || (tried && problems.length > 0)} onClick={() => void save(true)}>{t(`doc.issue.${type}` as Key)}</button>
        <button className="b" disabled={busy} onClick={() => void save(false)}>{t('doc.saveDraft')}</button>
        {id && <button className="b" disabled={busy} onClick={() => setConfirmDelete(true)}>{t('doc.deleteDraft')}</button>}
        <span className="mut small">{t(willPost ? 'doc.issueHint' : 'doc.quoteHint')}</span>
      </div>
    </>
  );
}

function Totals({ net, vat, gross, cur, due }: { net: string; vat: string; gross: string; cur: string; due?: string }) {
  const { t } = useI18n();
  return (
    <table className="totals">
      <tbody>
        <tr><td>{t('doc.subtotal')}</td><td className="num ltr">{fmt(net)}</td></tr>
        <tr><td>{t('doc.vatTotal')}</td><td className="num ltr">{fmt(vat)}</td></tr>
        <tr className="total"><td>{t('doc.total')} ({cur})</td><td className="num ltr">{fmt(gross)}</td></tr>
        {due !== undefined && <tr className="total"><td>{t('doc.amountDue')}</td><td className="num ltr">{fmt(due)}</td></tr>}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ view
export function DocView({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const d = useApi<DocDetail>(`/api/documents/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  if (x.status === 'draft' && books.canPost) return <DocEditor books={books} type={x.type} id={x.id} />;
  const side = sideOf(x.type);
  const m = moduleOfSide(side);
  const cur = books.company.currency;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await fn(); d.reload(); } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const due = x.status === 'issued' && (x.type === 'invoice' || x.type === 'bill');
  const canPay = books.canPost && due && toMinor(x.amountDue) > 0n;
  const title = t(`doc.title.${x.type}` as Key);
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go(m, pageForType(x.type))}>{t(`doc.back.${x.type}` as Key)}</button>
        <span className="spacer" />
        {canPay && <button className="b p" onClick={() => go(m, side === 'sales' ? 'payments-received' : 'payments-made', 'new', x.contactId, x.id)}>{t(side === 'sales' ? 'ov.recordReceipt' : 'ov.recordPayment')}</button>}
        {books.canPost && due && <button className="b" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ id: string }>(`/api/documents/${x.id}/credit`, { body: {} });
          go(m, x.type === 'invoice' ? 'credit-notes' : 'supplier-credits', r.id);
        })}>{t(x.type === 'invoice' ? 'doc.createCredit' : 'doc.createSupplierCredit')}</button>}
        {books.canPost && x.type === 'quotation' && (
          <>
            {x.status === 'draft' && <button className="b p" disabled={busy} onClick={() => void run(() => api(`/api/documents/${x.id}/quotation-status`, { body: { status: 'sent' } }))}>{t('doc.markSent')}</button>}
            {['sent', 'declined'].includes(x.status) && <button className="b" disabled={busy} onClick={() => void run(() => api(`/api/documents/${x.id}/quotation-status`, { body: { status: 'accepted' } }))}>{t('doc.markAccepted')}</button>}
            {x.status === 'sent' && <button className="b" disabled={busy} onClick={() => void run(() => api(`/api/documents/${x.id}/quotation-status`, { body: { status: 'declined' } }))}>{t('doc.markDeclined')}</button>}
            {['sent', 'accepted'].includes(x.status) && <button className="b p" disabled={busy} onClick={() => void run(async () => {
              const r = await api<{ id: string }>(`/api/documents/${x.id}/convert`, { body: {} });
              go('Sales', 'invoices', r.id);
            })}>{t('doc.convert')}</button>}
          </>
        )}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}

      <div className="card paper">
        <div className="paper-head">
          <div>
            <div className="paper-title">{title}{x.type === 'invoice' && lang === 'en' && <span className="mut"> · فاتورة ضريبية</span>}</div>
            <div className="paper-no ltr">{x.number ?? t('doc.draftNo')}</div>
          </div>
          <StateBadge state={x.state} />
        </div>
        <div className="paper-parties">
          <div>
            <small className="mut">{t(side === 'sales' ? 'doc.from' : 'doc.supplierLabel')}</small>
            {side === 'sales' ? (
              <><b>{local(x.seller.name, x.seller.nameAr)}</b>
                {x.seller.vatNumber && <div className="small">{t('contact.vatNumber')}: <span className="ltr">{x.seller.vatNumber}</span></div>}
                <div className="small">{t('contact.crNumber')}: <span className="ltr">{x.seller.crNumber}</span></div>
                <div className="small mut">{x.seller.address}, {x.seller.city}</div></>
            ) : (
              <><b>{local(x.contact.name, x.contact.nameAr)}</b>
                {x.contact.vatNumber && <div className="small">{t('contact.vatNumber')}: <span className="ltr">{x.contact.vatNumber}</span></div>}</>
            )}
          </div>
          <div>
            <small className="mut">{t(side === 'sales' ? 'doc.billTo' : 'doc.billedTo')}</small>
            {side === 'sales' ? (
              <><b><button className="link" onClick={() => go(m, 'customers', x.contactId)}>{local(x.contact.name, x.contact.nameAr)}</button></b>
                {x.contact.vatNumber && <div className="small">{t('contact.vatNumber')}: <span className="ltr">{x.contact.vatNumber}</span></div>}
                {(x.contact.address || x.contact.city) && <div className="small mut">{[x.contact.address, x.contact.city].filter(Boolean).join(', ')}</div>}</>
            ) : <b>{local(x.seller.name, x.seller.nameAr)}</b>}
          </div>
          <div className="small">
            <div>{t('doc.date')}: <b>{x.issueDate}</b></div>
            {x.dueDate && <div>{t(x.type === 'quotation' ? 'doc.validUntil' : 'doc.dueDate')}: <b>{x.dueDate}</b></div>}
            {x.reference && <div>{t(side === 'sales' ? 'doc.referenceSales' : 'doc.referencePurchases')}: <b className="ltr">{x.reference}</b></div>}
          </div>
        </div>
        <div className="wrap">
          <table className="stack">
            <thead><tr><th>{t('doc.description')}</th><th className="num">{t('doc.qty')}</th><th className="num">{t('doc.price')}</th><th className="num">{t('doc.vat')}</th><th className="num">{t('doc.amount')}</th></tr></thead>
            <tbody>
              {x.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}<div className="mut small">{l.accountCode} {local(l.accountName, l.accountNameAr)}{l.costCentre ? ` · ${local(l.costCentre, l.costCentreAr)}` : ''}</div></td>
                  <td className="num ltr" data-label={t('doc.qty')}>{l.quantity.replace(/\.?0+$/, '')}</td>
                  <td className="num ltr" data-label={t('doc.price')}>{fmt(l.unitPrice)}</td>
                  <td className="num ltr" data-label={t('doc.vat')}>{fmt(l.vat)} <span className="mut small">({l.vatCode === 'standard' ? `${Number(l.vatRate)}%` : t(`vat.${l.vatCode}` as Key)})</span></td>
                  <td className="num ltr" data-label={t('doc.amount')}>{fmt(l.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Totals net={x.netTotal} vat={x.vatTotal} gross={x.grossTotal} cur={cur} due={due ? x.amountDue : undefined} />
        {x.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{x.notes}</p>}
        {x.status === 'issued' && <p className="mut small">{t('doc.postedNote')}</p>}
        {x.type === 'invoice' && x.status === 'issued' && <p className="mut small">{t('doc.einvoiceLater', { einv: t(`einv.${books.company.country}`) })}</p>}
      </div>

      {x.payments.length > 0 && (
        <div className="card">
          <h2>{t(side === 'sales' ? 'sub.payments-received' : 'sub.payments-made')}</h2>
          <table className="stack"><tbody>
            {x.payments.map((p) => (
              <tr key={p.id}>
                <td><button className="link" onClick={() => go(m, side === 'sales' ? 'payments-received' : 'payments-made', p.id)}>{p.number}</button></td>
                <td>{p.date}</td>
                <td className="num ltr">{fmt(p.amount)} {cur}</td>
                <td>{p.voidedAt && <StateBadge state="voided" />}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {x.related.length > 0 && (
        <div className="card">
          <h2>{t('doc.related')}</h2>
          <table className="stack"><tbody>
            {x.related.map((r) => (
              <tr key={r.id}>
                <td><button className="link" onClick={() => go(moduleOfSide(sideOf(r.type)), pageForType(r.type), r.id)}>{t(`doc.title.${r.type}` as Key)} {r.number ?? t('doc.draftNo')}</button></td>
                <td>{r.issueDate}</td>
                <td className="num ltr">{fmt(r.grossTotal)}</td>
                <td><StateBadge state={r.status} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </>
  );
}
