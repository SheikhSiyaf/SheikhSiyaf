// Owner console (the seller of Nusuh Books): customers are accounting firms or companies that run their own books.
// The owner creates each customer with its first Administrator, opens its Administrator console to add companies,
// and suspends or reactivates it. The owner never sees anyone's books.
import { useState, type FormEvent } from 'react';
import { api, setActingTenant, useApi, type Me } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { OwnerBilling, OwnerPlans } from './Billing.tsx';
import { OwnerWebsite } from './OwnerWebsite.tsx';
import { OwnerTrials } from './OwnerTrials.tsx';
import { OwnerSettings } from './OwnerSettings.tsx';
import { OwnerStaff, StaffHome } from './OwnerStaff.tsx';
import { NewCompanyCustomer } from './NewCompany.tsx';
import { OwnerSupport, useOwnerSupportUnread } from '../support/Support.tsx';
import { ConfirmBar, ErrorNote, InviteBox, Loading, Sidebar, TopControls, errorText, type Invite } from '../ui.tsx';

interface Tenant { id: string; name: string; kind: 'firm' | 'company'; status: 'active' | 'suspended'; createdAt: string; companies: number; users: number; admins: string | null; removedAt: string | null; eraseBlockers: string[] | null }

/** Opens a customer's Administrator console as the owner. */
export function openTenant(t: { id: string; name: string; kind: string }, to = '/admin/clients') {
  setActingTenant(t.id);
  try { sessionStorage.setItem('nb_acting_name', t.name); sessionStorage.setItem('nb_acting_kind', t.kind); } catch { /* not kept */ }
  navigate(to);
}

const OWNER_TABS = [['customers', '/owner'], ['support', '/owner/support'], ['billing', '/owner/billing'], ['trials', '/owner/trials'], ['plans', '/owner/plans'], ['website', '/owner/website'], ['staff', '/owner/staff'], ['settings', '/owner/settings']] as const;

