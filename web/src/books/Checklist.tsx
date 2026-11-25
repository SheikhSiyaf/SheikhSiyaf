// The checklist beside the bell: a button in the top bar showing progress (3/9) and a badge while items are open. It opens a panel
// (a popover on a computer, a full-screen sheet on a phone) with the items grouped as Set up, Daily and Month end. The server decides
// which items a person receives and which tick themselves from the books; this file only shows them. The company's Administrator
// edits the list in ChecklistEditor (here for an Administrator who also uses the books, and on the Administrator's client page).
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { navigate } from '../router.ts';
import { useGo } from '../sales/common.tsx';
import { GO_MODULES, type Area, type Go, type Item, type SetupItem } from '../../../src/books/checklistRules.ts';

interface Checklist { items: Item[]; progress: { done: number; total: number; open: number }; isAdmin: boolean; today: string; month: string }
const AREAS: Area[] = ['setup', 'daily', 'month_end'];

/** The words of an item: the company's own wording (in the reader's language, falling back to English) or the built-in text. */
function useItemText() {
  const { t, has, lang } = useI18n();
  const word = (kind: 's' | 'h' | 'g', key: string): string => {
    const old = `setup.${kind}.${key}`, now = `ck.${kind}.${key}`;
    return has(old) ? t(old as Key) : has(now) ? t(now as Key) : '';
  };
  return {
    title: (x: Pick<Item, 'key' | 'title' | 'titleAr'>) => (lang === 'ar' && x.titleAr) || x.title || word('s', x.key) || x.key,
    help: (x: Pick<Item, 'key' | 'help' | 'helpAr'>) => (lang === 'ar' && x.helpAr) || x.help || word('h', x.key),
    go: (x: Pick<Item, 'key'>) => word('g', x.key) || t('ck.go'),
  };
}

function useMonthName() {
  const { lang } = useI18n();
  return (period: string) => {
    const [y, m] = period.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang === 'ar' ? 'ar-SA' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
}

function useGoTo(companyId: string) {
  const goTo = useGo(companyId);
  return (g: Go | null) => {
    if (!g) return;
    if (g.page === 'company') navigate(`/admin/clients/${companyId}`);
    else if (g.page === 'security') navigate('/security');
    else if (g.module) goTo(g.module, g.sub, g.item);
  };
}

export function ChecklistButton({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const id = books.company.id;
  const list = useApi<Checklist>(`/api/companies/${id}/checklist`);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); setEditing(false); btn.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    list.reload();
    panel.current?.focus();
    // a click outside closes the popover (on a phone the panel covers the page, so only its Close button and Escape apply)
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { const h = setInterval(list.reload, 300_000); return () => clearInterval(h); }, [list.reload]);
  const p = list.data?.progress;
  const label = p ? t('ck.btn', { done: p.done, total: p.total, open: p.open }) : t('ck.title');
  return (
    <div className="check" ref={box}>
      <button ref={btn} className="b check-btn" id="checklist-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {p && p.total > 0 && <span className="check-prog" id="checklist-progress">{p.done}/{p.total}</span>}
        {p && p.open > 0 && <span className="check-n" id="checklist-open" aria-hidden="true">{p.open}</span>}
      </button>
      {open && (
        <div className="check-menu" id="checklist-panel" role="dialog" aria-label={t('ck.title')} tabIndex={-1} ref={panel}>
          <div className="check-head">
            <b>{t('ck.title')}</b>
            {p && <span className="small mut">{t('ck.progress', { done: p.done, total: p.total })}</span>}
            <span className="spacer" />
            {list.data?.isAdmin && <button className="link small" id="checklist-edit" onClick={() => setEditing(!editing)}>{editing ? t('ck.editDone') : t('ck.edit')}</button>}
            <button className="b small" id="checklist-close" onClick={close}>{t('ck.close')}</button>
          </div>
          {list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : editing
            ? <ChecklistEditor companyId={id} onChanged={list.reload} bare />
            : <Groups companyId={id} data={list.data} reload={list.reload} onGo={() => setOpen(false)} />}
        </div>
      )}
    </div>
  );
}

