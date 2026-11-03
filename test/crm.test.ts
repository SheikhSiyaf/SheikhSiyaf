// CRM: campaigns, leads and converting them, the pipeline and its quotation link, activities, separation and access.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, type Fixture } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import * as C from '../src/books/crmService.js';
import * as S from '../src/books/documentsService.js';

let f: Fixture;
let server: FastifyInstance;
let campaign: string, lead: string, deal: string;

beforeAll(async () => {
  f = await seed();
  server = buildServer({ pool: appPool, sessionSecret: 'test-secret' });
});
afterAll(async () => { await server.close(); });

describe('Campaigns and leads', () => {
  it('a lead needs a name and a way to reach them; lost needs a reason', async () => {
    campaign = await as(f.staff, (db) => C.saveCampaign(db, f.a.id, { name: 'Ramadan offer', channel: 'whatsapp', startDate: '2026-02-20', endDate: '2026-03-20', budget: '1500.00' }));
    await expect(as(f.staff, (db) => C.saveCampaign(db, f.a.id, { name: 'Late', startDate: '2026-03-20', endDate: '2026-02-20' }))).rejects.toThrow(/end date/);
    await expect(as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'Gulf Steel' }))).rejects.toThrow(/phone number or an email/);
    lead = await as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'Gulf Steel', contactPerson: 'Hassan', phone: '+966500000001', campaignId: campaign, estimatedValue: '25000.00', ownerId: f.staff }));
    expect(await as(f.staff, (db) => C.getLead(db, lead))).toMatchObject({ source: 'campaign', campaignName: 'Ramadan offer', ownerName: 'Staff', status: 'new' });
    const other = await as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'Najd Foods', email: 'buy@najd.example', campaignId: campaign }));
    await expect(as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'Najd Foods', email: 'buy@najd.example', status: 'lost' }, other))).rejects.toThrow(/why/);
    await as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'Najd Foods', email: 'buy@najd.example', status: 'lost', lostReason: 'Price', campaignId: campaign }, other));
  });

  it('owners must be people of the company', async () => {
    const outsider = (await owner.query(`SELECT user_id FROM memberships WHERE company_id = $1 AND user_id <> ALL ($2)`, [f.b.id, [f.partner, f.reviewer]])).rows[0].user_id;
    await expect(as(f.staff, (db) => C.saveLead(db, f.a.id, { name: 'X', phone: '1', ownerId: outsider }))).rejects.toThrow(/different company/);
    expect((await as(f.staff, (db) => C.people(db, f.a.id))).map((p) => p.name)).toContain('Staff');
    expect(await as(f.b.clientAccountant, (db) => C.people(db, f.a.id))).toEqual([]);
  });

  it('converting a lead makes a customer and opens a deal', async () => {
    const r = await as(f.staff, (db) => C.convertLead(db, lead, { dealTitle: 'Steel racks for warehouse', dealValue: '25000.00' }));
    deal = r.dealId!;
    expect((await as(f.staff, (db) => S.getContact(db, r.contactId))).isCustomer).toBe(true);
    expect(await as(f.staff, (db) => C.getLead(db, lead))).toMatchObject({ status: 'converted', contactId: r.contactId });
    expect(await as(f.staff, (db) => C.getDeal(db, deal))).toMatchObject({ stage: 'qualified', value: '25000.00', customerName: 'Gulf Steel' });
    await expect(as(f.staff, (db) => C.convertLead(db, lead))).rejects.toThrow(/already a customer/);
  });
});

describe('Pipeline and quotations', () => {
  it('a deal gets a quotation; sending, accepting and invoicing it move the deal to won', async () => {
    const qid = await as(f.staff, (db) => C.quoteDeal(db, deal));
    expect(await as(f.staff, (db) => C.getDeal(db, deal))).toMatchObject({ stage: 'proposal', quotationId: qid });
    await expect(as(f.staff, (db) => C.quoteDeal(db, deal))).rejects.toThrow(/already has a quotation/);
    await as(f.staff, (db) => S.setQuotationStatus(db, qid, 'sent'));
    await as(f.staff, (db) => S.setQuotationStatus(db, qid, 'accepted'));
    expect((await as(f.staff, (db) => C.getDeal(db, deal))).stage).toBe('negotiation');
    await as(f.staff, (db) => S.convertQuotation(db, qid));
    expect(await as(f.staff, (db) => C.getDeal(db, deal))).toMatchObject({ stage: 'won', quotationStatus: 'invoiced' });
  });

  it('the board totals open deals by stage with a weighted value and win rate', async () => {
    const customer = await as(f.staff, (db) => S.saveContact(db, f.a.id, { isCustomer: true, name: 'Riyadh Mall' }));
    await as(f.staff, (db) => C.saveDeal(db, f.a.id, { title: 'Fit-out', contactId: customer, value: '10000.00', stage: 'negotiation' }));
    await as(f.staff, (db) => C.saveDeal(db, f.a.id, { title: 'Signage', contactId: customer, value: '4000.00', stage: 'new' }));
    const lostId = await as(f.staff, (db) => C.saveDeal(db, f.a.id, { title: 'Cleaning', contactId: customer, value: '900.00' }));
    await expect(as(f.staff, (db) => C.moveDeal(db, lostId, 'lost'))).rejects.toThrow(/why/);
    await as(f.staff, (db) => C.moveDeal(db, lostId, 'lost', 'Went with a cheaper supplier'));
    const p = await as(f.staff, (db) => C.pipeline(db, f.a.id, { from: '2020-01-01', to: '2099-12-31' }));
    expect(p).toMatchObject({ openTotal: '14000.00', weighted: '7900.00', wonTotal: '25000.00', wonCount: 1, lostCount: 1, winRate: 50 });
    expect(p.stages.find((s) => s.stage === 'negotiation')!.count).toBe(1);
  });

  it('campaign results count its leads, customers and deals won', async () => {
    const c = (await as(f.staff, (db) => C.listCampaigns(db, f.a.id))).find((x) => x.id === campaign)!;
    expect(c).toMatchObject({ leads: 2, converted: 1, won: 1, wonValue: '25000.00', costPerLead: '750.00' });
  });
});

