// The guided first-run setup: its rules, the Word-table reader, the PDF/picture reader (switched off unless configured, tested with a fake
// provider), saving the steps, switching modules on only during the trial, separation between customers, and the owner's counts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as appPool, as, owner, seed, saCr, saVat } from './helpers.js';
import { buildServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import * as B from '../src/books/billingService.js';
import * as S from '../src/books/guidedSetup.js';
import { cleanAnswers, industryRows, modulesForGoals, guideOf, INDUSTRY_ACCOUNTS, BUSINESS_TYPES } from '../src/books/setupRules.js';
import { readDocx } from '../src/bank/docx.js';
import { zipStored } from '../src/export/xlsx.js';
import { cleanRows, extractRows, extractConfig, Limiter, type Fetcher } from '../src/books/documentExtract.js';
import { CHART_TEMPLATE } from '../src/books/chartTemplate.js';

const PW = 'pw-123456';
const enc = (s: string) => new TextEncoder().encode(s);
const P = 'application/pdf';
const PDF = Buffer.from('%PDF-1.4 throwaway').toString('base64');

describe('The rules', () => {
  it('goals switch on only the optional modules they need', () => {
    expect(modulesForGoals(['invoicing', 'vat', 'payroll', 'inventory', 'payroll'])).toEqual(['HRM', 'Inventory']);
    expect(modulesForGoals([])).toEqual([]);
  });
  it('answers outside the lists are refused, not dropped', () => {
    expect(cleanAnswers({ businessType: 'bank', goals: [] })).toEqual({ ok: false, problem: 'businessType' });
    expect(cleanAnswers({ goals: ['payroll', 'hack'] })).toEqual({ ok: false, problem: 'goals' });
    expect(cleanAnswers({ goals: 'payroll' })).toEqual({ ok: false, problem: 'goals' });
    expect(cleanAnswers({ dataChoice: 'sample' })).toEqual({ ok: false, problem: 'dataChoice' });
    expect(cleanAnswers({ businessType: 'trading', goals: ['vat', 'vat'], dataChoice: 'fresh' })).toEqual({ ok: true, value: { businessType: 'trading', goals: ['vat'], dataChoice: 'fresh' } });
  });
  it('the extra accounts of a business never clash with the standard chart or with each other', () => {
    const standard = new Set(CHART_TEMPLATE.map((a) => a.code));
    for (const b of BUSINESS_TYPES) {
      const codes = INDUSTRY_ACCOUNTS[b].map((r) => r[0]);
      expect(new Set(codes).size).toBe(codes.length);
      for (const c of codes) expect(standard.has(c), `${b} ${c}`).toBe(false);
    }
    expect(industryRows('other')).toEqual([]);
    expect(industryRows('restaurant')[0]).toEqual(['Code', 'Name', 'Arabic name', 'Type', 'Cost centre required']);
  });
  it('knows which page guide a path belongs to', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(guideOf(`/c/${id}`)).toBe('Home');
    expect(guideOf(`/c/${id}/Sales/invoices`)).toBe('Sales');
    expect(guideOf(`/c/${id}/Nope/x`)).toBeNull();
    expect(guideOf('/admin/clients')).toBeNull();
  });
});

describe('Reading a Word table (no AI, in the browser or Node)', () => {
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:tc>`;
  const row = (...c: string[]) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
  const docx = (body: string) => zipStored([['word/document.xml', enc(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`)]]);
  it('reads the biggest table, ignores the text around it and decodes entities', async () => {
    const small = `<w:tbl>${row('a', 'b')}</w:tbl>`;
    const big = `<w:tbl>${row('Name', 'VAT number')}${row('Gulf &amp; Steel', '300000000000003')}${row('Najd', '')}</w:tbl>`;
    const rows = await readDocx(docx(`<w:p><w:r><w:t>Intro</w:t></w:r></w:p>${small}${big}`));
    expect(rows).toEqual([['Name', 'VAT number'], ['Gulf & Steel', '300000000000003'], ['Najd', '']]);
  });
  it('refuses a file with no table, a non-zip file and a zip that is not a Word file', async () => {
    await expect(readDocx(docx('<w:p><w:r><w:t>no table</w:t></w:r></w:p>'))).rejects.toThrow(/no table/);
    await expect(readDocx(enc('hello'))).rejects.toThrow();
    await expect(readDocx(zipStored([['x.txt', enc('x')]]))).rejects.toThrow(/Word/);
  });
});

