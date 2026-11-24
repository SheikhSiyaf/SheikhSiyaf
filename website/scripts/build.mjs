// Nusuh Books marketing site: static build. No dependencies; Node 18+.
//   node scripts/build.mjs               -> dist/   (warns if dummy company details remain)
//   node scripts/build.mjs --production  -> dist/   (refuses to build with dummy details)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PRODUCTION = process.argv.includes('--production');

const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
const readText = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ---------- data sources -------------------------------------------------
// admin-data.json is the file stand-in for your admin page's API. Set ADMIN_DATA_URL
// to read the same JSON shape from an API at build time instead.
async function loadAdminData() {
  const url = process.env.ADMIN_DATA_URL;
  if (!url) return j('admin-data.json');
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ADMIN_DATA_URL answered ${res.status}`);
  return res.json();
}

const site = j('site.json');
const pricing = j('pricing.json');
const modules = j('modules.json');
const forms = j('forms.json');
const admin = await loadAdminData();

const DUMMY = { cr: '0000000000', vat: '300000000000003' };
const dummyLeft = admin.company.cr === DUMMY.cr || admin.company.vat === DUMMY.vat;
if (dummyLeft) {
  const msg = 'TODO: company registration (CR) and/or VAT number are still the DUMMY placeholders in config/admin-data.json.';
  if (PRODUCTION) { console.error('\nBUILD REFUSED. ' + msg + '\nReplace them with the real numbers, then run again.\n'); process.exit(1); }
  console.warn('\n  WARNING  ' + msg + '\n  (This build is fine for testing, not for launch.)\n');
}

// ---------- tokens ---------------------------------------------------------
const n = (v) => Number(v).toLocaleString('en-US');
const fmt = (v) => `${pricing.currency} ${n(v)}`;
const ctx = {
  site: { url: site.url },
  url: { app: admin.appUrl },
  contact: {
    email: site.contact.email,
    phoneDisplay: site.contact.phoneDisplay,
    phoneE164: site.contact.phoneE164,
    whatsappUrl: `https://wa.me/${site.contact.whatsappNumber}`,
  },
  support: { hours: site.support.hours },
  trial: { days: String(site.trial.days) },
  company: { cr: admin.company.cr, vat: admin.company.vat, legalName: admin.company.legalName },
  num: { implementation: n(pricing.implementation), cleanup: n(pricing.cleanup), annualCore: n(pricing.annualCore), perModule: n(pricing.perModule) },
  money: {
    currency: pricing.currency,
    implementation: fmt(pricing.implementation),
    cleanup: fmt(pricing.cleanup),
    annualCore: fmt(pricing.annualCore),
    perModule: fmt(pricing.perModule),
    exampleTwoModulesYear: fmt(pricing.annualCore + 2 * pricing.perModule),
    exampleCleanOnce: fmt(pricing.implementation + pricing.cleanup),
  },
  forms: {
    orderDoneTitle: forms.messages.orderDoneTitle,
    orderDoneText: forms.messages.orderDoneText,
  },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function tokens(s, where) {
  return s.replace(/\{\{([a-zA-Z0-9.]+)\}\}/g, (m, key) => {
    let v = ctx;
    for (const k of key.split('.')) v = v?.[k];
    if (v === undefined || v === null) throw new Error(`Unknown token ${m} in ${where}`);
    return String(v);
  });
}

// ---------- bank details (hidden until all four are filled) ----------------
const bank = admin.bank || {};
const bankFilled = ['accountName', 'bank', 'iban', 'swift'].every((k) => String(bank[k] || '').trim());
const bankRows = bankFilled
  ? `<dl class="bank"><div><dt>Account name</dt><dd>${esc(bank.accountName)}</dd></div><div><dt>Bank</dt><dd>${esc(bank.bank)}</dd></div><div><dt>IBAN</dt><dd dir="ltr">${esc(bank.iban)}</dd></div><div><dt>SWIFT/BIC</dt><dd dir="ltr">${esc(bank.swift)}</dd></div></dl>`
  : '';
const bankFallback = `<p class="ct-sub">We send our bank details in writing with every invoice. Questions? Email {{contact.email}} or call {{contact.phoneDisplay}}.</p>`;

