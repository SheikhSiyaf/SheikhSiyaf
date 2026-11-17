# Nusuh Books: brief for the advisor (Claude chat)

Upload this file to a Claude Project as project knowledge. It brings the advisor up to date. The developer
(Claude Code, working in the repository) keeps it current: the "Where things stand" section changes after each feature.

Last updated: 2026-11-17 (the logo and brand name in the app; ZATCA proved against the official SDK validator).

---

## 1. Setting up the advisor (once)

1. On claude.ai, create a **Project** called "Nusuh Books advisor".
2. Under **Project knowledge**, upload these files from the repository:
   - `docs/ADVISOR_BRIEF.md` (this file): required
   - `docs/PENDING.md`: what is left
   - `docs/DECISIONS.md`: decided and open questions
   - `docs/PRODUCT_SPEC.md`: full feature list (optional, it is long)
   - `CLAUDE.md`: the rules the developer follows (optional)
3. Paste the text in section 2 into the Project's **custom instructions**.
4. Start every advisory conversation inside that Project.
5. When the developer says the brief has changed, replace the uploaded file (delete the old one, upload the new one).

## 2. Custom instructions for the Project (copy and paste)

```
You are my business and product advisor for Nusuh Books, an accounting platform I am building for accounting firms
and companies in Saudi Arabia and the UAE (Oman later). The project files describe the product, what is built,
what is left and the open decisions. Read ADVISOR_BRIEF.md first.

Your role:
- Advise on strategy, priorities, pricing, go-live, compliance (ZATCA, UAE FTA and Peppol, PDPL), vendors,
  hosting, hiring and sales. Give a clear recommendation, not a list of options.
- You do not write the code. A separate developer (Claude Code, working in the GitHub repository) builds
  everything. When we decide something should be built or changed, write a "Developer brief" I can paste to the
  developer, in the format given in ADVISOR_BRIEF.md section 8.
- Respect the decisions already made (section 6 of the brief). If you think one is wrong, say why, but do not
  plan as if it were changed.
- Say plainly when something needs confirmation from an authority, a lawyer or a qualified accountant, and do not
  invent tax rates, deadlines or legal requirements. If you are unsure of a current date or rule, say so.
- Keep answers short and in plain language. I am not a programmer.
```

## 3. The product in one paragraph

Nusuh Books is a web accounting platform sold to two kinds of customers: **accounting firms** (who keep the books of
many client companies) and **companies** that keep their own books. One firm login reviews many client companies;
client accountants do daily entry. It is bilingual (English and Arabic, right-to-left), follows double-entry rules
strictly, and includes Saudi ZATCA e-invoicing. The owner of Nusuh Books (the platform owner) runs it from an owner
console: creates customers and companies, bills them, answers support messages, and never sees anyone's books.

## 4. Who uses it

- **Platform owner** (Nusuh Books itself): owner console only. Creates every customer, its first Administrator and
  every company. Billing and subscriptions. Answers the support chat.
- **Administrator** (one per customer): manages users, roles and access. Never sees books.
- **Firm staff** (firms only): Firm partner (locks periods), Reviewer (reviews and signs off), Staff accountant. Each
  sees only the clients assigned to them.
- **Client users**: each has a role the Administrator defines (None / View / View and enter per module, plus an
  "approve claims" right). They see only their own company.
- **Customers of the client** use a portal (invoice links, online payment, document requests).

## 5. What is built (status: build steps 1 to 6 done, plus extras)

- **Foundation**: sign-in with two-factor, roles, audit log of every change, cost centres, ledger, period locks,
  strict data separation between companies enforced in the database (row-level security), sign-in throttling.
- **Sales**: quotes, invoices, credit and debit notes, recurring invoices, customer statements and reminders,
  bulk issue and email, online payment from the invoice link (Moyasar, plus a test sandbox).
