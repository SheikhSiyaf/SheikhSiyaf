import { ReviewedBadge } from '../review/Review.tsx';
import { useDates, useDeadlineText, type CalItem } from '../calendar/Calendar.tsx';
import { today } from '../router.ts';
import { useApi, type CompanyBooks } from '../api.ts';
import { navigate } from '../router.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { useState } from 'react';
import { useGo } from '../sales/common.tsx';
import { fmt, neg } from '../money.ts';
import { toMinor, fromMinor } from '../money.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { accessTo } from '../../../src/books/modules.ts';

interface Summary {
  asOf: string; cash: string; receivables: string; payables: string; inputVat: string; outputVat: string;
  monthIncome?: string; monthExpense?: string; monthProfit?: string;   // the month's results only come with the owner reports
  entries: number; entriesThisMonth: number; lockedUpTo: string | null;
}

export function Home({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  // A client role sees the company figures only with Reports or Ledger; quick actions follow its modules.
  const level = (m: string) => accessTo(books.access?.permissions, m);
  const figures = level('Reports') !== 'none' || level('Ledger') !== 'none';
  const s = useApi<Summary>(figures ? `/api/companies/${books.company.id}/summary` : null);
  if (!figures) return (
    <>
      <ComingUp books={books} go={go} />
      <QuickActions books={books} go={go} level={level} />
    </>
  );
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const cur = books.company.currency;
  const vatDue = fromMinor(-toMinor(d.outputVat) - toMinor(d.inputVat));
  const figs: [string, string, string][] = [
    [t('home.cash'), d.cash, t('home.fromLedger')],
    [t('home.receivables'), d.receivables, t('home.fromLedger')],
    [t('home.payables'), neg(d.payables), t('home.fromLedger')],
  ];
  if (d.monthProfit !== undefined) figs.push([t('home.profit'), d.monthProfit, t('home.salesLessExpenses')]);
  return (
    <>
      <ReviewedBadge books={books} go={go} />
      <FromAccountant books={books} go={go} />
      <WaitingApproval books={books} go={go} />
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
      <QuickActions books={books} go={go} level={level} />
    </>
  );
}

/** Shortcuts, each shown only when the person's role may use its module (edit to create, view to read). */
function QuickActions({ books, go, level }: { books: CompanyBooks; go: (m: string, sub?: string) => void; level: (m: string) => string }) {
  const { t } = useI18n();
  const can = (m: string) => books.canPost && level(m) === 'edit';
  const actions: [boolean, string, string, Key][] = [
    [can('Sales'), 'Sales', 'invoices/new', 'ov.newInvoice'], [can('Sales'), 'Sales', 'payments-received/new', 'ov.recordReceipt'],
    [can('Expenses'), 'Expenses', 'expenses/new', 'exp.record'], [can('Purchases'), 'Purchases', 'bills/new', 'ov.newBill'],
    [can('Journal'), 'Journal', 'new', 'home.newEntry'],
    [level('Reports') !== 'none', 'Reports', 'trial-balance', 'home.trialBalance'], [level('Reports') !== 'none', 'Reports', 'vat-summary', 'home.vatSummary'],
  ];
  const shown = actions.filter(([ok]) => ok);
  if (!shown.length) return null;
  return (
    <div className="card">
      <h2>{t('home.quick')}</h2>
      <div className="actions">
        {shown.map(([, m, sub, key], i) => <button key={key} className={i === 0 ? 'b p' : 'b'} onClick={() => go(m, sub)}>{t(key)}</button>)}
      </div>
    </div>
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
  const w = useApi<{ canApprove: boolean; toDecide: number; approvedToAction: number; corrections?: number }>(`/api/companies/${books.company.id}/approvals/waiting`);
  if (!w.data || (!w.data.toDecide && !w.data.corrections && !(books.canPost && w.data.approvedToAction))) return null;
  return (
    <div className="notice warn actions" id="home-approvals">
      {w.data.toDecide > 0 && <span>{t('home.toApprove', { n: w.data.toDecide })}</span>}
      {books.canPost && w.data.approvedToAction > 0 && <span>{t('home.approvedToAction', { n: w.data.approvedToAction })}</span>}
      {(w.data.corrections ?? 0) > 0 && <span>{t('appr.attCorrectionsHint', { n: w.data.corrections! })}</span>}
      <span className="spacer" />
      <button className="b small p" onClick={() => go('Approvals', 'waiting')}>{t('home.openApprovals')}</button>
    </div>
  );
}