function Groups({ companyId, data, reload, onGo }: { companyId: string; data: Checklist; reload: () => void; onGo: () => void }) {
  const { t, has } = useI18n();
  const text = useItemText();
  const monthName = useMonthName();
  const goTo = useGoTo(companyId);
  const [error, setError] = useState<string>();
  const base = `/api/companies/${companyId}/checklist`;
  const act = async (path: string, body: unknown) => {
    setError(undefined);
    try { await api(`${base}/${path}`, { body }); reload(); } catch (e) { setError(errorText(t, has, e)); }
  };
  const mine = data.items.filter((x) => !x.hiddenByMe && !x.hiddenForCompany);
  const hidden = data.items.filter((x) => x.hiddenByMe && !x.hiddenForCompany);
  const row = (x: Item, extra?: 'hidden') => (
    <li key={x.key} className={`check-item ${x.done ? 'done' : ''}`} data-key={x.key}>
      <input type="checkbox" id={`ck-${x.key}`} checked={x.done} disabled={x.how === 'auto' || !!extra} aria-label={text.title(x)}
        onChange={(e) => void act('tick', { key: x.key, done: e.target.checked })} />
      <span className="check-text">
        <label htmlFor={`ck-${x.key}`}><b>{text.title(x)}</b>{x.forMonth && <span className="small mut"> · {t('ck.forMonth', { month: monthName(x.forMonth) })}</span>}</label>
        {text.help(x) && <span className="small mut">{text.help(x)}</span>}
        {x.how === 'auto' && <span className="small mut">{t('ck.auto')}</span>}
      </span>
      <span className="check-actions">
        {!x.done && x.go && !extra && <button className="b small" onClick={() => { onGo(); goTo(x.go); }}>{text.go(x)}</button>}
        {extra ? <button className="link small" onClick={() => void act('hide', { key: x.key, hidden: false })}>{t('ck.unhide')}</button>
          : <button className="link small" onClick={() => void act('hide', { key: x.key, hidden: true })}>{t('ck.hide')}</button>}
      </span>
    </li>
  );
  return (
    <div className="check-body">
      {error && <div className="notice bad" role="alert">{error}</div>}
      {mine.length === 0 && hidden.length === 0 && <p className="small mut">{t('ck.empty')}</p>}
      {mine.length > 0 && mine.every((x) => x.done) && <p className="small" id="checklist-alldone">{t('ck.allDone')}</p>}
      {AREAS.map((a) => {
        const inArea = mine.filter((x) => x.area === a);
        if (!inArea.length) return null;
        const open = inArea.filter((x) => !x.done), done = inArea.filter((x) => x.done);
        return (
          <section key={a} className="check-group" data-area={a}>
            <h3>{t(`ck.area.${a}` as Key)}</h3>
            {open.length > 0 && <ul>{open.map((x) => row(x))}</ul>}
            {done.length > 0 && (
              <details className="check-done"><summary>{t('ck.done', { n: done.length })}</summary><ul>{done.map((x) => row(x))}</ul></details>
            )}
          </section>
        );
      })}
      {hidden.length > 0 && (
        <details className="check-done" id="checklist-hidden"><summary>{t('ck.hidden', { n: hidden.length })}</summary><ul>{hidden.map((x) => row(x, 'hidden'))}</ul></details>
      )}
    </div>
  );
}

interface Setup { items: SetupItem[] }
interface Draft { key?: string; area: Area; scope: 'company' | 'user'; title: string; titleAr: string; help: string; helpAr: string; goModule: string }
const blank: Draft = { area: 'setup', scope: 'company', title: '', titleAr: '', help: '', helpAr: '', goModule: '' };

