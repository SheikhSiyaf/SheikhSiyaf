// Billing and subscriptions. The owner: each customer's plan and invoices, the plans on sale, the seller's details and
// a billing run. A customer's Administrator: its plan, usage against what is included, the next bill and its invoices.
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt, fromMinor, toMinor } from '../money.ts';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, TopControls, errorText } from '../ui.tsx';

export interface Plan { id: string; code: string; name: string; nameAr: string | null; forKind: 'firm' | 'company' | 'any'; monthlyPrice: string; yearlyPrice: string;
  includedCompanies: number; includedUsers: number; extraCompanyPrice: string; extraUserPrice: string; trialDays: number; active: boolean; customers?: number }
interface Sub { id: string; planId: string; planName: string; cycle: 'monthly' | 'yearly'; status: 'trial' | 'active' | 'past_due' | 'cancelled'; startedOn: string;
  trialEnds: string | null; nextBillOn: string; discountPct: string; cancelAtPeriodEnd: boolean; notes: string | null; includedCompanies: number; includedUsers: number; price?: string }
interface Customer { firmId: string; name: string; kind: 'firm' | 'company'; tenantStatus: string; companies: number; users: number; subscription: Sub | null; owed: string; overdue: string }
interface Line { key: 'plan' | 'extraCompanies' | 'extraUsers'; name?: string; quantity: number; months?: number; unitPrice: number | string; amount: number | string }
export interface BillInvoice { id: string; firmId: string; customer: string; number: string; planName: string; cycle: string; periodStart: string; periodEnd: string;
  issuedOn: string; dueOn: string; currency: string; lines: Line[]; subtotal: string; discount: string; vatRate: string; vat: string; total: string;
  status: 'open' | 'overdue' | 'paid' | 'void'; paidOn: string | null; paidRef: string | null; voidReason: string | null }
interface Settings { sellerName: string; sellerVat: string | null; sellerAddress: string | null; currency: string; vatRate: string; termsDays: number }
interface Quote { lines: Line[]; subtotal: number; discount: number; vat: number; total: number; currency: string; periodStart: string; periodEnd: string }

const today = () => new Date().toISOString().slice(0, 10);
const money = (x: number | string | null | undefined) => fmt(x === null || x === undefined ? '' : String(x));
const STATUS_BADGE: Record<string, string> = { trial: '', active: 'good', past_due: 'bad', cancelled: '', open: '', overdue: 'bad', paid: 'good', void: '' };

function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); after?.(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const note = <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</>;
  return { run, busy, note };
}

export function lineText(t: (k: Key, v?: Record<string, string | number>) => string, l: Line, cycle: string) {
  if (l.key === 'plan') return t(cycle === 'yearly' ? 'bill.linePlanYear' : 'bill.linePlanMonth', { plan: l.name ?? '' });
  return t(l.key === 'extraCompanies' ? 'bill.lineExtraCompanies' : 'bill.lineExtraUsers', { n: l.quantity, months: l.months ?? 1 });
}

