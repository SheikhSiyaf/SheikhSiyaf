// The checklist beside the bell: the rules (which items exist, who sees them, which tick themselves, what the Administrator may send),
// then the real thing through the API with throwaway customers: roles limit what arrives, ticks and hiding are per company and per person,
// only the company's Administrator changes the list, another company can neither read nor change it, and every tick is in the audit log.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, saCr, saVat } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import * as C from '../src/books/checklistService.js';
import {
  BUILT_IN, buildChecklist, cleanItem, periodKey, previousMonth, progress, registrationLooksReal, visibleTo,
  type Facts, type Inputs, type Role,
} from '../src/books/checklistRules.js';

const PW = 'pw-123456';
const baseFacts: Facts = {
  country: 'SA', vatStatus: 'registered', cr: '1010123456', vat: '300000000000003', modules: [], addressDone: true, logo: false, bankAccounts: false,
  customers: false, suppliers: false, items: false, entries: false, invoice: false, einvoicing: false, approvalRules: false, members: 1, twofa: false,
  openBankLines: false, openBankLinesToMonthEnd: false, draftsToMonthEnd: false, signedOff: false,
};
const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  facts: baseFacts, role: null, isAdmin: false, today: '2026-11-25', userId: 'u1', overrides: [], ticks: [], hiddenByMe: [], ...over,
});
const role = (permissions: Record<string, string>, extra: Partial<Role> = {}): Role => ({ permissions, canApprove: false, canSignOff: false, ...extra });
const keys = (i: Inputs) => buildChecklist(i).map((x) => x.key);

