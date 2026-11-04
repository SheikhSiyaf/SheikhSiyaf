// Bank: bank accounts (add your own), statement import (CSV or Excel), reviewing statement lines with
// suggestions, reconciliation and rules. The bank's own lines are never changed; each one is matched to the books.
import { useMemo, useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { ArabicHint } from '../arabic.tsx';
import { bankFromIban, detectLayout, findAccountInFile, ibanValid, normaliseIban, parseCsv, readStatement, type Layout, type StatementRow } from '../../../src/bank/statement.ts';
import { readXlsx } from '../../../src/bank/xlsx.ts';

export interface BankAccount {
  id: string; accountId: string; kind: 'bank' | 'cash' | 'card'; bankName: string | null; accountNumber: string | null; iban: string | null; status: string;
  importLayout: Layout | null; code: string; name: string; nameAr: string | null; booksBalance: string; openLines: number; lastStatementDate: string | null;
}
type Suggestion =
  | { kind: 'match'; journalLineId: string; date: string; memo: string | null }
  | { kind: 'pay'; contactId: string; contactName: string; documentNumber: string }
  | { kind: 'rule'; ruleId: string; accountId: string; costCentreId: string | null; vatCode: string; accountCode: string; accountName: string; accountNameAr: string | null; label: string | null };
interface Line {
  id: string; date: string; description: string; reference: string | null; amount: string; balance: string | null; status: 'open' | 'matched' | 'ignored';
  matchedMemo: string | null; suggestion: Suggestion | null;
}
interface Recon {
  statementDate: string | null; statementBalance: string | null; booksBalance: string; adjustedBooks?: string; difference: string | null;
  inBooksOnly: { journalLineId: string; date: string; memo: string | null; amount: string }[]; onStatementOnly: { id: string; date: string; description: string; amount: string }[];
}

const Amount = ({ v }: { v: string }) => <span className={`num ltr ${toMinor(v) < 0n ? 'bad' : 'good'}`}>{fmt(v)}</span>;
const prettyIban = (s: string | null) => (s ? s.replace(/(.{4})/g, '$1 ').trim() : '');

function useAccounts(books: CompanyBooks) {
  return useApi<BankAccount[]>(`/api/companies/${books.company.id}/bank-accounts`);
}

// ------------------------------------------------------------------ bank accounts
export function BankAccountList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const list = useAccounts(books);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <p className="mut small" style={{ flex: '1 1 260px', margin: 0 }}>{t('bank.hint')}</p>
        {books.canPost && <button className="b p" onClick={() => go('Bank', 'accounts', 'new')}>{t('bank.addPlus')}</button>}
      </div>
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? <Loading /> : (
        <div className="grid projects">
          {list.data.map((b) => (
            <button key={b.id} className={`card tile ${b.status !== 'active' ? 'mut' : ''}`} onClick={() => go('Bank', 'accounts', b.id)}>
              <div className="actions"><b style={{ flex: 1 }}>{local(b.name, b.nameAr)}</b><span className="badge">{t(`bank.kind.${b.kind}` as Key)}</span></div>
              <div className="small mut ltr">{b.code}{b.iban ? ` · ${prettyIban(b.iban)}` : b.accountNumber ? ` · ${b.accountNumber}` : ''}</div>
              <table className="mini"><tbody>
                <tr className="total"><td>{t('bank.booksBalance')}</td><td className="num ltr">{fmt(b.booksBalance)}</td></tr>
                <tr><td>{t('bank.lastStatement')}</td><td className="num ltr">{b.lastStatementDate ?? '—'}</td></tr>
              </tbody></table>
              {b.openLines > 0 ? <span className="badge warn">{t('bank.toReview', { n: b.openLines })}</span>
                : b.lastStatementDate ? <span className="badge good">{t('bank.allDone')}</span> : <span className="small mut">{t('bank.noStatement')}</span>}
              {b.status !== 'active' && <span className="badge">{t('bank.closed')}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function BankAccountForm({ books, id, onDone }: { books: CompanyBooks; id?: string; onDone?: () => void }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const cur = useApi<BankAccount>(id ? `/api/bank-accounts/${id}` : null);
  const [f, setF] = useState<{ kind: string; bankName: string; accountNumber: string; iban: string; name: string; nameAr: string; status: string }>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!f && (!id || cur.data)) {
    const x = cur.data;
    setF({ kind: x?.kind ?? 'bank', bankName: x?.bankName ?? '', accountNumber: x?.accountNumber ?? '', iban: x?.iban ? prettyIban(x.iban) : '',
      name: x?.name ?? '', nameAr: x?.nameAr ?? '', status: x?.status ?? 'active' });
  }
  if (cur.error) return <ErrorNote error={cur.error} onRetry={cur.reload} />;
  if (!f) return <Loading />;
  const iban = normaliseIban(f.iban);
  const ibanOk = !iban || ibanValid(iban);
  const known = iban && ibanOk ? bankFromIban(iban) : undefined;
  const set = (k: keyof typeof f, v: string) => {
    const next = { ...f, [k]: v };
    if (k === 'iban') {   // the IBAN names the bank: fill in the bank name while it is empty or was filled in from the IBAN before
      const b = ibanValid(normaliseIban(v)) ? bankFromIban(v) : undefined;
      if (b && (!f.bankName || f.bankName === known?.name)) next.bankName = b.name;
    }
    setF(next);
  };
  const canSave = books.canPost && ibanOk && (f.kind !== 'bank' || f.bankName.trim() !== '' || Boolean(known)) && (f.kind === 'bank' || f.name.trim() !== '');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<{ id: string }>(id ? `/api/bank-accounts/${id}` : `/api/companies/${books.company.id}/bank-accounts`, { body: { ...f, iban } });
      if (onDone) onDone(); else go('Bank', 'accounts', r.id);
    } catch (err) { setMsg(errorText(t, has, err)); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={save} noValidate>
      <h2>{id ? t('bank.editTitle') : t('bank.addTitle')}</h2>
      {msg && <div className="notice bad" role="alert">{msg}</div>}
      <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="chips" role="radiogroup" aria-label={t('bank.kind')} style={{ marginBottom: 12 }}>
          {(['bank', 'cash', 'card'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={f.kind === k} className={`b ${f.kind === k ? 'p' : ''}`} onClick={() => set('kind', k)}>{t(`bank.kind.${k}` as Key)}</button>
          ))}
        </div>
        {f.kind !== 'cash' && (
          <div className="row">
            <label className="f">{t('bank.iban')}
              <input id="ba-iban" dir="ltr" value={f.iban} onChange={(e) => set('iban', e.target.value.toUpperCase())} placeholder={books.company.country === 'AE' ? 'AE07 0331 2345 6789 0123 456' : 'SA03 8000 0000 6080 1016 7519'} />
              {!ibanOk && iban.length >= 15 && <span className="small bad">{t('bank.ibanCheck')}</span>}
              {known && <span className="small good">{t('bank.recognised', { bank: known.name })}</span>}
            </label>
            <label className="f">{t('bank.bankName')}<input id="ba-bank" value={f.bankName} onChange={(e) => set('bankName', e.target.value)} /></label>
            <label className="f">{t('bank.accountNumber')}<input id="ba-number" dir="ltr" value={f.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} /></label>
          </div>
        )}
        <div className="row">
          <label className="f">{t('bank.displayName')}<input id="ba-name" value={f.name} placeholder={f.kind === 'cash' ? t('bank.cashExample') : t('bank.nameAuto')} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="f">{t('ar.nameAr')}<input id="ba-name-ar" dir="rtl" value={f.nameAr} placeholder={known?.nameAr} onChange={(e) => set('nameAr', e.target.value)} /><ArabicHint english={f.name} arabic={f.nameAr} /></label>
        </div>
        {id && toMinor(cur.data?.booksBalance ?? '0') === 0n && (
          <label className="actions" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.status === 'closed'} onChange={(e) => set('status', e.target.checked ? 'closed' : 'active')} /><span>{t('bank.closeAccount')}</span></label>
        )}
        <p className="mut small">{t('bank.ledgerNote')}</p>
        {books.canPost && <button className="b p" type="submit" disabled={busy || !canSave}>{id ? t('admin.saveDetails') : t('bank.add')}</button>}
      </fieldset>
    </form>
  );
}

// ------------------------------------------------------------------ one bank account: its statement lines
export function BankAccountPage({ books, id, filter }: { books: CompanyBooks; id: string; filter?: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const acct = useApi<BankAccount>(`/api/bank-accounts/${id}`);
  const status = filter ?? 'open';
  const lines = useApi<Line[]>(`/api/bank-accounts/${id}/lines?status=${status}`);
  const recon = useApi<Recon>(`/api/bank-accounts/${id}/reconciliation`);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string>();
  const reload = () => { lines.reload(); recon.reload(); acct.reload(); };
  if (acct.error) return <ErrorNote error={acct.error} onRetry={acct.reload} />;
  if (!acct.data) return <Loading />;
  const b = acct.data;
  const rules = (lines.data ?? []).filter((l) => l.suggestion?.kind === 'rule').length;
  const applyRules = async () => {
    const r = await api<{ booked: number }>(`/api/bank-accounts/${id}/apply-rules`, { body: {} });
    setMsg(t('bank.rulesApplied', { n: r.booked })); reload();
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Bank', 'accounts')}>{t('bank.back')}</button>
        <span className="spacer" />
        {books.canPost && b.status === 'active' && <button className="b p" onClick={() => go('Bank', 'import', id)}>{t('sub.import')}</button>}
        <button className="b" onClick={() => go('Bank', 'reconcile', id)}>{t('sub.reconcile')}</button>
        {books.canPost && <button className="b" onClick={() => setEditing(!editing)}>{t('bank.editDetails')}</button>}
      </div>
      {editing ? <BankAccountForm books={books} id={id} onDone={() => { setEditing(false); acct.reload(); }} /> : (
        <div className="card">
          <h2 style={{ marginBottom: 2 }}>{local(b.name, b.nameAr)}</h2>
          <div className="small mut ltr">{[b.code, b.bankName, prettyIban(b.iban) || b.accountNumber].filter(Boolean).join(' · ')}</div>
          <div className="grid" style={{ marginTop: 10 }}>
            <div className="fig"><small>{t('bank.booksBalance')}</small><b className="ltr">{fmt(b.booksBalance)}</b></div>
            <div className="fig"><small>{t('bank.statementBalance')}{recon.data?.statementDate ? ` · ${recon.data.statementDate}` : ''}</small><b className="ltr">{recon.data?.statementBalance ? fmt(recon.data.statementBalance) : '—'}</b></div>
            <div className="fig"><small>{t('bank.unmatched')}</small><b>{b.openLines}</b></div>
          </div>
        </div>
      )}
      {b.kind === 'bank' && b.status === 'active' && <BankFeedCard books={books} id={id} onSynced={reload} />}
      {msg && <div className="notice">{msg}</div>}
      <div className="top" style={{ marginBottom: 10 }}>
        <div className="chips" role="tablist">
          {(['open', 'matched', 'ignored', 'all'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} className={`b ${status === s ? 'p' : ''}`} onClick={() => go('Bank', 'accounts', id, s)}>{t(`bank.filter.${s}` as Key)}</button>
          ))}
        </div>
        {books.canPost && status === 'open' && rules > 0 && <button className="b" onClick={applyRules}>{t('bank.applyRules', { n: rules })}</button>}
      </div>
      {lines.error && <ErrorNote error={lines.error} onRetry={lines.reload} />}
      {!lines.data ? <Loading /> : lines.data.length === 0 ? (
        <div className="card mut">{status === 'open' ? (b.lastStatementDate ? t('bank.nothingToReview') : t('bank.importFirst')) : t('none')}</div>
      ) : (
        <div className="card">
          {lines.data.map((l) => <StatementLine key={l.id} books={books} line={l} onChange={reload} />)}
        </div>
      )}
    </>
  );
}

interface Feed { id: string; provider: string; status: 'active' | 'expired' | 'error'; consentExpiresOn: string | null; lastSyncAt: string | null; syncedTo: string | null;
  lastError: string | null; connectedBy: string | null }
/** Direct bank feed (db/migrations/0038): connect the account through an open-banking provider; lines then come in by themselves. */
function BankFeedCard({ books, id, onSynced }: { books: CompanyBooks; id: string; onSynced: () => void }) {
  const { t, has } = useI18n();
  const d = useApi<{ feed: Feed | null; providers: { key: string; ready: boolean }[] }>(`/api/bank-accounts/${id}/feed`);
  const [pick, setPick] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const act = async (path: string, body: unknown, ok: (r: { imported?: number; booked?: number; expired?: boolean }) => string) => {
    setBusy(true); setMsg({});
    try { const r = await api<{ imported?: number; booked?: number; expired?: boolean }>(`/api/bank-accounts/${id}/feed${path}`, { body }); setMsg({ ok: ok(r) }); setPick(undefined); d.reload(); onSynced(); }
    catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (!d.data) return null;
  const f = d.data.feed;
  const synced = (r: { imported?: number; booked?: number; expired?: boolean }) => r.expired ? t('feed.expiredNow') : t('feed.synced', { n: r.imported ?? 0, b: r.booked ?? 0 });
  return (
    <div className="card" id="bank-feed">
      <div className="actions"><h2 style={{ margin: 0 }}>{t('feed.title')}</h2><span className="spacer" />
        {f && <span className={`badge ${f.status === 'active' ? 'good' : 'bad'}`}>{t(`feed.st.${f.status}` as Key)}</span>}</div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {f ? <>
        <div className="small mut">{t('feed.connected', { provider: t(`feed.provider.${f.provider}` as Key), name: f.connectedBy ?? '' })}
          {f.syncedTo && <> · {t('feed.syncedTo', { date: f.syncedTo })}</>}{f.consentExpiresOn && <> · {t('feed.consentTo', { date: f.consentExpiresOn })}</>}</div>
        {f.status === 'expired' && <div className="small bad">{t('feed.expiredHint')}</div>}
        {f.lastError && <div className="small bad">{f.lastError}</div>}
        {books.canPost && <div className="actions" style={{ marginTop: 8 }}>
          {f.status !== 'expired' && <button className="b p" id="feed-sync" disabled={busy} onClick={() => void act('/sync', {}, synced)}>{t('feed.syncNow')}</button>}
          <button className="b" id="feed-disconnect" disabled={busy} onClick={() => void act('/disconnect', {}, () => t('feed.disconnected'))}>{t('feed.disconnect')}</button>
        </div>}
      </> : <>
        <div className="small mut">{t('feed.hint')}</div>
        {books.canPost && (pick === undefined
          ? <div className="actions" style={{ marginTop: 8 }}><button className="b p" id="feed-connect" onClick={() => setPick('sandbox')}>{t('feed.connect')}</button></div>
          : <div style={{ marginTop: 8 }}>
              <div className="seg" role="radiogroup">
                {d.data.providers.map((p) => <button key={p.key} type="button" role="radio" aria-checked={pick === p.key} id={`feed-provider-${p.key}`} disabled={!p.ready}
                  className={pick === p.key ? 'on' : ''} onClick={() => setPick(p.key)}>{t(`feed.provider.${p.key}` as Key)}{!p.ready && ` · ${t('feed.soon')}`}</button>)}
              </div>
              <div className="small mut" style={{ margin: '6px 0' }}>{t(`feed.providerHint.${pick}` as Key)}</div>
              <div className="actions"><button className="b p" id="feed-connect-go" disabled={busy} onClick={() => void act('', { provider: pick }, synced)}>{t('feed.connectGo')}</button>
                <button className="b" onClick={() => setPick(undefined)}>{t('cancel')}</button></div>
            </div>)}
      </>}
    </div>
  );
}

function StatementLine({ books, line, onChange }: { books: CompanyBooks; line: Line; onChange: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true); setErr(undefined);
    try { await api(path, { body }); onChange(); } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const s = line.suggestion;
  const moneyIn = toMinor(line.amount) > 0n;
  return (
    <div className="bankline" data-status={line.status}>
      <div className="bl-main">
        <div className="bl-date ltr small mut">{line.date}</div>
        <div className="bl-desc">{line.description}{line.reference && <span className="small mut ltr"> · {line.reference}</span>}</div>
        <div className="bl-amt"><Amount v={line.amount} /></div>
      </div>
      {line.status === 'matched' && (
        <div className="bl-sugg"><span className="badge good">{t('bank.matched')}</span> <span className="small">{line.matchedMemo}</span>
          {books.canPost && <button className="link small" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/unmatch`)}>{t('bank.unmatch')}</button>}</div>
      )}
      {line.status === 'ignored' && (
        <div className="bl-sugg"><span className="badge">{t('bank.ignored')}</span>
          {books.canPost && <button className="link small" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/unmatch`)}>{t('bank.restore')}</button>}</div>
      )}
      {line.status === 'open' && books.canPost && (
        <div className="bl-sugg">
          {s?.kind === 'match' && <><span className="small">{t('bank.sugMatch', { memo: s.memo ?? '', date: s.date })}</span>
            <button className="b small p" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/match`, { journalLineId: s.journalLineId })}>{t('bank.match')}</button></>}
          {s?.kind === 'pay' && <><span className="small">{t(moneyIn ? 'bank.sugReceived' : 'bank.sugPaid', { name: s.contactName, doc: s.documentNumber })}</span>
            <button className="b small p" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/pay`, { contactId: s.contactId })}>{t('bank.recordPayment')}</button></>}
          {s?.kind === 'rule' && <><span className="small">{t('bank.sugRule', { account: `${s.accountCode} ${local(s.accountName, s.accountNameAr)}` })}</span>
            <button className="b small p" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/book`, { accountId: s.accountId, costCentreId: s.costCentreId, vatCode: s.vatCode, description: s.label })}>{t('bank.book')}</button></>}
          {!s && <span className="small mut">{t('bank.noSuggestion')}</span>}
          <button className="b small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('cancel') : t('bank.choose')}</button>
        </div>
      )}
      {err && <div className="notice bad small" role="alert">{err}</div>}
      {open && line.status === 'open' && <LineActions books={books} line={line} busy={busy} act={act} />}
    </div>
  );
}

function LineActions({ books, line, busy, act }: { books: CompanyBooks; line: Line; busy: boolean; act: (path: string, body?: unknown) => Promise<void> }) {
  const { t } = useI18n();
  const local = useLocalName();
  const moneyIn = toMinor(line.amount) > 0n;
  const [tab, setTab] = useState<'book' | 'pay' | 'find'>('book');
  const contacts = useApi<Contact[]>(tab === 'pay' ? `/api/companies/${books.company.id}/contacts?role=${moneyIn ? 'customer' : 'payee'}` : null);
  const candidates = useApi<{ journalLineId: string; date: string; memo: string | null; amount: string }[]>(tab === 'find' ? `/api/bank-lines/${line.id}/candidates` : null);
  const accounts = books.accounts.filter((a) => a.code !== '1300');   // stock moves only through goods notes
  const [f, setF] = useState({ accountId: '', vatCode: moneyIn ? 'out_of_scope' : 'standard', costCentreId: '', description: line.description, remember: false,
    matchText: line.description.replace(/[0-9#*/-]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ') });
  const [contactId, setContactId] = useState('');
  const acct = books.accounts.find((a) => a.id === f.accountId);
  const isExpense = !moneyIn && acct?.type === 'expense';
  const needsCc = Boolean(acct?.costCentreRequired) && !f.costCentreId;
  return (
    <div className="bl-panel">
      <div className="chips" role="tablist" style={{ marginBottom: 10 }}>
        {(['book', 'pay', 'find'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`b small ${tab === k ? 'p' : ''}`} onClick={() => setTab(k)}>{t(`bank.tab.${k}${k === 'pay' ? (moneyIn ? 'In' : 'Out') : ''}` as Key)}</button>
        ))}
        <button className="b small" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/ignore`)}>{t('bank.ignore')}</button>
      </div>
      {tab === 'book' && (
        <>
          <div className="row">
            <label className="f">{t('journal.account')}
              <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                <option value="">{t('bank.chooseAccount')}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
              </select>
            </label>
            {isExpense && (
              <label className="f">{t('doc.vat')}
                <select value={f.vatCode} onChange={(e) => setF({ ...f, vatCode: e.target.value })}>
                  {['standard', 'zero', 'exempt', 'out_of_scope'].map((v) => <option key={v} value={v}>{t(`vat.${v}` as Key, { rate: Number(books.company.vatRate) })}</option>)}
                </select>
              </label>
            )}
            <label className="f">{t('journal.costCentre')}
              <select value={f.costCentreId} onChange={(e) => setF({ ...f, costCentreId: e.target.value })}>
                <option value="">—</option>
                {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
          </div>
          <label className="f">{t('doc.description')}<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="actions small" style={{ margin: '8px 0' }}>
            <input type="checkbox" checked={f.remember} onChange={(e) => setF({ ...f, remember: e.target.checked })} />
            <span>{t('bank.always')}</span>
            {f.remember && <input dir="auto" value={f.matchText} onChange={(e) => setF({ ...f, matchText: e.target.value })} aria-label={t('bank.ruleText')} style={{ maxWidth: 220 }} />}
          </label>
          <p className="small mut">{isExpense ? t('bank.bookExpenseNote') : t('bank.bookJournalNote')}</p>
          {needsCc && <p className="small bad">{t('err.costCentreRequired')}</p>}
          <button className="b p" disabled={busy || !f.accountId || needsCc || (f.remember && f.matchText.trim().length < 3)}
            onClick={() => act(`/api/bank-lines/${line.id}/book`, { accountId: f.accountId, vatCode: isExpense ? f.vatCode : 'out_of_scope', costCentreId: f.costCentreId || null,
              description: f.description, remember: f.remember ? f.matchText : null })}>{t('bank.bookAndMatch')}</button>
        </>
      )}
      {tab === 'pay' && (
        <>
          {!contacts.data ? <Loading /> : (
            <label className="f">{t(moneyIn ? 'contact.customer' : 'bank.payee')}
              <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">—</option>
                {contacts.data.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}{c.balanceDue && toMinor(c.balanceDue) > 0n ? ` · ${fmt(c.balanceDue)}` : ''}</option>)}
              </select>
            </label>
          )}
          <p className="small mut">{t('bank.payNote')}</p>
          <button className="b p" disabled={busy || !contactId} onClick={() => act(`/api/bank-lines/${line.id}/pay`, { contactId })}>{t('bank.recordPayment')}</button>
        </>
      )}
      {tab === 'find' && (!candidates.data ? <Loading /> : candidates.data.length === 0 ? <p className="small mut">{t('bank.noCandidates')}</p> : (
        <table className="mini"><tbody>
          {candidates.data.map((c) => (
            <tr key={c.journalLineId}><td className="ltr small">{c.date}</td><td className="small">{c.memo}</td><td className="num"><Amount v={c.amount} /></td>
              <td><button className="b small p" disabled={busy} onClick={() => act(`/api/bank-lines/${line.id}/match`, { journalLineId: c.journalLineId })}>{t('bank.match')}</button></td></tr>
          ))}
        </tbody></table>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ import
/** Reads a .csv or .xlsx file in the browser. */
async function readFile(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  return parseCsv(await file.text());
}
const layoutFits = (l: Layout | null | undefined, rows: string[][]): l is Layout =>
  Boolean(l && rows[l.headerRow] && readStatement(rows, l).lines.length > 0);

export function ImportStatement({ books, bankId }: { books: CompanyBooks; bankId?: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const accounts = useAccounts(books);
  const [file, setFile] = useState<{ name: string; rows: string[][] }>();
  const [chosen, setChosen] = useState<string | undefined>(bankId);
  const [recognised, setRecognised] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ imported: number; skipped: number; bank: string }>();
  const [busy, setBusy] = useState(false);
  const active = (accounts.data ?? []).filter((a) => a.status === 'active');
  const acct = active.find((a) => a.id === chosen);

  const onFile = async (f: File | undefined) => {
    setErr(undefined); setDone(undefined);
    if (!f) return;
    if (!/\.(csv|txt|xlsx)$/i.test(f.name)) { setErr(t('bank.fileType')); return; }
    try {
      const rows = await readFile(f);
      setFile({ name: f.name, rows });
      const found = findAccountInFile(rows, active.map((a) => ({ id: a.id, iban: a.iban, accountNumber: a.accountNumber })));
      const target = found ?? chosen;
      setRecognised(Boolean(found));
      if (found) setChosen(found);
      const remembered = active.find((a) => a.id === target)?.importLayout;
      setLayout(layoutFits(remembered, rows) ? remembered : detectLayout(rows));
    } catch { setErr(t('bank.fileUnreadable')); }
  };
  const result = useMemo(() => (file && layout ? readStatement(file.rows, layout) : null), [file, layout]);
  const totals = useMemo(() => {
    if (!result) return null;
    const inn = result.lines.filter((l) => toMinor(l.amount) > 0n).reduce((s, l) => s + toMinor(l.amount), 0n);
    const out = result.lines.filter((l) => toMinor(l.amount) < 0n).reduce((s, l) => s + toMinor(l.amount), 0n);
    const dates = result.lines.map((l) => l.date).sort();
    return { inn, out, from: dates[0], to: dates.at(-1) };
  }, [result]);

  const doImport = async () => {
    if (!acct || !result?.lines.length) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api<{ imported: number; skipped: number }>(`/api/bank-accounts/${acct.id}/import`, { body: { fileName: file!.name, lines: result.lines, layout } });
      setDone({ ...r, bank: acct.id }); setFile(undefined); accounts.reload();
    } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };

  if (accounts.error) return <ErrorNote error={accounts.error} onRetry={accounts.reload} />;
  if (!accounts.data) return <Loading />;
  return (
    <>
      {done && (
        <div className="notice">
          {t('bank.imported', { n: done.imported })}{done.skipped > 0 && ` ${t('bank.skipped', { n: done.skipped })}`}{' '}
          <button className="link" onClick={() => go('Bank', 'accounts', done.bank)}>{t('bank.reviewNow')}</button>
        </div>
      )}
      <div className="card">
        <h2>{t('bank.importTitle')}</h2>
        <p className="mut small">{t('bank.importHint')}</p>
        <label className="f">{t('bank.file')}<input id="st-file" type="file" accept=".csv,.txt,.xlsx" disabled={!books.canPost}
          onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ''; void onFile(picked); }} />
          {file && <span className="small mut">{file.name}</span>}</label>
        {err && <div className="notice bad" role="alert">{err}</div>}
        {file && (
          <>
            <label className="f">{t('bank.intoAccount')}
              <select id="st-account" value={chosen ?? ''} onChange={(e) => { setChosen(e.target.value); setRecognised(false);
                const rem = active.find((a) => a.id === e.target.value)?.importLayout; if (layoutFits(rem, file.rows)) setLayout(rem); }}>
                <option value="">{t('bank.chooseBank')}</option>
                {active.map((a) => <option key={a.id} value={a.id}>{local(a.name, a.nameAr)}{a.iban ? ` · ${a.iban.slice(-4)}` : ''}</option>)}
              </select>
              {recognised && acct && <span className="small good">{t('bank.recognisedFile', { bank: local(acct.name, acct.nameAr) })}</span>}
            </label>
            {!layout ? <ColumnPicker rows={file.rows} onPick={setLayout} /> : (
              <>
                <div className="actions small mut" style={{ margin: '6px 0' }}>
                  <span>{t('bank.columnsFound')}</span>
                  <button className="link small" onClick={() => setLayout(null)}>{t('bank.changeColumns')}</button>
                </div>
                {result && totals && (
                  <>
                    <div className="grid" style={{ margin: '8px 0' }}>
                      <div className="fig"><small>{t('bank.lines')}</small><b>{result.lines.length}</b></div>
                      <div className="fig"><small>{t('bank.period')}</small><b className="ltr small">{totals.from} → {totals.to}</b></div>
                      <div className="fig"><small>{t('bank.moneyIn')}</small><b className="ltr good">{fmt(fromMinor(totals.inn))}</b></div>
                      <div className="fig"><small>{t('bank.moneyOut')}</small><b className="ltr bad">{fmt(fromMinor(-totals.out))}</b></div>
                    </div>
                    {result.leftOut > 0 && <p className="small mut">{t('bank.leftOut', { n: result.leftOut })}</p>}
                    <Preview lines={result.lines.slice(0, 8)} more={result.lines.length - 8} />
                  </>
                )}
                <button id="st-import" className="b p" disabled={busy || !acct || !result?.lines.length} onClick={doImport}>
                  {acct ? t('bank.importN', { n: result?.lines.length ?? 0 }) : t('bank.chooseBank')}
                </button>
              </>
            )}
          </>
        )}
      </div>
      <p className="mut small">{t('bank.feedsLater')}</p>
    </>
  );
}

function Preview({ lines, more }: { lines: StatementRow[]; more: number }) {
  const { t } = useI18n();
  return (
    <div className="wrap" style={{ marginBottom: 10 }}>
      <table className="stack">
        <thead><tr><th>{t('doc.date')}</th><th>{t('doc.description')}</th><th className="num">{t('doc.amount')}</th><th className="num">{t('led.balance')}</th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}><td className="ltr">{l.date}</td><td>{l.description}</td><td className="num" data-label={t('doc.amount')}><Amount v={l.amount} /></td>
              <td className="num ltr" data-label={t('led.balance')}>{l.balance ? fmt(l.balance) : ''}</td></tr>
          ))}
          {more > 0 && <tr><td colSpan={4} className="mut small">{t('bank.andMore', { n: more })}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** When the file's columns are not recognised: say once which column is which; it is remembered for this bank account. */
function ColumnPicker({ rows, onPick }: { rows: string[][]; onPick: (l: Layout) => void }) {
  const { t } = useI18n();
  const [headerRow, setHeaderRow] = useState(0);
  const [l, setL] = useState<{ date: number; description: number; amount: number; debit: number; credit: number; balance: number; dateOrder: Layout['dateOrder']; mode: 'one' | 'two' }>(
    { date: -1, description: -1, amount: -1, debit: -1, credit: -1, balance: -1, dateOrder: 'dmy', mode: 'one' });
  const head = rows[headerRow] ?? [];
  const cols = head.map((h, i) => ({ i, label: h || `${t('bank.column')} ${i + 1}` }));
  const pick = (k: keyof typeof l, label: Key) => (
    <label className="f">{t(label)}
      <select value={String(l[k])} onChange={(e) => setL({ ...l, [k]: Number(e.target.value) })}>
        <option value="-1">—</option>
        {cols.map((c) => <option key={c.i} value={c.i}>{c.label}</option>)}
      </select>
    </label>
  );
  const layout: Layout | null = l.date >= 0 && l.description >= 0 && (l.mode === 'one' ? l.amount >= 0 : l.debit >= 0 && l.credit >= 0)
    ? { headerRow, date: l.date, description: l.description, dateOrder: l.dateOrder, balance: l.balance >= 0 ? l.balance : undefined,
      ...(l.mode === 'one' ? { amount: l.amount } : { debit: l.debit, credit: l.credit }) } : null;
  const n = layout ? readStatement(rows, layout).lines.length : 0;
  return (
    <div className="notice warn">
      <p style={{ marginTop: 0 }}>{t('bank.pickColumns')}</p>
      <label className="f">{t('bank.headerRow')}
        <select value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))}>
          {rows.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 4).join(' | ')}</option>)}
        </select>
      </label>
      <div className="row">{pick('date', 'doc.date')}{pick('description', 'doc.description')}{pick('balance', 'led.balance')}</div>
      <div className="chips" style={{ margin: '6px 0' }}>
        <button type="button" className={`b small ${l.mode === 'one' ? 'p' : ''}`} onClick={() => setL({ ...l, mode: 'one' })}>{t('bank.oneAmount')}</button>
        <button type="button" className={`b small ${l.mode === 'two' ? 'p' : ''}`} onClick={() => setL({ ...l, mode: 'two' })}>{t('bank.twoAmounts')}</button>
      </div>
      <div className="row">{l.mode === 'one' ? pick('amount', 'doc.amount') : <>{pick('debit', 'bank.moneyOut')}{pick('credit', 'bank.moneyIn')}</>}
        <label className="f">{t('bank.dateOrder')}
          <select value={l.dateOrder} onChange={(e) => setL({ ...l, dateOrder: e.target.value as Layout['dateOrder'] })}>
            <option value="dmy">31/12/2026</option><option value="mdy">12/31/2026</option><option value="ymd">2026-12-31</option>
          </select>
        </label>
      </div>
      <button className="b p" disabled={!layout || n === 0} onClick={() => layout && onPick(layout)}>{layout ? t('bank.useColumns', { n }) : t('bank.pickAll')}</button>
    </div>
  );
}

