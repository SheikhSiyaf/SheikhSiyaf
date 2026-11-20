// Sales > ZATCA monitor. One place that says whether this company's ZATCA e-invoicing is healthy, what needs attention
// and what to do about it. It only reads what Nusuh Books has recorded and never contacts ZATCA, so opening it, or leaving
// it open, costs nothing and changes nothing. It refreshes itself every minute. The one thing it can do is the same
// "send now" that Sales > E-invoicing has; everything else points to the screen where the change is made.
import { useEffect, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from './common.tsx';

type State = 'off' | 'ok' | 'test' | 'attention' | 'critical';
interface Finding { code: string; severity: 'critical' | 'warning' | 'info'; params: Record<string, unknown>; action: 'connect' | 'renew' | 'send_now' | 'review_rejected' | 'none' }
interface Device { id: string; name: string; environment: string; status: string; certValidTo: string | null; certDaysLeft: number | null }
interface Row { id: string; number: string; docType: string; kind: string; httpStatus: number | null; attempts: number; createdAt: string; errors?: Array<{ code?: string; message?: string } | string> }
interface Monitor {
  state: State; findings: Finding[]; country: string; enabled: boolean; productionAllowed: boolean; devices: Device[];
  waiting: Record<'simplified' | 'standard', { count: number; oldestAt: string | null }>; waitingList: Row[]; rejected: Row[];
  sender: { lastFinishedAt: string | null; lastOk: boolean | null; lastError: string | null };
  lastSevenDays: { cleared: number; reported: number; lastAcceptedAt: string | null }; checkedAt: string;
}

const TONE: Record<State, string> = { off: '', ok: 'good', test: 'warn', attention: 'warn', critical: 'bad' };
const SEVERITY_CLASS = { critical: 'bad', warning: 'warn', info: '' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
const words = (x: NonNullable<Row['errors']>[number]) => (typeof x === 'string' ? x : [x.code, x.message].filter(Boolean).join(': '));

export function ZatcaMonitor({ books }: { books: CompanyBooks }) {
  const { t, has } = useI18n();
  const go = useGo(books.company.id);
  const m = useApi<Monitor>(`/api/companies/${books.company.id}/einvoicing/monitor`);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const { reload } = m;
  useEffect(() => { const i = setInterval(reload, 60_000); return () => clearInterval(i); }, [reload]);

  if (m.error) return <ErrorNote error={m.error} onRetry={m.reload} />;
  if (!m.data) return <Loading />;
  const d = m.data;
  const active = d.devices.find((x) => x.status === 'active');

  const text = (f: Finding) => {
    const p: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(f.params)) p[k] = typeof v === 'number' ? v : String(v ?? '');
    if (f.code === 'test_mode') p.environment = t(`einv.env.${String(f.params.environment)}` as Key);
    if (f.code === 'setup_unfinished') p.status = t(`einv.dev.${String(f.params.status)}` as Key);
    const key = f.code === 'sender_stalled' && f.params.never ? 'zmon.f.sender_never' : `zmon.f.${f.code}`;
    return t(key as Key, p);
  };
  const act = async (f: Finding) => {
    if (f.action === 'send_now') {
      setBusy(true); setMsg({});
      try { await api(`/api/companies/${books.company.id}/einvoices/send-pending`, { body: {} }); setMsg({ ok: t('zmon.sentNow') }); m.reload(); }
      catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
    } else if (f.action !== 'none') go('Sales', 'e-invoicing');
  };

  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('zmon.hint')}</div>
      <div className={`card ${d.state === 'critical' ? 'bad' : ''}`} id="zmon-state">
        <div className="actions">
          <h2 style={{ margin: 0 }}>{t('zmon.title')}</h2>
          <span className={`badge ${TONE[d.state]}`} id="zmon-badge">{t(`zmon.state.${d.state}` as Key)}</span>
          <span className="spacer" />
          <span className="mut small">{t('zmon.checked', { time: new Date(d.checkedAt).toLocaleTimeString() })}</span>
          <button className="b small" onClick={m.reload} disabled={m.loading}>{t('zmon.refresh')}</button>
        </div>
        <p style={{ margin: '8px 0 0' }}>{t(`zmon.say.${d.state}` as Key)}</p>
      </div>

      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}

      {d.findings.length > 0 && (
        <div className="card" id="zmon-findings">
          {d.findings.map((f) => (
            <div key={f.code} className={`notice ${SEVERITY_CLASS[f.severity]}`} data-code={f.code} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 280px' }}>{text(f)}</span>
              {f.action !== 'none' && (f.action !== 'send_now' || books.canPost) && (
                <button className={`b small ${f.severity === 'critical' ? 'p' : ''}`} disabled={busy} onClick={() => void act(f)}>{t(`zmon.act.${f.action}` as Key)}</button>
              )}
            </div>
          ))}
        </div>
      )}
      {d.state !== 'off' && d.findings.length === 0 && <div className="notice">{t('zmon.none')}</div>}

      {d.state !== 'off' && (
        <div className="grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', margin: '12px 0' }}>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('zmon.conn')}</h3>
            {active ? (
              <dl className="kv">
                <dt>{t('zmon.device')}</dt><dd>{active.name}</dd>
                <dt>{t('zmon.env')}</dt><dd><span className={`badge ${active.environment === 'production' ? 'good' : 'warn'}`}>{t(`einv.env.${active.environment}` as Key)}</span></dd>
                <dt>{t('zmon.cert')}</dt>
                <dd>{active.certDaysLeft == null ? '—' : active.certDaysLeft <= 0
                  ? t('zmon.certEnded', { date: (active.certValidTo ?? '').slice(0, 10) })
                  : t('zmon.certLeft', { days: active.certDaysLeft, date: (active.certValidTo ?? '').slice(0, 10) })}</dd>
              </dl>
            ) : <p className="mut">{t('zmon.noDevice')}</p>}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('zmon.queue')}</h3>
            <dl className="kv">
              <dt>{t('zmon.waitSimple')}</dt><dd id="zmon-wait-simplified">{d.waiting.simplified.count}</dd>
              <dt>{t('zmon.waitStd')}</dt><dd id="zmon-wait-standard">{d.waiting.standard.count}</dd>
              <dt>{t('zmon.rej')}</dt><dd id="zmon-rejected">{d.rejected.length}</dd>
              <dt>{t('zmon.week')}</dt><dd>{d.lastSevenDays.cleared + d.lastSevenDays.reported}</dd>
              <dt>{t('zmon.lastOk')}</dt><dd>{when(d.lastSevenDays.lastAcceptedAt) ?? t('zmon.never')}</dd>
            </dl>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('zmon.sender')}</h3>
            <dl className="kv">
              <dt>{t('zmon.senderLast')}</dt><dd>{when(d.sender.lastFinishedAt) ?? t('zmon.never')}</dd>
              <dt>&nbsp;</dt><dd>{d.sender.lastOk === null ? '—' : <span className={`badge ${d.sender.lastOk ? 'good' : 'bad'}`}>{d.sender.lastOk ? t('zmon.senderOk') : t('zmon.senderBad')}</span>}</dd>
            </dl>
            <p className="mut small">{t('zmon.senderHint')}</p>
          </div>
        </div>
      )}

      {d.rejected.length > 0 && <List title={t('zmon.rejectedTitle')} id="zmon-rejected-list" rows={d.rejected} showWords />}
      {d.waitingList.length > 0 && <List title={t('zmon.waitingTitle')} id="zmon-waiting-list" rows={d.waitingList} />}
    </>
  );
}

function List({ title, rows, id, showWords }: { title: string; rows: Row[]; id: string; showWords?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="card" id={id}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>{t('zmon.number')}</th><th>{t('zmon.kind')}</th><th>{t('zmon.attempts')}</th>{showWords ? <th>{t('zmon.words')}</th> : <th>{t('zmon.since')}</th>}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td data-label={t('zmon.number')}>{r.number}</td>
            <td data-label={t('zmon.kind')}>{r.kind}</td>
            <td data-label={t('zmon.attempts')}>{r.attempts}</td>
            <td data-label={showWords ? t('zmon.words') : t('zmon.since')} className={showWords ? 'ltr' : ''}>
              {showWords ? (r.errors?.length ? r.errors.map((x, i) => <div key={i}>{words(x)}</div>) : '—') : new Date(r.createdAt).toLocaleString()}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
