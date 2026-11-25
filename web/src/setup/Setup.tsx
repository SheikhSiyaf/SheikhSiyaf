// The guided first-run setup and the page guides. The setup is a short, skippable, resumable wizard shown to the person who keeps the books
// while the customer is in its free trial: what the business is and wants (which switches on the modules it needs), the accounts a business
// like it usually has, then bringing its data (the ordinary import, with a preview) or starting fresh, and finally its first invoice.
// The guide is a "?" button on every page that explains the page in plain words. Nothing here posts anything by itself.
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { TopControls, errorText } from '../ui.tsx';
import { ImportData } from '../books/ImportData.tsx';
import { BUSINESS_TYPES, GOALS, modulesForGoals, industryRows, GUIDE_PAGES, type BusinessType } from '../../../src/books/setupRules.ts';
import { IMPORT_KINDS, type ImportKind } from '../../../src/books/importRules.ts';

export interface SetupState {
  step: 'about' | 'chart' | 'data' | 'done'; businessType: BusinessType | null; goals: string[]; dataChoice: 'import' | 'fresh' | null;
  skipped: boolean; completed: boolean; tourSeen: string[]; inTrial: boolean; show: boolean; companies: { id: string; name: string; modules: string[] }[];
}
interface SetupReply { setup: SetupState | null; extractEnabled: boolean }
const ORDER = ['about', 'chart', 'data', 'done'] as const;
export const openSetup = () => window.dispatchEvent(new Event('nb:open-setup'));

/** Shows the wizard by itself while it is due, or when asked (the "run the setup again" link in the guide). */
export function SetupGate({ books, onChanged }: { books: CompanyBooks; onChanged: () => void }) {
  const info = useApi<SetupReply>('/api/setup');
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Once the wizard is on screen it stays until closed: saving a step re-reads the setup, and that must not close it or reset its step.
  const [active, setActive] = useState(false);
  const first = useRef<SetupState | null>(null);
  useEffect(() => { const on = () => { setDismissed(false); setOpen(true); }; window.addEventListener('nb:open-setup', on); return () => window.removeEventListener('nb:open-setup', on); }, []);
  const s = info.data?.setup;
  const due = Boolean(s?.show && books.canPost && !dismissed);
  useEffect(() => { if ((due || open) && s && !first.current) { first.current = s; setActive(true); } }, [due, open, s]);
  if (!active || !first.current) return null;
  return <Wizard books={books} setup={first.current} extractEnabled={Boolean(info.data?.extractEnabled)} onChanged={() => { info.reload(); onChanged(); }}
    onClose={() => { first.current = null; setActive(false); setOpen(false); setDismissed(true); info.reload(); }} />;
}

