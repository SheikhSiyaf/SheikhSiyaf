// Brochure demo data: one accounting firm (Al Amal Accounting) and seven fictional companies, in a THROWAWAY local
// database. Run with `npx tsx tools/brochure/seed.ts` (add `--teardown` to remove everything).
//
// Safety, by construction:
//   - It only talks to a database on this machine (localhost) whose name contains "brochure", and refuses anything else.
//   - Passwords are generated at run time and kept in a state file outside the repository (BROCHURE_STATE, default in the
//     system temp folder, readable only by you). They are never printed and never committed.
//   - Everything is fictional: names, numbers, @example.com emails, obviously fake VAT, ID and bank numbers.
//   - E-invoicing is left unconnected: nothing is sent to ZATCA and no invoice shows a clearance.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/auth/password.js';
import { CHART_TEMPLATE } from '../../src/books/chartTemplate.js';
import { DEFAULT_MODULES, type Industry, type OptionalModule } from '../../src/books/modules.js';
import { daysAgo, fakeVat, makeCtx } from './lib.js';
import { BUILDERS, finishFirm } from './build.js';

export const ADMIN_URL = process.env.BROCHURE_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const DB_NAME = process.env.BROCHURE_DB ?? 'nusuh_brochure';
export const STATE_FILE = process.env.BROCHURE_STATE ?? join(tmpdir(), 'nusuh-brochure-state.json');
export const FIRM = 'Al Amal Accounting';

export interface State { appPassword: string; passwords: Record<string, string>; companies: Record<string, string>; users: Record<string, string>; facts: Record<string, Record<string, string>> }
export const urlFor = (user?: string, password?: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; if (user) { u.username = user; u.password = password ?? ''; } return u.toString(); };
export const readState = (): State | null => (existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : null);

