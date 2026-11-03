// Client portal: the firm asks for documents, the client sends them (or anything else), the firm marks them dealt
// with and shares files back, and publishes a monthly report with its comments. One screen, two sides: what each
// person sees depends on whether they are on the firm's side for this client.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { ACCEPT, MAX, sizeText, toBase64 } from '../print/Attachments.tsx';
import { fileUrl, type Attachment } from '../print/Pdf.tsx';
import { useDates } from '../calendar/Calendar.tsx';

const CATEGORIES = ['bank_statement', 'receipts', 'sales', 'purchases', 'payroll', 'contract', 'tax', 'other'] as const;
interface Request { id: string; title: string; details: string | null; category: string; periodEnd: string | null; dueDate: string | null; status: 'open' | 'answered' | 'done';
  requestedBy: string | null; requestedAt: string; closedBy: string | null; closedAt: string | null; answers: number }
interface Upload { id: string; requestId: string | null; requestTitle: string | null; category: string; periodEnd: string | null; note: string | null; fromFirm: boolean; status: 'new' | 'processed';
  uploadedBy: string | null; mine: boolean; uploadedAt: string; processedBy: string | null; processedAt: string | null; files: (Attachment & { dataUrl?: string })[] }
interface Letter { id: string; periodEnd: string; commentary: string; publishedBy: string | null; publishedAt: string; readBy: string | null; readAt: string | null;
  figures: { revenue: string; grossProfit: string; netProfit: string; ytdNetProfit: string; cash: string; receivables: string; payables: string; vatDue: string } }
interface Overview { openRequests: number; answeredRequests: number; newUploads: number; shared: number; unreadLetters: number; firm: boolean;
  latestLetter: { id: string; periodEnd: string; publishedAt: string; readAt: string | null } | null; requests: Request[] }

const lastMonthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10); };
const monthEndOf = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** A success note that survives moving to another page of the portal (shown once). */
let flash: Key | undefined;
function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>(() => { const ok = flash; flash = undefined; return ok ? { ok: t(ok) } : {}; });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); return true; } catch (e) { setMsg({ bad: errorText(t, has, e) }); return false; } finally { setBusy(false); }
  };
  const notes = <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</>;
  return { run, busy, notes };
}

export function Portal({ books, sub, item, extra }: { books: CompanyBooks; sub: string; item?: string; extra?: string }) {
  if (sub === 'requests') return <Requests books={books} startNew={item === 'new'} />;
  if (sub === 'documents') return <Documents key={`${item ?? ''}${extra ?? ''}`} books={books} item={item} extra={extra} />;
  if (sub === 'monthly-reports') return <Letters books={books} id={item} />;
  return <PortalOverview books={books} />;
}

