// Support chat with Nusuh Books (db/migrations/0042). Customers: a Help button in the corner opens a panel with their
// conversations, a form to raise an issue and the chat itself. The owner: the Support tab in the owner console, every
// customer's conversations, answer and close. Only what people write is shared: the owner never sees the books.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';

interface Thread { id: string; subject: string; category: string; status: 'open' | 'answered' | 'closed'; createdAt: string; lastMessageAt: string; firmId: string;
  customer: string; customerKind: string; openedBy: string; openedByName: string; company: string | null; messages: number; unread: number; lastBody: string; lastFromOwner: boolean }
interface Message { id: string; fromOwner: boolean; authorName: string; mine: boolean; body: string; createdAt: string }
const CATEGORIES = ['question', 'problem', 'billing', 'idea', 'other'] as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS_BADGE: Record<string, string> = { open: 'warn', answered: 'good', closed: '' };

/** Polls a path while mounted (and the tab is visible), so new replies show without reloading; also refreshes at
 *  once when a conversation is read or written to (the "nb:support" event), so unread counts drop straight away. */
const SUPPORT_EVENT = 'nb:support';
const supportChanged = () => window.dispatchEvent(new Event(SUPPORT_EVENT));
function usePolled<T>(path: string | null, ms: number) {
  const r = useApi<T>(path);
  const reload = useRef(r.reload); reload.current = r.reload;
  useEffect(() => {
    if (!path) return;
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') reload.current(); }, ms);
    const now = () => reload.current();
    window.addEventListener(SUPPORT_EVENT, now);
    return () => { clearInterval(t); window.removeEventListener(SUPPORT_EVENT, now); };
  }, [path, ms]);
  return r;
}