function guard() {
  const host = new URL(ADMIN_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('The brochure data only goes into a database on this machine. Refusing.');
  if (!/brochure/i.test(DB_NAME)) throw new Error('The database name must contain "brochure". Refusing.');
}

export interface CompanySpec { key: string; name: string; nameAr: string; industry: Industry; city: string; prefix: string; modules?: OptionalModule[]; owner: [string, string] }
export const COMPANIES: CompanySpec[] = [
  { key: 'corniche', name: 'Corniche Resort', nameAr: 'منتجع الكورنيش', industry: 'hospitality', city: 'Jeddah', prefix: 'CR-', owner: ['Saud Al-Harbi', 'سعود الحربي'] },
  { key: 'najd', name: 'Najd Contracting', nameAr: 'نجد للمقاولات', industry: 'construction', city: 'Riyadh', prefix: 'NC-', owner: ['Fahad Al-Dossari', 'فهد الدوسري'] },
  { key: 'gulf', name: 'Gulf Steel Trading', nameAr: 'الخليج لتجارة الحديد', industry: 'trading', city: 'Dammam', prefix: 'GST-', owner: ['Majed Al-Shammari', 'ماجد الشمري'] },
  { key: 'zaytoon', name: 'Al Zaytoon Café', nameAr: 'مقهى الزيتون', industry: 'restaurant', city: 'Madinah', prefix: 'AZ-', owner: ['Reem Al-Juhani', 'ريم الجهني'] },
  { key: 'rmart', name: 'Riyadh Mart', nameAr: 'رياض مارت', industry: 'retail', city: 'Riyadh', prefix: 'RM-', owner: ['Turki Al-Subaie', 'تركي السبيعي'] },
  { key: 'rose', name: 'Desert Rose Consulting', nameAr: 'وردة الصحراء للاستشارات', industry: 'services', city: 'Jeddah', prefix: 'DRC-', owner: ['Noura Al-Qahtani', 'نورة القحطاني'] },
  { key: 'eastern', name: 'Eastern Fabrication', nameAr: 'الشرقية للتصنيع', industry: 'manufacturing', city: 'Jubail', prefix: 'EF-', owner: ['Khaled Al-Anazi', 'خالد العنزي'] },
];
const STAFF = [
  { key: 'admin', name: 'Nadia Al-Subaie', email: 'admin@amal.example', kind: 'admin', role: 'admin', clients: [] as string[] },
  { key: 'partner', name: 'Turki Al-Mutairi', email: 'partner@amal.example', kind: 'firm_staff', role: 'partner', clients: ['corniche', 'najd', 'gulf', 'zaytoon', 'rmart', 'rose'] },
  { key: 'reviewer', name: 'Lama Al-Rashidi', email: 'reviewer@amal.example', kind: 'firm_staff', role: 'reviewer', clients: ['corniche', 'gulf', 'zaytoon'] },
  { key: 'staff1', name: 'Rakan Al-Otaibi', email: 'rakan@amal.example', kind: 'firm_staff', role: 'staff_accountant', clients: ['najd', 'rmart'] },
  { key: 'staff2', name: 'Hessa Al-Ghamdi', email: 'hessa@amal.example', kind: 'firm_staff', role: 'staff_accountant', clients: ['rose', 'eastern'] },
] as const;
export const ownerEmail = (key: string) => `demo.owner@${key}.example`;

export async function seed(): Promise<'seeded' | 'exists'> {
  guard();
  const only = (process.env.BROCHURE_ONLY ?? '').split(',').filter(Boolean);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const have = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME])).rowCount;
  if (have && !readState()) { await admin.end(); throw new Error(`The database ${DB_NAME} exists but its state file is missing, so the demo logins are unknown. Run with --teardown first.`); }
  const state: State = readState() ?? { appPassword: randomBytes(18).toString('hex'), passwords: {}, companies: {}, users: {}, facts: {} };
  if (!have) {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(DB_NAME)}`);
    writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
    await migrate(urlFor(), state.appPassword);
  }
  await admin.end();

  const client = new pg.Client({ connectionString: urlFor() });
  await client.connect();
  try {
    return await populate(client, state, only, () => writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 }));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { await client.end(); }
}

/** Fills an already migrated database with the firm, its staff, the companies and their data. `persist` is called whenever
 *  the logins in `state` change. Used by the brochure (a local throwaway database) and by the demo site's seed. */
export async function populate(client: pg.Client, state: State, only: string[], persist: () => void): Promise<'seeded' | 'exists'> {
  const asUser = (id: string) => client.query("SELECT set_config('app.user_id', $1, true)", [id]);
  {
    if ((await client.query('SELECT 1 FROM firms WHERE name = $1', [FIRM])).rowCount) return 'exists';
    await client.query('BEGIN');
    const firmId: string = (await client.query('INSERT INTO firms (name) VALUES ($1) RETURNING id', [FIRM])).rows[0].id;
    const specs = COMPANIES.filter((c) => !only.length || only.includes(c.key));
    const people = [
      ...STAFF.map((s) => ({ email: s.email, name: s.name, kind: s.kind as string, staffRole: s.kind === 'firm_staff' ? (s.role as string) : null })),
      ...specs.map((c) => ({ email: ownerEmail(c.key), name: c.owner[0], kind: 'client', staffRole: null as string | null })),
    ];
    for (const p of people) {
      state.passwords[p.email] = randomBytes(15).toString('base64url');
      state.users[p.email] = (await client.query(
        `INSERT INTO users (firm_id, kind, full_name, email, password_hash, staff_role, password_set_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [firmId, p.kind, p.name, p.email, await hashPassword(state.passwords[p.email]!), p.staffRole])).rows[0].id;
    }
    const adminId = state.users['admin@amal.example']!;
    await asUser(adminId);
    for (const [n, c] of specs.entries()) {
      const id: string = (await client.query(
        `INSERT INTO companies (firm_id, name, name_ar, country, currency, cr_number, legal_form, vat_status, vat_number, vat_rate, address, city, fy_end_month, fy_end_day, invoice_prefix, industry, modules)
         VALUES ($1,$2,$3,'SA','SAR',$4,'LLC','registered',$5,'15.00','Demo address, King Fahd Road',$6,12,31,$7,$8,$9) RETURNING id`,
        [firmId, c.name, c.nameAr, `1000${String(100000 + n)}`, fakeVat(n + 1), c.city, c.prefix, c.industry, c.modules ?? DEFAULT_MODULES[c.industry]])).rows[0].id;
      state.companies[c.key] = id;
      await client.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,$3)', [state.users[ownerEmail(c.key)], id, 'client_accountant']);
      for (const s of STAFF.filter((x) => (x.clients as readonly string[]).includes(c.key))) {
        await client.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,$3)', [state.users[s.email], id, s.role]);
      }
      await client.query('SELECT setup_company_books($1, $2, $3)', [id, JSON.stringify(CHART_TEMPLATE), new Date().getUTCFullYear()]);
    }
    await client.query('COMMIT');
    persist();

    for (const [n, c] of specs.entries()) {
      const ctx = await makeCtx(client, { id: state.companies[c.key]!, key: c.key, name: c.name, vatRate: '15.00', firmId, poster: state.users[ownerEmail(c.key)]!, partner: state.users['partner@amal.example']!, userIds: state.users, seed: 1000 + n });
      await client.query('BEGIN');
      await asUser(ctx.poster);
      const started = Date.now();
      state.facts[c.key] = await BUILDERS[c.key]!(ctx);
      await client.query('COMMIT');
      console.log(`  ${c.name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
      persist();
    }
    await client.query('BEGIN');
    await finishFirm(client, state, firmId);
    await client.query('COMMIT');
    persist();
    return 'seeded';
  }
}

export async function teardown(): Promise<void> {
  guard();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(DB_NAME)} WITH (FORCE)`);
  await admin.end();
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}

if (process.argv[1]?.endsWith('tools/brochure/seed.ts')) {
  const run = process.argv.includes('--teardown') ? teardown().then(() => console.log('Brochure database and logins removed.')) : seed().then((r) => console.log(r === 'exists' ? 'Already seeded.' : 'Brochure data loaded (no logins printed).'));
  run.catch((e: unknown) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
}
void daysAgo;