/** The company's Administrator: hide, reorder, reword and add items. Nothing here shows figures from the books. */
export function ChecklistEditor({ companyId, onChanged, bare }: { companyId: string; onChanged?: () => void; bare?: boolean }) {
  const { t, has } = useI18n();
  const text = useItemText();
  const s = useApi<Setup>(`/api/companies/${companyId}/checklist/setup`);
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const base = `/api/companies/${companyId}/checklist`;
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const items = s.data.items;
  const run = async (path: string, body: unknown) => {
    setBusy(true); setError(undefined);
    try { await api(`${base}/${path}`, { body }); s.reload(); onChanged?.(); return true; }
    catch (e) { setError(errorText(t, has, e)); return false; } finally { setBusy(false); }
  };
  const move = (key: string, by: -1 | 1) => {
    const keys = items.map((x) => x.key);
    const i = keys.indexOf(key), j = i + by;
    if (j < 0 || j >= keys.length || items[j]!.area !== items[i]!.area) return;
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    void run('order', { keys });
  };
  const save = async () => {
    if (!draft) return;
    const body = { ...(draft.key ? { key: draft.key } : { area: draft.area, scope: draft.scope }), title: draft.title || null, titleAr: draft.titleAr || null,
      help: draft.help || null, helpAr: draft.helpAr || null, ...(draft.key ? {} : { goModule: draft.goModule || null }) };
    if (draft.key && !draft.title) { delete (body as { title?: unknown }).title; }
    if (await run('items', body)) setDraft(undefined);
  };
  const body = (
    <>
      {!bare && <h2>{t('ck.ed.title')}</h2>}
      <p className="small mut">{t('ck.ed.intro')}</p>
      {error && <div className="notice bad" role="alert" id="ck-ed-error">{error}</div>}
      {AREAS.map((a) => (
        <section key={a} className="check-group">
          <h3>{t(`ck.area.${a}` as Key)}</h3>
          <ul>
            {items.filter((x) => x.area === a).map((x) => (
              <li key={x.key} className={`check-item ${x.hiddenForCompany ? 'off' : ''}`} data-key={x.key}>
                <span className="check-text">
                  <b>{text.title(x)}</b>
                  <span className="small mut">{text.help(x)}{x.adminOnly ? ` · ${t('ck.ed.adminOnly')}` : ''}{x.custom ? ` · ${t('ck.ed.custom')}` : ''}{x.hiddenForCompany ? ` · ${t('ck.ed.hiddenFor')}` : ''}</span>
                </span>
                <span className="check-actions">
                  <button className="b small" aria-label={t('ck.ed.up')} title={t('ck.ed.up')} disabled={busy} onClick={() => move(x.key, -1)}>↑</button>
                  <button className="b small" aria-label={t('ck.ed.down')} title={t('ck.ed.down')} disabled={busy} onClick={() => move(x.key, 1)}>↓</button>
                  <button className="link small" disabled={busy} onClick={() => void run('items', { key: x.key, hidden: !x.hiddenForCompany })}>{x.hiddenForCompany ? t('ck.ed.showForAll') : t('ck.ed.hideForAll')}</button>
                  <button className="link small" disabled={busy} onClick={() => setDraft({ key: x.key, area: x.area, scope: x.scope, title: x.title ?? '', titleAr: x.titleAr ?? '', help: x.help ?? '', helpAr: x.helpAr ?? '', goModule: x.go?.module ?? '' })}>{t('ck.ed.rename')}</button>
                  {x.custom && <button className="link small bad" disabled={busy} onClick={() => void run('items/delete', { key: x.key })}>{t('ck.ed.delete')}</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {draft ? (
        <form className="check-form" id="ck-ed-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <b>{draft.key ? t('ck.ed.rename') : t('ck.ed.add')}</b>
          <label className="f">{t('ck.ed.titleLabel')}<input id="ck-ed-title" maxLength={120} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <label className="f">{t('ck.ed.titleAr')}<input id="ck-ed-title-ar" dir="rtl" maxLength={120} value={draft.titleAr} onChange={(e) => setDraft({ ...draft, titleAr: e.target.value })} /></label>
          <label className="f">{t('ck.ed.help')}<input id="ck-ed-help" maxLength={300} value={draft.help} onChange={(e) => setDraft({ ...draft, help: e.target.value })} /></label>
          <label className="f">{t('ck.ed.helpAr')}<input id="ck-ed-help-ar" dir="rtl" maxLength={300} value={draft.helpAr} onChange={(e) => setDraft({ ...draft, helpAr: e.target.value })} /></label>
          {!draft.key && (
            <>
              <label className="f">{t('ck.ed.area')}
                <select id="ck-ed-area" value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value as Area })}>
                  {AREAS.map((a) => <option key={a} value={a}>{t(`ck.area.${a}` as Key)}</option>)}</select></label>
              <label className="f">{t('ck.ed.scope')}
                <select id="ck-ed-scope" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as 'company' | 'user' })}>
                  <option value="company">{t('ck.ed.scope.company')}</option><option value="user">{t('ck.ed.scope.user')}</option></select></label>
              <label className="f">{t('ck.ed.goModule')}
                <select id="ck-ed-go" value={draft.goModule} onChange={(e) => setDraft({ ...draft, goModule: e.target.value })}>
                  <option value="">{t('ck.ed.noPage')}</option>
                  {GO_MODULES.map((m) => <option key={m} value={m}>{has(`mod.${m}`) ? t(`mod.${m}` as Key) : m}</option>)}</select></label>
            </>
          )}
          <div className="actions">
            <button className="b p" id="ck-ed-save" type="submit" disabled={busy || (!draft.key && !draft.title.trim())}>{t('ck.ed.save')}</button>
            <button className="b" type="button" onClick={() => setDraft(undefined)}>{t('ck.ed.cancel')}</button>
            {draft.key && <button className="link" type="button" disabled={busy} onClick={() => void run('items', { key: draft.key, title: null, titleAr: null, help: null, helpAr: null }).then((ok) => ok && setDraft(undefined))}>{t('ck.ed.reset')}</button>}
          </div>
        </form>
      ) : <button className="b" id="ck-ed-add" disabled={busy} onClick={() => setDraft(blank)}>{t('ck.ed.add')}</button>}
    </>
  );
  return bare ? <div className="check-body">{body}</div> : <details className="card" id="checklist-editor"><summary><h2 style={{ display: 'inline' }}>{t('ck.ed.title')}</h2></summary>{body}</details>;
}
