// CRM: leads, the deal pipeline (board by stage, linked to Sales quotations), activities and campaigns.
// Nothing here posts to the books; won deals become sales through their quotation and invoice.
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt, toMinor } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { accessTo } from '../../../src/books/modules.ts';

const SOURCES = ['referral', 'website', 'walk_in', 'phone', 'social', 'exhibition', 'campaign', 'other'] as const;
const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const OPEN = ['new', 'qualified', 'proposal', 'negotiation'] as const;
const KINDS = ['call', 'meeting', 'task', 'email', 'note'] as const;
const CHANNELS = ['email', 'sms', 'whatsapp', 'social', 'event', 'print', 'other'] as const;

interface Person { id: string; name: string }
interface Lead { id: string; name: string; nameAr: string | null; contactPerson: string | null; phone: string | null; email: string | null; source: string; campaignId: string | null;
  campaignName: string | null; ownerId: string | null; ownerName: string | null; status: string; estimatedValue: string; notes: string | null; lostReason: string | null; contactId: string | null; nextActivity: string | null }
interface Deal { id: string; title: string; contactId: string | null; customerName: string | null; customerNameAr: string | null; leadId: string | null; leadName: string | null; stage: string;
  value: string; expectedClose: string | null; ownerId: string | null; ownerName: string | null; quotationId: string | null; quotationNumber: string | null; quotationStatus: string | null;
  lostReason: string | null; closedAt: string | null; notes: string | null; nextActivity: string | null }
interface Pipeline { from: string; to: string; stages: { stage: string; chance: number; deals: Deal[]; count: number; total: string; weighted: string }[]; openTotal: string; weighted: string;
  wonTotal: string; wonCount: number; lostCount: number; winRate: number | null }
interface Activity { id: string; kind: string; subject: string; notes: string | null; dueDate: string | null; dueTime: string | null; doneAt: string | null; leadId: string | null; leadName: string | null;
  dealId: string | null; dealTitle: string | null; contactId: string | null; contactName: string | null; contactNameAr: string | null; ownerId: string | null; ownerName: string | null }
interface Campaign { id: string; name: string; channel: string; startDate: string | null; endDate: string | null; budget: string; status: string; audience: string | null; notes: string | null;
  leads: number; converted: number; won: number; wonValue: string; costPerLead: string | null }

function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); return true; } catch (e) { setMsg({ bad: errorText(t, has, e) }); return false; } finally { setBusy(false); }
  };
  return { run, busy, notes: <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</> };
}
const Fig = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => <div className="card fig"><small>{label}</small><b>{value}</b>{sub && <small>{sub}</small>}</div>;
const usePeople = (books: CompanyBooks) => useApi<Person[]>(`/api/companies/${books.company.id}/crm/people`).data ?? [];
const due = (d: string | null) => (d && d < today() ? 'bad' : d === today() ? 'warn' : '');

function OwnerSelect({ id, value, onChange, people, filter }: { id: string; value: string; onChange: (v: string) => void; people: Person[]; filter?: boolean }) {
  const { t } = useI18n();
  return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">{t(filter ? 'crm.everyone' : 'crm.nobody')}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
}

// ------------------------------------------------------------------ leads
export function Leads({ books, id }: { books: CompanyBooks; id?: string }) {
  return id ? <LeadPage key={id} books={books} id={id} /> : <LeadList books={books} />;
}

