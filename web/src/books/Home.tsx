import { ReviewedBadge } from '../review/Review.tsx';
import { useDates, useDeadlineText, type CalItem } from '../calendar/Calendar.tsx';
import { today } from '../router.ts';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { useState } from 'react';
import { useGo } from '../sales/common.tsx';
import { fmt, neg } from '../money.ts';
import { toMinor, fromMinor } from '../money.ts';
import { ErrorNote, Loading } from '../ui.tsx';

interface Summary {
  asOf: string; cash: string; receivables: string; payables: string; inputVat: string; outputVat: string;
  monthIncome: string; monthExpense: string; monthProfit: string; entries: number; entriesThisMonth: number; lockedUpTo: string | null;
}

export function Home({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const s = useApi<Summary>(`/api/companies/${books.company.id}/summary`);
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const cur = books.company.currency;
  const vatDue = fromMinor(-toMinor(d.outputVat) - toMinor(d.inputVat));
  const figs: [string, string, string][] = [
    [t('home.cash'), d.cash, t('home.fromLedger')],
    [t('home.receivables'), d.receivables, t('home.fromLedger')],
    [t('home.payables'), neg(d.payables), t('home.fromLedger')],
    [t('home.profit'), d.monthProfit, t('home.salesLessExpenses')],
  ];
  return (
    <>
      <ReviewedBadge books={books} go={go} />
      <FromAccountant books={books} go={go} />
      <WaitingApproval books={books} go={go} />
      <GettingStarted books={books} />
      <div className="grid">
        {figs.map(([label, value, note]) => (
          <div key={label} className="card fig">
            <small>{label}</small>
            <b className="ltr">{fmt(value)}</b>
            <small>{cur} · {note}</small>
          </div>
        ))}
      </div>
      <ComingUp books={books} go={go} />
      <div className="card">
        <h2>{t('home.todo')}</h2>
        <table>
          <tbody>
            <tr><td>{t('home.vatDue')}</td><td className="num ltr">{fmt(vatDue)} {cur}</td></tr>
            <tr><td>{t('home.entriesThisMonth')}</td><td className="num">{d.entriesThisMonth}</td></tr>
            <tr><td>{t('home.lockedUpTo')}</td><td className="num">{d.lockedUpTo ?? <span className="mut">{t('home.notLocked')}</span>}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>{t('home.quick')}</h2>
        <div className="actions">
          {books.canPost && <button className="b p" onClick={() => go('Sales', 'invoices/new')}>{t('ov.newInvoice')}</button>}
          {books.canPost && <button className="b" onClick={() => go('Sales', 'payments-received/new')}>{t('ov.recordReceipt')}</button>}
          {books.canPost && <button className="b" onClick={() => go('Expenses', 'expenses/new')}>{t('exp.record')}</button>}
          {books.canPost && <button className="b" onClick={() => go('Purchases', 'bills/new')}>{t('ov.newBill')}</button>}
          {books.canPost && <button className="b" onClick={() => go('Journal', 'new')}>{t('home.newEntry')}</button>}
          <button className="b" onClick={() => go('Reports', 'trial-balance')}>{t('home.trialBalance')}</button>
          <button className="b" onClick={() => go('Reports', 'vat-summary')}>{t('home.vatSummary')}</button>
        </div>
      </div>
    </>
  );
}

/** What the accounting firm is waiting for, and its latest monthly report (client users of a firm's client). */
function FromAccountant({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const skip = books.portal?.firm || books.portal?.tenantKind === 'company';
  const o = useApi<{ openRequests: number; unreadLetters: number }>(skip ? null : `/api/companies/${books.company.id}/portal/overview`);
  if (skip || !o.data || (!o.data.openRequests && !o.data.unreadLetters)) return null;
  return (
    <div className="notice warn actions" id="home-portal">
      {o.data.openRequests > 0 && <span>{t('home.asked', { n: o.data.openRequests })}</span>}
      {o.data.unreadLetters > 0 && <span>{t('home.newReport')}</span>}
      <span className="spacer" />
      <button className="b small p" onClick={() => go('Portal', 'overview')}>{t('home.openPortal')}</button>
    </div>
  );
}

/** Deadlines overdue or due within 14 days. */
function ComingUp({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const dt = useDates();
  const text = useDeadlineText(books.company.country);
  const c = useApi<CalItem[]>(`/api/companies/${books.company.id}/calendar`);
  const now = today();
  const open = (c.data ?? []).filter((i) => i.status === 'overdue' || i.status === 'soon');
  const next = (c.data ?? []).find((i) => i.status === 'later' && i.due >= now);
  if (!c.data) return null;
  return (
    <div className="card" id="home-deadlines">
      <div className="actions" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>{t('home.deadlines')}</h2><span className="spacer" />
        <button className="link" onClick={() => go('Calendar', 'upcoming')}>{t('home.openCalendar')}</button></div>
      {open.length === 0 ? <div className="mut small">{next ? t('home.nextDeadline', { what: text(next).title, date: dt.day(next.due) }) : t('cal.none')}</div> : (
        <table><tbody>{open.slice(0, 5).map((i) => (
          <tr key={i.key}><td><b>{text(i).title}</b><div className="small mut">{text(i).detail}</div></td>
            <td className="num"><span className={`badge ${i.status === 'overdue' ? 'bad' : 'warn'}`}>{i.status === 'overdue' ? t('cal.s.overdue') : dt.day(i.due)}</span></td></tr>
        ))}</tbody></table>
      )}
    </div>
  );
}

/** For approvers: bills, payments and credit notes waiting for their decision. */
function WaitingApproval({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const w = useApi<{ canApprove: boolean; toDecide: number; approvedToAction: number }>(`/api/companies/${books.company.id}/approvals/waiting`);
  if (!w.data || (!w.data.toDecide && !(books.canPost && w.data.approvedToAction))) return null;
  return (
    <div className="notice warn actions" id="home-approvals">
      {w.data.toDecide > 0 && <span>{t('home.toApprove', { n: w.data.toDecide })}</span>}
      {books.canPost && w.data.approvedToAction > 0 && <span>{t('home.approvedToAction', { n: w.data.approvedToAction })}</span>}
      <span className="spacer" />
      <button className="b small p" onClick={() => go('Approvals', 'waiting')}>{t('home.openApprovals')}</button>
    </div>
  );
}

/** A short checklist for a client still being set up; hidden when everything is done or when dismissed. */
function GettingStarted({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const goTo = useGo(books.company.id);
  const k = `nb_setup_hidden_${books.company.id}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(k) === '1'; } catch { return false; } });
  const s = useApi<{ steps: { key: string; done: boolean; go: [string, string?, string?] }[]; done: number; total: number }>(hidden || !books.canPost ? null : `/api/companies/${books.company.id}/setup-status`);
  if (hidden || !s.data || s.data.done === s.data.total) return null;
  const pct = Math.round((s.data.done / s.data.total) * 100);
  return (
    <div className="card" id="home-setup">
      <div className="actions" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>{t('setup.title')}</h2>
        <span className="small mut">{t('setup.progress', { done: s.data.done, total: s.data.total })}</span><span className="spacer" />
        <button className="link small" onClick={() => { setHidden(true); try { localStorage.setItem(k, '1'); } catch { /* not kept */ } }}>{t('setup.hide')}</button>
      </div>
      <div className="bar-track" style={{ marginBottom: 8 }}><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <ol className="setup-steps">{s.data.steps.map((x) => (
        <li key={x.key} className={x.done ? 'done' : ''}>
          <span className="tick" aria-hidden="true">{x.done ? '✓' : ''}</span>
          <span><b>{t(`setup.s.${x.key}` as Key)}</b><span className="small mut"> {t(`setup.h.${x.key}` as Key)}</span></span>
          {!x.done && <button className="b small" onClick={() => goTo(x.go[0], x.go[1], x.go[2])}>{t(`setup.go.${x.key}` as Key)}</button>}
        </li>
      ))}</ol>
    </div>
  );
}
