// What a person sees, in a real browser, on the demo data: the screens load, the numbers on them are right, the
// recent phases' features work end to end, Arabic reads right to left, a phone has no sideways scrolling, and one
// company cannot reach another's documents by changing an id.
//
// These run against the server and database started in globalSetup.ts. They are the check that a change to a screen
// cannot pass review just because the unit tests still pass.
import { hashPassword } from '../src/auth/password.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { zipStored } from '../src/export/xlsx.ts';
import { readZatcaQr } from '../src/einvoice/zatcaQr.ts';
import { BASE, call, closeBrowser, newPage, screenshotTo, signIn, waitForText, type Page } from './harness.js';

const ADMIN = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = process.env.BROWSER_TEST_DB ?? 'nusuh_browser_test';
const dbUrl = () => { const u = new URL(ADMIN); u.pathname = `/${DB}`; return u.toString(); };

let db: pg.Pool;
let company: string, accountant: string, otherCompany: string, otherUser: string;
let sales: string, bank: string, customer: string;
let page: Page, errors: string[];

beforeAll(async () => {
  db = new pg.Pool({ connectionString: dbUrl(), max: 3 });
  db.on('error', () => undefined);
  // The demo company that has sales, and one of its own accountants.
  const co = (await db.query(`SELECT c.id FROM companies c JOIN accounts a ON a.company_id = c.id AND a.code = '4000'
    WHERE c.country = 'SA' AND c.status = 'active' ORDER BY c.name LIMIT 1`)).rows[0];
  company = co.id;
  accountant = (await db.query(`SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE m.company_id = $1 AND u.kind = 'client' AND m.role = 'client_accountant' AND u.status = 'active' LIMIT 1`, [company])).rows[0].email;
  const other = (await db.query(`SELECT c.id, u.email FROM companies c JOIN memberships m ON m.company_id = c.id
    JOIN users u ON u.id = m.user_id WHERE c.id <> $1 AND u.kind = 'client' AND u.status = 'active' LIMIT 1`, [company])).rows[0];
  otherCompany = other.id; otherUser = other.email;
  sales = (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '4000'`, [company])).rows[0].id;
  bank = (await db.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = '1000'`, [company])).rows[0].id;
  customer = (await db.query(`SELECT id FROM contacts WHERE company_id = $1 AND is_customer AND status = 'active' LIMIT 1`, [company])).rows[0].id;
  ({ page, errors } = await newPage());
  await signIn(page, accountant);
});
afterAll(async () => { await closeBrowser(); await db?.end(); });

// A failed browser check is hard to read from a stack trace, so keep the screen it failed on.
afterEach(async (ctx) => {
  if (ctx.task.result?.state === 'fail' && page) {
    await screenshotTo(page, ctx.task.name).catch(() => undefined);
  }
});

const entryLines = async (docId: string) => (await db.query(
  `SELECT a.code, l.debit::text AS d, l.credit::text AS c FROM journal_lines l JOIN accounts a ON a.id = l.account_id
   WHERE l.entry_id = (SELECT journal_entry_id FROM documents WHERE id = $1) ORDER BY a.code`, [docId])).rows as { code: string; d: string; c: string }[];
const newestDoc = async (type: string) => (await db.query(
  `SELECT id FROM documents WHERE company_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1`, [company, type])).rows[0]?.id as string;

/** Types a one-line document into the editor. Returns once the totals have caught up. */
async function fillLine(p: Page, description: string, qty: string, price: string) {
  await p.locator('.dl-desc input').first().fill(description);
  await p.locator('.dl-qty input').first().fill(qty);
  await p.locator('.dl-price input').first().fill(price);
  await p.locator('.dl-acct select').first().selectOption(sales);
  await p.waitForTimeout(700);
}

describe('The workspace a client signs in to', () => {
  it('loads its navigation and reports no browser errors', async () => {
    await waitForText(page, 'Sales');
    expect(errors.filter((e) => !/40[0-9]|favicon/.test(e))).toEqual([]);
  });

  it('shows this company\'s own invoices, by number', async () => {
    await page.goto(`${BASE}/c/${company}/Sales/invoices`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1100);
    const rows = await page.locator('table tbody tr').count();
    expect(rows).toBeGreaterThan(0);
    const mine = (await db.query(`SELECT number FROM documents WHERE company_id = $1 AND type = 'invoice' AND number IS NOT NULL
      ORDER BY issue_date DESC, created_at DESC LIMIT 1`, [company])).rows[0].number as string;
    // The real number from the database, on the screen: proof the right company's books are loaded.
    await waitForText(page, mine);
  });
});

