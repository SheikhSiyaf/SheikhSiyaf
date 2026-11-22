// Fills the DEMO SITE's database with the fictional demo companies (one per client type) and the accounting firm that
// holds them. Run from GitHub Actions (.github/workflows/demo-site.yml) or by hand:
//     DEMO_DATABASE_ADMIN_URL=... DEMO_APP_DB_PASSWORD=... npx tsx tools/demo/seedDemoSite.ts [--reset]
// It is meant for a database made ONLY for the demo site. Safeguards, by construction:
//   - it refuses a database that already holds any customer (anything other than the platform and the demo firm);
//   - --reset (drops everything and starts again, to bring the dates up to today) works only on a database that is
//     already marked as a demo database;
//   - when done it checks that the database reads as a demo database (db/migrations/0064).
// Everything is fictional: names, numbers, @example addresses, obviously fake VAT and bank numbers. Nothing is sent anywhere.
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { clientConfig } from '../../src/db/ssl.js';
import { config } from '../../src/config.js';
import { COMPANIES, FIRM, ownerEmail, populate, type State } from '../brochure/seed.js';
import { ROLE_MODULES } from '../../src/books/modules.js';

const BLURBS: Record<string, { en: string; ar: string }> = {
  corniche: { en: 'Rooms and bookings, restaurant, events, staff payroll', ar: 'الغرف والحجوزات والمطعم والفعاليات ورواتب الموظفين' },
  najd: { en: 'Projects with budgets, equipment rentals, site staff payroll', ar: 'مشاريع بميزانيات وتأجير معدات ورواتب موظفي المواقع' },
  gulf: { en: 'Stock, purchase orders, sales, bank reconciliation', ar: 'المخزون وأوامر الشراء والمبيعات وتسوية البنك' },
  zaytoon: { en: 'Menu and kitchen stock, daily takings, staff', ar: 'القائمة ومخزون المطبخ والمبيعات اليومية والموظفون' },
  rmart: { en: 'Barcodes, stock and daily sales across 120 items', ar: 'الباركود والمخزون والمبيعات اليومية لـ 120 صنفاً' },
  rose: { en: 'Projects, quotes, recurring invoices, CRM', ar: 'المشاريع وعروض الأسعار والفواتير المتكررة وإدارة العملاء' },
  eastern: { en: 'Materials, job projects, machines, finished goods', ar: 'المواد ومشاريع التصنيع والآلات والبضائع التامة' },
};
const TYPE_AR: Record<string, string> = { hospitality: 'فندق ومنتجع', construction: 'مقاولات', trading: 'تجارة', restaurant: 'مطعم ومقهى', retail: 'تجزئة', services: 'خدمات واستشارات', manufacturing: 'تصنيع' };
const TYPE_EN: Record<string, string> = { hospitality: 'Hotel and resort', construction: 'Construction', trading: 'Trading', restaurant: 'Restaurant and café', retail: 'Retail', services: 'Services and consulting', manufacturing: 'Manufacturing' };
const ORDER = ['corniche', 'najd', 'gulf', 'zaytoon', 'rmart', 'rose', 'eastern'];

function die(msg: string): never { console.error(msg); process.exit(1); }

async function main() {
  const adminUrl = process.env.DEMO_DATABASE_ADMIN_URL ?? die('DEMO_DATABASE_ADMIN_URL is not set (the demo database\'s owner login).');
  const appPassword = process.env.DEMO_APP_DB_PASSWORD ?? die('DEMO_APP_DB_PASSWORD is not set (the password for the nusuh_app role).');
  if (appPassword.length < 16) die('DEMO_APP_DB_PASSWORD must be at least 16 characters.');
  const reset = process.argv.includes('--reset');
  const open = async () => { const c = new pg.Client(clientConfig(adminUrl, config.databaseCa)); await c.connect(); return c; };

  if (reset) {
    const c = await open();
    try {
      const marked = (await c.query(`SELECT to_regclass('public.demo_marker') IS NOT NULL AS t`)).rows[0].t
        && (await c.query('SELECT demo_database_ok() AS ok')).rows[0].ok;
      if (!marked) die('Refusing --reset: this database is not marked as a demo database (or it holds a real customer).');
      await c.query('DROP SCHEMA public CASCADE');
      await c.query('CREATE SCHEMA public');
      console.log('Demo database cleared.');
    } finally { await c.end(); }
  }

  await migrate(adminUrl, appPassword);
  const client = await open();
  try {
    const marked = (await client.query('SELECT count(*)::int AS n FROM demo_marker')).rows[0].n > 0;
    if (marked) { console.log('The demo database is already filled. Use --reset to start it again with up-to-date dates.'); return; }
    const customers = (await client.query(`SELECT name FROM firms WHERE kind <> 'platform'`)).rows;
    if (customers.length) die(`Refusing: this database already holds ${customers.length} customer(s). The demo site needs a database of its own.`);

    const state: State = { appPassword, passwords: {}, companies: {}, users: {}, facts: {} };
    const started = Date.now();
    const r = await populate(client, state, [], () => undefined);
    if (r !== 'seeded') die('The demo data could not be created.');
    console.log(`Demo companies created in ${((Date.now() - started) / 1000).toFixed(0)} s.`);

    const firmId: string = (await client.query('SELECT id FROM firms WHERE name = $1', [FIRM])).rows[0].id;
    // The demo owners can try everything: every module at view-and-enter, including the owner reports and ownership.
    const permissions = JSON.stringify(Object.fromEntries(ROLE_MODULES.map((m) => [m, 'edit'])));
    const roleId: string = (await client.query(
      `INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve) VALUES ($1, 'Demo owner (everything)', 'مالك تجريبي (كل شيء)', 'Every module, for trying the demo', $2, true) RETURNING id`,
      [firmId, permissions])).rows[0].id;
    for (const c of COMPANIES) {
      await client.query('UPDATE memberships SET client_role_id = $1 WHERE user_id = $2', [roleId, state.users[ownerEmail(c.key)]]);
    }
    await client.query('INSERT INTO demo_marker (firm_id) VALUES ($1)', [firmId]);
    let sort = 1;
    for (const key of ORDER) {
      const c = COMPANIES.find((x) => x.key === key)!;
      await client.query(
        `INSERT INTO demo_entries (key, title, title_ar, industry, blurb, blurb_ar, user_id, company_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [key, `${TYPE_EN[c.industry]} · ${c.name}`, `${TYPE_AR[c.industry]} · ${c.nameAr}`, c.industry, BLURBS[key]!.en, BLURBS[key]!.ar, state.users[ownerEmail(key)], state.companies[key], sort++]);
    }
    await client.query(
      `INSERT INTO demo_entries (key, title, title_ar, industry, blurb, blurb_ar, user_id, company_id, sort) VALUES ('firm', $1, $2, NULL, $3, $4, $5, NULL, 99)`,
      ['Accounting firm', 'مكتب محاسبة', 'An accounting firm with six clients: review, sign-off, the client portal and deadlines', 'مكتب محاسبة بستة عملاء: المراجعة والاعتماد وبوابة العميل والمواعيد', state.users['partner@amal.example']]);
    if (!(await client.query('SELECT demo_database_ok() AS ok')).rows[0].ok) die('The finished database does not read as a demo database. Check it before using it.');
    console.log(`Done: ${ORDER.length} client types and the accounting firm are ready.`);
  } finally { await client.end(); }
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
