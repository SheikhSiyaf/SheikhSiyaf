// Load test: how much of one CPU core and how much memory the app uses per request, on the throwaway brochure data.
//   npx tsx tools/loadtest/run.ts          (needs the brochure database: npx tsx tools/brochure/seed.ts)
// The app runs as its own process (limited to one core and a memory ceiling); this process only sends requests.
// It reads the app's CPU time from /proc, so the numbers are "CPU milliseconds per request", which can then be
// scaled to any server size. Demo passwords come from the brochure state file and are never printed.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readState, urlFor, ownerEmail } from '../brochure/seed.js';

const PORT = Number(process.env.LOAD_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const SECONDS = Number(process.env.LOAD_SECONDS ?? 20);
const HEAP_MB = Number(process.env.LOAD_HEAP_MB ?? 384);

if (process.argv[2] === 'serve') {
  const { buildServer, WEB_DIST } = await import('../../src/api/server.js');
  const { createPool } = await import('../../src/db/session.js');
  const state = readState()!;
  const pool = createPool(urlFor('nusuh_app', state.appPassword), { max: Number(process.env.POOL_MAX ?? 10) });
  const server = await buildServer({ pool, sessionSecret: process.env.SESSION_SECRET!, production: false, publicUrl: BASE, cookieSecure: false, demoLogins: false, staticDir: WEB_DIST });
  await server.listen({ port: PORT, host: '127.0.0.1' });
} else {
  await drive();
}

function cpuMs(pid: number): number {      // user + system CPU time of a process, from /proc
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return ((Number(f[11]) + Number(f[12])) * 1000) / 100;
}
function rssMb(pid: number): number { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) / 1024; }
function dbCpuMs(): number {               // CPU time of every PostgreSQL process on this machine
  const out = execFileSync('bash', ['-c', "for p in $(pgrep -x postgres); do cut -d' ' -f14,15 /proc/$p/stat 2>/dev/null; done"]).toString().trim().split('\n');
  return out.reduce((a, l) => { const [u, s] = l.split(' ').map(Number); return a + ((u ?? 0) + (s ?? 0)) * 10; }, 0);
}
function pct(a: number[], p: number): number { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; }

