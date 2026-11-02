// Journal: post a manual entry (errors prevented before posting), list and reverse entries, lock periods.
import { useMemo, useState } from 'react';
import { api, useApi, type CompanyBooks, type Entry } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt, isAmount, normalise, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { isLocked, lockedUpTo } from './Workspace.tsx';

interface Line { accountId: string; costCentreId: string; debit: string; credit: string }
const blank = (): Line => ({ accountId: '', costCentreId: '', debit: '', credit: '' });

export function Journal({ books, sub, reloadBooks, go }: { books: CompanyBooks; sub: string; reloadBooks: () => void; go: (sub: string) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const entries = useApi<Entry[]>(sub === 'entries' ? `/api/companies/${books.company.id}/entries?q=${encodeURIComponent(query)}` : null);
  if (sub === 'new') {
    return books.canPost ? <NewEntry books={books} onPosted={() => undefined} onShowEntries={() => go('entries')} /> : <div className="notice warn">{t('viewOnly')}</div>;
  }
  if (sub === 'periods') return <Periods books={books} onChanged={reloadBooks} />;
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{t('journal.entries')}</h2>
        <span className="spacer" />
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }} className="actions">
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQuery(''); }} placeholder={t('journal.searchPlaceholder')} aria-label={t('search')} style={{ minWidth: 220 }} />
          <button className="b" type="submit">{t('search')}</button>
        </form>
        {books.canPost && <button className="b p" onClick={() => go('new')}>{t('journal.new')}</button>}
      </div>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('journal.neverEdited')}</div>
      {entries.error && <ErrorNote error={entries.error} onRetry={entries.reload} />}
      {!entries.data ? <Loading /> : entries.data.length === 0 ? <div className="mut">{t('none')}</div> :
        entries.data.map((e) => <EntryCard key={e.id} entry={e} books={books} onReversed={entries.reload} />)}
    </div>
  );
}

