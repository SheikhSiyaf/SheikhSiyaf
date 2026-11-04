// Sales > Recurring invoices, Sales > Reminders (overdue invoices, polite reminders by email), Sales > Statements
// (a customer's statement of account, emailed), and Reports > Budgets (budget against actual).
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, isAmount, normalise, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { lineAccounts, useGo, type Contact } from './common.tsx';
import type { VatCode } from '../../../src/books/documents.ts';

const FREQS = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
const MODES = ['draft', 'issue', 'issue_and_email'] as const;
interface RLine { description: string; quantity: string; unitPrice: string; accountId: string; costCentreId: string | null; vatCode: VatCode }
interface RecInv { id: string; name: string; contactId: string; customer: string; customerAr: string | null; customerEmail: string | null; frequency: string; nextDate: string;
  endDate: string | null; termsDays: number; active: boolean; mode: string; lines: RLine[]; reference: string | null; notes: string | null; lastProblem: string | null;
  due: boolean; made: number; grossAmount: string; invoices?: { id: string; number: string | null; status: string; issueDate: string; grossTotal: string }[] }

// ------------------------------------------------------------------ recurring invoices
export function RecurringInvoices({ books, id }: { books: CompanyBooks; id?: string }) {
  if (id) return <RecurringInvoiceForm key={id} books={books} id={id} />;
  return <RecurringInvoiceList books={books} />;
}