// ------------------------------------------------------------------ reconciliation
export function Reconcile({ books, bankId }: { books: CompanyBooks; bankId?: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const accounts = useAccounts(books);
  const id = bankId ?? accounts.data?.find((a) => a.kind === 'bank' && a.status === 'active')?.id ?? accounts.data?.[0]?.id;
  const r = useApi<Recon>(id ? `/api/bank-accounts/${id}/reconciliation` : null);
  if (accounts.error) return <ErrorNote error={accounts.error} onRetry={accounts.reload} />;
  if (!accounts.data) return <Loading />;
  const sum = (xs: { amount: string }[]) => xs.reduce((s, x) => s + toMinor(x.amount), 0n);
  const money = (v: bigint) => fmt(fromMinor(v));
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <label className="f" style={{ flex: '1 1 260px' }}>{t('bank.account')}
          <select id="rc-account" value={id ?? ''} onChange={(e) => go('Bank', 'reconcile', e.target.value)}>
            {accounts.data.map((a) => <option key={a.id} value={a.id}>{local(a.name, a.nameAr)}</option>)}
          </select>
        </label>
      </div>
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {id && !r.data ? <Loading /> : r.data && (
        !r.data.statementDate ? <div className="card mut">{t('bank.importFirst')}</div> : (
          <>
            <div className="card">
              <h2>{t('bank.reconTitle', { date: r.data.statementDate })}</h2>
              <table className="totals"><tbody>
                <tr><td>{t('bank.booksBalanceOn', { date: r.data.statementDate })}</td><td className="num ltr">{fmt(r.data.booksBalance)}</td></tr>
                <tr><td>{t('bank.lessInBooks', { n: r.data.inBooksOnly.length })}</td><td className="num ltr">{money(-sum(r.data.inBooksOnly))}</td></tr>
                <tr><td>{t('bank.addOnStatement', { n: r.data.onStatementOnly.length })}</td><td className="num ltr">{money(sum(r.data.onStatementOnly))}</td></tr>
                <tr className="total"><td>{t('bank.adjusted')}</td><td className="num ltr">{fmt(r.data.adjustedBooks ?? '')}</td></tr>
                <tr><td>{t('bank.statementBalance')}</td><td className="num ltr">{r.data.statementBalance ? fmt(r.data.statementBalance) : '—'}</td></tr>
                <tr className="total"><td>{t('bank.difference')}</td><td className={`num ltr ${r.data.difference && toMinor(r.data.difference) !== 0n ? 'bad' : 'good'}`}>{r.data.difference ? fmt(r.data.difference) : '—'}</td></tr>
              </tbody></table>
              {r.data.difference === null ? <p className="small mut">{t('bank.noBalanceColumn')}</p>
                : toMinor(r.data.difference) === 0n ? <div className="notice">{r.data.onStatementOnly.length ? t('bank.reconciledOpen') : t('bank.reconciled')}</div>
                : <div className="notice warn">{t('bank.notReconciled')}</div>}
            </div>
            <div className="grid two">
              <div className="card">
                <h3>{t('bank.onStatementOnly')}</h3>
                {r.data.onStatementOnly.length === 0 ? <p className="mut small">{t('none')}</p> : (
                  <table className="mini"><tbody>{r.data.onStatementOnly.map((x) => <tr key={x.id}><td className="ltr small">{x.date}</td><td className="small">{x.description}</td><td className="num"><Amount v={x.amount} /></td></tr>)}</tbody></table>
                )}
                {r.data.onStatementOnly.length > 0 && <button className="b small" onClick={() => go('Bank', 'accounts', id)}>{t('bank.reviewNow')}</button>}
              </div>
              <div className="card">
                <h3>{t('bank.inBooksOnly')}</h3>
                <p className="small mut">{t('bank.inBooksHint')}</p>
                {r.data.inBooksOnly.length === 0 ? <p className="mut small">{t('none')}</p> : (
                  <table className="mini"><tbody>{r.data.inBooksOnly.map((x) => <tr key={x.journalLineId}><td className="ltr small">{x.date}</td><td className="small">{x.memo}</td><td className="num"><Amount v={x.amount} /></td></tr>)}</tbody></table>
                )}
              </div>
            </div>
          </>
        )
      )}
    </>
  );
}