async function drive() {
  let kill = () => {};
  try { await drive2((k) => { kill = k; }); } finally { kill(); }
}
async function drive2(reg: (k: () => void) => void) {
  const state = readState();
  if (!state) throw new Error('No brochure data. Run `npx tsx tools/brochure/seed.ts` first.');
  const child = spawn('taskset', ['-c', '0', 'node', `--max-old-space-size=${HEAP_MB}`, '--import', 'tsx', 'tools/loadtest/run.ts', 'serve'],
    { env: { ...process.env, SESSION_SECRET: randomBytes(24).toString('hex'), NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const pid = child.pid!;
  reg(() => child.kill('SIGTERM'));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }

  const companyId = state.companies.gulf!;
  const email = ownerEmail('gulf');
  const login = async (): Promise<string> => {
    const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: state.passwords[email] }) });
    if (!r.ok) throw new Error(`login failed ${r.status}`);
    return (r.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  };

  // Login cost (the password check is deliberately slow).
  let c0 = cpuMs(pid);
  const cookie = await login();
  for (let i = 0; i < 4; i++) await login().catch(() => undefined);
  const loginCpu = (cpuMs(pid) - c0) / 5;

  const get = (p: string) => ({ method: 'GET', path: `/api/companies/${companyId}${p}` });
  const raw = await (await fetch(`${BASE}/api/companies/${companyId}/chart`, { headers: { cookie } })).json() as unknown;
  const accts = (Array.isArray(raw) ? raw : Object.values(raw as object).find(Array.isArray) ?? []) as { id: string; code: string }[];
  const cash = accts.find((a) => a.code === '1000')!.id, sales = accts.find((a) => a.code === '4000')!.id;
  const contactsRaw = await (await fetch(`${BASE}/api/companies/${companyId}/contacts`, { headers: { cookie } })).json() as unknown;
  const contactList = (Array.isArray(contactsRaw) ? contactsRaw : Object.values(contactsRaw as object).find(Array.isArray) ?? []) as { id: string; isCustomer?: boolean }[];
  const cust = (contactList.find((c) => c.isCustomer) ?? contactList[0])!.id;
  const today = new Date().toISOString().slice(0, 10);
  // A realistic mix: mostly screen loads, some heavy reports, a few postings.
  const mix: { w: number; name: string; req: { method: string; path: string; body?: unknown } }[] = [
    { w: 20, name: 'me', req: { method: 'GET', path: '/api/me' } },
    { w: 14, name: 'overview', req: get('/overview') },
    { w: 10, name: 'contacts', req: get('/contacts') },
    { w: 10, name: 'documents', req: get('/documents?type=invoice') },
    { w: 8, name: 'items', req: get('/items') },
    { w: 6, name: 'open-documents', req: get(`/open-documents?direction=received&contactId=${cust}`) },
    { w: 6, name: 'accounts', req: get("/chart") },
    { w: 5, name: 'entries', req: get('/entries') },
    { w: 4, name: 'bank-accounts', req: get('/bank-accounts') },
    { w: 4, name: 'calendar', req: get('/calendar') },
    { w: 3, name: 'trial-balance', req: get('/reports/trial-balance') },
    { w: 3, name: 'profit-and-loss', req: get('/reports/profit-and-loss') },
    { w: 2, name: 'balance-sheet', req: get('/reports/balance-sheet') },
    { w: 2, name: 'aged', req: get('/reports/aged') },
    { w: 1, name: 'vat-return', req: get('/reports/vat-return') },
    { w: 2, name: 'POST journal entry', req: { method: 'POST', path: `/api/companies/${companyId}/entries`, body: { entryDate: today, memo: 'Load test entry', lines: [{ accountId: cash, debit: '10.00' }, { accountId: sales, credit: '10.00' }] } } },
  ];
  const total = mix.reduce((a, m) => a + m.w, 0);
  const pick = () => { let x = Math.random() * total; for (const m of mix) { if ((x -= m.w) < 0) return m; } return mix[0]!; };

  const results: string[] = [];
  const errorsSeen = new Map<string, number>();
  for (const conc of [1, 5, 10, 20, 40]) {
    const lat: number[] = [], per = new Map<string, number[]>();
    let ok = 0, bad = 0, stop = false;
    const cpuA = cpuMs(pid), dbA = dbCpuMs(), t0 = Date.now();
    const worker = async () => {
      while (!stop) {
        const m = pick();
        const s = performance.now();
        try {
          const r = await fetch(`${BASE}${m.req.path}`, { method: m.req.method, headers: { cookie, ...(m.req.body ? { 'content-type': 'application/json' } : {}) }, body: m.req.body ? JSON.stringify(m.req.body) : undefined });
          await r.arrayBuffer();
          if (r.ok) ok++; else { bad++; errorsSeen.set(`${m.name} ${r.status}`, (errorsSeen.get(`${m.name} ${r.status}`) ?? 0) + 1); }
        } catch { bad++; }
        const ms = performance.now() - s; lat.push(ms);
        (per.get(m.name) ?? per.set(m.name, []).get(m.name)!).push(ms);
      }
    };
    const workers = Array.from({ length: conc }, worker);
    await new Promise((r) => setTimeout(r, SECONDS * 1000)); stop = true; await Promise.all(workers);
    const secs = (Date.now() - t0) / 1000, n = ok + bad, cpu = cpuMs(pid) - cpuA, db = dbCpuMs() - dbA;
    results.push(`${String(conc).padStart(3)} users at once | ${(n / secs).toFixed(0).padStart(5)} req/s | median ${pct(lat, .5).toFixed(0).padStart(4)} ms | slowest 5% ${pct(lat, .95).toFixed(0).padStart(5)} ms | app CPU ${(cpu / n).toFixed(1).padStart(5)} ms/req (core ${(cpu / 10 / secs).toFixed(0)}%) | database CPU ${(db / n).toFixed(1).padStart(5)} ms/req | memory ${rssMb(pid).toFixed(0)} MB | failed ${bad}/${n}`);
    if (conc === 20) {
      for (const [k, v] of [...per.entries()].sort()) results.push(`      ${k.padEnd(20)} n=${String(v.length).padStart(5)}  median ${pct(v, .5).toFixed(0).padStart(4)} ms  slowest 5% ${pct(v, .95).toFixed(0).padStart(5)} ms`);
    }
  }
  console.log(`\nLogin: ${loginCpu.toFixed(0)} ms of CPU per sign-in (pinned to one core, ${HEAP_MB} MB heap ceiling, pool 10, ${SECONDS} s per step)\n`);
  console.log(results.join('\n'));
  if (errorsSeen.size) console.log('\nErrors:', Object.fromEntries(errorsSeen));
  console.log(`\nPeak memory of the app process: ${rssMb(pid).toFixed(0)} MB`);
  child.kill('SIGTERM');
}
void urlFor;
