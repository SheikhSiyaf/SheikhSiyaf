// Real-browser checks (Playwright, if installed) against the built site served by PHP, with a fake Resend.
// Skipped automatically when Playwright or PHP is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* not installed */ }
const hasPhp = spawnSync('php', ['-v']).status === 0;
const skip = (!chromium || !hasPhp) ? 'needs playwright and php' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-browser-'));
const sent = path.join(tmp, 'sent.jsonl');
const PORT = 19000 + Math.floor(Math.random() * 500), FAKE = PORT + 1000;
let app, fake, browser;
const fakeRouter = path.join(tmp, 'fake.php');
fs.writeFileSync(fakeRouter, `<?php file_put_contents(${JSON.stringify(sent)}, json_encode(json_decode(file_get_contents('php://input'), true)) . "\\n", FILE_APPEND); header('Content-Type: application/json'); echo '{"id":"x"}';`);
const mails = () => (fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = async (port) => { for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('no server'); };

before(async () => {
  if (skip) return;
  fs.cpSync(path.join(ROOT, 'dist'), path.join(tmp, 'site'), { recursive: true });
  fake = spawn('php', ['-S', `127.0.0.1:${FAKE}`, fakeRouter], { stdio: 'ignore' });
  app = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', path.join(tmp, 'site')], { stdio: 'ignore', env: { ...process.env, RESEND_API_KEY: 'k', MAIL_FROM: 'S <s@example.test>', RESEND_API_URL: `http://127.0.0.1:${FAKE}/e`, RATE_DIR: path.join(tmp, 'rate') } });
  await Promise.all([wait(FAKE), wait(PORT)]);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); app?.kill(); fake?.kill(); });

const open = async (url, w = 1360) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: 'load' });
  return { page, ctx, errors };
};

test('order: pick modules, live total, details, place order, e-mail carries the server total', { skip }, async () => {
  const { page, ctx, errors } = await open('/order/');
  await page.evaluate(() => localStorage.setItem('nb-consent', 'declined'));
  assert.equal(await page.locator('[data-one-time]').innerText(), 'SAR 9,000');
  await page.click('[data-module="Inventory"]');
  await page.click('[data-module="Rooms"]');
  await page.click('[data-cleanup]');
  assert.equal(await page.locator('[data-one-time]').innerText(), 'SAR 14,000');
  assert.equal(await page.locator('[data-yearly]').innerText(), 'SAR 2,500 / year');
  assert.equal(await page.locator('[data-module="Inventory"]').getAttribute('aria-pressed'), 'true');
  await page.click('[data-pay]');
  assert.ok(await page.locator('#cart-step2').isVisible());
  assert.ok(!(await page.locator('#cart-step1').isVisible()));
  await page.click('#cart-step2 button[type=submit]');                       // empty: refused in the browser
  assert.ok(await page.locator('#cart-step2 [data-error]').isVisible());
  assert.equal(await page.locator('input[name=company]').getAttribute('aria-invalid'), 'true');
  const before = mails().length;
  await page.fill('input[name=company]', 'Browser Test Co');
  await page.fill('input[name=email]', 'buyer@example.com');
  await page.click('#cart-step2 button[type=submit]');
  await page.waitForSelector('#cart-done', { state: 'visible' });
  assert.equal(mails().length, before + 1);
  const t = mails().at(-1).text;
  assert.match(t, /One-time total: SAR 14,000/); assert.match(t, /Yearly total: SAR 2,500/); assert.match(t, /Browser Test Co/);
  assert.match(await page.locator('#cart-done').innerText(), /Our bank details|We send our bank details/);   // fallback while bank details are empty
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('contact form: validation message, then success; nothing leaves the browser except to this site', { skip }, async () => {
  const { page, ctx, errors } = await open('/contact/');
  const external = []; page.on('request', (r) => { if (!r.url().startsWith(`http://127.0.0.1:${PORT}`)) external.push(r.url()); });
  await page.click('form[data-form=contact] button[type=submit]');
  assert.ok(await page.locator('form[data-form=contact] [data-error]').isVisible());
  await page.fill('form[data-form=contact] input[name=name]', 'Layla');
  await page.fill('form[data-form=contact] input[name=email]', 'layla@example.com');
  await page.fill('form[data-form=contact] textarea[name=message]', 'Can you show me the hotel setup?');
  const n = mails().length;
  await page.click('form[data-form=contact] button[type=submit]');
  await page.waitForSelector('form[data-form=contact] [data-ok]', { state: 'visible' });
  assert.equal(mails().length, n + 1);
  assert.equal(mails().at(-1).reply_to, 'layla@example.com');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await ctx.close();
});

test('demo and payment-confirmation forms deliver', { skip }, async () => {
  let { page, ctx } = await open('/book-a-demo/');
  await page.fill('form[data-form=demo] input[name=name]', 'Omar');
  await page.fill('form[data-form=demo] input[name=email]', 'omar@example.com');
  await page.fill('form[data-form=demo] input[name=company]', 'Steel trading');
  let n = mails().length;
  await page.click('form[data-form=demo] button[type=submit]');
  await page.waitForSelector('form[data-form=demo] [data-ok]', { state: 'visible' });
  assert.equal(mails().length, n + 1);
  await ctx.close();
  ({ page, ctx } = await open('/confirm-payment/'));
  const f = 'form[data-form=payment]';
  await page.fill(`${f} input[name=company]`, 'Gulf Steel'); await page.fill(`${f} input[name=email]`, 'ap@example.com');
  await page.fill(`${f} input[name=invoice]`, 'INV-7'); await page.fill(`${f} input[name=amount]`, '10500'); await page.fill(`${f} input[name=date]`, '2026-11-20');
  await page.setInputFiles(`${f} input[name=receipt]`, { name: 'r.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
  n = mails().length;
  await page.click(`${f} button[type=submit]`);
  await page.waitForSelector(`${f} [data-ok]`, { state: 'visible' });
  assert.equal(mails().length, n + 1);
  assert.equal(mails().at(-1).attachments.length, 1);
  await ctx.close();
});

test('cookie notice: shown, Decline hides it and the choice is remembered', { skip }, async () => {
  const { page, ctx } = await open('/');
  assert.ok(await page.locator('#cookie-banner').isVisible());
  await page.click('[data-consent=declined]');
  assert.ok(!(await page.locator('#cookie-banner').isVisible()));
  assert.equal(await page.evaluate(() => localStorage.getItem('nb-consent')), 'declined');
  assert.deepEqual(await ctx.cookies(), [], 'the site must set no cookies');
  await page.reload();
  assert.ok(!(await page.locator('#cookie-banner').isVisible()));
  await ctx.close();
});

test('phone: menu opens with the keyboard, closes with Escape; FAQ opens; no sideways scroll', { skip }, async () => {
  const { page, ctx } = await open('/faq/', 390);
  await page.evaluate(() => localStorage.setItem('nb-consent', 'declined'));
  await page.focus('details.menu > summary');
  await page.keyboard.press('Enter');
  assert.ok(await page.locator('details.menu[open]').count());
  assert.ok(await page.locator('details.menu .panel a.l').first().isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('details.menu[open]').count(), 0);
  await page.locator('details.faq > summary').first().click();
  assert.ok(await page.locator('details.faq[open]').count());
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.equal(w[0], w[1]);
  await ctx.close();
});
