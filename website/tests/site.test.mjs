// Checks on the built site (run `npm run build` first; `npm test` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
const site = j('site.json'), admin = j('admin-data.json'), pricing = j('pricing.json');

function pagesList() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'api') walk(p); } else if (e.name === 'index.html') out.push(p);
    }
  })(DIST);
  return out.map((f) => ({ file: f, url: '/' + path.relative(DIST, path.dirname(f)).replace(/\\/g, '/') + (path.relative(DIST, path.dirname(f)) ? '/' : ''), html: fs.readFileSync(f, 'utf8') }));
}
const pages = pagesList();
const textOf = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('all 45 pages the brief asks for exist', () => {
  assert.equal(pages.length, 45);
  for (const u of ['/', '/modules/', '/industries/', '/for-firms/', '/pricing/', '/about/', '/security/', '/faq/', '/contact/', '/book-a-demo/', '/order/', '/how-to-pay/', '/confirm-payment/', '/legal/', '/legal/privacy/', '/legal/cookies/', '/legal/website-terms/', '/legal/terms/', '/legal/dpa/', '/legal/acceptable-use/', '/legal/disclaimer/', '/legal/security-measures/']) assert.ok(pages.find((p) => p.url === u), 'missing ' + u);
  assert.equal(pages.filter((p) => p.url.startsWith('/modules/') && p.url !== '/modules/').length, 16);
  assert.equal(pages.filter((p) => p.url.startsWith('/industries/') && p.url !== '/industries/').length, 7);
});

test('there is no login or free-trial page of our own', () => {
  for (const u of ['/login/', '/log-in/', '/signup/', '/sign-up/', '/trial/', '/start-free-trial/', '/free-trial/']) assert.ok(!fs.existsSync(path.join(DIST, u)), u);
});

test('every page has one h1, a unique title and description, a canonical URL and Open Graph tags', () => {
  const titles = new Set(), descs = new Set();
  for (const p of pages) {
    assert.equal((p.html.match(/<h1[\s>]/g) || []).length, 1, `${p.url} h1 count`);
    const t = p.html.match(/<title>(.*?)<\/title>/)[1], d = p.html.match(/<meta name="description" content="(.*?)">/)[1];
    assert.ok(t.length > 5 && d.length > 20, p.url);
    assert.ok(!titles.has(t), `duplicate title ${t}`); titles.add(t);
    assert.ok(!descs.has(d), `duplicate description on ${p.url}`); descs.add(d);
    assert.ok(p.html.includes(`<link rel="canonical" href="${site.url}${p.url}">`), `${p.url} canonical`);
    assert.ok(p.html.includes('property="og:image"') && p.html.includes('og:title') && p.html.includes('name="twitter:card"'), p.url);
    assert.ok(p.html.includes('<main id="main">') && p.html.includes('<footer') && p.html.includes('<header class="nav'), `${p.url} landmarks`);
    assert.ok(p.html.includes('<html lang="en" dir="ltr">'), p.url);
  }
});

test('every internal link and image resolves to a built file', () => {
  const exists = (u) => { const f = path.join(DIST, u.split('#')[0].split('?')[0]); return fs.existsSync(f) && (fs.statSync(f).isFile() || fs.existsSync(path.join(f, 'index.html'))); };
  for (const p of pages) {
    for (const m of p.html.matchAll(/(?:href|src|srcset)="(\/[^"]*)"/g)) assert.ok(exists(m[1]), `${p.url} -> ${m[1]}`);
    assert.ok(!/\.dc\.html|<sc-|\{\{/.test(p.html), `${p.url} has an unresolved design marker`);
  }
});

test('images have alt text, width and height, and lazy-load below the fold', () => {
  for (const p of pages) {
    const imgs = [...p.html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    imgs.forEach((i, n) => {
      assert.ok(/ alt="[^"]+"/.test(i), `${p.url} image without alt: ${i.slice(0, 80)}`);
      assert.ok(/ width="\d+"/.test(i) && / height="\d+"/.test(i), `${p.url} image without size`);
      if (n >= 2 && !i.includes('fetchpriority="low"')) assert.ok(i.includes('loading="lazy"'), `${p.url} image ${n} should be lazy`);
    });
  }
});

test('sign-up and log-in buttons all go to the one app address, in the same tab', () => {
  const app = admin.appUrl;
  for (const p of pages) {
    for (const m of p.html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)) {
      const label = m[2].replace(/<[^>]+>/g, '').trim();
      if (/^(Log in|Start free trial|Start your \d+-day free trial|Start my \d+-day free trial|Start free trial instead|Start free 15-day trial)/i.test(label) || /^Or start the/.test(label)) {
        assert.ok(m[1].includes(`href="${app}"`), `${p.url}: "${label}" -> ${m[1]}`);
        assert.ok(!/target=/.test(m[1]), `${p.url}: "${label}" opens a new tab`);
      }
    }
    assert.ok(!/nusuh-demo|onrender\.com/.test(p.html), `${p.url} points at a demo address`);
  }
});

test('business facts come from config: phone, WhatsApp, email, support hours, prices', () => {
  const home = pages.find((p) => p.url === '/').html;
  assert.ok(home.includes(`href="mailto:${site.contact.email}"`));
  assert.ok(home.includes(`href="tel:${site.contact.phoneE164}"`));
  assert.ok(home.includes(`href="https://wa.me/${site.contact.whatsappNumber}"`));
  const pr = textOf(pages.find((p) => p.url === '/pricing/').html);
  const f = (n) => `${pricing.currency} ${n.toLocaleString('en-US')}`;
  for (const s of [f(pricing.implementation), f(pricing.cleanup), f(pricing.annualCore), f(pricing.perModule), f(pricing.annualCore + 2 * pricing.perModule), f(pricing.implementation + pricing.cleanup)]) assert.ok(pr.includes(s), `pricing page lacks ${s}`);
  const contact = textOf(pages.find((p) => p.url === '/contact/').html);
  assert.ok(contact.includes(`${site.support.hours}, Saudi Arabia time`), 'office hours');
});

test('legal rules: only the Phase 2 wording, none of the banned claims', () => {
  const banned = [/\bGOSI\b/, /\bWPS\b/, /\bMudad\b/i, /balance[- ]sheet/i, /table service/i, /\bstock[- ]?counts?\b/i, /new company/i, /in development/i, /ZATCA[^.]{0,40}\b(cleared|clearance|certified|approved|accredited)\b/i, /\bAI[- ]generated\b/i];
  for (const p of pages) {
    const t = textOf(p.html);
    for (const re of banned) {
      if (re.source.includes('AI') && (p.url === '/legal/disclaimer/' || p.url === '/legal/')) continue; // the AI-imagery disclosure lives only on the legal pages
      if (/ZATCA\[/.test(re.source) && p.url.startsWith('/legal/')) continue;                    // legal text states what it does NOT claim
      assert.ok(!re.test(t), `${p.url} matches ${re}`);
    }
  }
  assert.ok(textOf(pages.find((p) => p.url === '/').html).includes('Built for ZATCA Phase 2'));
});

test('company registration details come from config; dummy values are flagged', () => {
  const priv = textOf(pages.find((p) => p.url === '/legal/privacy/').html);
  assert.ok(priv.includes(admin.company.cr));
  const src = fs.readdirSync(path.join(ROOT, 'src', 'pages')).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'pages', f), 'utf8')).join('\n');
  assert.ok(!src.includes('300000000000003') && !/\b0000000000\b/.test(src), 'CR/VAT must not be written into page sources');
  assert.ok(admin.company._TODO, 'the TODO marker must stay in admin-data.json');
});

