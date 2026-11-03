// Sales > E-invoicing. Saudi Arabia: the seller's national address, connecting a device to ZATCA (Fatoora) with
// the one-time password, and every invoice's e-invoice: cleared, reported, waiting or rejected. UAE: PINT AE XML
// prepared for the accredited service provider. The books team sets it up; everyone on the client can see it.
import { useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from './common.tsx';
import { moduleForType, pageForType } from '../books/nav.ts';

interface Settings { enabled: boolean; street: string | null; buildingNumber: string | null; district: string | null; postalCode: string | null;
  zeroReasonCode: string; zeroReason: string; exemptReasonCode: string; exemptReason: string; oosReason: string }
interface Check { type: string; outcome: string; warnings: string[]; errors: string[] }
interface Device { id: string; environment: string; name: string; branch: string; invoiceTypes: string; status: string; checks: Check[]; icv: number; certValidTo: string | null;
  createdAt: string; activatedAt: string | null; createdBy: string | null }
interface Overview { country: 'SA' | 'AE' | 'OM'; vatStatus: string; settings: Settings; devices: Device[]; counts: Record<string, number> }
export interface EInvoiceRow { id: string; documentId: string; docType: string; number: string; issueDate: string; total: string; customer: string | null; scheme: 'zatca' | 'pint_ae';
  kind: 'standard' | 'simplified'; icv: number | null; status: 'pending' | 'cleared' | 'reported' | 'rejected' | 'ready'; warnings: string[]; errors: string[]; attempts: number;
  submittedAt: string | null; printQr?: string | null }

export const STATUS_TONE: Record<string, string> = { cleared: 'good', reported: 'good', pending: 'warn', rejected: 'bad', ready: '' };

/** Saves an e-invoice's XML (the cleared one when ZATCA returned it). */
export async function downloadXml(id: string) {
  const f = await api<{ fileName: string; xml: string }>(`/api/einvoices/${id}/xml?json=1`);
  const url = URL.createObjectURL(new Blob([f.xml], { type: 'application/xml' }));
  const a = document.createElement('a'); a.href = url; a.download = f.fileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EInvoicing({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const o = useApi<Overview>(`/api/companies/${books.company.id}/einvoicing`);
  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  if (d.country === 'OM') return <div className="card"><h2>{t('einv.title')}</h2><p className="mut">{t('einv.omanLater')}</p></div>;
  if (d.vatStatus !== 'registered') return <div className="card"><h2>{t('einv.title')}</h2><p className="mut">{t('einv.notVat')}</p></div>;
  return d.country === 'AE' ? <Uae books={books} o={d} reload={o.reload} /> : <Saudi books={books} o={d} reload={o.reload} />;
}

function useRun(reload: () => void) {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string; details?: string[] }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); reload(); return true; } catch (e) { setMsg({ bad: errorText(t, has, e), details: (e as { details?: string[] }).details }); return false; } finally { setBusy(false); }
  };
  const notes = <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}
    {msg.details?.length ? <> ({msg.details.map((x) => (has(`einv.f.${x}`) ? t(`einv.f.${x}` as Key) : x)).join(', ')})</> : null}</div>}</>;
  return { run, busy, notes, setMsg };
}

// ------------------------------------------------------------------ Saudi Arabia (ZATCA)
function Saudi({ books, o, reload }: { books: CompanyBooks; o: Overview; reload: () => void }) {
  const { t } = useI18n();
  const active = o.devices.find((x) => x.status === 'active');
  const unfinished = o.devices.find((x) => ['compliance', 'checks_failed', 'checks_passed'].includes(x.status));
  const [setup, setSetup] = useState(!active);
  const { run, busy, notes } = useRun(reload);
  const tile = (k: string, tone = '') => <div className={`card fig ${o.counts[k] && tone ? tone : ''}`}><small>{t(`einv.s.${k}` as Key)}</small><b>{o.counts[k] ?? 0}</b><small>{t(`einv.sub.${k}` as Key)}</small></div>;
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('einv.hintSA')}</div>
      {active ? (
        <div className="card">
          <div className="actions"><h2 style={{ margin: 0 }}>{t('einv.connected')}</h2><span className={`badge ${active.environment === 'production' ? 'good' : 'warn'}`}>{t(`einv.env.${active.environment}` as Key)}</span>
            <span className="spacer" />{books.canPost && !setup && <button className="b small" onClick={() => setSetup(true)}>{t('einv.newDevice')}</button>}</div>
          <table className="mini"><tbody>
            <tr><td>{t('einv.device')}</td><td><b>{active.name}</b> · {active.branch}</td></tr>
            <tr><td>{t('einv.counter')}</td><td className="ltr">{active.icv}</td></tr>
            <tr><td>{t('einv.certUntil')}</td><td className="ltr">{active.certValidTo?.slice(0, 10) ?? '—'}</td></tr>
            <tr><td>{t('einv.since')}</td><td className="ltr">{active.activatedAt?.slice(0, 10)} · {active.createdBy}</td></tr>
          </tbody></table>
          {active.environment !== 'production' && <div className="notice warn small" style={{ marginTop: 8 }}>{t('einv.testOnly')}</div>}
        </div>
      ) : <div className="notice warn">{t('einv.notConnected')}</div>}
      {active && <div className="grid">{tile('pending', 'warn')}{tile('cleared')}{tile('reported')}{tile('rejected', 'over')}</div>}
      {notes}
      {setup && books.canPost && <SetupSaudi books={books} o={o} unfinished={unfinished} run={run} busy={busy} onDone={() => setSetup(false)} canCancel={Boolean(active)} />}
      {active && <EInvoiceList books={books} reload={reload} />}
    </>
  );
}