function NewEntry({ books, onPosted, onShowEntries }: { books: CompanyBooks; onPosted: () => void; onShowEntries: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<unknown>();
  const [done, setDone] = useState(false);

  const set = (i: number, patch: Partial<Line>) => {
    setDone(false);
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  // Everything the database would reject is caught here first, in plain language.
  const check = useMemo(() => {
    const problems: string[] = [];
    let dr = 0n, cr = 0n, used = 0;
    let badFormat = false, bothSides = false;
    for (const l of lines) {
      const hasD = l.debit.trim() !== '', hasC = l.credit.trim() !== '';
      if ((hasD && !isAmount(l.debit)) || (hasC && !isAmount(l.credit))) { badFormat = true; continue; }
      const d = hasD ? toMinor(normalise(l.debit)) : 0n, c = hasC ? toMinor(normalise(l.credit)) : 0n;
      if (d && c) bothSides = true;
      if (l.accountId && (d || c)) used++;
      dr += d; cr += c;
      const acct = books.accounts.find((a) => a.id === l.accountId);
      if (acct?.costCentreRequired && !l.costCentreId && (d || c)) problems.push(t('journal.needCostCentre', { account: `${acct.code} ${local(acct.name, acct.nameAr)}` }));
    }
    if (badFormat) problems.push(t('journal.amountFormat'));
    if (bothSides) problems.push(t('journal.oneSide'));
    if (used < 2) problems.push(t('journal.needTwoLines'));
    if (dr !== cr) problems.push(t('journal.notBalanced', { diff: fmt(fromMinor(dr - cr)) }));
    if (lines.some((l) => !l.accountId && (l.debit || l.credit))) problems.push(t('journal.chooseAccount'));
    if (date && isLocked(books, date)) problems.push(t('journal.dateLocked', { date: lockedUpTo(books) ?? '' }));
    return { problems, dr, cr };
  }, [lines, date, books, t, local]);

  const post = async () => {
    setBusy(true); setServerError(undefined);
    try {
      await api(`/api/companies/${books.company.id}/entries`, {
        body: {
          entryDate: date, memo,
          lines: lines.filter((l) => l.accountId && (l.debit || l.credit)).map((l) => ({
            accountId: l.accountId, costCentreId: l.costCentreId || null,
            debit: l.debit ? normalise(l.debit) : undefined, credit: l.credit ? normalise(l.credit) : undefined,
          })),
        },
      });
      setLines([blank(), blank()]); setMemo(''); setDone(true);
      onPosted();
    } catch (e) {
      setServerError(e);
    } finally {
      setBusy(false);
    }
  };

  const touched = lines.some((l) => l.accountId || l.debit || l.credit);
  return (
    <div className="card">
      <h2>{t('journal.new')}</h2>
      <div className="row">
        <label className="f" style={{ flex: '0 1 180px' }}>{t('date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="f">{t('journal.memo')}<input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t('journal.memoPlaceholder')} maxLength={500} /></label>
      </div>
      <div className="wrap">
        <table className="lines">
          <thead><tr><th>{t('journal.account')}</th><th>{t('journal.costCentre')}</th><th className="num">{t('debit')}</th><th className="num">{t('credit')}</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const acct = books.accounts.find((a) => a.id === l.accountId);
              return (
                <tr key={i}>
                  <td style={{ minWidth: 200 }}>
                    <select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={t('journal.account')}>
                      <option value="">{t('journal.chooseAccount')}</option>
                      {books.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {local(a.name, a.nameAr)}{a.costCentreRequired ? ' *' : ''}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 150 }}>
                    <select value={l.costCentreId} onChange={(e) => set(i, { costCentreId: e.target.value })} aria-label={t('journal.costCentre')}
                      style={acct?.costCentreRequired && !l.costCentreId ? { borderColor: 'var(--bad)' } : undefined}>
                      <option value="">{t('journal.noCostCentre')}</option>
                      {books.costCentres.map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}
                    </select>
                  </td>
                  <td><input inputMode="decimal" className="num ltr" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label={t('debit')} placeholder={t('debit')} /></td>
                  <td><input inputMode="decimal" className="num ltr" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label={t('credit')} placeholder={t('credit')} /></td>
                  <td className="num">
                    <button className="b" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={t('journal.removeLine')} title={t('journal.removeLine')}>×</button>
                  </td>
                </tr>
              );
            })}
            <tr className="total">
              <td><button className="b" onClick={() => setLines((ls) => [...ls, blank()])}>{t('journal.addLine')}</button></td>
              <td className="num">{t('total')}</td>
              <td className="num ltr">{fmt(fromMinor(check.dr))}</td>
              <td className="num ltr">{fmt(fromMinor(check.cr))}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {touched && check.problems.length > 0 && (
        <ul className="bad small" style={{ margin: '8px 0', paddingInlineStart: 18 }}>
          {check.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {serverError !== undefined && <div className="notice bad" role="alert">{errorText(t, has, serverError)}</div>}
      {done && <div className="notice actions"><span>{t('journal.posted')}</span><button className="link" onClick={onShowEntries}>{t('journal.showEntries')}</button></div>}
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="b p" disabled={busy || check.problems.length > 0} onClick={() => void post()}>{t('journal.post')}</button>
        {check.problems.length === 0 && <span className="badge good">{t('journal.balanced')}</span>}
      </div>
    </div>
  );
}

function EntryCard({ entry, books, onReversed }: { entry: Entry; books: CompanyBooks; onReversed: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const todayLocked = isLocked(books, today());
  const reverse = async () => {
    setConfirming(false);
    setBusy(true); setError(undefined);
    try {
      await api(`/api/entries/${entry.id}/reverse`, { body: { date: today() } });
      onReversed();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ background: 'transparent' }}>
      <div className="entry-head">
        <b>{entry.memo || '—'}</b>
        <span className="mut small">{entry.date}{entry.createdBy ? ` · ${t('journal.by', { name: entry.createdBy })}` : ''}</span>
        {entry.reversedById && <span className="badge warn">{t('journal.reversed')}</span>}
        {entry.reversesEntryId && <span className="badge">{t('journal.reversalOf')}</span>}
        <span className="spacer" />
        {books.canPost && !entry.reversedById && !entry.reversesEntryId && !confirming && (
          <button className="b" disabled={busy || todayLocked} title={todayLocked ? t('journal.reverseLocked') : undefined} onClick={() => setConfirming(true)}>{t('journal.reverse')}</button>
        )}
      </div>
      {confirming && (
        <div className="notice warn actions" role="group">
          <span>{t('journal.reverseConfirm')}</span>
          <span className="spacer" />
          <button className="b p" disabled={busy} onClick={() => void reverse()}>{t('journal.reverseYes')}</button>
          <button className="b" onClick={() => setConfirming(false)}>{t('cancel')}</button>
        </div>
      )}
      <div className="wrap">
        <table>
          <tbody>
            {entry.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.accountCode} {local(l.accountName, l.accountNameAr)}{l.costCentre && <span className="mut small"> · {local(l.costCentre, l.costCentreAr)}</span>}</td>
                <td className="num ltr" style={{ width: '18%' }}>{toMinor(l.debit) ? fmt(l.debit) : ''}</td>
                <td className="num ltr" style={{ width: '18%' }}>{toMinor(l.credit) ? fmt(l.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error !== undefined && <div className="notice bad" role="alert" style={{ marginTop: 8 }}>{errorText(t, has, error)}</div>}
    </div>
  );
}

function Periods({ books, onChanged }: { books: CompanyBooks; onChanged: () => void }) {
  const { t, lang, has } = useI18n();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const toggle = async (start: string, locked: boolean) => {
    setBusy(true); setError(undefined);
    try {
      await api(`/api/companies/${books.company.id}/periods/${start}/lock`, { body: { locked } });
      onChanged();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <div className="card">
      <h2>{t('journal.periods')}</h2>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('journal.periodsHint')}</div>
      {error !== undefined && <div className="notice bad" role="alert">{errorText(t, has, error)}</div>}
      {books.periods.length === 0 ? <div className="mut">{t('journal.noPeriods')}</div> : (
        <div className="wrap">
          <table>
            <thead><tr><th>{t('journal.period')}</th><th>{t('journal.status')}</th><th /></tr></thead>
            <tbody>
              {books.periods.map((p) => (
                <tr key={p.startDate}>
                  <td>{monthName(p.startDate)} <span className="mut small ltr">({p.startDate} – {p.endDate})</span></td>
                  <td>{p.lockedAt ? <span className="badge warn">{t('journal.locked')}</span> : <span className="badge good">{t('journal.open')}</span>}</td>
                  <td className="num">
                    {books.canLock && (
                      <button className="b" disabled={busy} onClick={() => void toggle(p.startDate, !p.lockedAt)}>
                        {p.lockedAt ? t('journal.unlock') : t('journal.lock')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