describe('The rules', () => {
  it('works out the month just finished, across a year end and in a leap year', () => {
    expect(previousMonth('2026-11-25')).toEqual({ period: '2026-10', end: '2026-10-31' });
    expect(previousMonth('2027-01-03')).toEqual({ period: '2026-12', end: '2026-12-31' });
    expect(previousMonth('2024-03-01')).toEqual({ period: '2024-02', end: '2024-02-29' });
    expect(previousMonth('2026-03-01')).toEqual({ period: '2026-02', end: '2026-02-28' });
    expect(periodKey('once', '2026-11-25')).toBe('');
    expect(periodKey('day', '2026-11-25')).toBe('2026-11-25');
    expect(periodKey('month', '2026-11-25')).toBe('2026-10');
  });

  it('only calls registration numbers real when they are not filler and the VAT number has the country\'s shape', () => {
    expect(registrationLooksReal('SA', '1010123456', 'registered', '300000000000003')).toBe(true);
    expect(registrationLooksReal('SA', '0000000000', 'registered', '300000000000003')).toBe(false);
    expect(registrationLooksReal('SA', '1010123456', 'registered', '100000000000001')).toBe(false);
    expect(registrationLooksReal('SA', '1010123456', 'registered', null)).toBe(false);
    expect(registrationLooksReal('SA', '1010123456', 'unregistered', null)).toBe(true);
    expect(registrationLooksReal('AE', '12345678', 'registered', '100123456789012')).toBe(true);
    expect(registrationLooksReal('AE', '12345678', 'registered', '111111111111111')).toBe(false);
    expect(registrationLooksReal('OM', '1234567', 'registered', 'OM1234567')).toBe(true);
  });

  it('a role sees only the items of modules it can at least view; a firm member without a client role sees them all', () => {
    const finance = role({ Sales: 'edit', Bank: 'none' });
    const k = keys(inputs({ role: finance }));
    expect(k).toContain('invoice');
    expect(k).toContain('customers');
    expect(k).not.toContain('bank');
    expect(k).not.toContain('me_bank');
    expect(k).not.toContain('opening');   // needs Ledger
    expect(keys(inputs({ role: null }))).toContain('bank');
    expect(keys(inputs({ role: role({}) })).filter((x) => !['twofa', 'me_drafts'].includes(x))).toEqual([]);   // a role with no module sees only the personal and general ones
  });

  it('administrator items go only to the Administrator', () => {
    expect(keys(inputs({ isAdmin: false }))).not.toContain('company');
    expect(keys(inputs({ isAdmin: true }))).toEqual(expect.arrayContaining(['company', 'registration', 'team']));
  });

  it('shows e-invoicing only for a VAT-registered company outside Oman, inventory only when the module is on, approvals only to approvers', () => {
    expect(keys(inputs())).toContain('einvoicing');
    expect(keys(inputs({ facts: { ...baseFacts, vatStatus: 'unregistered' } }))).not.toContain('einvoicing');
    expect(keys(inputs({ facts: { ...baseFacts, country: 'OM' } }))).not.toContain('einvoicing');
    expect(keys(inputs())).not.toContain('items');
    expect(keys(inputs({ facts: { ...baseFacts, modules: ['Inventory'] } }))).toContain('items');
    expect(keys(inputs({ role: role({ Sales: 'edit' }) }))).not.toContain('approvals');
    expect(keys(inputs({ role: role({ Sales: 'edit' }, { canApprove: true }) }))).toContain('approvals');
    expect(keys(inputs({ role: role({ Reports: 'view' }) }))).not.toContain('me_signoff');
    expect(keys(inputs({ role: role({ Reports: 'view' }, { canSignOff: true }) }))).toContain('me_signoff');
    expect(keys(inputs({ facts: { ...baseFacts, vatStatus: 'unregistered' } }))).not.toContain('me_vat');
  });

  it('items tick themselves from the books, and a hand tick counts too', () => {
    const got = (f: Partial<Facts>, ticks: Inputs['ticks'] = []) => Object.fromEntries(buildChecklist(inputs({ facts: { ...baseFacts, ...f }, ticks })).map((x) => [x.key, x.how]));
    expect(got({}).bank).toBeNull();
    expect(got({ bankAccounts: true }).bank).toBe('auto');
    expect(got({ invoice: true }).invoice).toBe('auto');
    expect(got({}).chart).toBeNull();
    expect(got({}, [{ key: 'chart', userId: null, period: '', at: 'x' }]).chart).toBe('manual');
    expect(got({ members: 2 }).team).toBeUndefined();   // not the Administrator
  });

  it('a personal tick is only mine, a daily tick only counts today, a month-end tick only for the month just finished', () => {
    const find = (i: Inputs, key: string) => buildChecklist(i).find((x) => x.key === key)!;
    const mine = { key: 'twofa', userId: 'u1', period: '', at: 't' };
    expect(find(inputs({ ticks: [mine] }), 'twofa').done).toBe(true);
    expect(find(inputs({ userId: 'u2', ticks: [mine] }), 'twofa').done).toBe(false);
    const day = { key: 'daily_record', userId: 'u1', period: '2026-11-25', at: 't' };
    expect(find(inputs({ ticks: [day] }), 'daily_record').done).toBe(true);
    expect(find(inputs({ today: '2026-11-26', ticks: [day] }), 'daily_record').done).toBe(false);
    const month = { key: 'me_vat', userId: null, period: '2026-10', at: 't' };
    expect(find(inputs({ ticks: [month] }), 'me_vat')).toMatchObject({ done: true, forMonth: '2026-10' });
    expect(find(inputs({ today: '2026-12-02', ticks: [month] }), 'me_vat')).toMatchObject({ done: false, forMonth: '2026-11' });
    expect(find(inputs({ ticks: [{ ...mine, userId: null }] }), 'twofa').done).toBe(false);   // a company tick does not tick a personal item
  });

  it('month-end items follow the month just finished, not the current one', () => {
    const f = { ...baseFacts, bankAccounts: true, openBankLinesToMonthEnd: true, openBankLines: false };
    expect(buildChecklist(inputs({ facts: f })).find((x) => x.key === 'me_bank')!.done).toBe(false);
    expect(buildChecklist(inputs({ facts: f })).find((x) => x.key === 'daily_bank')!.done).toBe(true);
  });

  it('hiding: the company hides for everyone (the Administrator still sees it, marked), a person hides only for themselves', () => {
    const o = { key: 'chart', isCustom: false, area: null, scope: 'company' as const, title: null, titleAr: null, help: null, helpAr: null, goModule: null, goSub: null, sort: null, hidden: true };
    expect(keys(inputs({ overrides: [o] }))).not.toContain('chart');
    const admin = buildChecklist(inputs({ overrides: [o], isAdmin: true })).find((x) => x.key === 'chart')!;
    expect(admin.hiddenForCompany).toBe(true);
    expect(buildChecklist(inputs({ hiddenByMe: ['chart'] })).find((x) => x.key === 'chart')!.hiddenByMe).toBe(true);
    expect(buildChecklist(inputs()).find((x) => x.key === 'chart')!.hiddenByMe).toBe(false);
  });

  it('the button counts Set up and Month end items that are shown, never daily or hidden ones', () => {
    const all = buildChecklist(inputs({ facts: { ...baseFacts, invoice: true }, hiddenByMe: ['chart'] }));
    const p = progress(all);
    const counted = all.filter((x) => x.area !== 'daily' && !x.hiddenByMe);
    expect(p.total).toBe(counted.length);
    expect(p.done).toBe(counted.filter((x) => x.done).length);
    expect(p.open).toBe(p.total - p.done);
    expect(all.some((x) => x.area === 'daily')).toBe(true);
  });

  it('orders by area, then by the Administrator\'s order, and puts their own items after the built-in ones', () => {
    const custom = { key: 'c_abc', isCustom: true, area: 'setup' as const, scope: 'company' as const, title: 'Mine', titleAr: null, help: null, helpAr: null, goModule: 'Sales', goSub: null, sort: 1010, hidden: false };
    const moved = { key: 'bank', isCustom: false, area: null, scope: 'company' as const, title: null, titleAr: null, help: null, helpAr: null, goModule: null, goSub: null, sort: 5, hidden: false };
    const list = buildChecklist(inputs({ overrides: [custom, moved] }));
    expect(list[0]!.key).toBe('bank');
    const areas = list.map((x) => ['setup', 'daily', 'month_end'].indexOf(x.area));
    expect(areas).toEqual([...areas].sort((a, b) => a - b));
    expect(list.filter((x) => x.area === 'setup').at(-1)!.key).toBe('c_abc');
    expect(list.find((x) => x.key === 'c_abc')!.go).toEqual({ module: 'Sales' });
  });

  it('every built-in item has a unique key, a place to go and no visibility rule that hides it from everyone', () => {
    expect(new Set(BUILT_IN.map((b) => b.key)).size).toBe(BUILT_IN.length);
    for (const b of BUILT_IN) {
      expect(visibleTo(b, { facts: { ...baseFacts, modules: ['Inventory'], bankAccounts: true }, role: null, isAdmin: true }), b.key).toBe(true);
      expect(b.go.module || b.go.page, b.key).toBeTruthy();
    }
  });

  it('refuses anything the Administrator sends that is not on the allowed lists', () => {
    const bad = (x: unknown, create = true) => cleanItem(x, create);
    expect(bad({ area: 'setup', title: 'Ok' }).ok).toBe(true);
    expect(bad({ area: 'weekly', title: 'x' })).toMatchObject({ ok: false });
    expect(bad({ area: 'setup' })).toMatchObject({ ok: false, problem: 'title' });
    expect(bad({ title: 'x' })).toMatchObject({ ok: false, problem: 'area' });
    expect(bad({ area: 'setup', title: 'x'.repeat(121) })).toMatchObject({ ok: false });
    expect(bad({ area: 'setup', title: 7 })).toMatchObject({ ok: false });
    expect(bad({ area: 'setup', title: 'x', goModule: 'javascript:alert(1)' })).toMatchObject({ ok: false, problem: 'goModule' });
    expect(bad({ area: 'setup', title: 'x', goModule: 'Sales', goSub: '../../etc' })).toMatchObject({ ok: false, problem: 'goSub' });
    expect(bad({ area: 'setup', title: 'x', scope: 'everyone' })).toMatchObject({ ok: false, problem: 'scope' });
    expect(bad({ key: 'Bad Key' }, false)).toMatchObject({ ok: false, problem: 'key' });
    expect(bad('text')).toMatchObject({ ok: false });
    expect(bad([])).toMatchObject({ ok: false });
    expect(bad({ key: 'chart', hidden: 'yes' }, false)).toMatchObject({ ok: false, problem: 'hidden' });
    const r = cleanItem({ area: 'daily', title: '  Check   the   till  ' }, true);
    expect(r.ok && r.value.title).toBe('Check the till');
  });
});

