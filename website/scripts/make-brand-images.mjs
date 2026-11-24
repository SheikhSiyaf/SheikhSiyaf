// Regenerates public/assets/logo.png and og-default.png from the logo in the design.
// Needs Playwright (already installed in this environment): node scripts/make-brand-images.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nav = fs.readFileSync(path.join(ROOT, 'src/partials/nav.html'), 'utf8');
const [mark, wordmark] = nav.match(/<svg[\s\S]*?<\/svg>/g);
const fonts = (n) => `file://${ROOT}/public/fonts/${n}.woff2`;
const css = `
@font-face{font-family:J;font-weight:800;src:url(${fonts('plus-jakarta-sans-latin-800-normal')})}
@font-face{font-family:I;font-weight:400;src:url(${fonts('inter-latin-400-normal')})}
body{margin:0;width:1200px;height:630px;box-sizing:border-box;padding:72px;color:#fff;font-family:I;
background:radial-gradient(55% 75% at 88% 18%,rgba(20,163,153,.62),rgba(20,163,153,0) 62%),radial-gradient(45% 55% at 62% 108%,rgba(94,234,212,.26),rgba(94,234,212,0) 70%),linear-gradient(165deg,#0A3A42,#06222B 48%,#041820);display:flex;flex-direction:column;justify-content:space-between}
h1{font:800 76px/1.02 J;letter-spacing:-.035em;margin:0;max-width:900px}h1 span{color:#5EEAD4}
.logo{display:flex;align-items:center;gap:14px}.logo svg:first-child{width:56px;height:56px}.logo .wm{height:28px;width:auto}
p{margin:0;font-size:28px;color:rgba(255,255,255,.8)}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(`<style>${css}</style><div class="logo">${mark}${wordmark}</div><h1>Close every month on <span>one set of books.</span></h1><p>Built for ZATCA Phase 2 · Arabic and English</p>`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(ROOT, 'public/assets/og-default.png') });
const p2 = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await p2.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#06222B"/><path d="M29 74V28L71 74V30" fill="none" stroke="#FFFFFF" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="71" cy="29" r="8.5" fill="#F5B942"/></svg>`);
await p2.screenshot({ path: path.join(ROOT, 'public/assets/logo.png'), omitBackground: true });
await browser.close();
console.log('brand images written');
