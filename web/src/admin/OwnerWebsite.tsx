// Owner > Website: the testimonials the public website shows. Real quotes only, each with the customer's permission.
// None visible: the website shows nothing. 1 to 4: a row. More than 4: a slow loop. The most you can save is a limit of 5 to 10.
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote, Loading, errorText } from '../ui.tsx';

interface Item {
  id: string; name: string; nameAr: string; role: string; roleAr: string; company: string; companyAr: string; quote: string; quoteAr: string;
  consent: boolean; consentNote: string; visible: boolean;
}
interface Data { limit: number; minLimit: number; maxLimit: number; loopAbove: number; items: Item[] }
type Form = Omit<Item, 'id'> & { id?: string };
const EMPTY: Form = { name: '', nameAr: '', role: '', roleAr: '', company: '', companyAr: '', quote: '', quoteAr: '', consent: false, consentNote: '', visible: true };

export function OwnerWebsite() {
  const { t, has } = useI18n();
  const d = useApi<Data>('/api/owner/website');
  const [f, setF] = useState<Form>();
  const [limit, setLimit] = useState<number>();
  const [del, setDel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const data = d.data;
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); after?.(); d.reload(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  const full = data.items.length >= data.limit;
  const move = (i: number, by: -1 | 1) => {
    const ids = data.items.map((x) => x.id); const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api('/api/owner/website/testimonials/order', { body: { ids } }));
  };
  const toggle = (x: Item) => run(() => api(`/api/owner/website/testimonials/${x.id}`, { body: { ...x, visible: !x.visible } }), t('wedit.saved'));
  const text = (k: keyof Form, label: string, o: { max: number; ar?: boolean; id?: string; area?: boolean }) => (
    <label className="f">{label}
      {o.area
        ? <textarea id={o.id} rows={3} maxLength={o.max} dir={o.ar ? 'rtl' : undefined} value={String(f![k] ?? '')} onChange={(e) => setF({ ...f!, [k]: e.target.value })} />
        : <input id={o.id} maxLength={o.max} dir={o.ar ? 'rtl' : undefined} value={String(f![k] ?? '')} onChange={(e) => setF({ ...f!, [k]: e.target.value })} />}
    </label>);
  const shown = data.items.filter((x) => x.visible).length;
  return (
    <>
      <div className="card" id="web-testimonials">
        <h2>{t('wedit.title')}</h2>
        <div className="small mut" style={{ marginBottom: 8 }}>{t('wedit.hint', { n: data.loopAbove })}</div>
        {msg.ok && <div className="notice" id="web-msg">{msg.ok}</div>}
        {msg.bad && <div className="notice bad" role="alert" id="web-error">{msg.bad}</div>}
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <b id="web-count">{t('wedit.count', { n: data.items.length, max: data.limit })}</b>
          <span className="small mut">{t('wedit.shown', { n: shown })}</span>
          <span className="spacer" />
          <label className="f" style={{ margin: 0 }}>{t('wedit.limit')}
            <select id="web-limit" value={limit ?? data.limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {Array.from({ length: data.maxLimit - data.minLimit + 1 }, (_, i) => data.minLimit + i).map((n) => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <button className="b" id="web-limit-save" disabled={busy || limit === undefined || limit === data.limit} onClick={() => void run(() => api('/api/owner/website/settings', { body: { limit } }), t('wedit.limitSaved'), () => setLimit(undefined))}>{t('wedit.limitSave')}</button>
        </div>
        <div className="small mut">{t('wedit.limit.hint')}</div>
        {!f && <div className="actions" style={{ marginTop: 10 }}>
          <button className="b p" id="web-add" disabled={full} onClick={() => { setMsg({}); setF({ ...EMPTY }); }}>{t('wedit.add')}</button>
          {full && <span className="small mut" id="web-full">{t('wedit.full', { n: data.limit })}</span>}</div>}
        {f && (
          <form className="card inset" id="web-form" onSubmit={(e) => {
            e.preventDefault();
            const { id, ...body } = f;
            void run(() => api(id ? `/api/owner/website/testimonials/${id}` : '/api/owner/website/testimonials', { body }), t('wedit.saved'), () => setF(undefined));
          }}>
            <h3>{f.id ? t('wedit.edit') : t('wedit.add')}</h3>
            <div className="row">{text('name', t('wedit.name'), { max: 80, id: 'tm-name' })}{text('role', t('wedit.role'), { max: 80, id: 'tm-role' })}{text('company', t('wedit.company'), { max: 80, id: 'tm-company' })}</div>
            {text('quote', t('wedit.quote'), { max: 300, id: 'tm-quote', area: true })}
            <div className="small mut" id="tm-count">{t('wedit.quote.count', { n: f.quote.length })}</div>
            <details style={{ margin: '8px 0' }}><summary>{t('wedit.arabic')}</summary>
              <div className="row">{text('nameAr', t('wedit.nameAr'), { max: 80, ar: true })}{text('roleAr', t('wedit.roleAr'), { max: 80, ar: true })}{text('companyAr', t('wedit.companyAr'), { max: 80, ar: true })}</div>
              {text('quoteAr', t('wedit.quoteAr'), { max: 300, ar: true, area: true })}
            </details>
            <label className="check"><input type="checkbox" id="tm-consent" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />{t('wedit.consent')}</label>
            {text('consentNote', t('wedit.consentNote'), { max: 200, id: 'tm-consent-note' })}
            <label className="check"><input type="checkbox" id="tm-visible" checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} />{t('wedit.visible')}</label>
            <div className="actions"><button className="b p" id="tm-save" disabled={busy || !f.consent || !f.name.trim() || !f.quote.trim()}>{t('save')}</button>
              <button type="button" className="b" id="tm-cancel" onClick={() => setF(undefined)}>{t('cancel')}</button></div>
          </form>)}
        {data.items.length === 0 ? <div className="mut" id="web-none" style={{ marginTop: 10 }}>{t('wedit.none')}</div> : (
          <div className="wrap" style={{ marginTop: 10 }}><table id="web-list">
            <thead><tr><th>{t('wedit.col.order')}</th><th>{t('wedit.col.who')}</th><th>{t('wedit.quote')}</th><th>{t('wedit.col.status')}</th><th /></tr></thead>
            <tbody>{data.items.map((x, i) => (
              <tr key={x.id} className={x.visible ? '' : 'mut'}>
                <td><button className="b small" aria-label={t('wedit.up')} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button><button className="b small" aria-label={t('wedit.down')} disabled={busy || i === data.items.length - 1} onClick={() => move(i, 1)}>↓</button></td>
                <td><b>{x.name}</b><div className="small mut">{[x.role, x.company].filter(Boolean).join(', ')}</div></td>
                <td>{x.quote}</td>
                <td><span className={`badge ${x.visible ? 'good' : ''}`}>{t(x.visible ? 'wedit.status.shown' : 'wedit.status.hidden')}</span></td>
                <td className="actions">
                  <button className="b small" onClick={() => { setMsg({}); setF({ ...x }); }}>{t('wedit.edit')}</button>
                  <button className="b small" disabled={busy} onClick={() => void toggle(x)}>{t(x.visible ? 'wedit.hide' : 'wedit.show')}</button>
                  {del === x.id
                    ? <><button className="b small bad" disabled={busy} onClick={() => void run(() => api(`/api/owner/website/testimonials/${x.id}/delete`, { body: {} }), t('wedit.deleted'), () => setDel(undefined))}>{t('wedit.deleteSure')}</button><button className="b small" onClick={() => setDel(undefined)}>{t('cancel')}</button></>
                    : <button className="b small" onClick={() => setDel(x.id)}>{t('wedit.delete')}</button>}
                </td>
              </tr>))}</tbody>
          </table></div>)}
      </div>
    </>
  );
}
