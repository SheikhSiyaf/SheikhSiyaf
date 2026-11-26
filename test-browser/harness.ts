// The browser checks: what a person actually sees, driven through a real Chromium.
//
// These are deliberately separate from `npm test`. The unit and rule tests talk to the database and must stay fast
// enough to run constantly; these build the web app, start the server and drive the screens, which is slower and
// needs a browser. CI runs both (.github/workflows/ci.yml).
//
// Playwright is resolved at run time rather than imported, because where it lives differs between a developer's
// machine, this project's node_modules and a cloud session that has it pre-installed. PLAYWRIGHT_PATH and
// CHROMIUM_PATH override the search when needed.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { FAKE_GOOGLE_SCRIPT, signFakeGoogleToken, type FakeGoogleUser } from './googleDouble.js';

export const BASE = `http://127.0.0.1:${process.env.BROWSER_TEST_PORT ?? 3177}`;

/** Only the small part of Playwright these checks use, so the suite type-checks without its types installed. */
export interface Page {
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): Loc;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): Loc;
  evaluate<T>(fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  reload(o?: { waitUntil?: string }): Promise<unknown>;
  route(url: string, handler: (r: { fulfill(o: { contentType: string; body: string }): Promise<void> }) => unknown): Promise<void>;
  exposeFunction(name: string, fn: (...a: never[]) => unknown): Promise<void>;
  on(event: string, fn: (x: { type(): string; text(): string; message?: string }) => void): void;
  url(): string;
}
export interface Loc {
  fill(value: string): Promise<void>;
  click(o?: { force?: boolean }): Promise<void>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  count(): Promise<number>;
  first(): Loc;
  last(): Loc;
  nth(n: number): Loc;
  selectOption(value: string | { index: number }): Promise<unknown>;
  waitFor(o?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
}
interface Browser {
  newContext(o: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<{ newPage(): Promise<Page> }>;
  close(): Promise<void>;
}
interface Chromium { launch(o?: { executablePath?: string }): Promise<Browser> }

const require_ = createRequire(import.meta.url);
const CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  'playwright',                                            // the project's own dependency (CI installs it)
  '/opt/node-tools/node_modules/playwright/index.js',       // pre-installed in a cloud session
  '/opt/node22/lib/node_modules/playwright/index.mjs',
].filter(Boolean) as string[];

/** Where Chromium is: a pre-installed one when it exists, otherwise whatever Playwright downloaded for itself. */
function chromiumPath(): string | undefined {
  for (const p of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].filter(Boolean) as string[]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

let browser: Browser | undefined;

export async function openBrowser(): Promise<Browser> {
  if (browser) return browser;
  let chromium: Chromium | undefined;
  const tried: string[] = [];
  for (const c of CANDIDATES) {
    try {
      chromium = ((await import(c.startsWith('/') ? c : require_.resolve(c))) as { chromium: Chromium }).chromium;
      break;
    } catch (e) { tried.push(`${c}: ${(e as Error).message.split('\n')[0]}`); }
  }
  if (!chromium) {
    throw new Error(`Playwright was not found. Set PLAYWRIGHT_PATH, or run "npm install". Tried:\n  ${tried.join('\n  ')}`);
  }
  const executablePath = chromiumPath();
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  return browser;
}
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

/** A page, with every console error and page error collected so a check can insist there were none. */
export async function newPage(width = 1280): Promise<{ page: Page; errors: string[] }> {
  const b = await openBrowser();
  // deviceScaleFactor is left alone on a phone width: a screenshot nobody looks at does not need to be sharp.
  const ctx = await b.newContext({ viewport: { width, height: 1000 }, ...(width > 500 ? { deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  // Google is never contacted: its script is replaced by a stand-in that signs a token for whoever the check names (test-browser/googleDouble.ts).
  await page.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_GOOGLE_SCRIPT }));
  await page.exposeFunction('__googleToken', ((nonce: string, who: FakeGoogleUser) => signFakeGoogleToken(nonce, who)) as never);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message ?? String(e)));
  return { page, errors };
}

/** Calls the API from inside the page, so the session cookie goes with it. */
export function call(page: Page, url: string, body?: unknown, method?: string): Promise<{ status: number; json?: unknown; text?: string }> {
  return page.evaluate(async ([u, b, m]: never) => {
    const h: Record<string, string> = {};
    if (b) h['content-type'] = 'application/json';
    const r = await fetch(u as string, { method: (m as string) ?? (b ? 'POST' : 'GET'), headers: h, body: b ? JSON.stringify(b) : undefined, credentials: 'include' });
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text: text.slice(0, 300) }; }
  }, [url, body ?? null, method ?? null]);
}

/** Waits for text to appear on the page. The screens fill in after the first paint, so a check that reads the body
 *  the moment a page loads is a race: it passed or failed depending on the machine's mood. */
export async function waitForText(page: Page, text: string, ms = 15_000): Promise<string> {
  const until = Date.now() + ms;
  let body = '';
  for (;;) {
    body = await page.locator('body').innerText();
    if (body.includes(text)) return body;
    if (Date.now() > until) throw new Error(`"${text}" never appeared. The page showed:\n${body.slice(0, 600)}`);
    await page.waitForTimeout(250);
  }
}

/** Where a failed check leaves its screenshot, so CI can keep it and a person can see what the screen looked like. */
export const OUTPUT_DIR = new URL('./output/', import.meta.url).pathname;
export async function screenshotTo(page: Page, name: string): Promise<string> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${name.replace(/[^\w.-]+/g, '-').slice(0, 80)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export async function signIn(page: Page, email: string, password = 'demo1234'): Promise<void> {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.side').first().waitFor({ timeout: 30_000 });
}
