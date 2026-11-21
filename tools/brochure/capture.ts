// Takes the brochure screenshots from the real app, running against the throwaway brochure database.
//   npx tsx tools/brochure/capture.ts            all screens, desktop and mobile
//   npx tsx tools/brochure/capture.ts sales      only screens whose name contains "sales"
// It starts the app in this process (no outside calls, no e-mail, no ZATCA), signs in as the right demo user for each
// screen, takes the top of the page, checks the picture, retries once, and writes output/manifest.json and
// output/contact-sheet.html. Demo passwords are read from the state file and never printed.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildServer, WEB_DIST } from '../../src/api/server.js';
import { createPool } from '../../src/db/session.js';
import * as Email from '../../src/books/emailService.js';
import { readState, urlFor, ownerEmail } from './seed.js';

const PORT = Number(process.env.BROCHURE_PORT ?? 3188);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.BROCHURE_OUT ?? join(process.cwd(), 'tools/brochure/output');
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
} as const;
type VP = keyof typeof VIEWPORTS;

interface Screen { base: string; group: string; company: string; user: string | null; route: string; language: string; status: string; note?: string; pick?: Record<string, string> }
// Where "a client with ..." in the manifest means a specific demo company.
const FIRM_PICKS: Record<string, string> = { 'module-review': 'gulf', 'firms-02-month-end-review': 'corniche', 'firms-03-period-lock': 'gulf' };

const require_ = createRequire(import.meta.url);
function loadPlaywright(): { chromium: { launch(o: object): Promise<any> } } {
  for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node-tools/node_modules/playwright/index.js'].filter(Boolean) as string[]) {
    try { return require_(p as string); } catch { /* next */ }
  }
  throw new Error('Playwright was not found (set PLAYWRIGHT_PATH).');
}

async function settle(page: any) {
  await page.addStyleTag({ content: '.help-fab,.help-panel,.toast,.cookie,.fab-badge{display:none !important} *{caret-color:transparent !important} html{scroll-behavior:auto !important}' }).catch(() => undefined);
  for (let i = 0; i < 60; i++) { if ((await page.locator('[aria-busy="true"]').count()) === 0) break; await page.waitForTimeout(250); }
  await page.evaluate(async () => { await (document as any).fonts?.ready; window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur?.(); });
  await page.waitForTimeout(500);
}