describe('Through the API, with throwaway customers', () => {
  let server: FastifyInstance;
  let ownerCookie = '';
  let planId = '';
  const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  beforeAll(async () => {
    const f = await seed();
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'checklist-secret', lockCacheMs: 0 });
    ownerCookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
    planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  });
  afterAll(async () => { await server?.close(); });

  const login = async (email: string) => String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  /** A company with an Administrator (not a member: manages people, never sees the books) and a Finance person who uses the books. */
  async function customer() {
    const s = stamp();
    const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name: `Check ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh', modules: [] },
      users: [{ name: 'Admin', email: `a.${s}@list.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `f.${s}@list.example.com`, jobTitle: 'Finance' }] } });
    expect(res.statusCode, res.body).toBe(200);
    const firm = res.json().id as string;
    const users = (await owner.query('SELECT id, email FROM users WHERE firm_id = $1', [firm])).rows as { id: string; email: string }[];
    for (const u of users) await owner.query('UPDATE users SET password_hash = $1, password_set_at = now() WHERE id = $2', [await hashPassword(PW), u.id]);
    await server.inject({ method: 'POST', url: `/api/owner/tenants/${firm}/subscription`, headers: { cookie: ownerCookie }, payload: { planId, cycle: 'yearly', startOn: new Date().toISOString().slice(0, 10), trial: true } });
    const adm = users.find((u) => u.email.startsWith('a.'))!, fin = users.find((u) => u.email.startsWith('f.'))!;
    const companyId = (await owner.query('SELECT id FROM companies WHERE firm_id = $1', [firm])).rows[0].id as string;
    return { firm, companyId, admin: { id: adm.id, cookie: await login(adm.email) }, fin: { id: fin.id, cookie: await login(fin.email) } };
  }
  type Cust = Awaited<ReturnType<typeof customer>>;
  /** A second person with the same role as Finance, in the same company. */
  async function colleague(c: Cust) {
    const s = stamp();
    const id = (await owner.query(`INSERT INTO users (firm_id, kind, full_name, email, password_hash, password_set_at) VALUES ($1, 'client', 'Colleague', $2, $3, now()) RETURNING id`,
      [c.firm, `c.${s}@list.example.com`, await hashPassword(PW)])).rows[0].id as string;
    await owner.query(`INSERT INTO memberships (user_id, company_id, role, client_role_id) SELECT $1, company_id, role, client_role_id FROM memberships WHERE user_id = $2 AND company_id = $3`, [id, c.fin.id, c.companyId]);
    return { id, cookie: await login(`c.${s}@list.example.com`) };
  }
  /** Gives Finance the right to manage users: the same person is then both a member and an Administrator (the usual case for a small company). */
  const makeFinanceAdmin = (c: Cust) => owner.query(`UPDATE client_roles SET can_manage_users = true WHERE id = (SELECT client_role_id FROM memberships WHERE user_id = $1 AND company_id = $2)`, [c.fin.id, c.companyId]);
  const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, payload: payload as never, headers: { cookie } });
  const list = async (cookie: string, c: Cust) => (await call(cookie, 'GET', `/api/companies/${c.companyId}/checklist`)).json() as C.Checklist;
  const setup = async (cookie: string, c: Cust) => (await call(cookie, 'GET', `/api/companies/${c.companyId}/checklist/setup`)).json() as { items: { key: string; custom: boolean; title: string | null; hiddenForCompany: boolean; area: string; scope: string; go: unknown }[] };
  const find = <T extends { key: string }>(l: { items: T[] }, key: string) => l.items.find((x) => x.key === key);
  const tick = (cookie: string, c: Cust, key: string, done: boolean) => call(cookie, 'POST', `/api/companies/${c.companyId}/checklist/tick`, { key, done });

  it('gives Finance the books items; an Administrator who is not a member edits the list but never gets the books', async () => {
    const c = await customer();
    const f = await list(c.fin.cookie, c);
    expect(f.isAdmin).toBe(false);
    expect(find(f, 'invoice')).toBeTruthy();
    expect(find(f, 'company')).toBeUndefined();        // company details are for the Administrator
    expect(find(f, 'registration')).toBeUndefined();
    expect((await call(c.admin.cookie, 'GET', `/api/companies/${c.companyId}/checklist`)).statusCode).toBe(404);   // not a member: no books list
    const s = await setup(c.admin.cookie, c);
    expect(s.items.length).toBeGreaterThan(10);
    expect(JSON.stringify(s)).not.toMatch(/"done"|"doneAt"/);   // the editor carries no state from the books
    expect((await call(c.fin.cookie, 'GET', `/api/companies/${c.companyId}/checklist/setup`)).statusCode).toBe(403);
  });

  it('a person who is both a member and the Administrator gets the company items as well', async () => {
    const c = await customer();
    await makeFinanceAdmin(c);
    const l = await list(c.fin.cookie, c);
    expect(l.isAdmin).toBe(true);
    expect(find(l, 'company')).toBeTruthy();
    expect(find(l, 'registration')).toMatchObject({ done: true, how: 'auto' });   // real-looking CR and VAT numbers
    expect(find(l, 'team')).toMatchObject({ done: true, how: 'auto' });           // two people in the company
    expect(find(l, 'company')).toMatchObject({ done: true, how: 'auto' });        // a real address (there is no logo upload yet, so the address alone ticks it)
  });

  it('a tick by hand is for the company, can be taken back, and an item that ticks itself cannot be un-ticked', async () => {
    const c = await customer();
    expect((await tick(c.fin.cookie, c, 'chart', true)).statusCode).toBe(200);
    expect(find(await list(c.fin.cookie, c), 'chart')).toMatchObject({ done: true, how: 'manual' });
    expect((await tick(c.fin.cookie, c, 'chart', true)).statusCode).toBe(200);   // twice is fine
    expect((await owner.query(`SELECT count(*)::int AS n FROM checklist_ticks WHERE company_id = $1 AND item_key = 'chart'`, [c.companyId])).rows[0].n).toBe(1);
    // the colleague sees the same company tick, and can take it back
    const w = await colleague(c);
    expect(find(await list(w.cookie, c), 'chart')!.done).toBe(true);
    expect((await tick(w.cookie, c, 'chart', false)).statusCode).toBe(200);
    expect(find(await list(c.fin.cookie, c), 'chart')!.done).toBe(false);
    await makeFinanceAdmin(c);
    expect((await tick(c.fin.cookie, c, 'team', false)).statusCode).toBe(400);   // ticks itself from the people list
  });

  it('a tick is written to the audit log with who and when, and un-ticking is logged too', async () => {
    const c = await customer();
    await tick(c.fin.cookie, c, 'chart', true);
    await tick(c.fin.cookie, c, 'chart', false);
    const rows = (await owner.query(`SELECT action, user_id FROM audit_log WHERE company_id = $1 AND table_name = 'checklist_ticks' ORDER BY id`, [c.companyId])).rows;
    expect(rows.map((r) => r.action)).toEqual(['insert', 'delete']);
    expect(rows.every((r) => r.user_id === c.fin.id)).toBe(true);
  });

  it('a personal item is ticked only for me; hiding an item changes only my own list', async () => {
    const c = await customer();
    const w = await colleague(c);
    await tick(c.fin.cookie, c, 'twofa', true);
    expect(find(await list(c.fin.cookie, c), 'twofa')!.done).toBe(true);
    expect(find(await list(w.cookie, c), 'twofa')!.done).toBe(false);    // my colleague's own item is still open
    expect((await owner.query(`SELECT count(*)::int AS n FROM checklist_ticks WHERE company_id = $1 AND item_key = 'twofa' AND user_id = $2`, [c.companyId, c.fin.id])).rows[0].n).toBe(1);
    const r = await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/checklist/hide`, { key: 'chart', hidden: true });
    expect(r.statusCode).toBe(200);
    const mine = await list(c.fin.cookie, c);
    expect(find(mine, 'chart')!.hiddenByMe).toBe(true);
    expect(find(await list(w.cookie, c), 'chart')!.hiddenByMe).toBe(false);
    const total = mine.progress.total;
    await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/checklist/hide`, { key: 'chart', hidden: false });
    expect((await list(c.fin.cookie, c)).progress.total).toBe(total + 1);
  });

  it('a person cannot tick or hide an item their role does not show them', async () => {
    const c = await customer();
    expect((await tick(c.admin.cookie, c, 'invoice', true)).statusCode).toBe(404);   // the Administrator is not in the books
    expect((await tick(c.fin.cookie, c, 'company', true)).statusCode).toBe(404);      // Finance is not the Administrator
    expect((await tick(c.fin.cookie, c, 'no_such_item', true)).statusCode).toBe(404);
    expect((await tick(c.fin.cookie, c, 'chart', 'yes' as never)).statusCode).toBe(400);
    expect((await tick(c.fin.cookie, c, '../x', true)).statusCode).toBe(400);
    expect((await call(c.fin.cookie, 'POST', `/api/companies/${c.companyId}/checklist/hide`, { key: 'company', hidden: true })).statusCode).toBe(404);
    // a role with no access to a module never receives its items
    await owner.query(`UPDATE client_roles SET permissions = permissions || '{"Bank":"none"}'::jsonb WHERE id = (SELECT client_role_id FROM memberships WHERE user_id = $1 AND company_id = $2)`, [c.fin.id, c.companyId]);
    const l = await list(c.fin.cookie, c);
    expect(find(l, 'bank')).toBeUndefined();
    expect(find(l, 'me_bank')).toBeUndefined();
    expect((await tick(c.fin.cookie, c, 'bank', true)).statusCode).toBe(404);
  });

  it('only the company\'s Administrator adds, changes, hides, removes and orders items', async () => {
    const c = await customer();
    const base = `/api/companies/${c.companyId}/checklist`;
    // Finance (a member, not the Administrator) is refused at every door
    for (const [path, body] of [['items', { area: 'setup', title: 'Sneaky' }], ['items', { key: 'chart', hidden: true }], ['items/delete', { key: 'c_abc' }], ['order', { keys: ['bank', 'chart'] }]] as const) {
      const r = await call(c.fin.cookie, 'POST', `${base}/${path}`, body);
      expect(r.statusCode, path).toBe(403);
      expect(r.json().key).toBe('err.checklistAdmin');
    }
    // the Administrator adds an item of their own
    const added = await call(c.admin.cookie, 'POST', `${base}/items`, { area: 'daily', title: 'Count the till', titleAr: 'عدّ الصندوق', help: 'Before closing', goModule: 'Sales', scope: 'user' });
    expect(added.statusCode, added.body).toBe(200);
    const mine = (added.json() as Awaited<ReturnType<typeof setup>>).items.find((x) => x.custom)!;
    expect(mine).toMatchObject({ title: 'Count the till', area: 'daily', scope: 'user', go: { module: 'Sales' } });
    // Finance sees it and ticks it (a personal item); the colleague's own tick is separate
    const w = await colleague(c);
    expect(find(await list(c.fin.cookie, c), mine.key)!.title).toBe('Count the till');
    await tick(c.fin.cookie, c, mine.key, true);
    expect(find(await list(c.fin.cookie, c), mine.key)!.done).toBe(true);
    expect(find(await list(w.cookie, c), mine.key)!.done).toBe(false);
    // hide a built-in item for the whole company: nobody in the books gets it, the Administrator's editor shows it marked
    await call(c.admin.cookie, 'POST', `${base}/items`, { key: 'chart', hidden: true });
    expect(find(await list(c.fin.cookie, c), 'chart')).toBeUndefined();
    expect(find(await list(w.cookie, c), 'chart')).toBeUndefined();
    expect(find(await setup(c.admin.cookie, c), 'chart')!.hiddenForCompany).toBe(true);
    await call(c.admin.cookie, 'POST', `${base}/items`, { key: 'chart', hidden: false });
    expect(find(await list(c.fin.cookie, c), 'chart')).toBeTruthy();
    // reword a built-in item; its place and rule do not change
    await call(c.admin.cookie, 'POST', `${base}/items`, { key: 'chart', title: 'Check our chart of accounts' });
    expect(find(await list(c.fin.cookie, c), 'chart')).toMatchObject({ title: 'Check our chart of accounts', area: 'setup', scope: 'company' });
    // the place or the rule of a built-in item cannot be changed
    for (const body of [{ key: 'chart', area: 'daily' }, { key: 'chart', scope: 'user' }, { key: 'chart', goModule: 'Bank' }, { key: 'nothing_here', hidden: true }]) {
      expect([400, 404], JSON.stringify(body)).toContain((await call(c.admin.cookie, 'POST', `${base}/items`, body)).statusCode);
    }
    // order: the list the Administrator sends is kept; unknown or repeated keys are refused
    expect((await call(c.admin.cookie, 'POST', `${base}/order`, { keys: ['chart', 'bank', 'invoice'] })).statusCode).toBe(200);
    const ordered = (await list(c.fin.cookie, c)).items.filter((x) => x.area === 'setup').map((x) => x.key);
    expect(ordered.indexOf('chart')).toBeLessThan(ordered.indexOf('bank'));
    expect(ordered.indexOf('bank')).toBeLessThan(ordered.indexOf('invoice'));
    expect((await call(c.admin.cookie, 'POST', `${base}/order`, { keys: ['chart', 'chart'] })).statusCode).toBe(400);
    expect((await call(c.admin.cookie, 'POST', `${base}/order`, { keys: ['chart', 'hack'] })).statusCode).toBe(400);
    // remove it again; built-in items cannot be removed
    expect((await call(c.admin.cookie, 'POST', `${base}/items/delete`, { key: 'chart' })).statusCode).toBe(400);
    expect((await call(c.admin.cookie, 'POST', `${base}/items/delete`, { key: mine.key })).statusCode).toBe(200);
    expect(find(await list(c.fin.cookie, c), mine.key)).toBeUndefined();
    const n = (await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'checklist_items'`, [c.companyId])).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('refuses bad input from the Administrator and keeps the list unchanged', async () => {
    const c = await customer();
    const base = `/api/companies/${c.companyId}/checklist/items`;
    const before = (await setup(c.admin.cookie, c)).items.length;
    for (const body of [{ area: 'setup' }, { area: 'x', title: 'a' }, { area: 'setup', title: 'a', goModule: 'Nope' }, { area: 'setup', title: '<img src=x onerror=alert(1)>'.repeat(20) }, 'text', null]) {
      const r = await call(c.admin.cookie, 'POST', base, body as never);
      expect([400, 415], JSON.stringify(body)).toContain(r.statusCode);
    }
    expect((await setup(c.admin.cookie, c)).items.length).toBe(before);
    for (let i = 0; i < 30; i++) expect((await call(c.admin.cookie, 'POST', base, { area: 'setup', title: `Own ${i}` })).statusCode).toBe(200);
    expect((await call(c.admin.cookie, 'POST', base, { area: 'setup', title: 'One too many' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('many items added at the same moment still stop at 30 (found in the Deep Check: the count was not serialised)', async () => {
    const c = await customer();
    const results = await Promise.all(Array.from({ length: 45 }, (_, i) => call(c.admin.cookie, 'POST', `/api/companies/${c.companyId}/checklist/items`, { area: 'setup', title: `Parallel ${i}` })));
    expect(results.every((r) => r.statusCode < 500), results.map((r) => r.statusCode).join(',')).toBe(true);
    expect((await owner.query(`SELECT count(*)::int AS n FROM checklist_items WHERE company_id = $1 AND is_custom`, [c.companyId])).rows[0].n).toBe(30);
    // and forty ticks of one item at once leave exactly one tick
    await Promise.all(Array.from({ length: 40 }, () => tick(c.fin.cookie, c, 'chart', true)));
    expect((await owner.query(`SELECT count(*)::int AS n FROM checklist_ticks WHERE company_id = $1 AND item_key = 'chart'`, [c.companyId])).rows[0].n).toBe(1);
  });

  it('another company can neither read nor change this company\'s list, and nobody can write around the rules in the database', async () => {
    const a = await customer(), b = await customer();
    await tick(a.fin.cookie, a, 'chart', true);
    await call(a.admin.cookie, 'POST', `/api/companies/${a.companyId}/checklist/items`, { area: 'setup', title: 'Secret plan' });
    const other = `/api/companies/${a.companyId}/checklist`;
    expect((await call(b.fin.cookie, 'GET', other)).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'GET', `${other}/setup`)).statusCode).toBe(404);
    expect((await call(b.fin.cookie, 'POST', `${other}/tick`, { key: 'chart', done: false })).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'POST', `${other}/items`, { area: 'setup', title: 'x' })).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'POST', `${other}/items/delete`, { key: 'c_1' })).statusCode).toBe(404);
    expect((await call(b.admin.cookie, 'POST', `${other}/order`, { keys: ['bank'] })).statusCode).toBe(404);
    // company B sees none of A's rows even by asking the database directly
    for (const who of [b.fin.id, b.admin.id]) {
      expect((await as(who, (db) => db.query('SELECT * FROM checklist_items'))).rows.filter((r) => r.company_id === a.companyId)).toHaveLength(0);
      expect((await as(who, (db) => db.query('SELECT * FROM checklist_ticks'))).rows.filter((r) => r.company_id === a.companyId)).toHaveLength(0);
    }
    // Finance cannot add items straight into the table, nor tick for someone else, nor tick for another company, nor change a tick
    await expect(as(a.fin.id, (db) => db.query(`INSERT INTO checklist_items (company_id, key, is_custom, area, title) VALUES ($1, 'c_hack', true, 'setup', 'x')`, [a.companyId]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`INSERT INTO checklist_ticks (company_id, item_key, user_id) VALUES ($1, 'twofa', $2)`, [a.companyId, a.admin.id]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`INSERT INTO checklist_ticks (company_id, item_key) VALUES ($1, 'chart')`, [b.companyId]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`UPDATE checklist_ticks SET item_key = 'bank' WHERE company_id = $1`, [a.companyId]))).rejects.toThrow();
    await expect(as(a.fin.id, (db) => db.query(`INSERT INTO checklist_hidden (company_id, user_id, item_key) VALUES ($1, $2, 'bank')`, [a.companyId, a.admin.id]))).rejects.toThrow();
    // the Administrator of B cannot reach A through the table either
    await expect(as(b.admin.id, (db) => db.query(`INSERT INTO checklist_items (company_id, key, is_custom, area, title) VALUES ($1, 'c_hack', true, 'setup', 'x')`, [a.companyId]))).rejects.toThrow();
    // a column cannot carry a long text or a bad key
    await expect(as(a.admin.id, (db) => db.query(`INSERT INTO checklist_items (company_id, key, is_custom, area, title) VALUES ($1, 'Bad Key', true, 'setup', 'x')`, [a.companyId]))).rejects.toThrow();
    await expect(as(a.admin.id, (db) => db.query(`INSERT INTO checklist_items (company_id, key, is_custom, area, title) VALUES ($1, 'c_long', true, 'setup', $2)`, [a.companyId, 'x'.repeat(121)]))).rejects.toThrow();
  });

  it('daily items start afresh the next day and month-end items follow the month just finished (clock moved in the service)', async () => {
    const c = await customer();
    const day1 = new Date('2026-11-25T09:00:00Z'), day2 = new Date('2026-11-26T09:00:00Z'), nextMonth = new Date('2026-12-02T09:00:00Z');
    await as(c.fin.id, (db) => C.setTick(db, c.companyId, 'daily_record', true, day1));
    const read = (at: Date) => as(c.fin.id, (db) => C.checklistFor(db, c.companyId, at));
    expect(find(await read(day1), 'daily_record')!.done).toBe(true);
    expect(find(await read(day2), 'daily_record')!.done).toBe(false);
    await as(c.fin.id, (db) => C.setTick(db, c.companyId, 'me_vat', true, day1));
    expect(find(await read(day2), 'me_vat')).toMatchObject({ done: true, forMonth: '2026-10' });
    expect(find(await read(nextMonth), 'me_vat')).toMatchObject({ done: false, forMonth: '2026-11' });
    // the Riyadh date decides: 22:30 UTC on 25 Nov is already 26 Nov in Riyadh
    expect((await read(new Date('2026-11-25T22:30:00Z'))).today).toBe('2026-11-26');
  });

  it('ticks itself from real events: bank account and sign-off', async () => {
    const c = await customer();
    const l0 = await list(c.fin.cookie, c);
    expect(find(l0, 'bank')!.done).toBe(false);
    expect(find(l0, 'me_drafts')!.done).toBe(true);   // no drafts yet
    expect(find(l0, 'me_signoff')).toBeUndefined();   // Finance's role cannot sign off
    const cols = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_accounts'`)).rows.map((r) => r.column_name as string);
    expect(cols).toContain('kind');
    const acct = (await owner.query(`INSERT INTO accounts (company_id, code, name, type, is_bank) VALUES ($1, '1099', 'Bank', 'asset', true) RETURNING id`, [c.companyId])).rows[0].id as string;
    expect(find(await list(c.fin.cookie, c), 'bank')).toMatchObject({ done: true, how: 'auto' });
    await owner.query(`UPDATE client_roles SET can_review = true, can_sign_off = true WHERE id = (SELECT client_role_id FROM memberships WHERE user_id = $1 AND company_id = $2)`, [c.fin.id, c.companyId]);
    const prev = previousMonth((await as(c.fin.id, (db) => C.checklistFor(db, c.companyId))).today);
    expect(find(await list(c.fin.cookie, c), 'me_signoff')!.done).toBe(false);
    await owner.query(`INSERT INTO review_signoffs (company_id, period_end, signed_by) VALUES ($1, $2, $3)`, [c.companyId, prev.end, c.fin.id]);
    expect(find(await list(c.fin.cookie, c), 'me_signoff')).toMatchObject({ done: true, how: 'auto' });
  });
});
