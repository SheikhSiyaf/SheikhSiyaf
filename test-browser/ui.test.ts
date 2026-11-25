// What a person sees, in a real browser, on the demo data: the screens load, the numbers on them are right, the
// recent phases' features work end to end, Arabic reads right to left, a phone has no sideways scrolling, and one
// company cannot reach another's documents by changing an id.
//
// These run against the server and database started in globalSetup.ts. They are the check that a change to a screen
// cannot pass review just because the unit tests still pass.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
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