function SetupSaudi({ books, o, unfinished, run, busy, onDone, canCancel }: { books: CompanyBooks; o: Overview; unfinished?: Device; run: ReturnType<typeof useRun>['run']; busy: boolean;
  onDone: () => void; canCancel: boolean }) {
  const { t } = useI18n();
  const s = o.settings;
  const [addr, setAddr] = useState({ street: s.street ?? '', buildingNumber: s.buildingNumber ?? '', district: s.district ?? '', postalCode: s.postalCode ?? '' });
  const [reasons, setReasons] = useState({ zeroReasonCode: s.zeroReasonCode, zeroReason: s.zeroReason, exemptReasonCode: s.exemptReasonCode, exemptReason: s.exemptReason, oosReason: s.oosReason });
  const [more, setMore] = useState(false);
  const [conn, setConn] = useState({ environment: 'sandbox', name: '', branch: '', otp: '' });
  const [checks, setChecks] = useState<Check[] | null>(unfinished?.checks.length ? unfinished.checks : null);
  const addressDone = Boolean(s.street && s.buildingNumber && s.district && s.postalCode);
  const finish = async (id: string) => {
    const r = await api<{ status: string; checks: Check[] }>(`/api/einvoicing/devices/${id}/finish`, { body: {} });
    setChecks(r.checks);
    if (r.status === 'active') onDone();
    else throw Object.assign(new Error(t(r.status === 'checks_failed' ? 'einv.checksFailed' : 'einv.prodPending')), { key: r.status === 'checks_failed' ? 'einv.checksFailed' : 'einv.prodPending' });
  };
  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { const { id } = await api<{ id: string }>(`/api/companies/${books.company.id}/einvoicing/devices`, { body: conn }); await finish(id); }, t('einv.connectedNow'));
  };
  return (
    <>
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/einvoicing/settings`, { body: { ...s, ...addr, ...reasons } }), t('einv.saved')); }}>
        <h2>{t('einv.step1')}</h2>
        <div className="small mut" style={{ marginBottom: 8 }}>{t('einv.step1Hint')}</div>
        <div className="row">
          <label className="f" style={{ flex: '2 1 240px' }}>{t('einv.street')}<input id="einv-street" value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} /></label>
          <label className="f">{t('einv.building')}<input id="einv-building" dir="ltr" inputMode="numeric" maxLength={4} value={addr.buildingNumber} onChange={(e) => setAddr({ ...addr, buildingNumber: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        <div className="row">
          <label className="f">{t('einv.district')}<input id="einv-district" value={addr.district} onChange={(e) => setAddr({ ...addr, district: e.target.value })} /></label>
          <label className="f">{t('einv.city')}<input value={books.company.city ?? ''} disabled /></label>
          <label className="f">{t('einv.postal')}<input id="einv-postal" dir="ltr" inputMode="numeric" maxLength={5} value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        <button type="button" className="link small" onClick={() => setMore(!more)}>{t(more ? 'einv.lessReasons' : 'einv.moreReasons')}</button>
        {more && <div style={{ marginTop: 8 }}>
          <div className="small mut" style={{ marginBottom: 6 }}>{t('einv.reasonsHint')}</div>
          <div className="row">
            <label className="f">{t('einv.zeroCode')}<input dir="ltr" value={reasons.zeroReasonCode} onChange={(e) => setReasons({ ...reasons, zeroReasonCode: e.target.value })} /></label>
            <label className="f" style={{ flex: '2 1 240px' }}>{t('einv.zeroText')}<input value={reasons.zeroReason} onChange={(e) => setReasons({ ...reasons, zeroReason: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('einv.exemptCode')}<input dir="ltr" value={reasons.exemptReasonCode} onChange={(e) => setReasons({ ...reasons, exemptReasonCode: e.target.value })} /></label>
            <label className="f" style={{ flex: '2 1 240px' }}>{t('einv.exemptText')}<input value={reasons.exemptReason} onChange={(e) => setReasons({ ...reasons, exemptReason: e.target.value })} /></label>
          </div>
        </div>}
        <div className="actions" style={{ marginTop: 10 }}><button className="b p" id="einv-save-address" disabled={busy}>{t('save')}</button></div>
      </form>
      <form className={`card ${addressDone ? '' : 'mut'}`} onSubmit={connect}>
        <h2>{t('einv.step2')}</h2>
        <ol className="small" style={{ marginTop: 0 }}><li>{t('einv.step2a')}</li><li>{t('einv.step2b')}</li><li>{t('einv.step2c')}</li></ol>
        {!addressDone && <div className="notice small">{t('einv.addressFirst')}</div>}
        <fieldset disabled={!addressDone || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('einv.where')}<select id="einv-env" value={conn.environment} onChange={(e) => setConn({ ...conn, environment: e.target.value })}>
              {['sandbox', 'simulation', 'production'].map((x) => <option key={x} value={x}>{t(`einv.env.${x}` as Key)}</option>)}</select></label>
            <label className="f">{t('einv.deviceName')}<input id="einv-name" dir="ltr" placeholder={`EGS-${books.company.vatNumber ?? ''}`.slice(0, 30)} value={conn.name} onChange={(e) => setConn({ ...conn, name: e.target.value })} /></label>
            <label className="f">{t('einv.branch')}<input id="einv-branch" value={conn.branch} onChange={(e) => setConn({ ...conn, branch: e.target.value })} /></label>
          </div>
          <div className="small mut" style={{ marginBottom: 6 }}>{t(`einv.envHint.${conn.environment}` as Key)}</div>
          <div className="row">
            <label className="f">{t('einv.otp')}<input id="einv-otp" dir="ltr" inputMode="numeric" maxLength={6} placeholder="123456" value={conn.otp} onChange={(e) => setConn({ ...conn, otp: e.target.value.replace(/\D/g, '') })} /></label>
          </div>
          <div className="actions">
            <button className="b p" id="einv-connect" disabled={conn.otp.length !== 6}>{busy ? t('einv.connecting') : t('einv.connect')}</button>
            {unfinished && <button type="button" className="b" id="einv-finish" onClick={() => void run(() => finish(unfinished.id), t('einv.connectedNow'))}>{t('einv.finish')}</button>}
            {canCancel && <button type="button" className="b" onClick={onDone}>{t('cancel')}</button>}
          </div>
        </fieldset>
        {checks && <table className="mini" style={{ marginTop: 10 }}><tbody>{checks.map((c) => (
          <tr key={c.type}><td>{t(`einv.check.${c.type.replace(':', '.')}` as Key)}</td>
            <td><span className={`badge ${c.outcome === 'accepted' ? 'good' : 'bad'}`}>{t(`einv.outcome.${c.outcome}` as Key)}</span></td>
            <td className="small mut">{[...c.errors, ...c.warnings].join('; ')}</td></tr>))}</tbody></table>}
      </form>
    </>
  );
}

// ------------------------------------------------------------------ the list
function EInvoiceList({ books, reload }: { books: CompanyBooks; reload: () => void }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState('');
  const list = useApi<EInvoiceRow[]>(`/api/companies/${books.company.id}/einvoices${status ? `?status=${status}` : ''}`);
  const { run, busy, notes } = useRun(() => { list.reload(); reload(); });
  const pending = (list.data ?? []).filter((x) => x.status === 'pending').length;
  return (
    <div className="card">
      <div className="actions" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('einv.list')}</h2><span className="spacer" />
        <select aria-label={t('einv.filter')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('einv.all')}</option>{['pending', 'cleared', 'reported', 'rejected', 'ready'].map((s) => <option key={s} value={s}>{t(`einv.s.${s}` as Key)}</option>)}</select>
        {books.canPost && pending > 0 && <button className="b p" id="einv-send-pending" disabled={busy}
          onClick={() => void run(() => api(`/api/companies/${books.company.id}/einvoices/send-pending`, { body: {} }), t('einv.sentPending'))}>{t('einv.sendPending', { n: pending })}</button>}
      </div>
      {notes}
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('einv.none')}</div> : (
        <div className="wrap"><table className="stack"><thead><tr><th>{t('einv.invoice')}</th><th>{t('einv.kind')}</th><th className="num">{t('einv.total')}</th><th>{t('einv.status')}</th><th /></tr></thead>
          <tbody>{list.data.map((x) => (
            <tr key={x.id}>
              <td><button className="link" onClick={() => go(moduleForType(x.docType), pageForType(x.docType), x.documentId)}><b>{x.number}</b></button>
                <div className="small mut">{x.customer ?? ''} · {x.issueDate}{x.icv ? ` · ICV ${x.icv}` : ''}</div></td>
              <td data-label={t('einv.kind')}>{x.scheme === 'pint_ae' ? 'PINT AE' : t(`einv.k.${x.kind}` as Key)}{x.docType === 'credit_note' && <div className="small mut">{t('doc.title.credit_note')}</div>}</td>
              <td className="num" data-label={t('einv.total')}>{fmt(x.total)}</td>
              <td data-label={t('einv.status')}><span className={`badge ${STATUS_TONE[x.status]}`}>{t(`einv.s.${x.status}` as Key)}</span>
                {[...x.errors, ...x.warnings].length > 0 && <div className="small mut" style={{ maxWidth: 320 }}>{[...x.errors, ...x.warnings].join('; ')}</div>}</td>
              <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                {books.canPost && x.status === 'pending' && <button className="b small p" disabled={busy} onClick={() => void run(() => api(`/api/einvoices/${x.id}/submit`, { body: {} }))}>{t('einv.sendNow')}</button>}
                {books.canPost && x.status === 'rejected' && <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/documents/${x.documentId}/einvoice/again`, { body: {} }), t('einv.preparedAgain'))}>{t('einv.again')}</button>}
                <button className="link small" onClick={() => void downloadXml(x.id)}>XML</button>
              </span></td>
            </tr>
          ))}</tbody></table></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ UAE (PINT AE)
