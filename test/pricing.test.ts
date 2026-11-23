// The new pricing: software 9,000 (once), implementation 5,000 (optional, once), annual membership 1,500, and 500 a year for
// each additional (optional) module. Amounts are before VAT (15%).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, owner, seed, saCr, saVat, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';

const PW = 'pw-123456';
let f: Fixture;
let server: FastifyInstance;
let cookie = '';
let planId = '';

beforeAll(async () => {
  f = await seed();
  const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
  const res = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
});
afterAll(async () => { await server?.close(); });

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
async function customer(modules: string[]): Promise<string> {
  const s = stamp();
  const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie }, payload: {
    company: { name: `Priced ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh', modules },
    users: [{ name: 'Admin', email: `a.${s}@priced.example.com`, jobTitle: 'Administrator' }, { name: 'Owner', email: `o.${s}@priced.example.com`, jobTitle: 'Owner' }] } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}
const subscribe = (firm: string, body: object) => server.inject({ method: 'POST', url: `/api/owner/tenants/${firm}/subscription`, headers: { cookie }, payload: { planId, startOn: '2026-01-01', ...body } });
const invoiceOf = async (firm: string) => (await owner.query(`SELECT lines, subtotal::text, vat::text, total::text FROM billing_invoices WHERE firm_id = $1 ORDER BY period_start`, [firm])).rows;
const amounts = (lines: { key: string; amount: number | string }[]) => Object.fromEntries(lines.map((l) => [l.key, Number(l.amount)]));
const run = (day: string) => server.inject({ method: 'POST', url: '/api/owner/billing/run', headers: { cookie }, payload: { day } });

describe('The new pricing', () => {
  it('has one plan on sale with these prices, and the older plans are off sale (not deleted)', async () => {
    const p = (await owner.query(`SELECT yearly_price::text AS y, setup_price::text AS s, implementation_price::text AS i, extra_module_price::text AS m, annual, active FROM plans WHERE code = 'nusuh'`)).rows[0];
    expect(p).toEqual({ y: '1500.00', s: '9000.00', i: '5000.00', m: '500.00', annual: true, active: true });
    const old = (await owner.query(`SELECT code, active FROM plans WHERE code IN ('starter', 'business', 'firm', 'firm_plus') ORDER BY code`)).rows;
    expect(old).toHaveLength(4);
    expect(old.every((x) => x.active === false)).toBe(true);
  });

  it('first invoice with the implementation: software 9,000 + implementation 5,000 + membership 1,500 + 2 modules x 500, then 15% VAT', async () => {
    const firm = await customer(['Inventory', 'HRM']);
    expect((await subscribe(firm, { cycle: 'yearly', implementation: true })).statusCode).toBe(200);
    expect((await run('2026-01-01')).statusCode).toBe(200);
    const [inv] = await invoiceOf(firm);
    expect(amounts(inv.lines)).toEqual({ software: 9000, implementation: 5000, membership: 1500, extraModules: 1000 });
    expect(inv.subtotal).toBe('16500.00');
    expect(inv.vat).toBe('2475.00');
    expect(inv.total).toBe('18975.00');
  });

  it('the implementation is optional: without it the first invoice has no implementation line', async () => {
    const firm = await customer(['Inventory']);
    expect((await subscribe(firm, { cycle: 'yearly' })).statusCode).toBe(200);
    await run('2026-01-01');
    const [inv] = await invoiceOf(firm);
    expect(amounts(inv.lines)).toEqual({ software: 9000, membership: 1500, extraModules: 500 });
    expect(inv.subtotal).toBe('11000.00');
  });

  it('the one-time charges are billed once: next year is only the membership and the modules', async () => {
    const firm = await customer(['Inventory', 'HRM', 'CRM']);
    await subscribe(firm, { cycle: 'yearly', implementation: true });
    await run('2026-01-01');
    await run('2027-01-01');
    const [first, second] = await invoiceOf(firm);
    expect(amounts(first.lines)).toEqual({ software: 9000, implementation: 5000, membership: 1500, extraModules: 1500 });
    expect(amounts(second.lines)).toEqual({ membership: 1500, extraModules: 1500 });
    expect(second.subtotal).toBe('3000.00');
    // a module switched on later is charged from the next renewal
    await owner.query(`UPDATE companies SET modules = modules || ARRAY['Rentals'] WHERE firm_id = $1`, [firm]);
    await run('2028-01-01');
    const third = (await invoiceOf(firm))[2]!;
    expect(amounts(third.lines)).toEqual({ membership: 1500, extraModules: 2000 });
  });

  it('a customer with no optional modules pays only the membership (core modules are included); the annual plan is billed yearly only', async () => {
    const firm = await customer([]);
    expect((await subscribe(firm, { cycle: 'monthly' })).statusCode).toBe(200);   // asked for monthly: it is yearly
    expect((await owner.query(`SELECT cycle FROM subscriptions WHERE firm_id = $1`, [firm])).rows[0].cycle).toBe('yearly');
    await run('2026-01-01');
    const [inv] = await invoiceOf(firm);
    expect(amounts(inv.lines)).toEqual({ software: 9000, membership: 1500 });
  });
});