// ------------------------------------------------------------------ one conversation (both sides)
function Conversation({ id, owner, onBack }: { id: string; owner?: boolean; onBack: () => void }) {
  const { t, has } = useI18n();
  const d = usePolled<Thread & { messages: Message[] }>(`/api/support/threads/${id}`, 10_000);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const count = d.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);
  const loaded = Boolean(d.data);
  useEffect(() => { if (loaded) setTimeout(supportChanged, 0); }, [loaded]);   // opening it marked it read
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true); setBad(undefined);
    try { await api(`/api/support/threads/${id}/messages`, { body: { body } }); setBody(''); d.reload(); supportChanged(); }
    catch (x) { setBad(errorText(t, has, x)); } finally { setBusy(false); }
  };
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const th = d.data;
  return (
    <div className="chat">
      <div className="chat-head">
        <button className="b small" id="sup-back" onClick={onBack} aria-label={t('sup.back')}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}><b className="chat-title">{th.subject}</b>
          <div className="small mut">{owner ? `${th.customer}${th.company ? ` · ${th.company}` : ''} · ${th.openedByName}` : t(`sup.cat.${th.category}` as Key)}</div></div>
        <span className={`badge ${STATUS_BADGE[th.status]}`}>{t(`sup.st.${th.status}` as Key)}</span>
      </div>
      <div className="chat-msgs" role="log" aria-live="polite">
        {th.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.mine ? 'me' : ''} ${m.fromOwner ? 'nb' : ''}`}>
            <div className="small mut">{m.mine ? t('sup.you') : m.authorName} · {when(m.createdAt)}</div>
            <div className="bubble-text">{m.body}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {bad && <div className="notice bad" role="alert">{bad}</div>}
      <form className="chat-send" onSubmit={send}>
        <textarea id="sup-reply" rows={2} value={body} placeholder={th.status === 'closed' ? t('sup.reopenHint') : t('sup.writeHere')} aria-label={t('sup.writeHere')}
          onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e); }} />
        <div className="actions">
          {th.status !== 'closed' && <button type="button" className="b small" id="sup-close" disabled={busy}
            onClick={() => void api(`/api/support/threads/${id}/close`, { body: {} }).then(d.reload)}>{t('sup.close')}</button>}
          <span className="spacer" />
          <button className="b p" id="sup-send" disabled={busy || !body.trim()}>{t('sup.send')}</button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ customers: the Help button and panel
export function SupportChat({ companyId }: { companyId?: string | null }) {
  const { t, has } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ thread?: string; new?: boolean }>({});
  const unread = usePolled<{ unread: number }>('/api/support/unread', 60_000);
  const list = useApi<Thread[]>(open && !view.thread && !view.new ? '/api/support/threads' : null);
  const [f, setF] = useState({ subject: '', category: 'question', body: '' });
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string>();
  const n = unread.data?.unread ?? 0;
  const raise = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setBad(undefined);
    try { const r = await api<{ id: string }>('/api/support/threads', { body: { ...f, companyId: companyId ?? null } }); setF({ subject: '', category: 'question', body: '' }); setView({ thread: r.id }); }
    catch (x) { setBad(errorText(t, has, x)); } finally { setBusy(false); }
  };
  const back = () => { setView({}); unread.reload(); };
  return (
    <>
      <button className="help-fab no-print" id="sup-open" aria-expanded={open} onClick={() => { setOpen(!open); if (open) back(); }}>
        <span aria-hidden="true">?</span> {t('sup.help')}{n > 0 && <span className="fab-badge" aria-label={t('sup.unreadN', { n })}>{n}</span>}
      </button>
      {open && (
        <section className="help-panel no-print" role="dialog" aria-label={t('sup.title')}>
          {view.thread ? <Conversation id={view.thread} onBack={back} /> : view.new ? (
            <form className="chat" onSubmit={raise}>
              <div className="chat-head"><button type="button" className="b small" onClick={back} aria-label={t('sup.back')}>←</button><b style={{ flex: 1 }}>{t('sup.newTitle')}</b></div>
              <div className="chat-body">
                <div className="small mut" style={{ marginBottom: 8 }}>{t('sup.newHint')}</div>
                <label className="f">{t('sup.category')}<select id="sup-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`sup.cat.${c}` as Key)}</option>)}</select></label>
                <label className="f">{t('sup.subject')}<input id="sup-subject" value={f.subject} maxLength={200} placeholder={t('sup.subjectExample')} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
                <label className="f">{t('sup.message')}<textarea id="sup-body" rows={5} value={f.body} maxLength={5000} placeholder={t('sup.messageExample')} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
                {bad && <div className="notice bad" role="alert">{bad}</div>}
                <div className="small mut" style={{ marginBottom: 8 }}>{t('sup.privacy')}</div>
                <button className="b p wide" id="sup-raise" disabled={busy || !f.subject.trim() || !f.body.trim()}>{t('sup.raise')}</button>
              </div>
            </form>
          ) : (
            <div className="chat">
              <div className="chat-head"><b style={{ flex: 1 }}>{t('sup.title')}</b><button className="b small" onClick={() => setOpen(false)} aria-label={t('sup.hide')}>×</button></div>
              <div className="chat-body">
                <div className="small mut" style={{ marginBottom: 8 }}>{t('sup.hint')}</div>
                <button className="b p wide" id="sup-new" onClick={() => setView({ new: true })}>{t('sup.new')}</button>
                {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
                {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut small" style={{ marginTop: 10 }}>{t('sup.none')}</div> : (
                  <ul className="thread-list">{list.data.map((x) => (
                    <li key={x.id}><button onClick={() => setView({ thread: x.id })}>
                      <span className="tl-top"><b>{x.subject}</b>{x.unread > 0 && <span className="fab-badge inline">{x.unread}</span>}</span>
                      <span className="small mut">{x.lastFromOwner ? `${t('sup.nb')}: ` : ''}{x.lastBody.slice(0, 80)}</span>
                      <span className="small"><span className={`badge ${STATUS_BADGE[x.status]}`}>{t(`sup.st.${x.status}` as Key)}</span> <span className="mut">{when(x.lastMessageAt)}</span></span>
                    </button></li>))}</ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the owner: Support tab
export function OwnerSupport() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<'waiting' | 'all'>('waiting');
  const [openId, setOpenId] = useState<string>();
  const list = usePolled<Thread[]>(openId ? null : '/api/support/threads', 30_000);
  if (openId) return <div className="card owner-chat"><Conversation id={openId} owner onBack={() => { setOpenId(undefined); list.reload(); }} /></div>;
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const rows = list.data.filter((x) => filter === 'all' || x.status === 'open');
  const waiting = list.data.filter((x) => x.status === 'open').length;
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('sup.ownerHint')}</div>
      <div className="grid">
        <div className="card fig"><small>{t('sup.waiting')}</small><b>{waiting}</b><small>{t('sup.waitingSub')}</small></div>
        <div className="card fig"><small>{t('sup.unreadFig')}</small><b>{list.data.filter((x) => x.unread > 0).length}</b><small>{t('sup.unreadSub')}</small></div>
        <div className="card fig"><small>{t('sup.total')}</small><b>{list.data.length}</b><small>{t('sup.totalSub')}</small></div>
      </div>
      <div className="card">
        <div className="actions" style={{ marginBottom: 8 }}>
          <div className="seg" role="radiogroup">{(['waiting', 'all'] as const).map((k) => <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{t(`sup.filter.${k}` as Key)}</button>)}</div>
        </div>
        {rows.length === 0 ? <div className="mut">{t(filter === 'waiting' ? 'sup.noneWaiting' : 'sup.noneAll')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('sup.subject')}</th><th>{t('own.customer')}</th><th>{t('sup.from')}</th><th>{t('sup.last')}</th><th>{t('sup.status')}</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.id} className={x.unread > 0 ? 'unread-row' : ''}>
                <td><button className="link" id={`sup-t-${x.id.slice(0, 8)}`} onClick={() => setOpenId(x.id)}>{x.subject}</button>{x.unread > 0 && <span className="fab-badge inline">{x.unread}</span>}
                  <div className="small mut">{t(`sup.cat.${x.category}` as Key)} · {x.lastBody.slice(0, 90)}</div></td>
                <td data-label={t('own.customer')}>{x.customer}{x.company && <div className="small mut">{x.company}</div>}</td>
                <td data-label={t('sup.from')}>{x.openedByName}</td>
                <td className="small" data-label={t('sup.last')}>{when(x.lastMessageAt)}</td>
                <td data-label={t('sup.status')}><span className={`badge ${STATUS_BADGE[x.status]}`}>{t(`sup.st.${x.status}` as Key)}</span></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/** The owner's unread count for the Support tab label. */
export function useOwnerSupportUnread() {
  return usePolled<{ unread: number }>('/api/support/unread', 60_000).data?.unread ?? 0;
}
