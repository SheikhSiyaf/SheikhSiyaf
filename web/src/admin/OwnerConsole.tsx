// Owner console (the seller of Nusuh Books): customers are accounting firms or companies that run their own books.
// The owner creates each customer with its first Administrator, opens its Administrator console to add companies,
// and suspends or reactivates it. The owner never sees anyone's books.
import { useState, type FormEvent } from 'react';
import { api, setActingTenant, useApi, type Me } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { OwnerBilling, OwnerPlans } from './Billing.tsx';
import { OwnerSupport, useOwnerSupportUnread } from '../support/Support.tsx';
import { ConfirmBar, ErrorNote, InviteBox, Loading, Sidebar, TopControls, errorText, type Invite } from '../ui.tsx';

interface Tenant { id: string; name: string; kind: 'firm' | 'company'; status: 'active' | 'suspended'; createdAt: string; companies: number; users: number; admins: string | null }

/** Opens a customer's Administrator console as the owner. */
export function openTenant(t: { id: string; name: string; kind: string }) {
  setActingTenant(t.id);
  try { sessionStorage.setItem('nb_acting_name', t.name); sessionStorage.setItem('nb_acting_kind', t.kind); } catch { /* not kept */ }
  navigate('/admin/clients');
}

const OWNER_TABS = [['customers', '/owner'], ['support', '/owner/support'], ['billing', '/owner/billing'], ['plans', '/owner/plans']] as const;

