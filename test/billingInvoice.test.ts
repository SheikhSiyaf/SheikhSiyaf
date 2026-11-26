// The invoice Nusuh Books sends to its customers, as a ZATCA standard tax invoice: the lines add up to the stored totals to the cent,
// the QR code carries the ZATCA fields, the seller's details are checked, and the buyer's details are kept on the invoice as they were the day it was made.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { app as appPool, as, owner, seed, saCr, saVat } from './helpers.js';
import * as B from '../src/books/billingService.js';
import { allocate, fitBytes, invoiceQr, layoutInvoice, validSellerVat } from '../src/books/billingInvoiceView.js';
import { readZatcaQr } from '../src/einvoice/zatcaQr.js';
import { fromMinor, toMinor } from '../src/money.js';

/** What the billing engine stores: the VAT is worked out once on subtotal - discount, rounded half up to the cent. */
function made(amounts: bigint[], discountPct: number, rate = 15) {
  const sub = amounts.reduce((s, x) => s + x, 0n);
  const disc = (sub * BigInt(discountPct * 100) + 5000n) / 10000n;
  const vat = ((sub - disc) * BigInt(rate * 100) + 5000n) / 10000n;
  return { lines: amounts.map((a, i) => ({ key: i === 0 ? 'software' : 'implementation', quantity: 1, unitPrice: fromMinor(a), amount: fromMinor(a) })),
    subtotal: fromMinor(sub), discount: fromMinor(disc), vatRate: String(rate), vat: fromMinor(vat), total: fromMinor(sub - disc + vat) };
}

describe('Sharing a total over lines', () => {
  it('the parts always add up to the total, for any total and any weights, including negative and all-zero ones', () => {
    let seedN = 12345;
    const rnd = (n: number) => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN % n; };
    for (let k = 0; k < 2000; k++) {
      const n = 1 + rnd(7);
      const weights = Array.from({ length: n }, () => BigInt(rnd(5) === 0 ? 0 : rnd(1_000_000)));
      const total = BigInt(rnd(2_000_001) - 1_000_000);
      const parts = allocate(total, weights);
      expect(parts.reduce((s, x) => s + x, 0n), `${total} over ${weights}`).toBe(total);
      expect(parts).toHaveLength(n);
    }
    expect(allocate(10n, [])).toEqual([]);
    expect(allocate(7n, [0n, 0n, 0n])).toEqual([7n, 0n, 0n]);
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);   // the extra cent goes to the earlier line
  });
});

describe('The lines of the invoice', () => {
  it('a plain invoice: each line shows its own VAT and the columns equal the totals', () => {
    const inv = made([100000n, 25000n], 0);   // 1,000.00 + 250.00, 15% VAT
    const l = layoutInvoice(inv);
    expect(l.adds).toBe(true);
    expect(l.rows.map((r) => [r.taxable, r.vat, r.total])).toEqual([['1000.00', '150.00', '1150.00'], ['250.00', '37.50', '287.50']]);
    expect(l.totals).toEqual({ gross: '1250.00', discount: '0.00', taxable: '1250.00', vat: '187.50', total: '1437.50' });
  });
  it('a discount is shared over the lines and the VAT is on what is left', () => {
    const inv = made([420000n], 10);   // 4,200.00 less 10%
    const l = layoutInvoice(inv);
    expect(l.rows[0]).toMatchObject({ gross: '4200.00', discount: '420.00', taxable: '3780.00', vat: '567.00', total: '4347.00' });
    expect(l.adds).toBe(true);
  });
  it('for thousands of random invoices every column adds up to the stored figure, to the cent, and no line is more than a cent from its own VAT', () => {
    let seedN = 777;
    const rnd = (n: number) => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN % n; };
    for (let k = 0; k < 3000; k++) {
      const amounts = Array.from({ length: 1 + rnd(6) }, () => BigInt(1 + rnd(9_999_999)));
      const inv = made(amounts, [0, 5, 10, 12.5, 33.33][rnd(5)]!, [15, 5, 0][rnd(3)]!);
      const l = layoutInvoice(inv);
      expect(l.adds, JSON.stringify(inv)).toBe(true);
      const sum = (f: (r: (typeof l.rows)[number]) => string) => l.rows.reduce((s, r) => s + toMinor(f(r)), 0n);
      expect(fromMinor(sum((r) => r.taxable))).toBe(fromMinor(toMinor(inv.subtotal) - toMinor(inv.discount)));
      expect(fromMinor(sum((r) => r.vat))).toBe(inv.vat);
      expect(fromMinor(sum((r) => r.total))).toBe(inv.total);
      for (const r of l.rows) {
        expect(toMinor(r.total)).toBe(toMinor(r.taxable) + toMinor(r.vat));
        expect(toMinor(r.taxable)).toBeGreaterThanOrEqual(0n);
        const exact = (toMinor(r.taxable) * BigInt(Math.round(Number(inv.vatRate) * 100))) / 10000n;
        const diff = toMinor(r.vat) - exact;
        expect(diff >= -1n && diff <= 2n, `${r.taxable} @ ${inv.vatRate}% -> ${r.vat}`).toBe(true);
      }
    }
  });
  it('accepts amounts as numbers or text, and says when the rows do not match the stored totals', () => {
    const l = layoutInvoice({ lines: [{ key: 'plan', quantity: 1, unitPrice: 1000, amount: 1000 }], subtotal: '1000.00', discount: '0.00', vatRate: '15.00', vat: '150.00', total: '1150.00' });
    expect(l.rows[0]).toMatchObject({ unitPrice: '1000.00', gross: '1000.00', vatRate: '15', total: '1150.00' });
    expect(l.adds).toBe(true);
    expect(layoutInvoice({ lines: [{ key: 'plan', quantity: 1, unitPrice: 1000, amount: 1000 }], subtotal: '999.00', discount: '0.00', vatRate: '15', vat: '150.00', total: '1150.00' }).adds).toBe(false);
  });
});

