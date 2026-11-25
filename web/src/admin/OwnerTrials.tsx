// Owner > Trials: every free trial with where it stands, who to write to, when somebody last signed in, the reminder e-mails, any
// order waiting for payment, and the owner's actions (extend, mark paid, close now, resend a reminder). Every action needs a
// reason and is recorded. "Mark paid" is only for after the money is seen in the bank (src/books/trialOrders.ts).
import { Fragment, useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { OPTIONAL } from '../trial/BuyPanel.tsx';

type Label = 'trialing' | 'ending_soon' | 'ended' | 'in_grace' | 'closed' | 'paid';
interface Setup { step: string; businessType: string | null; goals: string[]; dataChoice: string | null; skipped: boolean; completed: boolean; tourPages: number; extractUsed: number; companies: number; contacts: number; documents: number; people: number }
interface Row {
  source?: 'self' | 'owner'; flags?: string[];
  setup: Setup | null;
  firmId: string; firmName: string; label: Label; endsAt: string | null; daysLeft: number | null; companies: string[];
  adminName: string | null; adminEmail: string | null; lastLoginAt: string | null; emailsSent: number; emailsFailed: number; orderId: string | null; orderConfirmed: boolean;
}
interface Data { counters: { started: number; open: number; converted: number; ended: number; waitingOrders: number; emailFailures: number }; trials: Row[] }
interface Order { id: string; firm_id: string; modules: string[]; cleanup: boolean; payment_reference: string | null; payment_amount: string | null; proof_name: string | null; status: string }
type Filter = 'all' | 'open' | 'ending_soon' | 'in_grace' | 'closed' | 'paid' | 'orders';
const FILTERS: Filter[] = ['all', 'open', 'ending_soon', 'in_grace', 'closed', 'paid', 'orders'];
const when = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '');
const matches = (r: Row, f: Filter) => f === 'all' || (f === 'open' ? r.label === 'trialing' || r.label === 'ending_soon' : f === 'orders' ? r.orderId !== null && r.label !== 'paid' : r.label === f);

interface Ev { id: string; at: string; kind: string; emailDomain: string | null; company: string | null; country: string | null; flags: string[]; attempts: number }
/** Every sign-up try, allowed or refused, newest first (the owner's record of who tried to start a trial, and what stopped them). */
function SignupActivity() {
  const { t, has } = useI18n();
  const d = useApi<{ enabled: boolean; events: Ev[] }>('/api/owner/signups');
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <div className="card" id="owner-signups" style={{ marginTop: 12 }}>
      <h2>{t('sup2.title')}</h2>
      <p className="small mut">{t('sup2.hint')}</p>
      <p className={`notice${d.data.enabled ? '' : ' warn'}`} id="sup2-state">{t(d.data.enabled ? 'sup2.on' : 'sup2.off')}</p>
      {d.data.events.length === 0 ? <p className="small mut" id="sup2-none">{t('sup2.none')}</p> : (
        <div className="wrap"><table id="sup2-table">
          <thead><tr><th>{t('sup2.col.when')}</th><th>{t('sup2.col.what')}</th><th>{t('sup2.col.company')}</th><th>{t('sup2.col.mail')}</th><th>{t('sup2.col.flags')}</th></tr></thead>
          <tbody>{d.data.events.slice(0, 100).map((e) => (
            <tr key={e.id}>
              <td className="ltr small">{when(e.at)}</td>
              <td><span className={`badge ${e.kind === 'verified' ? 'good' : e.kind === 'started' ? '' : 'bad'}`}>{has(`sup2.k.${e.kind}`) ? t(`sup2.k.${e.kind}` as Key) : e.kind}</span></td>
              <td>{e.company}{e.country ? <span className="mut small"> · {e.country}</span> : null}</td>
              <td className="ltr small">{e.emailDomain}{e.attempts > 2 && <div className="mut">{t('sup2.attempts', { n: e.attempts })}</div>}</td>
              <td className="small">{e.flags.map((f) => <div key={f}>⚠ {has(`sup2.flag.${f}`) ? t(`sup2.flag.${f}` as Key) : f}</div>)}</td>
            </tr>))}</tbody>
        </table></div>)}
    </div>
  );
}

