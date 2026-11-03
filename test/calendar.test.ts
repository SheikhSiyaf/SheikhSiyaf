// Compliance calendar in the database: settings, done marks, the client's own deadlines, who may change them,
// and separation between companies.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';
import * as K from '../src/books/calendarService.js';

let f: Fixture;
const TODAY = '2026-11-03';
const range = { from: '2026-10-01', to: '2026-12-31' };

beforeAll(async () => {
  f = await seed();
  await owner.query(`UPDATE companies SET modules = '{Inventory}' WHERE id = ANY ($1)`, [[f.a.id, f.b.id]]);   // no HRM: no payroll deadlines
});

describe('Deadlines from the company', () => {
  it('a Saudi client starts with quarterly VAT and zakat; the UAE client with corporate tax', async () => {
    const a = await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(a.map((d) => [d.key, d.due, d.status])).toEqual([['vat:2026-09-30', '2026-10-31', 'overdue']]);
    const b = await as(f.partner, (db) => K.calendar(db, f.b.id, TODAY, { from: '2026-01-01', to: '2026-12-31' }));
    expect(b.filter((d) => d.kind === 'corporate_tax').map((d) => d.due)).toEqual(['2026-09-30']);
    expect(b.filter((d) => d.kind === 'vat_return').map((d) => d.due)).toEqual(['2026-01-28', '2026-04-28', '2026-07-28', '2026-10-28']);
  });

  it('settings change the dates; view-only people cannot change them', async () => {
    await expect(as(f.a.clientViewer, (db) => K.saveSettings(db, f.a.id, { vatFrequency: 'monthly' }))).rejects.toThrow();
    await as(f.a.clientAccountant, (db) => K.saveSettings(db, f.a.id, { vatFrequency: 'monthly' }));
    const a = await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(a.map((d) => d.key)).toEqual(['vat:2026-09-30', 'vat:2026-10-31', 'vat:2026-11-30']);
    expect((await as(f.a.clientViewer, (db) => K.getSettings(db, f.a.id)))).toMatchObject({ vatFrequency: 'monthly', saved: true, zakat: true });
    await as(f.staff, (db) => K.saveSettings(db, f.a.id, { vatFrequency: 'quarterly' }));
  });
});

describe('Payroll deadlines', () => {
  it('turn on with HRM: GOSI by the 15th', async () => {
    await owner.query(`UPDATE companies SET modules = '{Inventory,HRM}' WHERE id = $1`, [f.a.id]);
    const a = await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(a.filter((d) => d.kind === 'social_insurance').map((d) => d.due)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15']);
    await owner.query(`UPDATE companies SET modules = '{Inventory}' WHERE id = $1`, [f.a.id]);
  });
});

describe('Marking deadlines done', () => {
  it('staff or the client accountant mark it done with the filing reference; view-only people cannot', async () => {
    await expect(as(f.a.clientViewer, (db) => K.markDone(db, f.a.id, 'vat:2026-09-30'))).rejects.toThrow();
    await as(f.a.clientAccountant, (db) => K.markDone(db, f.a.id, 'vat:2026-09-30', { reference: 'ZATCA 123456' }));
    const [d] = await as(f.a.clientViewer, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(d).toMatchObject({ status: 'done', done: { by: 'Client Accountant SA', reference: 'ZATCA 123456' } });
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'compliance_done'`)).rows[0].n).toBeGreaterThan(0);
    await as(f.staff, (db) => K.undoDone(db, f.a.id, 'vat:2026-09-30'));
    expect((await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range)))[0]!.status).toBe('overdue');
  });

  it('only keys of real deadlines can be marked', async () => {
    await expect(as(f.staff, (db) => K.markDone(db, f.a.id, 'vat:2026-09-29'))).rejects.toThrow(/not on this calendar/);
    await expect(as(f.staff, (db) => K.markDone(db, f.a.id, 'ct:2025-12-31'))).rejects.toThrow(/not on this calendar/);   // Saudi: no corporate tax deadline
    await expect(as(f.staff, (db) => K.markDone(db, f.a.id, "x'; DROP"))).rejects.toThrow(/not on this calendar/);
  });
});

describe("The client's own deadlines", () => {
  let id: string;
  it('added once or repeating; marked done one date at a time', async () => {
    id = await as(f.a.clientAccountant, (db) => K.saveCustom(db, f.a.id, { title: 'Municipality licence', titleAr: 'رخصة البلدية', firstDue: '2026-11-20', repeat: 'monthly' }));
    const list = await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(list.filter((d) => d.kind === 'custom').map((d) => d.due)).toEqual(['2026-11-20', '2026-12-20']);
    expect(list.find((d) => d.kind === 'custom')).toMatchObject({ label: 'Municipality licence', labelAr: 'رخصة البلدية', status: 'later' });
    await as(f.staff, (db) => K.markDone(db, f.a.id, `custom:${id}:2026-11-20`));
    const again = await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range));
    expect(again.filter((d) => d.kind === 'custom').map((d) => d.status)).toEqual(['done', 'later']);
    await expect(as(f.a.clientViewer, (db) => K.saveCustom(db, f.a.id, { title: 'X', firstDue: '2026-12-01' }))).rejects.toThrow();
    await expect(owner.query('DELETE FROM compliance_custom WHERE id = $1', [id])).rejects.toThrow();
  });

  it('archived deadlines leave the calendar', async () => {
    await as(f.staff, (db) => K.saveCustom(db, f.a.id, { title: 'Municipality licence', firstDue: '2026-11-20', repeat: 'monthly', status: 'archived' }, id));
    expect((await as(f.staff, (db) => K.calendar(db, f.a.id, TODAY, range))).some((d) => d.kind === 'custom')).toBe(false);
  });
});

describe('Separation', () => {
  it("another company's people see nothing and cannot mark this company's deadlines", async () => {
    await as(f.staff, (db) => K.markDone(db, f.a.id, 'vat:2026-09-30'));
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM compliance_done'))).rows).toEqual([]);
    expect((await as(f.b.clientAccountant, (db) => db.query('SELECT * FROM compliance_custom'))).rows).toEqual([]);
    await expect(as(f.b.clientAccountant, (db) => db.query(`INSERT INTO compliance_done (company_id, key, due_date, done_by) VALUES ($1, 'vat:2026-06-30', '2026-07-31', app_user_id())`, [f.a.id]))).rejects.toThrow();
    // A custom deadline of company A cannot be marked done on company B.
    const own = await as(f.partner, (db) => K.saveCustom(db, f.a.id, { title: 'Audit', firstDue: '2026-12-15' }));
    await expect(as(f.partner, (db) => db.query(`INSERT INTO compliance_done (company_id, key, due_date, done_by) VALUES ($1, $2, '2026-12-15', app_user_id())`, [f.b.id, `custom:${own}:2026-12-15`]))).rejects.toThrow(/different company/);
  });

  it("the firm's list across clients counts only their own clients", async () => {
    const rows = await as(f.staff, (db) => K.myClients(db, TODAY));
    expect(rows.map((r) => r.companyId)).toEqual([f.a.id]);
    expect(rows[0]).toMatchObject({ overdue: 1 });   // the June quarter (September's is done)
    const p = await as(f.partner, (db) => K.myClients(db, TODAY));
    expect(p.find((r) => r.companyId === f.b.id)).toMatchObject({ overdue: 3, next: { kind: 'vat_return', due: '2027-01-28' } });   // two VAT returns and corporate tax
  });
});
