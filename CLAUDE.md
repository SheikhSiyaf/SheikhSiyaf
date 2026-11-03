# Nusuh Books

Accounting platform for accounting firms and their clients in Saudi Arabia, UAE (Dubai), later Oman.
One firm login reviews many client companies; client accountants do daily entry.

## Stack (proposed)
PostgreSQL, TypeScript (Node) API, React front end, Vitest for tests. One codebase for all clients; per-client settings, never copies.

## Non-negotiable accounting rules
1. Double entry: every journal entry balances (total debit = total credit) and has at least 2 lines.
2. Posted entries and lines are never edited or deleted. Corrections use reversal entries or credit notes.
3. Locked periods reject any posting.
4. Every journal line can carry a cost centre; accounts can require one.
5. Every change is written to the audit log.
6. Strict data separation between client companies (row-level security).
7. Money is NUMERIC(18,2) in the database and integer minor units or a decimal library in code. Never floats.
8. Any change to ledger, VAT or report logic must come with automated tests, and all tests must pass.

## Workflow
- Read docs/ACCOUNTING_RULES.md before touching ledger code. Write the test first.
- Invoice data layout is identical for all countries; each country's e-invoicing (ZATCA, UAE Peppol via accredited provider, Oman Fawtara) is a separate adapter.
- Confirm e-invoicing dates and technical specs with the tax authorities before building them.
- Arabic and English with RTL from the start; no hard-coded strings.
- Plain accountant language in the UI; prevent errors instead of showing error messages.

## Build order
1 Foundation (db, logins, roles, audit, cost centres, ledger, period lock) -> 2 Sales/purchases/inventory/assets/bank -> 3 Reports and review layer -> 4 ZATCA, then UAE -> 5 Portal, calendar, approvals, forecast -> 6 HRM, CRM, restaurant -> 7 Pilot.

## Users and access (decided)
- Customers (tenants): accounting firms (keep books for clients) and companies that run their own books. The platform owner (the seller of Nusuh Books, owner console) creates every customer, its first Administrator and every company; it opens a customer's Administrator console to do so and never sees books.
- Five kinds of people: platform owner; Administrator (one customer's admin console only, never sees books); firm staff (Firm partner, Reviewer, Staff accountant; see only clients assigned to them; firms only); client users (each with a client role; see only their own company).
- A company customer's Administrator manages its users, roles, access and activity only; company details are kept by the owner. Its finance team reviews and signs off through roles with review and sign-off rights.
- No client or role switcher inside the app. Login decides everything.
- Roles: partner/staff accountant/client accountant can post; reviewer reviews and signs off; only partner locks periods; only the platform owner adds companies; the Administrator adds staff (firms) and users.
- Client roles: the Administrator defines job titles for client users (Admin > Roles and permissions) with None/View/View and enter per module and an "approve claims" right. Every role is editable: Client accountant and Client management are created for each firm as ordinary roles, and every client user has a role. Checked in the API per module; the database still blocks writes for view-only roles.
- Client data must never mix: every row carries company_id, every query is scoped by the user's assigned companies, enforced in the database (row-level security) and tested.

## Client registration (decided)
Required: company name, country, industry, CR (or trade licence in UAE) number, legal form, VAT status, address, city, financial year end, first client user (name, email).
The industry sets the optional modules (Inventory, Restaurant, Assets, Projects, HRM, CRM; a restaurant gets Restaurant instead of Inventory); the Administrator can change them.
VAT number required only if VAT registered; "VAT unregistered" means VAT rate 0%.
Optional: Arabic name, trade name, CR expiry, VAT registration date, phone, email, website, logo, compliance notes, staff assignment.
Validation: SA CR 10 digits; SA VAT 15 digits starting and ending with 3; UAE TRN 15 digits; CR and VAT numbers unique across clients.
Entry settings per client: invoice prefix, payment terms, period lock date.

## Reference
- docs/PRODUCT_SPEC.md: full feature list. docs/DECISIONS.md: decisions and open questions. docs/ACCOUNTING_RULES.md: tests to write first.
- prototype/nusuhbooks.html: clickable UI prototype (browser-only data). Use it as the visual and flow reference, not as production code.

## Commands
- First run: `npm install`, `cp .env.example .env`, `npm run db:up`, `npm run setup`, `npm start` -> http://localhost:3000. Dev: `npm run dev` -> http://localhost:5173. See README.md.
- `npm test` (rules, separation, API) and `npm run typecheck` must pass before every commit.
- Every UI string lives in web/src/i18n.tsx (English and Arabic). Amounts use src/money.ts, never floats.
- Schema changes go in a new file in `db/migrations/`. Never edit an applied migration. Record each change and the reason for it in docs/SCHEMA_CHANGES.md.
