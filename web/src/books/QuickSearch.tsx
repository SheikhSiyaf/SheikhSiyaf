// Quick search, at the top of the menu (also Ctrl+K or "/"): pages of the menu, customers, suppliers, employees,
// items and documents by number, name or VAT number. Arrow keys move, Enter opens, Escape closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { useGo } from '../sales/common.tsx';
import { hiddenFor, moduleForType, navFor, pageForType } from './nav.ts';
import { Icon } from '../icons.tsx';

interface Found { contacts: { id: string; name: string; nameAr: string | null; vatNumber: string | null; kind: 'customer' | 'supplier' | 'employee' }[];
  documents: { id: string; type: string; number: string | null; status: string; date: string; total: string; contact: string | null }[];
  items: { id: string; sku: string; name: string; nameAr: string | null }[] }
interface Hit { key: string; title: string; detail: string; group: string; open: () => void }

export function QuickSearch({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>();
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '');
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(true); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); else { setQ(''); setFound(undefined); } }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound(undefined); return; }
    let live = true;
    const h = setTimeout(() => { void api<Found>(`/api/companies/${books.company.id}/search?q=${encodeURIComponent(q.trim())}`).then((r) => live && setFound(r)).catch(() => undefined); }, 180);
    return () => { live = false; clearTimeout(h); };
  }, [q, books.company.id]);
  const pages = useMemo(() => navFor(books.company.modules, books.access?.permissions, hiddenFor(books.portal?.tenantKind))
    .flatMap((m) => [{ m: m.key, s: undefined as string | undefined }, ...m.subs.map((s) => ({ m: m.key, s: s.key }))]), [books]);
  const needle = q.trim().toLowerCase();
  const hits: Hit[] = [];
  if (needle) {
    for (const p of pages) {
      const title = p.s ? t(`sub.${p.s}` as Key) : t(`mod.${p.m}` as Key), where = t(`mod.${p.m}` as Key);
      if (`${title} ${where}`.toLowerCase().includes(needle)) hits.push({ key: `p${p.m}${p.s}`, title, detail: p.s ? where : '', group: t('qs.pages'), open: () => go(p.m, p.s) });
      if (hits.length >= 6) break;
    }
  }
  for (const c of found?.contacts ?? []) hits.push({ key: `c${c.id}`, title: local(c.name, c.nameAr), detail: `${t(`qs.kind.${c.kind}` as Key)}${c.vatNumber ? ` · ${c.vatNumber}` : ''}`, group: t('qs.people'),
    open: () => (c.kind === 'customer' ? go('Sales', 'customers', c.id) : c.kind === 'supplier' ? go('Purchases', 'suppliers', c.id) : go('HRM', 'employees', c.id)) });
  for (const d of found?.documents ?? []) hits.push({ key: `d${d.id}`, title: `${t(`doc.title.${d.type}` as Key)} ${d.number ?? t('qs.draft')}`, detail: `${d.contact ?? ''} · ${d.date} · ${fmt(d.total)}`, group: t('qs.documents'),
    open: () => go(moduleForType(d.type), pageForType(d.type), d.id) });
  for (const i of found?.items ?? []) hits.push({ key: `i${i.id}`, title: local(i.name, i.nameAr), detail: i.sku, group: t('qs.items'),
    open: () => go((books.company.modules ?? []).includes('Restaurant') ? 'Restaurant' : 'Inventory', (books.company.modules ?? []).includes('Restaurant') ? 'materials' : 'items', i.id) });
  const choose = (h: Hit) => { setOpen(false); h.open(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(x + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
    else if (e.key === 'Enter' && hits[sel]) choose(hits[sel]!);
  };
  return (
    <>
      <button className="qs-open" id="qs-open" onClick={() => setOpen(true)}><Icon name="search" size={16} /><span className="side-label">{t('qs.search')}</span><kbd>Ctrl K</kbd></button>
      {open && createPortal(
        <div className="qs-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="qs-box" role="dialog" aria-label={t('qs.search')}>
            <input ref={input} id="qs-input" value={q} placeholder={t('qs.placeholder')} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
            <div className="qs-list" role="listbox">
              {!needle && <div className="mut small qs-empty">{t('qs.hint')}</div>}
              {needle && hits.length === 0 && <div className="mut small qs-empty">{needle.length < 2 ? t('qs.keepTyping') : t('qs.none')}</div>}
              {hits.map((h, i) => (
                <div key={h.key}>
                  {(i === 0 || hits[i - 1]!.group !== h.group) && <div className="qs-group">{h.group}</div>}
                  <button role="option" aria-selected={i === sel} className={`qs-hit ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(h)}>
                    <b>{h.title}</b>{h.detail && <span className="small mut">{h.detail}</span>}</button>
                </div>
              ))}
            </div>
            <div className="qs-foot small mut">{t('qs.keys')}</div>
          </div>
        </div>, document.body,
      )}
    </>
  );
}