function Wizard({ books, setup, onChanged, onClose }: { books: CompanyBooks; setup: SetupState; extractEnabled: boolean; onChanged: () => void; onClose: () => void }) {
  const { t, has, lang } = useI18n();
  const [step, setStep] = useState<(typeof ORDER)[number]>(setup.step === 'done' ? 'about' : setup.step);
  const [type, setType] = useState<BusinessType | null>(setup.businessType);
  const [goals, setGoals] = useState<string[]>(setup.goals);
  const [choice, setChoice] = useState<'import' | 'fresh' | null>(setup.dataChoice);
  const [kind, setKind] = useState<ImportKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [added, setAdded] = useState<number>();
  const [noRights, setNoRights] = useState(false);
  const n = ORDER.indexOf(step) + 1;
  const goal = (g: string) => (has(`wiz.goal.${g}`) ? t(`wiz.goal.${g}` as Key) : g);
  const modName = (m: string) => (has(`mod.${m}`) ? t(`mod.${m}` as Key) : m);
  const save = async (to: (typeof ORDER)[number], extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr(undefined);
    try {
      await api('/api/setup', { body: { step: to, ...(type ? { businessType: type } : {}), ...(goals.length ? { goals } : {}), ...(choice ? { dataChoice: choice } : {}), ...extra } });
      setStep(to); onChanged();
    } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const skip = async () => { await save(step, { skip: true }); onClose(); };
  const wanted = modulesForGoals(goals).filter((m) => !(books.company.modules ?? []).includes(m));
  const rows = type ? industryRows(type).slice(1) : [];
  const addAccounts = async () => {
    setBusy(true); setErr(undefined); setNoRights(false);
    try { const r = await api<{ added: number }>(`/api/companies/${books.company.id}/setup/chart`, { body: { businessType: type } }); setAdded(r.added); }
    catch (e) { if ((e as { key?: string }).key === 'err.roleNoAccess') setNoRights(true); else setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  return (
    <div className="wiz-back" id="wiz" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
      <div className="wiz">
        <div className="wiz-head">
          <div><h2 id="wiz-title">{t('wiz.title')}</h2><p className="small mut">{t('wiz.sub')}</p></div>
          <div className="wiz-tools"><TopControls /></div>
          <button className="link" id="wiz-close" aria-label={t('guide.close')} onClick={onClose}>✕</button>
        </div>
        <ol className="wiz-steps" aria-label={t('wiz.step', { n, total: 4 })}>
          {ORDER.map((s, i) => <li key={s} className={s === step ? 'on' : i < n - 1 ? 'past' : ''} aria-current={s === step ? 'step' : undefined}><span>{i + 1}</span>{t(`wiz.s.${s}` as Key)}</li>)}
        </ol>
        {err && <div className="notice bad" role="alert" id="wiz-error">{err}</div>}

        {step === 'about' && (
          <div id="wiz-about">
            <h3>{t('wiz.about.type')}</h3>
            <div className="wiz-choices" role="radiogroup" aria-label={t('wiz.about.type')}>{BUSINESS_TYPES.map((b) => (
              <button key={b} id={`wiz-type-${b}`} role="radio" aria-checked={type === b} className={`wiz-opt${type === b ? ' on' : ''}`} onClick={() => setType(b)}>{t(`wiz.type.${b}` as Key)}</button>))}</div>
            <h3>{t('wiz.about.goals')}</h3>
            <p className="small mut">{t('wiz.about.goalsHint')}</p>
            <div className="wiz-goals">{GOALS.map((g) => (
              <label key={g} className="check"><input type="checkbox" id={`wiz-goal-${g}`} checked={goals.includes(g)} onChange={() => setGoals(goals.includes(g) ? goals.filter((x) => x !== g) : [...goals, g])} />{goal(g)}</label>))}</div>
            {goals.length > 0 && <p className="notice" id="wiz-switch">{wanted.length ? t('wiz.about.switchOn', { list: wanted.map(modName).join(', ') }) : t('wiz.about.switchNone')}</p>}
            <div className="actions">
              <button className="b p" id="wiz-next" disabled={busy || !type} onClick={() => void save('chart')}>{t('wiz.next')}</button>
              {!type && <span className="small mut">{t('wiz.needType')}</span>}
            </div>
          </div>)}

        {step === 'chart' && (
          <div id="wiz-chart">
            <h3>{t('wiz.chart.title')}</h3>
            {rows.length === 0 ? <p>{t('wiz.chart.none')}</p> : <>
              <p>{t('wiz.chart.body', { type: t(`wiz.type.${type!}` as Key).toLowerCase() })}</p>
              <ul className="wiz-accounts">{rows.map((r) => <li key={r[0]}><b className="ltr">{r[0]}</b> {lang === 'ar' ? r[2] : r[1]} <span className="small mut">({r[3]})</span></li>)}</ul></>}
            {added !== undefined && <p className="notice" id="wiz-added">{t('wiz.chart.added', { n: added })}</p>}
            {noRights && <p className="notice warn" id="wiz-norights">{t('wiz.chart.noRights')}</p>}
            <div className="actions">
              {rows.length > 0 && added === undefined && <button className="b p" id="wiz-add" disabled={busy} onClick={() => void addAccounts()}>{t('wiz.chart.add')}</button>}
              <button className={`b${rows.length === 0 || added !== undefined ? ' p' : ''}`} id="wiz-next" disabled={busy} onClick={() => void save('data')}>{rows.length > 0 && added === undefined ? t('wiz.chart.skip') : t('wiz.next')}</button>
              <button className="b" id="wiz-back" disabled={busy} onClick={() => setStep('about')}>{t('wiz.back')}</button>
            </div>
          </div>)}

        {step === 'data' && (
          <div id="wiz-data">
            <h3>{t('wiz.data.title')}</h3>
            {choice !== 'import' && <>
              <p>{t('wiz.data.body')}</p>
              <div className="wiz-choices">
                <button id="wiz-import" className="wiz-opt" onClick={() => setChoice('import')}><b>{t('wiz.data.import')}</b><small>{t('wiz.data.importHint')}</small></button>
                <button id="wiz-fresh" className="wiz-opt" onClick={() => { setChoice('fresh'); void save('done', { dataChoice: 'fresh' }); }}><b>{t('wiz.data.fresh')}</b><small>{t('wiz.data.freshHint')}</small></button>
              </div></>}
            {choice === 'import' && !kind && (
              <div className="wiz-choices" id="wiz-kinds">{IMPORT_KINDS.map((k) => <button key={k} id={`wiz-kind-${k}`} className="wiz-opt" onClick={() => setKind(k)}><b>{t(`imp.k.${k}` as Key)}</b><small>{t(`imp.kHint.${k}` as Key)}</small></button>)}</div>)}
            {choice === 'import' && kind && <div id="wiz-import-box"><ImportData books={books} initial={kind} only /></div>}
            <div className="actions">
              {choice === 'import' && <button className="b p" id="wiz-next" disabled={busy} onClick={() => void save('done', { dataChoice: 'import' })}>{t('wiz.next')}</button>}
              {choice === 'import' && kind && <button className="b" id="wiz-kinds-back" onClick={() => setKind(null)}>{t('wiz.data.back')}</button>}
              {choice === 'import' && !kind && <button className="b" id="wiz-choice-back" onClick={() => setChoice(null)}>{t('wiz.data.back')}</button>}
              <button className="b" id="wiz-back" disabled={busy} onClick={() => setStep('chart')}>{t('wiz.back')}</button>
            </div>
          </div>)}

        {step === 'done' && (
          <div id="wiz-done">
            <h3>{t('wiz.done.title')}</h3>
            <p>{t('wiz.done.body')}</p>
            <div className="actions">
              <button className="b p big" id="wiz-invoice" onClick={() => { void api('/api/setup', { body: { step: 'done', done: true } }).then(onChanged, () => undefined); onClose(); navigate(`/c/${books.company.id}/Sales/invoices`); }}>{t('wiz.done.invoice')}</button>
              <button className="b" id="wiz-tour" onClick={() => { void api('/api/setup', { body: { step: 'done', done: true } }).then(onChanged, () => undefined); onClose(); window.dispatchEvent(new Event('nb:open-guide')); }}>{t('wiz.done.tour')}</button>
              <button className="b" id="wiz-finish" onClick={() => { void api('/api/setup', { body: { step: 'done', done: true } }).then(onChanged, () => undefined); onClose(); }}>{t('wiz.done.close')}</button>
            </div>
          </div>)}

        {step !== 'done' && <p className="wiz-skip small"><button className="link" id="wiz-skip" disabled={busy} onClick={() => void skip()}>{t('wiz.skip')}</button> <span className="mut">{t('wiz.skipHint')}</span></p>}
      </div>
    </div>
  );
}

/** The "?" button on every page: opens a short guide to this module in plain words, once flagged as seen for the owner's record. */
export function GuideButton({ guide, trial }: { guide: string; trial?: boolean }) {
  const { t, has } = useI18n();
  const info = useApi<SetupReply>('/api/setup');
  const [open, setOpen] = useState(false);
  useEffect(() => { const on = () => setOpen(true); window.addEventListener('nb:open-guide', on); return () => window.removeEventListener('nb:open-guide', on); }, []);
  useEffect(() => { setOpen(false); }, [guide]);
  const s = info.data?.setup;
  if (!s || !(GUIDE_PAGES as readonly string[]).includes(guide) || !has(`tour.${guide}.title`)) return null;
  const unseen = !s.tourSeen.includes(guide);
  const show = () => { setOpen(true); if (unseen) void api('/api/setup/tour', { body: { page: guide } }).then(info.reload, () => undefined); };
  return (
    <>
      <button className={`b guide-btn${unseen ? ' new' : ''}`} id="guide-btn" aria-label={t('guide.button')} title={t('guide.button')} onClick={show}>?</button>
      {open && (
        <aside className="guide" id="guide-panel" role="dialog" aria-labelledby="guide-title">
          <div className="guide-head"><h2 id="guide-title">{t(`tour.${guide}.title` as Key)}</h2><button className="link" id="guide-close" aria-label={t('guide.close')} onClick={() => setOpen(false)}>✕</button></div>
          <p>{t(`tour.${guide}.body` as Key)}</p>
          <p className="guide-try"><b>{t('guide.tryIt')}:</b> {t(`tour.${guide}.try` as Key)}</p>
          {(trial ?? s.inTrial) && <p className="small mut">{t('guide.trial')}</p>}
          <p className="small mut">{t('guide.contact')}</p>
          {s.inTrial && <button className="link small" id="guide-setup" onClick={() => { setOpen(false); openSetup(); }}>{t('wiz.again')}</button>}
        </aside>)}
    </>
  );
}