describe('The QR code', () => {
  const base = { sellerNameAr: 'نصوح بوكس', sellerName: 'Nusuh Books', sellerVat: '300000000000003', createdAt: '2026-11-26T08:15:30Z', issuedOn: '2026-11-26', total: '1437.50', vat: '187.50' };
  it('carries the five ZATCA fields: seller, VAT number, time stamp, total with VAT and VAT', () => {
    const qr = invoiceQr(base)!;
    expect(readZatcaQr(qr)).toEqual({ 1: 'نصوح بوكس', 2: '300000000000003', 3: '2026-11-26T08:15:30Z', 4: '1437.50', 5: '187.50' });
  });
  it('uses the English name when there is no Arabic one, and makes no code without a valid 15-digit VAT number', () => {
    expect(readZatcaQr(invoiceQr({ ...base, sellerNameAr: null })!)[1]).toBe('Nusuh Books');
    for (const v of [null, '', '3000', '30000000000000x', '3000000000000030']) expect(invoiceQr({ ...base, sellerVat: v })).toBeNull();
    expect(validSellerVat('300000000000003')).toBe(true);
  });
  it('a long name is cut at a whole letter so every field stays within 255 bytes', () => {
    const long = 'ن'.repeat(160);
    const cut = fitBytes(long);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(255);
    expect(cut.length).toBeGreaterThan(100);
    expect(() => invoiceQr({ ...base, sellerNameAr: long })).not.toThrow();
  });
});