/** Why a picture should not be used, or an empty list when it looks right. */
async function verify(page: any, file: string): Promise<string[]> {
  const why: string[] = [];
  if (statSync(file).size < 40_000) why.push('the image is nearly blank');
  if (await page.locator('input[type="password"]').count()) why.push('login screen');
  if (await page.locator('.notice.bad, [role="alert"]').count()) why.push(`error message: ${(await page.locator('.notice.bad, [role="alert"]').first().innerText().catch(() => '')).slice(0, 80)}`);
  const text: string = await page.evaluate(() => document.body.innerText);
  if (/\bundefined\b|\bNaN\b|\[object /.test(text)) why.push('placeholder text such as undefined or NaN');
  const tables = await page.evaluate(() => [...document.querySelectorAll('table')].filter((t) => t.offsetParent !== null).map((t) => t.querySelectorAll('tbody tr').length));
  if (tables.length && tables.every((n: number) => n === 0)) why.push('empty table');
  return why;
}

/** Small steps that make a screen look as it does in use: hide the first-run checklist, start a sale on the till, one day's takings. */
async function prepare(page: any, base: string) {
  try {
    if (/-home$/.test(base)) {
      const hide = page.locator('button.link', { hasText: /^(Hide|إخفاء)$/ });
      if (await hide.count()) { await hide.first().click(); await page.waitForTimeout(300); }
    }
    if (['module-restaurant', 'restaurants-02-till-open-orders', 'hotels-04-restaurant-till'].includes(base)) {
      await page.getByRole('button', { name: /New sale/ }).first().click();
      await page.waitForSelector('.menu-tile', { timeout: 10_000 });
      for (const i of [0, 3, 8, 12, 3, 15]) await page.locator('.menu-tile').nth(i).click();
      await page.waitForTimeout(400);
    }
    if (base === 'restaurants-04-daily-takings') {
      const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await page.locator('input[type="date"]').nth(0).fill(y);
      await page.locator('input[type="date"]').nth(1).fill(y);
      await page.waitForLoadState('networkidle');
    }
    await settle(page);
  } catch { /* the check below reports anything that did not work */ }
}

async function main() {
  const state = readState();
  if (!state) throw new Error('No brochure data: run `npx tsx tools/brochure/seed.ts` first.');
  const filter = process.argv[2] ?? '';
  const screens: Screen[] = (JSON.parse(readFileSync('tools/brochure/screens.json', 'utf8')) as { screens: Screen[] }).screens.filter((s) => s.base.includes(filter));
  if (!existsSync(WEB_DIST)) throw new Error('The web app is not built. Run `npm run build` first.');

  const pool = createPool(urlFor('nusuh_app', state.appPassword));
  const server = buildServer({ pool, sessionSecret: randomBytes(24).toString('hex'), production: false, publicUrl: BASE, cookieSecure: false, demoLogins: false, staticDir: WEB_DIST });
  await server.listen({ port: PORT, host: '127.0.0.1' });
  const admin = new pg.Client({ connectionString: urlFor() });
  await admin.connect();

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--no-sandbox'] });
  const contexts = new Map<string, any>();
  const pageFor = async (email: string | null, vp: VP, lang: string) => {
    const key = `${email}|${vp}|${lang}`;
    if (contexts.has(key)) return contexts.get(key);
    const ctx = await browser.newContext({ ...VIEWPORTS[vp], locale: lang === 'ar' ? 'ar-SA' : 'en-US', timezoneId: 'Asia/Riyadh' });
    await ctx.addInitScript((l: string) => { try { localStorage.setItem('nb.lang', l); localStorage.setItem('nb.theme', 'light'); } catch { /* none */ } }, lang);
    if (email) {
      const r = await ctx.request.post(`${BASE}/api/login`, { data: { email, password: state.passwords[email] } });
      if (!r.ok()) throw new Error(`Sign-in failed for a demo user (HTTP ${r.status()})`);
    }
    const page = await ctx.newPage();
    contexts.set(key, page);
    return page;
  };

  const results: object[] = [];
  const emailOf = (s: Screen) => (s.user === 'owner' ? ownerEmail(s.company) : s.user === 'partner' ? 'partner@amal.example' : s.user === 'admin' ? 'admin@amal.example' : null);
  const companyOf = (s: Screen) => FIRM_PICKS[s.base] ?? s.company;
  for (const s of screens) {
    const ck = companyOf(s);
    const facts = state.facts[ck] ?? {};
    let route = s.route.replace('{company}', state.companies[ck] ?? '').replace('{invoice}', facts.invoiceId ?? '').replace('{bank}', facts.bankId ?? '')
      .replace('{contract}', facts.contractId ?? '').replace('{booking}', facts.bookingId ?? '').replace('{po}', facts.poId ?? '');
    if (route.includes('{payrun}')) route = route.replace('{payrun}', (await admin.query('SELECT id FROM payroll_runs WHERE company_id = $1 ORDER BY period_end DESC LIMIT 1', [state.companies[ck]])).rows[0].id);
    if (route.includes('{token}')) {
      await admin.query("SELECT set_config('app.user_id', $1, false)", [state.users[ownerEmail('gulf')]]);
      route = route.replace('{token}', await Email.documentLink(admin as never, state.facts.gulf!.openInvoiceId!));
    }
    for (const vp of Object.keys(VIEWPORTS) as VP[]) {
      const dir = join(OUT, s.group);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${s.base}-${vp === 'desktop' ? 'desktop' : 'mobile'}.png`);
      const page = await pageFor(emailOf(s), vp, s.language);
      let why: string[] = [], attempts = 0;
      for (attempts = 1; attempts <= 2; attempts++) {
        try {
          await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 45_000 });
          await settle(page);
          await prepare(page, s.base);
          await page.screenshot({ path: file, fullPage: false });
          why = await verify(page, file);
        } catch (e) { why = [`could not capture: ${(e instanceof Error ? e.message : 'error').split('\n')[0]}`]; }
        if (!why.length) break;
      }
      results.push({ file: `${s.group}/${s.base}-${vp}.png`, base: s.base, group: s.group, viewport: vp, route: route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\/i\/[\w-]+/, '/i/<token>'), user: s.user, language: s.language, passed: why.length === 0, problems: why, attempts, substitute: s.status === 'substitute' ? s.note ?? 'substitute' : null });
      console.log(`${why.length ? 'FAIL' : 'ok  '} ${s.base} ${vp}${why.length ? ` : ${why.join('; ')}` : ''}`);
    }
  }
  await browser.close();
  await server.close();
  await pool.end();
  await admin.end();

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), note: 'Fictional demo data only; e-invoicing unconnected. Screens marked substitute differ from the brief (see substitute).', screens: results }, null, 1));
  const cards = (results as { file: string; passed: boolean; problems: string[]; substitute: string | null }[]).map((r) =>
    `<figure class="${r.passed ? '' : 'bad'}"><img loading="lazy" src="${r.file}" alt="${r.file}"><figcaption>${r.file}${r.passed ? '' : ` — ${r.problems.join('; ')}`}${r.substitute ? ` — substitute: ${r.substitute}` : ''}</figcaption></figure>`).join('\n');
  writeFileSync(join(OUT, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8"><title>Nusuh Books brochure screenshots</title><style>body{font:14px system-ui;margin:16px;background:#f4f4f4}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}figure{margin:0;background:#fff;padding:8px;border-radius:8px}figure.bad{outline:3px solid #c33}img{width:100%;height:auto;display:block;border:1px solid #ddd}figcaption{font-size:12px;word-break:break-all;margin-top:6px}</style><h1>Nusuh Books: brochure screenshots</h1><p>Fictional demo data. ${results.length} images.</p><main>\n${cards}\n</main>`);
  const bad = (results as { passed: boolean }[]).filter((r) => !r.passed).length;
  console.log(`\n${results.length - bad} of ${results.length} passed${bad ? `, ${bad} need attention` : ''}.`);
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