export function OwnerConsole({ me, path, onSignOut }: { me: Me; path: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const tab = path.startsWith('/owner/billing') ? 'billing' : path.startsWith('/owner/plans') ? 'plans' : path.startsWith('/owner/support') ? 'support' : 'customers';
  const unread = useOwnerSupportUnread();
  const title = t(`own.tab.${tab}`);
  return (
    <div className="app">
      <Sidebar subtitle={t('own.console')} user={me.user} roleLabel={t('own.role')} onSignOut={onSignOut}>
        {OWNER_TABS.map(([k, to]) => <button key={k} id={`own-tab-${k}`} className={k === tab ? 'on' : ''} aria-current={k === tab ? 'page' : undefined} onClick={() => navigate(to)}>{t(`own.tab.${k}`)}{k === 'support' && unread > 0 && <span className="fab-badge inline">{unread}</span>}</button>)}
      </Sidebar>
      <main>
        <div className="top"><h1>{title}</h1><TopControls /></div>
        {tab === 'billing' ? <OwnerBilling /> : tab === 'plans' ? <OwnerPlans /> : tab === 'support' ? <OwnerSupport /> : <Customers />}
      </main>
    </div>
  );
}

function Customers() {
  const { t, has } = useI18n();
  const list = useApi<Tenant[]>('/api/owner/tenants');
  const [form, setForm] = useState<{ name: string; kind: 'firm' | 'company'; adminName: string; adminEmail: string }>();
  const [invite, setInvite] = useState<Invite>();
  const [addAdmin, setAddAdmin] = useState<{ id: string; name: string; email: string }>();
  const [confirm, setConfirm] = useState<Tenant>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); list.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { const r = await api<{ id: string; invite: Invite }>('/api/owner/tenants', { body: form }); setInvite(r.invite); setForm(undefined); });
  };
  const rows = list.data ?? [];
  return (
    <>
        <div className="grid">
          <div className="card fig"><small>{t('own.firms')}</small><b>{rows.filter((x) => x.kind === 'firm').length}</b><small>{t('own.firmsSub')}</small></div>
          <div className="card fig"><small>{t('own.companies')}</small><b>{rows.filter((x) => x.kind === 'company').length}</b><small>{t('own.companiesSub')}</small></div>
          <div className="card fig"><small>{t('own.booksTotal')}</small><b>{rows.reduce((s, x) => s + x.companies, 0)}</b><small>{t('own.usersN', { n: rows.reduce((s, x) => s + x.users, 0) })}</small></div>
        </div>
        <div className="mut small" style={{ marginBottom: 10 }}>{t('own.hint')}</div>
        {msg.ok && <div className="notice">{msg.ok}</div>}
        {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
        {invite && <InviteBox invite={invite} onClose={() => setInvite(undefined)} />}
        {confirm && <ConfirmBar busy={busy} message={t(confirm.status === 'active' ? 'own.suspendConfirm' : 'own.reactivateConfirm', { name: confirm.name })} onNo={() => setConfirm(undefined)}
          onYes={() => { const c = confirm; setConfirm(undefined); void run(() => api(`/api/owner/tenants/${c.id}`, { body: { name: c.name, status: c.status === 'active' ? 'suspended' : 'active' } })); }} />}
        <div className="actions" style={{ marginBottom: 10 }}>
          <span className="spacer" />
          {!form && <button className="b p" id="own-new" onClick={() => setForm({ name: '', kind: 'company', adminName: '', adminEmail: '' })}>{t('own.new')}</button>}
        </div>
        {form && (
          <form className="card inset" onSubmit={create}>
            <h2>{t('own.new')}</h2>
            <div className="seg" role="radiogroup" style={{ marginBottom: 10 }}>
              {(['company', 'firm'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={form.kind === k} id={`own-kind-${k}`} className={form.kind === k ? 'on' : ''} onClick={() => setForm({ ...form, kind: k })}>{t(`own.kind.${k}`)}</button>)}
            </div>
            <div className="small mut" style={{ marginBottom: 8 }}>{t(`own.kindHint.${form.kind}`)}</div>
            <label className="f">{t('own.name')}<input id="own-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <div className="row">
              <label className="f">{t('own.adminName')}<input id="own-admin-name" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} /></label>
              <label className="f">{t('own.adminEmail')}<input id="own-admin-email" type="email" dir="ltr" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} /></label>
            </div>
            <div className="small mut" style={{ marginBottom: 8 }}>{t('own.nextStep')}</div>
            <div className="actions"><button className="b p" id="own-save" disabled={busy}>{t('own.create')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        <div className="card">
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {!list.data ? <Loading /> : rows.length === 0 ? <div className="mut">{t('own.none')}</div> : (
            <div className="wrap"><table className="stack">
              <thead><tr><th>{t('own.customer')}</th><th>{t('own.type')}</th><th className="num">{t('own.booksCol')}</th><th className="num">{t('own.usersCol')}</th><th>{t('own.admins')}</th><th /></tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={x.id} className={x.status === 'suspended' ? 'mut' : ''}>
                  <td><b>{x.name}</b>{x.status === 'suspended' && <> <span className="badge bad">{t('admin.suspended')}</span></>}<div className="small mut ltr">{x.createdAt.slice(0, 10)}</div></td>
                  <td data-label={t('own.type')}><span className={`badge ${x.kind === 'company' ? 'good' : ''}`}>{t(`own.kind.${x.kind}`)}</span></td>
                  <td className="num" data-label={t('own.booksCol')}>{x.companies}</td>
                  <td className="num" data-label={t('own.usersCol')}>{x.users}</td>
                  <td className="small" data-label={t('own.admins')}>{x.admins ?? '—'}
                    {addAdmin?.id === x.id && (
                      <form className="actions" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
                        const r = await api<{ invite: Invite }>(`/api/owner/tenants/${x.id}/admins`, { body: addAdmin }); setInvite(r.invite); setAddAdmin(undefined); }); }}>
                        <input aria-label={t('own.adminName')} placeholder={t('own.adminName')} value={addAdmin.name} onChange={(e) => setAddAdmin({ ...addAdmin, name: e.target.value })} />
                        <input aria-label={t('own.adminEmail')} placeholder={t('own.adminEmail')} type="email" dir="ltr" value={addAdmin.email} onChange={(e) => setAddAdmin({ ...addAdmin, email: e.target.value })} />
                        <button className="b small p" disabled={busy}>{t('admin.add')}</button>
                      </form>
                    )}</td>
                  <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                    <button className="b small p" disabled={x.status !== 'active'} onClick={() => openTenant(x)}>{t('own.open')}</button>
                    {addAdmin?.id !== x.id && <button className="b small" onClick={() => setAddAdmin({ id: x.id, name: '', email: '' })}>{t('own.addAdmin')}</button>}
                    <button className="b small" onClick={() => setConfirm(x)}>{x.status === 'active' ? t('admin.suspend') : t('admin.reactivate')}</button>
                  </span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
    </>
  );
}