function RecurringInvoiceList({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useApi<RecInv[]>(`/api/companies/${books.company.id}/recurring-invoices`);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const make = async (r: RecInv) => {
    setMsg({});
    try { const x = await api<{ created: string[] }>(`/api/recurring-invoices/${r.id}/make`, { body: {} }); setMsg({ ok: t('ri.made', { n: x.created.length }) }); list.reload(); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); }
  };
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 300px', margin: 0 }}>{t('ri.hint')}</p>
        {books.canPost && <button className="b p" id="ri-new" onClick={() => go('Sales', 'recurring-invoices', 'new')}>{t('ri.new')}</button>}
      </div>
      {msg.ok && <div className="notice" role="status" id="ri-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <p className="mut">{t('ri.none')}</p> : (
          <div className="wrap"><table className="stack" id="ri-list">
            <thead><tr><th>{t('rec.name')}</th><th>{t('contact.customer')}</th><th>{t('rec.frequency')}</th><th>{t('rec.nextDate')}</th><th className="num">{t('doc.total')}</th><th>{t('ri.mode')}</th><th /></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'mut'}>
                <td><button className="link" onClick={() => go('Sales', 'recurring-invoices', r.id)}>{r.name}</button>{r.lastProblem && <div className="small bad">{r.lastProblem}</div>}</td>
                <td data-label={t('contact.customer')}>{local(r.customer, r.customerAr)}</td>
                <td data-label={t('rec.frequency')}>{t(`freq.${r.frequency}` as Key)}</td>
                <td className="ltr" data-label={t('rec.nextDate')}>{r.active ? r.nextDate : t('rec.ended')}{r.due && <span className="badge warn" style={{ marginInlineStart: 6 }}>{t('rec.due')}</span>}</td>
                <td className="num ltr" data-label={t('doc.total')}>{fmt(r.grossAmount)}</td>
                <td className="small" data-label={t('ri.mode')}>{t(`ri.mode.${r.mode}` as Key)}</td>
                <td className="num">{books.canPost && r.active && <button className="b small" onClick={() => void make(r)}>{t('ri.makeNow')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

function RecurringInvoiceForm({ books, id }: { books: CompanyBooks; id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const existing = useApi<RecInv>(isNew ? null : `/api/recurring-invoices/${id}`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const accounts = lineAccounts(books, 'sales');
  const registered = books.company.vatStatus !== 'unregistered';
  const blank = (): RLine => ({ description: '', quantity: '1', unitPrice: '', accountId: accounts[0]?.id ?? '', costCentreId: null, vatCode: registered ? 'standard' : 'out_of_scope' });
  const [f, setF] = useState<{ name: string; contactId: string; frequency: string; nextDate: string; endDate: string; termsDays: string; active: boolean; mode: string; reference: string; notes: string; lines: RLine[] }>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  if (!f && (isNew || existing.data)) {
    const r = existing.data;
    setF(r ? { name: r.name, contactId: r.contactId, frequency: r.frequency, nextDate: r.nextDate, endDate: r.endDate ?? '', termsDays: String(r.termsDays), active: r.active, mode: r.mode,
      reference: r.reference ?? '', notes: r.notes ?? '', lines: r.lines.map((l) => ({ ...l, costCentreId: l.costCentreId ?? null })) }
      : { name: '', contactId: '', frequency: 'monthly', nextDate: today(), endDate: '', termsDays: String(books.company.paymentTermsDays ?? 30), active: true, mode: 'draft', reference: '', notes: '', lines: [blank()] });
  }
  if (existing.error) return <ErrorNote error={existing.error} onRetry={existing.reload} />;
  if (!f) return <Loading />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const setLine = (i: number, p: Partial<RLine>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const customer = (customers.data ?? []).find((c) => c.id === f.contactId);
  const problems: string[] = [];
  if (!f.name.trim()) problems.push(t('err.recurringName'));
  if (!f.contactId) problems.push(t('ri.needCustomer'));
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
      await api(isNew ? `/api/companies/${books.company.id}/recurring-invoices` : `/api/recurring-invoices/${id}`, { body: { ...f, endDate: f.endDate || null, termsDays: Number(f.termsDays || 0),
        lines: f.lines.map((l) => ({ ...l, unitPrice: normalise(l.unitPrice) })) } });
      go('Sales', 'recurring-invoices');
    } catch (e) { setMsg(errorText(t, has, e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Sales', 'recurring-invoices')}>{t('ri.back')}</button>
        <h2 style={{ margin: 0 }}>{isNew ? t('ri.new') : f.name}</h2>
      </div>
      {msg && <div className="notice bad" role="alert">{msg}</div>}
      <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card">
          <div className="row">
            <label className="f" style={{ flex: '2 1 220px' }}>{t('rec.name')}<input id="ri-name" value={f.name} placeholder={t('ri.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="f">{t('contact.customer')}<select id="ri-customer" value={f.contactId} onChange={(e) => set({ contactId: e.target.value })}>
              <option value="">—</option>{(customers.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>
          </div>
          <div className="row">
            <label className="f">{t('rec.frequency')}<select id="ri-freq" value={f.frequency} onChange={(e) => set({ frequency: e.target.value })}>{FREQS.map((x) => <option key={x} value={x}>{t(`freq.${x}` as Key)}</option>)}</select></label>
            <label className="f">{t('rec.nextDate')}<input id="ri-next" type="date" value={f.nextDate} onChange={(e) => set({ nextDate: e.target.value })} /></label>
            <label className="f">{t('rec.endDate')}<input type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} /></label>
            <label className="f">{t('ri.terms')}<input className="num ltr" inputMode="numeric" value={f.termsDays} onChange={(e) => set({ termsDays: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></label>
          </div>
          <fieldset className="f" style={{ border: 0, padding: 0 }}><legend>{t('ri.mode')}</legend>
            <div className="chips">{MODES.map((m) => (
              <label key={m} className={`chip ${f.mode === m ? 'on' : ''}`}><input type="radio" name="ri-mode" checked={f.mode === m} onChange={() => set({ mode: m })} />{t(`ri.mode.${m}` as Key)}</label>
            ))}</div>
            <span className="small mut">{t(`ri.modeHint.${f.mode}` as Key)}</span>
            {f.mode === 'issue_and_email' && customer && !customer.email && <span className="small bad" style={{ display: 'block' }}>{t('ri.noEmail')}</span>}
          </fieldset>
          {!isNew && <label className="actions"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /><span>{t('rec.activeLabel')}</span></label>}
        </div>
        <div className="card">
          <div className="wrap"><table className="doclines">
            <thead><tr><th>{t('doc.description')}</th><th className="num">{t('doc.qty')}</th><th className="num">{t('doc.price')}</th><th>{t('doc.vat')}</th><th>{t('doc.account')}</th><th /></tr></thead>
            <tbody>{f.lines.map((l, i) => (
              <tr key={i}>
                <td className="dl-desc"><input value={l.description} aria-label={t('doc.description')} placeholder={t('doc.description')} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td className="dl-qty"><input className="num ltr" inputMode="decimal" value={l.quantity} aria-label={t('doc.qty')} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                <td className="dl-price"><input className="num ltr" inputMode="decimal" value={l.unitPrice} aria-label={t('doc.price')} placeholder={t('doc.price')} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></td>
                <td className="dl-vat"><select value={l.vatCode} aria-label={t('doc.vat')} onChange={(e) => setLine(i, { vatCode: e.target.value as VatCode })}>
                  {(['standard', 'zero', 'exempt', 'out_of_scope'] as const).map((c) => <option key={c} value={c}>{c === 'standard' ? t('vat.standard', { rate: Number(books.company.vatRate) }) : t(`vat.${c}` as Key)}</option>)}</select></td>
                <td className="dl-acct"><select value={l.accountId} aria-label={t('doc.account')} onChange={(e) => setLine(i, { accountId: e.target.value })}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}</select></td>
                <td className="dl-x"><button type="button" className="b small" disabled={f.lines.length <= 1} onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })} aria-label={t('journal.removeLine')}>×</button></td>
              </tr>
            ))}</tbody>
          </table></div>
          <button type="button" className="b" style={{ marginTop: 8 }} onClick={() => set({ lines: [...f.lines, blank()] })}>{t('journal.addLine')}</button>
        </div>
        {tried && problems.length > 0 && <ul className="bad small" style={{ margin: '0 0 10px', paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {books.canPost && <div className="actions"><button type="button" id="ri-save" className="b p" disabled={busy} onClick={() => void save()}>{t('save')}</button></div>}
      </fieldset>
      {existing.data?.invoices && existing.data.invoices.length > 0 && <div className="card" style={{ marginTop: 12 }}>
        <h3>{t('ri.madeList')}</h3>
        <table className="mini"><tbody>{existing.data.invoices.map((d) => (
          <tr key={d.id}><td><button className="link" onClick={() => go('Sales', 'invoices', d.id)}>{d.number ?? t('doc.draftNo')}</button></td><td className="ltr">{d.issueDate}</td><td className="num ltr">{fmt(d.grossTotal)}</td></tr>
        ))}</tbody></table>
      </div>}
    </>
  );
}

// ------------------------------------------------------------------ reminders
interface Open { id: string; number: string; contactId: string; customer: string; customerAr: string | null; email: string | null; issueDate: string; dueDate: string | null;
  amountDue: string; daysOverdue: number; bucket: string; lastReminder: string | null }
export function Reminders({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const r = useApi<{ settings: { auto: boolean; days: number[]; message: string | null; enabledBy: string | null }; open: Open[] }>(`/api/companies/${books.company.id}/reminders`);
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const overdue = r.data.open.filter((o) => o.daysOverdue > 0);
  const s = r.data.settings;
  const dayText = days ?? s.days.join(', ');
  const run = async (fn: () => Promise<string>) => { setBusy(true); setMsg({}); try { setMsg({ ok: await fn() }); r.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); } };
  const total = fromMinor(overdue.reduce((x, o) => x + toMinor(o.amountDue), 0n));
  return (
    <>
      <p className="mut small">{t('rem.hint')}</p>
      {msg.ok && <div className="notice" role="status" id="rem-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="card">
        <div className="actions" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{t('rem.overdue', { n: overdue.length, amount: fmt(total) })}</h3>
          <span className="spacer" />
          {books.canPost && <button className="b p" id="rem-send" disabled={busy || !picked.length} onClick={() => void run(async () => {
            const x = await api<{ results: { ok: boolean; error?: string }[] }>(`/api/companies/${books.company.id}/reminders/send`, { body: { ids: picked } });
            const bad = x.results.filter((y) => !y.ok); setPicked([]);
            if (bad.length) throw new Error(bad[0]!.error);
            return t('rem.sent', { n: x.results.length });
          })}>{t('rem.sendSelected', { n: picked.length })}</button>}
        </div>
        {overdue.length === 0 ? <p className="mut">{t('rem.none')}</p> : (
          <div className="wrap"><table className="stack" id="rem-list">
            <thead><tr><th className="pick"><input type="checkbox" aria-label={t('bulk.all')} checked={picked.length === overdue.filter((o) => o.email).length && picked.length > 0}
              onChange={(e) => setPicked(e.target.checked ? overdue.filter((o) => o.email).map((o) => o.id) : [])} /></th>
              <th>{t('doc.number')}</th><th>{t('contact.customer')}</th><th>{t('doc.dueDate')}</th><th className="num">{t('rem.days')}</th><th className="num">{t('doc.amountDue')}</th><th>{t('rem.last')}</th></tr></thead>
            <tbody>{overdue.map((o) => (
              <tr key={o.id}>
                <td className="pick"><input type="checkbox" disabled={!o.email} aria-label={`${t('bulk.pick')} ${o.number}`} checked={picked.includes(o.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))} /></td>
                <td><button className="link" onClick={() => go('Sales', 'invoices', o.id)}>{o.number}</button></td>
                <td>{local(o.customer, o.customerAr)}{!o.email && <div className="small bad">{t('rem.noEmail')}</div>}</td>
                <td className="ltr" data-label={t('doc.dueDate')}>{o.dueDate}</td>
                <td className={`num ${o.daysOverdue > 30 ? 'bad' : ''}`} data-label={t('rem.days')}>{o.daysOverdue}</td>
                <td className="num ltr" data-label={t('doc.amountDue')}>{fmt(o.amountDue)}</td>
                <td className="small" data-label={t('rem.last')}>{o.lastReminder ? String(o.lastReminder).slice(0, 10) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="card" id="rem-auto">
        <h3>{t('rem.autoTitle')}</h3>
        <label className="check-one"><input type="checkbox" id="rem-auto-on" disabled={!books.canPost || busy} checked={s.auto}
          onChange={(e) => void run(async () => { await api(`/api/companies/${books.company.id}/reminders/settings`, { body: { auto: e.target.checked, days: dayText.split(/[\s,]+/).map(Number).filter(Boolean), message: s.message } }); return e.target.checked ? t('rem.autoOn') : t('rem.autoOff'); })} />
          <span>{t('rem.autoLabel')}</span></label>
        <label className="f" style={{ maxWidth: 320 }}>{t('rem.daysLabel')}<input id="rem-days" className="ltr" value={dayText} onChange={(e) => setDays(e.target.value)}
          onBlur={() => days !== undefined && void run(async () => { await api(`/api/companies/${books.company.id}/reminders/settings`, { body: { auto: s.auto, days: dayText.split(/[\s,]+/).map(Number).filter(Boolean), message: s.message } }); setDays(undefined); return t('admin.saved'); })} /></label>
        {s.auto && s.enabledBy && <p className="small mut">{t('rem.autoBy', { name: s.enabledBy })}</p>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ statements
interface Stmt { company: { name: string; currency: string }; customer: { name: string; nameAr: string | null; email: string | null }; from: string; to: string;
  ledger: { opening: string; closing: string; rows: { date: string; number: string | null; memo: string | null; debit: string; credit: string; balance: string }[] };
  open: Open[]; aging: Record<string, string> }
export function Statements({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const [contactId, setContactId] = useState('');
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const s = useApi<Stmt>(contactId ? `/api/companies/${books.company.id}/statement?contact=${contactId}&from=${from}&to=${to}` : null);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [email, setEmail] = useState('');
  return (
    <>
      <div className="row">
        <label className="f">{t('contact.customer')}<select id="st-customer" value={contactId} onChange={(e) => { setContactId(e.target.value); setMsg({}); setEmail(''); }}>
          <option value="">—</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>
        <label className="f">{t('from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">{t('to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {msg.ok && <div className="notice" role="status" id="st-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {!contactId ? <p className="mut">{t('st.pick')}</p> : s.error ? <ErrorNote error={s.error} /> : !s.data ? <Loading /> : (
        <div className="card" id="st-view">
          <h3>{t('st.title', { name: local(s.data.customer.name, s.data.customer.nameAr), from, to })}</h3>
          <table className="mini">
            <thead><tr><th>{t('doc.date')}</th><th>{t('doc.number')}</th><th>{t('journal.memo')}</th><th className="num">{t('debit')}</th><th className="num">{t('credit')}</th><th className="num">{t('led.balance')}</th></tr></thead>
            <tbody>
              <tr><td colSpan={5}>{t('st.opening')}</td><td className="num ltr">{fmt(s.data.ledger.opening)}</td></tr>
              {s.data.ledger.rows.map((r, i) => <tr key={i}><td className="ltr">{r.date}</td><td>{r.number}</td><td className="small">{r.memo}</td>
                <td className="num ltr">{toMinor(r.debit) ? fmt(r.debit) : ''}</td><td className="num ltr">{toMinor(r.credit) ? fmt(r.credit) : ''}</td><td className="num ltr">{fmt(r.balance)}</td></tr>)}
              <tr className="total"><td colSpan={5}>{t('st.closing')} ({s.data.company.currency})</td><td className="num ltr"><b id="st-closing">{fmt(s.data.ledger.closing)}</b></td></tr>
            </tbody>
          </table>
          <div className="grid" style={{ marginTop: 10 }}>{Object.entries(s.data.aging).map(([k, v]) => <div key={k} className="card fig"><small>{t(`st.age.${k}` as Key)}</small><b className="ltr">{fmt(v)}</b></div>)}</div>
          {books.canPost && <div className="actions" style={{ marginTop: 10 }}>
            <input type="email" dir="ltr" placeholder={s.data.customer.email ?? t('mail.toHint')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={t('mail.to')} />
            <button className="b p" id="st-email" onClick={() => { setMsg({}); void api(`/api/companies/${books.company.id}/statement/email`, { body: { contactId, from, to, email: email.trim() || undefined } })
              .then(() => setMsg({ ok: t('st.emailed') }), (e) => setMsg({ bad: errorText(t, has, e) })); }}>{t('st.email')}</button>
          </div>}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ budgets
interface BudgetRow { id: string; name: string; startDate: string; status: string; total: string }
interface BudgetView { id: string; name: string; startDate: string; endDate: string; status: string;
  lines: { accountId: string; code: string; name: string; nameAr: string | null; type: string; costCentreId: string | null; costCentre: string | null; budget: string[]; actual: string[];
    totalBudget: string; totalActual: string; variance: string; usedPct: number | null }[] }
const monthLabel = (start: string, i: number, lang: string) => new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1 + i, 1)).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'short', timeZone: 'UTC' });

export function Budgets({ books, id }: { books: CompanyBooks; id?: string }) {
  const { t, has, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useApi<BudgetRow[]>(id ? null : `/api/companies/${books.company.id}/budgets`);
  const view = useApi<BudgetView>(id && id !== 'new' ? `/api/budgets/${id}` : null);
  const [edit, setEdit] = useState<{ name: string; startDate: string; lines: { accountId: string; costCentreId: string; months: string[] }[] }>();
  const [msg, setMsg] = useState<string>();
  const accounts = books.accounts.filter((a) => a.type === 'income' || a.type === 'expense');
  if (id === 'new' && !edit) setEdit({ name: `${today().slice(0, 4)} budget`, startDate: `${today().slice(0, 4)}-01-01`, lines: [{ accountId: accounts[0]?.id ?? '', costCentreId: '', months: Array(12).fill('') }] });
  const save = async () => {
    if (!edit) return;
    setMsg(undefined);
    try {
      const r = await api<{ id: string }>(id && id !== 'new' ? `/api/budgets/${id}` : `/api/companies/${books.company.id}/budgets`,
        { body: { ...edit, lines: edit.lines.filter((l) => l.accountId).map((l) => ({ ...l, costCentreId: l.costCentreId || null, months: l.months.map((m) => (m ? normalise(m) : '')) })) } });
      setEdit(undefined); go('Reports', 'budgets', r.id); view.reload();
    } catch (e) { setMsg(errorText(t, has, e)); }
  };
  if (edit) return (
    <div className="card" id="bd-edit">
      <div className="row">
        <label className="f">{t('bd.name')}<input id="bd-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label className="f">{t('bd.start')}<input id="bd-start" type="month" value={edit.startDate.slice(0, 7)} onChange={(e) => e.target.value && setEdit({ ...edit, startDate: `${e.target.value}-01` })} /></label>
      </div>
      {msg && <div className="notice bad" role="alert">{msg}</div>}
      <div className="wrap"><table className="mini bd-grid">
        <thead><tr><th>{t('doc.account')}</th>{Array.from({ length: 12 }, (_, i) => <th key={i} className="num">{monthLabel(edit.startDate, i, lang)}</th>)}<th /></tr></thead>
        <tbody>{edit.lines.map((l, li) => (
          <tr key={li}>
            <td><select value={l.accountId} aria-label={t('doc.account')} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === li ? { ...x, accountId: e.target.value } : x)) })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}</select>
              <select value={l.costCentreId} aria-label={t('journal.costCentre')} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === li ? { ...x, costCentreId: e.target.value } : x)) })}>
                <option value="">{t('bd.allCentres')}</option>{books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></td>
            {l.months.map((m, mi) => <td key={mi}><input className="num ltr bd-cell" inputMode="decimal" value={m} aria-label={`${monthLabel(edit.startDate, mi, lang)}`}
              onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === li ? { ...x, months: x.months.map((y, k) => (k === mi ? e.target.value : y)) } : x)) })} /></td>)}
            <td><button className="b small" title={t('bd.fill')} onClick={() => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === li ? { ...x, months: x.months.map(() => x.months[0] ?? '') } : x)) })}>→</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="small mut">{t('bd.fillHint')}</p>
      <div className="actions">
        <button className="b" onClick={() => setEdit({ ...edit, lines: [...edit.lines, { accountId: accounts[0]?.id ?? '', costCentreId: '', months: Array(12).fill('') }] })}>{t('journal.addLine')}</button>
        <span className="spacer" />
        <button className="b p" id="bd-save" onClick={() => void save()}>{t('save')}</button>
        <button className="b" onClick={() => { setEdit(undefined); if (id === 'new') go('Reports', 'budgets'); }}>{t('cancel')}</button>
      </div>
    </div>
  );
  if (id && id !== 'new') {
    if (view.error) return <ErrorNote error={view.error} onRetry={view.reload} />;
    if (!view.data) return <Loading />;
    const v = view.data;
    return (
      <>
        <div className="actions" style={{ marginBottom: 10 }}>
          <button className="b" onClick={() => go('Reports', 'budgets')}>{t('bd.back')}</button>
          <h2 style={{ margin: 0 }}>{v.name}</h2><span className="mut small ltr">{v.startDate} – {v.endDate}</span>
          <span className="spacer" />
          {books.canPost && <button className="b" onClick={() => setEdit({ name: v.name, startDate: v.startDate, lines: v.lines.map((l) => ({ accountId: l.accountId, costCentreId: l.costCentreId ?? '', months: l.budget.map((x) => (toMinor(x) ? x : '')) })) })}>{t('bd.edit')}</button>}
        </div>
        <div className="card"><div className="wrap"><table className="stack" id="bd-view">
          <thead><tr><th>{t('doc.account')}</th><th className="num">{t('bd.budget')}</th><th className="num">{t('bd.actual')}</th><th className="num">{t('bd.variance')}</th><th className="num">{t('bd.used')}</th></tr></thead>
          <tbody>{v.lines.map((l) => (
            <tr key={`${l.accountId}${l.costCentreId}`}>
              <td><span className="ltr">{l.code}</span> {local(l.name, l.nameAr)}{l.costCentre && <span className="small mut"> · {l.costCentre}</span>}</td>
              <td className="num ltr" data-label={t('bd.budget')}>{fmt(l.totalBudget)}</td>
              <td className="num ltr" data-label={t('bd.actual')}>{fmt(l.totalActual)}</td>
              <td className={`num ltr ${toMinor(l.variance) < 0n ? 'bad' : 'good'}`} data-label={t('bd.variance')}>{fmt(l.variance)}</td>
              <td className="num" data-label={t('bd.used')}>{l.usedPct === null ? '—' : `${l.usedPct}%`}<div className="bd-bar"><i style={{ width: `${Math.min(100, l.usedPct ?? 0)}%` }} className={l.type === 'expense' && (l.usedPct ?? 0) > 100 ? 'over' : ''} /></div></td>
            </tr>
          ))}</tbody>
        </table></div><p className="small mut">{t('bd.varianceHint')}</p></div>
      </>
    );
  }
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 300px', margin: 0 }}>{t('bd.hint')}</p>
        {books.canPost && <button className="b p" id="bd-new" onClick={() => go('Reports', 'budgets', 'new')}>{t('bd.new')}</button>}
      </div>
      <div className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <p className="mut">{t('bd.none')}</p> : (
          <table className="stack"><tbody>{list.data.map((b) => (
            <tr key={b.id}><td><button className="link" onClick={() => go('Reports', 'budgets', b.id)}>{b.name}</button></td><td className="ltr">{b.startDate}</td><td className="num ltr">{fmt(b.total)}</td></tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}