// ---------- images -----------------------------------------------------------
const dims = JSON.parse(readText('src', 'image-sizes.json'));
function pictures(html, where) {
  let n = 0;
  return html.replace(/<img src="assets\/([a-z0-9-]+)\.jpg"([^>]*)>/g, (m, name, rest, offset) => {
    const d = dims[name];
    if (!d) throw new Error(`No size for image ${name} in ${where}`);
    // Tiles sit in a sideways-scrolling strip: browsers never lazy-load pictures that are off to the side,
    // so they would pop in as the strip moves. They load with the page, at low priority.
    const inStrip = /class="tile"><div class="ph[^>]*>$/.test(html.slice(Math.max(0, offset - 80), offset));
    const eager = n < 2; n++;
    const attrs = `width="${d[0]}" height="${d[1]}" decoding="async"` + (inStrip ? ' fetchpriority="low"' : eager ? (n === 1 ? ' fetchpriority="high"' : '') : ' loading="lazy"');
    return `<picture><source srcset="/assets/${name}.avif" type="image/avif"><source srcset="/assets/${name}.webp" type="image/webp"><img src="/assets/${name}.jpg" ${attrs}${rest}></picture>`;
  });
}

// ---------- modules for the cart --------------------------------------------
const cartModules = modules.optional.map((m) =>
  `    <button type="button" class="ct-mod" data-module="${esc(m.id)}" aria-pressed="false"><span class="ct-box" aria-hidden="true"></span><span><b>${esc(m.name)}</b><span class="d">${esc(m.desc)}</span><span class="pr">+ {{money.perModule}} per year</span></span></button>`
).join('\n');

// small public config for the browser script (prices for the live total, form messages)
const clientConfig = JSON.stringify({
  pricing: { currency: pricing.currency, implementation: pricing.implementation, cleanup: pricing.cleanup, annualCore: pricing.annualCore, perModule: pricing.perModule },
  modules: modules.optional.map((m) => ({ id: m.id, name: m.name })),
  messages: Object.fromEntries(Object.entries(forms.messages).map(([k, v]) => [k, tokens(v, 'forms.json')])),
}).replace(/</g, '\\u003c');

// ---------- layout parts ------------------------------------------------------
const navHtml = readText('src', 'partials', 'nav.html');
const footerHtml = readText('src', 'partials', 'footer.html');
const askHtml = readText('src', 'partials', 'ask.html');

function navFor(onPath) {
  let h = navHtml;
  if (onPath) {
    const a = `href="${onPath}"`;
    h = h.replace(`<a ${a}>`, `<a ${a} class="on" aria-current="page">`).replace(`<a class="l" ${a}>`, `<a class="l on" ${a} aria-current="page">`);
  }
  return h;
}

const cookieBanner = `<div id="cookie-banner" class="cookie" role="region" aria-label="Cookies" hidden><p>We set only strictly necessary cookies. We do not run advertising or retargeting cookies. <a href="/legal/cookies/">Cookie policy</a></p><div class="cookie-acts"><button type="button" class="btn btn-line" data-consent="declined">Decline</button><button type="button" class="btn btn-ink" data-consent="accepted">Accept</button></div></div>`;

const cssVer = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'public', f))).digest('hex').slice(0, 8);

const orgLd = (pageUrl) => JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: site.name,
  legalName: admin.company.legalName || site.name,
  url: site.url + '/',
  logo: site.url + '/assets/logo.png',
  email: site.contact.email,
  telephone: site.contact.phoneE164,
  ...(admin.company.address ? { address: { '@type': 'PostalAddress', streetAddress: admin.company.address, addressCountry: 'SA' } } : {}),
  contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', email: site.contact.email, telephone: site.contact.phoneE164, availableLanguage: ['English', 'Arabic'] }],
});

function descriptionOf(body) {
  const m = body.match(/<p class="lead[^"]*"[^>]*>([\s\S]*?)<\/p>/) || body.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  let t = (m ? m[1] : site.name).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  if (t.length > 158) { const cut = t.slice(0, 158); t = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf(' '))).replace(/[,;:]$/, '') ; if (!/[.!?]$/.test(t)) t += '…'; }
  return t;
}

// Screen readers expect headings to step down one level at a time. The design goes from the page's h1 straight to
// card titles marked h3. aria-level fixes the outline without changing the tag, so styling is untouched.
function fixHeadingOrder(html) {
  let last = 0; const off = {};
  return html.replace(/<h([1-6])([^>]*)>/g, (m, lv, attrs) => {
    const L = Number(lv);
    const given = attrs.match(/aria-level="(\d)"/);
    if (given) { last = Number(given[1]); return m; }
    if (L <= last) for (const k of Object.keys(off)) if (Number(k) > L) delete off[k];
    let eff = L - (off[L] || 0);
    if (eff > last + 1) { off[L] = L - (last + 1); eff = last + 1; }
    last = eff;
    return eff === L ? m : `<h${lv}${attrs} aria-level="${eff}">`;
  });
}