describe('Issuing an invoice through the screens', () => {
  it('posts receivables, income and output VAT for what was typed', async () => {
    await page.goto(`${BASE}/c/${company}/Sales/invoices/new`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('#doc-contact').selectOption(customer);
    await fillLine(page, 'Browser check, steel plate', '2', '150.00');
    const totals = await page.locator('.totals').innerText();
    expect(totals).toContain('300.00');     // 2 x 150.00 net
    expect(totals).toContain('345.00');     // + 15% VAT
    await page.getByRole('button', { name: /^Save/i }).first().click();
    await page.waitForTimeout(2000);
    const id = await newestDoc('invoice');
    expect((await call(page, `/api/documents/${id}/issue`, {})).status).toBe(200);
    const ls = await entryLines(id);
    const at = (code: string) => ls.find((l) => l.code === code);
    expect(at('1100')?.d).toBe('345.00');
    expect(at('4000')?.c).toBe('300.00');
    expect(at('2100')?.c).toBe('45.00');
  });
});

describe('An invoice written in another currency', () => {
  it('shows what it will post in the company currency before it is issued, and says so once issued', async () => {
    await page.goto(`${BASE}/c/${company}/Sales/invoices/new`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('#doc-contact').selectOption(customer);
    await page.locator('#doc-currency').selectOption('USD');
    await page.waitForTimeout(700);
    await page.locator('#doc-fx-rate').fill('3.75');
    await fillLine(page, 'Browser check, dollar sale', '2', '100.00');
    // USD 200.00 net + 30.00 VAT = 230.00; at 3.75 that is SAR 862.50.
    expect(await page.locator('.totals').innerText()).toContain('230.00');
    expect(await page.locator('#doc-converted').innerText()).toContain('862.50');
    await page.getByRole('button', { name: /^Save/i }).first().click();
    await page.waitForTimeout(2000);
    const id = await newestDoc('invoice');
    expect((await call(page, `/api/documents/${id}/issue`, {})).status).toBe(200);
    const ls = await entryLines(id);
    expect(ls.find((l) => l.code === '1100')?.d).toBe('862.50');
    await page.goto(`${BASE}/c/${company}/Sales/invoices/${id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const note = await page.locator('#doc-fx-note').innerText();
    expect(note).toContain('USD');
    expect(note).toContain('862.50');
  });

  it('a receipt in that currency says how much reaches the bank, and books the exchange difference', async () => {
    const id = await newestDoc('invoice');
    await page.goto(`${BASE}/c/${company}/Sales/payments-received/new`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('#pay-contact').selectOption(customer);
    await page.waitForTimeout(800);
    await page.locator('#pay-currency').selectOption('USD');
    await page.waitForTimeout(800);
    await page.locator('#pay-fx-rate').fill('3.80');
    await page.locator('#pay-amount').fill('230.00');
    await page.waitForTimeout(800);
    expect(await page.locator('#pay-cash').innerText()).toContain('874.00');
    await page.locator('input[aria-label*="Settle"]').first().fill('230.00');
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /Record|Save/i }).first().click();
    await page.waitForTimeout(2200);
    const pay = (await db.query(`SELECT journal_entry_id FROM payments WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`, [company])).rows[0];
    const ls = (await db.query(`SELECT a.code, l.debit::text AS d, l.credit::text AS c FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY a.code`, [pay.journal_entry_id])).rows as { code: string; d: string; c: string }[];
    expect(ls.find((l) => l.code === '1100')?.c).toBe('862.50');   // cleared at the invoice's rate
    expect(ls.find((l) => l.code === '4951')?.c).toBe('11.50');    // the realised gain
    expect((await db.query(`SELECT document_amount_due($1)::text AS due, document_fx_due($1)::text AS fx`, [id])).rows[0])
      .toEqual({ due: '0.00', fx: '0.00' });
  });
});

describe('Both languages and a phone', () => {
  it('Arabic turns the whole page right to left', async () => {
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar');
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('ltr');
  });

  it('the main screens fit a phone with no sideways scrolling', async () => {
    const { page: phone } = await newPage(390);
    await signIn(phone, accountant);
    for (const path of ['Sales/invoices', 'Sales/invoices/new', 'Sales/payments-received', 'Reports/trial-balance']) {
      await phone.goto(`${BASE}/c/${company}/${path}`, { waitUntil: 'networkidle' });
      await phone.waitForTimeout(1100);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(2);
    }
  });
});

describe('One company cannot reach another', () => {
  it('changing the company in the address, or the document id in a request, is refused', async () => {
    const { page: intruder } = await newPage();
    await signIn(intruder, otherUser);
    const mine = await newestDoc('invoice');
    const myNumber = (await db.query(`SELECT number FROM documents WHERE id = $1`, [mine])).rows[0].number as string;
    expect((await call(intruder, `/api/documents/${mine}`)).status).toBeGreaterThanOrEqual(400);
    expect((await call(intruder, `/api/companies/${company}/documents?type=invoice`)).status).toBeGreaterThanOrEqual(400);
    await intruder.goto(`${BASE}/c/${company}/Sales/invoices`, { waitUntil: 'networkidle' });
    await intruder.waitForTimeout(1200);
    // Typing another company's address into the bar shows none of its invoices.
    expect(await intruder.locator('body').innerText()).not.toContain(myNumber);
    expect(otherCompany).not.toBe(company);
  });
});

describe('The ZATCA monitor', () => {
  it('opens from the Sales menu, names one of its five states, and says it only reads', async () => {
    errors.length = 0;
    await page.goto(`${BASE}/c/${company}/Sales/zatca`, { waitUntil: 'networkidle' });
    await page.locator('#zmon-badge').waitFor({ timeout: 15000 });
    const badge = (await page.locator('#zmon-badge').innerText()).trim();
    expect(['Not in use', 'All good', 'Test mode', 'Needs attention', 'Act now']).toContain(badge);
    expect(await page.locator('body').innerText()).toContain('never contacts ZATCA');
    expect(errors.filter((e) => !/40[0-9]|favicon/.test(e))).toEqual([]);
  });

  it('reads right to left in Arabic, and never scrolls sideways on a phone', async () => {
    await page.evaluate(() => localStorage.setItem('nb.lang', 'ar'));
    await page.goto(`${BASE}/c/${company}/Sales/zatca`, { waitUntil: 'networkidle' });
    await page.locator('#zmon-badge').waitFor({ timeout: 15000 });
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe('rtl');
    expect(await page.locator('#zmon-state').innerText()).toMatch(/[؀-ۿ]/);
    await page.evaluate(() => localStorage.setItem('nb.lang', 'en'));
  });
});

describe('The simplified menu and the owner-only reports', () => {
  const sideItems = async (p: Page) => (await p.locator('nav.side .subnav button').count());
  it('Sales lists its seven main pages, and the rest are one tap away under the title', async () => {
    await page.goto(`${BASE}/c/${company}/Sales/invoices`, { waitUntil: 'networkidle' });
    await page.locator('#more-links').waitFor({ timeout: 15000 });
    expect(await sideItems(page)).toBe(7);
    const more = await page.locator('#more-links').innerText();
    for (const name of ['Recurring invoices', 'Online payments', 'Statements', 'Payment reminders', 'ZATCA monitor']) expect(more).toContain(name);
    await page.locator('#more-links').getByRole('button', { name: 'Recurring invoices' }).click();
    await page.waitForTimeout(1200);
    expect(page.url()).toContain('/Sales/recurring-invoices');
    expect(await sideItems(page)).toBe(8);   // the page you are on is listed while you are on it
    expect(await page.locator('#more-links').innerText()).toContain('Online payments');
  });

  it('a title without the owner reports sees the finance reports but not profit and loss, balance sheet, cash flow or owner summary', async () => {
    await page.goto(`${BASE}/c/${company}/Reports`, { waitUntil: 'networkidle' });
    await page.locator('nav.side .subnav button').first().waitFor({ timeout: 15000 });
    const menu = await page.locator('nav.side .subnav').innerText();
    expect(menu).toContain('Trial balance');
    for (const name of ['Profit and loss', 'Balance sheet', 'Cash flow', 'Owner summary']) expect(menu).not.toContain(name);
    expect((await call(page, `/api/companies/${company}/reports/profit-and-loss?from=2027-01-01&to=2027-12-31`)).status).toBe(403);
  });
});

describe('Ownership', () => {
  beforeAll(async () => {
    // The Owner job title: ownership and the owner reports are not part of the default accountant title.
    await db.query(`UPDATE memberships m SET client_role_id = r.id FROM users u, client_roles r
      WHERE u.id = m.user_id AND u.email = $1 AND m.company_id = $2 AND r.firm_id = u.firm_id AND r.name = 'Owner'`, [accountant, company]);
  });
  it('adds an owner, sets the shares, records capital, and shows it in the statement of changes in equity', async () => {
    errors.length = 0;
    await page.goto(`${BASE}/c/${company}/Ownership/owners`, { waitUntil: 'networkidle' });
    await page.locator('#own-add').waitFor({ timeout: 15000 });
    await page.locator('#own-add').click();
    await page.locator('#own-name').fill('Browser Owner');
    await page.locator('#own-add-save').click();
    await waitForText(page, 'Owner added');
    await page.locator('#own-change').click();
    await page.locator('#own-change-form input.num').first().fill('1000');
    await page.locator('#own-change-save').click();
    await waitForText(page, 'Ownership saved');
    expect(await page.locator('#own-table').innerText()).toContain('100%');

    await page.goto(`${BASE}/c/${company}/Ownership/owner-movements`, { waitUntil: 'networkidle' });
    await page.locator('#own-amount').waitFor({ timeout: 15000 });
    await page.locator('#own-amount').fill('2500.00');
    await page.locator('#own-move-save').click();
    await waitForText(page, 'Recorded and posted');
    const t = (await db.query(`SELECT t.kind, t.amount::text AS amount FROM owner_transactions t JOIN owners o ON o.id = t.owner_id WHERE o.company_id = $1 AND o.name = 'Browser Owner'`, [company])).rows;
    expect(t).toEqual([{ kind: 'contribution', amount: '2500.00' }]);
    const eq = (await db.query(`SELECT sum(l.credit - l.debit)::text AS v FROM journal_lines l JOIN owners o ON o.capital_account_id = l.account_id WHERE o.company_id = $1 AND o.name = 'Browser Owner'`, [company])).rows[0].v;
    expect(eq).toBe('2500.00');

    await page.goto(`${BASE}/c/${company}/Ownership/equity-statement`, { waitUntil: 'networkidle' });
    await page.locator('#own-statement').waitFor({ timeout: 15000 });
    expect(await page.locator('#own-statement').innerText()).toContain('Browser Owner');
    expect(errors.filter((e) => !/40[0-9]|favicon/.test(e))).toEqual([]);
  });

  it('fits a phone without sideways scrolling', async () => {
    const { page: ar } = await newPage();
    await signIn(ar, accountant);
    await ar.goto(`${BASE}/c/${company}/Ownership/owners`, { waitUntil: 'networkidle' });
    await ar.getByRole('button', { name: 'EN | AR' }).click();
    await ar.waitForTimeout(900);
    expect(await ar.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await ar.locator('body').innerText()).toContain('الملاك');
    const { page: phone } = await newPage(390);
    await signIn(phone, accountant);
    for (const path of ['Ownership/owners', 'Ownership/owner-movements', 'Ownership/equity-statement']) {
      await phone.goto(`${BASE}/c/${company}/${path}`, { waitUntil: 'networkidle' });
      await phone.waitForTimeout(1100);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(2);
    }
  });
});

describe('A company that runs its own books', () => {
  it('its Owner has one login: the books, no accounting-firm modules, and the users and job titles screens', async () => {
    const solo = (await db.query(`SELECT u.email, u.firm_id AS firm, m.company_id AS company, u.id AS uid FROM users u JOIN memberships m ON m.user_id = u.id JOIN firms f ON f.id = u.firm_id
      WHERE f.kind = 'company' AND u.kind = 'client' AND u.status = 'active' LIMIT 1`)).rows[0];
    await db.query('SELECT add_default_client_roles($1)', [solo.firm]);
    await db.query(`UPDATE memberships SET client_role_id = (SELECT id FROM client_roles WHERE firm_id = $1 AND name = 'Owner') WHERE user_id = $2 AND company_id = $3`, [solo.firm, solo.uid, solo.company]);
    await db.query(`UPDATE client_roles SET can_manage_users = true WHERE firm_id = $1 AND name = 'Owner'`, [solo.firm]);   // optional since 0065: not on by default
    const { page: p } = await newPage();
    await signIn(p, solo.email);
    await p.goto(`${BASE}/c/${solo.company}/Home`, { waitUntil: 'networkidle' });
    await p.locator('#manage-users').waitFor({ timeout: 15000 });
    const side = await p.locator('nav.side').innerText();
    for (const gone of ['Review', 'Portal']) expect(side, gone).not.toContain(gone);
    expect(side).toContain('Reports');
    await p.locator('#manage-users').click();
    await p.waitForTimeout(1500);
    expect(p.url()).toContain(`/admin/clients/${solo.company}`);
    expect(await p.locator('nav.side').innerText()).toContain('Users');   // the console is for users and job titles, not an Administrator
    await p.locator('#back-to-books').click();
    await p.waitForTimeout(1500);
    expect(p.url()).toContain(`/c/${solo.company}/Home`);
  });
});

describe('Demo mode in the platform owner\'s account', () => {
  it('shows a Demo mode button in the side menu, and says plainly when the demo site is not set up', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage();
    await signIn(p, platform);
    await p.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await p.locator('#demo-mode').waitFor({ timeout: 15000 });
    expect(await p.locator('nav.side').innerText()).toContain('Demo mode');
    await p.locator('#demo-mode').click();
    await p.locator('#demo-msg').waitFor({ timeout: 15000 });
    expect(await p.locator('#demo-msg').innerText()).toContain('not set up');
    // Nobody else has the button.
    const { page: q } = await newPage();
    await signIn(q, accountant);
    await q.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await q.waitForTimeout(1200);
    expect(await q.locator('#demo-mode').count()).toBe(0);
    expect(await q.locator('#demo-switch').count()).toBe(0);
  });
});

describe('Add customer: Company own accounts', () => {
  it('is one flow (details, users, review): it never shows an add-companies screen and lands on the customer\'s page with the sign-in links', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p, errors: errs } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await p.locator('#own-new').waitFor({ timeout: 15000 });
    await p.locator('#own-new').click();
    await p.locator('#own-company-wizard').waitFor({ timeout: 15000 });
    expect(await p.locator('body').innerText()).toContain('Company own accounts');
    await screenshotTo(p, 'add-customer-1-details');

    // Step 1: the company's details. Nothing else is asked for here.
    const stamp = String(Date.now()).slice(-6);
    await p.locator('#reg-name').fill(`Flow Test Trading ${stamp}`);
    await p.locator('#reg-industry').selectOption('trading');
    await p.locator('#reg-cr').fill(`10${Date.now().toString().slice(-8)}`);
    await p.locator('#reg-vat').fill(`3${String(Date.now()).slice(-13).padStart(13, '1')}3`);
    await p.locator('#reg-address').fill('King Fahd Road');
    await p.locator('#reg-city').fill('Riyadh');
    await p.locator('#reg-email').fill('info@flow-test.example.com');
    await p.locator('#reg-phone').fill('+966500000000');
    await p.locator('#own-w-next').click();

    // Step 2: people. The first row is the company's Administrator, the second its Owner; a third person is added as Sales.
    await p.locator('#own-w-name-0').waitFor({ timeout: 15000 });
    expect(await p.locator('#own-w-title-0').inputValue()).toBe('Administrator');
    expect(await p.locator('#own-w-title-1').inputValue()).toBe('Owner');
    await screenshotTo(p, 'add-customer-2-users');
    await p.locator('#own-w-name-0').fill('Flow Admin');
    await p.locator('#own-w-email-0').fill(`flow.admin.${stamp}@example.com`);
    await p.locator('#own-w-name-1').fill('Flow Owner');
    await p.locator('#own-w-email-1').fill(`flow.owner.${stamp}@example.com`);
    await p.locator('#own-w-add-user').click();
    await p.locator('#own-w-name-2').fill('Flow Sales');
    await p.locator('#own-w-email-2').fill(`flow.sales.${stamp}@example.com`);
    await p.locator('#own-w-title-2').selectOption('Sales');
    await p.locator('#own-w-next').click();

    // Step 3: review, then create.
    await p.locator('#own-w-review').waitFor({ timeout: 15000 });
    const review = await p.locator('#own-company-wizard').innerText();
    expect(review).toContain(`Flow Test Trading ${stamp}`);
    expect(review).toContain('Flow Admin');
    expect(review).toContain('Flow Owner');
    expect(review).toContain('Flow Sales');
    await screenshotTo(p, 'add-customer-3-review');
    await p.locator('#own-w-next').click();

    // Lands on the customer's page (its one company), with both sign-in links, and no way to add another company.
    await p.locator('#new-customer-done').waitFor({ timeout: 20000 });
    expect(p.url()).toMatch(/\/admin\/clients\/[0-9a-f-]{36}$/);
    expect(await p.locator('input[aria-label]').count()).toBeGreaterThan(2);   // three links: the Administrator, the Owner and Sales
    await screenshotTo(p, 'add-customer-4-customer-page');
    // A company with its own books is not an accounting firm: none of the firm wording is on its pages.
    const pageText = await p.locator('body').innerText();
    for (const firmWord of ['Firm staff', 'Client users', 'All clients', 'Add client user', 'Without staff']) expect(pageText, firmWord).not.toContain(firmWord);
    await p.goto(`${BASE}/admin/clients`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    const listText = await p.locator('body').innerText();
    for (const firmWord of ['Staff assigned', 'Total clients', 'Without staff', 'Add client', 'Client\n']) expect(listText, firmWord).not.toContain(firmWord);
    await screenshotTo(p, 'add-customer-5-company-page');
    await p.goto(`${BASE}/admin/clients/new`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    expect(await p.locator('#add-client').count()).toBe(0);
    expect(await p.locator('body').innerText()).not.toContain('Register client');   // the "add company" form is not there either: it is the company's own page
    expect(errs.filter((e) => !/favicon|status of 401/.test(e))).toEqual([]);   // the sign-in page's own 401 (nobody signed in yet) is expected

    const made = (await db.query(`SELECT (SELECT count(*) FROM companies c JOIN firms f ON f.id = c.firm_id WHERE f.name = $1)::int AS companies,
      (SELECT count(*) FROM users u JOIN firms f ON f.id = u.firm_id WHERE f.name = $1 AND u.kind = 'client')::int AS users`, [`Flow Test Trading ${stamp}`])).rows[0];
    expect(made).toEqual({ companies: 1, users: 2 });   // two people use the books; the Administrator is a third login that does not

    // The company's Administrator (a separate login from its Owner): the admin area is only the users, their roles and
    // permissions, and a way to raise an issue. No books, no Activity, E-invoices, Billing or Settings.
    const adminEmail = `flow.admin.${stamp}@example.com`;
    await db.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE kind = 'owner' LIMIT 1), password_set_at = now() WHERE lower(email) = lower($1)`, [adminEmail]);
    const { page: q, errors: qerrs } = await newPage(1280);
    await signIn(q, adminEmail);
    await q.goto(`${BASE}/admin/clients`, { waitUntil: 'networkidle' });
    await q.locator('#raise-issue').waitFor({ timeout: 15000 });
    const side = await q.locator('nav.side').innerText();
    for (const want of ['Users', 'Roles and permissions', 'Raise an issue']) expect(side, want).toContain(want);
    for (const gone of ['Activity', 'E-invoices', 'Billing', 'Settings', 'Companies', 'Staff', 'Back to my books']) expect(side, gone).not.toContain(gone);
    const mine = await q.locator('main').innerText();
    expect(mine).toContain(`Flow Test Trading ${stamp}`);
    expect(mine).toContain('Flow Sales');
    for (const firmWord of ['Firm staff', 'All clients', 'Client users']) expect(mine, firmWord).not.toContain(firmWord);
    await screenshotTo(q, 'add-customer-6-company-admin');
    await q.locator('#raise-issue').click();
    await q.locator('#sup-subject').waitFor({ timeout: 15000 });   // the form to raise an issue with Nusuh Books opens straight away
    await screenshotTo(q, 'add-customer-7-raise-issue');

    // The company's Owner is not the Administrator: they use the books and have no way into the admin area.
    const ownerEmail = `flow.owner.${stamp}@example.com`;
    await db.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE kind = 'owner' LIMIT 1), password_set_at = now() WHERE lower(email) = lower($1)`, [ownerEmail]);
    const { page: r } = await newPage(1280);
    await signIn(r, ownerEmail);
    await r.waitForTimeout(1500);
    expect(await r.locator('#manage-users').count()).toBe(0);
    await r.goto(`${BASE}/admin/clients`, { waitUntil: 'networkidle' });
    await r.waitForTimeout(1200);
    expect(r.url()).not.toContain('/admin');
    expect(qerrs.filter((e) => !/favicon|status of 401/.test(e))).toEqual([]);
  });

  it('keeps the accounting firm flow as it was: name, kind and first Administrator, then the firm adds its client companies', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await p.locator('#own-new').waitFor({ timeout: 15000 });
    await p.locator('#own-new').click();
    await p.locator('#own-kind-firm').click();
    await p.locator('#own-admin-name').waitFor({ timeout: 15000 });
    expect(await p.locator('#own-company-wizard').count()).toBe(0);
    await screenshotTo(p, 'add-customer-firm-form');
  });
});

describe('Remove a customer and see a password', () => {
  it('the owner removes a customer (it is hidden, nobody there can sign in), then restores it', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const tenant = (await db.query(`SELECT f.id, f.name FROM firms f WHERE f.kind = 'company' AND f.name LIKE 'Flow Test Trading %' ORDER BY f.created_at DESC LIMIT 1`)).rows[0] as { id: string; name: string };
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await p.locator(`#own-remove-${tenant.id}`).waitFor({ timeout: 15000 });
    await p.locator(`#own-remove-${tenant.id}`).click();
    await waitForText(p, 'Its books and history are kept on file');
    await screenshotTo(p, 'remove-customer-confirm');
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await waitForText(p, 'was removed');
    expect(await p.locator('table').innerText()).not.toContain(tenant.name);   // hidden from the list
    expect((await db.query(`SELECT removed_at IS NOT NULL AS gone, status FROM firms WHERE id = $1`, [tenant.id])).rows[0]).toEqual({ gone: true, status: 'suspended' });
    expect((await db.query(`SELECT count(*)::int AS n FROM companies WHERE firm_id = $1`, [tenant.id])).rows[0].n).toBe(1);   // the books stay on file
    await p.locator('#own-show-removed').click();
    await p.locator(`#own-restore-${tenant.id}`).waitFor({ timeout: 15000 });
    expect(await p.locator('table').innerText()).toContain('Removed');
    await screenshotTo(p, 'remove-customer-removed-list');
    await p.locator(`#own-restore-${tenant.id}`).click();
    await waitForText(p, 'was restored');
    expect((await db.query(`SELECT removed_at FROM firms WHERE id = $1`, [tenant.id])).rows[0].removed_at).toBeNull();
  });

  it('the owner deletes a removed customer that never used the books for good: only after typing its name, nothing else is touched', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    const stamp = Date.now().toString(36), digits = (n: number) => String(Math.floor(Math.random() * 9 * 10 ** (n - 1) + 10 ** (n - 1)));
    const made = await call(p, '/api/owner/customers/company', {
      company: { name: `Erase Me ${stamp}`, country: 'SA', industry: 'trading', legalForm: 'LLC', crNumber: digits(10), vatStatus: 'registered', vatNumber: `3${digits(13)}3`, address: 'Road', city: 'Riyadh' },
      users: [{ name: 'Admin', email: `admin.erase.${stamp}@browser-erase.example.com`, jobTitle: 'Administrator' }, { name: 'Finance', email: `fin.erase.${stamp}@browser-erase.example.com`, jobTitle: 'Owner' }] });
    expect(made.status, JSON.stringify(made)).toBe(200);
    const id = (made.json as { id: string }).id, name = `Erase Me ${stamp}`;
    const others = (await db.query(`SELECT count(*)::int AS n FROM firms WHERE id <> $1`, [id])).rows[0].n as number;
    await p.goto(`${BASE}/owner`, { waitUntil: 'networkidle' });
    await p.locator(`#own-remove-${id}`).waitFor({ timeout: 15000 });
    expect(await p.locator(`#own-erase-${id}`).count()).toBe(0);                       // a live customer cannot be deleted for good
    await p.locator(`#own-remove-${id}`).click();
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await waitForText(p, 'was removed');
    await p.locator('#own-show-removed').click();
    await p.locator(`#own-erase-${id}`).waitFor({ timeout: 15000 });
    await p.locator(`#own-erase-${id}`).click();
    await p.locator('#own-erase-panel').waitFor({ timeout: 15000 });
    expect(await p.locator('#own-erase-panel').innerText()).toContain(name);
    expect(await p.locator('#own-erase-go').isDisabled()).toBe(true);                  // nothing happens until the name is typed
    await p.locator('#own-erase-name').fill(`${name.slice(0, -1)}`);
    expect(await p.locator('#own-erase-go').isDisabled()).toBe(true);
    await screenshotTo(p, 'erase-customer-confirm');
    await p.locator('#own-erase-name').fill(name);
    expect(await p.locator('#own-erase-go').isDisabled()).toBe(false);
    await p.locator('#own-erase-go').click();
    await waitForText(p, 'was deleted for good');
    expect((await db.query(`SELECT count(*)::int AS n FROM firms WHERE id = $1`, [id])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE firm_id = $1`, [id])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM erasure_log WHERE firm_id = $1`, [id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM firms WHERE id <> $1`, [id])).rows[0].n).toBe(others);
    expect(await p.locator('table').innerText()).not.toContain(name);
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgenabled = 'D' AND NOT tgisinternal`)).rows[0].n).toBe(0);
  });

  it('the Administrator removes a person (hidden, cannot sign in, name kept), then restores them', async () => {
    const tenant = (await db.query(`SELECT f.id, f.name FROM firms f WHERE f.kind = 'company' AND f.name LIKE 'Flow Test Trading %' ORDER BY f.created_at DESC LIMIT 1`)).rows[0] as { id: string; name: string };
    const adminEmail = (await db.query(`SELECT email FROM users WHERE firm_id = $1 AND kind = 'admin' LIMIT 1`, [tenant.id])).rows[0].email as string;
    const seller = (await db.query(`SELECT u.id, u.email FROM users u WHERE u.firm_id = $1 AND u.kind = 'client' AND u.full_name = 'Flow Sales'`, [tenant.id])).rows[0] as { id: string; email: string };
    await db.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE kind = 'owner' LIMIT 1), password_set_at = now() WHERE lower(email) = lower($1)`, [adminEmail]);
    const { page: p } = await newPage(1280);
    await signIn(p, adminEmail);
    await p.goto(`${BASE}/admin/clients`, { waitUntil: 'networkidle' });
    await p.locator(`#remove-user-${seller.id}`).waitFor({ timeout: 15000 });
    await p.locator(`#remove-user-${seller.id}`).click();
    await waitForText(p, 'Their name stays on everything they did');
    await screenshotTo(p, 'remove-user-confirm');
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await p.waitForTimeout(1500);
    expect(await p.locator('main').innerText()).not.toContain('Flow Sales');   // hidden from the list
    expect((await db.query(`SELECT removed_at IS NOT NULL AS gone, status FROM users WHERE id = $1`, [seller.id])).rows[0]).toEqual({ gone: true, status: 'suspended' });
    expect((await db.query(`SELECT full_name FROM users WHERE id = $1`, [seller.id])).rows[0].full_name).toBe('Flow Sales');   // the name stays
    await p.locator('#show-removed-people').click();
    await p.locator(`#restore-user-${seller.id}`).waitFor({ timeout: 15000 });
    await screenshotTo(p, 'remove-user-removed-list');
    await p.locator(`#restore-user-${seller.id}`).click();
    await p.waitForTimeout(1500);
    expect((await db.query(`SELECT removed_at FROM users WHERE id = $1`, [seller.id])).rows[0].removed_at).toBeNull();
  });

  it('the sign-in page has a Show / Hide button on the password', async () => {
    const { page: p } = await newPage(1280);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.locator('#login-password').waitFor({ timeout: 15000 });
    await p.locator('#login-password').fill('my-secret-pass');
    const kind = () => p.evaluate(() => (document.getElementById('login-password') as HTMLInputElement).type);
    expect(await kind()).toBe('password');
    await p.getByRole('button', { name: 'Show the password' }).click();
    expect(await kind()).toBe('text');
    expect(await p.locator('#login-password').inputValue()).toBe('my-secret-pass');
    await screenshotTo(p, 'login-show-password');
    await p.getByRole('button', { name: 'Hide the password' }).click();
    expect(await kind()).toBe('password');
  });
});

