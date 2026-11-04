// The bell in the top bar: what needs attention in this company (worked out live on the server), newest first.
// Opening an item marks it seen for this person.
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { useGo } from '../sales/common.tsx';

interface Notice { key: string; kind: string; count?: number; params: Record<string, string | number>; module: string; sub?: string; item?: string; at: string | null; read?: boolean }

export function Bell({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const list = useApi<Notice[]>(`/api/companies/${books.company.id}/notifications`);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { const h = setInterval(list.reload, 120_000); return () => clearInterval(h); }, [list.reload]);
  const items = list.data ?? [];
  const unread = items.filter((n) => !n.read).length;
  const openItem = (n: Notice) => {
    setOpen(false);
    void api(`/api/companies/${books.company.id}/notifications/read`, { body: { keys: [n.key] } }).then(list.reload, () => undefined);
    go(n.module, n.sub, n.item);
  };
  return (
    <div className="bell" ref={box}>
      <button className="b bell-btn" id="bell" aria-haspopup="menu" aria-expanded={open} aria-label={t('note.title', { n: unread })} title={t('note.title', { n: unread })} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {unread > 0 && <span className="bell-n">{unread}</span>}
      </button>
      {open && (
        <div className="bell-menu" role="menu" id="bell-menu">
          <div className="actions" style={{ marginBottom: 4 }}><b>{t('note.heading')}</b><span className="spacer" />
            {unread > 0 && <button className="link small" onClick={() => void api(`/api/companies/${books.company.id}/notifications/read`, { body: { keys: items.map((n) => n.key) } }).then(list.reload)}>{t('note.allSeen')}</button>}</div>
          {items.length === 0 ? <p className="small mut" style={{ margin: 0 }}>{t('note.none')}</p> : items.map((n) => (
            <button key={n.key} role="menuitem" className={`bell-item ${n.read ? 'read' : ''}`} onClick={() => openItem(n)}>
              {!n.read && <i className="bell-dot" aria-hidden="true" />}
              <span>{t(`note.${n.kind}` as Key, { ...n.params, amount: n.params.amount !== undefined ? fmt(String(n.params.amount)) : '' })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