export function OwnerConsole({ me, path, onSignOut }: { me: Me; path: string; onSignOut: () => void }) {
  const { t, has } = useI18n();
  const [demoMsg, setDemoMsg] = useState<string>();
  /** Demo mode: a short-lived signed link to the separate demo site, opened in a new tab. */
  const openDemo = async () => {
    setDemoMsg(undefined);
    const w = window.open('about:blank', '_blank');   // opened first so the browser does not block it
    try {
      const r = await api<{ url: string }>('/api/owner/demo-link');
      if (w) { w.opener = null; w.location.replace(r.url); } else window.location.assign(r.url);
    } catch (e) { w?.close(); setDemoMsg(errorText(t, has, e)); }
  };
  const tab = path.startsWith('/owner/billing') ? 'billing' : path.startsWith('/owner/trials') ? 'trials' : path.startsWith('/owner/plans') ? 'plans' : path.startsWith('/owner/website') ? 'website' : path.startsWith('/owner/staff') ? 'staff' : path.startsWith('/owner/settings') ? 'settings' : path.startsWith('/owner/support') ? 'support' : 'customers';
  const unread = useOwnerSupportUnread();
  const full = me.access ? me.access.full : true;   // staff without the Owner role open only what their role allows (nothing else answers them)
  const title = full ? t(`own.tab.${tab}`) : t('staff.home.page');
  return (
    <div className="app">
      <Sidebar subtitle={t('own.console')} user={me.user} roleLabel={t('own.role')} onSignOut={onSignOut}>
        {(full ? OWNER_TABS : []).map(([k, to]) => <button key={k} id={`own-tab-${k}`} className={k === tab ? 'on' : ''} aria-current={k === tab ? 'page' : undefined} onClick={() => navigate(to)}>{t(`own.tab.${k}`)}{k === 'support' && unread > 0 && <span className="fab-badge inline">{unread}</span>}</button>)}
        <button id="demo-mode" className="side-extra" onClick={() => void openDemo()}>▶ {t('demoSite.button')}</button>
      </Sidebar>
      <main>
        <div className="top"><h1>{title}</h1><TopControls /></div>
        {demoMsg && <div className="notice bad" role="alert" id="demo-msg">{demoMsg}</div>}
        {!full && me.access ? <StaffHome role={me.access.role} permissions={me.access.permissions} /> : tab === 'staff' ? <OwnerStaff /> : tab === 'billing' ? <OwnerBilling /> : tab === 'trials' ? <OwnerTrials /> : tab === 'plans' ? <OwnerPlans /> : tab === 'website' ? <OwnerWebsite /> : tab === 'settings' ? <OwnerSettings /> : tab === 'support' ? <OwnerSupport /> : <Customers />}
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
  const [confirmRemove, setConfirmRemove] = useState<Tenant>();
  const [eraseFor, setEraseFor] = useState<Tenant>();   // a removed customer the owner is about to delete for good
  const [typed, setTyped] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
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
  const all = list.data ?? [];
  const live = all.filter((x) => !x.removedAt);
  const removedCount = all.length - live.length;
  const rows = showRemoved ? all : live;   // removed customers are hidden unless asked for
  const kindPicker = (cur: NonNullable<typeof form>) => (
    <div className="seg" role="radiogroup" style={{ marginBottom: 10 }}>
      {(['company', 'firm'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={cur.kind === k} id={`own-kind-${k}`} className={cur.kind === k ? 'on' : ''} onClick={() => setForm({ ...cur, kind: k })}>{t(`own.kind.${k}`)}</button>)}
    </div>
  );
  return (
    <>
        <div className="grid">
          <div className="card fig"><small>{t('own.firms')}</small><b>{live.filter((x) => x.kind === 'firm').length}</b><small>{t('own.firmsSub')}</small></div>
          <div className="card fig"><small>{t('own.companies')}</small><b>{live.filter((x) => x.kind === 'company').length}</b><small>{t('own.companiesSub')}</small></div>
          <div className="card fig"><small>{t('own.booksTotal')}</small><b>{live.reduce((s, x) => s + x.companies, 0)}</b><small>{t('own.usersN', { n: live.reduce((s, x) => s + x.users, 0) })}</small></div>
        </div>
        <div className="mut small" style={{ marginBottom: 10 }}>{t('own.hint')}</div>
        {msg.ok && <div className="notice">{msg.ok}</div>}
        {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
        {invite && <InviteBox invite={invite} onClose={() => setInvite(undefined)} />}
        {confirm && <ConfirmBar busy={busy} message={t(confirm.status === 'active' ? 'own.suspendConfirm' : 'own.reactivateConfirm', { name: confirm.name })} onNo={() => setConfirm(undefined)}
          onYes={() => { const c = confirm; setConfirm(undefined); void run(() => api(`/api/owner/tenants/${c.id}`, { body: { name: c.name, status: c.status === 'active' ? 'suspended' : 'active' } })); }} />}
        {confirmRemove && <ConfirmBar busy={busy} message={t('own.removeConfirm', { name: confirmRemove.name })} onNo={() => setConfirmRemove(undefined)}
          onYes={() => { const c = confirmRemove; setConfirmRemove(undefined); void run(() => api(`/api/owner/tenants/${c.id}/remove`, { body: { removed: true } }), t('own.removed', { name: c.name })); }} />}
        {eraseFor && (
          <div className="card inset" id="own-erase-panel" role="alertdialog" aria-labelledby="own-erase-title" style={{ borderColor: 'var(--bad, #b42318)' }}>
            <h2 id="own-erase-title">{t('own.erase.title', { name: eraseFor.name })}</h2>
            <p>{t('own.erase.warn')}</p>
            <label className="f">{t('own.erase.type', { name: eraseFor.name })}
              <input id="own-erase-name" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} dir="auto" />
            </label>
            <div className="actions">
              <button className="b bad" id="own-erase-go" disabled={busy || typed.trim() !== eraseFor.name}
                onClick={() => { const c = eraseFor; setEraseFor(undefined); setTyped(''); void run(() => api(`/api/owner/tenants/${c.id}/erase`, { body: { confirmName: typed } }), t('own.erase.done', { name: c.name })); }}>{t('own.erase')}</button>
              <button className="b" id="own-erase-cancel" onClick={() => { setEraseFor(undefined); setTyped(''); }}>{t('cancel')}</button>
            </div>
          </div>
        )}
        <div className="actions" style={{ marginBottom: 10 }}>
          {removedCount > 0 && <label className="small mut"><input type="checkbox" id="own-show-removed" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> {t('own.showRemoved', { n: removedCount })}</label>}
          <span className="spacer" />
          {!form && <button className="b p" id="own-new" onClick={() => setForm({ name: '', kind: 'company', adminName: '', adminEmail: '' })}>{t('own.new')}</button>}
        </div>
        {form && form.kind === 'company' && (
          <div className="card inset">
            <h2>{t('own.new')}</h2>
            {kindPicker(form)}
            <div className="small mut" style={{ marginBottom: 8 }}>{t('own.kindHint.company')}</div>
            <NewCompanyCustomer onCancel={() => setForm(undefined)}
              onCreated={(c) => { setForm(undefined); list.reload(); openTenant({ id: c.id, name: c.name, kind: 'company' }, `/admin/clients/${c.companyId}`); }} />
          </div>
        )}
        {form && form.kind === 'firm' && (
          <form className="card inset" onSubmit={create}>
            <h2>{t('own.new')}</h2>
            {kindPicker(form)}
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
                <tr key={x.id} className={x.status === 'suspended' || x.removedAt ? 'mut' : ''}>
                  <td><b>{x.name}</b>{x.removedAt ? <> <span className="badge bad">{t('own.removedBadge')}</span></> : x.status === 'suspended' && <> <span className="badge bad">{t('admin.suspended')}</span></>}<div className="small mut ltr">{x.createdAt.slice(0, 10)}</div></td>
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
                    {x.removedAt ? (<>
                      <button className="b small p" id={`own-restore-${x.id}`} disabled={busy} onClick={() => void run(() => api(`/api/owner/tenants/${x.id}/remove`, { body: { removed: false } }), t('own.restored', { name: x.name }))}>{t('own.restore')}</button>
                      {x.eraseBlockers && x.eraseBlockers.length === 0
                        ? <button className="b small bad" id={`own-erase-${x.id}`} disabled={busy} onClick={() => { setEraseFor(x); setTyped(''); }}>{t('own.erase')}</button>
                        : x.eraseBlockers && <span className="small mut" id={`own-erase-no-${x.id}`} style={{ maxWidth: 260, textAlign: 'start' }}>{t('own.erase.cannot', { why: x.eraseBlockers.map((k) => t(`own.erase.why.${k}` as 'own.erase')).join(', ') })}</span>}
                    </>) : (<>
                      <button className="b small p" disabled={x.status !== 'active'} onClick={() => openTenant(x)}>{t('own.open')}</button>
                      {addAdmin?.id !== x.id && <button className="b small" onClick={() => setAddAdmin({ id: x.id, name: '', email: '' })}>{t('own.addAdmin')}</button>}
                      <button className="b small" onClick={() => setConfirm(x)}>{x.status === 'active' ? t('admin.suspend') : t('admin.reactivate')}</button>
                      <button className="b small bad" id={`own-remove-${x.id}`} onClick={() => setConfirmRemove(x)}>{t('own.remove')}</button>
                    </>)}
                  </span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
    </>
  );
}
