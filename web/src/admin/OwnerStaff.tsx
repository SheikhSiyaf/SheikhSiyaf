// Internal users: the people of Nusuh Books itself, their roles, and what each role may open. Everything is checked again in the database
// (db/migrations/0088_staff_roles.sql); a button that is hidden here is also refused there.
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ConfirmBar, ErrorNote, InviteBox, Loading, errorText, type Invite } from '../ui.tsx';

interface Person { id: string; name: string; email: string; status: 'active' | 'suspended'; roleId: string; roleName: string; full: boolean; me: boolean }
interface Role { id: string; name: string; description: string; full: boolean; builtIn: boolean; archived: boolean; people: number; permissions: string[] }
interface Perm { code: string; workspace: string; labelEn: string; labelAr: string }
interface Overview { people: Person[]; roles: Role[]; permissions: Perm[] }

export function OwnerStaff() {
  const { t, has, lang } = useI18n();
  const data = useApi<Overview>('/api/owner/staff');
  const [form, setForm] = useState<{ name: string; email: string; roleId: string }>();
  const [edit, setEdit] = useState<{ id: string; name: string; email: string }>();
  const [roleForm, setRoleForm] = useState<{ id: string | null; name: string; description: string; permissions: string[] }>();
  const [invite, setInvite] = useState<Invite>();
  const [confirm, setConfirm] = useState<{ p: Person; status: 'active' | 'suspended' }>();
  const [confirmRole, setConfirmRole] = useState<Role>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); data.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const { people, permissions } = data.data;
  const roles = data.data.roles.filter((r) => !r.archived);
  const label = (p: Perm) => (lang === 'ar' ? p.labelAr : p.labelEn);
  const space = (code: string) => { const k = `staff.ws.${code}`; return has(k) ? t(k) : code; };
  const workspaces = [...new Set(permissions.map((p) => p.workspace))];
  const toggle = (code: string) => setRoleForm((f) => f && ({ ...f, permissions: f.permissions.includes(code) ? f.permissions.filter((x) => x !== code) : [...f.permissions, code] }));

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    void run(async () => { const r = await api<{ invite: Invite }>('/api/owner/staff', { body: form }); setInvite(r.invite); setForm(undefined); });
  };
  const saveRole = (e: FormEvent) => {
    e.preventDefault();
    if (!roleForm) return;
    const { id, ...body } = roleForm;
    void run(async () => { await api(id ? `/api/owner/staff-roles/${id}` : '/api/owner/staff-roles', { body }); setRoleForm(undefined); }, t('staff.roleSaved'));
  };

  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('staff.hint')}</div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert" id="staff-error">{msg.bad}</div>}
      {invite && <InviteBox invite={invite} onClose={() => setInvite(undefined)} />}
      {confirm && <ConfirmBar busy={busy} message={t(confirm.status === 'suspended' ? 'staff.suspendConfirm' : 'staff.restoreConfirm', { name: confirm.p.name })} onNo={() => setConfirm(undefined)}
        onYes={() => { const c = confirm; setConfirm(undefined); void run(() => api(`/api/owner/staff/${c.p.id}/status`, { body: { status: c.status } })); }} />}
      {confirmRole && <ConfirmBar busy={busy} message={t('staff.roleRemoveConfirm', { name: confirmRole.name })} onNo={() => setConfirmRole(undefined)}
        onYes={() => { const c = confirmRole; setConfirmRole(undefined); void run(() => api(`/api/owner/staff-roles/${c.id}/archive`, { body: {} })); }} />}

      <div className="actions" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{t('staff.people')}</h2><span className="spacer" />
        {!form && <button className="b p" id="staff-new" onClick={() => setForm({ name: '', email: '', roleId: roles.find((r) => !r.full)?.id ?? roles[0]?.id ?? '' })}>{t('staff.new')}</button>}
      </div>
      {form && (
        <form className="card inset" onSubmit={add} id="staff-form">
          <label className="f">{t('staff.name')}<input id="staff-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} autoComplete="off" /></label>
          <label className="f">{t('staff.email')}<input id="staff-email" type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required maxLength={200} autoComplete="off" /></label>
          <label className="f">{t('staff.role')}
            <select id="staff-role" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <div className="actions"><button className="b p" id="staff-add" disabled={busy}>{t('staff.add')}</button><button type="button" className="b" onClick={() => setForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="wrap"><table className="stack" id="staff-table">
        <thead><tr><th>{t('staff.name')}</th><th>{t('staff.email')}</th><th>{t('staff.role')}</th><th>{t('staff.status')}</th><th /></tr></thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id} data-email={p.email}>
              {edit?.id === p.id ? (
                <td colSpan={5}>
                  <form className="actions" onSubmit={(e) => { e.preventDefault(); const x = edit; void run(async () => { await api(`/api/owner/staff/${x.id}`, { body: { name: x.name, email: x.email } }); setEdit(undefined); }, t('staff.saved')); }}>
                    <input aria-label={t('staff.name')} id="staff-edit-name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={120} />
                    <input aria-label={t('staff.email')} id="staff-edit-email" type="email" dir="ltr" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} required maxLength={200} />
                    <button className="b p" id="staff-edit-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setEdit(undefined)}>{t('cancel')}</button>
                  </form>
                </td>
              ) : (
                <>
                  <td data-label={t('staff.name')}><b>{p.name}</b>{p.me && <span className="mut small"> ({t('staff.you')})</span>}</td>
                  <td data-label={t('staff.email')} dir="ltr">{p.email}</td>
                  <td data-label={t('staff.role')}>
                    {p.me ? p.roleName : (
                      <select aria-label={t('staff.role')} className="staff-role-pick" value={p.roleId} disabled={busy} onChange={(e) => void run(() => api(`/api/owner/staff/${p.id}/role`, { body: { roleId: e.target.value } }), t('staff.saved'))}>
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td data-label={t('staff.status')}>{t(`staff.status.${p.status}`)}</td>
                  <td className="actions">
                    <button className="b" onClick={() => setEdit({ id: p.id, name: p.name, email: p.email })}>{t('staff.edit')}</button>
                    {!p.me && <button className="b" disabled={busy} onClick={() => setConfirm({ p, status: p.status === 'active' ? 'suspended' : 'active' })}>{t(p.status === 'active' ? 'staff.suspend' : 'staff.restore')}</button>}
                    {!p.me && <button className="b" disabled={busy} onClick={() => void run(async () => { const r = await api<{ invite: Invite }>(`/api/owner/staff/${p.id}/invite`, { body: {} }); setInvite(r.invite); }).then(() => undefined)}>{t('staff.invite')}</button>}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table></div>

      <div className="actions" style={{ margin: '24px 0 10px' }}>
        <h2 style={{ margin: 0 }}>{t('staff.roles')}</h2><span className="spacer" />
        {!roleForm && <button className="b p" id="staff-role-new" onClick={() => setRoleForm({ id: null, name: '', description: '', permissions: [] })}>{t('staff.roleNew')}</button>}
      </div>
      {roleForm && (
        <form className="card inset" onSubmit={saveRole} id="staff-role-form">
          <label className="f">{t('staff.roleName')}<input id="staff-role-name" value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} required minLength={2} maxLength={60} /></label>
          <label className="f">{t('staff.roleDesc')}<input id="staff-role-desc" value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} maxLength={300} /></label>
          {workspaces.map((w) => (
            <fieldset key={w} style={{ border: 0, padding: 0, margin: '8px 0' }}>
              <legend><b>{space(w)}</b></legend>
              {permissions.filter((p) => p.workspace === w).map((p) => (
                <label key={p.code} className="small" style={{ display: 'block' }}><input type="checkbox" data-perm={p.code} checked={roleForm.permissions.includes(p.code)} onChange={() => toggle(p.code)} /> {label(p)}</label>
              ))}
            </fieldset>
          ))}
          <div className="actions"><button className="b p" id="staff-role-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setRoleForm(undefined)}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="wrap"><table className="stack" id="staff-roles-table">
        <thead><tr><th>{t('staff.roleName')}</th><th>{t('staff.access')}</th><th>{t('staff.peopleN')}</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td data-label={t('staff.roleName')}><b>{r.name}</b>{r.builtIn && <span className="mut small"> ({t('staff.builtIn')})</span>}<div className="mut small">{r.description}</div></td>
              <td data-label={t('staff.access')} className="small">{r.full ? t('staff.fullAccess') : r.permissions.map((c) => permissions.find((p) => p.code === c)).filter((p): p is Perm => Boolean(p)).map(label).join(' · ') || t('staff.noAccess')}</td>
              <td data-label={t('staff.peopleN')}>{r.people}</td>
              <td className="actions">
                {!r.builtIn && <button className="b" onClick={() => setRoleForm({ id: r.id, name: r.name, description: r.description, permissions: r.permissions })}>{t('staff.edit')}</button>}
                {!r.builtIn && <button className="b" disabled={busy || r.people > 0} title={r.people > 0 ? t('staff.roleInUse') : undefined} onClick={() => setConfirmRole(r)}>{t('staff.roleRemove')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}

/** What a staff person without full access sees: who they are and what their role may open (the areas open up as each is built). */
export function StaffHome({ role, permissions }: { role: string; permissions: string[] }) {
  const { t, has } = useI18n();
  const name = (c: string) => { const k = `staff.perm.${c}`; return has(k) ? t(k) : c; };
  return (
    <div className="card" id="staff-home">
      <h2>{t('staff.home.title', { role })}</h2>
      <p>{t('staff.home.body')}</p>
      <p className="mut small">{permissions.length ? permissions.map(name).join(' · ') : t('staff.noAccess')}</p>
    </div>
  );
}
