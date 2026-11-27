// Rooms contract options (db/migrations/0095): the contract type on a booking, the guest identity check of a short stay (details
// only: nothing is scanned or uploaded), the rental contract of a long-term booking (Ejar warning, signing, renewal notice,
// addenda, payment schedule, the registered contract PDF), the guest receipt, the settings, and the contracts page
// (renewal alerts and the registration record). The rules are the shared ones in src/books/roomContracts.ts.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { download } from '../print/Print.tsx';
import { ID_TYPES, EJAR_STATUSES, missingLongTerm, missingShortStay, type ContractType } from '../../../src/books/roomContracts.ts';
import { registrationCsv, registrationFields, type RegistrationRow } from '../../../src/books/roomContractCsv.ts';

export interface IdentityForm { idType: string; idNumber: string; nationality: string; verifiedBy: string }
export interface RentalForm { landlordName: string; landlordIdType: string; landlordIdNumber: string; tenantIdType: string; tenantIdNumber: string; property: string; city: string;
  rent: string; rentPeriod: string; deposit: string; vatCode: string; ejarStatus: string; ejarNumber: string }
export const EMPTY_ID: IdentityForm = { idType: '', idNumber: '', nationality: '', verifiedBy: '' };
export const EMPTY_RENTAL: RentalForm = { landlordName: '', landlordIdType: '', landlordIdNumber: '', tenantIdType: '', tenantIdNumber: '', property: '', city: '', rent: '', rentPeriod: '',
  deposit: '0', vatCode: '', ejarStatus: 'not_registered', ejarNumber: '' };

function useAction() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); after?.(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return { run, busy, note: <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</> };
}

const IdTypeSelect = ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => {
  const { t } = useI18n();
  return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">{t('rc.choose')}</option>
    {ID_TYPES.map((k) => <option key={k} value={k}>{t(`rc.idType.${k}` as Key)}</option>)}</select>;
};
const fieldNames = (t: (k: Key) => string, names: string[]) => names.map((n) => t(`rc.f.${n}` as Key)).join(', ');