// ---------- pages ---------------------------------------------------------------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
const pages = [];

for (const f of fs.readdirSync(path.join(ROOT, 'src', 'pages')).sort()) {
  let raw = readText('src', 'pages', f);
  const meta = JSON.parse(raw.match(/^<!--meta (.*?) -->\n/)[1]);
  let body = raw.replace(/^<!--meta .*? -->\n/, '');

  body = body.replace('<!--@cart-modules-->', cartModules);
  body = body.replace('<!--@bank-details-->', bankFilled ? bankRows : bankFallback);
  if (bankFilled) {
    // Replace the "bank details are on your invoice" card text with the real details.
    body = body.replace(/<h3 class="h3" style="margin:14px 0 8px">Our bank details are on your invoice\.<\/h3><p[^>]*>[\s\S]*?<\/p>/, `<h3 class="h3" style="margin:14px 0 8px">${esc(bank.accountName)}</h3>${bankRows}`);
  }
  // forms (Contact, Demo, Payment confirmation) are inserted where the page has a marker
  body = body.replace(/<!--@form:([a-z]+)-->/g, (m, name) => readText('src', 'forms', name + '.html'));

  body = tokens(body, f);
  body = pictures(body, f);

  const footer = tokens(footerHtml, 'footer');
  const [before, after] = body.split('<!--@footer-->');
  if (after === undefined) throw new Error(`${f} has no footer marker`);

  const description = descriptionOf(body);
  const canonical = site.url + meta.path;
  const isHome = meta.path === '/';
  const css = isHome ? 'home.css' : 'base.css';
  const title = meta.title;
  const og = `${site.url}/assets/og-default.png`;

  const html = `<!doctype html>
<html lang="${site.language.lang}" dir="${site.language.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#06222B">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/logo.png">
<link rel="preload" href="/fonts/plus-jakarta-sans-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/${css}?v=${cssVer('css/' + css)}">
<link rel="stylesheet" href="/css/extra.css?v=${cssVer('css/extra.css')}">
<script type="application/ld+json">${orgLd(canonical)}</script>
<script type="application/json" id="site-config">${clientConfig}</script>
<script src="/js/site.js?v=${cssVer('js/site.js')}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<span id="top"></span>
${navFor(meta.navOn).replace('<header class="nav glass">', '<header class="nav glass">')}
<div class="site"><div class="${meta.pageClass}">
<main id="main">
${before}
</main>
${footer}
</div></div>
${askHtml.replace(/\{\{[^}]+\}\}/g, (m) => tokens(m, 'ask'))}
${cookieBanner}
</body>
</html>
`;
  const outDir = path.join(DIST, meta.path);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), fixHeadingOrder(tokens(html, f)));
  pages.push({ path: meta.path, title, description });
}

// ---------- static files ------------------------------------------------------------
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(ROOT, 'public'), DIST);
copyDir(path.join(ROOT, 'api'), path.join(DIST, 'api'));
fs.rmSync(path.join(DIST, 'api', 'config.local.php'), { force: true });
fs.mkdirSync(path.join(DIST, 'api', 'data'), { recursive: true });
// the order handler recomputes every total from these two files, never from the browser
fs.copyFileSync(path.join(ROOT, 'config', 'pricing.json'), path.join(DIST, 'api', 'data', 'pricing.json'));
fs.copyFileSync(path.join(ROOT, 'config', 'modules.json'), path.join(DIST, 'api', 'data', 'modules.json'));
fs.writeFileSync(path.join(DIST, 'api', 'data', 'forms.json'), JSON.stringify({ to: forms.to, subjects: forms.subjects, messages: Object.fromEntries(Object.entries(forms.messages).map(([k, v]) => [k, tokens(v, 'forms.json')])), siteName: site.name }, null, 2));

// sitemap + robots
const lastmod = new Date().toISOString().slice(0, 10);
const sm = pages.sort((a, b) => a.path.localeCompare(b.path))
  .map((p) => `  <url><loc>${site.url}${p.path}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n');
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sm}\n</urlset>\n`);
fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site.url}/sitemap.xml\n`);

// token left over anywhere in the output = a bug
const leftovers = [];
(function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.html') && /\{\{|<sc-|\.dc\.html|<!--@/.test(fs.readFileSync(p, 'utf8'))) leftovers.push(p);
  }
})(DIST);
if (leftovers.length) { console.error('Unresolved markers in:\n' + leftovers.join('\n')); process.exit(1); }

console.log(`Built ${pages.length} pages into ${path.relative(process.cwd(), DIST) || '.'}${dummyLeft ? '  (dummy company details still present)' : ''}`);
