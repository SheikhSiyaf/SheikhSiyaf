// Ledger reports: general (account) ledger, cost centre ledger, and customer / supplier / employee ledgers.
import { useState, type ReactNode } from 'react';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { moduleForType, pageForType } from '../books/nav.ts';

interface LRow { date: string; entryId: string; memo: string | null; sourceType: string | null; sourceId: string | null; accountCode: string;
  accountName: string; accountNameAr: string | null; costCentre: string | null; costCentreAr: string | null; debit: string; credit: string; balance?: string; number?: string | null }

function useRange() {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  return { from, to, setFrom, setTo };
}
function RangeInputs({ r }: { r: ReturnType<typeof useRange> }) {
  const { t } = useI18n();
  return (
    <>
      <label className="f">{t('from')}<input type="date" value={r.from} onChange={(e) => r.setFrom(e.target.value)} /></label>
      <label className="f">{t('to')}<input type="date" value={r.to} onChange={(e) => r.setTo(e.target.value)} /></label>
    </>
  );
}

/** Where a line came from, as a link to its document or payment when there is one. */
function Source({ books, r }: { books: CompanyBooks; r: LRow }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const docTypes = ['invoice', 'credit_note', 'bill', 'supplier_credit', 'expense', 'claim', 'quotation'];
  if (r.sourceId && r.sourceType && docTypes.includes(r.sourceType)) {
    return <button className="link" onClick={() => go(moduleForType(r.sourceType!), pageForType(r.sourceType!), r.sourceId!)}>{r.memo ?? t('doc.draftNo')}</button>;
  }
  if (r.sourceId && (r.sourceType === 'payment_received' || r.sourceType === 'payment_made')) {
    return <button className="link" onClick={() => go(r.sourceType === 'payment_received' ? 'Sales' : 'Purchases', r.sourceType === 'payment_received' ? 'payments-received' : 'payments-made', r.sourceId!)}>{r.memo}</button>;
  }
  if (r.sourceId && (r.sourceType === 'grn' || r.sourceType === 'gdn')) return <button className="link" onClick={() => go('Inventory', r.sourceType!, r.sourceId!)}>{r.memo}</button>;
  if (r.sourceId && r.sourceType === 'asset_disposal') return <button className="link" onClick={() => go('Assets', 'register', r.sourceId!)}>{r.memo}</button>;
  if (r.sourceType === 'depreciation') return <button className="link" onClick={() => go('Assets', 'depreciation')}>{r.memo}</button>;
  return <>{r.memo ?? '—'}</>;
}