export function OwnerTrials() {
  const { t, has } = useI18n();
  const d = useApi<Data>('/api/owner/trials');
  const orders = useApi<{ orders: Order[] }>('/api/owner/trial-orders');
  const [filter, setFilter] = useState<Filter>('all');
  const [act, setAct] = useState<{ firmId: string; kind: 'extend' | 'paid' | 'cancel' | 'resend' }>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const rows = d.data.trials.filter((r) => matches(r, filter));
  const c = d.data.counters;
  const orderOf = (r: Row) => orders.data?.orders.find((o) => o.firm_id === r.firmId && o.status === 'waiting');
  const done = (ok: string) => { setMsg({ ok }); setAct(undefined); d.reload(); orders.reload(); };
  const failed = (e: unknown) => setMsg({ bad: errorText(t, has, e) });
  const stat = (id: string, n: number, k: Key) => <div className="stat" id={`tr-c-${id}`}><b>{n}</b><span>{t(k)}</span></div>;
  return (
    <div className="card" id="owner-trials">
      <h2>{t('trials.title')}</h2>
      <p className="small mut">{t('trials.hint')}</p>
      <div className="stats">
        {stat('started', c.started, 'trials.c.started')}{stat('open', c.open, 'trials.c.open')}{stat('converted', c.converted, 'trials.c.converted')}
        {stat('ended', c.ended, 'trials.c.ended')}{stat('orders', c.waitingOrders, 'trials.c.orders')}{stat('failures', c.emailFailures, 'trials.c.failures')}
      </div>
      <div className="chips" role="group">{FILTERS.map((f) => <button key={f} id={`tr-f-${f}`} className={`chip${f === filter ? ' on' : ''}`} aria-pressed={f === filter} onClick={() => setFilter(f)}>{t(`trials.f.${f}` as Key)}</button>)}</div>
      {msg.ok && <div className="notice" id="tr-msg">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" id="tr-error">{msg.bad}</div>}
      {rows.length === 0 ? <p className="small mut" id="tr-none">{t('trials.none')}</p> : (
        <div className="wrap"><table id="tr-table">
          <thead><tr><th>{t('trials.col.customer')}</th><th>{t('trials.col.status')}</th><th>{t('trials.col.ends')}</th><th>{t('trials.col.admin')}</th>
            <th>{t('trials.col.login')}</th><th>{t('trials.col.setup')}</th><th>{t('trials.col.mails')}</th><th>{t('trials.col.order')}</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const o = orderOf(r);
            return (
              <Fragment key={r.firmId}><tr id={`tr-row-${r.firmId}`}>
                <td><b>{r.firmName}</b>{r.source === 'self' && <span className="badge" style={{ marginInlineStart: 6 }}>{t('trials.self')}</span>}<div className="small mut">{r.companies.join(', ')}</div>{(r.flags ?? []).map((f) => <div key={f} className="small">⚠ {has(`sup2.flag.${f}`) ? t(`sup2.flag.${f}` as Key) : f}</div>)}</td>
                <td><span className={`badge ${r.label === 'paid' ? 'good' : r.label === 'ending_soon' ? 'warn' : r.label === 'trialing' ? '' : 'bad'}`}>{t(`trials.s.${r.label === 'ended' ? 'in_grace' : r.label}` as Key)}</span>{r.daysLeft !== null && <div className="small mut">{t('trials.daysLeft', { n: r.daysLeft })}</div>}</td>
                <td className="ltr">{when(r.endsAt)}</td>
                <td>{r.adminName}<div className="small mut ltr">{r.adminEmail}</div></td>
                <td className="ltr">{r.lastLoginAt ? when(r.lastLoginAt) : t('trials.never')}</td>
                <td className="small" id={`tr-setup-${r.firmId}`}>{r.setup ? <>
                  <b>{r.setup.completed ? t('trials.setup.done') : r.setup.skipped ? t('trials.setup.skipped') : t('trials.setup.at', { step: t(`wiz.s.${r.setup.step}` as Key) })}</b>
                  {r.setup.businessType && <div>{t('trials.setup.type', { type: t(`wiz.type.${r.setup.businessType}` as Key) })}</div>}
                  {r.setup.goals.length > 0 && <div>{t('trials.setup.goals', { goals: r.setup.goals.map((g) => (has(`wiz.goal.${g}`) ? t(`wiz.goal.${g}` as Key) : g)).join(', ') })}</div>}
                  <div className="mut">{t('trials.setup.counts', { companies: r.setup.companies, contacts: r.setup.contacts, documents: r.setup.documents, people: r.setup.people, pages: r.setup.tourPages })}</div></> : <span className="mut">{t('trials.setup.none')}</span>}</td>
                <td className="small">{t('trials.mails', { sent: r.emailsSent, failed: r.emailsFailed })}</td>
                <td>{r.orderId ? (r.orderConfirmed ? <b>{t('trials.order.confirmed')}</b> : t('trials.order.waiting')) : <span className="mut">{t('trials.order.none')}</span>}
                  {o?.proof_name && <div><a href={`/api/owner/trial-orders/${o.id}/proof`} download id={`tr-proof-${r.firmId}`}>{t('trials.proof')}</a></div>}</td>
                <td className="row-actions">
                  {r.label !== 'paid' && (['extend', 'paid', 'cancel', 'resend'] as const).map((k) => (
                    <button key={k} className="b small" id={`tr-${k}-${r.firmId}`} onClick={() => { setMsg({}); setAct({ firmId: r.firmId, kind: k }); }}>{t(`trials.act.${k}` as Key)}</button>))}
                </td></tr>
              {act?.firmId === r.firmId && <tr><td colSpan={9}><Action kind={act.kind} row={r} order={o} onDone={done} onError={failed} onCancel={() => setAct(undefined)} /></td></tr>}</Fragment>
            );
          })}</tbody>
        </table></div>)}
      <SignupActivity />
    </div>
  );
}