// ------------------------------------------------------------------ the contract type and its details, on the new booking form
export function ContractFields({ type, setType, idf, setIdf, rf, setRf }: { type: ContractType; setType: (t: ContractType) => void; idf: IdentityForm; setIdf: (v: IdentityForm) => void;
  rf: RentalForm; setRf: (v: RentalForm) => void }) {
  const { t } = useI18n();
  const setI = (k: keyof IdentityForm, v: string) => setIdf({ ...idf, [k]: v });
  const setR = (k: keyof RentalForm, v: string) => setRf({ ...rf, [k]: v });
  const idStarted = Object.values(idf).some((v) => v.trim());
  const idGaps = idStarted ? missingShortStay({ ...idf, checkIn: '2000-01-01', checkOut: '2000-01-02', guests: 1, verifiedAt: 'now' }) : [];
  return (
    <div className="inset" style={{ marginBottom: 10 }} id="bk-contract">
      <label className="f">{t('rc.type')}<select id="bk-type" value={type} onChange={(e) => setType(e.target.value as ContractType)}>
        <option value="short_stay">{t('rc.type.short_stay')}</option><option value="long_term">{t('rc.type.long_term')}</option></select></label>
      {type === 'short_stay' ? (
        <>
          <div className="notice" id="bk-id-notice">{t('rc.idNotice')}</div>
          <div className="small mut">{t('rc.idLater')}</div>
          <div className="row">
            <label className="f">{t('rc.f.idType')}<IdTypeSelect id="bk-id-type" value={idf.idType} onChange={(v) => setI('idType', v)} /></label>
            <label className="f">{t('rc.f.idNumber')}<input id="bk-id-number" dir="ltr" autoComplete="off" value={idf.idNumber} onChange={(e) => setI('idNumber', e.target.value)} /></label>
            <label className="f">{t('rc.f.nationality')}<input id="bk-nationality" value={idf.nationality} onChange={(e) => setI('nationality', e.target.value)} /></label>
            <label className="f">{t('rc.f.verifiedBy')}<input id="bk-verified-by" value={idf.verifiedBy} onChange={(e) => setI('verifiedBy', e.target.value)} /></label>
          </div>
          {idGaps.length > 0 && <div className="notice bad" id="bk-id-missing">{t('rc.missing', { list: fieldNames(t, idGaps) })}</div>}
        </>
      ) : (
        <>
          <div className="notice bad" id="bk-ejar-warning" hidden={rf.ejarStatus === 'registered'}>{t('rc.ejarWarning')}</div>
          <div className="row">
            <label className="f">{t('rc.f.landlordName')}<input id="bk-landlord" value={rf.landlordName} onChange={(e) => setR('landlordName', e.target.value)} /></label>
            <label className="f">{t('rc.f.landlordIdType')}<IdTypeSelect value={rf.landlordIdType} onChange={(v) => setR('landlordIdType', v)} /></label>
            <label className="f">{t('rc.f.landlordIdNumber')}<input dir="ltr" autoComplete="off" value={rf.landlordIdNumber} onChange={(e) => setR('landlordIdNumber', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('rc.f.tenantIdType')}<IdTypeSelect value={rf.tenantIdType} onChange={(v) => setR('tenantIdType', v)} /></label>
            <label className="f">{t('rc.f.tenantIdNumber')}<input id="bk-tenant-id" dir="ltr" autoComplete="off" value={rf.tenantIdNumber} onChange={(e) => setR('tenantIdNumber', e.target.value)} /></label>
            <label className="f">{t('rc.f.property')}<input value={rf.property} onChange={(e) => setR('property', e.target.value)} /></label>
            <label className="f">{t('rc.f.city')}<input id="bk-city" value={rf.city} onChange={(e) => setR('city', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('rc.f.rent')}<input id="bk-rent" inputMode="decimal" className="num" value={rf.rent} onChange={(e) => setR('rent', e.target.value)} /></label>
            <label className="f">{t('rc.f.rentPeriod')}<select id="bk-period" value={rf.rentPeriod} onChange={(e) => setR('rentPeriod', e.target.value)}>
              <option value="">{t('rc.choose')}</option><option value="monthly">{t('rc.rent.monthly')}</option><option value="yearly">{t('rc.rent.yearly')}</option></select></label>
            <label className="f">{t('rc.f.deposit')}<input inputMode="decimal" className="num" value={rf.deposit} onChange={(e) => setR('deposit', e.target.value)} /></label>
            <label className="f">{t('rc.f.vatCode')}<select id="bk-vat" value={rf.vatCode} onChange={(e) => setR('vatCode', e.target.value)}>
              <option value="">{t('rc.choose')}</option>{['standard', 'zero', 'exempt', 'out_of_scope'].map((v) => <option key={v} value={v}>{t(`rc.vat.${v}` as Key)}</option>)}</select></label>
          </div>
          <div className="small mut">{t('rc.rentVatHint')}</div>
          <div className="row">
            <label className="f">{t('rc.f.ejarStatus')}<select id="bk-ejar" value={rf.ejarStatus} onChange={(e) => setR('ejarStatus', e.target.value)}>
              {EJAR_STATUSES.map((s) => <option key={s} value={s}>{t(`rc.ejar.${s}` as Key)}</option>)}</select></label>
            {rf.ejarStatus === 'registered' && <label className="f">{t('rc.f.ejarNumber')}<input id="bk-ejar-no" dir="ltr" value={rf.ejarNumber} onChange={(e) => setR('ejarNumber', e.target.value)} /></label>}
          </div>
        </>
      )}
    </div>
  );
}

/** The fields still missing for the form as entered (empty = can be saved). Tenant name, unit and dates come from the booking itself. */
export function contractGaps(type: ContractType, rf: RentalForm, guestName: string): string[] {
  if (type !== 'long_term') return [];
  return missingLongTerm({ ...rf, tenantName: guestName, unit: 'x', startDate: '2000-01-01', endDate: '2000-01-02' }).filter((n) => !['unit', 'startDate', 'endDate'].includes(n));
}

// ------------------------------------------------------------------ on the booking page
export function ContractPanel({ books, id, type, canEdit, restricted, status, reload }: { books: CompanyBooks; id: string; type: ContractType; canEdit: boolean; restricted: boolean;
  status: string; reload: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="small" style={{ marginTop: 6 }}><span className="badge" id="bk-type-badge">{t(`rc.type.${type}` as Key)}</span></div>
      {restricted && <div className="notice" id="bk-restricted">{t('rc.restrictedNote')}</div>}
      {!restricted && type === 'short_stay' && <GuestCheck id={id} canEdit={canEdit && ['reserved', 'in_house'].includes(status)} reload={reload} />}
      {!restricted && type === 'long_term' && <Rental books={books} id={id} canEdit={canEdit} reload={reload} />}
      {!restricted && type === 'short_stay' && <Receipt id={id} />}
    </>
  );
}

function GuestCheck({ id, canEdit, reload }: { id: string; canEdit: boolean; reload: () => void }) {
  const { t } = useI18n();
  const g = useApi<{ restricted: boolean; check?: { idType: string; idNumber: string; nationality: string; verifiedBy: string; verifiedAt: string } | null }>(`/api/bookings/${id}/guest-check`);
  const { run, busy, note } = useAction();
  const [f, setF] = useState<IdentityForm>();
  if (g.error) return <ErrorNote error={g.error} onRetry={g.reload} />;
  if (!g.data) return <Loading />;
  if (g.data.restricted) return <div className="notice">{t('rc.restrictedNote')}</div>;
  const c = g.data.check;
  const gaps = f ? missingShortStay({ ...f, checkIn: '2000-01-01', checkOut: '2000-01-02', guests: 1, verifiedAt: 'now' }) : [];
  const save = (e: FormEvent) => { e.preventDefault(); void run(() => api(`/api/bookings/${id}/guest-check`, { body: f }), t('rc.checkSaved'), () => { setF(undefined); g.reload(); reload(); }); };
  return (
    <div className="inset" style={{ marginTop: 8 }} id="guest-check">
      <b>{t('rc.guestCheck')}</b>
      <div className="notice" id="guest-check-notice">{t('rc.idNotice')}</div>
      {note}
      {c && !f ? (
        <div className="small">{t(`rc.idType.${c.idType}` as Key)} · <span className="ltr">{c.idNumber}</span> · {c.nationality}<br />
          <span className="mut">{t('rc.verifiedOn', { name: c.verifiedBy, when: c.verifiedAt.slice(0, 16).replace('T', ' ') })}</span>
          {canEdit && <> <button className="b small" onClick={() => setF({ idType: c.idType, idNumber: c.idNumber, nationality: c.nationality, verifiedBy: c.verifiedBy })}>{t('room.change')}</button></>}</div>
      ) : !f ? (
        <div className="small"><span className="mut" id="guest-check-missing">{t('rc.needCheck')}</span> {canEdit && <button className="b small p" id="guest-check-add" onClick={() => setF({ ...EMPTY_ID })}>{t('rc.checkAdd')}</button>}</div>
      ) : (
        <form onSubmit={save}>
          <div className="row">
            <label className="f">{t('rc.f.idType')}<IdTypeSelect id="gc-type" value={f.idType} onChange={(v) => setF({ ...f, idType: v })} /></label>
            <label className="f">{t('rc.f.idNumber')}<input id="gc-number" dir="ltr" autoComplete="off" value={f.idNumber} onChange={(e) => setF({ ...f, idNumber: e.target.value })} /></label>
            <label className="f">{t('rc.f.nationality')}<input id="gc-nationality" value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value })} /></label>
            <label className="f">{t('rc.f.verifiedBy')}<input id="gc-verified" value={f.verifiedBy} onChange={(e) => setF({ ...f, verifiedBy: e.target.value })} /></label>
          </div>
          {gaps.length > 0 && <div className="small mut" id="gc-missing">{t('rc.missing', { list: fieldNames(t, gaps) })}</div>}
          <div className="actions"><button className="b p" id="gc-save" disabled={busy || gaps.length > 0}>{t('rc.checkSave')}</button>
            <button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
    </div>
  );
}

function Receipt({ id }: { id: string }) {
  const { t } = useI18n();
  const r = useApi<{ number: string; lines: { label: string; amount: string }[]; total: string; vatRate: string; cancellationEn: string | null; cancellationAr: string | null; governingLanguage: 'ar' | 'en' }>(`/api/bookings/${id}/receipt`);
  if (!r.data) return null;
  const x = r.data;
  const order = x.governingLanguage === 'ar' ? (['ar', 'en'] as const) : (['en', 'ar'] as const);
  const term = (l: 'ar' | 'en') => (l === 'ar' ? x.cancellationAr : x.cancellationEn);
  return (
    <div className="inset" style={{ marginTop: 8 }} id="guest-receipt">
      <div className="actions"><b>{t('rc.receipt')}</b><span className="spacer" /><button className="b small" onClick={() => window.print()}>{t('rc.print')}</button></div>
      <table><tbody>
        {x.lines.map((l, i) => <tr key={i}><td>{l.label}</td><td className="num">{fmt(l.amount)}</td></tr>)}
        <tr><td><b>{t('rc.receiptTotal')}</b></td><td className="num"><b>{fmt(x.total)}</b></td></tr>
      </tbody></table>
      {(x.cancellationEn || x.cancellationAr) && (
        <div className="small" id="receipt-cancellation"><b>{t('rc.cancelTerms')}</b>
          {order.map((l) => term(l) ? <div key={l} lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'}>{term(l)}</div> : null)}
          <div className="mut">{t('rc.governing', { lang: t(`rc.lang.${x.governingLanguage}` as Key) })}</div></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the rental contract
interface Contract {
  saved: boolean; restricted?: boolean; warning: string | null; signed: boolean; ejarStatus: string; ejarNumber: string | null; landlordName: string; landlordIdType: string; landlordIdNumber: string;
  tenantIdType: string; tenantIdNumber: string; property: string; city: string; rent: string; effectiveRent: string; rentPeriod: string; deposit: string; vatCode: string;
  lastRegisteredRent: string | null; nonrenewalDate: string | null; nonrenewalBy: string | null; signedAt: string | null; end: string; alert: 90 | 60 | null; daysLeft: number; renewsAutomatically: boolean;
  addenda: { no: number; effective: string; newRent: string | null; newEnd: string | null }[];
  instalments: { id: string; no: number; due: string; amount: string; documentId: string | null; documentNumber: string | null }[];
  files: { id: string; fileName: string; size: number }[];
}

function Rental({ books, id, canEdit, reload }: { books: CompanyBooks; id: string; canEdit: boolean; reload: () => void }) {
  const { t } = useI18n();
  const c = useApi<Contract>(`/api/bookings/${id}/contract`);
  const { run, busy, note } = useAction();
  const [ej, setEj] = useState<{ status: string; number: string }>();
  const [nt, setNt] = useState<{ date: string; by: string }>();
  const [ad, setAd] = useState<{ effectiveDate: string; newRent: string; newEnd: string; reason: string }>();
  const done = () => { c.reload(); reload(); };
  if (c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  if (!c.data) return <Loading />;
  const x = c.data;
  if (x.restricted) return <div className="notice">{t('rc.restrictedNote')}</div>;
  if (!x.saved) return <div className="notice bad" id="rental-warning">{x.warning ?? t('rc.ejarWarning')}</div>;
  const canSales = books.canPost;
  const upload = async (file?: File) => {
    if (!file) return;
    const data = btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (b) => String.fromCharCode(b)).join(''));
    void run(() => api(`/api/bookings/${id}/contract/file`, { body: { fileName: file.name, data } }), t('rc.fileSaved'), done);
  };
  return (
    <div className="inset" style={{ marginTop: 8 }} id="rental">
      <b>{t('rc.rental')}</b>
      {x.warning && <div className="notice bad" id="rental-warning">{t('rc.ejarWarning')}</div>}
      {note}
      <div className="small">{t('rc.f.landlordName')}: {x.landlordName} · <span className="ltr">{x.landlordIdNumber}</span> · {t('rc.f.tenantIdNumber')}: <span className="ltr">{x.tenantIdNumber}</span><br />
        {x.property}, {x.city} · {t(`rc.rent.${x.rentPeriod}` as Key)}: <b>{fmt(x.effectiveRent)}</b> · {t('rc.f.deposit')}: {fmt(x.deposit)} · {t(`rc.vat.${x.vatCode}` as Key)}<br />
        {t('rc.f.ejarStatus')}: <b id="rental-ejar">{t(`rc.ejar.${x.ejarStatus}` as Key)}</b>{x.ejarNumber && <span className="ltr"> · {x.ejarNumber}</span>}
        {x.lastRegisteredRent && <span className="mut"> · {t('rc.lastReg', { amount: fmt(x.lastRegisteredRent) })}</span>}</div>
      {canEdit && !ej && <div className="actions"><button className="b small" id="ejar-edit" onClick={() => setEj({ status: x.ejarStatus, number: x.ejarNumber ?? '' })}>{t('rc.ejarChange')}</button></div>}
      {ej && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/bookings/${id}/contract/ejar`, { body: ej }), t('rc.saved'), () => { setEj(undefined); done(); }); }}>
          <label className="f">{t('rc.f.ejarStatus')}<select id="ejar-status" value={ej.status} onChange={(e) => setEj({ ...ej, status: e.target.value })}>
            {EJAR_STATUSES.map((s) => <option key={s} value={s}>{t(`rc.ejar.${s}` as Key)}</option>)}</select></label>
          <label className="f">{t('rc.f.ejarNumber')}<input id="ejar-number" dir="ltr" value={ej.number} onChange={(e) => setEj({ ...ej, number: e.target.value })} /></label>
          <button className="b p" id="ejar-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setEj(undefined)}>{t('cancel')}</button>
        </form>
      )}
      {!x.signed ? (
        <div className="actions"><span className="small mut">{t('rc.signHint')}</span>{canEdit && <button className="b p" id="rental-sign" disabled={busy}
          onClick={() => void run(() => api(`/api/bookings/${id}/contract/sign`, { body: {} }), t('rc.signedNow'), done)}>{t('rc.sign')}</button>}</div>
      ) : (
        <>
          <div className="small" id="rental-signed">{t('rc.signed', { when: String(x.signedAt).slice(0, 10) })}</div>
          <div className="small" id="rental-renewal">
            {x.daysLeft < 0 ? <span className="badge bad">{t('rc.expired', { n: -x.daysLeft })}</span> : x.alert ? <span className="badge warn">{t(`rc.alert${x.alert}` as Key, { n: x.daysLeft })}</span> : <span className="mut">{t('rc.daysLeft', { n: x.daysLeft })}</span>}
            {' '}{x.renewsAutomatically ? t('rc.autoRenew') : t('rc.noRenew', { date: x.nonrenewalDate ?? '', by: x.nonrenewalBy ?? '' })}</div>
          {canEdit && x.renewsAutomatically && !nt && <button className="b small" id="notice-add" onClick={() => setNt({ date: today(), by: '' })}>{t('rc.noticeAdd')}</button>}
          {nt && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/bookings/${id}/contract/non-renewal`, { body: nt }), t('rc.saved'), () => { setNt(undefined); done(); }); }}>
              <label className="f">{t('rc.noticeDate')}<input id="notice-date" type="date" value={nt.date} onChange={(e) => setNt({ ...nt, date: e.target.value })} /></label>
              <label className="f">{t('rc.noticeBy')}<input id="notice-by" value={nt.by} onChange={(e) => setNt({ ...nt, by: e.target.value })} /></label>
              <button className="b p" id="notice-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setNt(undefined)}>{t('cancel')}</button>
            </form>
          )}
          <div style={{ marginTop: 8 }}><b className="small">{t('rc.schedule')}</b>
            <div className="wrap"><table className="stack"><tbody>{x.instalments.map((i) => (
              <tr key={i.id}><td className="ltr" data-label={t('rc.dueOn')}>{i.no} · {i.due}</td><td className="num" data-label={t('rc.f.rent')}>{fmt(i.amount)}</td>
                <td>{i.documentId ? <span className="small mut">{t('rc.billed')} {i.documentNumber ?? ''}</span>
                  : canEdit && canSales && <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/booking-instalments/${i.id}/bill`, { body: {} }), t('rc.rentBilled'), done)}>{t('rc.billRent')}</button>}</td></tr>))}</tbody></table></div></div>
          <div style={{ marginTop: 8 }}><b className="small">{t('rc.addenda')}</b>
            {x.addenda.length === 0 && <div className="small mut">{t('rc.noAddenda')}</div>}
            {x.addenda.map((a) => <div key={a.no} className="small ltr">#{a.no} · {a.effective}{a.newRent ? ` · ${fmt(a.newRent)}` : ''}{a.newEnd ? ` → ${a.newEnd}` : ''}</div>)}
            {canEdit && !ad && <button className="b small" id="addendum-add" onClick={() => setAd({ effectiveDate: today(), newRent: '', newEnd: '', reason: '' })}>{t('rc.addendumAdd')}</button>}
            {ad && (
              <form onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/bookings/${id}/contract/addenda`, { body: ad }), t('rc.saved'), () => { setAd(undefined); done(); }); }}>
                <div className="row">
                  <label className="f">{t('rc.effective')}<input id="addendum-date" type="date" value={ad.effectiveDate} onChange={(e) => setAd({ ...ad, effectiveDate: e.target.value })} /></label>
                  <label className="f">{t('rc.newRent')}<input id="addendum-rent" inputMode="decimal" className="num" value={ad.newRent} onChange={(e) => setAd({ ...ad, newRent: e.target.value })} /></label>
                  <label className="f">{t('rc.newEnd')}<input id="addendum-end" type="date" value={ad.newEnd} onChange={(e) => setAd({ ...ad, newEnd: e.target.value })} /></label>
                  <label className="f">{t('rc.reason')}<input id="addendum-reason" value={ad.reason} onChange={(e) => setAd({ ...ad, reason: e.target.value })} /></label>
                </div>
                <div className="actions"><button className="b p" id="addendum-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setAd(undefined)}>{t('cancel')}</button></div>
              </form>
            )}
          </div>
        </>
      )}
      <div style={{ marginTop: 8 }}><b className="small">{t('rc.contractPdf')}</b>
        {x.files.map((f) => <div key={f.id} className="small"><a href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.fileName}</a></div>)}
        {canEdit && <label className="b small" style={{ display: 'inline-block' }}>{t('rc.upload')}<input id="rental-pdf" type="file" accept=".pdf,application/pdf" hidden onChange={(e) => void upload(e.target.files?.[0])} /></label>}
        <div className="small mut">{t('rc.pdfHint')}</div></div>
    </div>
  );
}