describe('The seller and the buyer on the invoice', () => {
  let server: FastifyInstance;
  let ownerCookie = '';
  beforeAll(async () => {
    const f = await seed();
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword('pw-123456'), f.platformOwner])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'billing-invoice-secret', lockCacheMs: 0 });
    ownerCookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-123456' } })).headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await server?.close(); });
  /** A customer that keeps its own books, made the way the owner makes one. */
  async function companyCustomer(name: string, nameAr: string, vat: string | null, cr: string) {
    const s = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name, nameAr, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: cr, vatStatus: vat ? 'registered' : 'unregistered', ...(vat ? { vatNumber: vat } : {}), address: 'King Fahd Road 12', city: 'Riyadh', modules: [] },
      users: [{ name: 'Admin', email: `a.${s}@inv.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `f.${s}@inv.example.com`, jobTitle: 'Finance' }] } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().id as string;
  }
  it('the owner saves the seller\'s Arabic name and address and registration number; a bad VAT number or registration number is refused', async () => {
    const f = await seed();
    const save = (x: object) => as(f.platformOwner, (db) => B.saveSettings(db, { sellerName: 'Nusuh Books', currency: 'SAR', vatRate: '15', termsDays: 14, ...x }));
    await save({ sellerNameAr: 'نصوح بوكس', sellerAddressAr: 'الرياض، المملكة العربية السعودية', sellerAddress: 'Riyadh, Saudi Arabia', sellerVat: '300000000000003', sellerCr: '1010123456' });
    const s = await as(f.platformOwner, (db) => B.settings(db));
    expect(s).toMatchObject({ sellerNameAr: 'نصوح بوكس', sellerVat: '300000000000003', sellerCr: '1010123456', sellerAddressAr: 'الرياض، المملكة العربية السعودية' });
    await expect(save({ sellerVat: '12345' })).rejects.toThrow(/15 digits/);
    await expect(save({ sellerVat: '300000000000003', sellerCr: 'no way!' })).rejects.toThrow(/registration/);
    await expect(save({ sellerNameAr: 'ن'.repeat(101) })).rejects.toThrow(/too long/);
    await expect(save({ sellerAddress: 'x'.repeat(301) })).rejects.toThrow(/too long/);
    await expect(as(f.admin, (db) => B.saveSettings(db, { sellerName: 'Hacker', currency: 'SAR', vatRate: '15', termsDays: 14 }))).rejects.toThrow(/platform owner/);
    await save({ sellerNameAr: null, sellerCr: null });   // clearing is allowed
    expect((await as(f.platformOwner, (db) => B.settings(db))).sellerNameAr).toBeNull();
  });

  async function invoiceFor(firmId: string, n: string) {
    return (await owner.query(`INSERT INTO billing_invoices (firm_id, number, customer_name, plan_name, cycle, period_start, period_end, issued_on, due_on, currency, lines, subtotal, vat_rate, vat, total)
      VALUES ($1, $2, 'Buyer', 'Plan', 'yearly', '2026-01-01', '2026-12-31', '2026-01-01', '2026-01-15', 'SAR', '[{"key":"software","quantity":1,"unitPrice":1000,"amount":1000}]', 1000, 15, 150, 1150) RETURNING id`, [firmId, n])).rows[0].id as string;
  }
  it('a company customer\'s invoice keeps the buyer exactly as it was the day it was made, even if the company changes later', async () => {
    const vat = saVat(), cr = saCr();
    const firm = await companyCustomer('Buyer Trading LLC', 'شركة المشتري للتجارة', vat, cr);
    const id = await invoiceFor(firm, `T-${Date.now()}-1`);
    const x = (await owner.query(`SELECT buyer_name_ar, buyer_vat, buyer_cr, buyer_address FROM billing_invoices WHERE id = $1`, [id])).rows[0];
    expect(x).toEqual({ buyer_name_ar: 'شركة المشتري للتجارة', buyer_vat: vat, buyer_cr: cr, buyer_address: 'King Fahd Road 12, Riyadh, Saudi Arabia' });
    await owner.query(`UPDATE companies SET vat_number = $2, address = 'Somewhere else' WHERE firm_id = $1`, [firm, saVat()]);
    const again = (await owner.query(`SELECT buyer_vat, buyer_address FROM billing_invoices WHERE id = $1`, [id])).rows[0];
    expect(again).toEqual({ buyer_vat: vat, buyer_address: 'King Fahd Road 12, Riyadh, Saudi Arabia' });   // unchanged
    // and the owner reads it through the service, with the bank details null until all four lines are set
    const f = await seed();
    const view = await as(f.platformOwner, (db) => B.invoice(db, id));
    expect(view).toMatchObject({ buyerVat: vat, buyerCr: cr, buyerNameAr: 'شركة المشتري للتجارة' });
    expect(view.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(view.bank).toBeNull();
    // an issued invoice is still not changed afterwards
    await expect(owner.query(`UPDATE billing_invoices SET buyer_vat = '999' WHERE id = $1`, [id])).rejects.toThrow(/not changed/);
  });
  it('an accounting firm customer has no single company, so the buyer lines stay empty (the name is still on the invoice)', async () => {
    const f = await seed();
    const id = await invoiceFor(f.firmId, `T-${Date.now()}-2`);
    expect((await owner.query(`SELECT buyer_vat, buyer_cr, buyer_address, buyer_name_ar FROM billing_invoices WHERE id = $1`, [id])).rows[0]).toEqual({ buyer_vat: null, buyer_cr: null, buyer_address: null, buyer_name_ar: null });
  });
  it('a placeholder address is not copied onto an invoice', async () => {
    const firm = await companyCustomer('Placeholder Co', '', null, saCr());
    await owner.query(`UPDATE companies SET address = 'To be completed in company settings', city = 'Jeddah' WHERE firm_id = $1`, [firm]);
    const id = await invoiceFor(firm, `T-${Date.now()}-3`);
    expect((await owner.query(`SELECT buyer_address, buyer_vat FROM billing_invoices WHERE id = $1`, [id])).rows[0]).toEqual({ buyer_address: 'Jeddah, Saudi Arabia', buyer_vat: null });
  });
  it('only the owner and the customer\'s own Administrator can read an invoice; another customer cannot', async () => {
    const a = await seed(), b = await seed();
    const id = await invoiceFor(a.firmId, `T-${Date.now()}-4`);
    expect((await as(a.admin, (db) => B.invoice(db, id))).number).toBeTruthy();
    await expect(as(b.admin, (db) => B.invoice(db, id))).rejects.toThrow(/Not found/);
    expect(appPool).toBeTruthy();
  });
});
