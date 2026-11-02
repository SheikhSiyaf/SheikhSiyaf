// Administrator console: separate from the books.
// Clients (summary, search, add, manage), Staff (add, clients handled, suspend, sign-in links),
// Activity (who changed clients, people and access) and Settings (firm name, sign-in security).
import { useEffect, useState, type FormEvent } from 'react';
import { api, useApi, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ConfirmBar, ErrorNote, InviteBox, Loading, Sidebar, TopControls, errorText, type Invite } from '../ui.tsx';

type Country = 'SA' | 'AE' | 'OM';
interface ClientRow {
  id: string; name: string; nameAr: string | null; country: Country; currency: string; crNumber: string;
  vatStatus: string; vatNumber: string | null; vatRate: string; city: string; status: string; clientUsers: number; staff: string[];
}
interface StaffRow {
  id: string; name: string; email: string; role: string; status: string; twoFactor: boolean;
  invitePending: boolean | null; passwordSet: boolean; clientIds: string[]; clients: string[];
}
interface ClientUser { id: string; name: string; email: string; role: string; status: string; invitePending: boolean | null; passwordSet: boolean; twoFactor: boolean }
interface ClientDetail {
  company: Record<string, string | null> & { id: string; name: string; country: Country; status: string };
  users: ClientUser[];
  staff: { id: string; name: string; role: string; status: string; assigned: boolean }[];
}

