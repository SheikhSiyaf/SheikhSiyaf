// Administrator console: separate from the books.
// Clients (summary, search, add, manage), Staff (add, clients handled, suspend, sign-in links),
// Activity (who changed clients, people and access) and Settings (firm name, sign-in security).
import { DEFAULT_MODULES, INDUSTRIES, OPTIONAL_MODULES, ROLE_MODULES, type AccessLevel, type Industry } from '../../../src/books/modules.ts';
import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { api, setActingTenant, useApi, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { AdminBilling } from './Billing.tsx';
import { ConfirmBar, ErrorNote, InviteBox, Loading, Sidebar, TopControls, errorText, type Invite } from '../ui.tsx';
import { ArabicHint, followArabic } from '../arabic.tsx';

type Country = 'SA' | 'AE' | 'OM';
interface ClientRow {
  id: string; name: string; nameAr: string | null; country: Country; currency: string; crNumber: string;
  vatStatus: string; vatNumber: string | null; vatRate: string; city: string; status: string; clientUsers: number; staff: string[];
}
interface StaffRow {
  id: string; name: string; email: string; role: string; status: string; twoFactor: boolean;
  invitePending: boolean | null; passwordSet: boolean; clientIds: string[]; clients: string[];
}
interface ClientUser { id: string; name: string; email: string; role: string; clientRoleId: string | null; status: string; invitePending: boolean | null; passwordSet: boolean; twoFactor: boolean }
interface ClientDetail {
  company: Record<string, string | null> & { id: string; name: string; country: Country; status: string };
  users: ClientUser[];
  staff: { id: string; name: string; role: string; status: string; assigned: boolean }[];
}

const TABS = ['Clients', 'Staff', 'Roles', 'Activity', 'Billing', 'Settings'] as const;
const LEGAL_FORMS = ['LLC', 'Sole establishment', 'Joint stock company', 'Partnership', 'Branch of foreign company', 'Other'] as const;
const DERIVED = { SA: { currency: 'SAR', rate: 15 }, AE: { currency: 'AED', rate: 5 }, OM: { currency: 'OMR', rate: 5 } } as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Which customer this console belongs to: an accounting firm or a company that runs its own books, and whether
 *  the platform owner is working in it (only the owner adds companies and changes a company's details). */
interface Tenant { kind: 'firm' | 'company'; owner: boolean; name: string }
const TenantCtx = createContext<Tenant>({ kind: 'firm', owner: false, name: '' });
const useTenant = () => useContext(TenantCtx);
/** Company details may be changed by the owner, or by an accounting firm's Administrator for its clients. */
const canEditDetails = (x: Tenant) => x.owner || x.kind === 'firm';

export function AdminConsole({ me, path, onSignOut, owner }: { me: Me; path: string; onSignOut: () => void; owner?: boolean }) {
  const { t } = useI18n();
  const settings = useApi<{ firmName: string; kind: 'firm' | 'company'; owner: boolean }>('/api/admin/settings');
  const tenant: Tenant = { kind: settings.data?.kind ?? 'firm', owner: Boolean(settings.data?.owner), name: settings.data?.firmName ?? '' };
  const seg = path.split('/');                       // ['', 'admin', tab, id?]
  const tabs = TABS.filter((x) => !(x === 'Staff' && tenant.kind === 'company'));
  const tab = (tabs.find((x) => x.toLowerCase() === seg[2]) ?? 'Clients');
  const clientId = tab === 'Clients' && seg[3] && seg[3] !== 'new' ? seg[3] : null;
  const adding = tab === 'Clients' && seg[3] === 'new';
  const tabLabel = (x: string) => (x === 'Clients' && tenant.kind === 'company' ? t('admin.Companies') : t(`admin.${x}` as Key));
  const title = adding ? t('reg.title') : tabLabel(tab);
  if (!settings.data) return <main>{settings.error ? <ErrorNote error={settings.error} onRetry={settings.reload} /> : <Loading />}</main>;
  return (
    <div className="app">
      <Sidebar subtitle={owner ? tenant.name : t('admin.console')} user={me.user} roleLabel={owner ? t('own.role') : t('role.admin')} onSignOut={onSignOut}>
        {tabs.map((x) => (
          <button key={x} className={x === tab ? 'on' : ''} onClick={() => navigate(`/admin/${x.toLowerCase()}`)} aria-current={x === tab ? 'page' : undefined}>
            {tabLabel(x)}
          </button>
        ))}
      </Sidebar>
      <main>
        {owner && (
          <div className="notice owner-bar">
            <span>{t('own.workingIn', { name: tenant.name, kind: t(`own.kind.${tenant.kind}`) })}</span>
            <button className="b small" id="own-back" onClick={() => { setActingTenant(null); navigate('/owner'); }}>{t('own.back')}</button>
          </div>
        )}
        <div className="top">
          <h1>{clientId ? '' : title}</h1>
          <TopControls />
        </div>
        <TenantCtx.Provider value={tenant}>
        {tab === 'Staff' ? <Staff /> : tab === 'Billing' ? <AdminBilling /> : tab === 'Roles' ? <Roles /> : tab === 'Activity' ? <Activity /> : tab === 'Settings' ? <Settings />
          : adding && tenant.owner ? <AddClient /> : clientId ? <ClientPage id={clientId} /> : <Clients />}
        </TenantCtx.Provider>
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
        {useTenant().owner ? <button className="b p" id="add-client" onClick={() => navigate('/admin/clients/new')}>{t(useTenant().kind === 'company' ? 'admin.addCompany' : 'admin.addClient')}</button>
          : <span className="small mut">{t('admin.ownerAdds')}</span>}
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
/** The form keeps the chosen modules as "Restaurant,Assets"; the API takes a list. */
const toBody = (f: Fields) => ({ ...f, modules: (f.modules ?? '').split(',').filter(Boolean) });

function useCompanyCheck() {
  const { t } = useI18n();
  return (f: Fields): string | undefined => {
    const country = (f.country ?? 'SA') as Country;
    const registered = f.vatStatus !== 'unregistered';
    const v = (k: string) => (f[k] ?? '').trim();
    const missing: string[] = [];
    const need = (k: string, label: Key) => { if (!v(k)) missing.push(t(label).replace(' *', '')); };
    need('name', 'reg.name'); need('industry', 'reg.industry'); need('crNumber', `reg.cr${country}` as Key);
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
          <label className="f">{t('reg.name')}<input id="reg-name" value={v('name')}
            onChange={(e) => { const ar = followArabic(v('name'), e.target.value, v('nameAr')); set('name', e.target.value); if (ar !== v('nameAr')) set('nameAr', ar); }} /></label>
          <label className="f">{t('reg.nameAr')}<input id="reg-name-ar" value={v('nameAr')} onChange={on('nameAr')} dir="rtl" />
            <ArabicHint english={v('name')} arabic={v('nameAr')} /></label>
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
        <div className="row">
          <label className="f">{t('reg.industry')}
            <select id="reg-industry" value={v('industry')} onChange={(e) => { set('industry', e.target.value); set('modules', DEFAULT_MODULES[e.target.value as Industry]?.join(',') ?? ''); }}>
              <option value="">{t('reg.chooseIndustry')}</option>
              {INDUSTRIES.map((x) => <option key={x} value={x}>{t(`industry.${x}` as Key)}</option>)}
            </select>
          </label>
        </div>
        {v('industry') && (
          <fieldset className="modules" aria-label={t('reg.modules')}>
            <legend className="small">{t('reg.modules')}</legend>
            <div className="chips">
              {OPTIONAL_MODULES.map((m) => {
                const chosen = v('modules').split(',').filter(Boolean);
                const on = chosen.includes(m);
                return (
                  <label key={m} className={`chip ${on ? 'on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => set('modules', (on ? chosen.filter((x) => x !== m) : [...chosen, m]).join(','))} />
                    {t(`mod.${m}` as Key)}
                  </label>
                );
              })}
            </div>
            <span className="small mut">{t('reg.modulesHint')}</span>
          </fieldset>
        )}
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
  const roles = useApi<ClientRole[]>('/api/admin/roles');
  const [f, setF] = useState<Fields>({ country: 'SA', legalForm: 'LLC', vatStatus: 'registered', fyEnd: '12-31', invoicePrefix: 'INV-', paymentTermsDays: '30', userRole: '' });
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
      setDone(await api('/api/admin/companies', { body: { company: toBody(company), firstUser: { name: userName, email: userEmail, clientRoleId: userRole || firstRoleId(roles.data) }, staffIds } }));
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
            <select id="reg-user-role" value={f.userRole || firstRoleId(roles.data)} onChange={(e) => set('userRole', e.target.value)}>
              <RoleOptions roles={roles.data} />
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
  const tenantInfo = useTenant();
  const editable = canEditDetails(tenantInfo);
  const local = useLocalName();
  const check = useCompanyCheck();
  const d = useApi<ClientDetail>(`/api/admin/companies/${id}`);
  const roles = useApi<ClientRole[]>('/api/admin/roles');
  const [f, setF] = useState<Fields>();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [invite, setInvite] = useState<Invite>();
  const [nu, setNu] = useState({ name: '', email: '', role: '' });
  const [nuError, setNuError] = useState<string>();
  const [ticks, setTicks] = useState<Record<string, boolean>>({});   // shown at once, confirmed by the server
  useEffect(() => setTicks({}), [d.data]);

  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const c = d.data.company;
  const fields: Fields = f ?? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']));
  const suspended = c.status !== 'active';

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); d.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const problem = check(fields);
    if (problem) { setMsg({ bad: problem }); return; }
    void run(async () => { await api(`/api/admin/companies/${id}`, { body: { company: toBody(fields) } }); setF(undefined); }, t('admin.saved'));
  };
  const addUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!nu.name.trim() || !nu.email.trim()) { setNuError(t('err.nameEmail')); return; }
    if (!EMAIL.test(nu.email.trim())) { setNuError(t('v.email')); return; }
    setNuError(undefined);
    setBusy(true);
    try {
      const r = await api<{ invite: Invite }>(`/api/admin/companies/${id}/users`, { body: { name: nu.name, email: nu.email, clientRoleId: nu.role || firstRoleId(roles.data) } });
      setInvite(r.invite); setNu({ name: '', email: '', role: '' }); d.reload();
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
        {!editable ? null : suspended
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
        <PeopleTable people={d.data.users} onChanged={d.reload} onInvite={setInvite}
          roleOf={(u) => (
            <select aria-label={t('admin.role')} value={u.clientRoleId ?? ''} disabled={busy}
              onChange={(e) => void run(() => api(`/api/admin/companies/${id}/users/${u.id}/role`, { body: { clientRoleId: e.target.value } }), t('admin.roleChanged', { name: u.name }))}>
              {!u.clientRoleId && <option value="">{t(`role.${u.role}` as Key)}</option>}
              <RoleOptions roles={roles.data} current={u.clientRoleId} />
            </select>
          )} />
        <div className="small mut" style={{ marginTop: 6 }}>{t('admin.rolesHint')} <a href="/admin/roles" onClick={(e) => { e.preventDefault(); navigate('/admin/roles'); }}>{t('admin.Roles')}</a></div>
        <form onSubmit={addUser} style={{ marginTop: 12 }}>
          <b className="small">{t('admin.addClientUser')}</b>
          {nuError && <div className="small bad">{nuError}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <label className="f">{t('reg.firstUserName')}<input id="nu-name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></label>
            <label className="f">{t('reg.firstUserEmail')}<input id="nu-email" type="email" dir="ltr" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></label>
            <label className="f">{t('reg.firstUserRole')}
              <select id="nu-role" value={nu.role || firstRoleId(roles.data)} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                <RoleOptions roles={roles.data} />
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
        {!editable && <div className="notice small">{t('admin.detailsByOwner')}</div>}
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
          <CompanyForm f={fields} set={(k, v) => setF((cur) => ({ ...(cur ?? fields), [k]: v }))} editing />
          {editable && <button className="b p" type="submit" disabled={busy || !f}>{t('admin.saveDetails')}</button>}
        </fieldset>
      </form>
    </>
  );
}

/** People with sign-in state and actions: new sign-in link, reset two-factor, suspend/reactivate. */
function PeopleTable<P extends { id: string; name: string; email: string; status: string; invitePending: boolean | null; passwordSet: boolean; twoFactor: boolean }>(
  { people, roleOf, extra, onChanged, onInvite }: {
    people: P[]; roleOf: (p: P) => React.ReactNode; extra?: (p: P) => React.ReactNode; onChanged: () => void; onInvite: (i: Invite) => void;
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

// ------------------------------------------------------------------ Roles and permissions (client users)
interface ClientRole {
  id: string; name: string; nameAr: string | null; description: string | null;
  permissions: Record<string, AccessLevel>; canApprove: boolean; canReview: boolean; canSignOff: boolean; posMode: boolean; status: 'active' | 'archived'; users: number;
}
/** The role offered first when adding a person: the active role that enters in the most modules (usually Client accountant). */
const firstRoleId = (roles?: ClientRole[]) => {
  const edits = (r: ClientRole) => Object.values(r.permissions).filter((v) => v === 'edit').length;
  return [...(roles ?? [])].filter((r) => r.status === 'active').sort((x, y) => edits(y) - edits(x))[0]?.id ?? '';
};

function RoleOptions({ roles, current }: { roles?: ClientRole[]; current?: string | null }) {
  const local = useLocalName();
  return <>{(roles ?? []).filter((r) => r.status === 'active' || r.id === current).map((r) => <option key={r.id} value={r.id}>{local(r.name, r.nameAr)}</option>)}</>;
}

function AccessSummary({ permissions }: { permissions: Record<string, AccessLevel> }) {
  const { t } = useI18n();
  const list = ROLE_MODULES.filter((m) => permissions[m] === 'view' || permissions[m] === 'edit');
  if (!list.length) return <span className="mut small">{t('roles.noModules')}</span>;
  return (
    <span className="chips">
      {list.map((m) => <span key={m} className={`badge ${permissions[m] === 'edit' ? 'good' : ''}`}>{t(`mod.${m}` as Key)} · {t(`access.${permissions[m]}` as Key)}</span>)}
    </span>
  );
}

type RoleDraft = { id?: string; name: string; nameAr: string; description: string; permissions: Record<string, AccessLevel>; canApprove: boolean; canReview: boolean; canSignOff: boolean; posMode: boolean; status: 'active' | 'archived' };
const emptyRole = (): RoleDraft => ({ name: '', nameAr: '', description: '', permissions: {}, canApprove: false, canReview: false, canSignOff: false, posMode: false, status: 'active' });

function Roles() {
  const { t, has } = useI18n();
  const local = useLocalName();
  const list = useApi<ClientRole[]>('/api/admin/roles');
  const [edit, setEdit] = useState<RoleDraft>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;

  const save = async (draft: RoleDraft, ok: string) => {
    if (!draft.name.trim()) { setMsg({ bad: t('err.roleName') }); return; }
    setBusy(true); setMsg({});
    try {
      const body = { name: draft.name, nameAr: draft.nameAr, description: draft.description, permissions: draft.permissions, canApprove: draft.canApprove, canReview: draft.canReview, canSignOff: draft.canSignOff, posMode: draft.posMode, status: draft.status };
      await api(draft.id ? `/api/admin/roles/${draft.id}` : '/api/admin/roles', { body });
      setEdit(undefined); setMsg({ ok }); list.reload();
    } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const setAll = (level: AccessLevel) => edit && setEdit({ ...edit, permissions: Object.fromEntries(ROLE_MODULES.map((m) => [m, level])) });

  const form = edit && (
    <form className="card inset" id="role-form" onSubmit={(e) => { e.preventDefault(); void save(edit, t('roles.saved', { role: edit.name })); }}>
      <h2>{edit.id ? t('roles.editTitle', { role: edit.name }) : t('roles.new')}</h2>
      <div className="row">
        <label className="f">{t('roles.title')}<input id="role-name" value={edit.name} placeholder={t('roles.titleExample')}
          onChange={(e) => setEdit({ ...edit, name: e.target.value, nameAr: followArabic(edit.name, e.target.value, edit.nameAr) })} /></label>
        <label className="f">{t('ar.nameAr')}<input id="role-name-ar" dir="rtl" value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} />
          <ArabicHint english={edit.name} arabic={edit.nameAr} /></label>
      </div>
      <label className="f">{t('roles.description')}<input id="role-desc" value={edit.description} placeholder={t('roles.descriptionExample')} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
      <div className="actions" style={{ margin: '10px 0 6px' }}>
        <b className="small" style={{ flex: '1 1 auto' }}>{t('roles.accessTitle')}</b>
        <button type="button" className="b small" onClick={() => setAll('none')}>{t('roles.allNone')}</button>
        <button type="button" className="b small" onClick={() => setAll('view')}>{t('roles.allView')}</button>
        <button type="button" className="b small" onClick={() => setAll('edit')}>{t('roles.allEdit')}</button>
      </div>
      <div className="wrap">
        <table className="perm">
          <thead><tr><th>{t('roles.module')}</th>{(['none', 'view', 'edit'] as const).map((l) => <th key={l} className="c">{t(`access.${l}`)}</th>)}</tr></thead>
          <tbody>
            {ROLE_MODULES.map((m) => {
              const cur = edit.permissions[m] ?? 'none';
              return (
                <tr key={m}>
                  <td>{t(`mod.${m}` as Key)}<div className="small mut">{t(`roles.about.${m}` as Key)}</div></td>
                  {(['none', 'view', 'edit'] as const).map((l) => (
                    <td key={l} className="c">
                      <input type="radio" name={`perm-${m}`} id={`perm-${m}-${l}`} aria-label={`${t(`mod.${m}` as Key)}: ${t(`access.${l}`)}`} checked={cur === l}
                        onChange={() => setEdit({ ...edit, permissions: { ...edit.permissions, [m]: l } })} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="check-one" style={{ marginTop: 10 }}>
        <input type="checkbox" id="role-approve" checked={edit.canApprove} onChange={(e) => setEdit({ ...edit, canApprove: e.target.checked })} />
        {t('roles.canApprove')}
      </label>
      <label className="check-one" style={{ marginTop: 6 }}>
        <input type="checkbox" id="role-review" checked={edit.canReview} onChange={(e) => setEdit({ ...edit, canReview: e.target.checked, canSignOff: e.target.checked && edit.canSignOff })} />
        {t('roles.canReview')}
      </label>
      <label className="check-one" style={{ marginTop: 6 }}>
        <input type="checkbox" id="role-signoff" checked={edit.canSignOff} disabled={!edit.canReview} onChange={(e) => setEdit({ ...edit, canSignOff: e.target.checked })} />
        {t('roles.canSignOff')}
      </label>
      <label className="check-one" style={{ marginTop: 6 }}>
        <input type="checkbox" id="role-pos" checked={edit.posMode} onChange={(e) => setEdit({ ...edit, posMode: e.target.checked })} />
        <span>{t('roles.posMode')}<span className="small mut" style={{ display: 'block' }}>{t('roles.posModeHint')}</span></span>
      </label>
      <div className="small mut" style={{ margin: '4px 0 10px' }}>{t('roles.levelsHint')}</div>
      <div className="actions">
        <button className="b p" type="submit" id="role-save" disabled={busy}>{t('roles.save')}</button>
        <button className="b" type="button" onClick={() => { setEdit(undefined); setMsg({}); }}>{t('cancel')}</button>
      </div>
    </form>
  );

  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('roles.hint')}</div>
      {msg.ok && <div className="notice">{msg.ok}</div>}
      {msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}
      <div className="actions" style={{ marginBottom: 10 }}>
        <span className="spacer" />
        {!edit && <button className="b p" id="role-new" onClick={() => { setMsg({}); setEdit(emptyRole()); }}>{t('roles.new')}</button>}
      </div>
      {edit && !edit.id && form}
      <div className="card">
        <div className="wrap">
          <table className="roles">
            <thead><tr><th>{t('roles.title')}</th><th>{t('roles.access')}</th><th>{t('roles.approves')}</th><th className="num">{t('roles.people')}</th><th /></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} className={r.status === 'archived' ? 'mut' : ''}>
                  <td data-label={t('roles.title')}><b>{local(r.name, r.nameAr)}</b>{r.status === 'archived' && <> <span className="badge">{t('roles.archived')}</span></>}
                    {r.description && <div className="small mut">{r.description}</div>}</td>
                  <td data-label={t('roles.access')}><AccessSummary permissions={r.permissions} /></td>
                  <td data-label={t('roles.approves')}>{r.canApprove ? t('yes') : t('no')}{r.canSignOff ? <div className="small"><span className="badge good">{t('roles.signsOff')}</span></div> : r.canReview ? <div className="small"><span className="badge">{t('roles.reviews')}</span></div> : null}{r.posMode && <div className="small"><span className="badge">{t('roles.counter')}</span></div>}</td>
                  <td className="num" data-label={t('roles.people')}>{r.users}</td>
                  <td className="num">
                    <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="b small" disabled={busy} onClick={() => { setMsg({}); setEdit({ id: r.id, name: r.name, nameAr: r.nameAr ?? '', description: r.description ?? '', permissions: { ...r.permissions }, canApprove: r.canApprove, canReview: r.canReview, canSignOff: r.canSignOff, posMode: Boolean(r.posMode), status: r.status }); }}>{t('roles.edit')}</button>
                      {r.status === 'active'
                        ? <button className="b small" disabled={busy || r.users > 0} title={r.users > 0 ? t('err.roleInUse') : undefined}
                            onClick={() => void save({ ...r, nameAr: r.nameAr ?? '', description: r.description ?? '', status: 'archived' }, t('roles.archivedDone', { role: r.name }))}>{t('roles.archive')}</button>
                        : <button className="b small" disabled={busy}
                            onClick={() => void save({ ...r, nameAr: r.nameAr ?? '', description: r.description ?? '', status: 'active' }, t('roles.restored', { role: r.name }))}>{t('roles.restore')}</button>}
                    </span>
                  </td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={5} className="mut">{t('roles.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {edit?.id && form}
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
  const tenantInfo = useTenant();
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
        <h2>{t(tenantInfo.kind === 'company' ? 'settings.company' : 'settings.firm')}</h2>
        {msg.ok && <div className="notice">{msg.ok}</div>}
        {msg.bad && <div className="notice bad">{msg.bad}</div>}
        <div className="actions">
          <label className="f" style={{ flex: '1 1 240px' }}>{t('settings.firmName')}
            <input id="firm-name" value={name ?? s.data.firmName} disabled={!canEditDetails(tenantInfo)} onChange={(e) => setName(e.target.value)} />
          </label>
          {canEditDetails(tenantInfo) && <button className="b p" type="submit" disabled={busy || name === undefined} style={{ alignSelf: 'flex-end' }}>{t('save')}</button>}
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