test('the dummy-details guard stops a production build', async () => {
  const { spawnSync } = await import('node:child_process');
  const dummy = admin.company.cr === '0000000000' || admin.company.vat === '300000000000003';
  if (!dummy) return;
  const r = spawnSync('node', ['scripts/build.mjs', '--production'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BUILD REFUSED/);
  spawnSync('node', ['scripts/build.mjs'], { cwd: ROOT }); // restore dist for the other tests
});

test('bank details and testimonials stay hidden while empty', () => {
  const pay = textOf(pages.find((p) => p.url === '/how-to-pay/').html);
  const filled = Object.values(admin.bank).filter((v) => typeof v === 'string' && v && !v.startsWith('_')).length;
  if (filled === 0) {
    assert.ok(pay.includes('Our bank details are on your invoice.'));
    assert.ok(!/IBAN|SWIFT/.test(pay));
  }
  if (!admin.testimonials.length) for (const p of pages) assert.ok(!p.html.includes('tm-wrap'), `${p.url} shows an empty testimonials strip`);
});

test('the site loads nothing from other websites', () => {
  const ok = /^(https:\/\/(nusuhbooks\.com|app\.nusuhbooks\.com|wa\.me|schema\.org|www\.w3\.org)|http:\/\/www\.w3\.org)/;
  for (const p of pages) for (const m of p.html.matchAll(/(?:src|srcset|href)="(https?:\/\/[^"]+)"/g)) assert.match(m[1], ok, `${p.url} loads ${m[1]}`);
  for (const f of ['css/base.css', 'css/home.css', 'css/extra.css']) assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(fs.readFileSync(path.join(DIST, f), 'utf8').replace(/url\(data:[^)]*\)/g, '')), f);
});

test('sitemap lists every page; robots points at it; headers file has the required security headers', () => {
  const sm = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
  for (const p of pages) assert.ok(sm.includes(`<loc>${site.url}${p.url}</loc>`), p.url);
  assert.match(fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/nusuhbooks\.com\/sitemap\.xml/);
  const ht = fs.readFileSync(path.join(DIST, '.htaccess'), 'utf8');
  for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy']) assert.ok(ht.includes(h), h);
});

test('FAQ items are real <details> elements and the mobile menu is a <details> (keyboard accessible)', () => {
  const faq = pages.find((p) => p.url === '/faq/').html;
  assert.ok((faq.match(/<details class="faq[ "]/g) || []).length >= 5);
  assert.ok(pages[0].html.includes('<details class="menu"'));
});

test('no secrets in the repository sources', () => {
  const bad = /re_[A-Za-z0-9]{20,}|sk_live|api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/i;
  for (const d of ['src', 'config', 'api', 'public', 'scripts']) (function walk(x) {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(html|json|php|js|mjs|css|example|md|txt)$/.test(e.name)) assert.ok(!bad.test(fs.readFileSync(p, 'utf8')), p);
    }
  })(path.join(ROOT, d));
  assert.ok(!fs.existsSync(path.join(DIST, 'api', 'config.local.php')));
});