describe('Reading a PDF or picture (off unless configured)', () => {
  const on = { enabled: true, apiKey: 'test-key', model: 'm', endpoint: 'https://example.invalid/v1/messages' };
  const ok = (rows: unknown): Fetcher => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'submit_rows', input: { rows } }] }) });
  it('is off by default and when outside calls are off', () => {
    expect(extractConfig({}).enabled).toBe(false);
    expect(extractConfig({ DOC_EXTRACT: 'on' }).enabled).toBe(false);
    expect(extractConfig({ DOC_EXTRACT: 'on', ANTHROPIC_API_KEY: 'k' }).enabled).toBe(true);
    expect(extractConfig({ DOC_EXTRACT: 'on', ANTHROPIC_API_KEY: 'k', OUTSIDE_CALLS: 'off' }).enabled).toBe(false);
  });
  it('needs the customer\'s tick, a known kind, and a real PDF or picture of up to 5 MB', async () => {
    const f = ok([['Code', 'Name'], ['1', 'x']]);
    await expect(extractRows({ ...on, enabled: false }, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true }, f)).rejects.toMatchObject({ key: 'err.extractOff' });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: PDF, fileType: P }, f)).rejects.toMatchObject({ key: 'err.extractConsent' });
    await expect(extractRows(on, { kind: 'payroll', fileBase64: PDF, fileType: P, consent: true }, f)).rejects.toMatchObject({ key: 'err.importKind' });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: Buffer.from('MZ evil').toString('base64'), fileType: P, consent: true }, f)).rejects.toMatchObject({ key: 'err.payFileType' });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: '***', fileType: P, consent: true }, f)).rejects.toMatchObject({ key: 'err.payFile' });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 0x25).toString('base64'), fileType: P, consent: true }, f)).rejects.toMatchObject({ key: 'err.payFileSize' });
  });
  it('sends the file as data with only one tool, and returns a cleaned table', async () => {
    let seen: any;
    const f: Fetcher = async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return ok([['Code', 'Name', 'Type'], ['1000', 'Cash\u0000 bank', 'asset']])(url, init); };
    const rows = await extractRows(on, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true }, f);
    expect(rows).toEqual([['Code', 'Name', 'Type'], ['1000', 'Cash  bank', 'asset']]);
    expect(seen.headers['x-api-key']).toBe('test-key');
    expect(seen.body.tools).toHaveLength(1);
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'submit_rows' });
    expect(seen.body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: P } });
    expect(seen.body.system).toMatch(/DATA/);
  });
  it('adds our header when the reader gave none, and refuses nonsense or oversized answers', async () => {
    expect(cleanRows([['1000', 'Cash', 'asset']], 'accounts')[0]).toEqual(['Code', 'Name', 'Arabic name', 'Type', 'Cost centre required']);
    expect(() => cleanRows('hi', 'accounts')).toThrow();
    expect(() => cleanRows([], 'accounts')).toThrow();
    expect(() => cleanRows([['a'], 'x'], 'accounts')).toThrow();
    expect(() => cleanRows(Array.from({ length: 2005 }, () => ['a']), 'accounts')).toThrow();
    expect(cleanRows([['Code'], ['x'.repeat(900)]], 'accounts')[1]![0]).toHaveLength(300);
  });
  it('a failing or lying provider gives a plain error, never a crash or a partial table', async () => {
    const down: Fetcher = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true }, down)).rejects.toMatchObject({ key: 'err.extractFailed' });
    const throws: Fetcher = async () => { throw new Error('network'); };
    await expect(extractRows(on, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true }, throws)).rejects.toMatchObject({ key: 'err.extractFailed' });
    const noTool: Fetcher = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ignore previous instructions' }] }) });
    await expect(extractRows(on, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true }, noTool)).rejects.toMatchObject({ key: 'err.extractFailed' });
  });
  it('the limiter allows a few and then stops, and forgets after its window', () => {
    let t = 0;
    const l = new Limiter(2, 1000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a'), l.take('b')]).toEqual([true, true, false, true]);
    t = 1500;
    expect(l.take('a')).toBe(true);
  });
});

