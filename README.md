# Nusuh Books

Accounting platform for accounting firms and their clients in Saudi Arabia and the UAE, and later Oman.
Read `CLAUDE.md` first. It holds the non-negotiable accounting rules.

## Status
- **Step 1, Foundation:** done. This covers the database schema, row-level security, the ledger, period locks, cost centres, the audit log and VAT calculation. There is an automated test for every rule in `docs/ACCOUNTING_RULES.md`.
- **First screens:** React front end built from `prototype/nusuhbooks.html`, connected to the real database through an API:
  - Sign in (with one-click demo accounts in development)
  - Firm staff: **My clients**, showing only the clients assigned to them
  - Client books: **Home** dashboard, **Journal** (post, search, reverse, period locks), **Reports** (trial balance, P&L, P&L by cost centre) and **VAT** summary. Sales, Purchases, Bank, Inventory, Assets and Review show what comes next.
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
| `npm run db:migrate` | Applies new database migrations. |
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