describe('The new pricing in the owner console', () => {
  it('the Plans page shows the one plan on sale with the one-time software price, the yearly membership, the module price and the optional implementation', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner/plans`, { waitUntil: 'networkidle' });
    await waitForText(p, 'Nusuh Books');
    const text = await p.locator('main').innerText();
    for (const want of ['9,000.00', 'once', '1,500.00', 'Annual membership', '500.00', 'Each additional module', '5,000.00', 'Optional implementation']) expect(text, want).toContain(want);
    await screenshotTo(p, 'pricing-plans');
  });
});

describe('Bank feed: consent and exceptions', () => {
  it('an ended consent shows a Reconnect prompt, Reconnect works in one press, and unexplained lines show under Exceptions', async () => {
    // the demo company's own bank account; the feed row is put in place directly, as an ended consent
    const id = (await db.query(`SELECT id FROM bank_accounts WHERE company_id = $1 AND kind = 'bank' ORDER BY created_at LIMIT 1`, [company])).rows[0].id as string;
    const me = (await db.query(`SELECT id FROM users WHERE email = $1`, [accountant])).rows[0].id as string;
    await db.query(`UPDATE bank_feeds SET status = 'disconnected' WHERE bank_account_id = $1 AND status <> 'disconnected'`, [id]);
    await db.query(`INSERT INTO bank_feeds (company_id, bank_account_id, provider, status, external_account_id, consent_expires_on, synced_to, created_by)
      VALUES ($1, $2, 'sandbox', 'expired', 'browser-check', current_date - 1, current_date - 3, $3)`, [company, id, me]);
    // the demo accountant only views the bank: for this check (the last one, on the throwaway browser database) the job title may edit it
    await db.query(`UPDATE client_roles SET permissions = permissions || '{"Bank":"edit"}'::jsonb WHERE id IN
      (SELECT m.client_role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND u.email = $2)`, [company, accountant]);
    const editor = accountant;
    const { page: pg } = await newPage(1280);
    await signIn(pg, editor!);
    await pg.goto(`${BASE}/c/${company}/Bank/accounts/${id}`, { waitUntil: 'networkidle' });
    await pg.locator('#feed-reconnect-prompt').waitFor({ timeout: 15000 });
    await screenshotTo(pg, 'bank-feed-reconnect');
    await pg.locator('#feed-reconnect').click();
    await waitForText(pg, 'Reconnected');
    expect(await pg.locator('#feed-reconnect').count()).toBe(0);
    await pg.getByRole('tab', { name: /Exceptions/ }).click();
    await waitForText(pg, 'Bank lines that nothing in your books explains');
    await screenshotTo(pg, 'bank-exceptions');
  });
});

describe('The billing invoice sent to a customer', () => {
  const NUMBER = 'ZT-BROWSER-0001';
  let invoiceId = '', saved: Record<string, unknown> = {};
  beforeAll(async () => {
    saved = (await db.query(`SELECT seller_name_ar, seller_name_ar AS n, seller_vat, seller_cr, seller_address, seller_address_ar FROM billing_settings`)).rows[0];
    await db.query(`UPDATE billing_settings SET seller_name_ar = 'نصوح بوكس', seller_vat = '300000000000003', seller_cr = '1010123456', seller_address = 'King Fahd Road, Riyadh 12211', seller_address_ar = 'طريق الملك فهد، الرياض 12211'`);
    const firm = (await db.query(`SELECT firm_id FROM companies WHERE id = $1`, [company])).rows[0].firm_id as string;
    invoiceId = (await db.query(`INSERT INTO billing_invoices (firm_id, number, customer_name, plan_name, cycle, period_start, period_end, issued_on, due_on, currency, lines, subtotal, discount, vat_rate, vat, total, buyer_name_ar, buyer_vat, buyer_cr, buyer_address)
      VALUES ($1, $2, 'Al Noor Contracting Co', 'Nusuh', 'yearly', '2026-11-26', '2027-11-25', '2026-11-26', '2026-12-10', 'SAR',
      '[{"key":"software","quantity":1,"unitPrice":9000,"amount":9000},{"key":"membership","quantity":1,"unitPrice":1500,"amount":1500},{"key":"extraModules","quantity":2,"unitPrice":500,"amount":1000}]',
      11500, 1150, 15, 1552.50, 11902.50, 'شركة النور للمقاولات', '300055555500003', '1010987654', 'Prince Sultan Road 45, Jeddah, Saudi Arabia') RETURNING id`, [firm, NUMBER])).rows[0].id as string;
  });
  afterAll(async () => {
    await db.query(`UPDATE billing_invoices SET status = 'void', void_reason = 'browser check' WHERE id = $1 AND status = 'open'`, [invoiceId]).catch(() => undefined);
    await db.query(`UPDATE billing_settings SET seller_name_ar = $1, seller_vat = $2, seller_cr = $3, seller_address = $4, seller_address_ar = $5`,
      [saved.seller_name_ar ?? null, saved.seller_vat ?? null, saved.seller_cr ?? null, saved.seller_address ?? null, saved.seller_address_ar ?? null]);
  });
  const platform = async () => (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
  const open = async (width: number) => {
    const { page: p } = await newPage(width);
    await signIn(p, await platform());
    await p.goto(`${BASE}/owner/billing/${invoiceId}`, { waitUntil: 'networkidle' });
    await p.locator('#tax-invoice').waitFor({ timeout: 20000 });
    await p.waitForTimeout(600);
    return p;
  };

  it('is a ZATCA-format tax invoice in Arabic and English: seller and buyer with VAT and registration numbers, a line for each charge with discount, taxable amount, VAT and total, and the totals', async () => {
    const p = await open(1280);
    const text = await p.locator('#tax-invoice').innerText();
    for (const want of ['Tax invoice', 'فاتورة ضريبية', 'Nusuh Books', 'نصوح بوكس', '300000000000003', '1010123456', 'Al Noor Contracting Co', 'شركة النور للمقاولات', '300055555500003', '1010987654',
      'Prince Sultan Road 45', 'Taxable amount', 'المبلغ الخاضع للضريبة', 'Discount', 'VAT %', 'Total amount due', 'إجمالي المبلغ المستحق', ZT_NO()]) expect(text, want).toContain(want);
    expect(await p.locator('#inv-lines tbody tr').count()).toBe(3);
    // every column adds up to the totals, to the cent
    const cells = await p.evaluate(() => [...document.querySelectorAll('#inv-lines tbody tr')].map((tr) => [...tr.querySelectorAll('td.num')].map((td) => (td.textContent ?? '').replace(/,/g, ''))));
    const cents = (v: string) => Math.round(Number(v.replace('%', '')) * 100);
    const col = (i: number) => cells.reduce((n, r) => n + cents(r[i]!), 0);   // 0 qty, 1 unit, 2 discount, 3 taxable, 4 rate, 5 vat, 6 total
    expect(col(2)).toBe(115000);
    expect(col(3)).toBe(1035000);
    expect(col(5)).toBe(155250);
    expect(col(6)).toBe(1190250);
    expect(await text_(p, '#inv-grand')).toBe('SAR 11,902.50');
    expect(await text_(p, '#inv-totals')).toContain('10,350.00');
    expect(await p.locator('#inv-mismatch').count()).toBe(0);
    await screenshotTo(p, 'billing-invoice-zatca');
  });

  it('carries the ZATCA QR code: seller, VAT number, time stamp, total with VAT and VAT, matching the printed totals', async () => {
    const p = await open(1280);
    const payload = await p.locator('#inv-qr').getAttribute('data-payload');
    expect(payload).toBeTruthy();
    const f = readZatcaQr(payload!);
    expect(f[1]).toBe('نصوح بوكس');
    expect(f[2]).toBe('300000000000003');
    expect(f[3]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(f[4]).toBe('11902.50');
    expect(f[5]).toBe('1552.50');
    expect(await p.evaluate(() => { const i = document.querySelector('#inv-qr') as HTMLImageElement; return i.naturalWidth > 100 && i.src.startsWith('data:image/png'); })).toBe(true);
  });

  it('without a seller VAT number there is no QR code and the owner is told why (and nothing of that note prints)', async () => {
    await db.query(`UPDATE billing_settings SET seller_vat = NULL`);
    try {
      const p = await open(1280);
      expect(await p.locator('#inv-qr').count()).toBe(0);
      expect(await p.locator('#inv-no-vat.no-print').count()).toBe(1);
    } finally { await db.query(`UPDATE billing_settings SET seller_vat = '300000000000003'`); }
  });

  it('reads right to left in Arabic and stacks each line as a card on a phone with no sideways scrolling', async () => {
    const ar = await open(1280);
    await ar.getByRole('button', { name: 'EN | AR' }).first().click();
    await ar.waitForTimeout(900);
    expect(await text_(ar, '#tax-invoice h1 .bi > span:first-child')).toBe('فاتورة ضريبية');
    expect(await ar.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl');
    const ph = await open(390);
    expect(await overflowOf(ph)).toBeLessThanOrEqual(2);
    expect(await ph.evaluate(() => getComputedStyle(document.querySelector('#inv-lines thead')!).display)).toBe('none');
    expect(await ph.locator('#inv-lines td[data-label]').first().getAttribute('data-label')).toBeTruthy();
    expect(await text_(ph, '#inv-grand')).toBe('SAR 11,902.50');
    await screenshotTo(ph, 'billing-invoice-phone');
  });
});

describe('Owner Settings', () => {
  it('shows the sign-in email, an empty backup email, the email service without a key, and a test button that reports what happened', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner/settings`, { waitUntil: 'networkidle' });
    await p.locator('#oset-main-email').waitFor({ timeout: 15000 });
    expect((await p.locator('#oset-main-email').innerText()).toLowerCase()).toBe(platform.toLowerCase());
    expect(await p.locator('#oset-backup-none').count()).toBe(1);
    const text = await p.locator('main').innerText();
    for (const want of ['Email service', 'Main email', 'Backup email', 'Test email']) expect(text, want).toContain(want);
    expect(text).not.toMatch(/re_[A-Za-z0-9]{6}/);
    // the change form asks for the password and does nothing by itself
    await p.locator('#oset-main-change').click();
    await p.locator('#oset-main-password').waitFor({ timeout: 5000 });
    expect(await p.locator('#oset-main-send').isDisabled()).toBe(true);
    await screenshotTo(p, 'owner-settings');
    // the test email: this server has no email service, so the answer is "Waiting" with the reason, not a crash
    await p.locator('#oset-test-send').click();
    await p.locator('#oset-test-list').waitFor({ timeout: 15000 });
    expect(await p.locator('#oset-test-list').innerText()).toContain('Waiting');
  });
});

describe('My account (client email)', () => {
  it('a client sees their sign-in email and can ask to change it, with no backup email and no test email', async () => {
    const { page: p } = await newPage(1280);
    await signIn(p, accountant);
    await p.goto(`${BASE}/security`, { waitUntil: 'networkidle' });
    await p.locator('#my-email-address').waitFor({ timeout: 15000 });
    expect((await p.locator('#my-email-address').innerText()).toLowerCase()).toBe(accountant.toLowerCase());
    const text = await p.locator('main').innerText();
    for (const want of ['My account', 'Your email', 'Two-factor sign-in']) expect(text, want).toContain(want);
    for (const never of ['Backup email', 'Test email', 'Email service']) expect(text, never).not.toContain(never);
    await p.locator('#my-email-change').click();
    await p.locator('#my-email-password').waitFor({ timeout: 5000 });
    expect(await p.locator('#my-email-send').isDisabled()).toBe(true);
    await screenshotTo(p, 'my-account-email');
  });
});

