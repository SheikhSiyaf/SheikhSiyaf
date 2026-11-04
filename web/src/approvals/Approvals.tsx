// Approvals: what waits for a decision (bills, supplier payments, credit notes, and employee claims), the history,
// and the rules (from which amount each needs approval). The sender never decides; approvers are the firm's
// partner or reviewer, or a client role with the approve right. Issuing or paying is refused until approved.
import { useState } from 'react';
import { CorrectionList, type Correction } from '../hrm/AttendanceClock.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';

export interface ApprovalRequest {
  id: string; kind: 'bill' | 'payment' | 'credit_note'; status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'done'; amount: string; note: string | null; reason: string | null;
  documentId: string | null; docNumber: string | null; docType: string | null; docDate: string | null; payment: { date?: string; method?: string; reference?: string } | null;
  paymentId: string | null; paymentNumber: string | null; contact: string; contactAr: string | null;
  requestedBy: string | null; requestedAt: string; decidedBy: string | null; decidedAt: string | null; doneAt: string | null; mine: boolean; canDecide: boolean;
}
interface Rule { kind: 'bill' | 'payment' | 'credit_note'; threshold: string; active: boolean; updatedBy: string | null; updatedAt: string | null }
const TONE: Record<string, string> = { pending: 'warn', approved: 'good', rejected: 'bad', withdrawn: '', done: 'good' };

/** The rules for this company, and whether an amount of a kind needs approval. */
export function useApprovalRules(books: CompanyBooks) {
  const r = useApi<{ canEdit: boolean; rules: Rule[] }>(`/api/companies/${books.company.id}/approvals/rules`);
  const needs = (kind: Rule['kind'], gross: bigint) => {
    const rule = r.data?.rules.find((x) => x.kind === kind && x.active);
    if (!rule) return false;
    const [w, f = ''] = rule.threshold.split('.');
    return gross >= BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2));
  };
  return { rules: r.data?.rules ?? [], needs, threshold: (kind: Rule['kind']) => r.data?.rules.find((x) => x.kind === kind && x.active)?.threshold ?? null };
}

export function Approvals({ books, sub }: { books: CompanyBooks; sub: string }) {
  if (sub === 'approval-rules') return <Rules books={books} />;
  return <RequestList books={books} history={sub === 'approval-history'} />;
}

function useActions(reload: () => void, onOk?: (msg: string) => void) {
  const { t, has } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) { setMsg({ ok }); onOk?.(ok); } reload(); return true; } catch (e) { setMsg({ bad: errorText(t, has, e) }); return false; } finally { setBusy(false); }
  };
  const notes = <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</>;
  const errors = msg.bad ? <div className="notice bad small" role="alert">{msg.bad}</div> : null;
  return { run, busy, notes, errors };
}

/** Approve, reject (with a reason), withdraw, and carry out once approved. Used in the list and on a draft. */
export function RequestActions({ books, r, reload, compact, onOk }: { books: CompanyBooks; r: ApprovalRequest; reload: () => void; compact?: boolean; onOk?: (msg: string) => void }) {
  const { t } = useI18n();
  const go = useGo(books.company.id);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const { run, busy, notes, errors } = useActions(reload, onOk);
  const open = r.status === 'pending' || r.status === 'approved';
  return (
    <>
      {!compact && notes}
      <span className="actions" style={{ justifyContent: 'flex-end' }}>
        {r.status === 'pending' && r.canDecide && !rejecting && <>
          <button className="b small p" id={`appr-approve-${r.id}`} disabled={busy} onClick={() => void run(() => api(`/api/approvals/${r.id}/decide`, { body: { decision: 'approved' } }), t('apr.approved1'))}>{t('appr.approve')}</button>
          <button className="b small" disabled={busy} onClick={() => setRejecting(true)}>{t('appr.reject')}</button>
        </>}
        {r.status === 'approved' && r.kind !== 'payment' && books.canPost && r.documentId && <button className="b small p" id={`appr-issue-${r.id}`} disabled={busy}
          onClick={() => void run(async () => { await api(`/api/documents/${r.documentId}/issue`, { body: {} }); }, t('apr.issued1'))}>{t(r.kind === 'bill' ? 'apr.issueBill' : 'apr.issueCredit')}</button>}
        {r.status === 'approved' && r.kind === 'payment' && books.canPost && <button className="b small p" id={`appr-pay-${r.id}`} disabled={busy}
          onClick={() => void run(() => api(`/api/approvals/${r.id}/pay`, { body: {} }), t('apr.paid1'))}>{t('apr.pay')}</button>}
        {open && (r.mine || r.canDecide) && !rejecting && <button className="link small" disabled={busy} onClick={() => void run(() => api(`/api/approvals/${r.id}/withdraw`, { body: {} }), t('apr.withdrawn1'))}>{t('apr.withdraw')}</button>}
        {r.documentId && !compact && <button className="link small" onClick={() => go(r.kind === 'bill' ? 'Purchases' : 'Sales', r.kind === 'bill' ? 'bills' : 'credit-notes', r.documentId!)}>{t('apr.open')}</button>}
        {r.paymentId && <button className="link small" onClick={() => go('Purchases', 'payments-made', r.paymentId!)}>{r.paymentNumber}</button>}
      </span>
      {rejecting && (
        <div className="notice warn" style={{ marginTop: 6 }}>
          <label className="f">{t('appr.reason')}<textarea id="apr-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="actions" style={{ marginTop: 6 }}>
            <button className="b small p" disabled={busy || !reason.trim()} onClick={() => void run(() => api(`/api/approvals/${r.id}/decide`, { body: { decision: 'rejected', reason } }), t('apr.rejected1')).then((x) => x && setRejecting(false))}>{t('appr.reject')}</button>
            <button className="b small" onClick={() => setRejecting(false)}>{t('cancel')}</button>
          </div>
        </div>
      )}
      {compact && errors}
    </>
  );
}