describe('Activities', () => {
  it('due, overdue and done; linked to one lead, deal or customer', async () => {
    await expect(as(f.staff, (db) => C.saveActivity(db, f.a.id, { subject: 'Call', leadId: lead, dealId: deal }))).rejects.toThrow(/one lead, deal or customer/);
    await expect(as(f.staff, (db) => C.saveActivity(db, f.a.id, { subject: 'Call', dueTime: '25:00' }))).rejects.toThrow(/hours and minutes/);
    const late = await as(f.staff, (db) => C.saveActivity(db, f.a.id, { kind: 'call', subject: 'Follow up on racks', dueDate: '2020-01-05', dealId: deal, ownerId: f.staff }));
    await as(f.staff, (db) => C.saveActivity(db, f.a.id, { kind: 'meeting', subject: 'Site visit', dueDate: '2099-01-05', dueTime: '10:30', leadId: lead }));
    expect((await as(f.staff, (db) => C.listActivities(db, f.a.id, { show: 'overdue' }))).map((a) => a.subject)).toEqual(['Follow up on racks']);
    await as(f.staff, (db) => C.setActivityDone(db, late, true));
    expect(await as(f.staff, (db) => C.listActivities(db, f.a.id, { show: 'overdue' }))).toEqual([]);
    expect((await as(f.staff, (db) => C.listActivities(db, f.a.id, { show: 'done' })))[0]).toMatchObject({ subject: 'Follow up on racks', dealTitle: 'Steel racks for warehouse' });
    await as(f.staff, (db) => C.deleteActivity(db, late));
    expect((await as(f.staff, (db) => C.listActivities(db, f.a.id, { show: 'all' }))).length).toBe(1);
  });
});

describe('Separation and access', () => {
  it('other companies see nothing; view-only users and roles without CRM cannot change it; leads and deals are kept', async () => {
    expect(await as(f.b.clientAccountant, (db) => C.listLeads(db, f.a.id))).toEqual([]);
    await expect(as(f.a.clientViewer, (db) => C.saveLead(db, f.a.id, { name: 'X', phone: '1' }))).rejects.toThrow();
    await expect(owner.query('DELETE FROM crm_deals WHERE id = $1', [deal])).rejects.toThrow();
    const hash = await hashPassword('pw-123456');
    const emails: Record<string, string> = {};
    for (const [k, id] of Object.entries({ admin: f.admin, clientA: f.a.clientAccountant })) {
      emails[k] = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [hash, id])).rows[0].email;
    }
    const signIn = async (who: string) => String((await server.inject({ method: 'POST', url: '/api/login', payload: { email: emails[who], password: 'pw-123456' } })).headers['set-cookie']).split(';')[0]!;
    const a = await signIn('admin');
    const role = (await server.inject({ method: 'POST', url: '/api/admin/roles', headers: { cookie: a }, payload: { name: 'Sales rep', permissions: { CRM: 'edit' } } })).json().id;
    await server.inject({ method: 'POST', url: `/api/admin/companies/${f.a.id}/users/${f.a.clientAccountant}/role`, headers: { cookie: a }, payload: { clientRoleId: role } });
    const c = await signIn('clientA');
    expect((await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/crm/pipeline`, headers: { cookie: c } })).statusCode).toBe(200);
    const d2 = (await server.inject({ method: 'POST', url: `/api/companies/${f.a.id}/crm/deals`, headers: { cookie: c }, payload: { title: 'New one', leadId: lead } })).json().id;
    // A quotation is a Sales document: CRM alone is not enough.
    expect((await server.inject({ method: 'POST', url: `/api/crm/deals/${d2}/quotation`, headers: { cookie: c } })).json()).toMatchObject({ key: 'err.roleNoAccess' });
    expect((await server.inject({ method: 'GET', url: `/api/companies/${f.a.id}/documents?type=invoice`, headers: { cookie: c } })).statusCode).toBe(403);
  });
});