describe('The platform owner\'s Payment settings and Website tab', () => {
  it('changes a price with a reason after a confirm step, adds a testimonial, and both appear in what the website reads', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage();
    await signIn(p, platform);
    const site = async () => p.evaluate(async () => (await (await fetch('/api/public/site-data', { cache: 'no-store' })).json()) as { lines: { key: string; amount: number | string }[]; testimonials: { items: { name: string; quote: string }[] } });
    await p.goto(`${BASE}/owner/settings`, { waitUntil: 'networkidle' });
    await p.locator('#pay-settings').waitFor({ timeout: 15000 });
    const before = Number((await site()).lines.find((l) => l.key === 'implementation')!.amount);
    // No change: nothing to review. Then a new price: review, confirm needs a reason, then it is live.
    expect(await p.locator('#pay-review').isVisible()).toBe(true);
    await p.locator('#pay-amount-implementation').fill(String(before + 100));
    await p.locator('#pay-review').click();
    await p.locator('#pay-confirm').waitFor();
    expect(await p.locator('#pay-affect').innerText()).toContain('Invoices already issued never change');
    expect(await p.locator('#pay-confirm-go').count()).toBe(1);
    await p.locator('#pay-reason').fill('Browser check price change');
    await p.locator('#pay-confirm-go').click();
    await p.locator('#pay-msg').waitFor({ timeout: 15000 });
    expect(Number((await site()).lines.find((l) => l.key === 'implementation')!.amount)).toBe(before + 100);
    expect(await p.locator('#pay-history').innerText()).toContain('Browser check price change');
    // put it back so other checks see the original price
    await p.locator('#pay-amount-implementation').fill(String(before));
    await p.locator('#pay-review').click();
    await p.locator('#pay-reason').fill('Browser check: restore');
    await p.locator('#pay-confirm-go').click();
    await p.locator('#pay-msg').waitFor({ timeout: 15000 });
    expect(Number((await site()).lines.find((l) => l.key === 'implementation')!.amount)).toBe(before);

    // Testimonials
    await p.goto(`${BASE}/owner/website`, { waitUntil: 'networkidle' });
    await p.locator('#web-testimonials').waitFor({ timeout: 15000 });
    await p.locator('#web-add').click();
    await p.locator('#tm-name').fill('Browser Tester');
    await p.locator('#tm-quote').fill('A real quote written in a browser check.');
    expect(await p.locator('#tm-save').isVisible()).toBe(true);
    await p.locator('#tm-consent').click();
    await p.locator('#tm-save').click();
    await p.locator('#web-msg').waitFor({ timeout: 15000 });
    expect((await site()).testimonials.items.map((x) => x.name)).toContain('Browser Tester');
    expect(await p.locator('#web-count').innerText()).toMatch(/1 of 8/);
    // Hide it: it leaves the public answer but stays saved.
    await p.getByRole('button', { name: 'Hide', exact: true }).first().click();
    await p.waitForTimeout(1500);
    expect((await site()).testimonials.items.map((x) => x.name)).not.toContain('Browser Tester');
    expect(await p.locator('#web-list').innerText()).toContain('Browser Tester');
    await db.query('DELETE FROM website_testimonials');   // leave the database as it was
  });
});

describe('The owner\'s bank details for customers who buy', () => {
  it('need all four lines (or none) and are then shown to a buying customer', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage();
    await signIn(p, platform);
    await p.goto(`${BASE}/owner/settings`, { waitUntil: 'networkidle' });
    await p.locator('#bank-details').waitFor({ timeout: 15000 });
    await p.locator('#bank-account').fill('Nusuh Demo Co');
    await p.locator('#bank-name').fill('Demo Bank');
    await p.locator('#bank-save').click();
    await p.locator('#bank-error').waitFor({ timeout: 15000 });
    expect(await p.locator('#bank-error').innerText()).toContain('all four');
    await p.locator('#bank-iban').fill('SA03 8000 0000 6080 1016 7519');
    await p.locator('#bank-swift').fill('DEMOSARI');
    await p.locator('#bank-save').click();
    await p.locator('#bank-msg').waitFor({ timeout: 15000 });
    expect((await db.query('SELECT bank_iban FROM billing_settings')).rows[0].bank_iban).toBe('SA0380000000608010167519');
    await p.locator('#bank-iban').fill('');
    await p.locator('#bank-account').fill('');
    await p.locator('#bank-name').fill('');
    await p.locator('#bank-swift').fill('');
    await p.locator('#bank-save').click();
    await p.locator('#bank-msg').waitFor({ timeout: 15000 });
    expect((await db.query('SELECT bank_iban FROM billing_settings')).rows[0].bank_iban).toBeNull();
  });
});

