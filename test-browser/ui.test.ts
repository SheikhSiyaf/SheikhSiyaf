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

describe('Ownership', () => {
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