// ------------------------------------------------------------------ Owner: customers' subscriptions and invoices
export function OwnerBilling() {
  const { t } = useI18n();
  const data = useApi<{ customers: Customer[]; plans: Plan[]; settings: Settings }>('/api/owner/billing');
  const inv = useApi<BillInvoice[]>('/api/owner/billing/invoices');
  const { run, busy, note } = useRun();
  const [edit, setEdit] = useState<{ firmId: string; kind: string; planId: string; cycle: 'monthly' | 'yearly'; startOn: string; trial: boolean; discountPct: string; notes: string; isNew: boolean }>();
  const [pay, setPay] = useState<{ id: string; paidOn: string; reference: string }>();
  const [voiding, setVoiding] = useState<{ id: string; reason: string }>();
  const [filter, setFilter] = useState<'unpaid' | 'all'>('unpaid');
  const reload = () => { data.reload(); inv.reload(); };
  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const { customers, plans, settings } = data.data;
  const cur = settings.currency;
  const sum = (xs: string[]) => xs.reduce((a, x) => a + toMinor(x), 0n);
  const owedMinor = sum(customers.map((c) => c.owed)), overdueMinor = sum(customers.map((c) => c.overdue));
  // Monthly recurring revenue: a yearly price counts as a twelfth.
  const mrr = customers.filter((c) => c.subscription && ['active', 'past_due'].includes(c.subscription.status))
    .reduce((a, c) => a + (c.subscription!.cycle === 'yearly' ? toMinor(c.subscription!.price!) / 12n : toMinor(c.subscription!.price!)), 0n);
  const minor = (n: bigint) => fmt(fromMinor(n));
  const rows = (inv.data ?? []).filter((x) => filter === 'all' || x.status === 'open' || x.status === 'overdue');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const x = edit!;
    void run(() => api(`/api/owner/tenants/${x.firmId}/subscription`, { body: { planId: x.planId, cycle: x.cycle, startOn: x.startOn, trial: x.trial, discountPct: x.discountPct, notes: x.notes } }),
      t('bill.subSaved'), () => { setEdit(undefined); reload(); });
  };
  return (
    <>
      <div className="grid">
        <div className="card fig"><small>{t('bill.mrr')}</small><b>{cur} {minor(mrr)}</b><small>{t('bill.mrrSub')}</small></div>
        <div className="card fig"><small>{t('bill.owed')}</small><b>{cur} {minor(owedMinor)}</b><small>{t('bill.owedSub')}</small></div>
        <div className="card fig"><small>{t('bill.overdue')}</small><b className={overdueMinor > 0n ? 'bad' : ''}>{cur} {minor(overdueMinor)}</b>
          <small>{t('bill.pastDueN', { n: customers.filter((c) => c.subscription?.status === 'past_due').length })}</small></div>
      </div>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('bill.hint')}</div>
      {note}
      <div className="actions" style={{ marginBottom: 10 }}>
        <span className="spacer" />
        <button className="b" id="bill-run" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ made: number }>('/api/owner/billing/run', { body: { day: today() } });
          reload(); return r;
        }, t('bill.runDone'))}>{t('bill.runNow')}</button>
      </div>
      {edit && (
        <form className="card inset" onSubmit={save}>
          <h2>{t(edit.isNew ? 'bill.startSub' : 'bill.changeSub')} · {customers.find((c) => c.firmId === edit.firmId)?.name}</h2>
          <div className="row">
            <label className="f">{t('bill.plan')}
              <select id="bill-plan" value={edit.planId} onChange={(e) => setEdit({ ...edit, planId: e.target.value })}>
                <option value="">{t('bill.pickPlan')}</option>
                {plans.filter((p) => p.active && (p.forKind === 'any' || p.forKind === edit.kind)).map((p) =>
                  <option key={p.id} value={p.id}>{p.name} · {cur} {fmt(p.monthlyPrice)} / {t('bill.month')} · {cur} {fmt(p.yearlyPrice)} / {t('bill.year')}</option>)}
              </select></label>
            <div className="f">{t('bill.cycle')}
              <div className="seg" role="radiogroup">
                {(['monthly', 'yearly'] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={edit.cycle === c} id={`bill-cycle-${c}`}
                  className={edit.cycle === c ? 'on' : ''} onClick={() => setEdit({ ...edit, cycle: c })}>{t(`bill.cycle.${c}`)}</button>)}
              </div></div>
          </div>
          <div className="row">
            {edit.isNew && <label className="f">{t('bill.startOn')}<input id="bill-start" type="date" value={edit.startOn} onChange={(e) => setEdit({ ...edit, startOn: e.target.value })} /></label>}
            <label className="f">{t('bill.discount')}<input id="bill-discount" inputMode="decimal" value={edit.discountPct} onChange={(e) => setEdit({ ...edit, discountPct: e.target.value })} /></label>
          </div>
          {edit.isNew && <label className="check"><input type="checkbox" id="bill-trial" checked={edit.trial} onChange={(e) => setEdit({ ...edit, trial: e.target.checked })} />
            {t('bill.trial', { n: plans.find((p) => p.id === edit.planId)?.trialDays ?? 14 })}</label>}
          <label className="f">{t('bill.notes')}<input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          <div className="small mut" style={{ marginBottom: 8 }}>{t(edit.isNew ? 'bill.startHint' : 'bill.changeHint')}</div>
          <div className="actions"><button className="b p" id="bill-save" disabled={busy || !edit.planId}>{t('save')}</button><button type="button" className="b" onClick={() => setEdit(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        <h2>{t('bill.subscriptions')}</h2>
        {customers.length === 0 ? <div className="mut">{t('own.none')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('own.customer')}</th><th>{t('bill.plan')}</th><th>{t('bill.status')}</th><th className="num">{t('bill.usage')}</th><th>{t('bill.nextBill')}</th><th className="num">{t('bill.owedCol')}</th><th /></tr></thead>
            <tbody>{customers.map((c) => {
              const s = c.subscription;
              const over = s && (c.companies > s.includedCompanies || c.users > s.includedUsers);
              return (
                <tr key={c.firmId}>
                  <td><b>{c.name}</b><div className="small mut">{t(`own.kind.${c.kind}`)}{c.tenantStatus === 'suspended' && <> · {t('admin.suspended')}</>}</div></td>
                  <td data-label={t('bill.plan')}>{s ? <>{s.planName}<div className="small mut">{t(`bill.cycle.${s.cycle}`)}{Number(s.discountPct) > 0 && <> · {t('bill.discountN', { n: String(Number(s.discountPct)) })}</>}</div></> : <span className="mut">{t('bill.noPlan')}</span>}</td>
                  <td data-label={t('bill.status')}>{s && <span className={`badge ${STATUS_BADGE[s.status]}`}>{t(`bill.st.${s.status}`)}</span>}
                    {s?.cancelAtPeriodEnd && s.status !== 'cancelled' && <div className="small mut">{t('bill.endsOn', { date: s.nextBillOn })}</div>}
                    {s?.status === 'trial' && <div className="small mut">{t('bill.trialEnds', { date: s.trialEnds ?? '' })}</div>}</td>
                  <td className="num" data-label={t('bill.usage')}><span className={over ? 'bad' : ''}>{s ? t('bill.usageOf', { c: c.companies, ci: s.includedCompanies, u: c.users, ui: s.includedUsers }) : t('bill.usageNo', { c: c.companies, u: c.users })}</span></td>
                  <td className="ltr" data-label={t('bill.nextBill')}>{s && s.status !== 'cancelled' && !s.cancelAtPeriodEnd ? s.nextBillOn : '—'}</td>
                  <td className="num" data-label={t('bill.owedCol')}>{Number(c.owed) > 0 ? <span className={Number(c.overdue) > 0 ? 'bad' : ''}>{fmt(c.owed)}</span> : '—'}</td>
                  <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                    {(!s || s.status === 'cancelled')
                      ? <button className="b small p" id={`bill-start-${c.firmId}`} onClick={() => setEdit({ firmId: c.firmId, kind: c.kind, planId: '', cycle: 'monthly', startOn: today().slice(8) > '28' ? today().slice(0, 8) + '28' : today(), trial: true, discountPct: '0', notes: '', isNew: true })}>{t('bill.startSub')}</button>
                      : <>
                        <button className="b small" onClick={() => setEdit({ firmId: c.firmId, kind: c.kind, planId: s.planId, cycle: s.cycle, startOn: s.startedOn, trial: false, discountPct: s.discountPct, notes: s.notes ?? '', isNew: false })}>{t('bill.changeSub')}</button>
                        <button className="b small" onClick={() => void run(() => api(`/api/owner/tenants/${c.firmId}/subscription/cancel`, { body: { cancel: !s.cancelAtPeriodEnd } }), undefined, reload)}>
                          {s.cancelAtPeriodEnd ? t('bill.keep') : t('bill.cancelSub')}</button>
                      </>}
                  </span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('bill.invoices')}</h2><span className="spacer" />
          <div className="seg" role="radiogroup">{(['unpaid', 'all'] as const).map((k) => <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{t(`bill.filter.${k}`)}</button>)}</div>
        </div>
        {inv.error && <ErrorNote error={inv.error} onRetry={inv.reload} />}
        {!inv.data ? <Loading /> : rows.length === 0 ? <div className="mut" style={{ marginTop: 8 }}>{t(filter === 'unpaid' ? 'bill.noneUnpaid' : 'bill.none')}</div> : (
          <InvoiceTable rows={rows} showCustomer actions={(x) => (x.status === 'open' || x.status === 'overdue') && (
            pay?.id === x.id ? (
              <form className="actions" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/owner/billing/invoices/${x.id}/paid`, { body: pay }), t('bill.paidDone'), () => { setPay(undefined); reload(); }); }}>
                <input type="date" aria-label={t('bill.paidOn')} value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
                <input aria-label={t('bill.paidRef')} placeholder={t('bill.paidRef')} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                <button className="b small p" id="bill-paid-save" disabled={busy}>{t('bill.markPaid')}</button>
                <button type="button" className="b small" onClick={() => setPay(undefined)}>{t('cancel')}</button>
              </form>
            ) : voiding?.id === x.id ? (
              <form className="actions" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/owner/billing/invoices/${x.id}/void`, { body: { reason: voiding.reason } }), t('bill.voidDone'), () => { setVoiding(undefined); reload(); }); }}>
                <input aria-label={t('bill.voidReason')} placeholder={t('bill.voidReason')} value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
                <button className="b small" disabled={busy || !voiding.reason.trim()}>{t('bill.void')}</button>
                <button type="button" className="b small" onClick={() => setVoiding(undefined)}>{t('cancel')}</button>
              </form>
            ) : <>
              <button className="b small p" id={`bill-pay-${x.number}`} onClick={() => setPay({ id: x.id, paidOn: today(), reference: '' })}>{t('bill.markPaid')}</button>
              <button className="b small" onClick={() => setVoiding({ id: x.id, reason: '' })}>{t('bill.void')}</button>
            </>)} open={(x) => navigate(`/owner/billing/${x.id}`)} />
        )}
      </div>
      <SellerSettings s={settings} onSaved={data.reload} />
    </>
  );
}

function InvoiceTable({ rows, showCustomer, actions, open }: { rows: BillInvoice[]; showCustomer?: boolean; actions?: (x: BillInvoice) => React.ReactNode; open: (x: BillInvoice) => void }) {
  const { t } = useI18n();
  return (
    <div className="wrap"><table className="stack">
      <thead><tr><th>{t('bill.number')}</th>{showCustomer && <th>{t('own.customer')}</th>}<th>{t('bill.period')}</th><th>{t('bill.dueOn')}</th><th className="num">{t('bill.total')}</th><th>{t('bill.status')}</th><th /></tr></thead>
      <tbody>{rows.map((x) => (
        <tr key={x.id} className={x.status === 'void' ? 'mut' : ''}>
          <td><a href="#" className="ltr" onClick={(e) => { e.preventDefault(); open(x); }}>{x.number}</a><div className="small mut">{x.planName}</div></td>
          {showCustomer && <td data-label={t('own.customer')}>{x.customer}</td>}
          <td className="ltr small" data-label={t('bill.period')}>{x.periodStart} → {x.periodEnd}</td>
          <td className="ltr" data-label={t('bill.dueOn')}>{x.dueOn}</td>
          <td className="num" data-label={t('bill.total')}>{x.currency} {fmt(x.total)}</td>
          <td data-label={t('bill.status')}><span className={`badge ${STATUS_BADGE[x.status]}`}>{t(`bill.st.${x.status}`)}</span>
            {x.paidOn && <div className="small mut ltr">{x.paidOn}{x.paidRef ? ` · ${x.paidRef}` : ''}</div>}{x.voidReason && <div className="small mut">{x.voidReason}</div>}</td>
          <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>{actions?.(x)}</span></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function SellerSettings({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const { t } = useI18n();
  const { run, busy, note } = useRun();
  const [f, setF] = useState<Settings>();
  if (!f) return <div className="actions"><span className="spacer" /><button className="b small" id="bill-settings" onClick={() => setF({ ...s, sellerVat: s.sellerVat ?? '', sellerAddress: s.sellerAddress ?? '', vatRate: String(Number(s.vatRate)) })}>{t('bill.settings')}</button></div>;
  return (
    <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(() => api('/api/owner/billing/settings', { body: { ...f, termsDays: Number(f.termsDays) } }), t('admin.saved'), () => { setF(undefined); onSaved(); }); }}>
      <h2>{t('bill.settings')}</h2>
      {note}
      <div className="row">
        <label className="f">{t('bill.sellerName')}<input value={f.sellerName} onChange={(e) => setF({ ...f, sellerName: e.target.value })} /></label>
        <label className="f">{t('bill.sellerVat')}<input dir="ltr" value={f.sellerVat ?? ''} onChange={(e) => setF({ ...f, sellerVat: e.target.value })} /></label>
      </div>
      <label className="f">{t('bill.sellerAddress')}<input value={f.sellerAddress ?? ''} onChange={(e) => setF({ ...f, sellerAddress: e.target.value })} /></label>
      <div className="row">
        <label className="f">{t('bill.currency')}<select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['SAR', 'AED', 'OMR', 'USD'].map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="f">{t('bill.vatRate')}<input inputMode="decimal" value={f.vatRate} onChange={(e) => setF({ ...f, vatRate: e.target.value })} /></label>
        <label className="f">{t('bill.termsDays')}<input inputMode="numeric" value={String(f.termsDays)} onChange={(e) => setF({ ...f, termsDays: Number(e.target.value.replace(/\D/g, '')) })} /></label>
      </div>
      <div className="actions"><button className="b p" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ Owner: plans
const EMPTY_PLAN: Omit<Plan, 'id'> = { code: '', name: '', nameAr: '', forKind: 'company', monthlyPrice: '', yearlyPrice: '', includedCompanies: 1, includedUsers: 3,
  extraCompanyPrice: '0', extraUserPrice: '0', trialDays: 14, active: true };
export function OwnerPlans() {
  const { t, lang } = useI18n();
  const list = useApi<Plan[]>('/api/owner/plans');
  const settings = useApi<{ settings: Settings }>('/api/owner/billing');
  const { run, busy, note } = useRun();
  const [f, setF] = useState<Omit<Plan, 'id'> & { id?: string }>();
  const cur = settings.data?.settings.currency ?? 'SAR';
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const num = (k: 'includedCompanies' | 'includedUsers' | 'trialDays') => (
    <input inputMode="numeric" id={`plan-${k}`} value={String(f![k])} onChange={(e) => setF({ ...f!, [k]: Number(e.target.value.replace(/\D/g, '') || 0) })} />);
  const amt = (k: 'monthlyPrice' | 'yearlyPrice' | 'extraCompanyPrice' | 'extraUserPrice') => (
    <input inputMode="decimal" id={`plan-${k}`} value={f![k]} onChange={(e) => setF({ ...f!, [k]: e.target.value })} />);
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('plan.hint')}</div>
      {note}
      <div className="actions" style={{ marginBottom: 10 }}><span className="spacer" />
        {!f && <button className="b p" id="plan-new" onClick={() => setF({ ...EMPTY_PLAN })}>{t('plan.new')}</button>}</div>
      {f && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); const { id, customers: _c, ...body } = f as Plan; void run(() => api(id ? `/api/owner/plans/${id}` : '/api/owner/plans', { body }), t('admin.saved'), () => { setF(undefined); list.reload(); }); }}>
          <h2>{f.id ? f.name : t('plan.new')}</h2>
          <div className="row">
            <label className="f">{t('plan.name')}<input id="plan-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, code: f.id ? f.code : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) })} /></label>
            <label className="f">{t('plan.nameAr')}<input dir="rtl" value={f.nameAr ?? ''} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></label>
            <label className="f">{t('plan.code')}<input dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          </div>
          <div className="seg" role="radiogroup" style={{ marginBottom: 10 }}>
            {(['company', 'firm', 'any'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={f.forKind === k} className={f.forKind === k ? 'on' : ''} onClick={() => setF({ ...f, forKind: k })}>{t(`plan.for.${k}`)}</button>)}
          </div>
          <div className="row">
            <label className="f">{t('plan.monthly', { cur })}{amt('monthlyPrice')}</label>
            <label className="f">{t('plan.yearly', { cur })}{amt('yearlyPrice')}</label>
            <label className="f">{t('plan.trialDays')}{num('trialDays')}</label>
          </div>
          <div className="row">
            <label className="f">{t('plan.inclCompanies')}{num('includedCompanies')}</label>
            <label className="f">{t('plan.extraCompany', { cur })}{amt('extraCompanyPrice')}</label>
            <label className="f">{t('plan.inclUsers')}{num('includedUsers')}</label>
            <label className="f">{t('plan.extraUser', { cur })}{amt('extraUserPrice')}</label>
          </div>
          {f.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t('plan.onSale')}</label>}
          <div className="actions"><button className="b p" id="plan-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="grid">
        {list.data.map((p) => (
          <div key={p.id} className={`card ${p.active ? '' : 'mut'}`}>
            <div className="actions"><h2 style={{ margin: 0 }}>{lang === 'ar' && p.nameAr ? p.nameAr : p.name}</h2><span className="spacer" /><span className="badge">{t(`plan.for.${p.forKind}`)}</span></div>
            <div style={{ fontSize: 22, margin: '8px 0' }}><b>{cur} {fmt(p.monthlyPrice)}</b> <span className="small mut">/ {t('bill.month')}</span></div>
            <div className="small mut">{t('plan.orYearly', { amount: `${cur} ${fmt(p.yearlyPrice)}` })}</div>
            <ul className="small" style={{ paddingInlineStart: 18 }}>
              <li>{t('plan.inclCompaniesN', { n: p.includedCompanies })}{Number(p.extraCompanyPrice) > 0 && <> · {t('plan.extraEach', { amount: `${cur} ${fmt(p.extraCompanyPrice)}` })}</>}</li>
              <li>{t('plan.inclUsersN', { n: p.includedUsers })}{Number(p.extraUserPrice) > 0 && <> · {t('plan.extraEach', { amount: `${cur} ${fmt(p.extraUserPrice)}` })}</>}</li>
              <li>{t('plan.trialN', { n: p.trialDays })}</li>
            </ul>
            <div className="actions"><span className="small mut">{t('plan.customersN', { n: p.customers ?? 0 })}{!p.active && <> · {t('plan.notOnSale')}</>}</span><span className="spacer" />
              <button className="b small" onClick={() => setF({ ...p, nameAr: p.nameAr ?? '' })}>{t('bill.edit')}</button></div>
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ The customer's Administrator
export function AdminBilling() {
  const { t } = useI18n();
  const d = useApi<{ subscription: (Sub & { extraCompanyPrice: string; extraUserPrice: string }) | null; usage: { companies: number; users: number }; next: Quote | null; invoices: BillInvoice[]; seller: Settings }>('/api/admin/billing');
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { subscription: s, usage, next, invoices, seller } = d.data;
  const unpaid = invoices.filter((x) => x.status === 'open' || x.status === 'overdue');
  const meter = (used: number, incl: number, label: string, extra: string) => (
    <div className="card fig"><small>{label}</small><b className={used > incl ? 'bad' : ''}>{used} / {incl}</b>
      <div className="meter" aria-hidden><span style={{ width: `${Math.min(100, incl ? (used / incl) * 100 : 100)}%` }} /></div>
      <small>{used > incl ? t('bill.overBy', { n: used - incl, amount: `${seller.currency} ${fmt(extra)}` }) : t('bill.leftN', { n: incl - used })}</small></div>
  );
  return (
    <>
      {!s ? <div className="card"><div className="mut">{t('bill.adminNoPlan')}</div></div> : <>
        {s.status === 'past_due' && <div className="notice bad" role="alert">{t('bill.adminPastDue')}</div>}
        {s.status === 'trial' && <div className="notice">{t('bill.adminTrial', { date: s.trialEnds ?? '' })}</div>}
        <div className="grid">
          <div className="card fig"><small>{t('bill.plan')}</small><b>{s.planName}</b><small>{t(`bill.cycle.${s.cycle}`)} · <span className={`badge ${STATUS_BADGE[s.status]}`}>{t(`bill.st.${s.status}`)}</span></small></div>
          {meter(usage.companies, s.includedCompanies, t('bill.companiesUsed'), s.extraCompanyPrice)}
          {meter(usage.users, s.includedUsers, t('bill.usersUsed'), s.extraUserPrice)}
        </div>
        {next ? (
          <div className="card">
            <h2>{t('bill.nextBillOn', { date: s.nextBillOn })}</h2>
            <QuoteLines q={next} cycle={s.cycle} />
            <div className="small mut">{t('bill.nextHint')}</div>
          </div>
        ) : <div className="card"><div className="mut">{s.status === 'cancelled' ? t('bill.adminCancelled') : t('bill.adminEnds', { date: s.nextBillOn })}</div></div>}
      </>}
      <div className="card">
        <h2>{t('bill.invoices')}{unpaid.length > 0 && <span className="badge bad" style={{ marginInlineStart: 8 }}>{t('bill.unpaidN', { n: unpaid.length })}</span>}</h2>
        {invoices.length === 0 ? <div className="mut">{t('bill.none')}</div> : <InvoiceTable rows={invoices} open={(x) => navigate(`/admin/billing/${x.id}`)} />}
        <div className="small mut" style={{ marginTop: 8 }}>{t('bill.adminHowToPay', { seller: seller.sellerName })}</div>
      </div>
    </>
  );
}

function QuoteLines({ q, cycle }: { q: { lines: Line[]; subtotal: number | string; discount: number | string; vat: number | string; total: number | string; currency: string; vatRate?: number | string }; cycle: string }) {
  const { t } = useI18n();
  return (
    <div className="wrap"><table>
      <tbody>
        {q.lines.map((l, i) => <tr key={i}><td>{lineText(t, l, cycle)}</td><td className="num">{money(l.amount)}</td></tr>)}
        {Number(q.discount) > 0 && <tr><td>{t('bill.discountLine')}</td><td className="num">−{money(q.discount)}</td></tr>}
        <tr><td>{t('bill.vatLine', { rate: q.vatRate !== undefined ? String(Number(q.vatRate)) : '' })}</td><td className="num">{money(q.vat)}</td></tr>
        <tr><td><b>{t('bill.total')}</b></td><td className="num"><b>{q.currency} {money(q.total)}</b></td></tr>
      </tbody>
    </table></div>
  );
}

// ------------------------------------------------------------------ One invoice, printable
export function BillingInvoicePage({ id, back }: { id: string; back: string }) {
  const { t } = useI18n();
  const d = useApi<BillInvoice & { seller: Settings }>(`/api/billing/invoices/${id}`);
  if (d.error) return <main className="public-doc"><ErrorNote error={d.error} onRetry={d.reload} /></main>;
  if (!d.data) return <main className="public-doc"><Loading /></main>;
  const x = d.data;
  return (
    <main className="public-doc">
      <div className="public-actions no-print">
        <div><b>{x.number}</b><div className="small">{x.customer}</div></div>
        <span className="spacer" />
        <button className="b" id="bill-back" onClick={() => navigate(back)}>{t('pub.back')}</button>
        <button className="b" onClick={() => window.print()}>{t('pub.print')}</button>
        <TopControls />
      </div>
      <div className="public-page">
        <div className="actions" style={{ alignItems: 'flex-start' }}>
          <div><h1 style={{ margin: 0 }}>{t('bill.taxInvoice')}</h1><div className="ltr">{x.number}</div></div>
          <span className="spacer" />
          <div style={{ textAlign: 'end' }}><b>{x.seller.sellerName}</b>{x.seller.sellerAddress && <div className="small">{x.seller.sellerAddress}</div>}
            {x.seller.sellerVat && <div className="small ltr">{t('bill.vatNo')} {x.seller.sellerVat}</div>}</div>
        </div>
        <hr />
        <div className="row">
          <div className="f"><small className="mut" style={{ display: 'block' }}>{t('bill.billTo')}</small><b>{x.customer}</b></div>
          <div className="f"><small className="mut" style={{ display: 'block' }}>{t('bill.issuedOn')}</small><span className="ltr">{x.issuedOn}</span></div>
          <div className="f"><small className="mut" style={{ display: 'block' }}>{t('bill.dueOn')}</small><span className="ltr">{x.dueOn}</span></div>
          <div className="f"><small className="mut" style={{ display: 'block' }}>{t('bill.period')}</small><span className="ltr">{x.periodStart} → {x.periodEnd}</span></div>
        </div>
        <QuoteLines q={x} cycle={x.cycle} />
        <div style={{ marginTop: 10 }}><span className={`badge ${STATUS_BADGE[x.status]}`}>{t(`bill.st.${x.status}`)}</span>
          {x.paidOn && <span className="small"> {t('bill.paidOnN', { date: x.paidOn })}</span>}{x.voidReason && <span className="small"> {x.voidReason}</span>}</div>
      </div>
    </main>
  );
}
