// Loads the demo firm (src/db/demoData.ts) so the app can be tried straight away.
// Runs as the owner but sets app.user_id for each step, so every rule and the audit log apply.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { postEntry, reverseEntry, type LineInput } from '../ledger/ledger.js';
import type { Db } from './session.js';
import { fromMinor } from '../money.js';
import { vatForLine } from '../vat/vat.js';
import { CHART_TEMPLATE } from '../books/chartTemplate.js';
import { DEMO_COMPANIES, DEMO_FIRM, DEMO_PASSWORD, DEMO_USERS } from './demoData.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

export async function seed(adminUrl: string): Promise<'seeded' | 'exists'> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const asUser = (id: string) => client.query("SELECT set_config('app.user_id', $1, true)", [id]);
  try {
    if ((await client.query('SELECT 1 FROM firms WHERE name = $1', [DEMO_FIRM])).rowCount) return 'exists';
    await client.query('BEGIN');
    const firmId: string = (await client.query('INSERT INTO firms (name) VALUES ($1) RETURNING id', [DEMO_FIRM])).rows[0].id;
    const hash = await hashPassword(DEMO_PASSWORD);

    const userIds: Record<string, string> = {};
    for (const u of DEMO_USERS) {
      userIds[u.email] = (await client.query(
        `INSERT INTO users (firm_id, kind, full_name, email, password_hash, staff_role, password_set_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [firmId, u.kind, u.name, u.email, hash, u.kind === 'firm_staff' ? u.role : null])).rows[0].id;
    }
    const admin = userIds['admin@firm.example']!;
    await asUser(admin);

    const companyIds: Record<string, string> = {};
    for (const c of DEMO_COMPANIES) {
      const id: string = (await client.query(
        `INSERT INTO companies (firm_id, name, name_ar, country, currency, cr_number, legal_form, vat_status, vat_number,
           vat_rate, address, city, fy_end_month, fy_end_day, invoice_prefix)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'registered',$8,$9,$10,$11,12,31,$12) RETURNING id`,
        [firmId, c.name, c.nameAr, c.country, c.currency, c.crNumber, c.legalForm, c.vatNumber, c.vatRate, c.address, c.city, c.invoicePrefix])).rows[0].id;
      companyIds[c.key] = id;
      for (const u of DEMO_USERS.filter((x) => x.companies.includes(c.key))) {
        await client.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,$3)', [userIds[u.email], id, u.role]);
      }
      await client.query('SELECT setup_company_books($1, $2, $3)', [id, JSON.stringify(CHART_TEMPLATE), new Date().getUTCFullYear()]);
      await client.query(`INSERT INTO cost_centres (company_id, kind, name, name_ar) VALUES ($1,'branch','Branch 1','الفرع 1'), ($1,'project','Project A','المشروع أ')`, [id]);
    }
    await client.query('COMMIT');

    // Postings, one transaction per company, as the people who would really post them.
    for (const c of DEMO_COMPANIES) {
      const id = companyIds[c.key]!;
      const poster = userIds[DEMO_USERS.find((u) => u.companies.includes(c.key) && ['client_accountant', 'staff_accountant'].includes(u.role))!.email]!;
      const partner = userIds['omar@firm.example']!;
      const acct = Object.fromEntries((await client.query('SELECT code, id FROM accounts WHERE company_id = $1', [id])).rows.map((r) => [r.code, r.id]));
      const cc = Object.fromEntries((await client.query('SELECT name, id FROM cost_centres WHERE company_id = $1', [id])).rows.map((r) => [r.name, r.id]));
      const vat = (net: number) => fromMinor(vatForLine(BigInt(net) * 100n, c.vatRate));
      const gross = (net: number) => fromMinor(BigInt(net) * 100n + vatForLine(BigInt(net) * 100n, c.vatRate));
      const L = (code: string, debit?: string | number, credit?: string | number, centre?: string): LineInput => ({
        accountId: acct[code], debit: debit === undefined ? undefined : String(debit), credit: credit === undefined ? undefined : String(credit),
        costCentreId: centre ? cc[centre] : null });
      const post = (date: string, memo: string, lines: LineInput[]) => postEntry(client as unknown as Db, { companyId: id, entryDate: date, memo, lines });

      await client.query('BEGIN');
      await asUser(poster);
      await post(daysAgo(120), 'Opening balance', [L('1000', '50000.00'), L('3000', undefined, '50000.00')]);
      await post(daysAgo(95), `${c.invoicePrefix}0001 · Gulf Steel`, [L('1100', gross(10000)), L('4000', undefined, '10000.00', 'Head office'), L('2100', undefined, vat(10000))]);
      await post(daysAgo(80), 'Receipt for ' + `${c.invoicePrefix}0001`, [L('1000', gross(10000)), L('1100', undefined, gross(10000))]);
      await post(daysAgo(60), 'Rent · head office', [L('5100', '4000.00', undefined, 'Head office'), L('1000', undefined, '4000.00')]);
      await post(daysAgo(34), `${c.invoicePrefix}0002 · Al Faisal Contracting`, [L('1100', gross(7250)), L('4000', undefined, '5000.00', 'Head office'), L('4000', undefined, '2250.00', 'Branch 1'), L('2100', undefined, vat(7250))]);
      await post(daysAgo(30), 'Bill · Riyadh Wholesale', [L('5000', '3200.00', undefined), L('1200', vat(3200)), L('2000', undefined, gross(3200))]);
      await post(daysAgo(25), 'Salaries', [L('5200', '6000.00', undefined, 'Head office'), L('5200', '2500.00', undefined, 'Branch 1'), L('1000', undefined, '8500.00')]);
      const wrong = await post(daysAgo(12), 'STC bill payment', [L('5300', '420.00'), L('1000', undefined, '420.00')]);
      await reverseEntry(client as unknown as Db, wrong, daysAgo(11), 'Reversal: STC bill posted twice');
      await post(daysAgo(6), `${c.invoicePrefix}0003 · Cash sale`, [L('1000', gross(1800)), L('4000', undefined, '1800.00', 'Project A'), L('2100', undefined, vat(1800))]);
      await post(daysAgo(1), 'Utilities', [L('5300', '650.00'), L('1000', undefined, '650.00')]);
      await client.query('COMMIT');

      // The partner locks every month that ended more than a month ago.
      await client.query('BEGIN');
      await asUser(partner);
      await client.query(
        `UPDATE periods SET locked_at = now() WHERE company_id = $1 AND locked_at IS NULL
           AND end_date < date_trunc('month', current_date) - interval '1 month'`, [id]);
      await client.query('COMMIT');
    }
    return 'seeded';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed(config.databaseAdminUrl)
    .then((r) => console.log(r === 'seeded'
      ? `Demo data loaded. Sign in with any demo user, password "${DEMO_PASSWORD}".`
      : 'Demo data is already loaded.'))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
