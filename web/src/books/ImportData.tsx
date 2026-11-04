// Ledger > Import data: customers, suppliers, items, accounts and opening balances from a CSV or Excel file.
// 1 choose what, 2 download the template (or use your own file: headers in English or Arabic, any order),
// 3 see what will happen to every row and why, 4 import. The file is read here in the browser; only the rows are sent.
import { useState } from 'react';
import { api, type CompanyBooks } from '../api.ts';
import { useI18n, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { errorText } from '../ui.tsx';
import { useGo } from '../sales/common.tsx';
import { COLUMNS, IMPORT_KINDS, template, type ImportKind } from '../../../src/books/importRules.ts';
import { parseCsv } from '../../../src/bank/statement.ts';
import { readXlsx } from '../../../src/bank/xlsx.ts';

interface PreviewRow { line: number; values: Record<string, string>; status: 'new' | 'exists' | 'error'; problems: string[] }
interface Preview { missing: string[]; rows: PreviewRow[]; counts: { new: number; exists: number; error: number };
  opening: { debit: string; credit: string; difference: string; date: string | null; problems: string[]; warnings: string[] } | null }
const TONE = { new: 'good', exists: '', error: 'bad' } as const;
const WHERE: Record<ImportKind, [string, string]> = { customers: ['Sales', 'customers'], suppliers: ['Purchases', 'suppliers'], items: ['Inventory', 'items'], accounts: ['Ledger', 'chart-of-accounts'], opening: ['Reports', 'trial-balance'] };

function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImportData({ books, initial, only }: { books: CompanyBooks; initial?: string; only?: boolean }) {
  const { t, has, lang } = useI18n();
  const go = useGo(books.company.id);
  const [kind, setKind] = useState<ImportKind | null>((IMPORT_KINDS as readonly string[]).includes(initial ?? '') ? initial as ImportKind : null);
  const [file, setFile] = useState<{ name: string; rows: string[][] }>();
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [toEquity, setToEquity] = useState(false);
  const [p, setP] = useState<Preview>();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ imported: number; skipped: number }>();
  const body = (rows: string[][], o: { date?: string; eq?: boolean } = {}) => ({ rows, date: o.date ?? date, balanceToEquity: o.eq ?? toEquity });
  const check = async (rows: string[][], k = kind!, o: { date?: string; eq?: boolean } = {}) => {
    setBusy(true); setErr(undefined); setDone(undefined);
    try { setP(await api<Preview>(`/api/companies/${books.company.id}/import/${k}/preview`, { body: body(rows, o) })); }
    catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(undefined); setP(undefined); setDone(undefined);
    try {
      const name = f.name.toLowerCase();
      let rows: string[][];
      if (name.endsWith('.xlsx')) rows = await readXlsx(new Uint8Array(await f.arrayBuffer()));
      else if (name.endsWith('.csv') || name.endsWith('.txt')) rows = parseCsv((await f.text()).replace(/^﻿/, ''));
      else { setErr(t('imp.fileType')); return; }
      if (rows.length > 5020) { setErr(t('imp.tooMany')); return; }
      setFile({ name: f.name, rows });
      await check(rows);
    } catch { setErr(t('imp.unreadable')); }
  };
  const run = async () => {
    if (!file || !kind) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api<{ imported: number; skipped: number }>(`/api/companies/${books.company.id}/import/${kind}/run`, { body: body(file.rows) });
      setDone(r); setP(undefined); setFile(undefined);
    } catch (e) { setErr(errorText(t, has, e)); } finally { setBusy(false); }
  };
  const reset = (k: ImportKind | null) => { setKind(k); setFile(undefined); setP(undefined); setErr(undefined); setDone(undefined); };
  const cols = kind ? COLUMNS[kind] : [];
  const shown = (p?.rows ?? []).filter((r) => !onlyProblems || r.status === 'error');
  const canImport = p && !p.missing.length && (kind === 'opening' ? !p.counts.error && !p.opening?.problems.length : p.counts.new > 0);
  const label = (key: string) => { const c = cols.find((x) => x.key === key); return c ? (lang === 'ar' ? c.ar : c.en) : key; };
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('imp.hint')}</div>
      {!only && <div className="grid imp-kinds">
        {IMPORT_KINDS.map((k) => (
          <button key={k} id={`imp-${k}`} className={`card fig tile ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => reset(k)}>
            <b style={{ fontSize: 16 }}>{t(`imp.k.${k}` as Key)}</b><small>{t(`imp.kHint.${k}` as Key)}</small>
          </button>
        ))}
      </div>}
      {done && kind && (
        <div className="notice" id="imp-done">{t('imp.done', { n: done.imported, skipped: done.skipped })} <button className="link" onClick={() => go(WHERE[kind][0], WHERE[kind][1])}>{t(`imp.open.${kind}` as Key)}</button></div>
      )}
      {kind && <div className="card">
        <h2>{t('imp.step2', { what: t(`imp.k.${kind}` as Key) })}</h2>
        <p className="small">{t('imp.columns')} {cols.map((c, i) => <span key={c.key}>{i ? ', ' : ''}<b>{lang === 'ar' ? c.ar : c.en}</b>{c.required ? ' *' : ''}</span>)}</p>
        <p className="small mut">{t(`imp.notes.${kind}` as Key)}</p>
        <div className="actions" style={{ marginBottom: 10 }}>
          <button className="b" id="imp-template" onClick={() => save(`nusuh-${kind}-template.csv`, template(kind, 'en'), 'text/csv;charset=utf-8')}>{t('imp.templateEn')}</button>
          <button className="b" onClick={() => save(`nusuh-${kind}-template-ar.csv`, template(kind, 'ar'), 'text/csv;charset=utf-8')}>{t('imp.templateAr')}</button>
        </div>
        {kind === 'opening' && <div className="row">
          <label className="f">{t('imp.date')}<input id="imp-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); if (file) void check(file.rows, kind, { date: e.target.value }); }} /></label>
          <label className="check-one" style={{ alignSelf: 'end', marginBottom: 12 }}><input type="checkbox" id="imp-equity" checked={toEquity} onChange={(e) => { setToEquity(e.target.checked); if (file) void check(file.rows, kind, { eq: e.target.checked }); }} />
            <span>{t('imp.toEquity')}</span></label>
        </div>}
        <label className="imp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files[0]); }}>
          <input id="imp-file" type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          <b>{file ? file.name : t('imp.choose')}</b><span className="small mut">{t('imp.chooseHint')}</span>
        </label>
        {err && <div className="notice bad" role="alert">{err}</div>}
        {busy && <div className="mut small">{t('loading')}</div>}
      </div>}
      {p && kind && <div className="card" id="imp-preview">
        <h2>{t('imp.step3')}</h2>
        {p.missing.length > 0 ? <div className="notice bad">{t('imp.missing', { cols: p.missing.map(label).join(', ') })}</div> : <>
          <div className="actions" style={{ marginBottom: 8 }}>
            <span className="badge good">{t('imp.c.new', { n: p.counts.new })}</span>
            {kind !== 'opening' && <span className="badge">{t('imp.c.exists', { n: p.counts.exists })}</span>}
            <span className={`badge ${p.counts.error ? 'bad' : ''}`}>{t('imp.c.error', { n: p.counts.error })}</span>
            <span className="spacer" />
            {p.counts.error > 0 && <label className="check-one small"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />{t('imp.onlyProblems')}</label>}
          </div>
          {p.opening && <div className={`notice ${p.opening.problems.length ? 'warn' : ''}`}>
            {t('imp.totals', { debit: fmt(p.opening.debit), credit: fmt(p.opening.credit), diff: fmt(p.opening.difference) })}
            {[...p.opening.problems, ...p.opening.warnings].map((x) => <div key={x} className="small">• {t(x as Key)}</div>)}
          </div>}
          <div className="wrap"><table className="mini imp-table">
            <thead><tr><th>{t('imp.line')}</th>{cols.slice(0, 4).map((c) => <th key={c.key}>{lang === 'ar' ? c.ar : c.en}</th>)}<th>{t('imp.what')}</th></tr></thead>
            <tbody>{shown.slice(0, 300).map((r) => (
              <tr key={r.line} className={r.status === 'error' ? 'imp-bad' : ''}>
                <td className="mut">{r.line}</td>{cols.slice(0, 4).map((c) => <td key={c.key}>{r.values[c.key] ?? ''}</td>)}
                <td><span className={`badge ${TONE[r.status]}`}>{t(`imp.s.${r.status}` as Key)}</span>{r.problems.length > 0 && <div className="small bad">{r.problems.map((x) => t(x as Key)).join(' · ')}</div>}</td>
              </tr>))}</tbody>
          </table></div>
          {shown.length > 300 && <p className="small mut">{t('imp.more', { n: shown.length - 300 })}</p>}
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="b p" id="imp-run" disabled={busy || !canImport} onClick={() => void run()}>
              {kind === 'opening' ? t('imp.postOpening') : t('imp.run', { n: p.counts.new })}</button>
            <span className="small mut">{kind === 'opening' ? t('imp.runHintOpening') : t('imp.runHint')}</span>
          </div>
        </>}
      </div>}
    </>
  );
}
