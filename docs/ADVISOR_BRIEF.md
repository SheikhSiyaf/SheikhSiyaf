# Nusuh Books: brief for the advisor (Claude chat)

Upload this file to a Claude Project as project knowledge. It brings the advisor up to date. The developer
(Claude Code, working in the repository) keeps it current: the "Where things stand" section changes after each feature.

Last updated: 2026-11-24 (public marketing website built in website/; earlier: owner Settings and verified email change; readiness check over every API route).

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
- **Refunds** (new): money can be paid back to a customer and received back from a supplier. A credit note on an
  invoice the customer had already paid leaves the amount owed to them, and a "Refund the customer" button on that
  invoice (or on a customer in credit) pays it out. Before this there was no way to return money at all: a refund,
  a cancelled booking, a returned product or an overpayment had nowhere to go. The journal follows the ledger side,
  not the direction of the cash, so a customer refund clears receivables and never payables, and the module rights
  follow it too (refunding a customer needs Sales, not Purchases). Deep Check passed 21 of 21 checks.
- **Starting a client who is already trading** (new): the bulk import has "Unpaid customer invoices" and "Unpaid
  supplier bills". Each one comes in as its own open document, keeping the number, issue date and due date it had in
  the client's old system, so the aged debtors report, customer statements and payment matching are right from the
  first day. Before this the whole receivable arrived as a single lump and all three were wrong. An opening document
  is not a new sale: the whole amount sits against 3000 Opening balances, nothing touches income, expense or VAT,
  and it is never sent to ZATCA, because the old system already invoiced and reported it. Deep Check passed 20 of 20.
- **Reports**: trial balance, P&L, balance sheet, VAT return, aged reports, budgets, forecast, multi-currency
  ledger accounts with month-end revaluation, export of everything.
