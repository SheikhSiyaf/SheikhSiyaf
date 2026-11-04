// HRM: overview, attendance sheet, leave, payroll (with payslips and the salary file), loans and advances,
// end of service, and HR documents. Amounts are worked out on the server (src/books/payroll.ts).
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { bankAccounts, useGo } from '../sales/common.tsx';
import { download, printPdf } from '../print/Print.tsx';
import { PayslipPdf, type PayslipLine, type Seller } from '../print/Pdf.tsx';
import { AttachmentsCard } from '../print/Attachments.tsx';
import { ClockImport, ClockMonth, CorrectionForm } from './AttendanceClock.tsx';

// ------------------------------------------------------------------ shared
export interface HrEmp {
  id: string; name: string; nameAr: string | null; employeeNo: string | null; jobTitle: string | null; status: string; costCentreId: string | null; hasProfile: boolean;
  nationality: string | null; national: boolean; idNumber: string | null; passportNo: string | null; dateOfBirth: string | null; joinDate: string | null; contractType: string | null;
  contractEnd: string | null; basic: string; housing: string; transport: string; otherAllowance: string; wage: string; iban: string | null; bankRouting: string | null;
  wpsPersonId: string | null; insuranceNo: string | null; insuranceRegistered: string | null; annualLeaveDays: number | null; openingLeaveDays: string; openingAsOf: string | null;
  openingEos: string; leavingDate: string | null; leavingReason: string | null; settled: boolean; country: 'SA' | 'AE' | 'OM';
}
const monthEndOf = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const sumOf = (vs: string[]) => fromMinor(vs.reduce((s, v) => s + toMinor(v || '0'), 0n));
const days = (n: number | string) => String(n).replace(/\.00$/, '');

function useMonthName() {
  const { lang } = useI18n();
  return (periodEnd: string) => new Date(`${periodEnd.slice(0, 7)}-01T00:00:00Z`).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string; details?: string[] }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); return true; }
    catch (e) { setMsg({ bad: errorText(t, has, e), details: (e as { details?: string[] }).details }); return false; }
    finally { setBusy(false); }
  };
  const notes = <>
    {msg.ok && <div className="notice">{msg.ok}</div>}
    {msg.bad && <div className="notice bad" role="alert">{msg.bad}{msg.details?.length ? <> {msg.details.filter((x) => x !== '—').join(', ')}</> : null}</div>}
  </>;
  return { run, busy, notes, setMsg };
}
const Tile = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) => (
  <div className={`card fig ${tone ?? ''}`}><small>{label}</small><b>{value}</b>{sub && <small>{sub}</small>}</div>
);

// ------------------------------------------------------------------ overview
interface Overview { headcount: number; withoutDetails: number; nationals: number; monthlyWages: string; pendingLeave: number; onLeave: number;
  lastRun: { id: string; periodEnd: string; status: string; totalNet: string } | null; expiring: HrDoc[] }

