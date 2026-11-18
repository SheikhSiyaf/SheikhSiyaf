// A probe across every HTTP route: does any of them answer a crash to empty or nonsense input?
//
// Why this exists. A real client's browser sends an empty field, an old id or a mistyped number every day, and
// anything that can reach the address can send a shape no screen would. A 400 or a 404 is an answer. A 500 is a bug:
// an unhandled exception, a line in the error log for every attempt, and nothing the person can act on.
//
// It walks the route table straight out of src/api/*.ts, so a route written tomorrow is probed with no list to
// update, and it runs against the demo data in its own database, so the ids point at rows that exist and the
// request reaches the handler instead of stopping at "not found".
//
// It found three real crashes the other 687 tests missed, all the same mistake: a request field read as a list
// without checking that it is one, so `(body.lines ?? []).map(...)` on a string threw "lines.map is not a function".
// POST /api/bank-accounts/:id/import, POST /api/companies/:id/reminders/settings and
// POST /api/companies/:id/notifications/read. src/api/errors.ts listOf() is the guard; this keeps them honest.
//
// What it does NOT do: it says nothing about whether a route does the right thing. It only says that no input makes
// the server fall over. The rest of the suite covers behaviour.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { DEMO_PASSWORD } from '../src/db/demoData.js';
import { buildServer } from '../src/api/server.js';
import { createPool } from '../src/db/session.js';
import { hashPassword } from '../src/auth/password.js';
import { APP_PASSWORD, PG_ADMIN_URL } from './config.js';
import { testPool } from './helpers.js';

const DB = process.env.PROBE_DB ?? 'nusuh_route_probe';
// The SAME password the rest of the suite uses, deliberately. migrate() runs `ALTER ROLE nusuh_app PASSWORD ...`,
// and a role belongs to the whole server, not to one database: giving this database its own password changed the
// password every other test file was already connected with, and they failed with "password authentication failed
// for user nusuh_app" while this file passed. Re-setting it to the same value is harmless.
const dbUrl = (user?: string, password?: string) => {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${DB}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
};

let server: FastifyInstance;
let pool: pg.Pool;
let ownerPool: pg.Pool;