function Action({ kind, row, order, onDone, onError, onCancel }: { kind: 'extend' | 'paid' | 'cancel' | 'resend'; row: Row; order?: Order; onDone: (m: string) => void; onError: (e: unknown) => void; onCancel: () => void }) {
  const { t, has } = useI18n();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');
  const [ref, setRef] = useState(order?.payment_reference ?? '');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [mods, setMods] = useState<string[]>(order?.modules ?? []);
  const [cleanup, setCleanup] = useState(order?.cleanup ?? false);
  const [busy, setBusy] = useState(false);
  const base = `/api/owner/tenants/${row.firmId}/trial`;
  const go = async () => {
    setBusy(true);
    try {
      if (kind === 'extend') { await api(`${base}/extend`, { body: { days: Number(days), reason } }); onDone(t('trials.done.extend')); }
      else if (kind === 'cancel') { await api(`${base}/cancel`, { body: { reason } }); onDone(t('trials.done.cancel')); }
      else if (kind === 'resend') { const r = await api<{ template: string; to: string }>(`${base}/resend`, { body: { reason } }); onDone(t('trials.done.resend', { template: r.template, to: r.to })); }
      else {
        const r = await api<{ invoice: { number: string; total: string; currency: string }; differs: boolean; customerWasTold: string }>(`${base}/mark-paid`, { body: { modules: mods, cleanup, reference: ref, paidOn, reason } });
        const fmt = (v: string) => `${r.invoice.currency} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
        onDone(t('trials.done.paid', { number: r.invoice.number, total: fmt(r.invoice.total) }) + (r.differs ? ` ${t('trials.done.differs', { told: fmt(r.customerWasTold) })}` : ''));
      }
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const hint = kind === 'paid' ? 'trials.act.paid.hint' : kind === 'cancel' ? 'trials.act.cancel.hint' : kind === 'resend' ? 'trials.act.resend.hint' : null;
  return (
    <div className="tr-act" id="tr-action">
      {hint && <p className="small mut">{t(hint as Key)}</p>}
      {kind === 'extend' && <label className="f">{t('trials.act.days')}<input id="tr-days" inputMode="numeric" dir="ltr" value={days} onChange={(e) => setDays(e.target.value)} /></label>}
      {kind === 'paid' && (<>
        <div className="buy-mods">{OPTIONAL.map((m) => <label key={m} className="check"><input type="checkbox" id={`tr-mod-${m}`} checked={mods.includes(m)} onChange={() => setMods(mods.includes(m) ? mods.filter((x) => x !== m) : [...mods, m])} />{has(`mod.${m}`) ? t(`mod.${m}` as Key) : m}</label>)}</div>
        <label className="check"><input type="checkbox" id="tr-cleanup" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />{t('trials.act.paid.cleanup')}</label>
        <div className="row">
          <label className="f">{t('trials.act.paid.ref')}<input id="tr-ref" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} /></label>
          <label className="f">{t('trials.act.paid.on')}<input id="tr-paid-on" type="date" dir="ltr" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
        </div></>)}
      <label className="f">{t('trials.act.reason')}<input id="tr-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="actions">
        <button className="b p" id="tr-go" disabled={busy || !reason.trim()} onClick={() => void go()}>{t('trials.act.go')}</button>
        <button className="b" id="tr-cancel" disabled={busy} onClick={onCancel}>{t('trials.act.cancelBtn')}</button>
      </div>
    </div>
  );
}
