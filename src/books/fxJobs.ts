// The daily foreign currency jobs, run by the server (src/api/main.ts), not by a person:
//   * sync: for each company currency, today's rates for the currencies in CURRENCIES from the rate provider
//     (FX_RATES_URL, "{base}" replaced by the currency), stored as shared rates. GCC currencies and the US dollar always
//     come from the central bank pegs, so they are there even when the provider cannot be reached.
//   * automatic month-end revaluation: for companies that turned it on, the last month end is revalued as the person
//     who turned it on (their rights, their name in the audit log). Locked months are skipped; problems are noted.
import type pg from 'pg';
import { withUser } from '../db/session.js';
import { CURRENCIES, pegRates, rateText, ratesFromProvider } from './fx.js';
import * as Fx from './fxService.js';

export const DEFAULT_RATES_URL = 'https://open.er-api.com/v6/latest/{base}';
export type FetchJson = (url: string) => Promise<unknown>;
const realFetch: FetchJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`The rate provider answered ${r.status}.`);
  return r.json();
};
const prevMonthEnd = (day: string) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);

export interface SyncResult { base: string; stored: number; provider: boolean; problem: string | null }

/** Stores today's shared rates for every company currency that does not have them yet (or always, with force). */
export async function syncRates(pool: pg.Pool, o: { day?: string; url?: string; fetchJson?: FetchJson; force?: boolean } = {}): Promise<SyncResult[]> {
  const day = o.day ?? new Date().toISOString().slice(0, 10);
  const url = o.url ?? process.env.FX_RATES_URL ?? DEFAULT_RATES_URL;
  const fetchJson = o.fetchJson ?? realFetch;
  const needs = (await pool.query('SELECT base, currencies, have FROM fx_sync_needs($1)', [day])).rows as { base: string; currencies: string[]; have: number }[];
  const out: SyncResult[] = [];
  for (const n of needs) {
    if (n.have > 0 && !o.force) continue;
    const wanted = [...new Set([...CURRENCIES.map((c) => c.code), ...n.currencies])].filter((c) => c !== n.base);
    let rates: Record<string, bigint> = {}, provider = false, problem: string | null = null;
    try { rates = ratesFromProvider(await fetchJson(url.replace('{base}', n.base)), n.base, wanted); provider = true; }
    catch (e) { problem = (e as Error).message || 'The rate provider could not be reached.'; }
    const pegs = pegRates(n.base);   // central bank pegs win for the pegged currencies
    const rows = [...Object.entries(rates).filter(([c]) => !pegs[c]).map(([c, r]) => ({ currency: c, rate: r, source: hostOf(url) })),
      ...Object.entries(pegs).map(([c, r]) => ({ currency: c, rate: r, source: 'central bank peg' }))]
      .map((x) => ({ rate_date: day, currency: x.currency, base: n.base, rate: rateText(x.rate), source: x.source }));
    const stored = rows.length ? (await pool.query('SELECT store_shared_rates($1) AS n', [JSON.stringify(rows)])).rows[0].n as number : 0;
    out.push({ base: n.base, stored, provider, problem });
  }
  return out;
}
const hostOf = (url: string) => { try { return new URL(url.replace('{base}', 'USD')).host; } catch { return 'rate provider'; } };

/** Revalues last month for every company with the automatic revaluation on. */
export async function runAutoRevaluations(pool: pg.Pool, day = new Date().toISOString().slice(0, 10)) {
  const pe = prevMonthEnd(day);
  const due = (await pool.query('SELECT company_id, enabled_by FROM fx_auto_due($1)', [pe])).rows as { company_id: string; enabled_by: string }[];
  const out: { companyId: string; ok: boolean; problem: string | null }[] = [];
  for (const d of due) {
    let problem: string | null = null;
    try { await withUser(pool, d.enabled_by, (db) => Fx.post(db, d.company_id, pe, { automatic: true })); }
    catch (e) { problem = (e as Error).message; }
    await pool.query('SELECT fx_auto_note($1, $2)', [d.company_id, problem]);
    out.push({ companyId: d.company_id, ok: !problem, problem });
  }
  return out;
}

/** Runs both jobs now and then every hour (each does nothing when today's work is already done). */
export function startFxJobs(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.FX_JOBS === 'off') return () => undefined;
  const run = async () => {
    try {
      for (const r of await syncRates(pool)) log(`Exchange rates for ${r.base}: ${r.stored} stored${r.problem ? ` (provider: ${r.problem}; central bank pegs used)` : ''}.`);
      for (const r of await runAutoRevaluations(pool)) log(`Automatic revaluation ${r.companyId}: ${r.ok ? 'posted' : r.problem}`);
    } catch (e) { log(`Exchange rate job failed: ${(e as Error).message}`); }
  };
  const first = setTimeout(() => void run(), 10_000);
  const every = setInterval(() => void run(), 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
