// An employee's HR details (pay, nationality, IDs, bank, social insurance, opening balances), leave and end of
// service so far, their HR documents, and the final settlement when they leave.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { today } from '../router.ts';
import { ConfirmBar, ErrorNote, Loading, errorText } from '../ui.tsx';
import { HrDocuments, type HrEmp } from './Hrm.tsx';

const NATIONALITIES = ['SA', 'AE', 'OM', 'BH', 'KW', 'QA', 'EG', 'JO', 'SY', 'LB', 'PS', 'YE', 'SD', 'MA', 'TN', 'IN', 'PK', 'BD', 'LK', 'NP', 'PH', 'ID', 'ET', 'KE', 'UG',
  'NG', 'TR', 'GB', 'US', 'CA', 'FR', 'DE'] as const;
const REASONS = ['resignation', 'termination', 'contract_end', 'retirement', 'death', 'other'] as const;
type Form = Record<string, string>;

export function HrDetails({ books, id, settling }: { books: CompanyBooks; id: string; settling?: boolean }) {
  const { t, lang, has } = useI18n();
  const e = useApi<HrEmp>(`/api/employees/${id}/hr`);
  const [f, setF] = useState<Form>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (e.error) return <ErrorNote error={e.error} onRetry={e.reload} />;
  if (!e.data) return <Loading />;
  const x = e.data;
  const country = books.company.country;
  const form: Form = f ?? {
    nationality: x.nationality ?? country, idNumber: x.idNumber ?? '', passportNo: x.passportNo ?? '', dateOfBirth: x.dateOfBirth ?? '', joinDate: x.joinDate ?? '',
    contractType: x.contractType ?? 'unlimited', contractEnd: x.contractEnd ?? '',
    basic: x.hasProfile ? x.basic : '', housing: x.hasProfile && toMinor(x.housing) ? x.housing : '', transport: x.hasProfile && toMinor(x.transport) ? x.transport : '',
    otherAllowance: x.hasProfile && toMinor(x.otherAllowance) ? x.otherAllowance : '', iban: x.iban ?? '', bankRouting: x.bankRouting ?? '', wpsPersonId: x.wpsPersonId ?? '',
    insuranceNo: x.insuranceNo ?? '', insuranceRegistered: x.insuranceRegistered ?? '', annualLeaveDays: x.annualLeaveDays == null ? '' : String(x.annualLeaveDays),
    openingLeaveDays: x.hasProfile && Number(x.openingLeaveDays) ? x.openingLeaveDays : '', openingAsOf: x.openingAsOf ?? '', openingEos: x.hasProfile && toMinor(x.openingEos) ? x.openingEos : '',
  };
  const set = (k: string, v: string) => setF({ ...form, [k]: v });
  const names = new Intl.DisplayNames([lang], { type: 'region' });
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true); setMsg({});
    try { await api(`/api/employees/${id}/hr`, { body: form }); setF(undefined); e.reload(); setMsg({ ok: t('admin.saved') }); }
    catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  const national = form.nationality === country;
  const amount = (k: string, label: Key) => (
    <label className="f">{t(label)} ({books.company.currency})<input id={`hr-${k}`} inputMode="decimal" className="num ltr amount" value={form[k]} onChange={(ev) => set(k, ev.target.value)} /></label>
  );
  const wage = fromMinor(['basic', 'housing', 'transport', 'otherAllowance'].reduce((s, k) => { try { return s + toMinor((form[k] ?? '').replace(/,/g, '') || '0'); } catch { return s; } }, 0n));
  return (
    <>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {x.settled && <div className="notice warn">{t('hr.leftOn', { date: x.leavingDate ?? '', reason: t(`hr.reason.${x.leavingReason}` as Key) })}</div>}
      {settling && !x.settled && x.hasProfile && <Settlement books={books} emp={x} onDone={e.reload} />}
      <form className="card" onSubmit={save} noValidate>
        <h2>{t('hr.detailsTitle')}</h2>
        {!x.hasProfile && <div className="notice warn small">{t('hr.detailsNeeded')}</div>}
        <fieldset disabled={!books.canPost || x.settled} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('hr.nationality')}<select id="hr-nationality" value={form.nationality} onChange={(ev) => set('nationality', ev.target.value)}>
              {NATIONALITIES.map((c) => <option key={c} value={c}>{names.of(c)}</option>)}</select></label>
            <label className="f">{t(country === 'AE' ? 'hr.idAE' : national ? 'hr.idSA' : 'hr.iqamaNo')}<input id="hr-id" dir="ltr" value={form.idNumber} onChange={(ev) => set('idNumber', ev.target.value)} /></label>
            <label className="f">{t('hr.passportNo')}<input id="hr-passport" dir="ltr" value={form.passportNo} onChange={(ev) => set('passportNo', ev.target.value)} /></label>
            <label className="f">{t('hr.dateOfBirth')}<input id="hr-dob" type="date" value={form.dateOfBirth} onChange={(ev) => set('dateOfBirth', ev.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('hr.joinDate')}<input id="hr-join" type="date" value={form.joinDate} onChange={(ev) => set('joinDate', ev.target.value)} /></label>
            <label className="f">{t('hr.contractType')}<select id="hr-contract" value={form.contractType} onChange={(ev) => set('contractType', ev.target.value)}>
              <option value="unlimited">{t('hr.contract.unlimited')}</option><option value="limited">{t('hr.contract.limited')}</option></select></label>
            {form.contractType === 'limited' && <label className="f">{t('hr.contractEnd')}<input id="hr-contract-end" type="date" value={form.contractEnd} onChange={(ev) => set('contractEnd', ev.target.value)} /></label>}
          </div>
          <h3>{t('hr.payTitle')}</h3>
          <div className="row">
            {amount('basic', 'hr.basic')}{amount('housing', 'hr.housing')}{amount('transport', 'hr.transport')}{amount('otherAllowance', 'hr.otherAllowance')}
          </div>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('hr.wageTotal', { amount: fmt(wage), currency: books.company.currency })}</div>
          <h3>{t('hr.bankTitle')}</h3>
          <div className="row">
            <label className="f">{t('hr.iban')}<input id="hr-iban" dir="ltr" value={form.iban} onChange={(ev) => set('iban', ev.target.value.toUpperCase())} /></label>
            {country === 'AE' && <>
              <label className="f">{t('hr.bankRouting')}<input id="hr-routing" dir="ltr" value={form.bankRouting} onChange={(ev) => set('bankRouting', ev.target.value)} /></label>
              <label className="f">{t('hr.wpsPersonId')}<input id="hr-wps" dir="ltr" value={form.wpsPersonId} onChange={(ev) => set('wpsPersonId', ev.target.value)} /></label>
            </>}
          </div>
          <h3>{t(country === 'SA' ? 'hr.gosiTitle' : 'hr.pensionTitle')}</h3>
          <div className="small mut" style={{ marginBottom: 6 }}>{t(country === 'SA' ? (national ? 'hr.gosiSaudi' : 'hr.gosiOther') : national ? 'hr.gpssaNational' : 'hr.gpssaOther')}</div>
          <div className="row">
            <label className="f">{t('hr.insuranceNo')}<input id="hr-ins-no" dir="ltr" value={form.insuranceNo} onChange={(ev) => set('insuranceNo', ev.target.value)} /></label>
            {country === 'SA' && national && <label className="f">{t('hr.insuranceRegistered')}<input id="hr-ins-date" type="date" value={form.insuranceRegistered} onChange={(ev) => set('insuranceRegistered', ev.target.value)} /></label>}
          </div>
          <details style={{ margin: '8px 0 12px' }}>
            <summary className="small">{t('hr.openingTitle')}</summary>
            <div className="small mut" style={{ margin: '6px 0' }}>{t('hr.openingHint')}</div>
            <div className="row">
              <label className="f">{t('hr.annualLeaveDays')}<input id="hr-leave-days" inputMode="numeric" className="num ltr" placeholder={t('hr.byLaw')} value={form.annualLeaveDays} onChange={(ev) => set('annualLeaveDays', ev.target.value.replace(/\D/g, ''))} /></label>
              <label className="f">{t('hr.openingLeave')}<input id="hr-open-leave" inputMode="decimal" className="num ltr" value={form.openingLeaveDays} onChange={(ev) => set('openingLeaveDays', ev.target.value)} /></label>
              <label className="f">{t('hr.openingAsOf')}<input id="hr-open-date" type="date" value={form.openingAsOf} onChange={(ev) => set('openingAsOf', ev.target.value)} /></label>
              {amount('openingEos', 'hr.openingEos')}
            </div>
          </details>
          {books.canPost && !x.settled && <button className="b p" id="hr-save" type="submit" disabled={busy}>{t('hr.saveDetails')}</button>}
        </fieldset>
      </form>
      {x.hasProfile && <HrDocuments books={books} contactId={id} />}
    </>
  );
}

