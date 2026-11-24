# Nusuh Books: marketing website

The public site for Nusuh Books (nusuhbooks.com). It is separate from the software at https://app.nusuhbooks.com/.

* **45 static pages** built from the design canvas (Home, Modules + 16, Industries + 7, For firms, Pricing, About, Security, FAQ, Contact, Book a demo, Order, How to pay, Confirm your payment, Legal hub + 8 legal pages).
* **One small PHP file** (`api/submit.php`) that handles the four forms and sends the message through **Resend**.
* **No login or free-trial pages.** Every "Log in" and "Start free trial" button goes to the app address, one constant in `config/admin-data.json` (`appUrl`).
* Built with a 200-line Node script, no frameworks, no dependencies. Output is plain HTML, CSS and one small JS file, so it is fast and cheap to host.

Why not Astro or Cloudflare Pages: you host on Hostinger, and the design is already finished HTML and CSS, so a framework would only add moving parts. Why PHP for the forms: Hostinger runs PHP on every plan and it needs no extra service. If you later move to Cloudflare Pages, `api/submit.php` is the only part to rewrite.

---

## 1. Run it on your computer

You need Node 18 or newer (and PHP 8.1+ only if you want to test the forms locally).

```
cd website
npm run build        # writes the finished site into website/dist
npm run preview      # http://localhost:4173  (pages only; forms need PHP)
npm test             # builds, then runs the site checks and the form-handler tests
```

To try the forms locally, run `php -S localhost:8080 -t dist` and open http://localhost:8080. Without a Resend key the form answers with the "could not send" message and sends nothing.

## 2. Put it live on Hostinger (step by step)

You do this once; after that it is "build, zip, upload".