// ------------------------------------------------------------------ overview
function PortalOverview({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  const o = useApi<Overview>(`/api/companies/${books.company.id}/portal/overview`);
  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const tile = (label: string, value: number, sub: string, onClick: () => void, tone = '') =>
    <button className={`card fig tile ${value ? tone : ''}`} onClick={onClick}><small>{label}</small><b>{value}</b><small>{sub}</small></button>;
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t(d.firm ? 'pt.hintFirm' : 'pt.hintClient')}</div>
      <div className="grid">
        {d.firm ? <>
          {tile(t('pt.newDocs'), d.newUploads, t('pt.newDocsSub'), () => go('Portal', 'documents'), 'warn')}
          {tile(t('pt.answered'), d.answeredRequests, t('pt.answeredSub'), () => go('Portal', 'requests'), 'warn')}
          {tile(t('pt.waitingClient'), d.openRequests, t('pt.waitingClientSub'), () => go('Portal', 'requests'))}
          {tile(t('pt.unreadReports'), d.unreadLetters, t('pt.unreadReportsFirmSub'), () => go('Portal', 'monthly-reports'))}
        </> : <>
          {tile(t('pt.asked'), d.openRequests, t('pt.askedSub'), () => go('Portal', 'requests'), 'warn')}
          {tile(t('pt.sentWaiting'), d.newUploads, t('pt.sentWaitingSub'), () => go('Portal', 'documents'))}
          {tile(t('pt.fromAccountant'), d.shared, t('pt.fromAccountantSub'), () => go('Portal', 'documents'))}
          {tile(t('pt.unreadReports'), d.unreadLetters, t('pt.unreadReportsSub'), () => go('Portal', 'monthly-reports'), 'warn')}
        </>}
      </div>
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="b p" id="pt-send" onClick={() => go('Portal', 'documents', 'send')}>{t(d.firm ? 'pt.share' : 'pt.send')}</button>
        {d.firm && <button className="b" id="pt-ask" onClick={() => go('Portal', 'requests', 'new')}>{t('pt.ask')}</button>}
        {d.firm && <button className="b" id="pt-publish" onClick={() => go('Portal', 'monthly-reports', 'new')}>{t('pt.publish')}</button>}
      </div>
      {d.latestLetter && (
        <button className="card tile wide" onClick={() => go('Portal', 'monthly-reports', d.latestLetter!.id)}>
          <small className="mut">{t('pt.latestReport')}</small>
          <b>{t('pt.reportFor', { month: dt.month(d.latestLetter.periodEnd) })}</b>
          <small>{d.latestLetter.readAt ? t('pt.readOn', { date: d.latestLetter.readAt.slice(0, 10) }) : <span className="badge warn">{t('pt.unread')}</span>}</small>
        </button>
      )}
      <div className="card">
        <h2>{t(d.firm ? 'pt.openRequests' : 'pt.whatNeeded')}</h2>
        {d.requests.length === 0 ? <div className="mut">{t(d.firm ? 'pt.noOpen' : 'pt.nothingNeeded')}</div> : <RequestRows books={books} rows={d.requests} firm={d.firm} reload={o.reload} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ requests
function RequestRows({ books, rows, firm, reload }: { books: CompanyBooks; rows: Request[]; firm: boolean; reload: () => void }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  const { run, busy, notes } = useRun();
  const now = today();
  return (
    <>
      {notes}
      <table className="stack"><tbody>{rows.map((r) => (
        <tr key={r.id} className={r.status === 'done' ? 'mut' : ''}>
          <td><b>{r.title}</b>{r.details && <div className="small">{r.details}</div>}
            <div className="small mut">{t(`pt.cat.${r.category}` as Key)}{r.periodEnd ? ` · ${dt.month(r.periodEnd)}` : ''} · {t('pt.askedBy', { name: r.requestedBy ?? '', date: r.requestedAt.slice(0, 10) })}</div></td>
          <td data-label={t('pt.dueBy')}>{r.dueDate ? <span className={r.status === 'open' && r.dueDate < now ? 'bad' : ''}>{dt.day(r.dueDate)}</span> : '—'}</td>
          <td data-label={t('pt.status')}><span className={`badge ${r.status === 'done' ? 'good' : r.status === 'answered' ? (firm ? 'warn' : '') : (firm ? '' : 'warn')}`}>{t(`pt.rs.${r.status}${firm ? 'Firm' : ''}` as Key)}</span>
            {r.answers > 0 && <div className="small"><button className="link" onClick={() => go('Portal', 'documents', r.id)}>{t('pt.answersN', { n: r.answers })}</button></div>}</td>
          <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
            {!firm && r.status !== 'done' && <button className="b small p" onClick={() => go('Portal', 'documents', 'send', r.id)}>{t('pt.sendFor')}</button>}
            {firm && r.status !== 'done' && <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/portal/requests/${r.id}/status`, { body: { status: 'done' } }), t('pt.requestDone')).then(reload)}>{t('pt.markReceived')}</button>}
            {firm && r.status === 'done' && <button className="link small" disabled={busy} onClick={() => void run(() => api(`/api/portal/requests/${r.id}/status`, { body: { status: 'open' } })).then(reload)}>{t('pt.reopen')}</button>}
          </span></td>
        </tr>
      ))}</tbody></table>
    </>
  );
}

function Requests({ books, startNew }: { books: CompanyBooks; startNew: boolean }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const firm = Boolean(books.portal?.firm);
  const list = useApi<Request[]>(`/api/companies/${books.company.id}/portal/requests`);
  const [form, setForm] = useState<{ title: string; details: string; category: string; periodEnd: string; dueDate: string } | undefined>(
    firm && startNew ? { title: '', details: '', category: 'bank_statement', periodEnd: lastMonthEnd(), dueDate: '' } : undefined);
  const { run, busy, notes } = useRun();
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/api/companies/${books.company.id}/portal/requests`, { body: form }), t('pt.asked1')).then((ok) => { if (ok) { setForm(undefined); list.reload(); go('Portal', 'requests'); } });
  };
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <span className="mut small">{t(firm ? 'pt.requestsHintFirm' : 'pt.requestsHint')}</span><span className="spacer" />
        {firm && !form && <button className="b p" id="pt-new-request" onClick={() => setForm({ title: '', details: '', category: 'bank_statement', periodEnd: lastMonthEnd(), dueDate: '' })}>{t('pt.ask')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={create}>
          <h2>{t('pt.ask')}</h2>
          <label className="f">{t('pt.whatDocs')}<input id="pt-req-title" placeholder={t('pt.whatDocsHint')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="row">
            <label className="f">{t('pt.category')}<select id="pt-req-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(`pt.cat.${c}` as Key)}</option>)}</select></label>
            <label className="f">{t('pt.month')}<input type="month" value={form.periodEnd.slice(0, 7)} onChange={(e) => setForm({ ...form, periodEnd: e.target.value ? monthEndOf(e.target.value) : '' })} /></label>
            <label className="f">{t('pt.dueBy')}<input id="pt-req-due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
          </div>
          <label className="f">{t('pt.details')}<textarea rows={2} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
          <div className="actions"><button className="b p" id="pt-req-save" disabled={busy}>{t('pt.sendRequest')}</button><button type="button" className="b" onClick={() => { setForm(undefined); go('Portal', 'requests'); }}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('pt.noRequests')}</div> : <RequestRows books={books} rows={list.data} firm={firm} reload={list.reload} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ documents
function Documents({ books, item, extra }: { books: CompanyBooks; item?: string; extra?: string }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  const firm = Boolean(books.portal?.firm);
  // /Portal/documents/send[/<request>] opens the form; /Portal/documents/<request> lists what answered that request.
  const sending = item === 'send';
  const forRequest = sending ? extra : item;
  const [filter, setFilter] = useState<'all' | 'new' | 'processed'>(firm ? 'new' : 'all');
  const list = useApi<Upload[]>(`/api/companies/${books.company.id}/portal/uploads${!sending && forRequest ? `?request=${forRequest}` : filter === 'all' ? '' : `?status=${filter}`}`);
  const requests = useApi<Request[]>(`/api/companies/${books.company.id}/portal/requests?status=open`);
  const [form, setForm] = useState<{ requestId: string; category: string; periodEnd: string; note: string } | undefined>(
    sending ? { requestId: forRequest ?? '', category: 'other', periodEnd: '', note: '' } : undefined);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const { run, busy, notes } = useRun();
  const [fileErr, setFileErr] = useState<string>();
  const pick = (fl: FileList | null) => {
    setFileErr(undefined);
    const ok = [...(fl ?? [])].filter((f) => {
      if (!/\.(pdf|png|jpe?g|webp)$/i.test(f.name)) { setFileErr(t('err.attachmentType')); return false; }
      if (f.size > MAX) { setFileErr(t('err.attachmentSize')); return false; }
      return true;
    });
    setFiles([...files, ...ok]);
    if (input.current) input.current.value = '';
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!files.length && !form!.note.trim()) { setFileErr(t('pt.addSomething')); return; }
    void run(async () => {
      const { id } = await api<{ id: string }>(`/api/companies/${books.company.id}/portal/uploads`, { body: { ...form, requestId: form!.requestId || undefined } });
      for (const f of files) await api(`/api/portal-uploads/${id}/attachments`, { body: { fileName: f.name, contentType: f.type, data: await toBase64(f) } });
    }).then((ok) => { if (ok) { flash = firm ? 'pt.shared1' : 'pt.sent1'; setForm(undefined); setFiles([]); list.reload(); requests.reload(); go('Portal', 'documents'); } });
  };
  const request = requests.data?.find((r) => r.id === form?.requestId);
  // Opened from a request: once the requests are loaded, the kind and month follow it.
  useEffect(() => {
    if (request && form && form.category === 'other' && !form.periodEnd) setForm({ ...form, category: request.category, periodEnd: request.periodEnd ?? '' });
  }, [request?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        {!sending && !forRequest && <div className="seg" role="radiogroup">
          {(['new', 'processed', 'all'] as const).map((f) => <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{t(`pt.df.${f}` as Key)}</button>)}
        </div>}
        {forRequest && !sending && <button className="link" onClick={() => go('Portal', 'documents')}>{t('pt.allDocs')}</button>}
        <span className="spacer" />
        {!form && <button className="b p" id="pt-send-docs" onClick={() => setForm({ requestId: '', category: 'other', periodEnd: '', note: '' })}>{t(firm ? 'pt.share' : 'pt.send')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={send}>
          <h2>{t(firm ? 'pt.share' : 'pt.send')}</h2>
          <div className="small mut" style={{ marginBottom: 8 }}>{t(firm ? 'pt.shareHint' : 'pt.sendHint')}</div>
          {!firm && (requests.data?.length ?? 0) > 0 && <label className="f">{t('pt.forRequest')}<select id="pt-up-request" value={form.requestId} onChange={(e) => {
            const r = requests.data!.find((x) => x.id === e.target.value);
            setForm({ ...form, requestId: e.target.value, category: r?.category ?? form.category, periodEnd: r?.periodEnd ?? form.periodEnd });
          }}><option value="">{t('pt.noRequest')}</option>{requests.data!.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>}
          {request?.details && <div className="notice small">{request.details}</div>}
          <div className="row">
            <label className="f">{t('pt.category')}<select id="pt-up-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(`pt.cat.${c}` as Key)}</option>)}</select></label>
            <label className="f">{t('pt.month')}<input type="month" value={form.periodEnd.slice(0, 7)} onChange={(e) => setForm({ ...form, periodEnd: e.target.value ? monthEndOf(e.target.value) : '' })} /></label>
          </div>
          <label className="f">{t('pt.note')}<textarea id="pt-up-note" rows={2} placeholder={t('pt.noteHint')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <div className="actions" style={{ marginBottom: 8 }}>
            <input ref={input} id="pt-files" type="file" accept={ACCEPT} multiple hidden onChange={(e) => pick(e.target.files)} />
            <button type="button" className="b" onClick={() => input.current?.click()}>{t('pt.chooseFiles')}</button>
            <span className="small mut">{t('pt.filesHint')}</span>
          </div>
          {files.length > 0 && <table className="mini"><tbody>{files.map((f, i) => (
            <tr key={`${f.name}${i}`}><td>{f.type === 'application/pdf' ? '📄' : '🖼'} {f.name}</td><td className="small mut">{sizeText(f.size)}</td>
              <td><button type="button" className="link small bad" onClick={() => setFiles(files.filter((_, j) => j !== i))}>{t('att.remove')}</button></td></tr>))}</tbody></table>}
          {fileErr && <div className="notice bad small" role="alert">{fileErr}</div>}
          <div className="actions" style={{ marginTop: 8 }}><button className="b p" id="pt-up-save" disabled={busy}>{busy ? t('loading') : t(firm ? 'pt.shareNow' : 'pt.sendNow')}</button>
            <button type="button" className="b" onClick={() => { setForm(undefined); setFiles([]); go('Portal', 'documents'); }}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('pt.noDocs')}</div> : (
          <table className="stack"><tbody>{list.data.map((u) => (
            <tr key={u.id}>
              <td><b>{t(`pt.cat.${u.category}` as Key)}{u.periodEnd ? ` · ${dt.month(u.periodEnd)}` : ''}</b>
                {u.requestTitle && <div className="small">{t('pt.forReq', { title: u.requestTitle })}</div>}
                {u.note && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{u.note}</div>}
                <div className="small mut">{u.fromFirm ? t('pt.fromFirm', { name: u.uploadedBy ?? '' }) : t('pt.sentBy', { name: u.mine ? t('pt.you') : u.uploadedBy ?? '' })} · {u.uploadedAt.slice(0, 10)}</div>
                {u.files.length > 0 && <div className="pt-files">{u.files.map((f) => (
                  <a key={f.id} className="link small" href={fileUrl(f)} target="_blank" rel="noreferrer" download={f.dataUrl ? f.fileName : undefined}>{f.contentType === 'application/pdf' ? '📄' : '🖼'} {f.fileName} <span className="mut">({sizeText(f.size)})</span></a>))}</div>}
              </td>
              <td data-label={t('pt.status')}>{u.fromFirm ? <span className="badge">{t('pt.ds.shared')}</span>
                : <span className={`badge ${u.status === 'processed' ? 'good' : firm ? 'warn' : ''}`}>{t(`pt.ds.${u.status}` as Key)}</span>}
                {u.processedAt && !u.fromFirm && <div className="small mut">{t('pt.dealtBy', { name: u.processedBy ?? '', date: u.processedAt.slice(0, 10) })}</div>}</td>
              <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}>
                {firm && !u.fromFirm && <button className={`b small ${u.status === 'new' ? 'p' : ''}`} disabled={busy}
                  onClick={() => void run(() => api(`/api/portal/uploads/${u.id}/status`, { body: { status: u.status === 'new' ? 'processed' : 'new' } })).then(list.reload)}>{u.status === 'new' ? t('pt.markDealt') : t('pt.notYet')}</button>}
                {u.mine && (u.status === 'new' || u.fromFirm) && <button className="link small bad" disabled={busy}
                  onClick={() => void run(() => api(`/api/portal/uploads/${u.id}/delete`, { body: {} })).then(list.reload)}>{t('att.remove')}</button>}
              </span></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ monthly reports
function Letters({ books, id }: { books: CompanyBooks; id?: string }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  const firm = Boolean(books.portal?.firm);
  const list = useApi<Letter[]>(`/api/companies/${books.company.id}/portal/letters`);
  const [form, setForm] = useState<{ periodEnd: string; commentary: string } | undefined>(firm && id === 'new' ? { periodEnd: lastMonthEnd(), commentary: '' } : undefined);
  const { run, busy, notes } = useRun();
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const open = id && id !== 'new' ? list.data.find((l) => l.id === id) : undefined;
  if (open) return <LetterView books={books} letter={open} firm={firm} onRead={list.reload} />;
  const publish = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/api/companies/${books.company.id}/portal/letters`, { body: form }), t('pt.published')).then((ok) => { if (ok) { setForm(undefined); list.reload(); go('Portal', 'monthly-reports'); } });
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <span className="mut small">{t(firm ? 'pt.lettersHintFirm' : 'pt.lettersHint')}</span><span className="spacer" />
        {firm && !form && <button className="b p" id="pt-new-letter" onClick={() => setForm({ periodEnd: lastMonthEnd(), commentary: '' })}>{t('pt.publish')}</button>}
      </div>
      {notes}
      {form && (
        <form className="card inset" onSubmit={publish}>
          <h2>{t('pt.publish')}</h2>
          <label className="f">{t('pt.month')}<input id="pt-letter-month" type="month" max={lastMonthEnd().slice(0, 7)} value={form.periodEnd.slice(0, 7)} onChange={(e) => e.target.value && setForm({ ...form, periodEnd: monthEndOf(e.target.value) })} /></label>
          <label className="f">{t('pt.commentary')}<textarea id="pt-letter-text" rows={8} placeholder={t('pt.commentaryHint')} value={form.commentary} onChange={(e) => setForm({ ...form, commentary: e.target.value })} /></label>
          <div className="small mut" style={{ marginBottom: 8 }}>{t('pt.figuresNote')}</div>
          <div className="actions"><button className="b p" id="pt-letter-save" disabled={busy}>{t('pt.publishNow')}</button><button type="button" className="b" onClick={() => { setForm(undefined); go('Portal', 'monthly-reports'); }}>{t('cancel')}</button></div>
        </form>
      )}
      <div className="card">
        {list.data.length === 0 ? <div className="mut">{t('pt.noLetters')}</div> : (
          <table className="stack"><tbody>{list.data.map((l) => (
            <tr key={l.id}>
              <td><button className="link" onClick={() => go('Portal', 'monthly-reports', l.id)}><b>{t('pt.reportFor', { month: dt.month(l.periodEnd) })}</b></button>
                <div className="small mut">{t('pt.publishedBy', { name: l.publishedBy ?? '', date: l.publishedAt.slice(0, 10) })}</div></td>
              <td className="num" data-label={t('reports.netProfit')}>{fmt(l.figures.netProfit)}</td>
              <td data-label={t('pt.status')}>{l.readAt ? <span className="badge good">{t('pt.readBy', { name: l.readBy ?? '', date: l.readAt.slice(0, 10) })}</span> : <span className="badge warn">{t('pt.unread')}</span>}</td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}

function LetterView({ books, letter, firm, onRead }: { books: CompanyBooks; letter: Letter; firm: boolean; onRead: () => void }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const dt = useDates();
  // The client opening the report marks it read (once); the firm opening it changes nothing.
  useEffect(() => {
    if (!firm && !letter.readAt) void api(`/api/portal/letters/${letter.id}/read`, { body: {} }).then(onRead).catch(() => undefined);
  }, [letter.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f = letter.figures;
  const cur = books.company.currency;
  const rows: [Key, string][] = [['reports.sales', f.revenue], ['reports.grossProfit', f.grossProfit], ['reports.netProfit', f.netProfit], ['pt.ytdProfit', f.ytdNetProfit],
    ['rep.cash', f.cash], ['rep.receivables', f.receivables], ['rep.payables', f.payables], ['rep.vatDue', f.vatDue]];
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}><button className="link" onClick={() => go('Portal', 'monthly-reports')}>{t('pt.allReports')}</button><span className="spacer" />
        <button className="b" onClick={() => go('Reports', 'owner-summary')}>{t('pt.openSummary')}</button></div>
      <article className="card letter">
        <div className="small mut">{books.company.name}</div>
        <h2>{t('pt.reportFor', { month: dt.month(letter.periodEnd) })}</h2>
        <div className="small mut" style={{ marginBottom: 10 }}>{t('pt.publishedBy', { name: letter.publishedBy ?? '', date: letter.publishedAt.slice(0, 10) })}</div>
        <div className="letter-text">{letter.commentary}</div>
        <h3>{t('pt.keyFigures')}</h3>
        <table><tbody>{rows.map(([k, v]) => <tr key={k}><td>{t(k)}</td><td className="num ltr">{fmt(v)} <span className="mut small">{cur}</span></td></tr>)}</tbody></table>
        <p className="small mut">{t('pt.figuresAsPublished')}</p>
      </article>
    </>
  );
}