function LeadList({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const list = useApi<Lead[]>(`/api/companies/${books.company.id}/crm/leads?status=${status}&q=${encodeURIComponent(q)}`);
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('crm.searchLeads')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} aria-label={t('search')} />
        <select aria-label={t('crm.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">{t('crm.openLeads')}</option>{['new', 'contacted', 'qualified', 'converted', 'lost'].map((s) => <option key={s} value={s}>{t(`crm.lead.${s}` as Key)}</option>)}<option value="">{t('crm.all')}</option>
        </select>
        {books.canPost && <button className="b p" id="lead-new" onClick={() => go('CRM', 'leads', 'new')}>{t('crm.leadNew')}</button>}
      </div>
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('crm.noLeads')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('crm.leadName')}</th><th>{t('crm.source')}</th><th>{t('crm.owner')}</th><th>{t('crm.nextActivity')}</th><th className="num">{t('crm.estimatedValue')}</th><th>{t('crm.status')}</th></tr></thead>
            <tbody>{list.data.map((l) => (
              <tr key={l.id} className={l.status === 'lost' ? 'mut' : ''}>
                <td><button className="link" onClick={() => go('CRM', 'leads', l.id)}>{local(l.name, l.nameAr)}</button><div className="small mut">{[l.contactPerson, l.phone, l.email].filter(Boolean).join(' · ')}</div></td>
                <td className="small" data-label={t('crm.source')}>{t(`crm.source.${l.source}` as Key)}{l.campaignName && <div className="mut">{l.campaignName}</div>}</td>
                <td className="small" data-label={t('crm.owner')}>{l.ownerName ?? '—'}</td>
                <td className={`small ltr ${due(l.nextActivity)}`} data-label={t('crm.nextActivity')}>{l.nextActivity ?? '—'}</td>
                <td className="num ltr" data-label={t('crm.estimatedValue')}>{toMinor(l.estimatedValue) ? fmt(l.estimatedValue) : '—'}</td>
                <td data-label={t('crm.status')}><span className={`badge ${l.status === 'converted' ? 'good' : l.status === 'lost' ? '' : 'warn'}`}>{t(`crm.lead.${l.status}` as Key)}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

function LeadPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const lead = useApi<Lead>(isNew ? null : `/api/crm/leads/${id}`);
  const campaigns = useApi<Campaign[]>(`/api/companies/${books.company.id}/crm/campaigns`);
  const people = usePeople(books);
  const [f, setF] = useState<Record<string, string>>();
  const [convert, setConvert] = useState<{ dealTitle: string; dealValue: string }>();
  const { run, busy, notes } = useRun();
  if (lead.error) return <ErrorNote error={lead.error} onRetry={lead.reload} />;
  if (!isNew && !lead.data) return <Loading />;
  const x = lead.data;
  const form = f ?? { name: x?.name ?? '', nameAr: x?.nameAr ?? '', contactPerson: x?.contactPerson ?? '', phone: x?.phone ?? '', email: x?.email ?? '', source: x?.source ?? 'referral',
    campaignId: x?.campaignId ?? '', ownerId: x?.ownerId ?? '', estimatedValue: x && toMinor(x.estimatedValue) ? x.estimatedValue : '', status: x?.status ?? 'new', lostReason: x?.lostReason ?? '', notes: x?.notes ?? '' };
  const set = (k: string, v: string) => setF({ ...form, [k]: v });
  const locked = !books.canPost || x?.status === 'converted';
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/crm/leads` : `/api/crm/leads/${id}`, { body: form });
      setF(undefined); if (isNew) go('CRM', 'leads', r.id); else lead.reload();
    }, isNew ? undefined : t('admin.saved'));
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('CRM', 'leads')}>{t('crm.allLeads')}</button>
        <span className="spacer" />
        {x?.contactId && <button className="b" onClick={() => go('Sales', 'customers', x.contactId!)}>{t('crm.openCustomer')}</button>}
        {x && books.canPost && !['converted', 'lost'].includes(x.status) && !convert && <button className="b p" id="lead-convert" onClick={() => setConvert({ dealTitle: '', dealValue: toMinor(x.estimatedValue) ? x.estimatedValue : '' })}>{t('crm.convert')}</button>}
      </div>
      {notes}
      {convert && x && (
        <form className="card inset" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await api<{ contactId: string; dealId: string | null }>(`/api/crm/leads/${id}/convert`, { body: convert }); setConvert(undefined);
          if (r.dealId) go('CRM', 'pipeline', r.dealId); else lead.reload();
        }); }}>
          <h2>{t('crm.convertTitle', { name: x.name })}</h2>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('crm.convertHint')}</div>
          <div className="row">
            <label className="f">{t('crm.dealTitle')}<input id="cv-title" value={convert.dealTitle} placeholder={t('crm.dealTitleExample')} onChange={(e) => setConvert({ ...convert, dealTitle: e.target.value })} /></label>
            <label className="f">{t('crm.value')} ({books.company.currency})<input id="cv-value" inputMode="decimal" className="num ltr amount" value={convert.dealValue} onChange={(e) => setConvert({ ...convert, dealValue: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="cv-save" disabled={busy}>{t('crm.convertSave')}</button><button type="button" className="b" onClick={() => setConvert(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('crm.leadNew') : x!.name}</h2>
        {x?.status === 'converted' && <div className="notice small">{t('crm.convertedNote')}</div>}
        <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('crm.leadName')}<input id="ld-name" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
            <label className="f">{t('crm.contactPerson')}<input id="ld-person" value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('contact.phone')}<input id="ld-phone" type="tel" dir="ltr" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
            <label className="f">{t('reg.email')}<input id="ld-email" type="email" dir="ltr" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('crm.source')}<select id="ld-source" value={form.campaignId ? 'campaign' : form.source} onChange={(e) => setF({ ...form, source: e.target.value, campaignId: e.target.value === 'campaign' ? form.campaignId ?? "" : '' })}>
              {SOURCES.map((s) => <option key={s} value={s}>{t(`crm.source.${s}`)}</option>)}</select></label>
            {(form.source === 'campaign' || form.campaignId) && <label className="f">{t('crm.campaign')}<select id="ld-campaign" value={form.campaignId} onChange={(e) => set('campaignId', e.target.value)}>
              <option value="">—</option>{(campaigns.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <label className="f">{t('crm.owner')}<OwnerSelect id="ld-owner" value={form.ownerId ?? ""} onChange={(v) => set('ownerId', v)} people={people} /></label>
            <label className="f">{t('crm.estimatedValue')} ({books.company.currency})<input id="ld-value" inputMode="decimal" className="num ltr amount" value={form.estimatedValue} onChange={(e) => set('estimatedValue', e.target.value)} /></label>
          </div>
          {!isNew && <div className="row">
            <label className="f">{t('crm.status')}<select id="ld-status" value={form.status} onChange={(e) => set('status', e.target.value)}>
              {['new', 'contacted', 'qualified', 'lost', ...(x?.status === 'converted' ? ['converted'] : [])].map((s) => <option key={s} value={s}>{t(`crm.lead.${s}` as Key)}</option>)}</select></label>
            {form.status === 'lost' && <label className="f">{t('crm.lostReason')}<input id="ld-lost" value={form.lostReason} onChange={(e) => set('lostReason', e.target.value)} /></label>}
          </div>}
          <label className="f">{t('crm.notes')}<textarea id="ld-notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          {!locked && <button className="b p" id="ld-save" type="submit" disabled={busy}>{isNew ? t('crm.leadSave') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {!isNew && <ActivityPanel books={books} link={{ leadId: id }} />}
    </>
  );
}

// ------------------------------------------------------------------ pipeline
export function PipelinePage({ books, id }: { books: CompanyBooks; id?: string }) {
  return id ? <DealPage key={id} books={books} id={id} /> : <Board books={books} />;
}

function Board({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const people = usePeople(books);
  const [owner, setOwner] = useState('');
  const p = useApi<Pipeline>(`/api/companies/${books.company.id}/crm/pipeline?owner=${owner}`);
  const { run, busy, notes } = useRun();
  const move = (d: Deal, dir: 1 | -1) => {
    const i = OPEN.indexOf(d.stage as (typeof OPEN)[number]);
    const stage = OPEN[i + dir];
    if (stage) void run(async () => { await api(`/api/crm/deals/${d.id}/stage`, { body: { stage } }); p.reload(); });
  };
  if (p.error) return <ErrorNote error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const c = books.company.currency;
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <label className="f">{t('crm.owner')}<OwnerSelect id="pl-owner" value={owner} onChange={setOwner} people={people} filter /></label>
        <span className="spacer" />
        {books.canPost && <button className="b p" id="deal-new" onClick={() => go('CRM', 'pipeline', 'new')}>{t('crm.dealNew')}</button>}
      </div>
      <div className="grid">
        <Fig label={t('crm.openPipeline')} value={<span className="ltr">{fmt(p.data.openTotal)}</span>} sub={c} />
        <Fig label={t('crm.weighted')} value={<span className="ltr">{fmt(p.data.weighted)}</span>} sub={t('crm.weightedHint')} />
        <Fig label={t('crm.wonThisYear')} value={<span className="ltr">{fmt(p.data.wonTotal)}</span>} sub={t('crm.dealsN', { n: p.data.wonCount })} />
        <Fig label={t('crm.winRate')} value={p.data.winRate === null ? '—' : `${p.data.winRate}%`} sub={t('crm.wonLost', { won: p.data.wonCount, lost: p.data.lostCount })} />
      </div>
      {notes}
      <div className="board">
        {p.data.stages.filter((s) => (OPEN as readonly string[]).includes(s.stage)).map((s) => (
          <section key={s.stage} className="card board-col" aria-label={t(`crm.stage.${s.stage}` as Key)}>
            <header><b>{t(`crm.stage.${s.stage}` as Key)}</b> <span className="mut small">{s.chance}%</span>
              <div className="small mut ltr">{s.count} · {fmt(s.total)}</div></header>
            {s.deals.length === 0 && <div className="mut small">{t('crm.noDealsHere')}</div>}
            {s.deals.map((d) => (
              <article key={d.id} className="deal">
                <button className="link" onClick={() => go('CRM', 'pipeline', d.id)}><b>{d.title}</b></button>
                <div className="small mut">{d.customerName ? local(d.customerName, d.customerNameAr) : `${t('crm.leadLabel')}: ${d.leadName}`}</div>
                <div className="actions" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                  <b className="ltr">{fmt(d.value)}</b>
                  {d.expectedClose && <span className={`small ltr ${due(d.expectedClose)}`}>{d.expectedClose}</span>}
                </div>
                {d.quotationNumber && <div className="small">{t('crm.quotationN', { n: d.quotationNumber })} · {t(`state.${d.quotationStatus}` as Key)}</div>}
                {books.canPost && <div className="actions deal-move">
                  <button className="b small" disabled={busy || s.stage === 'new'} aria-label={t('crm.moveBack')} onClick={() => move(d, -1)}>‹</button>
                  <button className="b small" disabled={busy || s.stage === 'negotiation'} aria-label={t('crm.moveOn')} onClick={() => move(d, 1)}>›</button>
                </div>}
              </article>
            ))}
          </section>
        ))}
      </div>
      <div className="grid two">
        {(['won', 'lost'] as const).map((k) => { const s = p.data!.stages.find((x) => x.stage === k)!; return (
          <div key={k} className="card"><h3 style={{ marginTop: 0 }}>{t(`crm.stage.${k}`)} <span className="mut small">({s.count})</span></h3>
            {s.deals.length === 0 ? <div className="mut small">{t('crm.noDealsHere')}</div> : <table className="mini"><tbody>{s.deals.map((d) => (
              <tr key={d.id}><td><button className="link" onClick={() => go('CRM', 'pipeline', d.id)}>{d.title}</button>{d.lostReason && <div className="small mut">{d.lostReason}</div>}</td>
                <td className="num ltr">{fmt(d.value)}</td><td className="small mut ltr">{d.closedAt}</td></tr>
            ))}</tbody></table>}
          </div>); })}
      </div>
    </>
  );
}

function DealPage({ books, id }: { books: CompanyBooks; id: string }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const isNew = id === 'new';
  const deal = useApi<Deal>(isNew ? null : `/api/crm/deals/${id}`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const leads = useApi<Lead[]>(`/api/companies/${books.company.id}/crm/leads?status=open`);
  const people = usePeople(books);
  const [f, setF] = useState<Record<string, string>>();
  const { run, busy, notes } = useRun();
  if (deal.error) return <ErrorNote error={deal.error} onRetry={deal.reload} />;
  if (!isNew && !deal.data) return <Loading />;
  const x = deal.data;
  const form = f ?? { title: x?.title ?? '', contactId: x?.contactId ?? '', leadId: x?.leadId ?? '', stage: x?.stage ?? 'new', value: x && toMinor(x.value) ? x.value : '', expectedClose: x?.expectedClose ?? '',
    ownerId: x?.ownerId ?? '', lostReason: x?.lostReason ?? '', notes: x?.notes ?? '' };
  const set = (k: string, v: string) => setF({ ...form, [k]: v });
  const canQuote = books.canPost && accessTo(books.access?.permissions, 'Sales') === 'edit';
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ id: string }>(isNew ? `/api/companies/${books.company.id}/crm/deals` : `/api/crm/deals/${id}`, { body: form });
      setF(undefined); if (isNew) go('CRM', 'pipeline', r.id); else deal.reload();
    }, isNew ? undefined : t('admin.saved'));
  };
  const closed = x?.stage === 'won' || x?.stage === 'lost';
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('CRM', 'pipeline')}>{t('crm.allDeals')}</button>
        <span className="spacer" />
        {x?.quotationId && <button className="b" onClick={() => go('Sales', 'quotations', x.quotationId!)}>{t('crm.openQuotation', { n: x.quotationNumber ?? t('state.draft') })}</button>}
        {x && !x.quotationId && !closed && canQuote && x.contactId && <button className="b p" id="deal-quote" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ id: string }>(`/api/crm/deals/${id}/quotation`, { body: {} }); go('Sales', 'quotations', r.id); })}>{t('crm.makeQuotation')}</button>}
        {x?.leadId && <button className="b" onClick={() => go('CRM', 'leads', x.leadId!)}>{t('crm.openLead')}</button>}
      </div>
      {notes}
      {x && !x.contactId && <div className="notice small">{t('crm.needsCustomer')}</div>}
      {x?.quotationId && <div className="notice small">{t('crm.followsQuotation')}</div>}
      <form className="card" onSubmit={save} noValidate>
        <h2>{isNew ? t('crm.dealNew') : x!.title}</h2>
        <fieldset disabled={!books.canPost} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <label className="f">{t('crm.dealTitle')}<input id="dl-title" value={form.title} placeholder={t('crm.dealTitleExample')} onChange={(e) => set('title', e.target.value)} /></label>
            <label className="f">{t('crm.value')} ({books.company.currency})<input id="dl-value" inputMode="decimal" className="num ltr amount" value={form.value} onChange={(e) => set('value', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="f">{t('crm.customer')}<select id="dl-customer" value={form.contactId} onChange={(e) => setF({ ...form, contactId: e.target.value })}>
              <option value="">{form.leadId ? t('crm.notYet') : '—'}</option>{(customers.data ?? []).filter((c) => c.status === 'active' || c.id === form.contactId).map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>
            {!form.contactId && <label className="f">{t('crm.leadLabel')}<select id="dl-lead" value={form.leadId} onChange={(e) => set('leadId', e.target.value)}>
              <option value="">—</option>{[...(leads.data ?? []), ...(x?.leadId && !(leads.data ?? []).some((l) => l.id === x.leadId) ? [{ id: x.leadId, name: x.leadName ?? '' } as Lead] : [])].map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
          </div>
          <div className="row">
            <label className="f">{t('crm.stage')}<select id="dl-stage" value={form.stage} onChange={(e) => set('stage', e.target.value)}>
              {STAGES.map((s) => <option key={s} value={s}>{t(`crm.stage.${s}`)}</option>)}</select></label>
            {form.stage === 'lost' && <label className="f">{t('crm.lostReason')}<input id="dl-lost" value={form.lostReason} onChange={(e) => set('lostReason', e.target.value)} /></label>}
            <label className="f">{t('crm.expectedClose')}<input id="dl-close" type="date" value={form.expectedClose} onChange={(e) => set('expectedClose', e.target.value)} /></label>
            <label className="f">{t('crm.owner')}<OwnerSelect id="dl-owner" value={form.ownerId ?? ""} onChange={(v) => set('ownerId', v)} people={people} /></label>
          </div>
          <label className="f">{t('crm.notes')}<textarea id="dl-notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          {books.canPost && <button className="b p" id="dl-save" type="submit" disabled={busy}>{isNew ? t('crm.dealSave') : t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
      {!isNew && <ActivityPanel books={books} link={{ dealId: id }} />}
    </>
  );
}

// ------------------------------------------------------------------ activities
type Link = { leadId?: string; dealId?: string; contactId?: string };

/** Activities of one lead, deal or customer, with a quick add. */
export function ActivityPanel({ books, link }: { books: CompanyBooks; link: Link }) {
  const { t } = useI18n();
  const qs = Object.entries({ lead: link.leadId, deal: link.dealId, contact: link.contactId }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
  const list = useApi<Activity[]>(`/api/companies/${books.company.id}/crm/activities?show=all&${qs}`);
  return (
    <div className="card">
      <h2>{t('sub.activities')}</h2>
      {books.canPost && <ActivityForm books={books} link={link} onSaved={list.reload} compact />}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut small">{t('crm.noActivities')}</div> : <ActivityTable books={books} rows={list.data} onChanged={list.reload} hideLink />}
    </div>
  );
}

function ActivityForm({ books, link, onSaved, compact, edit }: { books: CompanyBooks; link?: Link; onSaved: () => void; compact?: boolean; edit?: Activity }) {
  const { t } = useI18n();
  const people = usePeople(books);
  const blank = { kind: 'call', subject: '', dueDate: today(), dueTime: '', ownerId: '', notes: '' };
  const [f, setF] = useState(edit ? { kind: edit.kind, subject: edit.subject, dueDate: edit.dueDate ?? '', dueTime: edit.dueTime ?? '', ownerId: edit.ownerId ?? '', notes: edit.notes ?? '' } : blank);
  const { run, busy, notes } = useRun();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(edit ? `/api/crm/activities/${edit.id}` : `/api/companies/${books.company.id}/crm/activities`, { body: { ...f, ...(edit ? { leadId: edit.leadId, dealId: edit.dealId, contactId: edit.contactId } : link) } });
      setF(blank); onSaved();
    });
  };
  return (
    <form onSubmit={save} className={compact ? '' : 'card inset'} style={{ marginBottom: 10 }}>
      {notes}
      <div className="row">
        <label className="f">{t('crm.kind')}<select id="ac-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`crm.kind.${k}`)}</option>)}</select></label>
        <label className="f" style={{ flex: '3 1 240px' }}>{t('crm.subject')}<input id="ac-subject" value={f.subject} placeholder={t('crm.subjectExample')} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="f">{t('crm.dueDate')}<input id="ac-date" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        <label className="f">{t('crm.time')}<input id="ac-time" type="time" value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} /></label>
        <label className="f">{t('crm.owner')}<OwnerSelect id="ac-owner" value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} people={people} /></label>
      </div>
      {!compact && <label className="f">{t('crm.notes')}<textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>}
      <button className="b p" id="ac-save" disabled={busy || !f.subject.trim()}>{edit ? t('admin.saveDetails') : t('crm.activityAdd')}</button>
    </form>
  );
}

function ActivityTable({ books, rows, onChanged, hideLink }: { books: CompanyBooks; rows: Activity[]; onChanged: () => void; hideLink?: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const { run, busy, notes } = useRun();
  const [edit, setEdit] = useState<string>();
  return (
    <>
      {notes}
      <div className="wrap"><table className="stack">
        <thead><tr><th>{t('crm.done')}</th><th>{t('crm.activity')}</th>{!hideLink && <th>{t('crm.about')}</th>}<th>{t('crm.dueDate')}</th><th>{t('crm.owner')}</th><th /></tr></thead>
        <tbody>{rows.map((a) => (
          edit === a.id ? <tr key={a.id}><td colSpan={6}><ActivityForm books={books} edit={a} onSaved={() => { setEdit(undefined); onChanged(); }} /></td></tr> : (
          <tr key={a.id} className={a.doneAt ? 'mut' : ''}>
            <td><input type="checkbox" aria-label={t('crm.markDone', { subject: a.subject })} checked={!!a.doneAt} disabled={!books.canPost || busy}
              onChange={(e) => void run(async () => { await api(`/api/crm/activities/${a.id}/done`, { body: { done: e.target.checked } }); onChanged(); })} /></td>
            <td><span className="badge">{t(`crm.kind.${a.kind}` as Key)}</span> {a.doneAt ? <s>{a.subject}</s> : a.subject}{a.notes && <div className="small mut">{a.notes}</div>}</td>
            {!hideLink && <td className="small" data-label={t('crm.about')}>
              {a.dealId ? <button className="link" onClick={() => go('CRM', 'pipeline', a.dealId!)}>{a.dealTitle}</button>
                : a.leadId ? <button className="link" onClick={() => go('CRM', 'leads', a.leadId!)}>{a.leadName}</button>
                : a.contactId ? <button className="link" onClick={() => go('Sales', 'customers', a.contactId!)}>{local(a.contactName ?? '', a.contactNameAr)}</button> : '—'}</td>}
            <td className={`small ltr ${a.doneAt ? '' : due(a.dueDate)}`} data-label={t('crm.dueDate')}>{a.dueDate ?? '—'} {a.dueTime ?? ''}</td>
            <td className="small" data-label={t('crm.owner')}>{a.ownerName ?? '—'}</td>
            <td className="num">{books.canPost && <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
              <button className="b small" onClick={() => setEdit(a.id)}>{t('crm.change')}</button>
              <button className="b small" disabled={busy} onClick={() => void run(async () => { await api(`/api/crm/activities/${a.id}/delete`, { body: {} }); onChanged(); })}>{t('crm.remove')}</button>
            </span>}</td>
          </tr>)
        ))}</tbody>
      </table></div>
    </>
  );
}

export function Activities({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const people = usePeople(books);
  const [show, setShow] = useState('open');
  const [owner, setOwner] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useApi<Activity[]>(`/api/companies/${books.company.id}/crm/activities?show=${show}&owner=${owner}`);
  const overdue = (list.data ?? []).filter((a) => !a.doneAt && a.dueDate && a.dueDate < today()).length;
  return (
    <>
      <div className="top" style={{ marginBottom: 10 }}>
        <div className="seg">{['open', 'overdue', 'done', 'all'].map((s) => <button key={s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>{t(`crm.show.${s}` as Key)}</button>)}</div>
        <label className="f">{t('crm.owner')}<OwnerSelect id="act-owner" value={owner} onChange={setOwner} people={people} filter /></label>
        <span className="spacer" />
        {books.canPost && !adding && <button className="b p" id="act-new" onClick={() => setAdding(true)}>{t('crm.activityNew')}</button>}
      </div>
      {show === 'open' && overdue > 0 && <div className="notice warn small">{t('crm.overdueN', { n: overdue })}</div>}
      {adding && <ActivityForm books={books} onSaved={() => { setAdding(false); list.reload(); }} />}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('crm.noActivities')}</div> : <ActivityTable books={books} rows={list.data} onChanged={list.reload} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ campaigns
export function Campaigns({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const list = useApi<Campaign[]>(`/api/companies/${books.company.id}/crm/campaigns`);
  const [form, setForm] = useState<Record<string, string> & { id?: string }>();
  const { run, busy, notes } = useRun();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api(form!.id ? `/api/crm/campaigns/${form!.id}` : `/api/companies/${books.company.id}/crm/campaigns`, { body: form }); setForm(undefined); list.reload(); }, t('crm.campaignSaved'));
  };
  const c = books.company.currency;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <div className="mut small" style={{ flex: '1 1 300px' }}>{t('crm.campaignsHint')}</div>
        {books.canPost && !form && <button className="b p" id="cp-new" onClick={() => setForm({ name: '', channel: 'whatsapp', startDate: today(), endDate: '', budget: '', status: 'planned', audience: '', notes: '' })}>{t('crm.campaignNew')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={save}>
          <div className="row">
            <label className="f">{t('crm.campaignName')}<input id="cp-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="f">{t('crm.channel')}<select id="cp-channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>{CHANNELS.map((x) => <option key={x} value={x}>{t(`crm.channel.${x}`)}</option>)}</select></label>
            <label className="f">{t('crm.status')}<select id="cp-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{['planned', 'running', 'done'].map((x) => <option key={x} value={x}>{t(`crm.campaign.${x}` as Key)}</option>)}</select></label>
          </div>
          <div className="row">
            <label className="f">{t('crm.startDate')}<input id="cp-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
            <label className="f">{t('crm.endDate')}<input id="cp-end" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
            <label className="f">{t('crm.budget')} ({c})<input id="cp-budget" inputMode="decimal" className="num ltr amount" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="f">{t('crm.audience')}<input id="cp-audience" value={form.audience} placeholder={t('crm.audienceExample')} onChange={(e) => setForm({ ...form, audience: e.target.value })} /></label>
            <label className="f">{t('crm.notes')}<input id="cp-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <div className="actions"><button className="b p" id="cp-save" disabled={busy}>{t('crm.campaignSave')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('crm.noCampaigns')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('crm.campaignName')}</th><th>{t('crm.dates')}</th><th className="num">{t('crm.budget')}</th><th className="num">{t('crm.leadsCol')}</th>
              <th className="num">{t('crm.customersCol')}</th><th className="num">{t('crm.wonCol')}</th><th className="num">{t('crm.costPerLead')}</th><th /></tr></thead>
            <tbody>{list.data.map((x) => (
              <tr key={x.id} className={x.status === 'done' ? 'mut' : ''}>
                <td><b>{x.name}</b> <span className={`badge ${x.status === 'running' ? 'good' : ''}`}>{t(`crm.campaign.${x.status}` as Key)}</span>
                  <div className="small mut">{t(`crm.channel.${x.channel}` as Key)}{x.audience ? ` · ${x.audience}` : ''}</div></td>
                <td className="small ltr" data-label={t('crm.dates')}>{x.startDate ?? '—'}{x.endDate ? ` → ${x.endDate}` : ''}</td>
                <td className="num ltr" data-label={t('crm.budget')}>{fmt(x.budget)}</td>
                <td className="num" data-label={t('crm.leadsCol')}>{x.leads}</td>
                <td className="num" data-label={t('crm.customersCol')}>{x.converted}</td>
                <td className="num ltr" data-label={t('crm.wonCol')}>{x.won ? `${x.won} · ${fmt(x.wonValue)}` : '0'}</td>
                <td className="num ltr" data-label={t('crm.costPerLead')}>{x.costPerLead ? fmt(x.costPerLead) : '—'}</td>
                <td className="num">{books.canPost && <button className="b small" onClick={() => setForm({ id: x.id, name: x.name, channel: x.channel, startDate: x.startDate ?? '', endDate: x.endDate ?? '',
                  budget: toMinor(x.budget) ? x.budget : '', status: x.status, audience: x.audience ?? '', notes: x.notes ?? '' })}>{t('crm.change')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
