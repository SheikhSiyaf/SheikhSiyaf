import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll } from 'vitest';
import { withUser, type Db } from '../src/db/session.js';
import { OWNER_URL, APP_URL } from './config.js';

// Owner connection: bypasses RLS. Used only to seed fixtures and to inspect raw state.
export const owner = new pg.Pool({ connectionString: OWNER_URL, max: 3 });
// Application connection: role nusuh_app, subject to RLS. Every rule is tested through this.
export const app = new pg.Pool({ connectionString: APP_URL, max: 5 });

afterAll(async () => {
  await owner.end();
  await app.end();
});

export const as = <T>(userId: string, fn: (db: Db) => Promise<T>) => withUser(app, userId, fn);

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
export const saCr = () => digits(10);
export const saVat = () => `3${digits(13)}3`;
export const aeTrn = () => digits(15);

export interface Company {
  id: string;
  cash: string; sales: string; rent: string; branchCosts: string; outputVat: string;
  headOffice: string; branch1: string;
  clientAccountant: string; clientViewer: string;
}

export interface Fixture {
  firmId: string;
  admin: string; partner: string; reviewer: string; staff: string;
  a: Company; // Saudi company: partner, reviewer and staff are all assigned
  b: Company; // UAE company: partner and reviewer assigned, staff is NOT
}

async function addUser(c: pg.PoolClient, firmId: string, kind: string, name: string, staffRole?: string): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO users (firm_id, kind, full_name, email, password_hash, staff_role) VALUES ($1, $2, $3, $4, 'x', $5) RETURNING id`,
    [firmId, kind, name, `${name.toLowerCase().replace(/\s+/g, '.')}.${randomUUID().slice(0, 8)}@example.com`, staffRole ?? null],
  );
  return rows[0].id;
}

async function addCompany(c: pg.PoolClient, firmId: string, country: 'SA' | 'AE', staff: [string, string][]): Promise<Company> {
  const sa = country === 'SA';
  const { rows } = await c.query(
    `INSERT INTO companies (firm_id, name, country, currency, cr_number, legal_form, vat_status, vat_number, vat_rate,
                            address, city, fy_end_month, fy_end_day)
     VALUES ($1, $2, $3, $4, $5, 'LLC', 'registered', $6, $7, 'Street 1', $8, 12, 31) RETURNING id`,
    [firmId, `Test ${country} ${randomUUID().slice(0, 6)}`, country, sa ? 'SAR' : 'AED', sa ? saCr() : digits(8),
     sa ? saVat() : aeTrn(), sa ? '15.00' : '5.00', sa ? 'Riyadh' : 'Dubai'],
  );
  const id: string = rows[0].id;
  const clientAccountant = await addUser(c, firmId, 'client', `Client Accountant ${country}`);
  const clientViewer = await addUser(c, firmId, 'client', `Client Viewer ${country}`);
  const members: [string, string][] = [...staff, [clientAccountant, 'client_accountant'], [clientViewer, 'client_viewer']];
  for (const [u, role] of members) {
    await c.query('INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)', [u, id, role]);
  }
  const acct = async (code: string, name: string, type: string, ccRequired = false) =>
    (await c.query(
      `INSERT INTO accounts (company_id, code, name, type, cost_centre_required) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, code, name, type, ccRequired],
    )).rows[0].id as string;
  const cc = async (name: string, kind: string) =>
    (await c.query(`INSERT INTO cost_centres (company_id, kind, name) VALUES ($1,$2,$3) RETURNING id`, [id, kind, name]))
      .rows[0].id as string;
  return {
    id,
    cash: await acct('1000', 'Cash in bank', 'asset'),
    outputVat: await acct('2100', 'Output VAT', 'liability'),
    sales: await acct('4000', 'Sales', 'income'),
    rent: await acct('5000', 'Rent', 'expense'),
    branchCosts: await acct('5100', 'Branch running costs', 'expense', true),
    headOffice: await cc('Head office', 'branch'),
    branch1: await cc('Branch 1', 'branch'),
    clientAccountant,
    clientViewer,
  };
}

/** A firm with two client companies and every kind of user. Each call is fully independent. */
export async function seed(): Promise<Fixture> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const firmId = (await c.query(`INSERT INTO firms (name) VALUES ('Test firm') RETURNING id`)).rows[0].id;
    const admin = await addUser(c, firmId, 'admin', 'Admin');
    const partner = await addUser(c, firmId, 'firm_staff', 'Partner', 'partner');
    const reviewer = await addUser(c, firmId, 'firm_staff', 'Reviewer', 'reviewer');
    const staff = await addUser(c, firmId, 'firm_staff', 'Staff', 'staff_accountant');
    const a = await addCompany(c, firmId, 'SA', [[partner, 'partner'], [reviewer, 'reviewer'], [staff, 'staff_accountant']]);
    const b = await addCompany(c, firmId, 'AE', [[partner, 'partner'], [reviewer, 'reviewer']]);
    await c.query('COMMIT');
    return { firmId, admin, partner, reviewer, staff, a, b };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** A simple balanced sale: Dr cash / Cr sales. */
export const sale = (co: Company, date: string, amount: string, memo = 'Cash sale') => ({
  companyId: co.id,
  entryDate: date,
  memo,
  lines: [
    { accountId: co.cash, debit: amount },
    { accountId: co.sales, credit: amount },
  ],
});

export async function addPeriod(companyId: string, start: string, end: string, locked = false): Promise<void> {
  await owner.query(
    `INSERT INTO periods (company_id, start_date, end_date, locked_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)`,
    [companyId, start, end, locked],
  );
}