// ------------------------------------------------------------------ settings (administrator)
interface Settings { maxStayDays: number | null; governingLanguage: 'ar' | 'en'; frozenCities: string[]; termsEn: string | null; termsAr: string | null; cancellationEn: string | null; cancellationAr: string | null;
  charges: { id: string; name: string; nameAr: string | null; rate: string; active: boolean; accountId: string | null; vatCode: string }[] }

export function ContractSettings({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const s = useApi<Settings>(`/api/companies/${books.company.id}/room-settings`);
  const { run, busy, note } = useAction();
  const [f, setF] = useState<{ maxStayDays: string; governingLanguage: string; frozenCities: string; termsEn: string; termsAr: string; cancellationEn: string; cancellationAr: string }>();
  const [ch, setCh] = useState<{ id?: string; name: string; nameAr: string; rate: string; active: boolean; accountId: string; vatCode: string }>();
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const start = () => setF({ maxStayDays: d.maxStayDays ? String(d.maxStayDays) : '', governingLanguage: d.governingLanguage, frozenCities: d.frozenCities.join('\n'), termsEn: d.termsEn ?? '', termsAr: d.termsAr ?? '',
    cancellationEn: d.cancellationEn ?? '', cancellationAr: d.cancellationAr ?? '' });
  const income = books.accounts.filter((a) => a.type === 'income');
  return (
    <div className="card" id="room-contract-settings">
      <h2>{t('rc.settings')}</h2>
      <div className="small mut">{t('rc.settingsHint')}</div>
      {note}
      {!f ? (
        <>
          <div className="small">{t('rc.maxStay')}: <b>{d.maxStayDays ? t('rc.days', { n: d.maxStayDays }) : t('rc.off')}</b> · {t('rc.governingLang')}: <b>{t(`rc.lang.${d.governingLanguage}` as Key)}</b> · {t('rc.frozenCities')}: <b>{d.frozenCities.join(', ') || '—'}</b></div>
          {canEdit && <div className="actions"><button className="b small" id="rc-edit" onClick={start}>{t('room.change')}</button></div>}
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/room-settings`, { body: { ...f, maxStayDays: f.maxStayDays.trim() ? Number(f.maxStayDays) : null,
          frozenCities: f.frozenCities.split('\n').map((x) => x.trim()).filter(Boolean) } }), t('rc.saved'), () => { setF(undefined); s.reload(); }); }}>
          <div className="row">
            <label className="f">{t('rc.maxStay')}<input id="rc-max" inputMode="numeric" value={f.maxStayDays} onChange={(e) => setF({ ...f, maxStayDays: e.target.value.replace(/\D/g, '') })} /><small className="mut">{t('rc.maxStayHint')}</small></label>
            <label className="f">{t('rc.governingLang')}<select id="rc-lang" value={f.governingLanguage} onChange={(e) => setF({ ...f, governingLanguage: e.target.value })}>
              <option value="ar">{t('rc.lang.ar')}</option><option value="en">{t('rc.lang.en')}</option></select><small className="mut">{t('rc.governingHint')}</small></label>
            <label className="f">{t('rc.frozenCities')}<textarea id="rc-cities" rows={3} value={f.frozenCities} onChange={(e) => setF({ ...f, frozenCities: e.target.value })} /><small className="mut">{t('rc.frozenHint')}</small></label>
          </div>
          <div className="row">
            <label className="f">{t('rc.termsEn')}<textarea rows={4} value={f.termsEn} onChange={(e) => setF({ ...f, termsEn: e.target.value })} /></label>
            <label className="f">{t('rc.termsAr')}<textarea rows={4} dir="rtl" value={f.termsAr} onChange={(e) => setF({ ...f, termsAr: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('rc.cancelEn')}<textarea id="rc-cancel-en" rows={3} value={f.cancellationEn} onChange={(e) => setF({ ...f, cancellationEn: e.target.value })} /></label>
            <label className="f">{t('rc.cancelAr')}<textarea id="rc-cancel-ar" rows={3} dir="rtl" value={f.cancellationAr} onChange={(e) => setF({ ...f, cancellationAr: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="rc-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <h3 style={{ marginTop: 14 }}>{t('rc.charges')}</h3>
      <div className="small mut">{t('rc.chargesHint')}</div>
      {d.charges.length === 0 && <div className="small mut">{t('rc.chargeNone')}</div>}
      {d.charges.map((c) => <div key={c.id} className="small">{c.name} · {c.rate}% · <span className={c.active ? 'badge good' : 'badge'}>{c.active ? t('rc.on') : t('rc.off')}</span>
        {canEdit && <> <button className="b small" onClick={() => setCh({ id: c.id, name: c.name, nameAr: c.nameAr ?? '', rate: c.rate, active: c.active, accountId: c.accountId ?? '', vatCode: c.vatCode })}>{t('room.change')}</button></>}</div>)}
      {canEdit && !ch && <div className="actions"><button className="b small" id="rc-charge-add" onClick={() => setCh({ name: '', nameAr: '', rate: '', active: false, accountId: '', vatCode: 'out_of_scope' })}>{t('rc.chargeAdd')}</button></div>}
      {ch && (
        <form onSubmit={(e) => { e.preventDefault(); const { id, ...body } = ch; void run(() => api(id ? `/api/room-charges/${id}` : `/api/companies/${books.company.id}/room-charges`, { body: { ...body, accountId: body.accountId || null } }), t('rc.saved'),
          () => { setCh(undefined); s.reload(); }); }}>
          <div className="row">
            <label className="f">{t('rc.chargeName')}<input id="rc-charge-name" value={ch.name} onChange={(e) => setCh({ ...ch, name: e.target.value })} /></label>
            <label className="f">{t('rc.chargeNameAr')}<input dir="rtl" value={ch.nameAr} onChange={(e) => setCh({ ...ch, nameAr: e.target.value })} /></label>
            <label className="f">{t('rc.chargeRate')}<input id="rc-charge-rate" inputMode="decimal" className="num" value={ch.rate} onChange={(e) => setCh({ ...ch, rate: e.target.value })} /></label>
            <label className="f">{t('rc.chargeAccount')}<select value={ch.accountId} onChange={(e) => setCh({ ...ch, accountId: e.target.value })}>
              <option value="">{t('rc.choose')}</option>{income.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
            <label className="f">{t('rc.f.vatCode')}<select value={ch.vatCode} onChange={(e) => setCh({ ...ch, vatCode: e.target.value })}>
              {['standard', 'zero', 'exempt', 'out_of_scope'].map((v) => <option key={v} value={v}>{t(`rc.vat.${v}` as Key)}</option>)}</select></label>
            <label className="f"><span>{t('rc.chargeOn')}</span><input type="checkbox" checked={ch.active} onChange={(e) => setCh({ ...ch, active: e.target.checked })} /></label>
          </div>
          <div className="actions"><button className="b p" id="rc-charge-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setCh(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the contracts page: renewal alerts and the registration record
export function ContractsPage({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const ren = useApi<{ id: string; number: string; tenant: string | null; unit: string | null; end: string; daysLeft: number; alert: 90 | 60 | null; renewsAutomatically: boolean; ejarStatus: string }[]>(`/api/companies/${books.company.id}/rooms/renewals`);
  const [r, setR] = useState({ from: today().slice(0, 8) + '01', to: today() });
  const { run, busy, note } = useAction();
  const [rows, setRows] = useState<RegistrationRow[]>();
  const load = () => void run(async () => { const x = await api<{ rows: RegistrationRow[] }>(`/api/companies/${books.company.id}/rooms/registration-record?from=${r.from}&to=${r.to}`); setRows(x.rows); });
  const exportCsv = async () => { if (rows) await download(new TextEncoder().encode(registrationCsv(rows)), `registration-record-${r.from}-${r.to}.csv`, 'text/csv'); };
  return (
    <>
      <div className="card" id="renewals">
        <h2>{t('rc.renewals')}</h2>
        {ren.error ? <ErrorNote error={ren.error} onRetry={ren.reload} /> : !ren.data ? <Loading /> : ren.data.length === 0 ? <div className="mut">{t('rc.noRenewals')}</div> : (
          <div className="wrap"><table className="stack"><thead><tr><th>{t('room.booking')}</th><th>{t('room.guest')}</th><th>{t('rc.endDate')}</th><th>{t('rc.f.ejarStatus')}</th><th /></tr></thead>
            <tbody>{ren.data.map((x) => <tr key={x.id}><td className="ltr">{x.number}</td><td>{x.tenant ?? t('rc.restricted')} {x.unit && <span className="mut small">{x.unit}</span>}</td><td className="ltr">{x.end}</td>
              <td>{t(`rc.ejar.${x.ejarStatus}` as Key)}</td>
              <td>{x.daysLeft < 0 ? <span className="badge bad">{t('rc.expired', { n: -x.daysLeft })}</span> : <span className="badge warn">{t(`rc.alert${x.alert}` as Key, { n: x.daysLeft })}</span>}{' '}
                <span className="small mut">{x.renewsAutomatically ? t('rc.autoRenewShort') : t('rc.notRenewing')}</span></td></tr>)}</tbody></table></div>
        )}
      </div>
      {canEdit && (
        <div className="card" id="registration-record">
          <h2>{t('rc.registration')}</h2>
          <div className="notice">{t('rc.registrationHint')}</div>
          <div className="notice">{t('rc.idNotice')}</div>
          {note}
          <div className="actions">
            <label className="f">{t('rc.from')}<input id="reg-from" type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></label>
            <label className="f">{t('rc.to')}<input id="reg-to" type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></label>
            <button className="b p" id="reg-show" disabled={busy} onClick={load}>{t('rc.show')}</button>
            {rows && rows.length > 0 && <button className="b" id="reg-csv" onClick={() => void exportCsv()}>{t('rc.exportCsv')}</button>}
          </div>
          {rows && (rows.length === 0 ? <div className="mut">{t('rc.noRecords')}</div> : (
            <div className="wrap"><table className="stack"><thead><tr>{registrationFields.map((k) => <th key={k}>{t(`rc.reg.${k}` as Key)}</th>)}</tr></thead>
              <tbody>{rows.map((x) => <tr key={x.booking}>{registrationFields.map((k) => <td key={k} className="ltr" data-label={t(`rc.reg.${k}` as Key)}>{String(x[k] ?? '')}</td>)}</tr>)}</tbody></table></div>
          ))}
        </div>
      )}
    </>
  );
}