- **Purchases**: bills, purchase orders, expense claims with approvals, receipt photos.
- **Inventory, fixed assets, bank** (reconciliation, direct bank feeds: sandbox only), **projects**.
- **Rentals**: renting out equipment such as cranes and scaffolding as income (contracts, usage, rental bills).
- **Rooms** (hotels, new "hospitality" industry): room types with nightly rates including VAT and seasons, rooms, bookings (never two on the same night), front desk, calendar, check-in and check-out, extras, and the guest bill as an ordinary invoice on 4200 Room revenue. Refundable security deposits (held in 2150, no VAT; returned, or used to pay the guest's bill). Advance payments: an advance invoice (ZATCA type 386, VAT on receipt, account 2160) deducted on the final invoice as ZATCA's prepaid amount; ZATCA sandbox accepted all four test cases. VAT treatment of advances on the return still to be confirmed by an accountant before real use.
  Deep Check (2026-11-15) passed: bookings never overlap (also 8 at once), entries, VAT and the trial balance recompute exactly, other companies and roles are kept out, locked months refuse postings; ZATCA sandbox accepted the hotel's guest invoice, advance invoice, final invoice with prepaid and the advance's credit note. Fixed: front-desk roles no longer see company figures on Home; an unused advance can now be credited (0047). Open: no way to pay a refund out to a customer; a part-used advance cannot be refunded; guest bill lines are English only; accountant questions on advance VAT.
- **Reports**: trial balance, P&L, balance sheet, VAT return, aged reports, budgets, forecast, multi-currency
  ledger accounts with month-end revaluation, export of everything.
- **Review layer**: reviewer checks and sign-off; signing off a month locks it. Year-end close.
- **E-invoicing**: ZATCA (Saudi) built. Sandbox test (Stage 1, dummy data, see docs/ZATCA_SANDBOX_REPORT.md): onboarding, all 6 compliance checks and clearance of standard invoice, credit and debit notes pass; reporting of simplified invoices rejected in the sandbox (most likely the sandbox's dummy production certificate; to be settled in simulation). A device is now never switched on with a certificate that does not match its key. Code checked against ZATCA's XML and Security standards v1.2 (2023-05-19); not supported: advance-payment invoices. Stage 2 can run on a local test database. Simplified invoices are now reported automatically (every 2 minutes, retries 2/5/10/15/30 min, in order, never twice), with warnings at 12/20/24 hours, on rejection and login refusal (invoice numbers only), and an Administrator list of unsent invoices. Missing: certificate renewal. UAE Peppol: not built
  (needs an accredited service provider).
- **Portal, calendar of deadlines, approvals, forecast.**
- **HRM** (payroll, GOSI and GPSSA, end of service, leave, WPS and Mudad files), **CRM**, **Restaurant**.
- **Owner console**: customers, billing and subscriptions, support inbox.
- **Support chat**: a Help button for every customer user to raise an issue with Nusuh Books; owner answers;
  the customer gets an email when answered.
- **Email**: outbox with Resend, SendGrid or Postmark; invitations, password reset, documents, approvals.
- **Quality**: 500+ automated tests (accounting rules, data separation, API); every change is tested first.
- **Demo**: the real app now runs as a free demo site (Render web service + Neon PostgreSQL 16, Frankfurt), demo data only, every background job and outside connection switched off, sign-in with the demo users (password demo1234, so share the address only with trusted people). It sleeps after 15 minutes and takes up to a minute to wake; Neon keeps only 6 hours of restore history. Every push to the branch redeploys it. Not for real data: the paid hosting, backups and security review below are still needed. A browser-only demo also exists as a claude.ai artifact.
- **Marketing screenshots**: 46 real screenshots with demo data in `marketing-screens/` (English and Arabic at 1440x900, phone layouts of the dashboard, sales and firm client list). Al Noor Trading has a labelled demo e-invoicing device ("Demo device (not connected to ZATCA)", self-signed demo certificate): its e-invoices are made by the real code and ZATCA's answers are stored as demo data; nothing is sent. The firm client list shows as cards on phones.
- **Production readiness (done)**: in production the server refuses to start with missing, short or example SESSION_SECRET / ENCRYPTION_KEY; the encryption key never falls back to the session secret. A real installation: `npm run db:migrate`, then `npm run db:install` (owner account with a one-time link), then the first customer and company in the owner console (README); the demo seed and reset refuse to run in production. Background jobs are owned by one server copy at a time (database lock, handed over when it stops), each run recorded; `/health` reports database and jobs. `ERROR_REPORT_URL` turns on error reports; logs and reports never hold passwords, keys, tokens, one-time codes or amounts. Security headers, same-site check on cookie requests, rate limits on public links. Backup and restore tested.
- **ZATCA connects itself (2026-11-16)**: a customer connects their own company to ZATCA without telling anyone their details. The Connect screen opens with a "before you start" list (VAT number, CR, national address with the 4- and 5-digit rules, the VAT-group warning, their own Fatoora sign-in), names what to click in the portal, and never shows a password box. When ZATCA refuses, the screen shows a plain sentence, then the likely cause and what to do about it, then ZATCA's own words: eight cases covered in English and Arabic, and nothing invented when the cause is unknown.
- **ZATCA readiness (2026-11-16)**: sandbox rehearsal run again: both certificates issued, all 6 compliance scenarios accepted, standard invoices cleared; simplified reports rejected only because the sandbox hands out a sample certificate. Certificate renewal (same device, chain unbroken; ZATCA's sandbox accepted the renewal call), a 30-day warning (screen, bell, one email), Connect screen defaults to Simulation, Production is refused unless the host sets ZATCA_PRODUCTION=on, ZATCA's own error text is shown. Next: Stage 2 (simulation) when the owner writes the approval with the resort's details and a one-time code.
- **Independent security review (2026-11-16)**: no way found from one company into another; ledger, issued invoices, e-invoice chain and audit log held against direct attacks. Fixed: client roles could be stepped around by writing the company ID in capitals; sign-out, a new password or two-factor secret and a suspension now end every older sign-in (0053); replacing an authenticator needs a code from it; a two-factor code works once; the test checkout is refused on the live site; production needs TRUST_PROXY set; CSV exports keep formula-like text as text; password resets limited per address. Open: per-line VAT rounding to confirm against ZATCA's validator; Arabic text file (docs/ARABIC_TEXT_REVIEW.csv) waiting for a native accountant's review.
- **Known issues batch 1 (done)**: a year closes and reopens when its last month is signed off; withdrawing a sign-off unlocks only what the sign-off locked; simplified invoices say "Simplified tax invoice" (lists say "Invoice"); a new support issue emails the owner (subject and counts only). The built-in "Nusuh Books automatic sender" (cannot sign in, one company and one job at a time) now runs the ZATCA sender, online-payment confirmation, recurring invoices, automatic reminders, month-end revaluation and bank feed syncs, so they keep working when the person who set them up leaves; who set them up is still recorded. Standard invoices ZATCA cannot clear at once are retried automatically, marked "Not cleared by ZATCA yet", may go to the buyer after 5 minutes (ZATCA Detailed Guidelines v2, p.46), and the cleared invoice is offered when it arrives; ZATCA's 303 "clearance switched off" is reported instead. Migrations 0048 to 0052.
- **The logo in the app (2026-11-17)**: the Nusuh Books mark (the rounded N with the amber dot over its underline bar) now sits at the top left of every screen, with the name beside it in a rounded typeface that matches the logo's curves. Drawn as SVG, so it stays sharp at any size and follows light and dark mode. The name comes from the translations, so Arabic shows نصوح بوكس in a rounded Arabic face and the mark moves to the right. On phones the mark stays and the words give way to the menu. The two typefaces (Nunito for Latin, Baloo Bhaijaan 2 for Arabic, both SIL Open Font License) are stored with the site, about 60 KB in all, so no request ever goes to an outside font service: the site's own policy allows fonts from this site only, and loading them from Google would have been blocked and would have told Google who our clients are. The browser tab icon matches.
- **ZATCA proved against the official validator (2026-11-16)**: ZATCA's own Compliance and Enablement SDK (238-R4.0.0, the Java 21 build) was downloaded and every invoice type we support was run through it: standard, simplified, credit note, debit note, advance payment (386), zero-rated, exempt, mixed rates, foreign currency, a hotel guest bill and a final invoice with an advance deducted. **Two real defects were found and fixed.** (1) The signed-properties digest: ZATCA writes empty elements self-closing before hashing, we wrote them out in full, so the digest never matched and ZATCA would have refused EVERY simplified invoice. This was the true cause of the sandbox reporting rejections we had put down to the sandbox's sample certificate. (2) The VAT accounting currency must always be SAR; we copied the invoice currency (only reachable once invoices in other currencies are built). After the fixes, signing with a real ZATCA certificate, the validator passed the whole chain: standard clearance, simplified reporting, credit note and debit note, all of XSD, EN16931, KSA rules, QR, signature and the invoice chain. Our CSR is byte-identical to the SDK's and our invoice hash matches it exactly. The sandbox still refuses simplified reporting with "ECDSA Public Key does not match", and the reason is now proven: the certificate the sandbox hands out is byte-identical to the sample certificate shipped in the SDK, issued to another taxpayer and to a key that is not ours. That cannot happen for a real company. Still unproven without a real taxpayer: that ZATCA accepts a certificate issued to a real company, and the one-time code flow.
- **Demo site is out of date (2026-11-16)**: the Render demo answers, but it is running code from before 15 November. Checked: `/health` is missing and no security headers are sent (both added 15 November), and the page's built file name differs from a build of this branch. So the demo does NOT include the security review fixes or the ZATCA work. The branch on GitHub is current; the deploy is the gap. Before it deploys the new code, the host must set `TRUST_PROXY` (1 on Render), or the server will refuse to start.
- **Demo-site switches**: `OUTSIDE_CALLS=off` stops every call to an outside service (ZATCA, online payment, exchange rates, email), and `AUTH_PURGE_JOBS=off` joins the other job switches, so a free demo (Render + Neon) can run with no background work and no outside contact.

Technology (for vendor conversations): PostgreSQL database, Node.js (TypeScript) server, React web front end. One
codebase for all customers; per-customer settings, never copies. Code is in GitHub.

## 6. Decisions already made (do not reopen without a reason)

- Login decides everything: no client or role switcher in the app.
- The platform owner never sees books; Administrators never see books.
- Posted entries are never edited or deleted: corrections by reversal or credit note. Locked periods reject posting.
- Money is stored exactly (no rounding errors); every change is audited.
- Same invoice data for all countries; each country's e-invoicing is a separate add-on (ZATCA, UAE Peppol via an
  accredited provider, Oman Fawtara later).
- Arabic and English from the start; plain accountant language; prevent errors rather than show error messages.
- Registration rules: Saudi CR 10 digits; Saudi VAT 15 digits starting and ending with 3; UAE TRN 15 digits; CR and
  VAT numbers unique across clients. "VAT unregistered" means 0% VAT.
- The industry chosen at registration switches on optional modules (Inventory, Restaurant, Assets, Projects, HRM,
  CRM, Rentals); the Administrator can change them.

## 7. Where things stand and what is next

**Going live needs** (none of these are code-heavy; they are accounts and decisions):
- A PostgreSQL host (Supabase as a plain database, Neon, AWS RDS, or a Saudi/UAE region for data-residency law). Needs: PostgreSQL 16, the btree_gist extension, a login that can create the nusuh_app role, 11+ connections, daily backups with point-in-time restore.
- A server that keeps running (Render, Railway, Fly.io, DigitalOcean, AWS). Not Cloudflare Pages.
- A domain with Cloudflare (DNS, HTTPS, firewall).
- An email provider (Resend recommended) with the sending domain verified (SPF, DKIM).
- Backups with a tested restore; monitoring (e.g. Sentry and an uptime check).
- Later, per feature: Moyasar account (online payment), ZATCA onboarding per company (one-time code from the
  Fatoora portal), Lean or Tarabut agreement (bank feeds), an accredited UAE Peppol provider.

**Go-live blockers** (from PENDING.md): ZATCA Stage 2 (simulation with the resort's real one-time code: waiting for your go-ahead); hosting and a security review; legal
advice on Saudi and UAE data protection (PDPL); confirm GOSI/GPSSA rates, WPS and Mudad layouts and VAT return
boxes with the authorities; opening balances as open invoices; choose the UAE provider (companies with AED 50
million or more go live on 1 January 2027); move the browser checks into automated CI.

**Known gaps** (reported by the developer, not yet fixed):
- Online payment confirmation fails if the person who switched on payments later loses access.
- Year-end close and reopen are blocked when the last month is signed off.
- Withdrawing a sign-off also unlocks months the partner had locked.
- UAE annual leave in the first year of service is not modelled.
- No email to the owner when a customer raises a new support issue; no attachments in the support chat.

**Open decisions** (the advisor can help with these): which country signs first; what the SAR 2,500 managed fee
includes and the pilot discount; how clients use cost centres; which POS systems restaurants use; the hosting
region; the UAE service provider.

## 8. Handing work to the developer

When we decide to build or change something, write it like this so I can paste it to Claude Code:

```
Developer brief: <short title>
Goal: <what the user should be able to do, in one or two sentences>
Who: <which kind of user: owner, Administrator, firm staff, client user, portal>
Rules: <accounting, tax or legal rules that must hold, with the source if known>
Done when: <how we will know it works, as checks a person can do>
Not in scope: <what to leave alone>
Confirm first: <anything the developer must check with me before building>
```

And when the developer finishes, I may paste its summary back here for the advisor to review.