// ------------------------------------------------------------------ rules
interface Rule { id: string; matchText: string; direction: 'in' | 'out'; accountId: string; costCentreId: string | null; vatCode: string; label: string | null; active: boolean;
  accountCode: string; accountName: string; accountNameAr: string | null; costCentre: string | null; costCentreAr: string | null }

export function Rules({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const list = useApi<Rule[]>(`/api/companies/${books.company.id}/bank-rules`);
  const blank = { matchText: '', direction: 'out' as 'in' | 'out', accountId: '', vatCode: 'standard', costCentreId: '', label: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string>();
  const call = async (path: string, body: unknown) => {
    setErr(undefined);
    try { await api(path, { body }); list.reload(); return true; } catch (e) { setErr(errorText(t, has, e)); return false; }
  };
  const acct = books.accounts.find((a) => a.id === f.accountId);
  const vatApplies = f.direction === 'out' && acct?.type === 'expense';
  return (
    <>
      <p className="mut small">{t('bank.rulesHint')}</p>
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <p className="mut">{t('bank.noRules')}</p> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('bank.whenText')}</th><th>{t('bank.direction')}</th><th>{t('journal.account')}</th><th>{t('doc.vat')}</th><th /></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'mut'}>
                <td>“{r.matchText}”{r.label && <div className="small mut">{r.label}</div>}</td>
                <td data-label={t('bank.direction')}>{t(r.direction === 'in' ? 'bank.moneyIn' : 'bank.moneyOut')}</td>
                <td data-label={t('journal.account')}>{r.accountCode} {local(r.accountName, r.accountNameAr)}{r.costCentre && <span className="small mut"> · {local(r.costCentre, r.costCentreAr)}</span>}</td>
                <td data-label={t('doc.vat')}>{t(`vat.${r.vatCode}` as Key, { rate: Number(books.company.vatRate) })}</td>
                <td>{books.canPost && <span className="actions">
                  <button className="link small" onClick={() => call(`/api/bank-rules/${r.id}`, { ...r, active: !r.active })}>{r.active ? t('bank.pause') : t('bank.resume')}</button>
                  <button className="link small bad" onClick={() => call(`/api/bank-rules/${r.id}/delete`, {})}>{t('bank.deleteRule')}</button>
                </span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {books.canPost && (
        <div className="card">
          <h3>{t('bank.newRule')}</h3>
          <div className="row">
            <label className="f">{t('bank.whenText')}<input id="rl-text" dir="auto" value={f.matchText} onChange={(e) => setF({ ...f, matchText: e.target.value })} placeholder="STC, PETROMIN, SALARY…" /></label>
            <label className="f">{t('bank.direction')}
              <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'in' | 'out' })}>
                <option value="out">{t('bank.moneyOut')}</option><option value="in">{t('bank.moneyIn')}</option>
              </select>
            </label>
            <label className="f">{t('journal.account')}
              <select id="rl-account" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                <option value="">{t('bank.chooseAccount')}</option>
                {books.accounts.filter((a) => !a.isBank && a.code !== '1300').map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            {vatApplies && (
              <label className="f">{t('doc.vat')}
                <select value={f.vatCode} onChange={(e) => setF({ ...f, vatCode: e.target.value })}>
                  {['standard', 'zero', 'exempt', 'out_of_scope'].map((v) => <option key={v} value={v}>{t(`vat.${v}` as Key, { rate: Number(books.company.vatRate) })}</option>)}
                </select>
              </label>
            )}
            <label className="f">{t('journal.costCentre')}
              <select value={f.costCentreId} onChange={(e) => setF({ ...f, costCentreId: e.target.value })}>
                <option value="">—</option>
                {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
              </select>
            </label>
            <label className="f">{t('bank.ruleLabel')}<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          </div>
          <button className="b p" disabled={f.matchText.trim().length < 3 || !f.accountId}
            onClick={async () => { if (await call(`/api/companies/${books.company.id}/bank-rules`, { ...f, vatCode: vatApplies ? f.vatCode : 'out_of_scope', costCentreId: f.costCentreId || null })) setF(blank); }}>
            {t('bank.saveRule')}
          </button>
        </div>
      )}
    </>
  );
}
