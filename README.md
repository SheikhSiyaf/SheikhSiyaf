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
    - **Purchases:** overview; suppliers; bills; supplier credits; payments made.
    - **Expenses:** overview (this month against last month, biggest categories, recurring expenses due); expenses paid at once by cash, card or bank, with a supplier or just a payee name, and voided if wrong; recurring expenses that create drafts to check; categories, which are expense accounts.
      - **Employee claims:** an employee's out-of-pocket spending is entered as a claim and submitted. Someone other than the person who submitted it approves it (it then posts to `2200 Employee claims payable`) or rejects it with a reason (it goes back to draft to be corrected). **Approvals** lists the claims waiting. Approved claims are paid back with **Reimburse employee**.
    - **Projects:** every project with income, costs, profit and budget used, from lines tagged with the project; a project page with its transactions; a comparison report. Projects are cost centres, so any invoice, bill, expense or claim line can be tagged.
    - **HRM:** employees (number, job title, default cost centre). Payroll, leave, attendance, end of service, and iqama and documents describe what they will do.
    - **Journal:** entries, new entry, periods.
    - **Ledger:** general ledger for any account and cost centre ledger, with opening, running and closing balances; customer, supplier and employee ledgers. The employee ledger shows claims approved and paid back.
    - **Reports:** trial balance, P&L, P&L by cost centre, expenses by category, expenses by supplier, aged receivables, aged payables, VAT summary. The VAT return comes later.
    - **Bank:** bank accounts (add your own; the IBAN is checked and names the bank, and the account in the books is created for you); import a statement as CSV or Excel (the file is matched to the bank account by its IBAN or account number, columns are found in English or Arabic or set once per account, and lines already imported are skipped); review each line with a suggestion (already in the books, a customer or supplier payment, or a rule) and match, book or ignore it; reconciliation (books, statement and the difference); rules ("always do this").
    - **Inventory:** items with quantity, average cost and value; goods received notes (GRN, inbound: Dr 1300 Inventory, Cr 2050 Goods received not yet billed); goods delivery notes (GDN, outbound at average cost: Dr 5000 Cost of sales, Cr 1300); stock value against 1300 in the books.
    - **Assets:** fixed asset register (cost, depreciation to date, book value, against the books); monthly straight-line depreciation posted one month at a time; selling or scrapping an asset with its gain or loss.
    - **CRM and Review:** their sub-pages describe what each will do. CRM covers leads, pipeline, activities and campaigns.
  - **Sidebar:** pressing a module opens its sub-menu; pressing it again closes it.
  - **Line editors:** quantity and price boxes show the full number; on laptop screens each line takes two rows so nothing scrolls out of view.
  - **Arabic names:** when you type an English name for a customer, supplier, employee, project, category or client, the Arabic name is filled in as a suggestion (common business words are translated, names are written in Arabic letters). It is worked out inside the app, so no names are sent anywhere. Change it if needed; once you edit it, it is not overwritten.
  - Administrator console:
    - **Clients:** summary (active, suspended, without staff), search, the **Add client** registration page, and a **Manage** page per client. The Manage page lets you edit details and entry settings, add client users, tick which staff handle the client, and suspend or reactivate it.
    - **Staff:** add staff, change the clients each person handles, send a new sign-in link, reset two-factor, and suspend or reactivate.
    - **Activity:** who changed clients, people and access. It never shows the books.
    - **Settings:** firm name and sign-in security.
  - **Sign-in links:** new people set their own password from a one-time link that expires after 7 days. The Administrator copies the link and sends it to the person; sending it by email comes later.
  - **Two-factor sign-in:** each person turns it on from the bottom of the sidebar by scanning a QR code with an authenticator app. After 5 wrong passwords or codes, sign-in for that account is blocked for 15 minutes.
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
- Hosting with HTTPS. In `.env`:
  - set `COOKIE_SECURE=true`
  - set real values for `SESSION_SECRET` and `ENCRYPTION_KEY`, and never change `ENCRYPTION_KEY` afterwards
  - set `PUBLIC_URL` to the address people use
  - set `DEMO_LOGINS=false`, and do not load the demo data
- Everyone turns on two-factor sign-in. Settings shows how many have.
- Sending sign-in links by email (today the Administrator copies the link and sends it).
- The sign-in attempt limit is kept in server memory. If the app ever runs on more than one server, it should move to the database.
