// What a person sees, in a real browser, on the demo data: the screens load, the numbers on them are right, the
// recent phases' features work end to end, Arabic reads right to left, a phone has no sideways scrolling, and one
// company cannot reach another's documents by changing an id.
//
// These run against the server and database started in globalSetup.ts. They are the check that a change to a screen
// cannot pass review just because the unit tests still pass.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { zipStored } from '../src/export/xlsx.ts';
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

  it('reads right to left in Arabic and fits a phone', async () => {
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
  it('has a letterhead, a clear table of what is charged, totals and a status, and no sideways scrolling on a phone', async () => {
    const inv = (await db.query(`SELECT id, number FROM billing_invoices ORDER BY created_at DESC LIMIT 1`)).rows[0] as { id: string; number: string } | undefined;
    if (!inv) return;   // the demo data has no billing invoice: nothing to look at
    const platform = (await db.query(`SELECT email FROM users WHERE kind = 'owner' AND status = 'active' LIMIT 1`)).rows[0].email as string;
    for (const width of [1280, 390]) {
      const { page: p } = await newPage(width);
      await signIn(p, platform);
      await p.goto(`${BASE}/owner/billing/${inv.id}`, { waitUntil: 'networkidle' });
      await waitForText(p, inv.number);
      const text = await p.locator('.binv').innerText();
      for (const want of ['TAX INVOICE', 'Description', 'Amount', 'Subtotal', 'Total']) expect(text.toUpperCase(), want).toContain(want.toUpperCase());
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await screenshotTo(p, `billing-invoice-${width}`);
    }
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
    await p.locator('#wiz-added').waitFor({ timeout: 15000 });
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
    expect((await db.query('SELECT tour_seen FROM trial_setup WHERE firm_id = $1', [firm])).rows[0].tour_seen).toContain('Home');
    await screenshotTo(p, 'setup-guide');
    // run it again, in Arabic
    await p.locator('#guide-setup').click();
    await p.locator('#wiz').waitFor();
    await p.locator('#wiz').getByRole('button', { name: 'EN | AR' }).click();
    await p.waitForTimeout(800);
    expect(await p.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await text(p, '#wiz-title')).toBe('لنُعدّ شركتك');
    await screenshotTo(p, 'setup-wizard-arabic');
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