1. **Check your hosting plan** runs PHP 8.1 or newer with cURL on (hPanel > Websites > Manage > PHP Configuration). Hostinger's default is fine.
2. **Fill in the real company details** in `config/admin-data.json` (see section 4), then run `npm run build:production`. This command **refuses to build** while the dummy CR and VAT numbers are still there, so nothing placeholder can ship by accident. (`npm run build` is for testing and only warns.)
3. **Upload the site.** In hPanel open **File Manager**, go into `public_html`, delete the default files, and upload everything inside `website/dist` (the folder's contents, including the hidden `.htaccess`). Zipping `dist`, uploading the zip and using Extract is the easiest.
4. **Create a Resend key just for the website.** Resend > API Keys > Create > permission **Sending access**, domain `send.nusuhbooks.com` (the one already verified). Name it "website". Do not paste it anywhere except the next step.
5. **Create the secrets file.** Copy `api/config.local.php.example`, rename the copy `nusuh-website-secrets.php`, fill in the key and the sender address (for example `Nusuh Books <website@send.nusuhbooks.com>`), and upload it to the folder **one level above `public_html`** (so it cannot be reached from the internet). If your plan does not let you go above `public_html`, upload it as `public_html/api/config.local.php` instead; `api/.htaccess` blocks downloads of that file.
6. **Point the domain.** In hPanel connect `nusuhbooks.com` to the hosting plan so the root domain uses Hostinger. **Do not touch** the `app` record (it points to Render) or the `send` / Resend records.
7. **Test it end to end.** Open https://nusuhbooks.com/contact/, send yourself a message, and check it arrives at hello@nusuhbooks.com. Then try Book a demo, Confirm payment (with a small PDF) and a test Order.
8. Check https://nusuhbooks.com/sitemap.xml opens, and submit it in Google Search Console.

To update the site later: change a file, run `npm run build:production`, upload the new `dist` contents.

## 3. Where things live

```
config/
  site.json         name, domain, email, phone, WhatsApp number, support hours, trial length, language (lang, dir)
  pricing.json      ALL prices (SAR, excluding VAT). Change a number, rebuild, every page and the order total follow.
  modules.json      the 6 core and 10 optional modules (names and descriptions as in the design)
  forms.json        where form mail goes, subject lines, the short messages the forms show
  admin-data.json   the data your admin page will manage (section 4)
src/pages/          one HTML file per page, copied from the design, with {{tokens}} for facts that live in config
src/partials/       the menu, footer and "Ask us" panel, shared by every page
src/forms/          the Contact, Demo and Payment-confirmation forms
public/             CSS, JS, fonts (self-hosted), images (AVIF, WebP, JPG), favicon, .htaccess
api/submit.php      the form handler
scripts/build.mjs   the build
tests/              site checks and form-handler tests
```

Prices, phone, e-mail, hours, trial length, CR, VAT and the app address are never typed into the pages: they are `{{tokens}}` filled from the config at build time. The build fails if a token is unknown.

## 4. The admin-data shape (what your admin page will manage)

`config/admin-data.json` is read at build time. To read the same JSON from your admin app instead, build with `ADMIN_DATA_URL=https://…/site-data.json npm run build:production`. Keep this exact shape:

```json
{
  "appUrl": "https://app.nusuhbooks.com/",
  "company": { "legalName": "…", "cr": "…", "vat": "…", "address": "" },
  "bank":    { "accountName": "", "bank": "", "iban": "", "swift": "" },
  "testimonials": []
}
```

* **bank**: while any of the four is empty, "How to pay" and the order confirmation show the existing sentence "Our bank details are on your invoice / We send our bank details in writing with every invoice" and no half-filled block. Fill all four and the details appear in both places.
* **company**: CR and VAT appear on the legal pages; the address, when filled, goes into the site's structured data. **The CR (0000000000) and VAT (300000000000003) in the file are DUMMY placeholders**, marked `_TODO`, and the production build refuses them.
* **testimonials**: stays hidden while empty. (The design has the strip's styling but no strip, so it is not rendered until you supply real quotes and we agree its layout.)

Because the site is static, a change to this data shows after the next build and upload.

## 5. How the forms behave

* Contact, Book a demo, Confirm payment and Order all post to `/api/submit.php`.
* Checked in the browser first, then **again on the server**; invalid input is refused with the field named.
* Spam: a hidden field bots fill in, a link-stuffing check, 5 messages per 10 minutes and 30 a day per visitor, 200 an hour for the whole site, same-site check, size limits.
* The mail goes **to hello@nusuhbooks.com** with the visitor as Reply-To, so you reply straight to them. The Confirm-payment form can carry a receipt (PDF, JPG, PNG or WebP up to 5 MB).
* **Order totals are recomputed on the server** from `pricing.json` and `modules.json`. Whatever total the browser shows is ignored.
* No Resend key in the code, the repository or the browser. Without the secrets file the handler sends nothing and says so in the server log.

## 6. Cookies, privacy, security

* The site sets **no cookies** and has **no analytics**. The notice (Decline / Accept) stores one choice in the visitor's own browser. If you later approve an analytics tool, use a cookieless one (for example Plausible or Cloudflare Web Analytics) and update the Cookie policy first.
* Fonts, scripts and images are all served from the site itself. Nothing loads from another website.
* `public/.htaccess` sets HTTPS, www to non-www, a Content-Security-Policy, HSTS, X-Content-Type-Options, Referrer-Policy and caching.

## 7. Arabic later

The page shell reads `language.lang` and `language.dir` from `config/site.json` (`"en"` / `"ltr"` today). The CSS uses logical properties (start/end instead of left/right) so setting `"ar"` / `"rtl"` and supplying translated page text is all a later Arabic version needs. No text has been machine-translated.

## 8. What you must provide

| Item | Where | Needed for |
|---|---|---|
| Real commercial registration (CR), VAT number, address | `config/admin-data.json` > `company` | production build, legal pages |
| Bank name, account name, IBAN, SWIFT/BIC | `config/admin-data.json` > `bank` | How to pay, order confirmation |
| Resend key (sending access) and sender address | secrets file, section 2 step 5 | every form |
| Hosting plan on Hostinger with nusuhbooks.com attached | hPanel | going live |
| Real testimonials, if you want the strip | `config/admin-data.json` > `testimonials` | optional |
| Decisions in the list below | chat | wording only |

## 10. Checked results (2026-11-24)

* **Looks like the design:** every page was rendered next to the original canvas at 1360, 820 and 390 pixels wide and compared pixel by pixel. 40 of the 41 pages that have no added form are pixel-identical at 1360 (the exception, Modules, differs by one removed sentence), and the sampled pages at 820 and 390 are identical too. A word-by-word comparison of all 45 pages finds 40 with identical wording and 5 with the changes listed in section 9 (Modules, Contact, Book a demo, Confirm payment, Order).
* **Lighthouse** on a plain local server (no compression, no caching): Home mobile 96 / 100 / 100 / 100, Pricing, Order and Sales module 100 / 100 / 100 / 100 on mobile and desktop (performance / accessibility / best practices / SEO). All 45 pages score 100 for accessibility, best practices and SEO. Hostinger's compression and caching only help.
* **Tests:** `npm test` runs 27 checks: page set and links, headings, titles, images, claims rules, config use, form handler (against a fake Resend), and five real-browser flows (order, contact, demo, payment confirmation, cookie notice, phone menu).
* **Not tested here:** real delivery through Resend (it needs the website key on your hosting), the Hostinger server itself, Safari and Firefox, and Arabic.

## 9. Decisions and flags for you

See the report in chat; the short list is kept here so it travels with the code.

1. **Order page, step 5** still says "Press Place order. Your email app opens with the order ready to send." The button now sends the order through the site's form instead. The design's sentence was left as written; suggested replacement: "Press Place order. We receive your order straight away."
2. **Forms were not in the design.** Contact, Book a demo and Confirm payment only had e-mail links. Forms were added using the field names from the design's own e-mail templates. New words: "Send a message", "Name", "Email", "Message", "Send message", "Confirm your payment", "Transfer receipt", the form success and error messages in `config/forms.json`, and the cookie notice buttons "Decline" / "Accept".
3. **"Direct feeds in development."** (Modules page, Banking) was removed because the claims rules forbid "in development" wording. It is the only wording change.
4. **Cookie policy text is now untrue in two places**: it says "no consent banner is shown" and that the site loads Google Fonts. The site now has a notice (as asked) and self-hosts its fonts. Legal text was left untouched; it needs your lawyer's edit.
5. **Nine "Start free trial" buttons** pointed at an old demo address (nusuh-demo.onrender.com). All now go to the app address.
6. "**8 sample invoices**" (Home) is a number in the design that I could not verify; please confirm.
7. **Ask us**: the design's "Ask us" is a small help panel (FAQ answers + WhatsApp, Email, Call), not a bare WhatsApp link. Kept as designed; the WhatsApp button goes to wa.me/966546958273.
8. No custom 404 page exists in the design, so none was made.
9. The payment gateway is **not** part of this site. The Order page ends in a bank-transfer request, exactly as designed.
