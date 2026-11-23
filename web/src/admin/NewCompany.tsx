// Add customer, "Company own accounts": ONE customer with ONE company, made in a single save. Three steps and no more
// screens: the company's details, its people (each with a job title that sets what they can open), then a review. The
// owner never sees an "add companies" page for this kind of customer; that belongs to accounting firms only.
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { Loading, errorText, type Invite } from '../ui.tsx';
import { CompanyForm, toBody, useCompanyCheck, type Fields } from './AdminConsole.tsx';
import { holdInvites } from './pendingInvites.ts';

const TITLES = ['Owner', 'Finance', 'Sales', 'Commercial', 'Client accountant', 'Client management'] as const;
type Title = (typeof TITLES)[number] | 'Administrator';   // 'Administrator' is the company's separate admin login, not a job title
const ALL_TITLES: Title[] = ['Administrator', ...TITLES];
interface Person { name: string; email: string; jobTitle: Title }
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CURRENCY = { SA: 'SAR', AE: 'AED', OM: 'OMR' } as const;

export interface Created { id: string; name: string; companyId: string }

export function NewCompanyCustomer({ onCancel, onCreated }: { onCancel: () => void; onCreated: (c: Created) => void }) {
  const { t, has } = useI18n();
  const check = useCompanyCheck();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [f, setF] = useState<Fields>({ country: 'SA', legalForm: 'LLC', vatStatus: 'registered', fyEnd: '12-31', invoicePrefix: 'INV-', paymentTermsDays: '30' });
  const [people, setPeople] = useState<Person[]>([{ name: '', email: '', jobTitle: 'Administrator' }, { name: '', email: '', jobTitle: 'Owner' }]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setPerson = (i: number, patch: Partial<Person>) => setPeople((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const peopleProblem = (): string | undefined => {
    for (const p of people) {
      if (!p.name.trim() || !p.email.trim()) return t('err.nameEmail');
      if (!EMAIL.test(p.email.trim())) return t('v.email');
    }
    if (new Set(people.map((p) => p.email.trim().toLowerCase())).size !== people.length) return t('err.sameEmail');
    if (!people.some((p) => p.jobTitle === 'Administrator')) return t('err.companyAdmin');
    if (!people.some((p) => p.jobTitle !== 'Administrator')) return t('err.companyUsers');
    return undefined;
  };

  const next = (e: FormEvent) => {
    e.preventDefault();
    const problem = step === 1 ? check(f) : step === 2 ? peopleProblem() : undefined;
    setError(problem);
    if (problem) { window.scrollTo(0, 0); return; }
    if (step < 3) { setStep((step + 1) as 2 | 3); window.scrollTo(0, 0); return; }
    void create();
  };

  const create = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ id: string; companyId: string; invites: (Invite & { jobTitle: string })[] }>('/api/owner/customers/company', {
        body: { company: toBody(f), users: people.map((p) => ({ name: p.name.trim(), email: p.email.trim(), jobTitle: p.jobTitle })) },
      });
      holdInvites(r.companyId, r.invites);
      onCreated({ id: r.id, name: f.name!.trim(), companyId: r.companyId });
    } catch (err) {
      setError(errorText(t, has, err));
      window.scrollTo(0, 0);
    } finally { setBusy(false); }
  };

  const steps: [1 | 2 | 3, Key][] = [[1, 'own.w.step1'], [2, 'own.w.step2'], [3, 'own.w.step3']];
  const country = (f.country ?? 'SA') as keyof typeof CURRENCY;
  const endMonth = Number((f.fyEnd || '12-31').slice(0, 2));
  const startMonth = endMonth === 12 ? 1 : endMonth + 1;

  return (
    <form onSubmit={next} noValidate id="own-company-wizard">
      <ol className="small" aria-label={t('own.w.steps')} style={{ display: 'flex', gap: 14, listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
        {steps.map(([n, k]) => <li key={n} aria-current={n === step ? 'step' : undefined} className={n === step ? '' : 'mut'} style={{ fontWeight: n === step ? 700 : 400 }}>{n}. {t(k)}</li>)}
      </ol>
      {error && <div className="notice bad" role="alert" id="own-w-error">{error}</div>}

      {step === 1 && (
        <>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('own.w.hint1')}</div>
          <CompanyForm f={f} set={set} fyStart />
        </>
      )}

      {step === 2 && (
        <div className="card">
          <h2>{t('own.w.step2')}</h2>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('own.w.hint2')}</div>
          {people.map((p, i) => (
            <div key={i} className="inset" style={{ marginBottom: 10 }}>
              <div className="row">
                <label className="f">{t('own.w.name')}<input id={`own-w-name-${i}`} value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} /></label>
                <label className="f">{t('own.w.email')}<input id={`own-w-email-${i}`} type="email" dir="ltr" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} /></label>
                <label className="f">{t('own.w.jobTitle')}
                  <select id={`own-w-title-${i}`} value={p.jobTitle} onChange={(e) => setPerson(i, { jobTitle: e.target.value as Title })}>
                    {ALL_TITLES.map((x) => <option key={x} value={x}>{t(`own.w.title.${x}` as Key)}</option>)}
                  </select>
                </label>
              </div>
              <div className="small mut">{t(`own.w.about.${p.jobTitle}` as Key)}</div>
              {people.length > 1 && <div className="actions" style={{ marginTop: 6 }}><button type="button" className="b small" onClick={() => setPeople((xs) => xs.filter((_, j) => j !== i))}>{t('own.w.remove')}</button></div>}
            </div>
          ))}
          <button type="button" className="b" id="own-w-add-user" onClick={() => setPeople((xs) => [...xs, { name: '', email: '', jobTitle: 'Sales' }])}>{t('own.w.addUser')}</button>
        </div>
      )}

      {step === 3 && (
        <>
          <div className="card" id="own-w-review">
            <h2>{t('own.w.step3')}</h2>
            <div className="small mut" style={{ marginBottom: 8 }}>{t('own.w.hint3')}</div>
            <table className="stack"><tbody>
              <tr><th>{t('reg.name')}</th><td><b>{f.name}</b>{f.nameAr ? <> · <span dir="rtl">{f.nameAr}</span></> : null}</td></tr>
              <tr><th>{t('reg.country')}</th><td>{t(`country.${country}` as Key)} · {CURRENCY[country]}</td></tr>
              <tr><th>{t('reg.legalForm')}</th><td>{t(`lf.${f.legalForm || 'LLC'}` as Key)}</td></tr>
              <tr><th>{t(`reg.cr${country}` as Key)}</th><td className="ltr">{f.crNumber}</td></tr>
              <tr><th>{t(`reg.vatNumber${country}` as Key)}</th><td className="ltr">{f.vatStatus === 'unregistered' ? t('reg.vatUnregistered') : f.vatNumber}</td></tr>
              <tr><th>{t('reg.addressLine')}</th><td>{f.address}, {f.city}</td></tr>
              {(f.email || f.phone) && <tr><th>{t('own.w.contact')}</th><td className="ltr">{[f.email, f.phone].filter(Boolean).join(' · ')}</td></tr>}
              <tr><th>{t('reg.fyStart')}</th><td>1 {t(`month.${startMonth}` as Key)}</td></tr>
              <tr><th>{t('reg.industry')}</th><td>{f.industry ? t(`industry.${f.industry}` as Key) : ''}</td></tr>
              <tr><th>{t('reg.modules')}</th><td>{(f.modules ?? '').split(',').filter(Boolean).map((m) => t(`mod.${m}` as Key)).join(', ') || '—'}</td></tr>
            </tbody></table>
          </div>
          <div className="card">
            <h2>{t('own.w.step2')}</h2>
            <table className="stack">
              <thead><tr><th>{t('own.w.name')}</th><th>{t('own.w.email')}</th><th>{t('own.w.jobTitle')}</th></tr></thead>
              <tbody>{people.map((p, i) => <tr key={i}><td>{p.name}</td><td className="ltr">{p.email}</td><td>{t(`own.w.title.${p.jobTitle}` as Key)}</td></tr>)}</tbody>
            </table>
            <div className="small mut" style={{ marginTop: 8 }}>{t('own.w.noEmail')}</div>
          </div>
        </>
      )}

      <div className="actions">
        {step > 1 && <button type="button" className="b" id="own-w-back" disabled={busy} onClick={() => { setError(undefined); setStep((step - 1) as 1 | 2); window.scrollTo(0, 0); }}>{t('own.w.back')}</button>}
        <button className="b p" id="own-w-next" disabled={busy}>{step === 3 ? t('own.create') : t('own.w.next')}</button>
        <button type="button" className="b" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
        {busy && <Loading />}
      </div>
    </form>
  );
}
