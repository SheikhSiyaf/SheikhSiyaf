// HRM > Attendance: the time-clock file (import with a preview), the month day by day, and corrections.
// An absence the clock recorded, or a day of approved leave, changes only through a correction that someone else
// with the approve right approves (db/migrations/0028_attendance_days.sql); this screen asks for it and decides it.
import { useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { parseCsv } from '../../../src/bank/statement.ts';
import { readXlsx } from '../../../src/bank/xlsx.ts';
import { attendanceTemplate, clock, defaultWeekend, hoursText } from '../../../src/books/attendanceRules.ts';

type Status = 'present' | 'absent' | 'leave' | 'off';
interface Day { contactId: string; day: string; status: Status; checkIn: number | null; checkOut: number | null; workedMinutes: number | null; overtimeMinutes: number;
  leaveId: string | null; leaveKind: string | null; correctionId: string | null; flags: string[] }
export interface Correction { id: string; contactId: string; name: string; nameAr: string | null; employeeNo: string | null; kind: string; leaveKind: string | null; leaveId: string | null;
  dayFrom: string; dayTo: string; days: number; reason: string; status: string; decisionNote: string | null; createdBy: string | null; mine: boolean; createdAt: string;
  decidedBy: string | null; decidedAt: string | null }
interface MonthDays { days: Day[]; imports: { id: string; fileName: string | null; people: number; days: number; kept: number; createdAt: string; createdBy: string | null }[]; corrections: Correction[] }
interface Preview { posted: boolean; layout: 'daily' | 'punches' | null; missing: string[]; problems: { line: number; problem: string }[]; problemCount: number; unknownNumbers: string[];
  outsideMonth: number; weekend: number[]; dailyHours: number; kept: number; notInFile: { name: string; nameAr: string | null; employeeNo: string | null }[];
  people: { contactId: string; name: string; nameAr: string | null; employeeNo: string | null; present: number; absent: number; leave: number; off: number; overtimeHours: string; flags: number; kept: number }[] }
interface Person { id: string; name: string; nameAr: string | null; employeeNo: string | null }

const LETTER: Record<Status, string> = { present: 'P', absent: 'A', leave: 'L', off: '·' };
const save = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Reading a time-clock file, seeing what it means, then saving the days. */
export function ClockImport({ books, periodEnd, onDone }: { books: CompanyBooks; periodEnd: string; onDone: () => void }) {
  const { t, has, lang } = useI18n();
  const local = useLocalName();
  const [file, setFile] = useState<{ name: string; rows: string[][] }>();
  const [weekend, setWeekend] = useState<number[]>(defaultWeekend(books.company.country));
  const [holidays, setHolidays] = useState('');
  const [hours, setHours] = useState('8');
  const [p, setP] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ people: number; saved: number; kept: number }>();
  const body = (rows: string[][], o: { weekend?: number[]; holidays?: string; hours?: string } = {}) => ({
    periodEnd, rows, fileName: file?.name, weekend: o.weekend ?? weekend, dailyHours: Number(o.hours ?? hours),
    holidays: (o.holidays ?? holidays).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) });
  const check = async (rows: string[][], o: Parameters<typeof body>[1] = {}) => {
    setBusy(true); setErr(undefined); setDone(undefined);
    try { setP(await api<Preview>(`/api/companies/${books.company.id}/hr/attendance-import/preview`, { body: body(rows, o) })); }
    catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(undefined); setP(undefined); setDone(undefined);
    try {
      const n = f.name.toLowerCase();
      const rows = n.endsWith('.xlsx') ? await readXlsx(new Uint8Array(await f.arrayBuffer())) : n.endsWith('.csv') || n.endsWith('.txt') ? parseCsv((await f.text()).replace(/^﻿/, '')) : null;
      if (!rows) { setErr(t('imp.fileType')); return; }
      setFile({ name: f.name, rows });
      await check(rows);
    } catch { setErr(t('imp.unreadable')); }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true); setErr(undefined);
    try {
      setDone(await api(`/api/companies/${books.company.id}/hr/attendance-import/run`, { body: body(file.rows) }));
      setP(undefined); setFile(undefined); onDone();
    } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const dayNames = [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(Date.UTC(2026, 1, 1 + d)).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }));
  const toggleDay = (d: number) => { const w = weekend.includes(d) ? weekend.filter((x) => x !== d) : [...weekend, d]; setWeekend(w); if (file) void check(file.rows, { weekend: w }); };
  const canRun = p && p.layout && !p.posted && p.people.length > 0;
  return (
    <div className="card" id="clock-import">
      <h2>{t('att.importTitle')}</h2>
      <p className="small mut">{t('att.importHint')}</p>
      {done && <div className="notice" id="clock-done">{t('att.imported', { people: done.people, saved: done.saved })}{done.kept > 0 && <> {t('att.keptNote', { n: done.kept })}</>}</div>}
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => save('nusuh-time-clock-template.csv', attendanceTemplate('en'))}>{t('imp.templateEn')}</button>
        <button className="b" onClick={() => save('nusuh-time-clock-template-ar.csv', attendanceTemplate('ar'))}>{t('imp.templateAr')}</button>
      </div>
      <div className="row">
        <fieldset className="f att-week"><legend>{t('att.weekend')}</legend>
          <div className="chips">{dayNames.map((n, d) => (
            <label key={d} className={`chip ${weekend.includes(d) ? 'on' : ''}`}><input type="checkbox" checked={weekend.includes(d)} onChange={() => toggleDay(d)} />{n}</label>
          ))}</div>
        </fieldset>
        <label className="f">{t('att.holidays')}<input id="att-holidays" dir="ltr" placeholder="2026-09-23" value={holidays} onChange={(e) => setHolidays(e.target.value)}
          onBlur={() => file && void check(file.rows)} /><span className="small mut">{t('att.holidaysHint')}</span></label>
        <label className="f">{t('att.dailyHours')}<input id="att-hours" inputMode="decimal" className="num ltr" style={{ width: 90 }} value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={() => file && void check(file.rows)} /><span className="small mut">{t('att.dailyHoursHint')}</span></label>
      </div>
      <label className="imp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files[0]); }}>
        <input id="clock-file" type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <b>{file ? file.name : t('att.choose')}</b><span className="small mut">{t('att.chooseHint')}</span>
      </label>
      {err && <div className="notice bad" role="alert">{err}</div>}
      {busy && <div className="mut small">{t('loading')}</div>}
      {p && (
        <div id="clock-preview">
          {!p.layout ? <div className="notice bad">{t('att.noColumns')}</div> : <>
            <div className="actions" style={{ margin: '8px 0' }}>
              <span className="badge">{t(p.layout === 'daily' ? 'att.layoutDaily' : 'att.layoutPunches')}</span>
              {p.unknownNumbers.length > 0 && <span className="badge warn">{t('att.unknown', { list: p.unknownNumbers.slice(0, 8).join(', ') })}</span>}
              {p.outsideMonth > 0 && <span className="badge">{t('att.outside', { n: p.outsideMonth })}</span>}
              {p.problemCount > 0 && <span className="badge bad">{t('att.problems', { n: p.problemCount })}</span>}
            </div>
            {p.posted && <div className="notice bad">{t('hr.attPosted')}</div>}
            {p.kept > 0 && <div className="notice warn small">{t('att.keptWarn', { n: p.kept })}</div>}
            {p.problems.length > 0 && <div className="small bad" style={{ marginBottom: 6 }}>{p.problems.slice(0, 6).map((x) => `${t('imp.line')} ${x.line}: ${t(x.problem as Key)}`).join(' · ')}</div>}
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('hr.employee')}</th><th className="num">{t('att.present')}</th><th className="num">{t('att.absent')}</th><th className="num">{t('att.leave')}</th>
                <th className="num">{t('att.off')}</th><th className="num">{t('hr.overtimeHours')}</th><th>{t('att.notes')}</th></tr></thead>
              <tbody>{p.people.map((x) => (
                <tr key={x.contactId}>
                  <td>{local(x.name, x.nameAr)} <span className="mut small ltr">{x.employeeNo}</span></td>
                  <td className="num" data-label={t('att.present')}>{x.present}</td>
                  <td className="num" data-label={t('att.absent')}>{x.absent ? <b className="bad">{x.absent}</b> : 0}</td>
                  <td className="num" data-label={t('att.leave')}>{x.leave}</td>
                  <td className="num" data-label={t('att.off')}>{x.off}</td>
                  <td className="num ltr" data-label={t('hr.overtimeHours')}>{x.overtimeHours}</td>
                  <td className="small" data-label={t('att.notes')}>{[x.flags ? t('att.flagged', { n: x.flags }) : '', x.kept ? t('att.keptShort', { n: x.kept }) : ''].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {p.notInFile.length > 0 && <p className="small mut">{t('att.notInFile', { list: p.notInFile.map((x) => local(x.name, x.nameAr)).join(', ') })}</p>}
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="b p" id="clock-run" disabled={busy || !canRun} onClick={() => void run()}>{t('att.run', { n: p.people.length })}</button>
              <span className="small mut">{t('att.runHint')}</span>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}

/** The month day by day; pressing an absence or a leave day starts a correction request. */
export function DayGrid({ books, periodEnd, people, data, onAsk }: { books: CompanyBooks; periodEnd: string; people: Person[]; data: MonthDays; onAsk: (d: Day) => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const n = Number(periodEnd.slice(8, 10));
  const byKey = new Map(data.days.map((d) => [`${d.contactId}|${d.day}`, d]));
  const who = people.filter((p) => data.days.some((d) => d.contactId === p.id));
  if (!who.length) return <div className="card mut" id="att-grid-empty">{t('att.noDays')}</div>;
  const pending = new Set(data.corrections.filter((c) => c.status === 'requested').flatMap((c) => {
    const out: string[] = []; for (let d = c.dayFrom; d <= c.dayTo; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) out.push(`${c.contactId}|${d}`); return out; }));
  return (
    <div className="card">
      <div className="att-legend small">
        {(['present', 'absent', 'leave', 'off'] as Status[]).map((s) => <span key={s}><i className={`att-c ${s}`}>{LETTER[s]}</i> {t(`att.${s}` as Key)}</span>)}
        <span><i className="att-c present corrected">P</i> {t('att.corrected')}</span><span><i className="att-c pend">?</i> {t('att.waiting')}</span>
      </div>
      <p className="small mut">{t('att.gridHint')}</p>
      <div className="wrap"><table className="att-grid" id="att-grid">
        <thead><tr><th>{t('hr.employee')}</th>{Array.from({ length: n }, (_, i) => <th key={i} className="num">{i + 1}</th>)}<th className="num">{t('att.absent')}</th></tr></thead>
        <tbody>{who.map((p) => (
          <tr key={p.id}>
            <th scope="row">{local(p.name, p.nameAr)}</th>
            {Array.from({ length: n }, (_, i) => {
              const day = `${periodEnd.slice(0, 8)}${String(i + 1).padStart(2, '0')}`;
              const d = byKey.get(`${p.id}|${day}`);
              if (!d) return <td key={i} className="att-none" />;
              const askable = books.canPost && (d.status === 'absent' || d.status === 'leave') && !pending.has(`${p.id}|${day}`);
              const title = `${day} · ${t(`att.${d.status}` as Key)}${d.leaveKind ? ` (${t(`hr.kind.${d.leaveKind}` as Key)})` : ''}${d.checkIn !== null ? ` · ${clock(d.checkIn)}–${clock(d.checkOut)}` : ''}${d.overtimeMinutes ? ` · +${hoursText(d.overtimeMinutes)} h` : ''}${d.flags.map((f) => ` · ${t(f as Key)}`).join('')}`;
              const cls = `att-c ${d.status}${d.correctionId ? ' corrected' : ''}${pending.has(`${p.id}|${day}`) ? ' pend' : ''}${d.flags.length ? ' flag' : ''}`;
              return <td key={i}>{askable
                ? <button className={cls} title={title} aria-label={`${local(p.name, p.nameAr)} ${title}`} onClick={() => onAsk(d)}>{LETTER[d.status]}</button>
                : <i className={cls} title={title}>{pending.has(`${p.id}|${day}`) ? '?' : LETTER[d.status]}</i>}</td>;
            })}
            <td className="num"><b>{data.days.filter((d) => d.contactId === p.id && d.status === 'absent').length}</b></td>
          </tr>
        ))}</tbody>
      </table></div>
      {data.imports.length > 0 && <p className="small mut">{t('att.lastImport', { file: data.imports[0]!.fileName ?? '—', by: data.imports[0]!.createdBy ?? '', at: data.imports[0]!.createdAt.slice(0, 16).replace('T', ' ') })}</p>}
    </div>
  );
}

/** Asking for a correction: what the days become, from and to, and why. */
export function CorrectionForm({ books, day, person, range, onDone, onCancel }: { books: CompanyBooks; day: Pick<Day, 'day' | 'status' | 'leaveId'>; person: Person;
  range?: [string, string]; onDone: (msg: string) => void; onCancel: () => void }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const fromLeave = day.status === 'leave';
  const [kind, setKind] = useState(fromLeave ? 'leave_to_working' : 'absence_to_leave');
  const [leaveKind, setLeaveKind] = useState('annual');
  const [from, setFrom] = useState(range?.[0] ?? day.day);
  const [to, setTo] = useState(range?.[1] ?? day.day);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const send = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api(`/api/companies/${books.company.id}/hr/corrections`, { body: { contactId: person.id, kind, leaveKind: kind === 'absence_to_leave' ? leaveKind : null, leaveId: fromLeave ? day.leaveId : null, dayFrom: from, dayTo: to, reason } });
      onDone(t('att.asked'));
    } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  return (
    <div className="card inset" id="corr-form" role="dialog" aria-label={t('att.askTitle')}>
      <h3>{t('att.askTitle')}: {local(person.name, person.nameAr)}</h3>
      <p className="small mut">{t(fromLeave ? 'att.askLeaveHint' : 'att.askAbsentHint')}</p>
      <div className="row">
        {!fromLeave && <label className="f">{t('att.becomes')}<select id="corr-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="absence_to_leave">{t('att.k.absence_to_leave')}</option><option value="absence_excused">{t('att.k.absence_excused')}</option></select></label>}
        {kind === 'absence_to_leave' && <label className="f">{t('hr.leaveKind')}<select id="corr-leave-kind" value={leaveKind} onChange={(e) => setLeaveKind(e.target.value)}>
          {['annual', 'sick', 'unpaid', 'other_paid'].map((k) => <option key={k} value={k}>{t(`hr.kind.${k}` as Key)}</option>)}</select></label>}
        <label className="f">{t('hr.firstDay')}<input id="corr-from" type="date" value={from} min={range?.[0]} max={range?.[1]} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></label>
        <label className="f">{t('hr.lastDay')}<input id="corr-to" type="date" value={to} min={from} max={range?.[1]} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <label className="f">{t('att.why')}<input id="corr-reason" value={reason} placeholder={t('att.whyHint')} onChange={(e) => setReason(e.target.value)} /></label>
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="actions">
        <button className="b p" id="corr-send" disabled={busy || !reason.trim()} onClick={() => void send()}>{t('att.send')}</button>
        <button className="b" onClick={onCancel}>{t('cancel')}</button>
        <span className="small mut">{t('att.sendHint')}</span>
      </div>
    </div>
  );
}

/** Corrections asked for: approve or reject (someone else with the approve right), or withdraw your own. */
export function CorrectionList({ books, list, onChanged, compact }: { books: CompanyBooks; list: Correction[]; onChanged: (msg?: string) => void; compact?: boolean }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const canApprove = Boolean(books.access ? books.access.canApprove : ['partner', 'reviewer'].includes(books.role));
  const [rejecting, setRejecting] = useState<string>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const decide = async (id: string, status: string, msg: string) => {
    setBusy(true); setErr(undefined);
    try { await api(`/api/attendance-corrections/${id}/status`, { body: { status, note } }); setRejecting(undefined); setNote(''); onChanged(msg); }
    catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  if (!list.length) return <div className="mut small">{t('att.noCorrections')}</div>;
  return (
    <>
      {err && <div className="notice bad" role="alert">{err}</div>}
      <div className="wrap"><table className="stack" id="corr-list">
        <thead><tr><th>{t('hr.employee')}</th><th>{t('att.change')}</th><th>{t('hr.dates')}</th><th>{t('att.why')}</th><th>{t('hr.status')}</th><th /></tr></thead>
        <tbody>{list.map((c) => (
          <tr key={c.id} className={c.status === 'withdrawn' || c.status === 'rejected' ? 'mut' : ''}>
            <td>{local(c.name, c.nameAr)}{!compact && <div className="small mut">{t('att.askedBy', { who: c.createdBy ?? '' })}</div>}</td>
            <td data-label={t('att.change')}>{t(`att.k.${c.kind}` as Key)}{c.leaveKind && ` (${t(`hr.kind.${c.leaveKind}` as Key)})`}</td>
            <td className="ltr small" data-label={t('hr.dates')}>{c.dayFrom === c.dayTo ? c.dayFrom : `${c.dayFrom} → ${c.dayTo}`} <span className="mut">({c.days})</span></td>
            <td className="small" data-label={t('att.why')}>{c.reason}{c.decisionNote && <div className="mut">{c.decisionNote}</div>}</td>
            <td data-label={t('hr.status')}><span className={`badge ${c.status === 'approved' ? 'good' : c.status === 'requested' ? 'warn' : ''}`}>{t(`att.s.${c.status}` as Key)}</span>
              {c.decidedBy && <div className="small mut">{c.decidedBy}</div>}</td>
            <td className="num">
              {c.status === 'requested' && rejecting !== c.id && <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {canApprove && !c.mine && <><button className="b small p" disabled={busy} onClick={() => void decide(c.id, 'approved', t('att.approvedMsg'))}>{t('appr.approve')}</button>
                  <button className="b small" disabled={busy} onClick={() => { setRejecting(c.id); setNote(''); }}>{t('appr.reject')}</button></>}
                {c.mine && <button className="b small" disabled={busy} onClick={() => void decide(c.id, 'withdrawn', t('att.withdrawnMsg'))}>{t('att.withdraw')}</button>}
                {!c.mine && !canApprove && <span className="small mut">{t('att.waitingApprover')}</span>}
              </span>}
              {rejecting === c.id && <span className="actions" style={{ justifyContent: 'flex-end' }}>
                <input aria-label={t('att.rejectReason')} placeholder={t('att.rejectReason')} value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="b small" disabled={busy || !note.trim()} onClick={() => void decide(c.id, 'rejected', t('att.rejectedMsg'))}>{t('appr.reject')}</button>
                <button className="b small" onClick={() => setRejecting(undefined)}>{t('cancel')}</button></span>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
    </>
  );
}

/** The day-by-day view with its corrections, for one month. */
export function ClockMonth({ books, periodEnd, people, reloadSheet }: { books: CompanyBooks; periodEnd: string; people: Person[]; reloadSheet: () => void }) {
  const { t } = useI18n();
  const data = useApi<MonthDays>(`/api/companies/${books.company.id}/hr/attendance-days?month=${periodEnd}`);
  const [ask, setAsk] = useState<Day>();
  const [msg, setMsg] = useState<string>();
  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const changed = (m?: string) => { setMsg(m); setAsk(undefined); data.reload(); reloadSheet(); };
  const person = ask && people.find((p) => p.id === ask.contactId);
  return (
    <>
      {msg && <div className="notice" role="status" id="att-msg">{msg}</div>}
      {ask && person && <CorrectionForm books={books} day={ask} person={person} onDone={changed} onCancel={() => setAsk(undefined)} />}
      <DayGrid books={books} periodEnd={periodEnd} people={people} data={data.data} onAsk={(d) => { setMsg(undefined); setAsk(d); }} />
      <div className="card">
        <h3>{t('att.corrections')}</h3>
        <CorrectionList books={books} list={data.data.corrections} onChanged={changed} />
      </div>
    </>
  );
}