interface Preview { leavingDate: string; reason: string; serviceDays: number; basis: string; share: string; eosFull: string; eosAmount: string; leaveDays: string; leavePay: string;
  loanBalance: string; loanRecovered: string; provision: string; totalDue: string }

function Settlement({ books, emp, onDone }: { books: CompanyBooks; emp: HrEmp; onDone: () => void }) {
  const { t, has } = useI18n();
  const [x, setX] = useState({ leavingDate: today(), reason: 'resignation' });
  const [p, setP] = useState<Preview>();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const work = async (fn: () => Promise<void>) => { setBusy(true); setErr(undefined); try { await fn(); } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); } };
  const preview = () => work(async () => setP(await api<Preview>(`/api/employees/${emp.id}/settlement-preview`, { body: x })));
  const c = books.company.currency;
  return (
    <div className="card inset" id="settlement">
      <h2>{t('hr.settlementTitle')}</h2>
      <div className="small mut" style={{ marginBottom: 8 }}>{t('hr.settlementHint')}</div>
      <div className="row">
        <label className="f">{t('hr.leavingDate')}<input id="st-date" type="date" value={x.leavingDate} min={emp.joinDate ?? undefined} onChange={(e) => { setX({ ...x, leavingDate: e.target.value }); setP(undefined); }} /></label>
        <label className="f">{t('hr.leavingReason')}<select id="st-reason" value={x.reason} onChange={(e) => { setX({ ...x, reason: e.target.value }); setP(undefined); }}>
          {REASONS.map((r) => <option key={r} value={r}>{t(`hr.reason.${r}`)}</option>)}</select></label>
        <div className="f" style={{ alignSelf: 'end' }}><button className="b" id="st-preview" disabled={busy} onClick={() => void preview()}>{t('hr.workOut')}</button></div>
      </div>
      {err && <div className="notice bad small" role="alert">{err}</div>}
      {p && (
        <>
          <table className="mini" style={{ maxWidth: 520 }}><tbody>
            <tr><td>{t('hr.serviceLength', { years: (p.serviceDays / 365).toFixed(2), days: p.serviceDays })}</td><td /></tr>
            <tr><td>{t('hr.eosFullLine', { basis: fmt(p.basis) })}</td><td className="num ltr">{fmt(p.eosFull)}</td></tr>
            {p.share !== '1' && <tr><td>{t('hr.eosShare', { share: p.share })}</td><td className="num ltr">{fmt(p.eosAmount)}</td></tr>}
            <tr><td>{t('hr.leavePayLine', { days: p.leaveDays })}</td><td className="num ltr">{fmt(p.leavePay)}</td></tr>
            {toMinor(p.loanRecovered) > 0n && <tr><td>{t('hr.loanRecovered', { balance: fmt(p.loanBalance) })}</td><td className="num ltr">−{fmt(p.loanRecovered)}</td></tr>}
            <tr className="total"><td><b>{t('hr.totalDue')}</b></td><td className="num ltr"><b>{fmt(p.totalDue)} {c}</b></td></tr>
            <tr><td className="small mut">{t('hr.provisionUsed', { amount: fmt(p.provision) })}</td><td /></tr>
          </tbody></table>
          {confirm ? <ConfirmBar busy={busy} message={t('hr.settleConfirm', { name: emp.name, amount: fmt(p.totalDue) })} onNo={() => setConfirm(false)}
            onYes={() => void work(async () => { await api(`/api/employees/${emp.id}/settlement`, { body: x }); setConfirm(false); onDone(); })} />
            : books.canPost && <button className="b p" id="st-save" style={{ marginTop: 10 }} onClick={() => setConfirm(true)}>{t('hr.settlePost')}</button>}
        </>
      )}
    </div>
  );
}