async function dropDb() {
  const a = new pg.Client({ connectionString: PG_ADMIN_URL });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${a.escapeIdentifier(DB)} WITH (FORCE)`);
  await a.end();
}

beforeAll(async () => {
  await dropDb();
  const a = new pg.Client({ connectionString: PG_ADMIN_URL });
  await a.connect();
  await a.query(`CREATE DATABASE ${a.escapeIdentifier(DB)}`);
  await a.end();
  await migrate(dbUrl(), APP_PASSWORD);
  await seed(dbUrl());
  ownerPool = testPool(dbUrl(), 2);
  pool = createPool(dbUrl('nusuh_app', APP_PASSWORD));
  // No encryptionKey, so stored secrets are read with the same development default the demo seed wrote them with.
  server = buildServer({ pool, sessionSecret: 'route-probe-session-secret-0123456789', cookieSecure: false });
}, 300_000);

afterAll(async () => {
  await server?.close();
  await pool?.end();
  await ownerPool?.end();
  await dropDb();
});

interface Route { method: string; path: string; file: string }
function routes(): Route[] {
  const out: Route[] = [];
  for (const file of readdirSync('src/api').filter((n) => n.endsWith('.ts'))) {
    const s = readFileSync(`src/api/${file}`, 'utf8');
    for (const m of s.matchAll(/\.(get|post|put|patch|delete)(?:<[^(]*>)?\(\s*'([^']+)'/g)) {
      out.push({ method: m[1]!.toUpperCase(), path: m[2]!, file });
    }
  }
  return out;
}

/**
 * Where a real id for each kind of :param comes from, so the request reaches the handler instead of stopping at
 * "not found". Keyed by the path segment before the parameter, e.g. /api/bank-lines/:id -> bank-lines. The table
 * names are the real ones, checked against the schema at the start of the run: a rename that this map misses fails
 * the test loudly rather than quietly turning the probe into 400 requests that test nothing.
 */
const SOURCE: Record<string, { table: string; where?: string }> = {
  companies: { table: 'companies' }, contacts: { table: 'contacts' }, documents: { table: 'documents' },
  payments: { table: 'payments' }, accounts: { table: 'accounts' }, entries: { table: 'journal_entries' },
  // cc_kind is company | branch | department | project; a cost centre screen shows the first three
  'cost-centres': { table: 'cost_centres', where: "kind <> 'project'" },
  // a project is a cost centre of kind 'project' (src/books/ledgerService.ts saveProject)
  projects: { table: 'cost_centres', where: "kind = 'project'" },
  items: { table: 'items' }, assets: { table: 'fixed_assets' }, 'stock-notes': { table: 'stock_notes' },
  recipes: { table: 'recipes' }, 'bank-accounts': { table: 'bank_accounts' },
  'bank-lines': { table: 'bank_statement_lines' }, 'bank-rules': { table: 'bank_rules' },
  'bank-imports': { table: 'bank_imports' },
  employees: { table: 'contacts', where: 'is_employee' },
  payroll: { table: 'payroll_runs' }, 'payroll-lines': { table: 'payroll_lines' },
  leave: { table: 'leave_requests' }, 'hr-documents': { table: 'employee_documents' },
  'attendance-corrections': { table: 'hr_attendance_corrections' },
  'crm/leads': { table: 'crm_leads' }, 'crm/activities': { table: 'crm_activities' },
  'crm/campaigns': { table: 'crm_campaigns' }, 'crm/deals': { table: 'crm_deals' },
  budgets: { table: 'budgets' }, 'recurring-invoices': { table: 'recurring_invoices' },
  recurring: { table: 'recurring_expenses' }, approvals: { table: 'approval_requests' },
  'forecast/items': { table: 'forecast_items' }, 'fiscal-years': { table: 'fiscal_years' },
  'fx-revaluations': { table: 'fx_revaluations' }, einvoices: { table: 'einvoices' },
  'einvoicing/devices': { table: 'einvoice_devices' }, emails: { table: 'email_outbox' },
  attachments: { table: 'attachments' }, rooms: { table: 'rooms' }, 'room-types': { table: 'room_types' },
  'room-rates': { table: 'room_rates' }, bookings: { table: 'bookings' },
  'booking-extras': { table: 'booking_extras' }, 'rental-items': { table: 'rental_items' },
  'rental-contracts': { table: 'rental_contracts' }, 'rental-lines': { table: 'rental_lines' },
  'support/threads': { table: 'support_threads' }, 'review/queries': { table: 'review_queries' },
  'review/sign-offs': { table: 'review_signoffs' }, 'portal/letters': { table: 'portal_letters' },
  'portal/requests': { table: 'portal_requests' }, 'portal/uploads': { table: 'portal_uploads' },
  'calendar/custom': { table: 'compliance_custom' }, users: { table: 'users' }, plans: { table: 'plans' },
  tenants: { table: 'firms' },
};

/** Parameters named after what they hold, wherever they appear: /api/companies/:id/ledger/account/:accountId. */
const SOURCE_BY_PARAM: Record<string, string> = {
  accountId: 'accounts', contactId: 'contacts', userId: 'users', ccId: 'cost-centres',
  documentId: 'documents', companyId: 'companies',
};

/** Parameters that are not ids at all: a role name, a kind of import, a public link token. */
const LITERAL: Record<string, string> = { role: 'customer', kind: 'contacts', token: 'no-such-token', ref: 'no-such-ref' };

function sourceKey(path: string, paramIndex: number): string {
  const before = path.split('/').filter(Boolean).slice(0, paramIndex).filter((s) => !s.startsWith(':'));
  for (let take = 3; take >= 1; take--) {
    const key = before.slice(-take).join('/').replace(/^api\//, '');
    if (SOURCE[key]) return key;
  }
  return '';
}

describe('Every route, given empty or nonsense input', () => {
  it('never answers a crash', async () => {
    const all = routes().filter((r) => !r.path.includes('*'));
    expect(all.length).toBeGreaterThan(300);

    // Every table this map names must exist. If one is renamed and the map is not, the probe would still pass while
    // quietly testing nothing but "not found", so it is checked rather than skipped.
    const { rows: real } = await ownerPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const exists = new Set(real.map((r) => r.table_name as string));
    const unknown = [...new Set(Object.values(SOURCE).map((s) => s.table))].filter((t) => !exists.has(t));
    expect(unknown, 'tables named in SOURCE that are not in the schema').toEqual([]);

    // one real id for each kind of parameter
    const idOf: Record<string, string> = {};
    for (const [key, s] of Object.entries(SOURCE)) {
      const { rows } = await ownerPool.query(
        `SELECT id FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ''} ORDER BY 1 LIMIT 1`);
      if (rows[0]) idOf[key] = rows[0].id;
    }
    expect(idOf['companies']).toBeTruthy();
    // The demo data does not fill every table. Say which, so a thin spot is visible instead of assumed covered.
    const empty = Object.keys(SOURCE).filter((k) => !idOf[k]);
    if (empty.length) console.error(`probe: no demo row for ${empty.join(', ')} — those routes can only answer "not found"`);

    // one person per role, so each role's own routes are reached
    const { rows: people } = await ownerPool.query(
      `SELECT DISTINCT ON (kind, coalesce(staff_role::text, '')) email, kind, staff_role
         FROM users WHERE status = 'active' AND kind <> 'system'
        ORDER BY kind, coalesce(staff_role::text, ''), email`);
    expect(people.length).toBeGreaterThan(3);

    let signIns = 0;
    const hash = await hashPassword(DEMO_PASSWORD);
    const signIn = async (email: string): Promise<string> => {
      // The probe posts nonsense to the sign-out and password routes along the way, so its own session keeps dying.
      // The password is restored, the recorded attempts cleared, and each sign-in comes from a different address:
      // the per-account and per-address sign-in limits are deliberate and are tested on their own in
      // test/throttle.test.ts. Without this the probe trips them and silently stops testing the routes.
      await ownerPool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email]);
      await ownerPool.query('DELETE FROM auth_attempts');
      signIns++;
      const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: DEMO_PASSWORD },
        remoteAddress: `10.0.${(signIns >> 8) & 255}.${signIns & 255}` });
      if (res.statusCode !== 200) throw new Error(`probe cannot sign in as ${email}: ${res.statusCode} ${res.body}`);
      return String(res.headers['set-cookie']).split(';')[0]!;
    };
    const actors: { who: string; email: string; cookie: string }[] = [];
    for (const p of people) actors.push({ who: `${p.kind}/${p.staff_role ?? '-'}`, email: p.email, cookie: await signIn(p.email) });

    const bodies: unknown[] = [
      {},
      { name: '', amount: 'abc', date: 'not-a-date', id: 'nope', status: 'nonsense' },
      // Every field the code reads as a list, sent as a string instead. This is the mistake that was found:
      // `(body.lines ?? []).map(...)` on a string is an unhandled TypeError, so a 500 instead of a 400.
      ...['lines', 'allocations', 'keys', 'days', 'rows', 'ids', 'staffIds', 'clientIds', 'charges', 'extras']
        .map((k) => ({ [k]: 'x' })),
      // And a list whose members are the wrong shape.
      ...['lines', 'allocations', 'rows'].map((k) => ({ [k]: [{}, 'x', null, 7] })),
    ];

    const crashes: string[] = [];
    const status: Record<number, number> = {};
    let total = 0, reached = 0;

    for (const r of all) {
      const url = '/' + r.path.split('/').filter(Boolean).map((s, i) => {
        if (!s.startsWith(':')) return s;
        const name = s.slice(1);
        if (LITERAL[name]) return LITERAL[name]!;
        const byParam = SOURCE_BY_PARAM[name];
        if (byParam && idOf[byParam]) return idOf[byParam]!;
        return idOf[sourceKey(r.path, i)] ?? idOf['companies']!;
      }).join('/');

      for (const actor of actors) {
        for (const payload of r.method === 'GET' || r.method === 'DELETE' ? [undefined] : bodies) {
          const send = () => server.inject({
            method: r.method as 'GET', url, headers: { cookie: actor.cookie },
            ...(payload === undefined ? {} : { payload: payload as object }),
          });
          let res = await send();
          if (res.statusCode === 401) { actor.cookie = await signIn(actor.email); res = await send(); }
          total++;
          status[res.statusCode] = (status[res.statusCode] ?? 0) + 1;
          if (res.statusCode !== 401 && res.statusCode !== 403) reached++;
          if (res.statusCode >= 500) {
            crashes.push(`${res.statusCode} ${r.method} ${r.path} [${r.file}] as ${actor.who} body=${JSON.stringify(payload)} :: ${res.body.slice(0, 200)}`);
          }
        }
      }
    }

    if (crashes.length) {
      const first = new Map<string, string>();
      for (const c of crashes) first.set(c.slice(0, c.indexOf(' as ')), c);
      console.error(`\n${first.size} crashing route(s) out of ${all.length}:\n` + [...first.values()].join('\n'));
    }
    expect(crashes).toEqual([]);
    // If the probe ever stops reaching handlers it has quietly stopped testing anything, which is worse than a
    // failure, because it still reports green. Fix the setup rather than lowering this.
    expect(reached / total).toBeGreaterThan(0.8);
    expect(total).toBeGreaterThan(5000);
    console.error(`probe: ${total} requests over ${all.length} routes as ${actors.length} roles, statuses ${JSON.stringify(status)}`);
  }, 900_000);
});