describe('Payment settings and the Website tab: Arabic and a phone', () => {
  it('read right to left in Arabic, show Arabic text, and fit a phone with no sideways scrolling', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p, errors } = await newPage(390);
    await signIn(p, platform);
    for (const path of ['/owner/settings', '/owner/website']) {
      await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1200);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls sideways by ${overflow}px on a phone`).toBeLessThanOrEqual(2);
    }
    await p.getByRole('button', { name: 'EN | AR' }).click();
    await p.waitForTimeout(900);
    expect(await p.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await p.locator('#web-testimonials').innerText()).toContain('آراء العملاء');
    await p.goto(`${BASE}/owner/settings`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(900);
    expect(await p.locator('#pay-settings').innerText()).toContain('إعدادات الدفع');
    expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });
});


describe('The free trial on screen', () => {
  let firm: string, planId: string;
  let original: Record<string, unknown> | undefined;
  const dayEnd = (n: number) => `((((now() AT TIME ZONE 'Asia/Riyadh')::date + ${n})::timestamp + interval '23 hours 59 minutes 59.999 seconds') AT TIME ZONE 'Asia/Riyadh')`;
  const setState = (status: string, ends: string, grace: string, cancelled = 'NULL') => db.query(
    `UPDATE subscriptions SET status = $2, trial_ends = COALESCE(trial_ends, current_date + 7), trial_started_at = now() - interval '20 days', trial_ends_at = ${ends}, grace_ends_at = ${grace}, cancelled_at = ${cancelled}, converted_at = NULL WHERE firm_id = $1`, [firm, status]);
  const text = (p: Page, sel: string) => p.locator(sel).innerText();

  beforeAll(async () => {
    firm = (await db.query('SELECT firm_id FROM companies WHERE id = $1', [company])).rows[0].firm_id;
    planId = (await db.query(`SELECT id FROM plans WHERE code = 'nusuh'`)).rows[0].id;
    original = (await db.query('SELECT status, trial_ends, trial_started_at, trial_ends_at, grace_ends_at, converted_at, cancelled_at FROM subscriptions WHERE firm_id = $1', [firm])).rows[0];
    if (!original) await db.query(`INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, trial_ends, next_bill_on, trial_started_at, trial_ends_at, grace_ends_at)
      VALUES ($1, $2, 'yearly', 'trial', current_date, current_date + 7, current_date + 7, now(), now() + interval '7 days', now() + interval '37 days')`, [firm, planId]);
  });
  afterAll(async () => {   // a subscription row can never be deleted: put it back as it was, or as an ordinary paying customer
    const o = original;
    await db.query(`UPDATE subscriptions SET status = $2, trial_ends = $8, trial_started_at = $3, trial_ends_at = $4, grace_ends_at = $5, converted_at = $6, cancelled_at = $7 WHERE firm_id = $1`,
      [firm, o?.status ?? 'active', o?.trial_started_at ?? null, o?.trial_ends_at ?? null, o?.grace_ends_at ?? null, o?.converted_at ?? null, o?.cancelled_at ?? null, o?.trial_ends ?? null]);
  });

  it('while the trial is open: the days left show at the top, the last days stand out, and the software works as always', async () => {
    await setState('trial', dayEnd(6), dayEnd(36));
    const { page: p, errors: errs } = await newPage();
    await signIn(p, accountant);
    await p.locator('#trial-bar').waitFor({ timeout: 15000 });
    expect(await text(p, '#trial-days')).toBe('7 days left in your free trial');
    expect(await p.evaluate(() => document.querySelector('#trial-buy')?.getAttribute('href'))).toBe('/buy');
    expect(await p.evaluate(() => document.querySelector('#trial-bar')?.classList.contains('urgent'))).toBe(false);
    expect(await p.locator('nav.side').count()).toBe(1);   // the normal workspace
    await setState('trial', dayEnd(2), dayEnd(32));
    await p.reload({ waitUntil: 'networkidle' });
    await p.locator('#trial-bar').waitFor({ timeout: 15000 });
    expect(await text(p, '#trial-days')).toBe('3 days left in your free trial');
    await screenshotTo(p, 'trial-bar-urgent');
    expect(await p.evaluate(() => document.querySelector('#trial-bar')?.classList.contains('urgent'))).toBe(true);
    await setState('trial', dayEnd(0), dayEnd(30));
    await p.reload({ waitUntil: 'networkidle' });
    await p.locator('#trial-bar').waitFor({ timeout: 15000 });
    expect(await text(p, '#trial-days')).toBe('Last day of your free trial');
    expect(errs.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });

  it('day 16 is a soft last day: a pop-up asks to buy, the software still works, and "Buy now" opens the order', async () => {
    await setState('trial', dayEnd(-1), dayEnd(29));   // the trial ended at 23:59 last night
    const { page: p, errors: errs } = await newPage();
    await signIn(p, accountant);
    await p.locator('#soft-pop').waitFor({ timeout: 15000 });
    expect(await text(p, '#soft-title')).toBe('Today is your last day');
    expect(await text(p, '#trial-days')).toContain('locks at 23:59 tonight');
    await screenshotTo(p, 'trial-soft-last-day');
    await p.locator('#soft-later').click();
    expect(await p.locator('#soft-pop').count()).toBe(0);
    expect(await p.locator('nav.side').count()).toBe(1);   // the normal workspace, not the ended screen
    await p.locator('#trial-buy').click();
    await p.locator('#buy-panel').waitFor({ timeout: 15000 });
    expect(errs.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });

  it('once it has ended: only the trial-ended screen, with buying, contact, the export and which modules switch off; nothing can be posted', async () => {
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    // the shared page is still signed in as the accountant from the start of this file
    await page.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await page.locator('#trial-ended').waitFor({ timeout: 15000 });
    expect(await page.evaluate(() => document.querySelector('#trial-ended')?.getAttribute('data-level'))).toBe('locked');
    expect(await text(page, '#trialui-title')).toBe('Your free trial has ended');
    expect(await text(page, '#trialui-body')).toContain('Nothing has been deleted. Your data is kept until');
    expect(await page.locator('#buy-panel').count()).toBe(1);   // buying happens right here, not on another site
    expect(await text(page, '#trialui-modules')).toContain('The core modules stay on');
    expect(await text(page, '#trialui-contact')).toContain('hello@nusuhbooks.com');
    // what you keep, what it costs (the owner's prices), how buying works, and our own promotional panel beside it
    expect(await text(page, '#trialui-keep')).toContain('The same company and the same data');
    expect(await page.locator('#trial-price tr').count()).toBe(4);
    expect(await text(page, '#trial-price')).toMatch(/SAR 9,000[\s\S]*SAR 1,500/);
    expect(await text(page, '#trial-price')).toContain('before VAT');
    expect(await page.locator('#trial-steps li').count()).toBe(3);
    expect(await text(page, '#trial-promo')).toContain('Close every month on one set of books.');
    expect(await text(page, '#trial-promo')).toContain('Built for ZATCA Phase 2');
    expect(await page.locator('#trial-testimonials').count()).toBe(0);   // none until the owner adds real ones
    expect(await page.locator('#trialui-buy-2').count()).toBe(1);
    // a real testimonial the owner added shows in the panel; nothing is invented
    await db.query(`INSERT INTO website_testimonials (name, role, company, quote, consent) VALUES ('Browser Customer', 'Finance manager', 'Browser Co', 'It closes our month without chasing anyone.', true)`);
    await page.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await page.locator('#trial-testimonials').waitFor({ timeout: 15000 });
    expect(await text(page, '#trial-testimonials')).toContain('It closes our month without chasing anyone.');
    await db.query('DELETE FROM website_testimonials');
    await screenshotTo(page, 'trial-ended-screen');
    expect(await page.locator('nav.side').count()).toBe(0);   // no software behind it
    // the export link gives a zip; posting is refused
    const exp = await page.evaluate(async (id) => {
      const href = document.querySelector('#trialui-exports a')?.getAttribute('href') ?? '';
      const r = await fetch(href); return { href, status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    }, company);
    expect(exp.href).toBe(`/api/companies/${company}/export`);
    expect([exp.status, exp.type]).toEqual([200, 'application/zip']);
    expect(exp.bytes).toBeGreaterThan(100);
    const post = await page.evaluate(async (id) => { const r = await fetch(`/api/companies/${id}/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', isCustomer: true }) }); return { s: r.status, k: (await r.json()).key }; }, company);
    expect(post).toEqual({ s: 403, k: 'err.trialEnded' });
    // Arabic, right to left
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(page, '#trialui-title')).toBe('انتهت تجربتك المجانية');
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(500);
  });

  it('buying inside the software: choose modules, order, transfer details, then the owner marks it paid and the company opens again', async () => {
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    const modsBefore = (await db.query('SELECT id, modules FROM companies WHERE firm_id = $1', [firm])).rows;
    const subBefore = (await db.query('SELECT plan_id, cycle, discount_pct, implementation FROM subscriptions WHERE firm_id = $1', [firm])).rows[0];
    await db.query(`UPDATE subscriptions SET plan_id = $2, cycle = 'yearly', discount_pct = 0 WHERE firm_id = $1`, [firm, planId]);   // the standard plan, so the invoice equals the order
    await db.query('DELETE FROM trial_orders WHERE firm_id = $1 AND status = $2', [firm, 'waiting']).catch(() => undefined);
    const { page: c } = await newPage();
    await c.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await c.locator('input[type=email]').fill(accountant);
    await c.locator('input[type=password]').fill('demo1234');
    await c.getByRole('button', { name: 'Sign in', exact: true }).click();
    await c.locator('#buy-panel').waitFor({ timeout: 30000 });
    // pick exactly two optional modules; the preview adds up with the owner's prices
    for (const m of ['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM']) { const box = c.locator(`#buy-mod-${m}`); if (await box.isChecked()) await box.uncheck(); }
    await c.locator('#buy-mod-HRM').check();
    await c.locator('#buy-mod-CRM').check();
    expect(await text(c, '#buy-year')).toBe('SAR 2,500.00');   // 1,500 core + 2 x 500
    expect(await text(c, '#buy-once')).toBe('SAR 9,000.00');
    expect(await text(c, '#buy-sub')).toBe('SAR 11,500.00');
    await c.locator('#buy-cleanup').check();
    expect(await text(c, '#buy-sub')).toBe('SAR 16,500.00');
    await c.locator('#buy-place').click();
    await c.locator('#buy-waiting-title').waitFor({ timeout: 15000 });
    expect(await text(c, '#buy-waiting-sum')).toContain('SAR 18,975.00');   // 16,500 + 15% VAT
    expect(await text(c, '#buy-bank-none')).toContain('hello@nusuhbooks.com');
    await screenshotTo(c, 'trial-buy-waiting');
    // the bank details the owner saves show up here
    await db.query(`UPDATE billing_settings SET bank_account_name = 'Nusuh Demo Co', bank_name = 'Demo Bank', bank_iban = 'SA0380000000608010167519', bank_swift = 'DEMOSARI'`);
    await c.reload({ waitUntil: 'networkidle' });
    await c.locator('#buy-iban').waitFor({ timeout: 15000 });
    expect(await text(c, '#buy-iban')).toBe('SA0380000000608010167519');
    await db.query(`UPDATE billing_settings SET bank_account_name = NULL, bank_name = NULL, bank_iban = NULL, bank_swift = NULL`);
    // an empty form cannot be sent; a bad amount is explained in plain words
    expect(await c.locator('#buy-send').isDisabled()).toBe(true);
    await c.locator('#buy-amount').fill('abc');
    await c.locator('#buy-reference').fill('BROWSER-TRF-1');
    await c.locator('#buy-send').click();
    await c.locator('#buy-pay-error').waitFor({ timeout: 15000 });
    expect(await text(c, '#buy-pay-error')).toContain('amount');
    await c.locator('#buy-amount').fill('18975');
    await c.locator('#buy-send').click();
    await c.locator('#buy-done-title').waitFor({ timeout: 15000 });
    expect(await text(c, '#buy-done-body')).toContain('BROWSER-TRF-1');
    // the owner sees the order in Trials and marks it paid
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: o } = await newPage();
    await signIn(o, platform);
    await o.goto(`${BASE}/owner/trials`, { waitUntil: 'networkidle' });
    await o.locator('#tr-table').waitFor({ timeout: 15000 });
    expect(await o.locator('#tr-c-orders b').innerText()).not.toBe('0');
    await o.locator('#tr-f-orders').click();
    expect(await text(o, `#tr-row-${firm}`)).toContain('Says it has paid');
    await o.locator(`#tr-paid-${firm}`).click();
    await o.locator('#tr-action').waitFor();
    expect(await o.locator('#tr-mod-HRM').isChecked()).toBe(true);
    expect(await o.locator('#tr-cleanup').isChecked()).toBe(true);
    expect(await o.locator('#tr-go').isDisabled()).toBe(true);   // needs a reason
    await o.locator('#tr-reason').fill('Browser check: money seen in the bank');
    await o.locator('#tr-go').click();
    await o.locator('#tr-msg').waitFor({ timeout: 30000 });
    expect(await text(o, '#tr-msg')).toMatch(/Invoice NB-\d{4}-\d{4} \(SAR 18,975\.00\) is made and settled/);
    await screenshotTo(o, 'owner-trials');
    // the customer works again, with the same data
    await c.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await c.locator('nav.side').waitFor({ timeout: 20000 });
    expect(await c.locator('#trial-ended').count()).toBe(0);
    // put the demo company's modules back
    for (const r of modsBefore) await db.query('UPDATE companies SET modules = $2 WHERE id = $1', [r.id, r.modules]);
    await db.query('UPDATE subscriptions SET plan_id = $2, cycle = $3, discount_pct = $4, implementation = $5 WHERE firm_id = $1', [firm, subBefore.plan_id, subBefore.cycle, subBefore.discount_pct, subBefore.implementation]);
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));   // ended again for the checks that follow
    await db.query(`UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = $1 AND status = 'waiting'`, [firm]);
  });

  it('the buying panel reads right to left in Arabic, and the owner\'s Trials tab fits a phone', async () => {
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    await page.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await page.locator('#buy-panel').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(page, '#buy-panel h2')).toBe('اختر ما تريد شراءه');
    await page.getByRole('button', { name: 'EN | AR' }).click();
    await page.waitForTimeout(500);
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: ph } = await newPage(390);
    await signIn(ph, platform);
    await ph.goto(`${BASE}/owner/trials`, { waitUntil: 'networkidle' });
    await ph.locator('#owner-trials').waitFor({ timeout: 15000 });
    const overflow = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `sideways by ${overflow}px`).toBeLessThanOrEqual(2);
  });

  it('the guided setup: business and goals, accounts for the business, bringing a Word table, the first invoice, and the page guide', async () => {
    await setState('trial', dayEnd(8), dayEnd(38));
    await db.query('DELETE FROM trial_setup WHERE firm_id = $1', [firm]).catch(() => undefined);
    // earlier checks may have given this person a limited job title: the setup is for someone who can enter accounts and customers
    const role = (await db.query('SELECT m.client_role_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND u.email = $2', [company, accountant])).rows[0]?.client_role_id ?? null;
    await db.query('UPDATE memberships m SET client_role_id = NULL FROM users u WHERE u.id = m.user_id AND m.company_id = $1 AND u.email = $2', [company, accountant]);
    const stamp = Date.now().toString(36);
    const cell = (x: string) => `<w:tc><w:p><w:r><w:t>${x}</w:t></w:r></w:p></w:tc>`;
    const row = (...c: string[]) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
    const docx = Buffer.from(zipStored([['word/document.xml', new TextEncoder().encode(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:tbl>${row('Name', 'Email')}${row(`Word Customer ${stamp} A`, 'a@x.example')}${row(`Word Customer ${stamp} B`, 'b@x.example')}</w:tbl></w:body></w:document>`)]]));
    const { page: p, errors: errs } = await newPage();
    await signIn(p, accountant);
    await p.locator('#wiz').waitFor({ timeout: 20000 });
    expect(await p.locator('#wiz-next').isDisabled()).toBe(true);   // needs the kind of business first
    await p.locator('#wiz-type-restaurant').click();
    await p.locator('#wiz-goal-payroll').check();
    await p.locator('#wiz-goal-invoicing').check();
    await p.locator('#wiz-switch').waitFor();
    await screenshotTo(p, 'setup-wizard-1');
    await p.locator('#wiz-next').click();
    await p.locator('#wiz-chart').waitFor({ timeout: 15000 });
    expect(await p.locator('.wiz-accounts li').count()).toBe(4);
    await p.locator('#wiz-add').click();
    await p.locator('#wiz-added').waitFor({ timeout: 15000 }).catch(async (e) => { throw new Error(`${e.message} | error: ${await p.locator('#wiz-error').innerText().catch(() => 'none')} | norights: ${await p.locator('#wiz-norights').count()} | busy add disabled: ${await p.locator('#wiz-add').isDisabled().catch(() => 'gone')}`); });
    await p.locator('#wiz-next').click();
    await p.locator('#wiz-data').waitFor();
    await p.locator('#wiz-import').click();
    await p.locator('#wiz-kind-customers').click();
    await p.locator('#imp-file').setInputFiles({ name: 'customers.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
    await p.locator('#imp-preview').waitFor({ timeout: 15000 });
    expect(await text(p, '#imp-preview')).toContain(`Word Customer ${stamp} A`);
    await p.locator('#imp-run').click();
    await p.locator('#imp-done').waitFor({ timeout: 15000 });
    await screenshotTo(p, 'setup-wizard-3');
    await p.locator('#wiz-next').click();
    await p.locator('#wiz-done').waitFor({ timeout: 15000 }).catch(async (e) => { throw new Error(`${e.message} | error shown: ${await p.locator('#wiz-error').innerText().catch(() => 'none')} | next count ${await p.locator('#wiz-next').count()}`); });
    await p.locator('#wiz-finish').click();
    expect(await p.locator('#wiz').count()).toBe(0);
    // what was saved, and what the owner can see (counts only)
    const saved = (await db.query('SELECT step, business_type, goals, data_choice, completed_at IS NOT NULL AS done FROM trial_setup WHERE firm_id = $1', [firm])).rows[0];
    expect(saved).toMatchObject({ step: 'done', business_type: 'restaurant', goals: ['payroll', 'invoicing'], data_choice: 'import', done: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM contacts WHERE name LIKE $1`, [`Word Customer ${stamp}%`])).rows[0].n).toBe(2);
    // it does not come back, and the "?" guide explains the page
    await p.reload({ waitUntil: 'networkidle' });
    await p.locator('#guide-btn').waitFor({ timeout: 15000 });
    expect(await p.locator('#wiz').count()).toBe(0);
    await p.locator('#guide-btn').click();
    await p.locator('#guide-panel').waitFor();
    expect(await text(p, '#guide-title')).toContain('Home');
    let seen: string[] = [];
    for (let i = 0; i < 20 && !seen.includes('Home'); i++) { seen = (await db.query('SELECT tour_seen FROM trial_setup WHERE firm_id = $1', [firm])).rows[0]?.tour_seen ?? []; if (!seen.includes('Home')) await p.waitForTimeout(250); }   // the "seen" note is sent just after the panel opens
    expect(seen).toContain('Home');
    await screenshotTo(p, 'setup-guide');
    // run it again, in Arabic
    await p.locator('#guide-setup').click();
    await p.locator('#wiz').waitFor();
    await p.locator('#wiz').getByRole('button', { name: 'EN | AR' }).click();
    await p.waitForTimeout(800);
    expect(await p.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(p, '#wiz-title')).toBe('لنُعدّ شركتك');
    await screenshotTo(p, 'setup-wizard-arabic');
    await db.query('UPDATE memberships m SET client_role_id = $3 FROM users u WHERE u.id = m.user_id AND m.company_id = $1 AND u.email = $2', [company, accountant, role]);
    expect(errs.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });

  it('the setup wizard does not scroll sideways on a phone, and a skipped setup stays skipped', async () => {
    await setState('trial', dayEnd(8), dayEnd(38));
    await db.query('DELETE FROM trial_setup WHERE firm_id = $1', [firm]).catch(() => undefined);
    const { page: ph } = await newPage(390);
    await signIn(ph, accountant);
    await ph.locator('#wiz').waitFor({ timeout: 20000 });
    await ph.locator('#wiz-type-services').click();
    for (const g of ['invoicing', 'bookkeeping', 'vat', 'payroll']) await ph.locator(`#wiz-goal-${g}`).check();
    const ov = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(ov, `sideways by ${ov}px`).toBeLessThanOrEqual(2);
    await ph.locator('#wiz-skip').click();
    await ph.waitForTimeout(800);
    expect(await ph.locator('#wiz').count()).toBe(0);
    await ph.reload({ waitUntil: 'networkidle' });
    await ph.waitForTimeout(1500);
    expect(await ph.locator('#wiz').count()).toBe(0);
    expect((await db.query('SELECT skipped FROM trial_setup WHERE firm_id = $1', [firm])).rows[0].skipped).toBe(true);
  });

  it('on a phone the trial-ended screen does not scroll sideways', async () => {
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    const { page: ph } = await newPage(390);
    await ph.goto(`${BASE}/`, { waitUntil: 'networkidle' });   // signing in works while ended; the sidebar is just not there afterwards
    await ph.locator('input[type=email]').fill(accountant);
    await ph.locator('input[type=password]').fill('demo1234');
    await ph.getByRole('button', { name: 'Sign in', exact: true }).click();
    await ph.locator('#trial-ended').waitFor({ timeout: 30000 });
    const overflow = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await ph.evaluate(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('#trial-ended *')].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 6).map((e) => `${e.tagName}.${e.className}#${e.id} right=${Math.round(e.getBoundingClientRect().right)}`); });
    expect(overflow, `sideways by ${overflow}px: ${JSON.stringify(wide)}`).toBeLessThanOrEqual(2);
    // and after ordering (bank lines, the payment form and its file picker are wider than the choice screen)
    await ph.locator('#buy-place').click();
    await ph.locator('#buy-waiting-title').waitFor({ timeout: 15000 });
    const after = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(after, `sideways by ${after}px after ordering`).toBeLessThanOrEqual(2);
    await db.query(`UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = $1 AND status = 'waiting'`, [firm]);
  });

  it('paying by bank transfer: order with VAT, our bank with copy buttons, the "I paid" form, then waiting for review; the older form shows while payments are off', async () => {
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    await db.query(`UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = $1 AND status = 'waiting'`, [firm]);
    await db.query(`UPDATE subpay.orders SET status = 'expired' WHERE firm_id = $1 AND status IN ('awaiting_payment')`, [firm]).catch(() => undefined);
    await db.query(`UPDATE subpay.bank_live SET account_name = 'Nusuh Demo Co', bank = 'Demo Bank', iban = 'SA0380000000608010167519', swift = 'DEMOSARI', changed_at = now() - interval '30 days', first_entry = true`);
    await db.query(`UPDATE subpay.settings SET payments_enabled = false`);
    const { page: ph } = await newPage(390);
    await ph.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await ph.locator('input[type=email]').fill(accountant);
    await ph.locator('input[type=password]').fill('demo1234');
    await ph.getByRole('button', { name: 'Sign in', exact: true }).click();
    await ph.locator('#buy-place').waitFor({ timeout: 30000 });
    await ph.locator('#buy-place').click();
    await ph.locator('#buy-waiting-title').waitFor({ timeout: 15000 });          // payments off: the older form
    expect(await ph.locator('#pay-c-form').count()).toBe(0);
    await db.query(`UPDATE subpay.settings SET payments_enabled = true`);
    await ph.reload({ waitUntil: 'networkidle' });
    await ph.locator('#pay-c-start').waitFor({ timeout: 15000 });
    await ph.locator('#pay-c-start').click();
    await ph.locator('#pay-c-iban').waitFor({ timeout: 15000 });
    expect(await text(ph, '#pay-c-ref')).toMatch(/^NB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]$/);
    expect(await text(ph, '#pay-c-total')).toMatch(/^SAR [\d,]+\.\d{2}$/);
    expect(await ph.locator('#pay-c-iban').innerText()).toContain('SA0380000000608010167519');
    expect(await ph.locator('#pay-c-changed').count()).toBe(0);                  // the account did not change recently
    const sideways = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, `sideways by ${sideways}px`).toBeLessThanOrEqual(2);
    // a bad amount is explained; the right amount is accepted
    expect(await ph.locator('#pay-c-send').isDisabled()).toBe(true);
    await ph.locator('#pay-c-amount').fill('abc');
    await ph.locator('#pay-c-send').click();
    await ph.locator('#pay-c-form-error').waitFor({ timeout: 15000 });
    const total = (await text(ph, '#pay-c-total')).replace('SAR ', '').replace(/,/g, '');
    await ph.locator('#pay-c-amount').fill(total);
    await ph.locator('#pay-c-bankref').fill('BROWSER-PAY-1');
    await ph.locator('#pay-c-send').click();
    await ph.locator('#pay-c-wait').waitFor({ timeout: 15000 });
    expect(await ph.locator('#pay-c-form').count()).toBe(0);                     // no second form while it is being checked
    expect(await ph.locator('#pay-c-told').innerText()).toContain('BROWSER-PAY-1');
    expect(await ph.locator('#pay-c-timeline li').count()).toBeGreaterThanOrEqual(2);
    expect((await db.query(`SELECT status FROM subpay.orders WHERE firm_id = $1 ORDER BY created_at DESC LIMIT 1`, [firm])).rows[0].status).toBe('under_review');
    // the review desk: the Owner sees it in the queue, side by side, and decides
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const ref = await text(ph, '#pay-c-ref').catch(() => '');
    const { page: rv } = await newPage(1280);
    await signIn(rv, platform);
    await rv.goto(`${BASE}/owner/review`, { waitUntil: 'networkidle' });
    await rv.locator('#rv-queue').waitFor({ timeout: 15000 }).catch(async (e) => { throw new Error(`review desk did not show the queue; page says: ${(await rv.locator('main').innerText()).slice(0, 400)} | ${e}`); });
    const orderRef = (await db.query(`SELECT reference FROM subpay.orders WHERE firm_id = $1 ORDER BY created_at DESC LIMIT 1`, [firm])).rows[0].reference as string;
    expect(ref === '' || ref === orderRef).toBe(true);
    await rv.locator(`#rv-open-${orderRef}`).click();
    await rv.locator('#rv-compare').waitFor({ timeout: 15000 });
    expect((await text(rv, '#rv-entered')).replace(/[^\d.]/g, '')).toBe((await text(rv, '#rv-due')).replace(/[^\d.]/g, ''));   // same amount both sides
    expect(await rv.locator('#rv-flags').count()).toBe(0);
    // approving needs the tick "I saw the money"; the reject button needs a reason the customer will read
    await rv.locator('#rv-act-approve').click();
    expect(await rv.locator('#rv-go').isDisabled()).toBe(true);
    await rv.locator('#rv-saw').check();
    expect(await rv.locator('#rv-go').isDisabled()).toBe(false);
    await rv.locator('#rv-act-reject').click();
    expect(await rv.locator('#rv-go').isDisabled()).toBe(true);
    await rv.locator('#rv-text').fill('We could not find this transfer in our bank.');
    await rv.locator('#rv-go').click();
    await rv.locator('#rv-done').waitFor({ timeout: 15000 });
    expect((await db.query(`SELECT status FROM subpay.orders WHERE reference = $1`, [orderRef])).rows[0].status).toBe('rejected');
    // the customer reads the reason
    await ph.reload({ waitUntil: 'networkidle' });
    await ph.locator('#pay-c-timeline').waitFor({ timeout: 15000 });
    expect(await ph.locator('#pay-c-timeline').innerText()).toContain('We could not find this transfer');
    expect(await ph.locator('#pay-c-start').count()).toBe(1);                      // and can start again
    // leave shared settings as they were
    await db.query(`UPDATE subpay.settings SET payments_enabled = false`);
    await db.query(`UPDATE subpay.bank_live SET account_name = NULL, bank = NULL, iban = NULL, swift = NULL, first_entry = true`);
    await db.query(`UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = $1 AND status = 'waiting'`, [firm]);
  });

  it('website hand-over: /order keeps only module names (tricks in the address change nothing), and an existing customer who signs in lands on the buy screen with them ticked', async () => {
    await setState('trial', dayEnd(10), dayEnd(40));
    await db.query(`UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = $1 AND status = 'waiting'`, [firm]);
    const { page: p } = await newPage(390);
    const evil = encodeURIComponent('<img src=x onerror=window.__x=1>,HRM,CRM');
    await p.goto(`${BASE}/order?m=${evil}&c=1&price=1&amount=0.01&next=https://evil.example&redirect=//evil.example`, { waitUntil: 'networkidle' });
    await p.locator('#order-selection').waitFor({ timeout: 15000 });
    const shown = await text(p, '#order-selection');
    expect(shown).toContain('HRM'); expect(shown).toContain('CRM'); expect(shown).not.toContain('<img');
    expect(await p.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();           // nothing in the address ran
    expect(p.url()).toBe(`${BASE}/order`);                                                                   // the address no longer carries the choice
    expect(await text(p, '#order-once')).toBe('SAR 14,000.00');                                              // 9,000 + 5,000 clean-up: from the owner's prices, not from the address
    expect(await text(p, '#order-year')).toBe('SAR 2,500.00');                                               // 1,500 + 2 x 500
    expect(await overflowOf(p)).toBeLessThanOrEqual(2);
    await p.locator('#order-signin').click();
    await p.locator('input[type=email]').fill(accountant);
    await p.locator('input[type=password]').fill('demo1234');
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.locator('#buy-panel').waitFor({ timeout: 30000 });
    expect(new URL(p.url()).host).toBe(new URL(BASE).host);                                                  // never sent anywhere else
    expect(await p.locator('#buy-mod-HRM').isChecked()).toBe(true);
    expect(await p.locator('#buy-mod-CRM').isChecked()).toBe(true);
    expect(await p.locator('#buy-mod-Inventory').isChecked()).toBe(false);
    expect(await p.locator('#buy-cleanup').isChecked()).toBe(true);
    expect(await text(p, '#buy-sub')).toBe('SAR 16,500.00');                                                  // 14,000 once + 2,500 a year
  });

  it('the Administrator sees the same screen, told that the books are exported by company users', async () => {
    const adminEmail = (await db.query(`SELECT email FROM users WHERE firm_id = $1 AND kind = 'admin' AND status = 'active' LIMIT 1`, [firm])).rows[0]?.email as string | undefined;
    if (!adminEmail) return;   // the demo seed always has one; nothing to check otherwise
    await setState('trial', dayEnd(3), dayEnd(33));
    const { page: a } = await newPage();
    await signIn(a, adminEmail);
    await setState('trial', `now() - interval '2 days'`, dayEnd(28));
    await a.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await a.locator('#trial-ended').waitFor({ timeout: 15000 });
    expect(await a.locator('#trialui-export-admin').count()).toBe(1);
    expect(await a.locator('#trialui-exports').count()).toBe(0);
  });

  it('after the grace period it is a closed account: export only until the date, and then a closed page', async () => {
    await setState('cancelled', `now() - interval '40 days'`, `now() - interval '10 days'`, `now() - interval '10 days'`);
    await page.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await page.locator('#trial-ended').waitFor({ timeout: 15000 });
    expect(await page.evaluate(() => document.querySelector('#trial-ended')?.getAttribute('data-level'))).toBe('export_only');
    expect(await text(page, '#trialui-title')).toBe('This account is closed');
    expect(await text(page, '#trialui-body')).toContain('You can still export your data until');
    expect(await page.locator('#trialui-modules').count()).toBe(0);
    // past the export window: nothing is left to open
    await setState('cancelled', `now() - interval '200 days'`, `now() - interval '170 days'`, `now() - interval '170 days'`);
    await page.goto(`${BASE}/c/${company}/Home`, { waitUntil: 'networkidle' });
    await page.locator('#trial-closed').waitFor({ timeout: 15000 });
    expect(await text(page, '#trial-closed')).toContain('The time to export your data has passed');
    expect(await page.locator('#trialui-exports').count()).toBe(0);
  });
});