function Uae({ books, o, reload }: { books: CompanyBooks; o: Overview; reload: () => void }) {
  const { t } = useI18n();
  const { run, busy, notes } = useRun(reload);
  return (
    <>
      <div className="card">
        <h2>{t('einv.uaeTitle')}</h2>
        <p className="small">{t('einv.uaeHint')}</p>
        <ul className="small"><li>{t('einv.uaeDate1')}</li><li>{t('einv.uaeDate2')}</li></ul>
        <div className="notice warn small">{t('einv.uaeAsp')}</div>
        {notes}
        {books.canPost && <label className="check-one"><input type="checkbox" id="einv-uae-on" disabled={busy} checked={o.settings.enabled}
          onChange={(e) => void run(() => api(`/api/companies/${books.company.id}/einvoicing/settings`, { body: { ...o.settings, enabled: e.target.checked } }), t('einv.saved'))} />
          <span>{t('einv.uaeOn')}</span></label>}
        {!books.canPost && <div className="small">{t(o.settings.enabled ? 'einv.uaeIsOn' : 'einv.uaeIsOff')}</div>}
      </div>
      {o.settings.enabled && <EInvoiceList books={books} reload={reload} />}
    </>
  );
}

/** On an invoice or credit note: its e-invoice status, the XML, and sending or preparing it again. */
export function EInvoiceStatus({ books, documentId, onChange }: { books: CompanyBooks; documentId: string; onChange?: () => void }) {
  const { t, has } = useI18n();
  const rows = useApi<EInvoiceRow[]>(`/api/documents/${documentId}/einvoice`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const e = rows.data?.[0];
  if (!e) return null;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(undefined); try { await fn(); rows.reload(); onChange?.(); } catch (x) { setErr(errorText(t, has, x)); } finally { setBusy(false); } };
  return (
    <div className={`notice ${e.status === 'rejected' ? 'bad' : e.status === 'pending' ? 'warn' : ''} actions`} id="doc-einvoice">
      <span><b>{e.scheme === 'pint_ae' ? 'PINT AE' : 'ZATCA'}:</b> {t(`einv.s.${e.status}` as Key)}{e.scheme === 'zatca' && <> · {t(`einv.k.${e.kind}` as Key)}</>}
        {[...e.errors, ...e.warnings].length > 0 && <span className="small"> · {[...e.errors, ...e.warnings].join('; ')}</span>}</span>
      <span className="spacer" />
      {books.canPost && e.status === 'pending' && <button className="b small p" disabled={busy} onClick={() => void act(() => api(`/api/einvoices/${e.id}/submit`, { body: {} }))}>{t('einv.sendNow')}</button>}
      {books.canPost && e.status === 'rejected' && <button className="b small" disabled={busy} onClick={() => void act(() => api(`/api/documents/${documentId}/einvoice/again`, { body: {} }))}>{t('einv.again')}</button>}
      <button className="b small" onClick={() => void downloadXml(e.id)}>XML</button>
      {err && <span className="bad small">{err}</span>}
    </div>
  );
}