- **Review layer**: reviewer checks and sign-off; signing off a month locks it. Year-end close.
- **E-invoicing**: ZATCA (Saudi) built. Sandbox test (Stage 1, dummy data, see docs/ZATCA_SANDBOX_REPORT.md): onboarding, all 6 compliance checks and clearance of standard invoice, credit and debit notes pass; reporting of simplified invoices rejected in the sandbox (most likely the sandbox's dummy production certificate; to be settled in simulation). A device is now never switched on with a certificate that does not match its key. Code checked against ZATCA's XML and Security standards v1.2 (2023-05-19); not supported: advance-payment invoices. Stage 2 can run on a local test database. Simplified invoices are now reported automatically (every 2 minutes, retries 2/5/10/15/30 min, in order, never twice), with warnings at 12/20/24 hours, on rejection and login refusal (invoice numbers only), and an Administrator list of unsent invoices. Certificate renewal was already built. This phase closed a trap in it: if a certificate ran out while
  e-invoices were still waiting, ZATCA refused the login so they could never be sent, and renewal refused because
  invoices were waiting, so the company could neither send nor renew and nothing could be invoiced again. Renewal
  is now allowed in exactly that case and the waiting invoices are signed again with the new certificate; the
  invoices themselves do not change, so the counter and the chain stay as they were. UAE Peppol: not built
  (needs an accredited service provider).
- **Portal, calendar of deadlines, approvals, forecast.**
- **HRM** (payroll, GOSI and GPSSA, end of service, leave, WPS and Mudad files), **CRM**, **Restaurant**.
- **Owner console**: customers, billing and subscriptions, support inbox.
- **Support chat**: a Help button for every customer user to raise an issue with Nusuh Books; owner answers;
  the customer gets an email when answered.
- **Email**: outbox with Resend, SendGrid or Postmark; invitations, password reset, documents, approvals.
- **Quality**: 500+ automated tests (accounting rules, data separation, API); every change is tested first.
- **Backups (2026-11-19)**: `scripts/backup.sh` writes an encrypted (AES-256) dump and can upload it to S3-compatible storage (R2, B2); `scripts/restore.sh` restores into an empty database only. `test/backup.test.ts` backs up the demo books, restores them to a new database and compares every table, the ledger totals and row-level security. `.github/workflows/backup.yml` runs it daily and rehearses a restore; it is off until the owner sets BACKUP_ENABLED and the secrets. Not yet run against a real host or real bucket.
- **First real site (2026-11-20)**: live on Render (free) with its own Neon database; all 59 migrations applied there. Two faults found and fixed from its first deploy logs: the server listened on 127.0.0.1 (now HOST=0.0.0.0 in render.yaml), and a free plan has no shell, so the first owner's one-time sign-in link is made during the build from OWNER_NAME and OWNER_EMAIL and printed in the build log. Not yet done: domain, Resend email, backups switched on, upgrade to the $7 plan at the first client.
- **ZATCA monitor (2026-11-20)**: Sales > ZATCA monitor shows one state (not in use, all good, test mode, needs attention, act now) and the reasons: connection and certificate days left, invoices waiting (12h warning, 24h critical for simplified), rejections with ZATCA's own words, a login refused, a half-finished connection, and whether the automatic sender is running. It only reads our records and never calls ZATCA; the one button, "Send now", is the existing send. Rules in `src/books/einvoiceAssess.ts` (also used by the demo build), 28 rule and database tests, 2 browser checks, English and Arabic. Sandbox re-run: all compliance checks, renewal and clearance accepted; simplified reports still rejected by the sandbox's sample certificate (a device is never switched on with it: `cert_mismatch`). Not yet done: an owner-wide view across companies, and anything that needs a real taxpayer (simulation).
- **Decision (2026-11-20): go paid for the first client.** Owner will buy Render's $7 server (0.5c-512mb, billed per second, about $7 a month) by 2026-11-22. Because that keeps the server and so the database awake all day, Neon's free 100 compute-hours would run out in about 17 days (our estimate; at that point Neon suspends the database until the next period), so Neon moves to Launch (pay-as-you-go, roughly $20 a month always-on, up to 7 days of history) at the same time. Change the plan in render.yaml, never only in the dashboard, or the next blueprint sync puts it back to free. Reminders set for 2026-11-21 and 2026-11-22.
- **Supabase readiness (2026-11-20), nothing deployed**: reading Supabase's own documents turned up two faults that offline tests could not show. (1) Supabase's database certificates are signed by its own authority, not a public one, so the strict certificate rule would have refused to connect; an earlier code comment claiming otherwise was a guess. `DATABASE_CA_CERT` (a public file, set in the host's settings) is now the only authority trusted for that connection, used by the server, the migration and the first-owner command (`src/db/ssl.ts`, proved against a stand-in server with a private authority). (2) Supabase gives its public web API roles (anon, authenticated, service_role) every new table and function in `public`, where all of Nusuh Books lives: 1,638 objects were reachable on a simulated host. Migration 0060 revokes those grants and closes the default for later objects, and does nothing on a host without those roles; row-level security is untouched. Also: pool limits and timeouts (`DATABASE_POOL_MAX`, default 10, kept 1 to 50). To test against a real project, `scripts/hosted-db-check.ts` and the manual workflow `.github/workflows/hosted-db-check.yml` run the migrations, an exposure audit, the app's own login, row-level security, sign-in through the real API, speed and recovery against a throwaway Supabase project. Not yet run on a real project: it needs the owner's project and GitHub secrets. Also turn the project's Data API off in the Supabase dashboard. render.yaml is deliberately unchanged until the switch (it needs a DATABASE_CA_CERT entry then).
- **Google Drive backup (2026-11-21), not yet switched on**: the owner's Drive has folders Software, Marketing Website, Backups (Per version, Monthly) and Documents. The connector in a Claude session carries only about 3 MB of files per call, so the automatic route is `.github/workflows/drive-backup.yml` + `scripts/drive-backup.ts`, which send each push's source zip (new file per commit, nothing replaced), changed documents, and monthly the full git history (in pieces, join with `cat`) and the marketing screenshots. It talks to a small Google Apps Script web app the owner pastes into their own Drive account (`scripts/drive-upload.gs`; a service account cannot write to a personal Gmail Drive), which can write only into the five folders and is protected by a password kept in GitHub secrets. Off until the repository variable `DRIVE_BACKUP_ENABLED=true` and secrets `DRIVE_UPLOAD_URL`, `DRIVE_UPLOAD_SECRET` exist. Tested end to end against a fake Drive (22 tests, which also caught a folder-name lookup flaw); never run against real Google. Source and documents only: the live database's backups are the encrypted ones in `backup.yml`.
- **Demo**: the real app now runs as a free demo site (Render web service + Neon PostgreSQL 16, Frankfurt), demo data only, every background job and outside connection switched off, sign-in with the demo users (password demo1234, so share the address only with trusted people). It sleeps after 15 minutes and takes up to a minute to wake; Neon keeps only 6 hours of restore history. Every push to the branch redeploys it. Not for real data: the paid hosting, backups and security review below are still needed. A browser-only demo also exists as a claude.ai artifact.
- **Marketing screenshots**: 46 real screenshots with demo data in `marketing-screens/` (English and Arabic at 1440x900, phone layouts of the dashboard, sales and firm client list). Al Noor Trading has a labelled demo e-invoicing device ("Demo device (not connected to ZATCA)", self-signed demo certificate): its e-invoices are made by the real code and ZATCA's answers are stored as demo data; nothing is sent. The firm client list shows as cards on phones.
- **Production readiness (done)**: in production the server refuses to start with missing, short or example SESSION_SECRET / ENCRYPTION_KEY; the encryption key never falls back to the session secret. A real installation: `npm run db:migrate`, then `npm run db:install` (owner account with a one-time link), then the first customer and company in the owner console (README); the demo seed and reset refuse to run in production. Background jobs are owned by one server copy at a time (database lock, handed over when it stops), each run recorded; `/health` reports database and jobs. `ERROR_REPORT_URL` turns on error reports; logs and reports never hold passwords, keys, tokens, one-time codes or amounts. Security headers, same-site check on cookie requests, rate limits on public links. (An earlier line here said "backup and restore tested"; no backup code existed in the repository then. Real backups are the next item.)
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

- **Invoices, bills and payments in another currency (2026-11-17)**: an invoice or bill can now be written in USD, EUR
  or any other currency, and settled by a payment in that same currency. The rule that keeps the books provable is
  that **the ledger stays in one currency, the company's own**: a foreign document carries the amounts as written
  (what the customer reads, and what goes on the e-invoice) beside the same amounts converted at its own rate (what
  posts, and what every report, the aged list, statements and the amount due already read). When a foreign invoice is
  settled, the receivable is relieved at the rate the INVOICE was booked at, the bank gets what actually arrived, and
  the difference is a realised exchange gain or loss in account 4951 — the whole of realisation under IAS 21. A
  payment in another currency must settle in full, so there is never an unmeasured exchange exposure sitting on the
  books. ZATCA: a foreign invoice is reported in its own currency with the VAT total also given in SAR (BT-111, as
  BR-53 requires when the accounting currency is stated), and the XML of every riyal invoice is byte-for-byte what it
  always was, so no stored invoice hash moves. Proven by seeding the demo books with the previous code and with this
  one and comparing all 151 figures: identical. **Still only in the company's own currency**, on purpose: opening
  balances, expenses, employee claims, advance invoices, and bank accounts held in another currency. **Not yet done**:
  restating open foreign receivables and payables at the closing rate at period end (unrealised differences); the
  month-end revaluation from 0029 covers accounts kept in another currency, not per-invoice balances.

- **The checks that guard every change (2026-11-17)**: 672 automated tests and the type check run on every push,
  and so do browser checks that drive the real screens (sign in, issue an invoice, an invoice in another currency,
  Arabic right to left, a phone, and one company trying to read another's). Those browser checks were added because
  the database tests cannot see a broken screen: hiding the converted total on a foreign-currency invoice left all
  672 tests passing, and only the browser checks caught it. Two intermittent test failures were tracked to their
  causes and fixed — a bank-feed fixture whose pretend bank gave different transactions every run, and test
  connection pools missing the error listener a pool needs when the server closes a connection — and the suite then
  ran 25 times in a row with no failures and no errors, where before a problem appeared in roughly one run in three.

- **VAT rounding settled against ZATCA, and the e-invoice file name (2026-11-17)**: ZATCA's XML Implementation
  Standard v1.2 says in section 10 that a VAT category's tax amount is rounded once on the document and NOT added
  up from rounded line amounts. Nusuh Books did the opposite, which their arithmetic rule BR-CO-17 also forbids: a
  two-line invoice of SAR 3.10 each showed 6.20 taxable with 0.94 VAT, where 6.20 at 15% is 0.93. On random
  multi-line invoices the two rules disagree **38.5% of the time**, by one or two halalas, and an invoice that
  fails BR-CO-17 is one ZATCA can refuse. Each category's VAT is now worked out once on its own taxable amount and
  then shared over its lines, so the lines still add up, the ledger still equals the document, and the database
  itself enforces the rule when a document is issued. Invoices ALREADY ISSUED are untouched: they were immutable
  already, a credit note still copies the invoice's own VAT, and seeding the demo books both ways gives identical
  figures for all 78 issued documents. The e-invoice download is also named as ZATCA's section 14 requires
  (seller VAT number, issue date and time, invoice number) instead of the invoice number alone.
- **Ownership (Phase A, 2026-11-22; migration 0061).** Owners, partners and shareholders per company, with shares and percentages that apply from a date (earlier dates keep their earlier percentages), capital contributions, drawings, a partners' profit split by percent (exact to the halala), dividends declared into 2170 Dividends payable and then paid, and reversals for corrections. What is shown follows the legal form: sole establishment (one owner, drawings), partnership (percentages, drawings, profit split), anything else (shares, dividends). Each owner has a capital account (32xx) and a current account (33xx). Screens: Ownership > Owners, Capital and drawings, Changes in equity (English and Arabic). Own module key `Ownership` in job titles. Not yet: a demo-data version of the screens, a per-owner statement as PDF, share transfers as their own entry type (record a change of ownership on its date instead), and ownership in the portal.

- **Simpler menu and department users (Phase C, 2026-11-22; migration 0062).** Each module's sidebar shows only its main pages (Sales: Overview, Customers, Quotations, Invoices, Credit notes, Debit notes, Payments received); the other pages are one tap away in a "More in <module>" row under the page title and in the search box, so nothing was removed. New job titles for every customer: Owner, Finance, Sales, Commercial (purchasing and stock). New role module `OwnerReports` (owner summary, profit and loss, balance sheet, cash flow), and the home page no longer shows the month's income, expense and profit to a title without it. New customers' default Client accountant no longer includes Ownership or the owner reports. Not done: the demo build's job titles, per-cost-centre and per-project profit views are still under Reports and Projects, and a title with the trial balance can still work out profit by hand.

- **One login for a company that runs its own books (Phase B, 2026-11-22; migration 0063).** The Owner job title can carry the new right "may manage users and job titles" (`can_manage_users`). It works only for customers of kind `company`: that Owner signs in once, lands in their books, and has a "Users and job titles" link at the bottom of the menu that opens the same user and job title screens an Administrator uses, limited to their own customer. Accounting firms are unchanged (the Administrator stays a separate person who never sees books). Companies that run their own books no longer show the Portal or Review modules. Only Nusuh Books adds a company (as before). Not done: the owner console moving a company under an accounting firm (needs its own phase: users, job titles, staff assignments, portal threads and the calendar all move with it), and the demo build.

- **Demo mode and the demo site (Phase E, 2026-11-22; migration 0064).** A Demo mode button in the platform owner's side menu opens a SEPARATE demo site (its own service and database, `render-demo.yaml`) with a 15-minute signed link (`DEMO_SITE_URL` and `DEMO_LINK_SECRET` on the live service). There the owner picks a client type (hospitality, construction, trading, restaurant, retail, services, manufacturing, or an accounting firm with six clients) and lands inside a fictional company with all its data; everything can be tried and "change client type" returns to the picker. The demo database is filled by `tools/demo/seedDemoSite.ts` (GitHub Actions > Demo site data, 35 seconds; "Start again" refreshes the dates, monthly once `DEMO_SITE_ENABLED` is true). Safety: the demo site will not start, and refuses every request, unless its database is marked as a demo database and holds no real customer; it requires OUTSIDE_CALLS=off (no ZATCA, payments or rates), no email provider and no background jobs; the seed refuses any database that already holds a customer. Nothing is switched on yet: the demo database, its GitHub secrets, the second Render service and the two live settings are the owner's steps. Not done: the static click-through demo build is unchanged and does not carry this data.


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
- **Database host: Supabase (decided 2026-11-21).** The owner chose Supabase on their paid plan over Neon (Neon Launch would have been about $19 a month, uncapped). Reasons given: predictable cost, and the plan is already paid. Known trade-off, accepted: Supabase Pro keeps daily backups for 7 days, not restore-to-any-moment (that is a paid add-on), so our own encrypted backups matter more. Use a NEW project, never the LMS project (migration 0060 removes the public web API's access to the tables, which could break an app that uses it). Before the switch: the real-project check (`hosted-db-check`) on a throwaway project must pass. Neon stays live until then; its free hours last about 17 days once the Render server is paid and always awake.
- **Render paid plan and capacity (2026-11-22).** Web service moved to Starter (`0.5c-512mb`, $7/month) in `render.yaml`. Load test (`tools/loadtest/run.ts`, demo data): about 1.5 ms of app CPU and 20 ms of database CPU per request, 200 MB memory; the database, not the server, is the limit. Planning figure: about 40 client companies on Render Starter + Supabase Pro (Micro); upgrade when database CPU stays above 70% or Render memory above 400 MB. Estimates for Supabase and Neon are scaled, not run there.
- **Product direction (owner, 2026-11-22).** (1) Add ownership: owners/partners/shareholders, shares and percentages, capital contributions, drawings, dividends and partner profit split, for sole proprietor, partnership and LLC. (2) Sell direct to businesses, like Zoho Books: one company runs its own finances; firm features are hidden, not deleted. Order: Phase A ownership, then Phase B single-company front door. Nothing built yet.

## 7. Where things stand and what is next

**Marketing website (2026-11-24, no migration, folder website/).** The public site for nusuhbooks.com, built from the design canvas: 45 static pages (home, 16 module and 7 industry pages, pricing, order, how to pay, confirm payment, legal set), a Node build with no dependencies, and one PHP form handler (api/submit.php) that sends Contact, Book a demo, Confirm payment and Order to hello@ through Resend; order totals are recomputed on the server from config/pricing.json. Prices, contact facts, bank and company details live in config/ (admin-data.json is the file stand-in for the admin page; the dummy CR and VAT stop a production build). Checked against the design pixel for pixel at three widths, Lighthouse 96 to 100, 22 site, form and browser tests (website/README.md). Not done: real Resend delivery (needs the website key on Hostinger), Hostinger upload, the payment gateway, Arabic text.

**Owner Settings and verified email change (2026-11-24, migration 0069).** New Settings tab in the owner console: the sign-in email (changed only through a link sent to the new address, after the password and two-factor code; every older sign-in ends; the old address is told), an optional backup email (counts after its own link; gets security alerts), the email service (provider, sender, whether a key is set; never the key) and a Send test email button (only to the owner's own addresses, 5 a day, shows Waiting, Sent or Failed with the provider's reason). Everyone else (clients, staff, Administrators) has the same verified change under "My account" (the small menu above their name): their sign-in email and a Change button, with no backup email and no test email. Delivery to an inbox is not detected: Sent means the email service accepted it.

**Old address redirect (2026-11-24, no migration).** After the move to its own domain, setting REDIRECT_OLD_ADDRESS=on in Render makes page loads (GET) on the old *.onrender.com address go on to PUBLIC_URL (308); /health and changing requests are left alone. Off until set. Sign-in cookies belong to one address, so people sign in once on the new one.

**Bank feeds, exceptions and consent (2026-11-23, no migration).** Provider-neutral feed layer: each bank line carries the provider's own id so it is never imported twice (3-day overlap sync catches late-booked lines), unmatched and wrong-amount lines show under a new Exceptions tab, a consent ending soon shows a warning, an ended or withdrawn consent stops the feed and shows Reconnect (one press, resumes where it stopped), disconnect tells the provider. No bank logins are stored. Only the sandbox provider works: Lean, Mala'a, Tatbiq Darahem and Tarabut need a signed agreement, keys and the API spec first.

**New pricing (2026-11-23, migration 0068).** One plan, "Nusuh Books", replaces the monthly plans for every kind of customer (the four old plans stay in the table, off sale): software 9,000 once, an optional implementation (accounts fixation) 5,000 once chosen per customer, an annual membership of 1,500 with the core modules included, and 500 a year for each additional optional module (inventory, restaurant, rooms, assets, rentals, projects, HR, CRM). All amounts SAR before 15% VAT. The first invoice carries the one-time charges; renewals carry only the membership and the modules. A customer with several companies (an accounting firm) is charged once, with each module counted once; the owner has not yet said how a firm should be charged, so that is a stated assumption to confirm. The in-browser demo still shows its old sample plans.

**Remove a person (2026-11-23, migration 0067).** An Administrator can Remove (and Restore) the people of their own customer, and Nusuh Books can also remove an Administrator but never the last one. A removed person cannot sign in, any unused sign-in link stops working and they are hidden from the lists; their name stays on everything they did (posted entries and the audit log are never deleted). Nobody can remove themselves.

**Remove a customer, and Show / Hide password (2026-11-23, migration 0066).** The owner console has Remove (with a plain confirmation) and Restore on every customer, plus "Show removed customers". Remove hides the customer, locks everyone in it out, cancels its subscription and keeps every book and the audit log (posted entries can never be deleted); Restore undoes it. A password box with Show / Hide is on the sign-in page and the choose-a-password page.

**The Owner is not the Administrator (2026-11-23, migration 0065).** In a company that keeps its own books the owner (of Nusuh Books) now creates the company with TWO kinds of people: a separate Administrator login (users, roles and permissions, raise an issue; never the books) and the people who use the books (Owner, Finance, Sales and so on). The Owner job title no longer manages users by default; the right stays as an optional setting. This replaces the earlier "one login for the company owner" decision (Phase B). The Add customer flow needs at least one Administrator and one person who uses the books.

**A company with its own books IS the customer (2026-11-23).** There is no "customer, then companies inside it": the owner console opens the company's own page, and no accounting firm handles it (a firm is its own customer type, with the company added as one of its clients). The company's Owner has only Users, Roles and permissions and a Raise an issue button (the Help chat to Nusuh Books); Activity, E-invoices, Billing and Settings are not shown to them. No schema change.

**Add customer, "Company own accounts" is one flow (2026-11-23).** The owner console now makes ONE customer with ONE company and its people in a single save (POST /api/owner/customers/company, all-or-nothing in one transaction): company details, users with job titles (at least one Owner), review, then the customer's page with each person's one-time link. No add-companies screen exists for that kind of customer, and the server refuses a second company for it (err.oneCompany). The accounting firm flow is unchanged. No schema change.

**Owner exception to standing rule 1 (2026-11-23).** The owner wrote that rule 1 is lifted for ONE real client on the live site. Every other company stays demo or test data. Order agreed: move to Supabase first (owner doing it within the hour), then add the real client there; ZATCA stays sandbox-only and no real emails are sent until the owner says otherwise.

**Demo preview inside the live site (2026-11-23).** The platform owner's Demo mode button now opens /preview/index.html when no separate demo site is set up: the in-browser demo (sample companies held in the page, nothing saved, no database, a banner on every screen). Ownership sample data was added to it; the hotel sample has no Rooms yet (the in-browser demo has none). Remove the `build:preview` step from `build:prod` to take it off the site. The seven brochure companies stay in a scratch database only: loading them into the live database would be permanent (posted entries and the audit log cannot be deleted).

**Deployed to the live site (2026-11-23).** The owner asked for the live Render site to be updated; migrations 0061 to 0064 run on its database at deploy. The separate demo site still needs the owner's hosting steps.

**Demo mode built (2026-11-22).** Phase E is done and tested locally (see section 5); it needs the owner's hosting steps before the button works on the live site.

**Single-company front door built (2026-11-22).** Phase B is done and tested (see section 5). Next candidates: moving a company under an accounting firm (owner console), then Google sign-in and the 15-day trial.

**Menu and department users built (2026-11-22).** Phase C is done and tested (see section 5). Phase B (single-company front door) is still next; its first user should get the Owner title.

**Ownership built (2026-11-22).** Phase A of the owner's two product changes is done and tested (see section 5). Next, Phase B: the single-company front door (sell direct to businesses, firm features hidden, not deleted; the menu already hides the Portal for a customer that keeps its own books). Pushed with `[skip render]`, so the live site gets it at the next deploy; the migration is additive.

**Readiness check before hosting (2026-11-18).** Every route of the API was called with empty and malformed input as
each kind of user (21,504 requests over 392 routes). It found three places where the server answered a crash rather
than a plain error, all the same mistake: a field the screens always send as a list was read as one without checking,
so a different shape ended in an unhandled error. They are fixed and the check now runs with every build
(`test/routeProbe.test.ts`), which also lifted measured coverage of the server code from 84% of lines to 95%. One
test that compared sign-in response times was unreliable and could fail a build with nothing wrong in the code; it now
takes more readings and compares middles. **Still not covered by automated checks:** sending real email through the
provider, subscription billing, and the background jobs — each needs a live account to exercise properly.

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