function RequestList({ books, history }: { books: CompanyBooks; history: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState('');
  const [done, setDone] = useState<string>();
  const list = useApi<ApprovalRequest[]>(`/api/companies/${books.company.id}/approvals?status=${history ? status : 'open'}`);
  const w = useApi<{ canApprove: boolean; toDecide: number; claims: number; approvedToAction: number; corrections?: number }>(`/api/companies/${books.company.id}/approvals/waiting`);
  const hrm = (books.company.modules ?? []).includes('HRM') && accessTo(books.access?.permissions, 'HRM') !== 'none';
  const corr = useApi<Correction[]>(!history && hrm ? `/api/companies/${books.company.id}/hr/corrections?status=requested` : null);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  const reload = () => { list.reload(); w.reload(); corr.reload(); };
  return (
    <>
      {!history && <div className="grid">
        <div className={`card fig ${w.data?.toDecide ? 'warn' : ''}`}><small>{t('apr.toDecide')}</small><b>{w.data?.toDecide ?? '—'}</b><small>{t(w.data?.canApprove ? 'apr.toDecideSub' : 'apr.notApprover')}</small></div>
        <div className="card fig"><small>{t('apr.approvedToAction')}</small><b>{w.data?.approvedToAction ?? '—'}</b><small>{t('apr.approvedToActionSub')}</small></div>
        <button className="card fig tile" onClick={() => go('Expenses', 'approvals')}><small>{t('apr.claims')}</small><b>{w.data?.claims ?? '—'}</b><small>{t('apr.claimsSub')}</small></button>
        {hrm && <button className="card fig tile" onClick={() => go('HRM', 'attendance')}><small>{t('appr.attCorrections')}</small><b>{corr.data?.length ?? '—'}</b><small>{t('appr.attCorrectionsSub')}</small></button>}
      </div>}
      {!history && hrm && (corr.data?.length ?? 0) > 0 && <div className="card" id="apr-corrections">
        <h3>{t('appr.attCorrections')}</h3>
        <CorrectionList books={books} list={corr.data!} onChanged={(m) => { setDone(m); reload(); }} />
      </div>}
      {history && <div className="actions" style={{ marginBottom: 10 }}>
        <select aria-label={t('apr.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('apr.all')}</option>{['pending', 'approved', 'done', 'rejected', 'withdrawn'].map((s) => <option key={s} value={s}>{t(`apr.s.${s}` as Key)}</option>)}</select>
      </div>}
      {done && <div className="notice" role="status">{done}</div>}
      <div className="card">
        {!history && <div className="mut small" style={{ marginBottom: 8 }}>{t('apr.hint')}</div>}
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t(history ? 'apr.noneHistory' : 'apr.none')}</div> : (
          <table className="stack"><tbody>{list.data.map((r) => (
            <tr key={r.id}>
              <td><b>{t(`apr.k.${r.kind}` as Key)}{r.docNumber ? ` · ${r.docNumber}` : ''}</b> <span className="small">{local(r.contact, r.contactAr)}</span>
                {r.note && <div className="small">{r.note}</div>}
                <div className="small mut">{t('apr.sentBy', { name: r.requestedBy ?? '', date: r.requestedAt.slice(0, 10) })}{r.decidedBy ? ` · ${t('apr.decidedBy', { name: r.decidedBy, date: r.decidedAt!.slice(0, 10) })}` : ''}</div>
                {r.reason && <div className="small bad">{t('apr.reasonWas', { reason: r.reason })}</div>}</td>
              <td className="num" data-label={t('apr.amount')}><b className="ltr">{fmt(r.amount)}</b> <span className="mut small">{books.company.currency}</span></td>
              <td data-label={t('apr.status')}><span className={`badge ${TONE[r.status]}`}>{t(`apr.s.${r.status}` as Key)}</span></td>
              <td className="num"><RequestActions books={books} r={r} reload={reload} compact onOk={setDone} /></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}

function Rules({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const r = useApi<{ canEdit: boolean; rules: Rule[] }>(`/api/companies/${books.company.id}/approvals/rules`);
  const [edit, setEdit] = useState<Record<string, { threshold: string; active: boolean }>>({});
  const { run, busy, notes } = useActions(r.reload);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const can = r.data.canEdit;
  return (
    <div className="card">
      <h2>{t('apr.rulesTitle')}</h2>
      <p className="mut small">{t('apr.rulesHint')}</p>
      {!can && <div className="notice small">{t('apr.rulesViewOnly')}</div>}
      {notes}
      <table className="stack"><tbody>{r.data.rules.map((x) => {
        const v = edit[x.kind] ?? { threshold: x.threshold, active: x.active };
        const set = (p: Partial<typeof v>) => setEdit({ ...edit, [x.kind]: { ...v, ...p } });
        return (
          <tr key={x.kind}>
            <td><label className="check-one"><input type="checkbox" id={`rule-${x.kind}`} disabled={!can} checked={v.active} onChange={(e) => set({ active: e.target.checked })} />
              <span>{t(`apr.rule.${x.kind}` as Key)}<div className="small mut">{t(`apr.ruleHint.${x.kind}` as Key)}</div></span></label></td>
            <td data-label={t('apr.from')}><label className="f" style={{ margin: 0 }}>{t('apr.from')}<input id={`rule-${x.kind}-amount`} className="num" dir="ltr" inputMode="decimal" disabled={!can || !v.active}
              value={v.threshold} onChange={(e) => set({ threshold: e.target.value })} /></label></td>
            <td className="small mut">{x.updatedBy ? t('apr.changedBy', { name: x.updatedBy, date: x.updatedAt!.slice(0, 10) }) : ''}</td>
            <td className="num">{can && edit[x.kind] && <button className="b small p" id={`rule-${x.kind}-save`} disabled={busy}
              onClick={() => void run(() => api(`/api/companies/${books.company.id}/approvals/rules`, { body: { kind: x.kind, threshold: v.threshold.replace(/,/g, ''), active: v.active } }), t('apr.ruleSaved'))
                .then((ok) => { if (ok) { const n = { ...edit }; delete n[x.kind]; setEdit(n); } })}>{t('save')}</button>}</td>
          </tr>
        );
      })}</tbody></table>
    </div>
  );
}

/** On a draft bill or credit note: its approval request, if any. */
export function ApprovalPanel({ books, documentId, reload }: { books: CompanyBooks; documentId: string; reload: () => void }) {
  const { t } = useI18n();
  const r = useApi<ApprovalRequest | null>(`/api/documents/${documentId}/approval`);
  if (!r.data || !['pending', 'approved', 'rejected'].includes(r.data.status)) return null;
  const x = r.data;
  return (
    <div className={`notice ${x.status === 'rejected' ? 'bad' : x.status === 'approved' ? '' : 'warn'}`} id="doc-approval">
      <div className="actions">
        <span><b>{t(`apr.s.${x.status}` as Key)}</b> · {t('apr.sentBy', { name: x.requestedBy ?? '', date: x.requestedAt.slice(0, 10) })}
          {x.decidedBy && <> · {t('apr.decidedBy', { name: x.decidedBy, date: x.decidedAt!.slice(0, 10) })}</>}</span>
        <span className="spacer" />
        <RequestActions books={books} r={x} reload={() => { r.reload(); reload(); }} compact />
      </div>
      {x.status === 'pending' && <div className="small">{t('apr.lockedHint')}</div>}
      {x.status === 'rejected' && <div className="small">{t('apr.reasonWas', { reason: x.reason ?? '' })} {t('apr.rejectedHint')}</div>}
    </div>
  );
}
