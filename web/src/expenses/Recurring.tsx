// Recurring expenses: templates (rent, internet, subscriptions…) that create draft expenses on their dates.
// Nothing is posted automatically: each draft is checked and recorded by a person.
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, isAmount, normalise } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { bankAccounts, lineAccounts, useGo, type Contact } from '../sales/common.tsx';
import type { VatCode } from '../../../src/books/documents.ts';

const FREQS = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
interface RLine { description: string; quantity: string; unitPrice: string; accountId: string; costCentreId: string | null; vatCode: VatCode }
interface Rec {
  id: string; name: string; contactId: string | null; payeeName: string; payee: string | null; paidFromAccountId: string; paidFromName: string;
  paidFromNameAr: string | null; frequency: (typeof FREQS)[number]; nextDate: string; endDate: string | null; active: boolean; due: boolean;
  lines: RLine[]; reference: string | null; netAmount: string;
}

export function RecurringList({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const list = useApi<Rec[]>(`/api/companies/${books.company.id}/recurring`);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (path: string) => {
    setBusy(true); setMsg({});
    try {
      const r = await api<{ created: string[] }>(path, { body: {} });
      setMsg({ ok: t('rec.created', { n: r.created.length }) }); list.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const dueCount = list.data?.filter((r) => r.due).length ?? 0;
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 260px', margin: 0 }}>{t('rec.hint')}</p>
        {books.canPost && dueCount > 0 && <button className="b" disabled={busy} onClick={() => void run(`/api/companies/${books.company.id}/recurring/generate`)}>{t('rec.createDueN', { n: dueCount })}</button>}
        {books.canPost && <button className="b p" onClick={() => go('Expenses', 'recurring', 'new')}>{t('rec.newPlus')}</button>}
      </div>
      {msg.ok && (
        <div className="notice actions"><span>{msg.ok}</span><button className="link" onClick={() => go('Expenses', 'expenses', undefined, 'draft')}>{t('rec.reviewDrafts')}</button></div>
      )}
      {msg.bad && <div className="notice bad">{msg.bad}</div>}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('rec.none')}</div> : (
          <div className="wrap">
            <table className="stack">
              <thead><tr><th>{t('rec.name')}</th><th>{t('exp.paidTo')}</th><th>{t('rec.frequency')}</th><th>{t('rec.nextDate')}</th><th className="num">{t('rec.amount')}</th><th /></tr></thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} className={r.active ? '' : 'mut'}>
                    <td><button className="link" onClick={() => go('Expenses', 'recurring', r.id)}>{r.name}</button></td>
                    <td data-label={t('exp.paidTo')}>{r.payeeName}</td>
                    <td data-label={t('rec.frequency')}>{t(`freq.${r.frequency}` as Key)}</td>
                    <td data-label={t('rec.nextDate')}>{r.active ? r.nextDate : '—'} {r.due && <span className="badge warn">{t('rec.due')}</span>}</td>
                    <td className="num ltr" data-label={t('rec.amount')}>{fmt(r.netAmount)}</td>
                    <td>
                      {!r.active ? <span className="badge">{t('rec.stopped')}</span>
                        : books.canPost && <button className="b small" disabled={busy} onClick={() => void run(`/api/recurring/${r.id}/generate`)}>{t('rec.createNow')}</button>}
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

export function RecurringForm({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const existing = useApi<Rec>(isNew ? null : `/api/recurring/${id}`);
  const suppliers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=supplier`);
  const banks = bankAccounts(books);
  const accounts = lineAccounts(books, 'purchases');
  const defaultAccount = accounts.find((a) => a.code === '5400')?.id ?? accounts[0]?.id ?? '';
  const registered = books.company.vatStatus !== 'unregistered';
  const blank = (): RLine => ({ description: '', quantity: '1', unitPrice: '', accountId: defaultAccount, costCentreId: null, vatCode: registered ? 'standard' : 'out_of_scope' });
  const [f, setF] = useState<{ name: string; contactId: string; payee: string; paidFromAccountId: string; frequency: string; nextDate: string; endDate: string; active: boolean; reference: string; lines: RLine[] }>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  if (!f && (isNew || existing.data)) {
    const r = existing.data;
    setF(r ? { name: r.name, contactId: r.contactId ?? '', payee: r.payee ?? '', paidFromAccountId: r.paidFromAccountId, frequency: r.frequency, nextDate: r.nextDate,
      endDate: r.endDate ?? '', active: r.active, reference: r.reference ?? '', lines: r.lines.map((l) => ({ ...l, costCentreId: l.costCentreId ?? null })) }
      : { name: '', contactId: '', payee: '', paidFromAccountId: banks[0]?.id ?? '', frequency: 'monthly', nextDate: today(), endDate: '', active: true, reference: '', lines: [blank()] });
  }
  if (existing.error) return <ErrorNote error={existing.error} onRetry={existing.reload} />;
  if (!f) return <Loading />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const setLine = (i: number, p: Partial<RLine>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });

  const problems: string[] = [];
  if (!f.name.trim()) problems.push(t('err.recurringName'));
  if (!f.contactId && !f.payee.trim()) problems.push(t('exp.needPayee'));
  if (!f.paidFromAccountId) problems.push(t('err.bankAccount'));
  if (!f.nextDate) problems.push(t('err.date'));
  if (f.endDate && f.endDate < f.nextDate) problems.push(t('err.endDate'));
  f.lines.forEach((l, i) => {
    if (!l.description.trim()) problems.push(t('doc.lineNeedsDescription', { n: i + 1 }));
    if (!isAmount(l.unitPrice) || !/^\d+(\.\d{1,3})?$/.test(l.quantity) || Number(l.quantity) <= 0) problems.push(t('doc.lineNeedsNumbers', { n: i + 1 }));
  });
  const save = async () => {
    setTried(true);
    if (problems.length) return;
    setBusy(true); setMsg(undefined);
    try {
      const body = { ...f, contactId: f.contactId || null, payee: f.contactId ? null : f.payee, endDate: f.endDate || null,
        lines: f.lines.map((l) => ({ ...l, unitPrice: normalise(l.unitPrice) })) };
      await api(isNew ? `/api/companies/${books.company.id}/recurring` : `/api/recurring/${id}`, { body });
      go('Expenses', 'recurring');
    } catch (e) { setMsg(errorText(t, has, e)); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Expenses', 'recurring')}>{t('rec.back')}</button>
        <h2 style={{ margin: 0 }}>{isNew ? t('rec.new') : f.name}</h2>
      </div>
      {msg && <div className="notice bad" role="alert">{msg}</div>}
      <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card">
          <div className="row">
            <label className="f" style={{ flex: '2 1 220px' }}>{t('rec.name')}<input id="rec-name" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('rec.namePlaceholder')} /></label>
            <label className="f">{t('rec.frequency')}
              <select id="rec-freq" value={f.frequency} onChange={(e) => set({ frequency: e.target.value })}>
                {FREQS.map((x) => <option key={x} value={x}>{t(`freq.${x}` as Key)}</option>)}
              </select>
            </label>
            <label className="f">{t('rec.nextDate')}<input id="rec-next" type="date" value={f.nextDate} onChange={(e) => set({ nextDate: e.target.value })} /></label>
            <label className="f">{t('rec.endDate')}<input id="rec-end" type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('exp.supplierOptional')}
              <select id="rec-supplier" value={f.contactId} onChange={(e) => set({ contactId: e.target.value })}>
                <option value="">{t('exp.noSupplier')}</option>
                {(suppliers.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
            {!f.contactId && <label className="f">{t('exp.payee')}<input id="rec-payee" value={f.payee} onChange={(e) => set({ payee: e.target.value })} placeholder={t('exp.payeeHint')} /></label>}
            <label className="f">{t('exp.paidFrom')}
              <select id="rec-paid-from" value={f.paidFromAccountId} onChange={(e) => set({ paidFromAccountId: e.target.value })}>
                {banks.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
              </select>
            </label>
          </div>
          {!isNew && (
            <label className="actions"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /><span>{t('rec.activeLabel')}</span></label>
          )}
        </div>
        <div className="card">
          <div className="wrap">
            <table className="doclines">
              <thead><tr><th>{t('doc.description')}</th><th className="num">{t('doc.qty')}</th><th className="num">{t('doc.price')}</th><th>{t('doc.vat')}</th><th>{t('exp.category')}</th><th>{t('journal.costCentre')}</th><th /><th /></tr></thead>
              <tbody>
                {f.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="dl-desc"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={t('doc.description')} placeholder={t('doc.description')} /></td>
                    <td className="dl-qty"><input className="num ltr" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={t('doc.qty')} placeholder={t('doc.qty')} /></td>
                    <td className="dl-price"><input className="num ltr" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} aria-label={t('doc.price')} placeholder={t('doc.price')} /></td>
                    <td className="dl-vat">
                      <select value={l.vatCode} onChange={(e) => setLine(i, { vatCode: e.target.value as VatCode })} aria-label={t('doc.vat')}>
                        {(['standard', 'zero', 'exempt', 'out_of_scope'] as const).map((c) => <option key={c} value={c}>{c === 'standard' ? t('vat.standard', { rate: Number(books.company.vatRate) }) : t(`vat.${c}` as Key)}</option>)}
                      </select>
                    </td>
                    <td className="dl-acct">
                      <select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} aria-label={t('exp.category')}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}{a.costCentreRequired ? ' *' : ''}</option>)}
                      </select>
                    </td>
                    <td className="dl-cc">
                      <select value={l.costCentreId ?? ''} onChange={(e) => setLine(i, { costCentreId: e.target.value || null })} aria-label={t('journal.costCentre')}>
                        <option value="">{t('journal.costCentre')}: —</option>
                        {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
                      </select>
                    </td>
                    <td className="dl-amt" />
                    <td className="dl-x"><button type="button" className="b small" disabled={f.lines.length <= 1} onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })} aria-label={t('journal.removeLine')}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="b" style={{ marginTop: 8 }} onClick={() => set({ lines: [...f.lines, blank()] })}>{t('journal.addLine')}</button>
        </div>
        {tried && problems.length > 0 && <ul className="bad small" style={{ margin: '0 0 10px', paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {books.canPost && (
          <div className="actions">
            <button type="button" className="b p" disabled={busy} onClick={() => void save()}>{t('save')}</button>
            <span className="mut small">{t('rec.saveHint')}</span>
          </div>
        )}
      </fieldset>
    </>
  );
}
