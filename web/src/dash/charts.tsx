// Small charts drawn as SVG: no library, so the colours, the right-to-left mirroring and the text alternatives are fully ours.
// Every chart carries a text alternative (a visually hidden table), because a picture alone is no use to a screen reader.
// The values drawn are display figures made from the exact amounts the server sent; the exact amounts themselves are shown as text.
import { useI18n } from '../i18n.tsx';

export const SERIES = ['var(--dc1)', 'var(--dc2)', 'var(--dc3)', 'var(--dc4)', 'var(--dc5)', 'var(--dc6)', 'var(--dc7)', 'var(--dc8)'];
export interface Series { label: string; values: number[]; color?: string }

const W = 360, H = 190, PAD = { l: 8, r: 8, t: 12, b: 26 };
const nice = (max: number) => { if (max <= 0) return 1; const p = 10 ** Math.floor(Math.log10(max)); const n = max / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const short = (n: number) => { const a = Math.abs(n); const s = a >= 1e9 ? `${+(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${+(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(a / 1e3).toFixed(1)}K` : String(Math.round(a)); return n < 0 ? `-${s}` : s; };

/** The same data as a table for screen readers. */
function TextAlt({ labels, series, caption }: { labels: string[]; series: Series[]; caption: string }) {
  return (
    <table className="dash-sr"><caption>{caption}</caption>
      <thead><tr><th />{series.map((s) => <th key={s.label}>{s.label}</th>)}</tr></thead>
      <tbody>{labels.map((l, i) => <tr key={l + i}><th>{l}</th>{series.map((s) => <td key={s.label}>{s.values[i]}</td>)}</tr>)}</tbody>
    </table>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return <div className="dash-legend">{series.map((s, i) => <span key={s.label}><i style={{ background: s.color ?? SERIES[i % SERIES.length] }} />{s.label}</span>)}</div>;
}

/** Grouped bars over time. `labels` and values run oldest to newest; in right-to-left they are mirrored so time still reads in the reader's direction. */
export function BarChart({ labels, series, caption }: { labels: string[]; series: Series[]; caption: string }) {
  const { lang } = useI18n();
  const rtl = lang === 'ar';
  const ls = rtl ? [...labels].reverse() : labels;
  const ss = series.map((s) => ({ ...s, values: rtl ? [...s.values].reverse() : s.values }));
  const all = ss.flatMap((s) => s.values), flat = all.every((v) => v === 0), top = nice(Math.max(0, ...all)), bottom = Math.min(0, ...all) < 0 ? -nice(-Math.min(...all)) : 0;
  const span = top - bottom, iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - bottom) / span) * ih;
  const gw = iw / Math.max(1, ls.length), bw = Math.min(28, (gw * 0.7) / ss.length);
  return (
    <div className="dash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet" className="ltr">
        {(flat ? [0] : [bottom, (bottom + top) / 2, top]).map((v, i) => <g key={i}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="dash-grid" /><text x={rtl ? W - PAD.r : PAD.l} y={y(v) - 3} className="dash-tick" textAnchor={rtl ? 'end' : 'start'}>{short(v)}</text></g>)}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="dash-axis" />
        {ls.map((l, i) => {
          const x0 = PAD.l + gw * i + (gw - bw * ss.length) / 2;
          return (
            <g key={l + i}>
              {ss.map((s, k) => { const v = s.values[i] ?? 0; const yy = y(Math.max(v, 0)); return <rect key={s.label} x={x0 + bw * k} y={yy} width={bw - 2} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={2} fill={s.color ?? SERIES[k % SERIES.length]}><title>{`${s.label}, ${l}: ${v}`}</title></rect>; })}
              <text x={PAD.l + gw * i + gw / 2} y={H - 8} className="dash-label" textAnchor="middle">{l}</text>
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
      <TextAlt labels={labels} series={series} caption={caption} />
    </div>
  );
}

export function LineChart({ labels, series, caption }: { labels: string[]; series: Series[]; caption: string }) {
  const { lang } = useI18n();
  const rtl = lang === 'ar';
  const ls = rtl ? [...labels].reverse() : labels;
  const ss = series.map((s) => ({ ...s, values: rtl ? [...s.values].reverse() : s.values }));
  const all = ss.flatMap((s) => s.values), flat = all.every((v) => v === 0), top = nice(Math.max(0, ...all)), bottom = Math.min(0, ...all) < 0 ? -nice(-Math.min(...all)) : 0;
  const span = top - bottom, iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - bottom) / span) * ih;
  const x = (i: number) => PAD.l + (ls.length === 1 ? iw / 2 : (iw * i) / (ls.length - 1));
  return (
    <div className="dash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet" className="ltr">
        {(flat ? [0] : [bottom, (bottom + top) / 2, top]).map((v, i) => <g key={i}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="dash-grid" /><text x={rtl ? W - PAD.r : PAD.l} y={y(v) - 3} className="dash-tick" textAnchor={rtl ? 'end' : 'start'}>{short(v)}</text></g>)}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="dash-axis" />
        {ss.map((s, k) => (
          <g key={s.label}>
            <polyline fill="none" stroke={s.color ?? SERIES[k % SERIES.length]} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill={s.color ?? SERIES[k % SERIES.length]}><title>{`${s.label}, ${ls[i]}: ${v}`}</title></circle>)}
          </g>
        ))}
        {ls.map((l, i) => <text key={l + i} x={x(i)} y={H - 8} className="dash-label" textAnchor="middle">{l}</text>)}
      </svg>
      <Legend series={series} />
      <TextAlt labels={labels} series={series} caption={caption} />
    </div>
  );
}

/** A ring split into slices, with the slices listed beside it. */
export function Donut({ slices, caption, format }: { slices: { label: string; value: number; text: string }[]; caption: string; format?: (n: number) => string }) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  let acc = 0;
  return (
    <div className="dash-donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={caption} className="ltr">
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--line)" strokeWidth="6" />
        {total > 0 && slices.map((s, i) => {
          const pct = (Math.max(0, s.value) / total) * 100; const el = <circle key={s.label + i} cx="21" cy="21" r="15.9155" fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth="6" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={25 - acc} />;
          acc += pct; return el;
        })}
      </svg>
      <ul>{slices.map((s, i) => <li key={s.label + i}><i style={{ background: SERIES[i % SERIES.length] }} /><span className="dash-name">{s.label}</span><b className="ltr">{s.text}</b>{total > 0 && <small className="mut">{format ? format(s.value) : `${Math.round((Math.max(0, s.value) / total) * 100)}%`}</small>}</li>)}</ul>
    </div>
  );
}

/** A ranked list with a bar behind each row (the longest bar is the largest amount). */
export function HBars({ rows, caption }: { rows: { label: string; value: number; text: string; color?: string }[]; caption: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="dash-hbars" aria-label={caption}>
      {rows.map((r, i) => (
        <li key={r.label + i}>
          <span className="dash-hbar-top"><span className="dash-name">{r.label}</span><b className="ltr">{r.text}</b></span>
          <span className="dash-hbar-track"><span style={{ width: `${max > 0 ? Math.max(2, (Math.max(0, r.value) / max) * 100) : 0}%`, background: r.color ?? SERIES[i % SERIES.length] }} /></span>
        </li>
      ))}
    </ul>
  );
}