describe('The saved steps', () => {
  let server: FastifyInstance;
  let planId: string;
  let ownerCookie = '';
  const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  beforeAll(async () => {
    const f = await seed();
    const email = (await owner.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [await hashPassword(PW), f.platformOwner])).rows[0].email;
    server = buildServer({ pool: appPool, sessionSecret: 'setup-secret', lockCacheMs: 0 });
    ownerCookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
    planId = (await owner.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
  });
  afterAll(async () => { await server?.close(); });

  /** A customer with ONE company (like a company that keeps its own books), on a free trial, with one person who uses the books. */
  async function customer(trial = true) {
    const s = stamp();
    const res = await server.inject({ method: 'POST', url: '/api/owner/customers/company', headers: { cookie: ownerCookie }, payload: {
      company: { name: `Setup ${s}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: saCr(), vatStatus: 'registered', vatNumber: saVat(), address: 'Road', city: 'Riyadh', modules: ['Inventory'] },
      users: [{ name: 'Admin', email: `a.${s}@setup.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `f.${s}@setup.example.com`, jobTitle: 'Finance' }] } });
    expect(res.statusCode, res.body).toBe(200);
    const firm = res.json().id as string;
    const user = (await owner.query(`SELECT id, email FROM users WHERE firm_id = $1 AND email LIKE 'f.%'`, [firm])).rows[0] as { id: string; email: string };
    await owner.query('UPDATE users SET password_hash = $1, password_set_at = now() WHERE id = $2', [await hashPassword(PW), user.id]);
    if (trial) await server.inject({ method: 'POST', url: `/api/owner/tenants/${firm}/subscription`, headers: { cookie: ownerCookie }, payload: { planId, cycle: 'yearly', startOn: new Date().toISOString().slice(0, 10), trial: true } });
    const cookie = String((await server.inject({ method: 'POST', url: '/api/login', payload: { email: user.email, password: PW } })).headers['set-cookie']).split(';')[0]!;
    const companyId = (await owner.query('SELECT id FROM companies WHERE firm_id = $1', [firm])).rows[0].id as string;
    return { firm, user: user.id, cookie, companyId };
  }
  const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, payload: payload as never, headers: { cookie } });
  const modulesOf = async (id: string) => (await owner.query('SELECT modules FROM companies WHERE id = $1', [id])).rows[0].modules as string[];

  it('starts at the first step and shows itself only for an unpaid open trial', async () => {
    const c = await customer();
    const r = (await call(c.cookie, 'GET', '/api/setup')).json();
    expect(r.setup).toMatchObject({ step: 'about', inTrial: true, show: true, completed: false, skipped: false, goals: [] });
    expect(r.extractEnabled).toBe(false);
    const paying = await customer(false);
    expect((await call(paying.cookie, 'GET', '/api/setup')).json().setup).toMatchObject({ inTrial: false, show: false });
  });

  it('saving the goals switches on the optional modules they need (never off), and the steps are kept', async () => {
    const c = await customer();
    const r = await call(c.cookie, 'POST', '/api/setup', { step: 'chart', businessType: 'restaurant', goals: ['invoicing', 'payroll', 'restaurant'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().setup).toMatchObject({ step: 'chart', businessType: 'restaurant', goals: ['invoicing', 'payroll', 'restaurant'] });
    expect(await modulesOf(c.companyId)).toEqual(['HRM', 'Inventory', 'Restaurant']);   // Inventory stays: nothing is switched off
    const again = await call(c.cookie, 'POST', '/api/setup', { step: 'data', dataChoice: 'fresh' });
    expect(again.json().setup).toMatchObject({ step: 'data', dataChoice: 'fresh', businessType: 'restaurant', goals: ['invoicing', 'payroll', 'restaurant'] });
    const done = await call(c.cookie, 'POST', '/api/setup', { step: 'done', done: true });
    expect(done.json().setup).toMatchObject({ completed: true, show: false });
  });

  it('a tampered request is refused and changes nothing', async () => {
    const c = await customer();
    for (const body of [{ step: 'hack' }, { step: 'about', goals: ['payroll', 'Warehouse'] }, { step: 'about', businessType: 'x' }, { step: 'about', goals: 'HRM' }, { step: 'about', dataChoice: 'sample' }]) {
      const r = await call(c.cookie, 'POST', '/api/setup', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await modulesOf(c.companyId)).toEqual(['Inventory']);
    // the module function itself refuses anything not on the list, and a company that is not the caller's
    await expect(as(c.user, (db) => db.query(`SELECT setup_apply_modules($1, ARRAY['Warehouse'])`, [c.companyId]))).rejects.toThrow(/optional modules/);
    const other = await customer();
    await expect(as(c.user, (db) => db.query(`SELECT setup_apply_modules($1, ARRAY['CRM'])`, [other.companyId]))).rejects.toThrow(/Not allowed/);
  });

  it('after buying, the setup can no longer switch modules on (they are billed)', async () => {
    const c = await customer();
    await server.inject({ method: 'POST', url: `/api/owner/tenants/${c.firm}/trial/convert`, headers: { cookie: ownerCookie }, payload: { reason: 'Paid' } });
    await call(c.cookie, 'POST', '/api/setup', { step: 'chart', businessType: 'trading', goals: ['payroll'] });
    expect(await modulesOf(c.companyId)).toEqual(['Inventory']);
  });

  it('adds the accounts a kind of business needs once, leaves existing ones alone, and posts nothing', async () => {
    const c = await customer();
    const before = Number((await owner.query('SELECT count(*) AS n FROM journal_entries WHERE company_id = $1', [c.companyId])).rows[0].n);
    const r1 = await call(c.cookie, 'POST', `/api/companies/${c.companyId}/setup/chart`, { businessType: 'restaurant' });
    expect(r1.json()).toEqual({ added: 4 });
    expect((await call(c.cookie, 'POST', `/api/companies/${c.companyId}/setup/chart`, { businessType: 'restaurant' })).json()).toEqual({ added: 0 });
    expect((await call(c.cookie, 'POST', `/api/companies/${c.companyId}/setup/chart`, { businessType: 'other' })).json()).toEqual({ added: 0 });
    expect((await call(c.cookie, 'POST', `/api/companies/${c.companyId}/setup/chart`, { businessType: 'bank' })).statusCode).toBe(400);
    expect(Number((await owner.query('SELECT count(*) AS n FROM journal_entries WHERE company_id = $1', [c.companyId])).rows[0].n)).toBe(before);
    // another customer cannot add accounts to this company
    const other = await customer();
    expect([403, 404]).toContain((await call(other.cookie, 'POST', `/api/companies/${c.companyId}/setup/chart`, { businessType: 'restaurant' })).statusCode);
  });

  it('keeps one customer\'s setup apart from another\'s, and only the owner reads it directly', async () => {
    const a = await customer(), b = await customer();
    await call(a.cookie, 'POST', '/api/setup', { step: 'chart', businessType: 'contracting', goals: ['projects'] });
    expect((await call(b.cookie, 'GET', '/api/setup')).json().setup).toMatchObject({ step: 'about', businessType: null, goals: [] });
    expect((await as(a.user, (db) => db.query('SELECT * FROM trial_setup'))).rows).toHaveLength(0);   // no direct reads for customers
    await expect(as(a.user, (db) => db.query('SELECT * FROM owner_setup_overview()'))).rejects.toThrow(/platform owner/);
    expect((await call(a.cookie, 'GET', '/api/owner/trials')).statusCode).toBe(403);
  });

  it('refuses values of the wrong type, not just wrong values (a list where a word belongs)', async () => {
    const c = await customer();
    for (const [url, body] of [['/api/setup', { step: ['about'] }], ['/api/setup', { step: { a: 1 } }], ['/api/setup/tour', { page: ['Home'] }], [`/api/companies/${c.companyId}/setup/chart`, { businessType: ['trading'] }]] as const)
      expect((await call(c.cookie, 'POST', url, body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it('the PDF reader checks the company is the caller\'s before sending anything anywhere', async () => {
    process.env.DOC_EXTRACT = 'on'; process.env.ANTHROPIC_API_KEY = 'test-key';
    let sent = 0;
    const s2 = buildServer({ pool: appPool, sessionSecret: 'setup-secret-2', lockCacheMs: 0, extractFetch: async () => { sent++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'submit_rows', input: { rows: [['Name'], ['A']] } }] }) }; } });
    try {
      const a = await customer(), b = await customer();
      const login = async (email: string) => String((await s2.inject({ method: 'POST', url: '/api/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
      const email = (await owner.query(`SELECT email FROM users WHERE firm_id = $1 AND email LIKE 'f.%'`, [a.firm])).rows[0].email;
      const ck = await login(email);
      const body = { kind: 'customers', fileBase64: PDF, fileType: P, consent: true };
      const other = await s2.inject({ method: 'POST', url: `/api/companies/${b.companyId}/import/extract`, headers: { cookie: ck }, payload: body });
      expect([403, 404]).toContain(other.statusCode);
      expect(sent).toBe(0);
      const mine = await s2.inject({ method: 'POST', url: `/api/companies/${a.companyId}/import/extract`, headers: { cookie: ck }, payload: body });
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().rows).toEqual([['Name'], ['A']]);
      expect(sent).toBe(1);
      expect((await owner.query('SELECT extract_used FROM trial_setup WHERE firm_id = $1', [a.firm])).rows[0].extract_used).toBe(1);
    } finally { delete process.env.DOC_EXTRACT; delete process.env.ANTHROPIC_API_KEY; await s2.close(); }
  });

  it('records which page guides were opened, without duplicates, and refuses unknown pages', async () => {
    const c = await customer();
    for (const page of ['Home', 'Sales', 'Sales', 'Reports']) expect((await call(c.cookie, 'POST', '/api/setup/tour', { page })).statusCode).toBe(200);
    expect((await call(c.cookie, 'POST', '/api/setup/tour', { page: "x'; drop table users;--" })).statusCode).toBe(400);
    expect((await call(c.cookie, 'GET', '/api/setup')).json().setup.tourSeen.sort()).toEqual(['Home', 'Reports', 'Sales']);
  });

  it('reading a PDF is switched off, and refuses without the tick, until the owner configures it', async () => {
    const c = await customer();
    const r = await call(c.cookie, 'POST', `/api/companies/${c.companyId}/import/extract`, { kind: 'accounts', fileBase64: PDF, fileType: P, consent: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().key).toBe('err.extractOff');
  });

  it('the owner sees how far each customer got, with counts only', async () => {
    const c = await customer();
    await call(c.cookie, 'POST', '/api/setup', { step: 'data', businessType: 'trading', goals: ['inventory', 'vat'], dataChoice: 'import' });
    await call(c.cookie, 'POST', '/api/setup/tour', { page: 'Sales' });
    const v = (await call(ownerCookie, 'GET', '/api/owner/trials')).json();
    const mine = v.trials.find((t: { firmId: string }) => t.firmId === c.firm);
    expect(mine.setup).toMatchObject({ step: 'data', businessType: 'trading', goals: ['inventory', 'vat'], dataChoice: 'import', completed: false, skipped: false, tourPages: 1, companies: 1 });
    expect(Object.keys(mine.setup).sort()).toEqual(['businessType', 'companies', 'completed', 'contacts', 'dataChoice', 'documents', 'extractUsed', 'goals', 'people', 'skipped', 'step', 'tourPages', 'updatedAt']);
  });
});