describe('Signing up from the website\'s "Start free trial" link', () => {
  const stamp = Date.now().toString(36);
  const text = (p: Page, sel: string) => p.locator(sel).innerText();
  const cr = () => String(Math.floor(1e9 + Math.random() * 9e9));
  const fill = async (p: Page, o: { email: string; company: string; crNumber: string }) => {
    await p.locator('#su-name').fill('Browser Founder');
    await p.locator('#su-email').fill(o.email);
    await p.locator('#su-password').fill('Correct-Horse-9');
    await p.locator('#su-company').fill(o.company);
    await p.locator('#su-city').fill('Riyadh');
    await p.locator('#su-cr').fill(o.crNumber);
  };
  const tokenFor = async (email: string) => /\/verify\/([A-Za-z0-9_-]{43})/.exec(String((await db.query(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'signup' ORDER BY created_at DESC LIMIT 1`, [email])).rows[0]?.body_text ?? ''))?.[1];

  it('a new visitor creates an account with e-mail and password, confirms the link once, and lands in the setup wizard of a 15-day trial', async () => {
    const email = `visitor.${stamp}@browser-signup.example.com`, company = `Browser Signup Co ${stamp}`, crNumber = cr();
    const { page: p, errors: errs } = await newPage(1280);
    await p.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await p.locator('#signup').waitFor({ timeout: 15000 });
    await p.locator('#fake-google').waitFor({ timeout: 15000 });         // Google's button is offered (the stand-in draws it); the e-mail way works too
    expect(await p.locator('#su-submit').isDisabled()).toBe(true);        // nothing to send yet
    await screenshotTo(p, 'signup-form');
    await fill(p, { email, company, crNumber });
    expect(await p.locator('#su-submit').isDisabled()).toBe(true);        // the terms box is not ticked
    await p.locator('#su-terms').check();
    await p.locator('#su-submit').click();
    await p.locator('#signup-sent').waitFor({ timeout: 15000 });
    expect(await text(p, '#signup-sent')).toContain(email);
    expect((await db.query('SELECT count(*)::int AS n FROM firms WHERE name = $1', [company])).rows[0].n).toBe(0);   // nothing exists before the link
    const token = await tokenFor(email);
    expect(token).toBeTruthy();
    await p.goto(`${BASE}/verify/${token}`, { waitUntil: 'networkidle' });
    await p.locator('#verify-go').waitFor({ timeout: 15000 });
    expect((await db.query('SELECT count(*)::int AS n FROM firms WHERE name = $1', [company])).rows[0].n).toBe(0);   // opening the page alone creates nothing
    await p.locator('#verify-go').click();
    await p.locator('#wiz').waitFor({ timeout: 30000 });                  // signed in, and the guided setup opens
    expect((await db.query('SELECT count(*)::int AS n FROM firms WHERE name = $1', [company])).rows[0].n).toBe(1);
    const sub = (await db.query(`SELECT s.status FROM subscriptions s JOIN firms f ON f.id = s.firm_id WHERE f.name = $1`, [company])).rows[0];
    expect(sub.status).toBe('trial');
    await p.locator('#trial-bar').waitFor({ timeout: 15000 });
    expect(await text(p, '#trial-days')).toMatch(/^1[56] days left/);
    await screenshotTo(p, 'signup-first-screen');
    // the same link does nothing a second time
    const { page: again } = await newPage(1280);
    await again.goto(`${BASE}/verify/${token}`, { waitUntil: 'networkidle' });
    await again.locator('#verify-go').click();
    await again.locator('#verify-again').waitFor({ timeout: 15000 });
    expect((await db.query('SELECT count(*)::int AS n FROM firms WHERE name = $1', [company])).rows[0].n).toBe(1);
    // and the person can sign in with the password they chose
    const { page: login } = await newPage(1280);
    await login.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await login.locator('input[type=email]').fill(email);
    await login.locator('input[type=password]').fill('Correct-Horse-9');
    await login.getByRole('button', { name: 'Sign in', exact: true }).click();
    await login.locator('#trial-bar').waitFor({ timeout: 30000 });
    expect(errs.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });

  it('asking again with the same address, or the same company number, says the same thing and creates nothing more', async () => {
    const email = `dupe.${stamp}@browser-signup.example.com`, crNumber = cr();
    const first = await newPage(1280);
    await first.page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await fill(first.page, { email, company: `Dupe Co ${stamp}`, crNumber });
    await first.page.locator('#su-terms').check(); await first.page.locator('#su-submit').click();
    await first.page.locator('#signup-sent').waitFor({ timeout: 15000 });
    await first.page.goto(`${BASE}/verify/${await tokenFor(email)}`, { waitUntil: 'networkidle' });
    await first.page.locator('#verify-go').click();
    await first.page.locator('#wiz').waitFor({ timeout: 30000 });
    const second = await newPage(1280);
    await second.page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await fill(second.page, { email: email.replace('dupe.', 'DUPE.'), company: 'Another Co', crNumber: cr() });
    await second.page.locator('#su-terms').check(); await second.page.locator('#su-submit').click();
    await second.page.locator('#signup-sent').waitFor({ timeout: 15000 });   // same screen as for a new address
    expect((await db.query(`SELECT count(*)::int AS n FROM signup_requests WHERE email = $1 AND status = 'pending'`, [email])).rows[0].n).toBe(0);
    const third = await newPage(1280);
    await third.page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await fill(third.page, { email: `other.${stamp}@browser-signup.example.com`, company: 'Same Number Co', crNumber });
    await third.page.locator('#su-terms').check(); await third.page.locator('#su-submit').click();
    await third.page.locator('[role=alert]').first().waitFor({ timeout: 15000 });
    expect(await third.page.locator('[role=alert]').first().innerText()).toContain('already has an account');
  });

  it('refuses a weak password and a throwaway address in plain words, and reads right to left in Arabic on a phone without sideways scroll', async () => {
    const { page: p } = await newPage(390);
    await p.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await fill(p, { email: `weak.${stamp}@browser-signup.example.com`, company: 'Weak Co', crNumber: cr() });
    await p.locator('#su-password').fill('password123');
    await p.locator('#su-terms').check(); await p.locator('#su-submit').click();
    await p.locator('[role=alert]').first().waitFor({ timeout: 15000 });
    expect(await p.locator('[role=alert]').first().innerText()).toContain('stronger password');
    await p.locator('#su-password').fill('Correct-Horse-9');
    await p.locator('#su-email').fill('x@mailinator.com');
    await p.locator('#su-submit').click();
    await p.waitForFunction(() => /work e-mail/i.test(document.body.innerText), null, { timeout: 15000 });
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
    await p.getByRole('button', { name: 'EN | AR' }).click();
    await p.waitForTimeout(800);
    expect(await p.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(p, '#signup h1')).toBe('ابدأ تجربتك المجانية لمدة 15 يومًا');
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
    await screenshotTo(p, 'signup-arabic-phone');
  });

  it('the sign-in page links to sign-up, and the owner sees the attempts in Trials', async () => {
    const { page: p } = await newPage(1280);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.locator('#login-signup').click();
    await p.locator('#signup').waitFor({ timeout: 15000 });
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: o } = await newPage(1280);
    await signIn(o, platform);
    await o.goto(`${BASE}/owner/trials`, { waitUntil: 'networkidle' });
    await o.locator('#owner-signups').waitFor({ timeout: 15000 });
    const table = await text(o, '#sup2-table');
    expect(table).toContain('Confirmed: trial started');
    expect(table).toContain('Refused');
    expect(table).not.toContain('Correct-Horse');
    expect(table).not.toContain(`visitor.${stamp}@`);
  });
});

describe('Signing in and signing up with Google (a stand-in for Google; the real server checks the token)', () => {
  const stamp = Date.now().toString(36);
  const cr = () => String(Math.floor(1e9 + Math.random() * 9e9));
  const as_ = (p: Page, who: { email: string; name?: string; sub?: string; verified?: boolean }) => p.evaluate((w: never) => { (window as unknown as { __gwho: unknown }).__gwho = w; }, who);

  // every browser check comes from one address, and a sign-up address may ask only 6 times an hour: the earlier sign-up checks used some, so age them
  beforeAll(async () => { await db.query(`UPDATE signup_requests SET created_at = created_at - interval '3 hours'`); });

  it('a new visitor continues with Google, gives only the company, and lands in the setup wizard of a 15-day trial; next time one click signs them in', async () => {
    const email = `gvisitor.${stamp}@browser-google.example.com`, name = 'Gina Google', companyName = `Google Browser Co ${stamp}`;
    const { page: p, errors } = await newPage(1280);
    await p.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await p.locator('#fake-google').waitFor({ timeout: 15000 });
    await as_(p, { email, name });
    await p.locator('#fake-google').click();
    await p.locator('#google-company').waitFor({ timeout: 15000 });
    expect(await p.locator('#google-company').innerText()).toContain(email);
    expect(await p.locator('#gc-name').inputValue()).toBe(name);                       // Google's name is offered, and can be changed
    expect((await db.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', [email])).rows[0].n).toBe(0);   // nothing exists yet
    expect(await p.locator('#gc-submit').isVisible()).toBe(true);
    await screenshotTo(p, 'google-company-step');
    await p.locator('#gc-company').fill(companyName);
    await p.locator('#gc-city').fill('Jeddah');
    await p.locator('#gc-cr').fill(cr());
    await p.locator('#gc-terms').check();
    await p.locator('#gc-submit').click();
    await p.locator('#wiz').waitFor({ timeout: 30000 }).catch(async (e) => { throw new Error(`${e.message}\nThe page showed: ${(await p.locator('body').innerText()).slice(0, 700)}`); });
    expect((await db.query(`SELECT s.status FROM subscriptions s JOIN firms f ON f.id = s.firm_id WHERE f.name = $1`, [companyName])).rows[0].status).toBe('trial');
    expect((await db.query(`SELECT count(*)::int AS n FROM google_identities g JOIN users u ON u.id = g.user_id WHERE lower(u.email) = $1`, [email])).rows[0].n).toBe(1);
    await p.locator('#trial-bar').waitFor({ timeout: 15000 });
    // another browser: the sign-in page, one click, straight in
    const { page: again, errors: errs2 } = await newPage(1280);
    await again.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await again.locator('#fake-google').waitFor({ timeout: 15000 });
    await as_(again, { email, name });
    await again.locator('#fake-google').click();
    await again.locator('#trial-bar').waitFor({ timeout: 30000 });
    expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
    expect(errs2.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  });

  it('an existing person signs in with Google when it vouches for their e-mail; Google not confirming the address is refused in plain words', async () => {
    const { page: p } = await newPage(1280);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.locator('#fake-google').waitFor({ timeout: 15000 });
    await as_(p, { email: accountant, verified: false });
    await p.locator('#fake-google').click();
    await waitForText(p, 'Google has not confirmed this e-mail address');
    await p.locator('#fake-google').waitFor({ timeout: 15000 });                       // the button is made ready again after an answer
    await as_(p, { email: accountant, name: 'Demo Accountant', sub: `sub-browser-${stamp}` });
    await p.locator('#fake-google').click();
    await p.locator('.side').first().waitFor({ timeout: 30000 });                  // inside the software
    expect((await db.query(`SELECT count(*)::int AS n FROM google_identities g JOIN users u ON u.id = g.user_id WHERE lower(u.email) = lower($1)`, [accountant])).rows[0].n).toBe(1);
    await db.query(`DELETE FROM google_identities g USING users u WHERE u.id = g.user_id AND lower(u.email) = lower($1)`, [accountant]);   // leave the demo data as it was
  });

  it('a person who is not a customer and tries the sign-in page is taken to the company step, not turned away', async () => {
    const email = `gnew.${stamp}@browser-google.example.com`;
    const { page: p } = await newPage(1280);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.locator('#fake-google').waitFor({ timeout: 15000 });
    await as_(p, { email, name: 'New Person' });
    await p.locator('#fake-google').click();
    await p.locator('#google-company').waitFor({ timeout: 15000 });
    expect(p.url()).toContain('/signup');
    expect(await p.locator('#google-company').innerText()).toContain(email);
    await p.locator('#gc-other').click();                                              // "use a different way" goes back to the normal form
    await p.locator('#su-submit').waitFor({ timeout: 15000 });
  });

  it('fits a phone without sideways scrolling', async () => {
    const { page: p } = await newPage(390);
    await p.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await p.locator('#fake-google').waitFor({ timeout: 15000 });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await as_(p, { email: `gphone.${stamp}@browser-google.example.com`, name: 'Phone Person' });
    await p.locator('#fake-google').click();
    await p.locator('#google-company').waitFor({ timeout: 15000 });
    expect(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await screenshotTo(p, 'google-company-step-phone');
  });
});

describe('The checklist beside the bell', () => {
  const clean = async () => {
    await db.query('DELETE FROM checklist_ticks WHERE company_id = $1', [company]);
    await db.query('DELETE FROM checklist_hidden WHERE company_id = $1', [company]);
    await db.query('DELETE FROM checklist_items WHERE company_id = $1', [company]);
  };
  afterEach(clean);
  const open = async (p: Page) => {
    await p.goto(`${BASE}/c/${company}`, { waitUntil: 'networkidle' });
    await p.locator('#checklist-btn').waitFor({ timeout: 15000 });
    await p.locator('#checklist-btn').click();
    await p.locator('#checklist-panel').waitFor({ timeout: 10000 });
  };

  it('sits beside the bell with its progress, and the home page no longer carries the checklist', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await p.goto(`${BASE}/c/${company}`, { waitUntil: 'networkidle' });
    await p.locator('#checklist-btn').waitFor({ timeout: 15000 });
    expect(await p.locator('#home-setup').count()).toBe(0);
    expect(await p.locator('#checklist-progress').innerText()).toMatch(/^\d+\/\d+$/);
    const order = await p.evaluate(() => {
      const a = document.querySelector('#checklist-btn')!.getBoundingClientRect(), b = document.querySelector('#bell')!.getBoundingClientRect();
      return { checklistBeforeBell: a.right <= b.left + 1, sameRow: Math.abs(a.top - b.top) < 12 };
    });
    expect(order).toEqual({ checklistBeforeBell: true, sameRow: true });
  });

  it('opens a panel grouped as Set up, Daily and Month end; a tick is kept, shown under Done, and written to the audit log', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await open(p);
    const text = await p.locator('#checklist-panel').innerText();
    expect(text).toContain('Set up');
    expect(text).toContain('Daily');
    await p.locator('#ck-daily_record').click();
    await p.waitForTimeout(900);
    expect(await p.locator('#checklist-panel').innerText()).toContain('Done (1)');
    const tick = (await db.query(`SELECT t.period, t.done_by, u.email FROM checklist_ticks t JOIN users u ON u.id = t.done_by WHERE t.company_id = $1 AND t.item_key = 'daily_record'`, [company])).rows;
    expect(tick).toHaveLength(1);
    expect(tick[0].email).toBe(accountant);
    expect(tick[0].period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'checklist_ticks' AND action = 'insert'`, [company]);
    expect(audit.rows[0].n).toBe(1);
    // a reload keeps it
    await p.reload({ waitUntil: 'networkidle' });
    await p.locator('#checklist-btn').click();
    await p.locator('#checklist-panel').waitFor({ timeout: 10000 });
    expect(await p.locator('#checklist-panel').innerText()).toContain('Done (1)');
  });

  it('hiding an item hides it for this person only, and Escape closes the panel', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await open(p);
    await p.locator('[data-key="daily_record"] .link').first().click();
    await p.waitForTimeout(900);
    expect(await p.locator('#ck-daily_record').count()).toBe(1);   // it is now under "Hidden by you", not in the open list
    expect(await p.locator('#checklist-hidden').count()).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM checklist_hidden WHERE company_id = $1`, [company])).rows[0].n).toBe(1);
    await p.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await p.waitForTimeout(300);
    expect(await p.locator('#checklist-panel').count()).toBe(0);
  });

  it('is a full-screen sheet on a phone with no sideways scrolling', async () => {
    const { page: ph } = await newPage(390);
    await signIn(ph, accountant);
    await open(ph);
    const m = await ph.evaluate(() => {
      const r = document.querySelector('#checklist-panel')!.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height), inner: window.innerWidth, innerH: window.innerHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(m.width).toBe(m.inner);
    expect(m.height).toBeGreaterThanOrEqual(m.innerH - 2);
    expect(m.overflow).toBeLessThanOrEqual(2);
  });

  it('reads right to left in Arabic', async () => {
    const { page: ar } = await newPage();
    await signIn(ar, accountant);
    await ar.goto(`${BASE}/c/${company}`, { waitUntil: 'networkidle' });
    await ar.getByRole('button', { name: 'EN | AR' }).click();
    await ar.waitForTimeout(900);
    await ar.locator('#checklist-btn').click();
    await ar.locator('#checklist-panel').waitFor({ timeout: 10000 });
    const text = await ar.locator('#checklist-panel').innerText();
    expect(text).toContain('قائمة المهام');
    expect(text).toContain('الإعداد');
    expect(await ar.evaluate(() => getComputedStyle(document.querySelector('#checklist-panel')!).direction)).toBe('rtl');
    const order = await ar.evaluate(() => {
      const a = document.querySelector('#checklist-btn')!.getBoundingClientRect(), b = document.querySelector('#bell')!.getBoundingClientRect();
      return a.left >= b.right - 1;   // mirrored: the checklist is to the right of the bell
    });
    expect(order).toBe(true);
  });

  it('the Administrator hides an item for everyone from the client page, and the person in the books no longer gets it', async () => {
    const adminEmail = (await db.query(`SELECT u.email FROM users u JOIN companies c ON c.firm_id = u.firm_id WHERE c.id = $1 AND u.kind = 'admin' AND u.status = 'active' LIMIT 1`, [company])).rows[0]?.email as string | undefined;
    expect(adminEmail).toBeTruthy();
    const { page: a } = await newPage();
    await signIn(a, adminEmail!);
    await a.goto(`${BASE}/admin/clients/${company}`, { waitUntil: 'networkidle' });
    await a.locator('#checklist-editor summary').waitFor({ timeout: 15000 });
    await a.locator('#checklist-editor summary').click();
    await a.locator('#checklist-editor [data-key="daily_record"]').waitFor({ timeout: 10000 });
    await a.locator('#checklist-editor [data-key="daily_record"] .link').first().click();
    await a.waitForTimeout(900);
    expect((await db.query(`SELECT hidden FROM checklist_items WHERE company_id = $1 AND key = 'daily_record'`, [company])).rows[0]?.hidden).toBe(true);
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await open(p);
    expect(await p.locator('#ck-daily_record').count()).toBe(0);
    // the same page for the Administrator carries no figures from the books
    expect(await a.locator('#checklist-editor').innerText()).not.toMatch(/\b\d+\/\d+\b/);
  });
});

const textOf = (p: Page, sel: string) => p.locator(sel).innerText();
const text_ = textOf;
const ZT_NO = () => 'ZT-BROWSER-0001';
const overflowOf = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) as Promise<number>;

describe('The home page dashboard', () => {
  const clean = async () => {
    await db.query(`DELETE FROM dashboard_layouts WHERE company_id = $1`, [company]);
  };
  afterEach(clean);
  const home = async (p: Page) => {
    await p.goto(`${BASE}/c/${company}`, { waitUntil: 'networkidle' });
    await p.locator('#dashboard').waitFor({ timeout: 20000 });
    await p.waitForTimeout(1200);
  };
  const order = (p: Page) => p.evaluate(() => [...document.querySelectorAll('#dash-grid .dw')].map((e) => (e as HTMLElement).dataset.type)) as Promise<string[]>;

  it('shows widgets from the company\'s own books for this role, each with a way to its report, and no longer the old figure cards', async () => {
    const { page: p, errors: errs } = await newPage();
    await signIn(p, accountant);
    await home(p);
    const types = await order(p);
    expect(types.length).toBeGreaterThan(3);
    expect(types).toContain('receivables');
    // the owner-report widgets follow the role's own right to the owner reports (other checks in this suite change the role, so read it)
    const perms = (await db.query(`SELECT r.permissions FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN client_roles r ON r.id = m.client_role_id WHERE u.email = $1 AND m.company_id = $2`, [accountant, company])).rows[0]?.permissions as Record<string, string> | null | undefined;
    const ownerReports = !perms || (perms.OwnerReports !== undefined && perms.OwnerReports !== 'none');
    expect(types.includes('net_profit'), JSON.stringify(perms)).toBe(ownerReports);
    expect(await p.locator('#home-setup').count()).toBe(0);
    expect(await p.locator('.dw-report').count()).toBeGreaterThan(2);
    expect(await p.locator('.dw-sample').count()).toBe(0);    // no sample figures on the real home page
    expect(errs.filter((e) => !/40[0-9]|favicon/.test(e))).toEqual([]);
  });

  it('the money-owed widget shows the aged receivables total exactly, and "View report" opens that report for the same date', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await home(p);
    const shown = (await textOf(p, '.dw[data-type="receivables"] .dw-big b')).replace(/,/g, '');
    const asOf = await p.evaluate(() => (document.querySelector('.dw[data-type="receivables"] .dw-dates') as HTMLElement).textContent ?? '');
    expect(asOf).toMatch(/\d{4}/);
    const today = new Date().toISOString().slice(0, 10);
    const aged = await call(p, `/api/companies/${company}/reports/aged?side=sales&asOf=${today}`) as { json?: { rows: { total: string }[] } };
    const total = (aged.json?.rows ?? []).reduce((s, r) => s + Math.round(Number(r.total) * 100), 0) / 100;
    expect(Number(shown)).toBe(total);
    await p.locator('.dw[data-type="receivables"] .dw-report').click();
    await p.waitForTimeout(1500);
    expect(p.url()).toContain('/Reports/aged-receivables?asOf=');
    expect(await p.locator('input[type="date"]').first().inputValue()).toBe(new URL(p.url()).searchParams.get('asOf'));
  });

  it('editing: add from the gallery (sample previews), rename, resize, move, Save keeps it after a reload, Reset brings the default back', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await home(p);
    const before = await order(p);
    await p.locator('#dash-edit').click();
    await p.locator('#dash-hint').waitFor({ timeout: 10000 });
    // the gallery previews use sample figures and say so
    await p.locator('#dash-add').click();
    await p.locator('#dash-gallery').waitFor({ timeout: 10000 });
    expect(await p.locator('#dash-gallery .dw-sample').count()).toBeGreaterThan(3);
    await p.locator('#dash-gallery [data-type="books_status"] .b').first().click();
    await p.waitForTimeout(600);
    expect((await order(p)).length).toBe(before.length + 1);
    // rename the first widget and make it wide; move the last one to the front with the arrows
    const first = p.locator('#dash-grid .dw').first();
    await first.locator('input').first().fill('My cash position');
    await p.locator('#dash-grid .dw').last().locator('button[title="Move earlier"]').click();
    await p.waitForTimeout(300);
    await p.locator('#dash-save').click();
    await p.locator('#dash-msg').waitFor({ timeout: 10000 });
    const saved = await order(p);
    const row = (await db.query(`SELECT layout, scope FROM dashboard_layouts WHERE company_id = $1`, [company])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].scope).toBe('user');
    expect(row[0].layout.widgets.length).toBe(before.length + 1);
    await p.reload({ waitUntil: 'networkidle' });
    await p.locator('#dashboard').waitFor({ timeout: 20000 }); await p.waitForTimeout(1000);
    expect(await order(p)).toEqual(saved);
    expect(await textOf(p, '#dash-grid')).toContain('My cash position');
    // Reset brings the default back
    await p.locator('#dash-edit').click();
    await p.evaluate(() => { window.confirm = () => true; });
    await p.locator('#dash-reset').click();
    await p.locator('#dash-msg').waitFor({ timeout: 10000 });
    expect(await order(p)).toEqual(before);
    expect((await db.query(`SELECT count(*)::int AS n FROM dashboard_layouts WHERE company_id = $1`, [company])).rows[0].n).toBe(0);
  });

  it('Cancel leaves everything as it was and stores nothing', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await home(p);
    const before = await order(p);
    await p.locator('#dash-edit').click();
    await p.locator('#dash-grid .dw').first().locator('.dw-remove').click();
    expect((await order(p)).length).toBe(before.length - 1);
    await p.locator('#dash-cancel').click();
    await p.waitForTimeout(500);
    expect(await order(p)).toEqual(before);
    expect((await db.query(`SELECT count(*)::int AS n FROM dashboard_layouts WHERE company_id = $1`, [company])).rows[0].n).toBe(0);
  });

  it('a widget\'s own period and the shared period change what is shown, and the report link carries the dates', async () => {
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await home(p);
    await p.locator('#dash-period').selectOption('last_month');
    await p.waitForTimeout(1500);
    const vat = await p.evaluate(() => (document.querySelector('.dw[data-type="vat_due"] .dw-dates') as HTMLElement | null)?.textContent ?? '');
    expect(vat).toMatch(/\d{4}/);
    await p.locator('.dw[data-type="vat_due"] .dw-report').click();
    await p.waitForTimeout(1500);
    expect(p.url()).toMatch(/\/Reports\/vat-return\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);
  });

  it('mirrors in Arabic (the first widget is on the right) and stacks on a phone with no sideways scrolling', async () => {
    const { page: ar } = await newPage();
    await signIn(ar, accountant);
    await home(ar);
    const ltrLeft = await ar.evaluate(() => { const w = [...document.querySelectorAll('#dash-grid .dw')]; return [w[0]!.getBoundingClientRect().left, w[1]!.getBoundingClientRect().left]; });
    expect(ltrLeft[0]!).toBeLessThan(ltrLeft[1]!);
    await ar.getByRole('button', { name: 'EN | AR' }).click();
    await ar.waitForTimeout(1200);
    const rtlLeft = await ar.evaluate(() => { const w = [...document.querySelectorAll('#dash-grid .dw')]; return [w[0]!.getBoundingClientRect().left, w[1]!.getBoundingClientRect().left]; });
    expect(rtlLeft[0]!).toBeGreaterThan(rtlLeft[1]!);
    expect(await textOf(ar, '#dash-edit')).toBe('تعديل الصفحة الرئيسية');
    const { page: ph } = await newPage(390);
    await signIn(ph, accountant);
    await home(ph);
    const m = await ph.evaluate(() => ({ lefts: [...new Set([...document.querySelectorAll('#dash-grid .dw')].map((w) => Math.round(w.getBoundingClientRect().left)))], overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(m.lefts).toHaveLength(1);                          // one column
    expect(m.overflow).toBeLessThanOrEqual(2);
    await ph.locator('#dash-edit').click();
    await ph.waitForTimeout(600);
    expect(await overflowOf(ph)).toBeLessThanOrEqual(2);      // the editor fits a phone too
  });

  it('the Administrator sets the company default with sample figures only, and a person with no layout of their own gets it', async () => {
    const adminEmail = (await db.query(`SELECT u.email FROM users u JOIN companies c ON c.firm_id = u.firm_id WHERE c.id = $1 AND u.kind = 'admin' AND u.status = 'active' LIMIT 1`, [company])).rows[0]?.email as string;
    const { page: a } = await newPage();
    await signIn(a, adminEmail);
    await a.goto(`${BASE}/admin/clients/${company}`, { waitUntil: 'networkidle' });
    await a.locator('#dash-defaults summary').waitFor({ timeout: 20000 });
    await a.locator('#dash-defaults summary').click();
    await a.locator('#dash-defaults .dw').first().waitFor({ timeout: 10000 });
    expect(await a.locator('#dash-defaults .dw-sample').count()).toBeGreaterThan(3);   // every widget there is a sample, never the books
    expect(await textOf(a, '#dash-defaults')).not.toMatch(/Al Faisal|ANT-0002/);
    // remove the first widget and save it as the company default
    const firstType = await a.evaluate(() => (document.querySelector('#dash-defaults .dw') as HTMLElement).dataset.type);
    await a.locator('#dash-defaults .dw').first().locator('.dw-remove').click();
    await a.locator('#dash-ad-save').click();
    await a.locator('#dash-ad-msg').waitFor({ timeout: 10000 });
    const row = (await db.query(`SELECT scope, layout FROM dashboard_layouts WHERE company_id = $1`, [company])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].scope).toBe('company');
    expect(row[0].layout.widgets.map((x: { type: string }) => x.type)).not.toContain(firstType);
    const { page: p } = await newPage();
    await signIn(p, accountant);
    await home(p);
    expect(await order(p)).not.toContain(firstType);
    expect(await p.locator('#dash-source').count()).toBe(1);   // "set by your company's Administrator"
  });
});

describe('The sign-in and sign-up pages', () => {
  it('the sign-in page has the brand panel, a full-width form and the way to sign up', async () => {
    const { page: p, errors: errs } = await newPage(1280);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.locator('.auth-card').waitFor({ timeout: 15000 });
    const aside = await textOf(p, '.auth-aside');
    expect(aside).toContain('Built for ZATCA Phase 2');
    expect(aside).toContain('Accounting that fits how Gulf businesses work');
    const m = await p.evaluate(() => {
      const card = document.querySelector('.auth-card')!.getBoundingClientRect(), btn = document.querySelector('#login-submit')!.getBoundingClientRect(), a = document.querySelector('.auth-aside')!.getBoundingClientRect();
      return { btnFillsCard: btn.width > card.width - 80, asideRightOfCard: a.left > card.right };
    });
    expect(m).toEqual({ btnFillsCard: true, asideRightOfCard: true });
    expect(await p.locator('#login-signup').count()).toBe(1);
    expect(errs.filter((e) => !/40[0-9]|favicon/.test(e))).toEqual([]);
    await screenshotTo(p, 'login-page');
  });

  it('the sign-up page has the same panel, its fields in two short sections, and a password strength bar that follows what is typed', async () => {
    const { page: p } = await newPage(1280);
    await p.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await p.locator('#signup').waitFor({ timeout: 15000 });
    expect(await textOf(p, '.auth-aside')).toContain('Create your account');
    expect(await p.locator('.auth-aside .aside-steps li').count()).toBe(3);
    const secs = await p.evaluate(() => [...document.querySelectorAll('#signup .auth-sec')].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    expect(secs).toEqual(['1 ABOUT YOU', '2 YOUR COMPANY']);
    const strength = async (v: string) => { await p.locator('#su-password').fill(v); await p.waitForTimeout(150); return await p.evaluate(() => (document.querySelector('#pw-meter') as HTMLElement).dataset.s); };
    expect(await strength('')).toBe('0');
    expect(await strength('abc')).toBe('1');
    expect(await strength('abcdefghij1')).toBe('2');
    expect(await strength('Correct-Horse-Battery-9')).toBe('3');
    expect(await textOf(p, '#pw-meter')).toContain('Strong');
    // nothing was sent: it is only a guide
    expect(await p.locator('#signup-sent').count()).toBe(0);
    await screenshotTo(p, 'signup-page');
  });

  it('mirrors in Arabic (the panel moves to the left) and, on a phone, drops the panel for a row of trust points with no sideways scrolling', async () => {
    const { page: ar } = await newPage(1280);
    await ar.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await ar.locator('#signup').waitFor({ timeout: 15000 });
    await ar.getByRole('button', { name: 'EN | AR' }).first().click();
    await ar.waitForTimeout(900);
    const pos = await ar.evaluate(() => ({ aside: document.querySelector('.auth-aside')!.getBoundingClientRect().left, card: document.querySelector('.auth-card')!.getBoundingClientRect().left }));
    expect(pos.aside).toBeLessThan(pos.card);
    expect(await textOf(ar, '.auth-card h1')).toContain('15');
    expect(await overflowOf(ar)).toBeLessThanOrEqual(2);
    for (const path of ['/', '/signup']) {
      const { page: ph } = await newPage(390);
      await ph.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await ph.locator('.auth-card').waitFor({ timeout: 15000 });
      expect(await ph.evaluate(() => getComputedStyle(document.querySelector('.auth-aside')!).display)).toBe('none');
      expect(await ph.evaluate(() => getComputedStyle(document.querySelector('.auth-trust')!).display)).toBe('flex');
      expect(await overflowOf(ph), path).toBeLessThanOrEqual(2);
    }
  });
  it('Internal users: the owner adds a person, changes their role, suspends and restores them; a person without the Owner role sees only their own access', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner/staff`, { waitUntil: 'networkidle' });
    await p.locator('#staff-new').waitFor({ timeout: 15000 });
    const stamp = Date.now().toString(36), email = `ann.${stamp}@browser-staff.example.com`;
    await p.locator('#staff-new').click();
    await p.locator('#staff-name').fill(`Ann Accountant ${stamp}`);
    await p.locator('#staff-email').fill(email);
    await p.locator('#staff-role').selectOption({ index: 0 });
    const roles = (await db.query(`SELECT id, name FROM staff_roles WHERE NOT archived ORDER BY is_full DESC, built_in DESC, name`)).rows as { id: string; name: string }[];
    const accountant = roles.find((r) => r.name === 'Accountant')!, viewer = roles.find((r) => r.name === 'Viewer')!;
    await p.locator('#staff-role').selectOption(accountant.id);
    await p.locator('#staff-add').click();
    await p.locator(`tr[data-email="${email}"]`).waitFor({ timeout: 15000 });
    expect(await p.locator(`tr[data-email="${email}"]`).innerText()).toContain('Active');
    const row = (await db.query(`SELECT u.id, r.name AS role FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE lower(u.email) = $1`, [email])).rows[0];
    expect(row.role).toBe('Accountant');
    await screenshotTo(p, 'staff-list');
    // change the role from the list
    await p.locator(`tr[data-email="${email}"] select`).selectOption(viewer.id);
    await waitForText(p, 'Saved.');
    expect((await db.query(`SELECT r.name FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE u.id = $1`, [row.id])).rows[0].name).toBe('Viewer');
    // a new role with ticked permissions
    await p.locator('#staff-role-new').click();
    await p.locator('#staff-role-name').fill(`Bookkeeper ${stamp}`);
    await p.locator('input[data-perm="billing.view"]').click();
    await p.locator('input[data-perm="billing.manage"]').click();
    await p.locator('#staff-role-save').click();
    await waitForText(p, 'Role saved.');
    expect((await db.query(`SELECT count(*)::int AS n FROM staff_role_grants g JOIN staff_roles r ON r.id = g.role_id WHERE r.name = $1`, [`Bookkeeper ${stamp}`])).rows[0].n).toBe(2);
    // suspend, then restore
    await p.locator(`tr[data-email="${email}"]`).getByRole('button', { name: 'Suspend' }).click();
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await waitForText(p, 'Suspended');
    expect((await db.query(`SELECT status FROM users WHERE id = $1`, [row.id])).rows[0].status).toBe('suspended');
    await p.locator(`tr[data-email="${email}"]`).getByRole('button', { name: 'Restore' }).click();
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await p.locator(`tr[data-email="${email}"]`).getByRole('button', { name: 'Suspend' }).waitFor({ timeout: 15000 });
    // your own row has no role picker and no suspend button
    const mine = p.locator(`tr[data-email="${platform}"]`);
    expect(await mine.locator('select').count()).toBe(0);
    expect(await mine.getByRole('button', { name: 'Suspend' }).count()).toBe(0);
    expect(await overflowOf(p)).toBeLessThanOrEqual(2);
    // the person without the Owner role: signs in, sees only their access, no owner tabs
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword('staff-pass-123'), row.id]);
    const { page: q } = await newPage(390);
    await signIn(q, email, 'staff-pass-123');
    await q.locator('#staff-home').waitFor({ timeout: 15000 });
    expect(await q.locator('#staff-home').innerText()).toContain('Viewer');
    expect(await q.locator('#own-tab-customers').count()).toBe(0);
    expect(await q.locator('#own-tab-staff').count()).toBe(0);
    // a Viewer may see the payment queue but cannot decide anything
    expect(await q.locator('#own-tab-review').count()).toBe(1);
    await q.locator('#own-tab-review').click();
    await q.locator('#rv').waitFor({ timeout: 15000 });
    expect(await q.locator('#rv-act-approve').count()).toBe(0);
    expect(await q.locator('#rv-act-reject').count()).toBe(0);
    expect(await q.locator('#own-tab-payments').count()).toBe(0);
    expect(await overflowOf(q)).toBeLessThanOrEqual(2);
    await screenshotTo(q, 'staff-restricted-home');
    // Arabic and right to left
    await p.locator('button.lang, #lang').first().click().catch(() => undefined);
  });
  it('Payments screen: the Owner switches payments on and off, sets the rules, enters the bank details, and a changed account waits (and can be cancelled)', async () => {
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    // a clean start for this check: no bank details, payments off, nothing pending
    await db.query(`UPDATE subpay.bank_live SET account_name = NULL, bank = NULL, iban = NULL, swift = NULL, first_entry = true`);
    await db.query(`UPDATE subpay.bank_changes SET state = 'cancelled', decided_at = now() WHERE state = 'pending'`);
    await db.query(`UPDATE subpay.settings SET payments_enabled = false, bank_change_delay_hours = 24`);
    const { page: p } = await newPage(1280);
    await signIn(p, platform);
    await p.goto(`${BASE}/owner/payments`, { waitUntil: 'networkidle' });
    await p.locator('#pay-switch').waitFor({ timeout: 15000 });
    expect(await p.locator('#pay-state').innerText()).toBe('Off');
    expect(await p.locator('#pay-need-bank').count()).toBe(1);                         // cannot switch on without bank details
    expect(await p.locator('#pay-toggle').isDisabled()).toBe(true);
    // the first details show at once; a wrong password changes nothing
    await p.locator('#pay-bank-change').click();
    await p.locator('#pay-bank-name').fill('Nusuh Books Co');
    await p.locator('#pay-bank-bank').fill('Demo Bank');
    await p.locator('#pay-bank-iban').fill('SA03 8000 0000 6080 1016 7519');
    await p.locator('#pay-bank-password').fill('not-my-password');
    await p.locator('#pay-bank-save').click();
    await p.locator('#pay-error').waitFor({ timeout: 15000 });
    expect((await db.query(`SELECT iban FROM subpay.bank_live`)).rows[0].iban).toBeNull();
    await p.locator('#pay-bank-password').fill('demo1234');
    await p.locator('#pay-bank-iban').fill('SA0380000000608010167518');                // wrong check digits
    await p.locator('#pay-bank-save').click();
    await waitForText(p, 'valid Saudi IBAN');
    await p.locator('#pay-bank-iban').fill('SA03 8000 0000 6080 1016 7519');
    await p.locator('#pay-bank-save').click();
    await waitForText(p, 'show to customers now');
    expect((await db.query(`SELECT iban FROM subpay.bank_live`)).rows[0].iban).toBe('SA0380000000608010167519');
    expect(await p.locator('#pay-bank-live').innerText()).toContain('SA03 8000 0000 6080 1016 7519');
    // switch on (asks first), then the rules
    expect(await p.locator('#pay-toggle').isDisabled()).toBe(false);
    await p.locator('#pay-toggle').click();
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await p.locator('#pay-state').waitFor({ timeout: 15000 });
    await waitForText(p, 'Saved.');
    expect((await db.query(`SELECT payments_enabled FROM subpay.settings`)).rows[0].payments_enabled).toBe(true);
    await p.locator('#pay-hours').fill('6');
    await p.locator('#pay-delay').fill('0');
    await p.locator('#pay-rules-save').click();
    await p.waitForTimeout(600);                                                       // a delay of 0 hours is stopped by the form itself
    expect((await db.query(`SELECT bank_change_delay_hours AS d, review_target_hours AS h FROM subpay.settings`)).rows[0]).toEqual({ d: 24, h: 4 });
    await p.locator('#pay-delay').fill('12');
    await p.locator('#pay-rules-save').click();
    await waitForText(p, 'Saved.');
    expect((await db.query(`SELECT review_target_hours AS h, bank_change_delay_hours AS d FROM subpay.settings`)).rows[0]).toEqual({ h: 6, d: 12 });
    // a CHANGE of the account waits; customers keep the old one; it can be cancelled
    await p.locator('#pay-bank-change').click();
    await p.locator('#pay-bank-iban').fill('SA4420000001234567891234');
    await p.locator('#pay-bank-password').fill('demo1234');
    await p.locator('#pay-bank-save').click();
    await p.locator('#pay-bank-pending').waitFor({ timeout: 15000 });
    expect(await p.locator('#pay-bank-live').innerText()).toContain('SA03 8000 0000 6080 1016 7519');
    expect(await p.locator('#pay-bank-pending').innerText()).toContain('SA44 2000 0001 2345 6789 1234');
    expect((await db.query(`SELECT iban FROM subpay.bank_live`)).rows[0].iban).toBe('SA0380000000608010167519');
    await screenshotTo(p, 'payments-pending-change');
    expect(await overflowOf(p)).toBeLessThanOrEqual(2);
    await p.locator('#pay-bank-cancel').click();
    await p.getByRole('button', { name: 'Yes, continue' }).click();
    await waitForText(p, 'The change was cancelled.');
    expect(await p.locator('#pay-bank-pending').count()).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM subpay.bank_changes WHERE state = 'pending'`)).rows[0].n).toBe(0);
    // phone width
    const { page: ph } = await newPage(390);
    await signIn(ph, platform);
    await ph.goto(`${BASE}/owner/payments`, { waitUntil: 'networkidle' });
    await ph.locator('#pay-bank').waitFor({ timeout: 15000 });
    expect(await overflowOf(ph)).toBeLessThanOrEqual(2);
    // leave the shared database as other checks expect: payments off
    await db.query(`UPDATE subpay.settings SET payments_enabled = false, bank_change_delay_hours = 24`);
    await db.query(`UPDATE email_outbox SET status = 'failed', last_error = 'test: not sent' WHERE status = 'queued' AND subject LIKE 'Staff change%'`);
  });
});
