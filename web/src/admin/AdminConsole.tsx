// Administrator console: separate from the books. Clients (total, search, add), Add client page, Staff.
import { useState, type FormEvent } from 'react';
import { api, useApi, type Me } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { ErrorNote, Loading, Sidebar, TopControls, errorText } from '../ui.tsx';

interface ClientRow {
  id: string; name: string; nameAr: string | null; country: 'SA' | 'AE' | 'OM'; currency: string; crNumber: string;
  vatStatus: string; vatNumber: string | null; vatRate: string; city: string; clientUsers: number; staff: string[];
}
interface StaffRow { id: string; name: string; email: string; role: string; twoFactor: boolean; clients: string[] }

export function AdminConsole({ me, path, onSignOut }: { me: Me; path: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const tab = path.startsWith('/admin/staff') ? 'Staff' : 'Clients';
  const adding = path === '/admin/clients/new';
  const title = adding ? t('reg.title') : t(`admin.${tab}` as Key);
  return (
    <div className="app">
      <Sidebar subtitle={t('admin.console')} user={me.user} roleLabel={t('role.admin')} onSignOut={onSignOut}>
        {(['Clients', 'Staff'] as const).map((x) => (
          <button key={x} className={x === tab ? 'on' : ''} onClick={() => navigate(`/admin/${x.toLowerCase()}`)}>{t(`admin.${x}`)}</button>
        ))}
      </Sidebar>
      <main>
        <div className="top">
          <h1>{title}</h1>
          <TopControls />
        </div>
        {tab === 'Staff' ? <Staff /> : adding ? <AddClient /> : <Clients />}
      </main>
    </div>
  );
}

function Clients() {
  const { t } = useI18n();
  const local = useLocalName();
  const list = useApi<ClientRow[]>('/api/admin/companies');
  const [q, setQ] = useState('');
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const needle = q.trim().toLowerCase();
  const rows = list.data.filter((c) => !needle || [c.name, c.nameAr, c.crNumber, c.vatNumber, c.country, c.city].join(' ').toLowerCase().includes(needle));
  return (
    <>
      <div className="grid">
        <div className="card fig"><small>{t('admin.totalClients')}</small><b>{list.data.length}</b></div>
      </div>
      <div className="top" style={{ marginBottom: 10 }}>
        <input type="search" placeholder={t('admin.searchClients')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px' }} aria-label={t('search')} />
        <button className="b p" onClick={() => navigate('/admin/clients/new')}>{t('admin.addClient')}</button>
      </div>
      <div className="card">
        <div className="wrap">
          <table>
            <thead><tr><th>{t('col.client')}</th><th>{t('col.country')}</th><th>{t('admin.crNo')}</th><th>{t('col.vat')}</th><th className="num">{t('admin.clientUsers')}</th><th>{t('admin.staffAssigned')}</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{local(c.name, c.nameAr)}<div className="mut small">{c.city} · {c.currency} · {Number(c.vatRate)}%</div></td>
                  <td>{t(`country.${c.country}`)}</td>
                  <td className="ltr">{c.crNumber}</td>
                  <td className="ltr">{c.vatStatus === 'unregistered' ? <span className="badge warn">{t('admin.unregistered')}</span> : c.vatNumber}</td>
                  <td className="num">{c.clientUsers}</td>
                  <td className="small">{c.staff.join(', ') || <span className="mut">—</span>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="mut">{t('admin.noMatch')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mut small">{t('admin.neverBooks')}</p>
    </>
  );
}

function Staff() {
  const { t } = useI18n();
  const list = useApi<StaffRow[]>('/api/admin/staff');
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <div className="card">
      <h2>{t('admin.staffTitle')} ({list.data.length})</h2>
      <div className="mut small" style={{ marginBottom: 8 }}>{t('admin.staffHint')}</div>
      <div className="wrap">
        <table>
          <thead><tr><th>{t('col.name')}</th><th>{t('reg.firstUserRole')}</th><th>{t('admin.clientsHandled')}</th><th>{t('admin.twoFactor')}</th></tr></thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<div className="mut small ltr">{s.email}</div></td>
                <td>{t(`role.${s.role}` as Key)}</td>
                <td className="small">{s.clients.join(', ') || <span className="mut">—</span>}</td>
                <td>{s.twoFactor ? <span className="badge good">{t('admin.on')}</span> : <span className="badge warn">{t('admin.off')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LEGAL_FORMS = ['LLC', 'Sole establishment', 'Joint stock company', 'Partnership', 'Branch of foreign company', 'Other'] as const;
const DERIVED = { SA: { currency: 'SAR', rate: 15 }, AE: { currency: 'AED', rate: 5 }, OM: { currency: 'OMR', rate: 5 } } as const;
type Country = keyof typeof DERIVED;

function AddClient() {
  const { t, has } = useI18n();
  const staff = useApi<StaffRow[]>('/api/admin/staff');
  const [f, setF] = useState<Record<string, string>>({ country: 'SA', legalForm: 'LLC', vatStatus: 'registered', fyEnd: '12-31', invoicePrefix: 'INV-', paymentTermsDays: '30', userRole: 'client_accountant' });
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [doneId, setDoneId] = useState<string>();
  const v = (k: string) => f[k] ?? '';
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const country = v('country') as Country;
  const registered = v('vatStatus') === 'registered';

  // Same checks as the database, shown before sending (prevent errors instead of reporting them).
  const validate = (): string | undefined => {
    const missing: string[] = [];
    const need = (k: string, label: Key) => { if (!v(k).trim()) missing.push(t(label).replace(' *', '')); };
    need('name', 'reg.name'); need('crNumber', `reg.cr${country}` as Key);
    if (registered) need('vatNumber', `reg.vatNumber${country}` as Key);
    need('address', 'reg.addressLine'); need('city', 'reg.city');
    need('userName', 'reg.firstUserName'); need('userEmail', 'reg.firstUserEmail');
    if (missing.length) return t('v.required', { fields: missing.join(', ') });
    if (country === 'SA' && !/^\d{10}$/.test(v('crNumber').trim())) return t('v.saCr');
    if (registered && country === 'SA' && !/^3\d{13}3$/.test(v('vatNumber').trim())) return t('v.saVat');
    if (registered && country === 'AE' && !/^\d{15}$/.test(v('vatNumber').trim())) return t('v.aeTrn');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('userEmail').trim())) return t('v.email');
    if (v('email').trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email').trim())) return t('v.email');
    return undefined;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem) { window.scrollTo(0, 0); return; }
    setBusy(true);
    try {
      const { userName, userEmail, userRole, ...company } = f;
      const res = await api<{ id: string }>('/api/admin/companies', {
        body: { company: { ...company, vatNumber: registered ? company.vatNumber : undefined }, firstUser: { name: userName, email: userEmail, role: userRole }, staffIds },
      });
      setDoneId(res.id);
    } catch (err) {
      setError(errorText(t, has, err));
      window.scrollTo(0, 0);
    } finally {
      setBusy(false);
    }
  };

  if (doneId) {
    return (
      <>
        <div className="notice">{t('reg.done')}</div>
        <div className="actions">
          <button className="b p" onClick={() => navigate('/admin/clients')}>{t('admin.Clients')}</button>
        </div>
      </>
    );
  }

  const lastDay = (m: number) => new Date(Date.UTC(2023, m, 0)).getUTCDate();
  return (
    <form onSubmit={submit} noValidate>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button type="button" className="b" onClick={() => navigate('/admin/clients')}>← {t('admin.Clients')}</button>
        <span className="mut small">{t('reg.required')}</span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}

      <div className="card">
        <h2>{t('reg.company')}</h2>
        <div className="row">
          <label className="f">{t('reg.name')}<input value={v('name')} onChange={set('name')} required /></label>
          <label className="f">{t('reg.nameAr')}<input value={v('nameAr')} onChange={set('nameAr')} dir="rtl" /></label>
          <label className="f">{t('reg.tradeName')}<input value={v('tradeName')} onChange={set('tradeName')} /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.country')}
            <select value={country} onChange={set('country')}>
              {(['SA', 'AE', 'OM'] as const).map((c) => <option key={c} value={c}>{t(`country.${c}`)}</option>)}
            </select>
          </label>
          <label className="f">{t('reg.legalForm')}
            <select value={v('legalForm')} onChange={set('legalForm')}>
              {LEGAL_FORMS.map((x) => <option key={x} value={x}>{t(`lf.${x}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="mut small">{t('reg.derived', { currency: DERIVED[country].currency, rate: registered ? DERIVED[country].rate : 0, einv: t(`einv.${country}`) })}</div>
      </div>

      <div className="card">
        <h2>{t('reg.tax')}</h2>
        <div className="row">
          <label className="f">{t(`reg.cr${country}` as Key)}<input value={v('crNumber')} onChange={set('crNumber')} placeholder={t(`reg.crHint${country}` as Key)} dir="ltr" required /></label>
          <label className="f">{t('reg.crExpiry')}<input type="date" value={v('crExpiry')} onChange={set('crExpiry')} /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.vatStatus')}
            <select value={v('vatStatus')} onChange={set('vatStatus')}>
              <option value="registered">{t('reg.vatRegistered')}</option>
              <option value="unregistered">{t('reg.vatUnregistered')}</option>
            </select>
          </label>
          <label className="f">{t(`reg.vatNumber${country}` as Key)}
            <input value={registered ? v('vatNumber') : ''} onChange={set('vatNumber')} disabled={!registered} placeholder={t(`reg.vatHint${country}` as Key)} dir="ltr" />
          </label>
          <label className="f">{t('reg.vatDate')}<input type="date" value={v('vatRegistrationDate')} onChange={set('vatRegistrationDate')} disabled={!registered} /></label>
        </div>
      </div>

      <div className="card">
        <h2>{t('reg.address')}</h2>
        <div className="row">
          <label className="f" style={{ flex: '2 1 260px' }}>{t('reg.addressLine')}<input value={v('address')} onChange={set('address')} required /></label>
          <label className="f">{t('reg.city')}<input value={v('city')} onChange={set('city')} required /></label>
        </div>
        <div className="row">
          <label className="f">{t('reg.phone')}<input type="tel" value={v('phone')} onChange={set('phone')} dir="ltr" /></label>
          <label className="f">{t('reg.email')}<input type="email" value={v('email')} onChange={set('email')} dir="ltr" /></label>
          <label className="f">{t('reg.website')}<input value={v('website')} onChange={set('website')} dir="ltr" /></label>
        </div>
      </div>

      <div className="card">
        <h2>{t('reg.settings')}</h2>
        <div className="row">
          <label className="f">{t('reg.fyEnd')}
            <select value={v('fyEnd')} onChange={set('fyEnd')}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const val = `${String(m).padStart(2, '0')}-${String(lastDay(m)).padStart(2, '0')}`;
                return <option key={m} value={val}>{lastDay(m)} {t(`month.${m}` as Key)}</option>;
              })}
            </select>
          </label>
          <label className="f">{t('reg.invoicePrefix')}<input value={v('invoicePrefix')} onChange={set('invoicePrefix')} dir="ltr" maxLength={12} /></label>
          <label className="f">{t('reg.paymentTerms')}<input type="number" min={0} max={365} value={v('paymentTermsDays')} onChange={set('paymentTermsDays')} /></label>
        </div>
        <label className="f">{t('reg.notes')}<textarea rows={2} value={v('complianceNotes')} onChange={set('complianceNotes')} /></label>
        <p className="mut small">{t('reg.ccLater')}</p>
      </div>

      <div className="card">
        <h2>{t('reg.people')}</h2>
        <b className="small">{t('reg.firstUser')}</b>
        <div className="row" style={{ marginTop: 6 }}>
          <label className="f">{t('reg.firstUserName')}<input value={v('userName')} onChange={set('userName')} required /></label>
          <label className="f">{t('reg.firstUserEmail')}<input type="email" value={v('userEmail')} onChange={set('userEmail')} dir="ltr" required /></label>
          <label className="f">{t('reg.firstUserRole')}
            <select value={v('userRole')} onChange={set('userRole')}>
              <option value="client_accountant">{t('role.client_accountant')}</option>
              <option value="client_viewer">{t('role.client_viewer')}</option>
            </select>
          </label>
        </div>
        <p className="mut small">{t('reg.inviteLater')}</p>
        <b className="small">{t('reg.assignStaff')}</b>
        {staff.data ? (
          <div className="row" style={{ marginTop: 6 }}>
            {staff.data.map((s) => (
              <label key={s.id} className="actions" style={{ flex: '0 1 auto' }}>
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