export function HrOverview({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const o = useApi<Overview>(`/api/companies/${books.company.id}/hr/overview`);
  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const withDetails = d.headcount - d.withoutDetails;
  const share = withDetails ? Math.round((d.nationals * 100) / withDetails) : 0;
  return (
    <>
      {d.withoutDetails > 0 && <div className="notice warn">{t('hr.missingDetails', { n: d.withoutDetails })} <button className="link" onClick={() => go('HRM', 'employees')}>{t('sub.employees')}</button></div>}
      <div className="grid">
        <Tile label={t('hr.headcount')} value={d.headcount} sub={t('hr.nationalsShare', { pct: share, country: t(`hr.nationals.${books.company.country}` as Key) })} />
        <Tile label={t('hr.monthlyWages')} value={<span className="ltr">{fmt(d.monthlyWages)}</span>} sub={books.company.currency} />
        <Tile label={t('hr.onLeaveToday')} value={d.onLeave} sub={d.pendingLeave ? <button className="link" onClick={() => go('HRM', 'leave')}>{t('hr.pendingLeave', { n: d.pendingLeave })}</button> : t('hr.noPending')} />
        <Tile label={t('hr.lastPayroll')} value={d.lastRun ? monthName(d.lastRun.periodEnd) : '—'}
          sub={d.lastRun ? <button className="link" onClick={() => go('HRM', 'payroll', d.lastRun!.id)}>{t(`hr.run.${d.lastRun.status}` as Key)} · {fmt(d.lastRun.totalNet)}</button> : t('hr.noPayroll')} />
      </div>
      <div className="card">
        <div className="actions" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>{t('hr.expiringTitle')}</h2><span className="spacer" />
          <button className="b small" onClick={() => go('HRM', 'hr-documents')}>{t('hr.allDocuments')}</button></div>
        {d.expiring.length === 0 ? <div className="mut">{t('hr.noneExpiring')}</div> : (
          <table className="stack"><tbody>{d.expiring.map((x) => (
            <tr key={x.id}><td>{local(x.name, x.nameAr)}</td><td>{t(`hr.doc.${x.kind}` as Key)} <span className="ltr mut small">{x.number}</span></td>
              <td className="ltr">{x.expiryDate}</td><td><ExpiryBadge daysLeft={x.daysLeft} /></td></tr>
          ))}</tbody></table>
        )}
      </div>
      <div className="actions">
        {books.canPost && <button className="b p" onClick={() => go('HRM', 'payroll')}>{t('hr.runPayroll')}</button>}
        <button className="b" onClick={() => go('HRM', 'attendance')}>{t('sub.attendance')}</button>
        <button className="b" onClick={() => go('HRM', 'leave')}>{t('sub.leave')}</button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ attendance
interface AttRow { contactId: string; fromClock?: boolean; name: string; nameAr: string | null; employeeNo: string | null; absentDays: number; overtimeHours: string; notes: string;
  annualLeave: number; sickLeave: number; unpaidLeave: number; otherLeave: number }

export function Attendance({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const [month, setMonth] = useState(lastMonth());
  const pe = monthEndOf(month);
  const a = useApi<{ posted: boolean; rows: AttRow[] }>(`/api/companies/${books.company.id}/hr/attendance?month=${pe}`);
  const [edit, setEdit] = useState<Record<string, { absentDays: string; overtimeHours: string; notes: string }>>({});
  const [view, setView] = useState<'sheet' | 'days'>('sheet');
  const [importing, setImporting] = useState(false);
  const [ver, setVer] = useState(0);
  const staff = useApi<HrEmp[]>(`/api/companies/${books.company.id}/hr/employees`);
  const { run, busy, notes } = useRun();
  const file = useRef<HTMLInputElement>(null);
  const val = (r: AttRow) => edit[r.contactId] ?? { absentDays: String(r.absentDays), overtimeHours: r.overtimeHours, notes: r.notes };
  const set = (r: AttRow, k: 'absentDays' | 'overtimeHours' | 'notes', v: string) => setEdit({ ...edit, [r.contactId]: { ...val(r), [k]: v } });
  const canEdit = books.canPost && !a.data?.posted;
  const save = () => void run(async () => {
    await api(`/api/companies/${books.company.id}/hr/attendance`, { body: { month: pe, rows: (a.data?.rows ?? []).map((r) => ({ contactId: r.contactId, ...val(r) })) } });
    setEdit({}); a.reload();
  }, t('hr.attSaved'));
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    const csv = await f.text();
    await run(async () => { await api(`/api/companies/${books.company.id}/hr/attendance`, { body: { month: pe, csv } }); setEdit({}); a.reload(); }, t('hr.attImported'));
    if (file.current) file.current.value = '';
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <label className="f">{t('hr.month')}<input id="att-month" type="month" value={month} max={today().slice(0, 7)} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setEdit({}); } }} /></label>
        <span className="spacer" />
        <div className="seg">
          <button id="att-view-sheet" className={view === 'sheet' ? 'on' : ''} onClick={() => setView('sheet')}>{t('att.viewSheet')}</button>
          <button id="att-view-days" className={view === 'days' ? 'on' : ''} onClick={() => setView('days')}>{t('att.viewDays')}</button>
        </div>
        {canEdit && <button className={`b ${importing ? '' : 'p'}`} id="att-clock" onClick={() => setImporting(!importing)}>{importing ? t('att.closeImport') : t('att.importClock')}</button>}
      </div>
      {importing && canEdit && <ClockImport books={books} periodEnd={pe} onDone={() => { a.reload(); setVer((v) => v + 1); setView('days'); }} />}
      {view === 'days' ? <ClockMonth key={`${pe}-${ver}`} books={books} periodEnd={pe} people={(staff.data ?? []).map((e) => ({ id: e.id, name: e.name, nameAr: e.nameAr, employeeNo: e.employeeNo }))} reloadSheet={a.reload} /> : <>
      <div className="mut small" style={{ marginBottom: 8 }}>{a.data?.posted ? t('hr.attPosted') : t('hr.attHint')}</div>
      {notes}
      <div className="card">
        {canEdit && <div className="actions" style={{ marginBottom: 8, justifyContent: 'flex-end' }}>
          <input ref={file} id="att-file" type="file" accept=".csv,.txt" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
          <button className="b" disabled={busy} onClick={() => file.current?.click()}>{t('hr.attImport')}</button>
          <button className="b p" id="att-save" disabled={busy || !Object.keys(edit).length} onClick={save}>{t('hr.attSave')}</button>
        </div>}
        {a.error && <ErrorNote error={a.error} onRetry={a.reload} />}
        {!a.data ? <Loading /> : a.data.rows.length === 0 ? <div className="mut">{t('hr.nobodyThisMonth')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('col.name')}</th><th className="num">{t('hr.leaveTaken')}</th><th className="num">{t('hr.absentDays')}</th><th className="num">{t('hr.overtimeHours')}</th><th>{t('hr.notes')}</th></tr></thead>
            <tbody>{a.data.rows.map((r) => {
              const v = val(r);
              const leave = [r.annualLeave && `${t('hr.kind.annual')} ${r.annualLeave}`, r.sickLeave && `${t('hr.kind.sick')} ${r.sickLeave}`, r.unpaidLeave && `${t('hr.kind.unpaid')} ${r.unpaidLeave}`,
                r.otherLeave && `${t('hr.kind.other_paid')} ${r.otherLeave}`].filter(Boolean).join(' · ');
              return (
                <tr key={r.contactId}>
                  <td>{local(r.name, r.nameAr)} <span className="mut small ltr">{r.employeeNo}</span>{r.fromClock && <div><span className="badge" title={t('att.fromClockHint')}>{t('att.fromClock')}</span></div>}</td>
                  <td className="num small" data-label={t('hr.leaveTaken')}>{leave || '—'}</td>
                  <td className="num" data-label={t('hr.absentDays')}><input aria-label={`${r.name} ${t('hr.absentDays')}`} inputMode="numeric" className="num ltr" style={{ width: 70 }} disabled={!canEdit || r.fromClock}
                    value={v.absentDays} onChange={(e) => set(r, 'absentDays', e.target.value.replace(/\D/g, ''))} /></td>
                  <td className="num" data-label={t('hr.overtimeHours')}><input aria-label={`${r.name} ${t('hr.overtimeHours')}`} inputMode="decimal" className="num ltr" style={{ width: 80 }} disabled={!canEdit || r.fromClock}
                    value={v.overtimeHours} onChange={(e) => set(r, 'overtimeHours', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                  <td data-label={t('hr.notes')}><input aria-label={`${r.name} ${t('hr.notes')}`} disabled={!canEdit} value={v.notes} onChange={(e) => set(r, 'notes', e.target.value)} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      <p className="mut small">{t('hr.attFileHint')}</p>
      </>}
    </>
  );
}

// ------------------------------------------------------------------ leave
interface LeaveRow { id: string; contactId: string; name: string; nameAr: string | null; kind: string; startDate: string; endDate: string; days: number; reason: string | null; status: string; createdBy: string | null; decidedBy: string | null }
interface Balance { contactId: string; name: string; nameAr: string | null; employeeNo: string | null; perYear: number; earned: number; opening: number; taken: number; balance: number }
const KINDS = ['annual', 'sick', 'unpaid', 'other_paid'] as const;

export function Leave({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'requests' | 'balances'>('requests');
  const list = useApi<LeaveRow[]>(`/api/companies/${books.company.id}/hr/leave?status=${status}`);
  const bal = useApi<Balance[]>(tab === 'balances' ? `/api/companies/${books.company.id}/hr/leave-balances` : null);
  const staff = useApi<HrEmp[]>(`/api/companies/${books.company.id}/hr/employees`);
  const [form, setForm] = useState<{ contactId: string; kind: string; startDate: string; endDate: string; reason: string; approve: boolean }>();
  const { run, busy, notes, setMsg } = useRun();
  const [giveBack, setGiveBack] = useState<LeaveRow>();
  const canApprove = books.canPost && (!books.access || books.access.canApprove);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api(`/api/companies/${books.company.id}/hr/leave`, { body: form }); setForm(undefined); list.reload(); }, t('hr.leaveSaved'));
  };
  const decide = (id: string, s: string) => void run(async () => { await api(`/api/leave/${id}/status`, { body: { status: s } }); list.reload(); });
  const people = (staff.data ?? []).filter((e) => e.hasProfile && !e.settled);
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="seg">
          <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>{t('hr.leaveRequests')}</button>
          <button className={tab === 'balances' ? 'on' : ''} onClick={() => setTab('balances')}>{t('hr.leaveBalances')}</button>
        </div>
        <span className="spacer" />
        {books.canPost && !form && <button className="b p" id="leave-new" onClick={() => setForm({ contactId: people[0]?.id ?? '', kind: 'annual', startDate: today(), endDate: today(), reason: '', approve: canApprove })}>{t('hr.leaveNew')}</button>}
      </div>
      {notes}
      {giveBack && <CorrectionForm books={books} day={{ day: giveBack.startDate, status: 'leave', leaveId: giveBack.id }} range={[giveBack.startDate, giveBack.endDate]}
        person={{ id: giveBack.contactId, name: giveBack.name, nameAr: giveBack.nameAr, employeeNo: null }}
        onDone={(m) => { setGiveBack(undefined); setMsg({ ok: m }); list.reload(); }} onCancel={() => setGiveBack(undefined)} />}
      {form && (
        <form className="card inset" onSubmit={save}>
          <h2>{t('hr.leaveNew')}</h2>
          <div className="row">
            <label className="f">{t('hr.employee')}<select id="lv-emp" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
              {people.map((p) => <option key={p.id} value={p.id}>{local(p.name, p.nameAr)}</option>)}</select></label>
            <label className="f">{t('hr.leaveKind')}<select id="lv-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`hr.kind.${k}`)}</option>)}</select></label>
          </div>
          <div className="row">
            <label className="f">{t('hr.firstDay')}<input id="lv-from" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate < e.target.value ? e.target.value : form.endDate })} /></label>
            <label className="f">{t('hr.lastDay')}<input id="lv-to" type="date" value={form.endDate} min={form.startDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
            <label className="f">{t('hr.reason')}<input id="lv-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          </div>
          <div className="small mut" style={{ marginBottom: 8 }}>{t(`hr.kindHint.${form.kind}` as Key)}</div>
          {canApprove && <label className="check-one" style={{ marginBottom: 10 }}><input type="checkbox" checked={form.approve} onChange={(e) => setForm({ ...form, approve: e.target.checked })} />{t('hr.approveNow')}</label>}
          <div className="actions"><button className="b p" id="lv-save" disabled={busy || !form.contactId}>{t('hr.leaveSave')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      {tab === 'requests' ? (
        <div className="card">
          <div className="actions" style={{ marginBottom: 6 }}>
            <select aria-label={t('hr.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('hr.allStatuses')}</option>{['requested', 'approved', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{t(`hr.leave.${s}` as Key)}</option>)}
            </select>
          </div>
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('hr.noLeave')}</div> : (
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('hr.employee')}</th><th>{t('hr.leaveKind')}</th><th>{t('hr.dates')}</th><th className="num">{t('hr.days')}</th><th>{t('hr.status')}</th><th /></tr></thead>
              <tbody>{list.data.map((l) => (
                <tr key={l.id} className={l.status === 'cancelled' || l.status === 'rejected' ? 'mut' : ''}>
                  <td>{local(l.name, l.nameAr)}{l.reason && <div className="small mut">{l.reason}</div>}</td>
                  <td data-label={t('hr.leaveKind')}>{t(`hr.kind.${l.kind}` as Key)}</td>
                  <td className="ltr small" data-label={t('hr.dates')}>{l.startDate} → {l.endDate}</td>
                  <td className="num" data-label={t('hr.days')}>{l.days}</td>
                  <td data-label={t('hr.status')}><span className={`badge ${l.status === 'approved' ? 'good' : l.status === 'requested' ? 'warn' : ''}`}>{t(`hr.leave.${l.status}` as Key)}</span>
                    {l.decidedBy && <div className="small mut">{l.decidedBy}</div>}</td>
                  <td className="num"><span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    {l.status === 'requested' && canApprove && <><button className="b small p" disabled={busy} onClick={() => decide(l.id, 'approved')}>{t('appr.approve')}</button>
                      <button className="b small" disabled={busy} onClick={() => decide(l.id, 'rejected')}>{t('appr.reject')}</button></>}
                    {l.status === 'requested' && books.canPost && <button className="b small" disabled={busy} onClick={() => decide(l.id, 'cancelled')}>{t('hr.cancelLeave')}</button>}
                    {l.status === 'approved' && books.canPost && <button className="b small" disabled={busy} title={t('att.giveBackHint')} onClick={() => { setMsg({}); setGiveBack(l); }}>{t('att.giveBack')}</button>}
                  </span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="mut small" style={{ marginBottom: 8 }}>{t('hr.balanceHint', { country: books.company.country === 'SA' ? t('hr.lawSA') : t('hr.lawAE') })}</div>
          {bal.error && <ErrorNote error={bal.error} onRetry={bal.reload} />}
          {!bal.data ? <Loading /> : (
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('hr.employee')}</th><th className="num">{t('hr.perYear')}</th><th className="num">{t('hr.earned')}</th><th className="num">{t('hr.opening')}</th><th className="num">{t('hr.taken')}</th><th className="num">{t('hr.balance')}</th></tr></thead>
              <tbody>{bal.data.map((b) => (
                <tr key={b.contactId}><td>{local(b.name, b.nameAr)}</td><td className="num" data-label={t('hr.perYear')}>{b.perYear}</td>
                  <td className="num ltr" data-label={t('hr.earned')}>{b.earned.toFixed(2)}</td><td className="num ltr" data-label={t('hr.opening')}>{b.opening.toFixed(2)}</td>
                  <td className="num ltr" data-label={t('hr.taken')}>{b.taken.toFixed(2)}</td><td className="num ltr" data-label={t('hr.balance')}><b>{b.balance.toFixed(2)}</b></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ payroll
interface RunRow { id: string; periodEnd: string; status: string; totalGross: string; totalNet: string; totalEmployer: string; entryId: string | null; paymentEntryId: string | null;
  paidOn: string | null; createdBy: string | null; postedBy: string | null; people: number }
interface PayLineRow extends Omit<PayslipLine, 'idNumber' | 'iban'> { id: string; contactId: string; costCentreId: string | null; sickUnpaid: number; eosAccrual: string; loanId: string | null }
interface RunDetail extends RunRow { companyId: string; lines: PayLineRow[]; totals: Record<string, string>; missingDetails: string[] }

export function Payroll({ books, id }: { books: CompanyBooks; id?: string }) {
  return id ? <PayrollRun books={books} id={id} /> : <PayrollList books={books} />;
}

function PayrollList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const list = useApi<RunRow[]>(`/api/companies/${books.company.id}/payroll`);
  const [month, setMonth] = useState(lastMonth());
  const { run, busy, notes } = useRun();
  const prepare = () => void run(async () => {
    const r = await api<{ id: string }>(`/api/companies/${books.company.id}/payroll`, { body: { month: monthEndOf(month) } });
    go('HRM', 'payroll', r.id);
  });
  return (
    <>
      {books.canPost && (
        <div className="card">
          <h2>{t('hr.prepareTitle')}</h2>
          <div className="mut small" style={{ marginBottom: 8 }}>{t('hr.prepareHint')}</div>
          <div className="actions">
            <label className="f">{t('hr.month')}<input id="pr-month" type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
            <button className="b p" id="pr-prepare" disabled={busy} onClick={prepare}>{t('hr.prepare')}</button>
          </div>
        </div>
      )}
      {notes}
      <HrSettings books={books} />
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('hr.noPayroll')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('hr.month')}</th><th className="num">{t('hr.people')}</th><th className="num">{t('hr.gross')}</th><th className="num">{t('hr.netPay')}</th><th>{t('hr.status')}</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id}>
                <td><button className="link" onClick={() => go('HRM', 'payroll', r.id)}>{monthName(r.periodEnd)}</button></td>
                <td className="num" data-label={t('hr.people')}>{r.people}</td>
                <td className="num ltr" data-label={t('hr.gross')}>{r.status === 'draft' ? '—' : fmt(r.totalGross)}</td>
                <td className="num ltr" data-label={t('hr.netPay')}>{r.status === 'draft' ? '—' : fmt(r.totalNet)}</td>
                <td data-label={t('hr.status')}><span className={`badge ${r.status === 'paid' ? 'good' : r.status === 'draft' ? 'warn' : ''}`}>{t(`hr.run.${r.status}` as Key)}</span>{r.paidOn && <span className="small mut ltr"> {r.paidOn}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

function PayrollRun({ books, id }: { books: CompanyBooks; id: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const monthName = useMonthName();
  const r = useApi<RunDetail>(`/api/payroll/${id}`);
  const { run, busy, notes } = useRun();
  const [confirm, setConfirm] = useState<'post' | 'delete'>();
  const [pay, setPay] = useState<{ bankAccountId: string; date: string }>();
  const [lineEdit, setLineEdit] = useState<{ id: string; bonus: string; otherDeductions: string; note: string }>();
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const draft = d.status === 'draft';
  const banks = bankAccounts(books);
  const deductions = (l: PayLineRow) => sumOf([l.absence, l.sick, l.insuranceEmployee, l.loan, l.otherDeductions]);
  const payslips = (only?: PayLineRow) => run(async () => {
    const [seller, staff] = await Promise.all([api<{ seller: Seller }>(`/api/companies/${books.company.id}/print-header`), api<HrEmp[]>(`/api/companies/${books.company.id}/hr/employees`)]);
    const lines = (only ? [only] : d.lines).map((l) => { const e = staff.find((x) => x.id === l.contactId); return { ...l, idNumber: e?.idNumber ?? null, iban: e?.iban ?? null }; });
    await printPdf(`${t('pdf.payslip')} ${d.periodEnd.slice(0, 7)}${only ? ` ${only.name}` : ''}`, () => <PayslipPdf seller={seller.seller} periodEnd={d.periodEnd} paidOn={d.paidOn} lines={lines} />);
  });
  const salaryFile = () => run(async () => {
    const f = await api<{ fileName: string; contentType: string; content: string }>(`/api/payroll/${id}/salary-file`);
    await download(new TextEncoder().encode(f.content), f.fileName, f.contentType);
  });
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('HRM', 'payroll')}>{t('hr.allPayroll')}</button>
        <span className="spacer" />
        {draft && books.canPost && <>
          <button className="b" disabled={busy} onClick={() => void run(async () => { await api(`/api/payroll/${id}/refresh`, { body: {} }); r.reload(); }, t('hr.refreshed'))}>{t('hr.refresh')}</button>
          <button className="b" disabled={busy} onClick={() => setConfirm('delete')}>{t('hr.removeDraft')}</button>
          <button className="b p" id="pr-post" disabled={busy || !d.lines.length} onClick={() => setConfirm('post')}>{t('hr.post')}</button>
        </>}
        {!draft && <>
          <button className="b" id="pr-payslips" disabled={busy} onClick={() => void payslips()}>{t('hr.payslips')}</button>
          <button className="b" id="pr-file" disabled={busy} onClick={() => void salaryFile()}>{books.company.country === 'AE' ? t('hr.wpsFile') : t('hr.payrollFile')}</button>
          {d.status === 'posted' && books.canPost && !pay && <button className="b p" id="pr-pay" onClick={() => setPay({ bankAccountId: banks[0]?.id ?? '', date: today() })}>{t('hr.paySalaries')}</button>}
          <button className="b" onClick={() => go('Journal', 'entries', d.entryId!)}>{t('hr.viewEntry')}</button>
        </>}
      </div>
      <div className="top"><h2 style={{ margin: 0, flex: '1 1 auto' }}>{t('hr.payrollFor', { month: monthName(d.periodEnd) })}</h2>
        <span className={`badge ${d.status === 'paid' ? 'good' : draft ? 'warn' : ''}`}>{t(`hr.run.${d.status}` as Key)}</span></div>
      {confirm && <ConfirmBar busy={busy} message={confirm === 'post' ? t('hr.postConfirm', { month: monthName(d.periodEnd), net: fmt(d.totals.net ?? '0') }) : t('hr.deleteConfirm')}
        onNo={() => setConfirm(undefined)} onYes={() => void run(async () => {
          if (confirm === 'post') { await api(`/api/payroll/${id}/post`, { body: {} }); setConfirm(undefined); r.reload(); }
          else { await api(`/api/payroll/${id}/delete`, { body: {} }); go('HRM', 'payroll'); }
        }, confirm === 'post' ? t('hr.posted') : undefined)} />}
      {notes}
      {draft && <div className="notice small">{t('hr.draftHint')}</div>}
      {d.missingDetails.length > 0 && draft && <div className="notice warn small">{t('hr.missingInRun')} {d.missingDetails.join(', ')}</div>}
      {pay && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/payroll/${id}/pay`, { body: pay }); setPay(undefined); r.reload(); }, t('hr.paid')); }}>
          <h2>{t('hr.paySalaries')}</h2>
          <div className="row">
            <label className="f">{t('hr.paidFrom')}<select id="pay-bank" value={pay.bankAccountId} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{local(b.name, b.nameAr)}</option>)}</select></label>
            <label className="f">{t('hr.payDate')}<input id="pay-date" type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></label>
          </div>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('hr.payHint', { net: fmt(d.totals.net ?? '0') })}</div>
          <div className="actions"><button className="b p" id="pay-save" disabled={busy}>{t('hr.paySalaries')}</button><button type="button" className="b" onClick={() => setPay(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="grid">
        <Tile label={t('hr.people')} value={d.lines.length} />
        <Tile label={t('hr.gross')} value={<span className="ltr">{fmt(d.totals.gross ?? '0')}</span>} sub={books.company.currency} />
        <Tile label={t('hr.netPay')} value={<span className="ltr">{fmt(d.totals.net ?? '0')}</span>} sub={books.company.currency} />
        <Tile label={t('hr.employerCost')} value={<span className="ltr">{fmt(sumOf([d.totals.insuranceEmployer ?? '0', d.totals.eosAccrual ?? '0']))}</span>} sub={t('hr.employerCostHint')} />
      </div>
      <div className="card">
        <div className="wrap"><table className="stack payroll">
          <thead><tr><th>{t('hr.employee')}</th><th className="num">{t('hr.wageEarned')}</th><th className="num">{t('hr.overtimeBonus')}</th><th className="num">{t('hr.deductions')}</th>
            <th className="num">{t('hr.netPay')}</th><th className="num">{t('hr.employerInsurance')}</th><th className="num">{t('hr.eosAccrual')}</th><th /></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id}>
              <td>{local(l.name, l.nameAr)} <span className="mut small ltr">{l.employeeNo}</span>
                {(l.unpaidDays > 0 || l.absentDays > 0 || l.sickUnpaid > 0) && <div className="small mut">{[l.unpaidDays && t('hr.unpaidN', { n: l.unpaidDays }), l.absentDays && t('hr.absentN', { n: l.absentDays }),
                  l.sickUnpaid && t('hr.sickN', { n: days((l.sickUnpaid / 100).toFixed(2)) })].filter(Boolean).join(' · ')}</div>}
                {l.note && <div className="small mut">{l.note}</div>}</td>
              <td className="num ltr" data-label={t('hr.wageEarned')}>{fmt(sumOf([l.basic, l.housing, l.transport, l.otherAllowance]))}</td>
              <td className="num ltr" data-label={t('hr.overtimeBonus')}>{fmt(sumOf([l.overtime, l.bonus]))}{toMinor(l.overtimeHours) > 0n && <div className="small mut">{t('hr.hoursN', { n: l.overtimeHours })}</div>}</td>
              <td className="num ltr" data-label={t('hr.deductions')}>{fmt(deductions(l))}{toMinor(l.loan) > 0n && <div className="small mut">{t('hr.loanN', { amount: fmt(l.loan) })}</div>}</td>
              <td className="num ltr" data-label={t('hr.netPay')}><b>{fmt(l.net)}</b></td>
              <td className="num ltr" data-label={t('hr.employerInsurance')}>{fmt(l.insuranceEmployer)}</td>
              <td className="num ltr" data-label={t('hr.eosAccrual')}>{fmt(l.eosAccrual)}</td>
              <td className="num">
                {draft && books.canPost && <button className="b small" onClick={() => setLineEdit({ id: l.id, bonus: toMinor(l.bonus) ? l.bonus : '', otherDeductions: toMinor(l.otherDeductions) ? l.otherDeductions : '', note: l.note ?? '' })}>{t('hr.adjust')}</button>}
                {!draft && <button className="b small" onClick={() => void payslips(l)}>{t('hr.payslip')}</button>}
              </td>
            </tr>
          ))}
            <tr className="total"><td>{t('total')}</td><td className="num ltr">{fmt(sumOf([d.totals.basic!, d.totals.housing!, d.totals.transport!, d.totals.otherAllowance!]))}</td>
              <td className="num ltr">{fmt(sumOf([d.totals.overtime!, d.totals.bonus!]))}</td>
              <td className="num ltr">{fmt(sumOf([d.totals.absence!, d.totals.sick!, d.totals.insuranceEmployee!, d.totals.loan!, d.totals.otherDeductions!]))}</td>
              <td className="num ltr"><b>{fmt(d.totals.net!)}</b></td><td className="num ltr">{fmt(d.totals.insuranceEmployer!)}</td><td className="num ltr">{fmt(d.totals.eosAccrual!)}</td><td /></tr>
          </tbody>
        </table></div>
      </div>
      {lineEdit && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/payroll-lines/${lineEdit.id}`, { body: lineEdit }); setLineEdit(undefined); r.reload(); }); }}>
          <h2>{t('hr.adjustFor', { name: d.lines.find((l) => l.id === lineEdit.id)?.name ?? '' })}</h2>
          <div className="row">
            <label className="f">{t('hr.bonus')} ({books.company.currency})<input id="pl-bonus" inputMode="decimal" className="num ltr amount" value={lineEdit.bonus} onChange={(e) => setLineEdit({ ...lineEdit, bonus: e.target.value })} /></label>
            <label className="f">{t('hr.otherDeductions')} ({books.company.currency})<input id="pl-ded" inputMode="decimal" className="num ltr amount" value={lineEdit.otherDeductions} onChange={(e) => setLineEdit({ ...lineEdit, otherDeductions: e.target.value })} /></label>
            <label className="f">{t('hr.notes')}<input id="pl-note" value={lineEdit.note} onChange={(e) => setLineEdit({ ...lineEdit, note: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="pl-save" disabled={busy}>{t('hr.saveLine')}</button><button type="button" className="b" onClick={() => setLineEdit(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <p className="mut small">{t(books.company.country === 'SA' ? 'hr.rulesSA' : 'hr.rulesAE')}</p>
    </>
  );
}

// ------------------------------------------------------------------ loans and advances
interface LoanRow { id: string; number: string; contactId: string; name: string; nameAr: string | null; issueDate: string; amount: string; installment: string; balance: string; notes: string | null; entryId: string }

export function Loans({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const list = useApi<LoanRow[]>(`/api/companies/${books.company.id}/hr/loans`);
  const staff = useApi<HrEmp[]>(`/api/companies/${books.company.id}/hr/employees`);
  const banks = bankAccounts(books);
  const [form, setForm] = useState<{ contactId: string; date: string; amount: string; installment: string; bankAccountId: string; notes: string }>();
  const { run, busy, notes } = useRun();
  const people = (staff.data ?? []).filter((e) => e.hasProfile && !e.settled);
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="mut small" style={{ flex: '1 1 300px' }}>{t('hr.loansHint')}</div>
        {books.canPost && !form && <button className="b p" id="loan-new" onClick={() => setForm({ contactId: people[0]?.id ?? '', date: today(), amount: '', installment: '', bankAccountId: banks[0]?.id ?? '', notes: '' })}>{t('hr.loanNew')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/companies/${books.company.id}/hr/loans`, { body: form }); setForm(undefined); list.reload(); }, t('hr.loanSaved')); }}>
          <h2>{t('hr.loanNew')}</h2>
          <div className="row">
            <label className="f">{t('hr.employee')}<select id="ln-emp" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
              {people.map((p) => <option key={p.id} value={p.id}>{local(p.name, p.nameAr)}</option>)}</select></label>
            <label className="f">{t('hr.date')}<input id="ln-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="f">{t('hr.paidFrom')}<select id="ln-bank" value={form.bankAccountId} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{local(b.name, b.nameAr)}</option>)}</select></label>
          </div>
          <div className="row">
            <label className="f">{t('hr.loanAmount')} ({books.company.currency})<input id="ln-amount" inputMode="decimal" className="num ltr amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            <label className="f">{t('hr.installment')} ({books.company.currency})<input id="ln-inst" inputMode="decimal" className="num ltr amount" value={form.installment} placeholder={form.amount} onChange={(e) => setForm({ ...form, installment: e.target.value })} /></label>
            <label className="f">{t('hr.notes')}<input id="ln-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="ln-save" disabled={busy || !form.contactId}>{t('hr.loanSave')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('hr.noLoans')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('hr.loanNo')}</th><th>{t('hr.employee')}</th><th>{t('hr.date')}</th><th className="num">{t('hr.loanAmount')}</th><th className="num">{t('hr.installment')}</th><th className="num">{t('hr.stillOwed')}</th></tr></thead>
            <tbody>{list.data.map((l) => (
              <tr key={l.id} className={toMinor(l.balance) === 0n ? 'mut' : ''}><td className="ltr">{l.number}</td><td>{local(l.name, l.nameAr)}{l.notes && <div className="small mut">{l.notes}</div>}</td>
                <td className="ltr" data-label={t('hr.date')}>{l.issueDate}</td><td className="num ltr" data-label={t('hr.loanAmount')}>{fmt(l.amount)}</td>
                <td className="num ltr" data-label={t('hr.installment')}>{fmt(l.installment)}</td><td className="num ltr" data-label={t('hr.stillOwed')}><b>{fmt(l.balance)}</b></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ end of service
interface EosRow { contactId: string; name: string; nameAr: string | null; employeeNo: string | null; joinDate: string; serviceDays: number; basis: string; full: string; onResignation: string; accrued: string; provision: string }
interface SettlementRow { id: string; contactId: string; name: string; nameAr: string | null; leavingDate: string; reason: string; serviceDays: number; eosAmount: string; leaveDays: string; leavePay: string; loanRecovered: string; totalDue: string; entryId: string }
const years = (d: number) => (d / 365).toFixed(1);

export function EndOfService({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [asOf, setAsOf] = useState(today());
  const s = useApi<{ rows: EosRow[]; books: string; settlements: SettlementRow[] }>(`/api/companies/${books.company.id}/hr/end-of-service?asOf=${asOf}`);
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const held = sumOf(s.data.rows.map((r) => r.provision));
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="mut small" style={{ flex: '1 1 300px' }}>{t(books.company.country === 'SA' ? 'hr.eosLawSA' : 'hr.eosLawAE')}</div>
        <label className="f">{t('asOf')}<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
      </div>
      <div className="grid">
        <Tile label={t('hr.eosOwedToday')} value={<span className="ltr">{fmt(sumOf(s.data.rows.map((r) => r.full)))}</span>} sub={books.company.currency} />
        <Tile label={t('hr.provisionHeld')} value={<span className="ltr">{fmt(held)}</span>} sub={t('hr.inBooks', { amount: fmt(s.data.books) })} tone={held === s.data.books ? '' : 'warn'} />
      </div>
      <div className="card">
        <div className="wrap"><table className="stack">
          <thead><tr><th>{t('hr.employee')}</th><th className="num">{t('hr.years')}</th><th className="num">{t('hr.eosBasis')}</th><th className="num">{t('hr.eosFull')}</th>
            <th className="num">{t('hr.eosResign')}</th><th className="num">{t('hr.provision')}</th><th /></tr></thead>
          <tbody>{s.data.rows.map((r) => (
            <tr key={r.contactId}><td>{local(r.name, r.nameAr)} <span className="mut small ltr">{r.employeeNo}</span><div className="small mut ltr">{r.joinDate}</div></td>
              <td className="num ltr" data-label={t('hr.years')}>{years(r.serviceDays)}</td><td className="num ltr" data-label={t('hr.eosBasis')}>{fmt(r.basis)}</td>
              <td className="num ltr" data-label={t('hr.eosFull')}><b>{fmt(r.full)}</b></td><td className="num ltr" data-label={t('hr.eosResign')}>{fmt(r.onResignation)}</td>
              <td className="num ltr" data-label={t('hr.provision')}>{fmt(r.provision)}</td>
              <td className="num">{books.canPost && <button className="b small" onClick={() => go('HRM', 'employees', r.contactId, 'settlement')}>{t('hr.settle')}</button>}</td></tr>
          ))}
            {s.data.rows.length === 0 && <tr><td colSpan={7} className="mut">{t('hr.noEmployees')}</td></tr>}</tbody>
        </table></div>
      </div>
      {s.data.settlements.length > 0 && (
        <div className="card">
          <h2>{t('hr.settlements')}</h2>
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('hr.employee')}</th><th>{t('hr.leavingDate')}</th><th>{t('hr.leavingReason')}</th><th className="num">{t('hr.eosAmount')}</th><th className="num">{t('hr.leavePay')}</th><th className="num">{t('hr.totalDue')}</th></tr></thead>
            <tbody>{s.data.settlements.map((x) => (
              <tr key={x.id}><td>{local(x.name, x.nameAr)}</td><td className="ltr" data-label={t('hr.leavingDate')}>{x.leavingDate}</td><td data-label={t('hr.leavingReason')}>{t(`hr.reason.${x.reason}` as Key)}</td>
                <td className="num ltr" data-label={t('hr.eosAmount')}>{fmt(x.eosAmount)}</td><td className="num ltr" data-label={t('hr.leavePay')}>{fmt(x.leavePay)}</td>
                <td className="num ltr" data-label={t('hr.totalDue')}><button className="link" onClick={() => go('Journal', 'entries', x.entryId)}>{fmt(x.totalDue)}</button></td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ HR documents
export interface HrDoc { id: string; contactId: string; name: string; nameAr: string | null; kind: string; number: string | null; issueDate: string | null; expiryDate: string | null; notes: string | null; daysLeft: number | null; files: number }
const DOC_KINDS = ['national_id', 'iqama', 'emirates_id', 'passport', 'visa', 'work_permit', 'contract', 'medical_insurance', 'driving_licence', 'other'] as const;

export function ExpiryBadge({ daysLeft }: { daysLeft: number | null }) {
  const { t } = useI18n();
  if (daysLeft === null) return <span className="mut small">—</span>;
  if (daysLeft < 0) return <span className="badge bad">{t('hr.expired')}</span>;
  return <span className={`badge ${daysLeft <= 30 ? 'bad' : daysLeft <= 60 ? 'warn' : 'good'}`}>{t('hr.daysLeft', { n: daysLeft })}</span>;
}

export function HrDocuments({ books, contactId }: { books: CompanyBooks; contactId?: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const list = useApi<HrDoc[]>(`/api/companies/${books.company.id}/hr/documents${contactId ? `?employee=${contactId}` : ''}`);
  const staff = useApi<HrEmp[]>(contactId ? null : `/api/companies/${books.company.id}/hr/employees`);
  const [form, setForm] = useState<{ id?: string; contactId: string; kind: string; number: string; issueDate: string; expiryDate: string; notes: string }>();
  const [files, setFiles] = useState<string>();
  const { run, busy, notes } = useRun();
  const defaultKind = books.company.country === 'AE' ? 'emirates_id' : 'iqama';
  const people = contactId ? [] : (staff.data ?? []).filter((e) => !e.settled);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ id: string }>(form!.id ? `/api/hr-documents/${form!.id}` : `/api/companies/${books.company.id}/hr/documents`, { body: form });
      setForm(undefined); setFiles(r.id); list.reload();
    }, t('hr.docSaved'));
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        {contactId ? <h2 style={{ margin: 0 }}>{t('sub.hr-documents')}</h2> : <div className="mut small" style={{ flex: '1 1 300px' }}>{t('hr.docsHint')}</div>}
        <span className="spacer" />
        {books.canPost && !form && <button className="b p" id="doc-new" onClick={() => setForm({ contactId: contactId ?? people[0]?.id ?? '', kind: defaultKind, number: '', issueDate: '', expiryDate: '', notes: '' })}>{t('hr.docNew')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={save}>
          <div className="row">
            {!contactId && <label className="f">{t('hr.employee')}<select id="hd-emp" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
              {people.map((p) => <option key={p.id} value={p.id}>{local(p.name, p.nameAr)}</option>)}</select></label>}
            <label className="f">{t('hr.docKind')}<select id="hd-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {DOC_KINDS.map((k) => <option key={k} value={k}>{t(`hr.doc.${k}`)}</option>)}</select></label>
            <label className="f">{t('hr.docNumber')}<input id="hd-no" dir="ltr" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('hr.issueDate')}<input id="hd-issue" type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></label>
            <label className="f">{t('hr.expiryDate')}<input id="hd-expiry" type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></label>
            <label className="f">{t('hr.notes')}<input id="hd-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="hd-save" disabled={busy || !form.contactId}>{t('hr.docSave')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('hr.noDocs')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr>{!contactId && <th>{t('hr.employee')}</th>}<th>{t('hr.docKind')}</th><th>{t('hr.docNumber')}</th><th>{t('hr.expiryDate')}</th><th /><th /></tr></thead>
            <tbody>{list.data.map((x) => (
              <tr key={x.id}>{!contactId && <td>{local(x.name, x.nameAr)}</td>}<td data-label={t('hr.docKind')}>{t(`hr.doc.${x.kind}` as Key)}{x.notes && <div className="small mut">{x.notes}</div>}</td>
                <td className="ltr" data-label={t('hr.docNumber')}>{x.number ?? '—'}</td><td className="ltr" data-label={t('hr.expiryDate')}>{x.expiryDate ?? '—'}</td><td><ExpiryBadge daysLeft={x.daysLeft} /></td>
                <td className="num"><span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <button className="b small" onClick={() => setFiles(files === x.id ? undefined : x.id)}>{t('hr.files', { n: x.files })}</button>
                  {books.canPost && <button className="b small" onClick={() => setForm({ id: x.id, contactId: x.contactId, kind: x.kind, number: x.number ?? '', issueDate: x.issueDate ?? '', expiryDate: x.expiryDate ?? '', notes: x.notes ?? '' })}>{t('hr.change')}</button>}
                </span></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {files && <AttachmentsCard key={files} owner="hr-documents" id={files} canAdd={books.canPost} canRemove={books.canPost} hint={t('hr.docFilesHint')} />}
    </>
  );
}

/** The employer's numbers for salary files and social insurance (UAE WPS needs the establishment ID and bank routing code). */
function HrSettings({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const s = useApi<{ employerId: string | null; bankRouting: string | null; insuranceNo: string | null }>(`/api/companies/${books.company.id}/hr/settings`);
  const [f, setF] = useState<{ employerId: string; bankRouting: string; insuranceNo: string }>();
  const { run, busy, notes } = useRun();
  if (!s.data) return null;
  const v = f ?? { employerId: s.data.employerId ?? '', bankRouting: s.data.bankRouting ?? '', insuranceNo: s.data.insuranceNo ?? '' };
  const ae = books.company.country === 'AE';
  return (
    <details className="card" open={ae && !s.data.employerId}>
      <summary><b>{t('hr.settingsTitle')}</b></summary>
      {notes}
      <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: '8px 0 0' }}>
        <div className="row">
          <label className="f">{t(ae ? 'hr.employerIdAE' : 'hr.employerIdSA')}<input id="hs-employer" dir="ltr" value={v.employerId} onChange={(e) => setF({ ...v, employerId: e.target.value })} /></label>
          {ae && <label className="f">{t('hr.employerRouting')}<input id="hs-routing" dir="ltr" value={v.bankRouting} onChange={(e) => setF({ ...v, bankRouting: e.target.value })} /></label>}
          <label className="f">{t(ae ? 'hr.employerGpssa' : 'hr.employerGosi')}<input id="hs-ins" dir="ltr" value={v.insuranceNo} onChange={(e) => setF({ ...v, insuranceNo: e.target.value })} /></label>
        </div>
        {books.canPost && <button className="b" id="hs-save" disabled={busy || !f} onClick={() => void run(async () => { await api(`/api/companies/${books.company.id}/hr/settings`, { body: v }); setF(undefined); s.reload(); }, t('admin.saved'))}>{t('hr.saveSettings')}</button>}
      </fieldset>
    </details>
  );
}
