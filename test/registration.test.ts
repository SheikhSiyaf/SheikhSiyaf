// CLAUDE.md > Client registration (decided)
import { describe, it, expect, beforeAll } from 'vitest';
import { as, seed, saCr, saVat, aeTrn, type Fixture } from './helpers.js';
import type { Db } from '../src/db/session.js';

let f: Fixture;
beforeAll(async () => { f = await seed(); });

interface Reg { [k: string]: string | number | null }
const base = (): Reg => ({
  name: 'Al Noor Trading', country: 'SA', currency: 'SAR', cr_number: saCr(), legal_form: 'LLC',
  vat_status: 'registered', vat_number: saVat(), vat_rate: '15.00', address: 'King Fahd Rd', city: 'Riyadh',
  fy_end_month: 12, fy_end_day: 31,
});

/** Registers a client the way the admin console will: company + first client user + membership, one transaction. */
async function register(db: Db, firmId: string, reg: Reg, withClientUser = true): Promise<string> {
  const cols = Object.keys(reg);
  const { rows } = await db.query(
    `INSERT INTO companies (firm_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [firmId, ...Object.values(reg)],
  );
  const companyId = rows[0].id;
  if (withClientUser) {
    const u = await db.query(
      `INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'client', 'First User', $2) RETURNING id`,
      [firmId, `first.${companyId}@example.com`],
    );
    await db.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, 'client_accountant')`, [u.rows[0].id, companyId]);
  }
  return companyId;
}

const reg = (r: Reg, withUser = true) => as(f.admin, (db) => register(db, f.firmId, r, withUser));

describe('Client registration', () => {
  it('Administrator registers a Saudi client with all required details and a first client user', async () => {
    await expect(reg(base())).resolves.toBeTruthy();
  });

  it('a client cannot be registered without its first client user', async () => {
    await expect(reg(base(), false)).rejects.toThrow(/first client user/);
  });

  it('only the Administrator registers clients', async () => {
    await expect(as(f.partner, (db) => register(db, f.firmId, base()))).rejects.toThrow(/row-level security/);
  });

  it('required fields are required', async () => {
    for (const k of ['name', 'country', 'currency', 'cr_number', 'legal_form', 'vat_status', 'address', 'city', 'fy_end_month']) {
      await expect(reg({ ...base(), [k]: null }), k).rejects.toThrow(/null value|violates/);
    }
  });

  it('SA CR must be 10 digits', async () => {
    await expect(reg({ ...base(), cr_number: '123456789' })).rejects.toThrow(/sa_cr_format/);
    await expect(reg({ ...base(), cr_number: '12345678901' })).rejects.toThrow(/sa_cr_format/);
  });

  it('SA VAT number must be 15 digits starting and ending with 3', async () => {
    await expect(reg({ ...base(), vat_number: '123456789012343' })).rejects.toThrow(/sa_vat_format/);
    await expect(reg({ ...base(), vat_number: '300000000000001' })).rejects.toThrow(/sa_vat_format/);
    await expect(reg({ ...base(), vat_number: '30000000000003' })).rejects.toThrow(/sa_vat_format/);
  });

  it('UAE TRN must be 15 digits; trade licence has no fixed format', async () => {
    const ae = { ...base(), country: 'AE', currency: 'AED', cr_number: 'TL-' + aeTrn().slice(0, 6), vat_rate: '5.00', city: 'Dubai' };
    await expect(reg({ ...ae, vat_number: '12345' })).rejects.toThrow(/ae_trn_format/);
    await expect(reg({ ...ae, vat_number: aeTrn() })).resolves.toBeTruthy();
  });

  it('VAT number is required only if VAT registered; unregistered means 0% VAT', async () => {
    await expect(reg({ ...base(), vat_number: null })).rejects.toThrow(/vat_number_when_registered/);
    await expect(reg({ ...base(), vat_status: 'unregistered', vat_number: null, vat_rate: '15.00' })).rejects.toThrow(/vat_number_when_registered/);
    await expect(reg({ ...base(), vat_status: 'unregistered', vat_number: null, vat_rate: '0' })).resolves.toBeTruthy();
  });

  it('CR and VAT numbers are unique across clients', async () => {
    const first = base();
    await reg(first);
    await expect(reg({ ...base(), cr_number: first.cr_number! })).rejects.toThrow(/cr_number_unique/);
    await expect(reg({ ...base(), vat_number: first.vat_number! })).rejects.toThrow(/vat_number_unique/);
  });

  it('currency must match the country', async () => {
    await expect(reg({ ...base(), currency: 'AED' })).rejects.toThrow(/currency_matches_country/);
  });
});