function LinesTable({ books, rows, opening, closing, totalDebit, totalCredit, showAccount, showCc }: {
  books: CompanyBooks; rows: LRow[]; opening?: string; closing?: string; totalDebit?: string; totalCredit?: string; showAccount?: boolean; showCc?: boolean;
}) {
  const { t } = useI18n();
  const local = useLocalName();
  const running = rows.some((r) => r.balance !== undefined);
  return (
    <div className="wrap">
      <table className="stack ledger">
        <thead><tr><th>{t('doc.date')}</th><th>{t('led.details')}</th>{showAccount && <th>{t('journal.account')}</th>}{showCc && <th>{t('journal.costCentre')}</th>}
          <th className="num">{t('debit')}</th><th className="num">{t('credit')}</th>{running && <th className="num">{t('led.balance')}</th>}</tr></thead>
        <tbody>
          {opening !== undefined && (
            <tr className="mut"><td /><td>{t('led.opening')}</td>{showAccount && <td />}{showCc && <td />}<td /><td />{running && <td className="num ltr">{fmt(opening)}</td>}</tr>
          )}
          {rows.map((r, i) => (
            <tr key={`${r.entryId}-${i}`}>
              <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
              <td><Source books={books} r={r} /></td>
              {showAccount && <td className="small" data-label={t('journal.account')}>{r.accountCode} {local(r.accountName, r.accountNameAr)}</td>}
              {showCc && <td className="small" data-label={t('journal.costCentre')}>{r.costCentre ? local(r.costCentre, r.costCentreAr ?? null) : '—'}</td>}
              <td className="num ltr" data-label={t('debit')}>{toMinor(r.debit) ? fmt(r.debit) : ''}</td>
              <td className="num ltr" data-label={t('credit')}>{toMinor(r.credit) ? fmt(r.credit) : ''}</td>
              {running && <td className="num ltr" data-label={t('led.balance')}>{fmt(r.balance!)}</td>}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="mut">{t('reports.noActivity')}</td></tr>}
          {totalDebit !== undefined && (
            <tr className="total"><td /><td>{t('led.closing')}</td>{showAccount && <td />}{showCc && <td />}<td className="num ltr">{fmt(totalDebit)}</td>
              <td className="num ltr">{fmt(totalCredit!)}</td>{running && <td className="num ltr">{fmt(closing!)}</td>}</tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Header({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <div className="actions" style={{ marginBottom: 8 }}><h2 style={{ margin: 0, flex: '1 1 200px' }}>{title}</h2>{children}</div>;
}

export function GeneralLedger({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const r = useRange();
  const [accountId, setAccountId] = useState(books.accounts.find((a) => a.isBank)?.id ?? books.accounts[0]?.id ?? '');
  const d = useApi<{ opening: string; closing: string; totalDebit: string; totalCredit: string; rows: LRow[] }>(
    accountId ? `/api/companies/${books.company.id}/ledger/account/${accountId}?from=${r.from}&to=${r.to}` : null);
  return (
    <div className="card">
      <Header title={`${t('sub.general-ledger')} (${books.company.currency})`}>
        <label className="f">{t('journal.account')}
          <select id="gl-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {books.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
          </select>
        </label>
        <RangeInputs r={r} />
      </Header>
      {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
      {!d.data ? <Loading /> : <LinesTable books={books} {...d.data} showCc />}
    </div>
  );
}

export function CostCentreLedger({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const r = useRange();
  const [ccId, setCcId] = useState(books.costCentres[0]?.id ?? '');
  const d = useApi<{ rows: LRow[]; income: string; expense: string; profit: string }>(
    ccId ? `/api/companies/${books.company.id}/ledger/cost-centre/${ccId}?from=${r.from}&to=${r.to}` : null);
  return (
    <div className="card">
      <Header title={`${t('sub.cost-centre-ledger')} (${books.company.currency})`}>
        <label className="f">{t('journal.costCentre')}
          <select id="cc-pick" value={ccId} onChange={(e) => setCcId(e.target.value)}>
            {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}{c.kind === 'project' ? ` · ${t('proj.project')}` : ''}</option>)}
          </select>
        </label>
        <RangeInputs r={r} />
      </Header>
      {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
      {!d.data ? <Loading /> : (
        <>
          <div className="grid">
            <div className="card fig"><small>{t('reports.income')}</small><b className="ltr">{fmt(d.data.income)}</b></div>
            <div className="card fig"><small>{t('reports.expenses')}</small><b className="ltr">{fmt(d.data.expense)}</b></div>
            <div className="card fig"><small>{t('reports.netProfit')}</small><b className="ltr">{fmt(d.data.profit)}</b></div>
          </div>
          <LinesTable books={books} rows={d.data.rows} showAccount />
        </>
      )}
    </div>
  );
}

type Role = 'customer' | 'supplier' | 'employee';
interface Balance { id: string; name: string; nameAr: string | null; employeeNo: string | null; status: string; balance: string }

/** List of customers / suppliers / employees with their balance; pick one to see their ledger. */
export function ContactLedgers({ books, role, contactId }: { books: CompanyBooks; role: Role; contactId?: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const sub = `${role}-ledger`;
  const list = useApi<Balance[]>(contactId ? null : `/api/companies/${books.company.id}/ledger/balances/${role}`);
  if (contactId) return <ContactLedger books={books} role={role} contactId={contactId} />;
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const total = list.data.reduce((s, x) => s + toMinor(x.balance), 0n);
  return (
    <div className="card">
      <p className="mut small" style={{ marginTop: 0 }}>{t(`led.hint.${role}` as Key)}</p>
      {list.data.length === 0 ? <div className="mut">{t('none')}</div> : (
        <div className="wrap">
          <table className="stack">
            <thead><tr><th>{t('col.name')}</th><th className="num">{t(`led.balance.${role}` as Key)}</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className={c.status !== 'active' ? 'mut' : ''}>
                  <td><button className="link" onClick={() => go('Ledger', sub, c.id)}>{local(c.name, c.nameAr)}</button>{c.employeeNo && <span className="mut small"> · {c.employeeNo}</span>}</td>
                  <td className="num ltr" data-label={t(`led.balance.${role}` as Key)}>{fmt(c.balance)}</td>
                </tr>
              ))}
              <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(fromMinor(total))}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ContactLedger({ books, role, contactId }: { books: CompanyBooks; role: Role; contactId: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const r = useRange();
  const d = useApi<{ contact: { name: string; nameAr: string | null }; opening: string; closing: string; totalDebit: string; totalCredit: string; rows: LRow[] }>(
    `/api/companies/${books.company.id}/ledger/contact/${contactId}?from=${r.from}&to=${r.to}`);
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Ledger', `${role}-ledger`)}>{t(`led.back.${role}` as Key)}</button>
        <span className="spacer" />
        {role === 'employee' && books.canPost && (
          <>
            <button className="b" onClick={() => go('Expenses', 'claims', 'new', contactId)}>{t('claim.new')}</button>
            <button className="b p" onClick={() => go('Purchases', 'payments-made', 'new', contactId)}>{t('claim.reimburse')}</button>
          </>
        )}
      </div>
      <div className="card">
        <Header title={d.data ? local(d.data.contact.name, d.data.contact.nameAr) : ''}>
          <RangeInputs r={r} />
        </Header>
        <p className="mut small">{t(`led.balance.${role}` as Key)}</p>
        {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
        {!d.data ? <Loading /> : <LinesTable books={books} {...d.data} />}
      </div>
    </>
  );
}