const TABS = ['Clients', 'Staff', 'Activity', 'Settings'] as const;
const LEGAL_FORMS = ['LLC', 'Sole establishment', 'Joint stock company', 'Partnership', 'Branch of foreign company', 'Other'] as const;
const DERIVED = { SA: { currency: 'SAR', rate: 15 }, AE: { currency: 'AED', rate: 5 }, OM: { currency: 'OMR', rate: 5 } } as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function AdminConsole({ me, path, onSignOut }: { me: Me; path: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const seg = path.split('/');                       // ['', 'admin', tab, id?]
  const tab = (TABS.find((x) => x.toLowerCase() === seg[2]) ?? 'Clients');
  const clientId = tab === 'Clients' && seg[3] && seg[3] !== 'new' ? seg[3] : null;
  const adding = tab === 'Clients' && seg[3] === 'new';
  const title = adding ? t('reg.title') : t(`admin.${tab}` as Key);
  return (
    <div className="app">
      <Sidebar subtitle={t('admin.console')} user={me.user} roleLabel={t('role.admin')} onSignOut={onSignOut}>
        {TABS.map((x) => (
          <button key={x} className={x === tab ? 'on' : ''} onClick={() => navigate(`/admin/${x.toLowerCase()}`)} aria-current={x === tab ? 'page' : undefined}>
            {t(`admin.${x}`)}
          </button>
        ))}
      </Sidebar>
      <main>
        <div className="top">
          <h1>{clientId ? '' : title}</h1>
          <TopControls />
        </div>
        {tab === 'Staff' ? <Staff /> : tab === 'Activity' ? <Activity /> : tab === 'Settings' ? <Settings />
          : adding ? <AddClient /> : clientId ? <ClientPage id={clientId} /> : <Clients />}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ Clients list
function Clients() {
  const { t } = useI18n();
  const local = useLocalName();
  const list = useApi<ClientRow[]>('/api/admin/companies');
  const [q, setQ] = useState('');
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const needle = q.trim().toLowerCase();
  const rows = list.data.filter((c) => !needle || [c.name, c.nameAr, c.crNumber, c.vatNumber, c.country, c.city].join(' ').toLowerCase().includes(needle));
  const active = list.data.filter((c) => c.status === 'active');
  const figs: [string, number][] = [
    [t('admin.totalClients'), list.data.length],
    [t('admin.active'), active.length],
    [t('admin.suspended'), list.data.length - active.length],
    [t('admin.withoutStaff'), active.filter((c) => c.staff.length === 0).length],
  ];
  return (
    <>
      <div className="grid">
        {figs.map(([label, n]) => <div key={label} className="card fig"><small>{label}</small><b>{n}</b></div>)}
      </div>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('admin.searchClients')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px' }} aria-label={t('search')} />
        <button className="b p" onClick={() => navigate('/admin/clients/new')}>{t('admin.addClient')}</button>
      </div>
      <div className="card">
        <div className="wrap">
          <table>
            <thead><tr><th>{t('col.client')}</th><th>{t('col.country')}</th><th>{t('admin.crNo')}</th><th>{t('col.vat')}</th><th className="num">{t('admin.clientUsers')}</th><th>{t('admin.staffAssigned')}</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    {local(c.name, c.nameAr)} {c.status !== 'active' && <span className="badge bad">{t('admin.suspended')}</span>}
                    <div className="mut small">{c.city} · {c.currency} · {Number(c.vatRate)}%</div>
                  </td>
                  <td>{t(`country.${c.country}`)}</td>
                  <td className="ltr">{c.crNumber}</td>
                  <td className="ltr">{c.vatStatus === 'unregistered' ? <span className="badge warn">{t('admin.unregistered')}</span> : c.vatNumber}</td>
                  <td className="num">{c.clientUsers}</td>
                  <td className="small">{c.staff.join(', ') || <span className="badge warn">{t('admin.withoutStaff')}</span>}</td>
                  <td className="num"><button className="b p" onClick={() => navigate(`/admin/clients/${c.id}`)}>{t('admin.manage')}</button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="mut">{list.data.length ? t('admin.noMatch') : t('admin.noClientsYet')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mut small">{t('admin.neverBooks')}</p>
    </>
  );
}

// ------------------------------------------------------------------ Registration form (add and edit)
type Fields = Record<string, string>;

function useCompanyCheck() {
  const { t } = useI18n();
  return (f: Fields): string | undefined => {
    const country = (f.country ?? 'SA') as Country;
    const registered = f.vatStatus !== 'unregistered';
    const v = (k: string) => (f[k] ?? '').trim();
    const missing: string[] = [];
    const need = (k: string, label: Key) => { if (!v(k)) missing.push(t(label).replace(' *', '')); };
    need('name', 'reg.name'); need('crNumber', `reg.cr${country}` as Key);
    if (registered) need('vatNumber', `reg.vatNumber${country}` as Key);
    need('address', 'reg.addressLine'); need('city', 'reg.city');
    if (missing.length) return t('v.required', { fields: missing.join(', ') });
    if (country === 'SA' && !/^\d{10}$/.test(v('crNumber'))) return t('v.saCr');
    if (registered && country === 'SA' && !/^3\d{13}3$/.test(v('vatNumber'))) return t('v.saVat');
    if (registered && country === 'AE' && !/^\d{15}$/.test(v('vatNumber'))) return t('v.aeTrn');
    if (v('email') && !EMAIL.test(v('email'))) return t('v.email');
    return undefined;
  };
}

function CompanyForm({ f, set, editing }: { f: Fields; set: (k: string, v: string) => void; editing?: boolean }) {
  const { t } = useI18n();
  const v = (k: string) => f[k] ?? '';
  const on = (k: string) => (e: { target: { value: string } }) => set(k, e.target.value);
  const country = (v('country') || 'SA') as Country;
  const registered = v('vatStatus') !== 'unregistered';
  const lastDay = (m: number) => new Date(Date.UTC(2023, m, 0)).getUTCDate();
  return (
    <>
      <div className="card">
        <h2>{t('reg.company')}</h2>
        <div className="row">
          <label className="f">{t('reg.name')}<input id="reg-name" value={v('name')} onChange={on('name')} /></label>
          <label className="f">{t('reg.nameAr')}<input id="reg-name-ar" value={v('nameAr')} onChange={on('nameAr')} dir="rtl" /></label>
          <label className="f">{t('reg.tradeName')}<input id="reg-trade" value={v('tradeName')} onChange={on('tradeName')} /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.country')}
            <select id="reg-country" value={country} onChange={on('country')} disabled={editing}>
              {(['SA', 'AE', 'OM'] as const).map((c) => <option key={c} value={c}>{t(`country.${c}`)}</option>)}
            </select>
          </label>
          <label className="f">{t('reg.legalForm')}
            <select id="reg-lf" value={v('legalForm') || 'LLC'} onChange={on('legalForm')}>
              {LEGAL_FORMS.map((x) => <option key={x} value={x}>{t(`lf.${x}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="mut small">
          {t('reg.derived', { currency: DERIVED[country].currency, rate: registered ? DERIVED[country].rate : 0, einv: t(`einv.${country}`) })}
          {editing && <> · {t('admin.countryFixed')}</>}
        </div>
      </div>

      <div className="card">
        <h2>{t('reg.tax')}</h2>
        <div className="row">
          <label className="f">{t(`reg.cr${country}` as Key)}<input id="reg-cr" value={v('crNumber')} onChange={on('crNumber')} placeholder={t(`reg.crHint${country}` as Key)} dir="ltr" /></label>
          <label className="f">{t('reg.crExpiry')}<input id="reg-cr-exp" type="date" value={v('crExpiry')} onChange={on('crExpiry')} /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.vatStatus')}
            <select id="reg-vat-status" value={v('vatStatus') || 'registered'} onChange={on('vatStatus')}>
              <option value="registered">{t('reg.vatRegistered')}</option>
              <option value="unregistered">{t('reg.vatUnregistered')}</option>
            </select>
          </label>
          <label className="f">{t(`reg.vatNumber${country}` as Key)}
            <input id="reg-vat" value={registered ? v('vatNumber') : ''} onChange={on('vatNumber')} disabled={!registered} placeholder={t(`reg.vatHint${country}` as Key)} dir="ltr" />
          </label>
          <label className="f">{t('reg.vatDate')}<input id="reg-vat-date" type="date" value={v('vatRegistrationDate')} onChange={on('vatRegistrationDate')} disabled={!registered} /></label>
        </div>
      </div>

      <div className="card">
        <h2>{t('reg.address')}</h2>
        <div className="row">
          <label className="f" style={{ flex: '2 1 260px' }}>{t('reg.addressLine')}<input id="reg-address" value={v('address')} onChange={on('address')} /></label>
          <label className="f">{t('reg.city')}<input id="reg-city" value={v('city')} onChange={on('city')} /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.phone')}<input id="reg-phone" type="tel" value={v('phone')} onChange={on('phone')} dir="ltr" /></label>
          <label className="f">{t('reg.email')}<input id="reg-email" type="email" value={v('email')} onChange={on('email')} dir="ltr" /></label>
          <label className="f">{t('reg.website')}<input id="reg-web" value={v('website')} onChange={on('website')} dir="ltr" /></label>
        </div>
      </div>

      <div className="card">
        <h2>{t('reg.settings')}</h2>
        <div className="row">
          <label className="f">{t('reg.fyEnd')}
            <select id="reg-fy" value={v('fyEnd') || '12-31'} onChange={on('fyEnd')}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const val = `${String(m).padStart(2, '0')}-${String(lastDay(m)).padStart(2, '0')}`;
                return <option key={m} value={val}>{lastDay(m)} {t(`month.${m}` as Key)}</option>;
              })}
            </select>
          </label>
          <label className="f">{t('reg.invoicePrefix')}<input id="reg-prefix" value={v('invoicePrefix')} onChange={on('invoicePrefix')} dir="ltr" maxLength={12} /></label>
          <label className="f">{t('reg.paymentTerms')}<input id="reg-terms" type="number" min={0} max={365} value={v('paymentTermsDays')} onChange={on('paymentTermsDays')} /></label>
        </div>
        <label className="f">{t('reg.notes')}<textarea id="reg-notes" rows={2} value={v('complianceNotes')} onChange={on('complianceNotes')} /></label>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Add client
function AddClient() {
  const { t, has } = useI18n();
  const check = useCompanyCheck();
  const staff = useApi<StaffRow[]>('/api/admin/staff');
  const [f, setF] = useState<Fields>({ country: 'SA', legalForm: 'LLC', vatStatus: 'registered', fyEnd: '12-31', invoicePrefix: 'INV-', paymentTermsDays: '30', userRole: 'client_accountant' });
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; invite: Invite }>();
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let problem = check(f);
    if (!problem && (!f.userName?.trim() || !f.userEmail?.trim())) problem = t('err.firstClientUser');
    if (!problem && !EMAIL.test(f.userEmail!.trim())) problem = t('v.email');
    setError(problem);
    if (problem) { window.scrollTo(0, 0); return; }
    setBusy(true);
    try {
      const { userName, userEmail, userRole, ...company } = f;
      setDone(await api('/api/admin/companies', { body: { company, firstUser: { name: userName, email: userEmail, role: userRole }, staffIds } }));
      window.scrollTo(0, 0);
    } catch (err) {
      setError(errorText(t, has, err));
      window.scrollTo(0, 0);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <>
        <div className="notice">{t('reg.done')}</div>
        <InviteBox invite={done.invite} onClose={() => navigate(`/admin/clients/${done.id}`)} />
        <div className="actions">
          <button className="b p" onClick={() => navigate(`/admin/clients/${done.id}`)}>{t('admin.manage')}</button>
          <button className="b" onClick={() => navigate('/admin/clients')}>{t('admin.allClients')}</button>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button type="button" className="b" onClick={() => navigate('/admin/clients')}>{t('admin.allClients')}</button>
        <span className="mut small">{t('reg.required')}</span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <CompanyForm f={f} set={set} />
      <div className="card">
        <h2>{t('reg.people')}</h2>
        <b className="small">{t('reg.firstUser')}</b>
        <div className="row" style={{ marginTop: 6 }}>
          <label className="f">{t('reg.firstUserName')}<input id="reg-user-name" value={f.userName ?? ''} onChange={(e) => set('userName', e.target.value)} /></label>
          <label className="f">{t('reg.firstUserEmail')}<input id="reg-user-email" type="email" value={f.userEmail ?? ''} onChange={(e) => set('userEmail', e.target.value)} dir="ltr" /></label>
          <label className="f">{t('reg.firstUserRole')}
            <select id="reg-user-role" value={f.userRole} onChange={(e) => set('userRole', e.target.value)}>
              <option value="client_accountant">{t('role.client_accountant')}</option>
              <option value="client_viewer">{t('role.client_viewer')}</option>
            </select>
          </label>
        </div>
        <b className="small">{t('reg.assignStaff')}</b>
        {staff.data ? (
          <div className="check-list" style={{ marginTop: 6 }}>
            {staff.data.filter((s) => s.status === 'active').map((s) => (
              <label key={s.id}>
                <input type="checkbox" checked={staffIds.includes(s.id)}
                  onChange={(e) => setStaffIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} />
                {s.name} <span className="mut small">· {t(`role.${s.role}` as Key)}</span>
              </label>
            ))}
          </div>
        ) : <Loading />}
      </div>
      <button className="b p" type="submit" disabled={busy}>{t('reg.submit')}</button>
    </form>
  );
}

// ------------------------------------------------------------------ Client page (Manage)
function ClientPage({ id }: { id: string }) {
  const { t, has } = useI18n();
  const local = useLocalName();
  const check = useCompanyCheck();
  const d = useApi<ClientDetail>(`/api/admin/companies/${id}`);
  const [f, setF] = useState<Fields>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [invite, setInvite] = useState<Invite>();
  const [nu, setNu] = useState({ name: '', email: '', role: 'client_accountant' });
  const [nuError, setNuError] = useState<string>();
  const [ticks, setTicks] = useState<Record<string, boolean>>({});   // shown at once, confirmed by the server
  useEffect(() => setTicks({}), [d.data]);

  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const c = d.data.company;
  const fields: Fields = f ?? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ?? '']));
  const suspended = c.status !== 'active';

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); d.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const problem = check(fields);
    if (problem) { setMsg({ bad: problem }); return; }
    void run(async () => { await api(`/api/admin/companies/${id}`, { body: { company: fields } }); setF(undefined); }, t('admin.saved'));
  };
  const addUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!nu.name.trim() || !nu.email.trim()) { setNuError(t('err.nameEmail')); return; }
    if (!EMAIL.test(nu.email.trim())) { setNuError(t('v.email')); return; }
    setNuError(undefined);
    setBusy(true);
    try {
      const r = await api<{ invite: Invite }>(`/api/admin/companies/${id}/users`, { body: nu });
      setInvite(r.invite); setNu({ name: '', email: '', role: 'client_accountant' }); d.reload();
    } catch (err) { setNuError(errorText(t, has, err)); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => navigate('/admin/clients')}>{t('admin.allClients')}</button>
      </div>
      <div className="top">
        <h1 style={{ flex: '1 1 auto' }}>{local(c.name, c.nameAr ?? null)}</h1>
        <span className={`badge ${suspended ? 'bad' : 'good'}`}>{suspended ? t('admin.suspended') : t('admin.active')}</span>
        {suspended
          ? <button className="b" disabled={busy} onClick={() => void run(() => api(`/api/admin/companies/${id}/status`, { body: { active: true } }))}>{t('admin.reactivate')}</button>
          : <button className="b" disabled={busy} onClick={() => setConfirmSuspend(true)}>{t('admin.suspend')}</button>}
      </div>
      {confirmSuspend && (
        <ConfirmBar message={t('admin.suspendClientConfirm', { client: c.name })} busy={busy}
          onYes={() => { setConfirmSuspend(false); void run(() => api(`/api/admin/companies/${id}/status`, { body: { active: false } })); }}
          onNo={() => setConfirmSuspend(false)} />
      )}
      {suspended && <div className="notice warn">{t('admin.clientSuspendedNote')}</div>}
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      {invite && <InviteBox invite={invite} onClose={() => setInvite(undefined)} />}

      {/* Client users */}
      <div className="card">
        <h2>{t('admin.clientUsersTitle')}</h2>
        <PeopleTable people={d.data.users} roleOf={(u) => t(`role.${u.role}` as Key)} onChanged={d.reload} onInvite={setInvite} />
        <form onSubmit={addUser} style={{ marginTop: 12 }}>
          <b className="small">{t('admin.addClientUser')}</b>
          {nuError && <div className="small bad">{nuError}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <label className="f">{t('reg.firstUserName')}<input id="nu-name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></label>
            <label className="f">{t('reg.firstUserEmail')}<input id="nu-email" type="email" dir="ltr" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></label>
            <label className="f">{t('reg.firstUserRole')}
              <select id="nu-role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                <option value="client_accountant">{t('role.client_accountant')}</option>
                <option value="client_viewer">{t('role.client_viewer')}</option>
              </select>
            </label>
          </div>
          <button className="b p" type="submit" disabled={busy}>{t('admin.add')}</button>
        </form>
      </div>

      {/* Firm staff for this client */}
      <div className="card">
        <h2>{t('reg.assignStaff')}</h2>
        <div className="mut small" style={{ marginBottom: 8 }}>{t('admin.staffForClientHint')}</div>
        <div className="check-list">
          {d.data.staff.map((s) => (
            <label key={s.id} className={s.status !== 'active' ? 'mut' : ''}>
              <input type="checkbox" checked={ticks[s.id] ?? s.assigned}
                onChange={(e) => {
                  const assigned = e.target.checked;
                  setTicks((x) => ({ ...x, [s.id]: assigned }));
                  void run(() => api(`/api/admin/companies/${id}/staff`, { body: { userId: s.id, assigned } }));
                }} />
              {s.name} <span className="mut small">· {t(`role.${s.role}` as Key)}{s.status !== 'active' ? ` · ${t('admin.suspended')}` : ''}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Registration and entry settings */}
      <form onSubmit={save} noValidate>
        <CompanyForm f={fields} set={(k, v) => setF({ ...fields, [k]: v })} editing />
        <button className="b p" type="submit" disabled={busy || !f}>{t('admin.saveDetails')}</button>
      </form>
    </>
  );
}

/** People with sign-in state and actions: new sign-in link, reset two-factor, suspend/reactivate. */
function PeopleTable<P extends { id: string; name: string; email: string; status: string; invitePending: boolean | null; passwordSet: boolean; twoFactor: boolean }>(
  { people, roleOf, extra, onChanged, onInvite }: {
    people: P[]; roleOf: (p: P) => string; extra?: (p: P) => React.ReactNode; onChanged: () => void; onInvite: (i: Invite) => void;
  }) {
  const { t, has } = useI18n();
  const [confirm, setConfirm] = useState<{ kind: 'suspend' | 'reset'; p: P }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await fn(); onChanged(); } catch (e) { setError(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const signIn = (p: P) => p.status !== 'active' ? <span className="badge bad">{t('admin.suspended')}</span>
    : p.invitePending ? <span className="badge warn">{t('admin.invitePending')}</span>
    : !p.passwordSet ? <span className="badge warn">{t('admin.noPassword')}</span>
    : <span className="badge good">{t('admin.passwordSet')}</span>;
  return (
    <>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {confirm && (
        <ConfirmBar busy={busy}
          message={confirm.kind === 'suspend' ? t('admin.suspendUserConfirm', { name: confirm.p.name }) : t('admin.resetTwoFactorConfirm', { name: confirm.p.name })}
          onNo={() => setConfirm(undefined)}
          onYes={() => {
            const { kind, p } = confirm;
            setConfirm(undefined);
            void run(() => api(kind === 'suspend' ? `/api/admin/users/${p.id}/status` : `/api/admin/users/${p.id}/reset-two-factor`, { body: kind === 'suspend' ? { active: false } : {} }));
          }} />
      )}
      <div className="wrap">
        <table className="people">
          <thead><tr><th>{t('col.name')}</th><th>{t('admin.role')}</th>{extra && <th>{t('admin.clientsHandled')}</th>}<th>{t('admin.signInState')}</th><th>{t('admin.twoFactor')}</th><th>{t('admin.actions')}</th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className={p.status !== 'active' ? 'mut' : ''}>
                <td>{p.name}<div className="mut small ltr">{p.email}</div></td>
                <td className="small" data-label={t('admin.role')}>{roleOf(p)}</td>
                {extra && <td className="small" data-label={t('admin.clientsHandled')}>{extra(p)}</td>}
                <td data-label={t('admin.signInState')}>{signIn(p)}</td>
                <td data-label={t('admin.twoFactor')}>{p.twoFactor ? <span className="badge good">{t('admin.on')}</span> : <span className="badge warn">{t('admin.off')}</span>}</td>
                <td>
                  <div className="actions">
                    {p.status === 'active' ? (
                      <>
                        <button className="b small" disabled={busy} onClick={() => void run(async () => onInvite((await api<{ invite: Invite }>(`/api/admin/users/${p.id}/invite`, { body: {} })).invite))}>{t('admin.newInvite')}</button>
                        {p.twoFactor && <button className="b small" disabled={busy} onClick={() => setConfirm({ kind: 'reset', p })}>{t('admin.resetTwoFactor')}</button>}
                        <button className="b small" disabled={busy} onClick={() => setConfirm({ kind: 'suspend', p })}>{t('admin.suspend')}</button>
                      </>
                    ) : (
                      <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/admin/users/${p.id}/status`, { body: { active: true } }))}>{t('admin.reactivate')}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {people.length === 0 && <tr><td colSpan={6} className="mut">{t('none')}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Staff
function Staff() {
  const { t, has } = useI18n();
  const local = useLocalName();
  const list = useApi<StaffRow[]>('/api/admin/staff');
  const clients = useApi<ClientRow[]>('/api/admin/companies');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [invite, setInvite] = useState<Invite>();
  const [nf, setNf] = useState({ name: '', email: '', role: 'staff_accountant', clientIds: [] as string[] });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});   // shown at once, confirmed by the server
  useEffect(() => setTicks({}), [list.data]);

  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data || !clients.data) return <Loading />;
  const activeClients = clients.data.filter((c) => c.status === 'active');

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!nf.name.trim() || !nf.email.trim()) { setError(t('err.nameEmail')); return; }
    if (!EMAIL.test(nf.email.trim())) { setError(t('v.email')); return; }
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ invite: Invite }>('/api/admin/staff', { body: nf });
      setInvite(r.invite); setAdding(false); setNf({ name: '', email: '', role: 'staff_accountant', clientIds: [] }); list.reload();
    } catch (err) { setError(errorText(t, has, err)); } finally { setBusy(false); }
  };
  const toggle = async (userId: string, companyId: string, assigned: boolean) => {
    setTicks((x) => ({ ...x, [`${userId}:${companyId}`]: assigned }));
    setBusy(true); setError(undefined);
    try { await api(`/api/admin/companies/${companyId}/staff`, { body: { userId, assigned } }); list.reload(); clients.reload(); }
    catch (err) { setError(errorText(t, has, err)); setTicks({}); } finally { setBusy(false); }
  };

  return (
    <>
      {invite && <InviteBox invite={invite} onClose={() => setInvite(undefined)} />}
      {error && <div className="notice bad" role="alert">{error}</div>}
      {adding ? (
        <form className="card" onSubmit={add} noValidate>
          <h2>{t('admin.addStaffTitle')}</h2>
          <div className="row">
            <label className="f">{t('reg.firstUserName')}<input id="ns-name" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></label>
            <label className="f">{t('reg.firstUserEmail')}<input id="ns-email" type="email" dir="ltr" value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} /></label>
            <label className="f">{t('admin.role')}
              <select id="ns-role" value={nf.role} onChange={(e) => setNf({ ...nf, role: e.target.value })}>
                {(['partner', 'reviewer', 'staff_accountant'] as const).map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
              </select>
            </label>
          </div>
          <b className="small">{t('admin.clientsToHandle')}</b>
          <div className="check-list" style={{ margin: '6px 0 12px' }}>
            {activeClients.map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={nf.clientIds.includes(c.id)}
                  onChange={(e) => setNf({ ...nf, clientIds: e.target.checked ? [...nf.clientIds, c.id] : nf.clientIds.filter((x) => x !== c.id) })} />
                {local(c.name, c.nameAr)}
              </label>
            ))}
            {activeClients.length === 0 && <span className="mut small">{t('admin.noClientsYet')}</span>}
          </div>
          <div className="actions">
            <button className="b p" type="submit" disabled={busy}>{t('admin.add')}</button>
            <button className="b" type="button" onClick={() => setAdding(false)}>{t('cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="actions" style={{ marginBottom: 10 }}>
          <span className="spacer" />
          <button className="b p" onClick={() => { setAdding(true); setInvite(undefined); }}>{t('admin.addStaff')}</button>
        </div>
      )}

      <div className="card">
        <h2>{t('admin.staffTitle')} ({list.data.length})</h2>
        <div className="mut small" style={{ marginBottom: 8 }}>{t('admin.staffHint')}</div>
        <PeopleTable people={list.data} roleOf={(s) => t(`role.${s.role}` as Key)} onChanged={() => { list.reload(); clients.reload(); }} onInvite={setInvite}
          extra={(s) => editing === s.id ? (
            <div>
              <div className="check-list" style={{ flexDirection: 'column', gap: 4 }}>
                {activeClients.map((c) => (
                  <label key={c.id}>
                    <input type="checkbox" checked={ticks[`${s.id}:${c.id}`] ?? s.clientIds.includes(c.id)} onChange={(e) => void toggle(s.id, c.id, e.target.checked)} />
                    {local(c.name, c.nameAr)}
                  </label>
                ))}
              </div>
              <button className="b small" style={{ marginTop: 6 }} onClick={() => setEditing(undefined)}>{t('admin.done')}</button>
            </div>
          ) : (
            <>
              <div>{s.clients.join(', ') || <span className="badge warn">{t('admin.noClientsYet')}</span>}</div>
              {s.status === 'active' && <button className="link small" onClick={() => setEditing(s.id)}>{t('admin.changeClients')}</button>}
            </>
          )} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Activity
interface ActivityRow { id: string; at: string; actor: string | null; key: string; params: Record<string, string> }

function Activity() {
  const { t, lang, has } = useI18n();
  const log = useApi<ActivityRow[]>('/api/admin/activity');
  if (log.error) return <ErrorNote error={log.error} onRetry={log.reload} />;
  if (!log.data) return <Loading />;
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const text = (r: ActivityRow) => {
    const p = { ...r.params };
    if (p.role && has(`role.${p.role}`)) p.role = t(`role.${p.role}` as Key);
    return has(r.key) ? t(r.key as Key, p) : t('act.other');
  };
  return (
    <div className="card">
      <div className="mut small" style={{ marginBottom: 8 }}>{t('activity.hint')}</div>
      <div className="wrap">
        <table>
          <thead><tr><th>{t('activity.when')}</th><th>{t('activity.who')}</th><th>{t('activity.what')}</th></tr></thead>
          <tbody>
            {log.data.map((r) => (
              <tr key={r.id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.at)}</td>
                <td className="small">{r.actor ?? <span className="mut">{t('activity.system')}</span>}</td>
                <td>{text(r)}</td>
              </tr>
            ))}
            {log.data.length === 0 && <tr><td colSpan={3} className="mut">{t('activity.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Settings
interface SettingsData { firmName: string; users: { total: number; active: number; suspended: number; twoFactor: number; invitesPending: number; neverSignedIn: number } }

function Settings() {
  const { t, has } = useI18n();
  const s = useApi<SettingsData>('/api/admin/settings');
  const [name, setName] = useState<string>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const u = s.data.users;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!(name ?? '').trim()) { setMsg({ bad: t('err.firmName') }); return; }
    setBusy(true); setMsg({});
    try { await api('/api/admin/settings', { body: { firmName: name } }); setMsg({ ok: t('admin.saved') }); setName(undefined); s.reload(); }
    catch (err) { setMsg({ bad: errorText(t, has, err) }); } finally { setBusy(false); }
  };
  const rows: [string, string, boolean][] = [
    [t('settings.activeUsers'), String(u.active), false],
    [t('settings.twoFactor'), t('settings.of', { n: u.twoFactor, total: u.active }), u.twoFactor < u.active],
    [t('settings.invites'), String(u.invitesPending), false],
    [t('settings.neverSignedIn'), String(u.neverSignedIn), u.neverSignedIn > 0],
    [t('settings.suspendedUsers'), String(u.suspended), false],
  ];
  return (
    <>
      <form className="card" onSubmit={save} style={{ maxWidth: 620 }}>
        <h2>{t('settings.firm')}</h2>
        {msg.ok && <div className="notice">{msg.ok}</div>}
        {msg.bad && <div className="notice bad">{msg.bad}</div>}
        <div className="actions">
          <label className="f" style={{ flex: '1 1 240px' }}>{t('settings.firmName')}
            <input id="firm-name" value={name ?? s.data.firmName} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="b p" type="submit" disabled={busy || name === undefined} style={{ alignSelf: 'flex-end' }}>{t('save')}</button>
        </div>
      </form>
      <div className="card" style={{ maxWidth: 620 }}>
        <h2>{t('settings.security')}</h2>
        <table>
          <tbody>
            {rows.map(([label, value, warn]) => (
              <tr key={label}><td>{label}</td><td className="num">{warn ? <span className="badge warn">{value}</span> : value}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="mut small">{t('settings.twoFactorAdvice')}</p>
      </div>
    </>
  );
}
