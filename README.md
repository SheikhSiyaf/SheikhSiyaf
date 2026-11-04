# Nusuh Books

Accounting platform for accounting firms and their clients in Saudi Arabia and the UAE, and later Oman.
Read `CLAUDE.md` first. It holds the non-negotiable accounting rules.

## Status
- **Step 1, Foundation:** done. This covers the database schema, row-level security, the ledger, period locks, cost centres, the audit log and VAT calculation. There is an automated test for every rule in `docs/ACCOUNTING_RULES.md`.
- **First screens:** React front end built from `prototype/nusuhbooks.html`, connected to the real database through an API:
  - Sign in (with one-click demo accounts in development)
  - Firm staff: **My clients**, showing only the clients assigned to them
  - Client books, with a sub-menu under each module:
    - **Sales:** overview of what is owed and what is late; customers; quotations (send, accept, convert to invoice); tax invoices; credit notes; payments received, which settle invoices oldest first.
    - **E-invoicing** (Sales > E-invoicing; step 4):
      - **Saudi Arabia, ZATCA phase 2:** save the national address, then connect a device with the one-time password from the Fatoora portal (sandbox, simulation or production). Nusuh Books makes the device key and CSR, gets the compliance certificate, runs ZATCA's six compliance checks and gets the production certificate. From then on every invoice and credit note is made as UBL 2.1 XML with its hash chain (counter and previous hash), signed (ECDSA, XAdES) with the phase 2 QR code, and sent straight after issuing: invoices to businesses are cleared, sales to consumers reported. Rejected ones show ZATCA's reasons and are prepared again after the fix; if ZATCA cannot be reached they wait and are sent again. Each invoice shows its status and its XML; the PDF prints ZATCA's QR. A tax invoice to a Saudi business needs the customer's national address (building number, street, district, city, postal code).
      - **UAE, Peppol PINT AE:** turned on per company; invoices and credit notes to businesses with a TRN are prepared as PINT AE XML for the accredited service provider (to be chosen).
    - **Purchases:** overview; suppliers; bills; supplier credits; payments made.
    - **Expenses:** overview (this month against last month, biggest categories, recurring expenses due); expenses paid at once by cash, card or bank, with a supplier or just a payee name, and voided if wrong; recurring expenses that create drafts to check; categories, which are expense accounts.
      - **Employee claims:** an employee's out-of-pocket spending is entered as a claim and submitted. Someone other than the person who submitted it approves it (it then posts to `2200 Employee claims payable`) or rejects it with a reason (it goes back to draft to be corrected). **Approvals** lists the claims waiting. Approved claims are paid back with **Reimburse employee**.
    - **Projects:** every project with income, costs, profit and budget used, from lines tagged with the project; a project page with its transactions; a comparison report. Projects are cost centres, so any invoice, bill, expense or claim line can be tagged.
    - **HRM** (Saudi Arabia and UAE rules):
      - **Overview:** headcount and share of nationals, monthly wages, who is on leave, the last payroll, documents expiring within 60 days.
      - **Employees:** HR details per person (nationality, ID or iqama, join date, contract, basic and allowances, IBAN, WPS IDs in the UAE, GOSI or GPSSA), opening leave and end of service balances, their documents, and the final settlement.
      - **Attendance:** a monthly sheet of days absent and overtime hours, typed in or imported from a file; leave taken shows beside it.
      - **Leave:** annual, sick, unpaid and other paid leave, requested and approved (approving needs the approve right in a client role); balances by law (Saudi 21 days, 30 after 5 years; UAE 30).
      - **Time clock:** HRM > Attendance > Import time-clock file reads the month from the clock (CSV or Excel; one row per person per day, or one row per punch; English or Arabic headers) with a preview: present, absent, leave, off (weekend by country, public holidays) and overtime beyond the normal hours of the day, per person. The month day by day shows every day; the monthly sheet for payroll follows it. An absence, or a day of approved leave, is changed only by a correction request (absence into leave, absence excused, leave days given back) that someone else with the approve right approves, in Attendance or the Approvals hub. A new file never overturns a recorded absence or leave day.
      - **Payroll:** prepare a month, add bonuses and deductions, post it as one journal entry (salaries and social insurance by cost centre, end of service provision, loan repayments, net pay to Salaries payable), pay it from the bank, bilingual payslips (PDF), and the salary file (UAE WPS SIF, or a Saudi payroll file for Mudad or the bank). Social insurance: GOSI in Saudi Arabia, GPSSA for UAE nationals. Overtime, unpaid leave, absence and sick pay tiers follow the labour laws.
      - **Loans and advances:** paid out from the bank and repaid from salary each month.
      - **End of service:** what each person would get today (and on resignation) next to the provision held; final settlement with end of service, unused leave and any loan recovered.
      - **Iqama and documents:** iqama, Emirates ID, passports, visas, contracts and insurance with expiry dates and attached scans.
    - **Journal:** entries, new entry, periods.
    - **Ledger:** chart of accounts (add and rename accounts, by type, with balances); cost centres (branches and departments, kept apart from projects); general ledger for any account and cost centre ledger, with opening, running and closing balances; customer, supplier and employee ledgers. The employee ledger shows claims approved and paid back.
    - **Reports:** owner summary (cash, receivables, payables, VAT due, this month against last month, year to date, ratios, top customers and expenses), P&L (with last month, last year or month-by-month columns), balance sheet (with comparison date), cash flow, trial balance, P&L by cost centre, expenses by category, expenses by supplier, aged receivables, aged payables, VAT summary and the VAT return worksheet. Click any account to open its ledger. Every report has **PDF** and **Excel** buttons. Reports show account names, without codes. The P&L reads Sales, less Cost of sales = Gross profit, less Indirect expenses, add Indirect income = Net profit; each account's line can be changed in Ledger > Chart of accounts. P&L by cost centre shows branches and departments, with projects kept apart.
    - **Bank:** bank accounts (add your own; the IBAN is checked and names the bank, and the account in the books is created for you); import a statement as CSV or Excel (the file is matched to the bank account by its IBAN or account number, columns are found in English or Arabic or set once per account, and lines already imported are skipped); review each line with a suggestion (already in the books, a customer or supplier payment, or a rule) and match, book or ignore it; reconciliation (books, statement and the difference); rules ("always do this").
    - **Inventory:** items with quantity, average cost and value; goods received notes (GRN, inbound: Dr 1300 Inventory, Cr 2050 Goods received not yet billed); goods delivery notes (GDN, outbound at average cost: Dr 5000 Cost of sales, Cr 1300); stock value against 1300 in the books.
      The **warehouse counter** works like a till: scan a barcode (a USB or Bluetooth scanner, or the phone camera where the browser can read barcodes) or type the item code, `5*code` adds five, tap tiles, then one button records and posts the goods received or delivery note. A code nobody knows can be added as a new item on the spot. Every item has a barcode: the supplier's, or one Nusuh makes (EAN-13 starting with 2); labels print three across on A4 after goods in or from the item page.
    - **Restaurant** (for clients whose industry is restaurant or café, instead of Inventory): food sales with a tap-to-sell order pad (each sale issues the tax invoice, takes the recipe materials out of stock at average cost and records the cash, card or bank payment; a sale on account stays to be paid); the menu with recipes, cost per portion, food cost % and margin; materials; materials in; waste and staff meals; stock value; a stock counter for materials in and out.
    - **Assets:** fixed asset register (cost, depreciation to date, book value, against the books); monthly straight-line depreciation posted one month at a time; selling or scrapping an asset with its gain or loss.
    - **CRM** (light, no postings to the books):
      - **Pipeline:** open deals as a board by stage (New, Interested, Quotation sent, Negotiation), with totals, likely value (each stage's chance), deals won this year and win rate. A deal can make a Sales quotation for its customer; the deal then follows it (sent, accepted, invoiced = won, declined = lost).
      - **Leads:** possible customers with where they came from (or the campaign), who follows up, possible value and status; **Make customer** creates the customer in Sales and can open a deal.
      - **Activities:** calls, meetings, tasks, emails and notes with due dates, for a lead, deal or customer; to do, overdue and done. Customer pages in Sales show their activities.
      - **Campaigns:** channel, dates and budget, with the leads, customers and won deals they brought in and the cost per lead.
    - **Review** (the firm's review layer; clients read it and answer queries):
      - **Overview:** one month at a glance: findings to look at, checklist progress, open queries and sign-off.
      - **Automated checks:** possibly missing input VAT, VAT claimed without a supplier VAT number, sales without standard VAT, possible duplicates, round amounts in manual entries, bank lines not reconciled, balances on the wrong side, invoices over 90 days overdue, drafts never issued, payroll not posted, depreciation not run. Each finding links to the document, entry or account; the firm explains it (it stays listed) or asks the client.
      - **Queries:** questions from the firm to the client with replies on both sides; a client reply marks it answered; only the firm closes it.
      - **Monthly checklist:** bank reconciled, sales and purchases complete, no drafts, VAT reviewed, payroll, depreciation, stock, customer and supplier balances, accruals, queries closed. Items the books can answer tick themselves.
      - **Period sign-off:** a partner or reviewer signs off a finished month once its checklist is done and its queries are closed. The client's Home page then shows "Reviewed by your accountant up to ...". Entries changed after sign-off are flagged; a sign-off can be withdrawn with a reason, never deleted.
      - **My clients** shows, for each client, how far it is reviewed and the answers waiting for the firm.
  - **Portal** (between the accounting firm and its client; not shown to a company that keeps its own books):
      - **Overview:** for the client, what the accountant asked for, documents sent, files from the accountant and unread monthly reports; for the firm, new documents, answers to check and requests waiting.
      - **Requests:** the firm asks for documents (kind, month, needed-by date); the client answers by sending them; only the firm marks a request received or asks again.
      - **Documents:** the client sends PDFs or photos (up to 10 MB each) with a note, for a request or on their own; the firm marks them dealt with, and shares files back (returns as filed, letters). Files can be removed by the sender until the firm has dealt with them.
      - **Monthly reports:** the firm publishes a short letter for a finished month; sales, profit, cash, receivables, payables and VAT are taken from the books at that moment and kept. Opening it marks it read for the firm to see.
    - **Calendar** (compliance deadlines): VAT returns (monthly or quarterly, staggered UAE quarters), GOSI or GPSSA and UAE WPS salaries (with HRM), Saudi zakat, UAE corporate tax, the CR or trade licence expiry, employee documents expiring, and the client's own deadlines (once or repeating). A list grouped by month or a month view; mark done with the filing reference; settings choose what applies. Home shows what is overdue or due within 14 days; **My clients** shows each client's overdue deadlines, next deadline and new portal documents.
; pressing it again closes it.
  - **PDFs:** every invoice, credit note, quotation, bill, expense, claim and goods note has a **PDF** button. It opens a professional A4 page in the print window; choose "Save as PDF". Saudi tax invoices carry the ZATCA phase 1 QR code. Bills, expenses, claims and goods notes can have attachments (the supplier's invoice as a PDF or photo, up to 10 MB); pictures are printed on pages after the document.
  - **Line editors:** quantity and price boxes show the full number; on laptop screens each line takes two rows so nothing scrolls out of view.
  - **Arabic names:** when you type an English name for a customer, supplier, employee, project, category or client, the Arabic name is filled in as a suggestion (common business words are translated, names are written in Arabic letters). It is worked out inside the app, so no names are sent anywhere. Change it if needed; once you edit it, it is not overwritten.
  - **Owner console (Nusuh Books):** the customer list (accounting firms and companies that run their own books), a new customer with its first Administrator and sign-in link, another Administrator, suspend or reactivate, and **Open** to work in that customer's Administrator console, where only the owner adds companies. The owner never sees books.
  - **Billing and subscriptions (owner console > Billing, Plans):** plans with a monthly and yearly price, companies and users included and the price of each extra one; each customer's subscription (plan, monthly or yearly, free trial, discount, cancel at the end of the period). Customers are billed in advance (VAT and seller details from the billing settings), with their companies and users on the day; a job every six hours bills what is due (`BILLING_JOBS=off` turns it off; Run billing now does it by hand) and emails the invoice to the customer's Administrators. The owner marks invoices paid or voids them; an overdue invoice makes the customer past due. The customer's Administrator sees its plan, usage, next invoice and invoices in Admin > Billing.
  - Administrator console:
    - **Clients** (Companies for a company customer): summary (active, suspended, without staff), search, the **Add client** registration page for the owner (the industry chosen there turns on the client's modules, which can be changed), and a **Manage** page per client. A company customer's Administrator has no Staff tab and sees company details read-only. The Manage page lets you edit details and entry settings, add client users, tick which staff handle the client, and suspend or reactivate it.
    - **Staff:** add staff, change the clients each person handles, send a new sign-in link, reset two-factor, and suspend or reactivate.
    - **Accountant tools:** Sales > Recurring invoices (draft, issue, or issue and email on each date; hourly job as the person who set it up), Sales > Statements (statement of account with ageing, emailed with a CSV copy), Sales > Payment reminders (overdue invoices, reminders by hand or automatically at chosen days after the due date, each once), Reports > Budgets (per account and cost centre, month by month, against actual), the bell in the top bar (approvals, corrections, claims, overdue invoices, low stock, failed emails, rejected e-invoices, portal answers), bulk issue and email on document lists, Take a photo on attachments (receipts from the phone camera), and Ledger > Chart of accounts > Export everything (one CSV per kind of record in a ZIP).
    - **Counter joined to sales and purchases:** on the warehouse counter, tick *Make the customer's invoice too* on goods out to post the delivery note and issue the invoice in one step (at each item's sale price, which can be changed; paid now into a cash or bank account by cash or card, or on account), or *Make the supplier's bill too* on goods in to post the goods received and make the supplier's bill as a draft at the cost received, on 2050 (issuing it clears 2050), from an open purchase order when there is one. Needs Sales or Purchases access as well as Inventory; the invoice or bill shows which goods note it came from.
    - **Online payments:** Sales > Online payments chooses the provider (Sandbox to try it out, or Moyasar for mada, cards and Apple Pay with the company's keys; the secret key is stored encrypted) and the bank or clearing account the money lands in. The invoice link then shows **Pay online**; when the provider confirms (its webhook at `/api/public/payments/webhook/moyasar`, or the customer coming back), the server asks the provider itself and records the payment against the invoice once, as the person who turned online payments on. The demo companies have the sandbox turned on.
    - **Bank feeds:** on a bank account, *Connect to the bank* brings its transactions in as statement lines by themselves (the last 30 days at first, then every six hours or Sync now; `BANK_FEED_JOBS=off` turns the job off), through the same import as a statement file (no duplicates), and the bank rules book what they recognise. The built-in sandbox bank shows how it works (card settlements, fees, customers paying open invoices by transfer). Lean and Tarabut are listed but need an agreement and their API specification before their adapters are written; the bank consent lasts 90 days and is renewed by connecting again.
    - **Email:** set `EMAIL_PROVIDER` (resend, sendgrid or postmark, with `RESEND_API_KEY`, `SENDGRID_API_KEY` or `POSTMARK_TOKEN`; `log` for development) and `EMAIL_FROM`. Without a provider, emails wait in the outbox. Invitations, password resets (Forgot your password? on the sign-in page), approvals waiting, and invoices, credit notes and quotations (Email to customer on the document: a two-language email with a link that opens the document without signing in, to print or save as PDF; the e-invoice XML attached) all go through it. Sales > Emails sent lists them, with retry.
    - **Year-end:** Journal > Year-end closes a financial year (partner only, in order, after it has ended): one entry on the year end moves income and expenses to 3100 Retained earnings per cost centre, and every month of the year is locked; the P&L still shows the year's result. The latest closed year can be reopened with a reason (its closing entry is reversed).
    - **Currencies:** Ledger > Chart of accounts lets an asset or liability account be kept in another currency (a USD deposit, a EUR loan). Journal lines on it take the foreign amount and the day's rate (filled in, can be changed). Ledger > Currencies and rates shows the rates, fetched daily (`FX_RATES_URL`, default open.er-api.com; GCC currencies and the US dollar always follow the central bank pegs) and the company's own rates. Ledger > Currency revaluation restates the foreign balances at the month-end closing rate (IAS 21) to 4950 unrealised and 4951 realised exchange gains and losses, with a preview, reversal, and an optional automatic run each month.
    - **Roles and permissions:** job titles for client users (for example Cashier, Store keeper, Finance manager), each with No access, View only or View and enter per module, and whether it may approve expense claims. A role can be **counter only (POS)**: its people sign in straight to the counter (warehouse goods in and out, the restaurant order pad) with no books menu; the demo has Yousef (store keeper, Al Noor Trading) and Maya (counter cashier, Marina Café). Client accountant and Client management are ordinary roles too and can be changed like any other. Each client user's role is chosen on the client's Manage page. A client user sees only the modules their role allows; firm staff keep their own roles.
    - **Activity:** who changed clients, people and access. It never shows the books.
    - **Settings:** firm name and sign-in security.
  - **Sign-in links:** new people set their own password from a one-time link that expires after 7 days. The Administrator copies the link and sends it to the person; sending it by email comes later.
  - **Approvals:** what waits for a decision (bills, supplier payments, customer credit notes, with a link to employee claims), the history, and the rules (from which amount, with VAT, each needs approval). A bill or credit note at or above the amount shows **Send for approval** instead of Issue; a supplier payment the same. While waiting the draft is locked; the sender never approves; approvers are the firm's partner and reviewer and client roles with the approve right; once approved the sender issues it or records the payment exactly as approved. Home and My clients show what waits for you.
  - **Cash flow forecast** (Reports): 13 weeks or 6 months from today's cash and bank: customers and suppliers by due date, bills waiting for approval, employee claims, recurring expenses, last month's payroll, social insurance and VAT returns due, plus your own items (once or repeating). A chart of the cash at the end of each period, the lowest point, a warning below the minimum cash you set, "customers pay N days late", and every figure opens what makes it up.
  - **Import data** (Ledger > Import data, and **Import from Excel** on the customer, supplier, item and chart of accounts lists): customers, suppliers, items, accounts and opening balances from Excel (.xlsx) or CSV. Download a template (English or Arabic headers) or use your own file; headers are found in any order, Arabic digits are read. Every row shows what will happen (added, already there, or left out and why) before anything is imported. Opening balances post as one balanced entry (any difference can go to owner's equity), never into a locked month.
  - **Search** (top of the menu, Ctrl+K or /): pages, customers, suppliers, employees, items and documents by number, name or VAT number, only what the person's role allows.
  - **Getting started** (Home): a checklist for a client being set up (bank account, customers, suppliers, items, opening balances, e-invoicing, approval rules, first invoice), with a button for each step.
  - **Menu sections**: Today, Money in and out, Operations, People, Books and review, each module with an icon.
  - **Sidebar:** your initials, name and role sit in one row at the bottom with a sign-out button; your email and two-factor sign-in open from your name. The menu scrolls above it and keeps the open module in view.
  - **Two-factor sign-in:** each person turns it on from their name at the bottom of the sidebar by scanning a QR code with an authenticator app. After 5 wrong passwords or codes, sign-in for that account is blocked for 15 minutes.
  - English and Arabic (right to left), light and dark mode, and phone layout

## Run it on your computer

You need **Node.js 20 or newer** (https://nodejs.org) and **Docker Desktop** (https://www.docker.com/products/docker-desktop), which runs the PostgreSQL database.

Open a terminal in this folder and run:

```bash
npm install              # 1. install the packages (first time only)
cp .env.example .env     # 2. create your settings file (first time only; on Windows: copy .env.example .env)
npm run db:up            # 3. start PostgreSQL in Docker
npm run setup            # 4. create the tables, load the demo firm, build the web app
npm start                # 5. start Nusuh Books
```

Then open **http://localhost:3000** in your browser.

On the sign-in page, click any demo person to sign in as them. Every demo account uses the password `demo1234`.
| Person | What they see |
|---|---|
| Nadia Admin | Administrator console: clients and staff, never the books |
| Omar Al Harbi | Firm partner: all 3 clients; can lock and unlock periods |
| Layla Haddad | Reviewer: 2 clients; read only |
| Rami Saleh | Staff accountant: 1 client |
| Sara Nasser | Client accountant at Al Noor Trading: posts entries |
| Faisal Al Qahtani | Client management at Al Noor Trading: view only |

Stop the app with `Ctrl+C`. Stop the database with `npm run db:down`. Your data is kept for next time.

### While developing (live reload)
```bash
npm run dev
```
Then open **http://localhost:5173**. Edits to the screens appear straight away. The API runs on port 3000 behind it.

### Other commands
| Command | What it does |
|---|---|
| `npm test` | Runs every accounting-rule, data-separation and API test against a throwaway `nusuh_test` database. |
| `npm run typecheck` | Type-checks the server and the web app. |
| `npm run build` | Rebuilds the web app into `web/dist` (needed after changing screens before `npm start`). |
| `npm run db:migrate` | Applies new database migrations. Run it after pulling new changes, then `npm run build`. |
| `npm run db:seed` | Loads the demo firm, if it is not there yet. |
| `npm run db:reset` | Development only: deletes the database and starts again with fresh demo data. |

### Live preview in the Claude desktop app
`.claude/launch.json` defines two previews: **dev** on port 5173 and **built** on port 3000.
When you open this folder in Claude Code in the desktop app on your own computer, Claude can start a preview and show it in the app's browser pane.
Start the database first (`npm run db:up` and `npm run setup`).

### If something goes wrong
- **Port 5432 already in use:** another PostgreSQL is running. Stop it, or change the port in `docker-compose.yml` and in `.env`.
- **"password authentication failed for user nusuh_app":** `APP_DB_PASSWORD` and the password in `DATABASE_URL` in `.env` must match. Run `npm run db:migrate` again after changing them.
- **The page says it cannot reach the server:** check that `npm start` (or `npm run dev`) is still running in the terminal.

## Folder structure
```
db/migrations/      SQL migrations, applied in name order. This is the source of truth for the schema.
src/api/            HTTP API (Fastify). Every request runs as the signed-in user, so the database rules apply.
src/auth/           Password hashing (scrypt) and the signed session cookie.
src/books/          Chart of accounts template copied to each new client.
src/db/             Migrations runner, request session (withUser), demo data, seed, reset.
src/ledger/         Posting, reversal, trial balance and period lock.
src/vat/            VAT per line and credit notes, in exact integer minor units.
src/money.ts        Decimal strings <-> bigint minor units. Never floats. Shared with the web app.
web/                React front end (Vite). web/src/i18n.tsx holds every English and Arabic string.
test/               Vitest suites: accounting rules, separation, roles, registration, VAT, API.
docs/               Product spec, decisions, accounting rules, schema changes.
prototype/          The original clickable prototype (visual and flow reference only).
```

## How data separation works
- The API connects as `nusuh_app`. That role is not a superuser, owns no tables and cannot bypass row-level security.
- Each request is one transaction that sets `app.user_id` from the signed-in session.
  The database works out which companies the user can see, and their role in each, from `memberships`.
- Every table has row-level security. Triggers protect the ledger and the audit log so that even the owner role cannot change them.

## Before real client data
- Hosting with HTTPS. In `.env`, set `NODE_ENV=production`: the server then refuses to start, listing every problem, until:
  - `SESSION_SECRET` and `ENCRYPTION_KEY` are each at least 32 characters and different (never change `ENCRYPTION_KEY` afterwards)
  - `DATABASE_URL` connects as `nusuh_app` with a real password, and is not `DATABASE_ADMIN_URL`
  - `COOKIE_SECURE=true`, and `PUBLIC_URL` is the `https://` address people use (the only address used in links)
  - `DEMO_LOGINS` is not true (and do not load the demo data)
  Outside production the same list is printed as warnings at start-up. Behind your own proxy, set `TRUST_PROXY`.
- Everyone turns on two-factor sign-in. Settings shows how many have.
- Sending sign-in links by email (today the Administrator copies the link and sends it).
