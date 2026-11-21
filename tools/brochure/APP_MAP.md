# Nusuh Books: app map for the brochure screenshots (Stage 1)

Read from the repository on 2026-11-21. Nothing in the product code was changed. "Confirm" marks a point I could only
read in code and will check on screen during capture.

## 1. Who signs in, and where they land

| Kind (role) | Who | Lands on | Menu |
|---|---|---|---|
| `owner` | Nusuh Books platform owner | `/owner` | Customers, Billing, Plans, Support. Can act inside one customer's console (`/admin/*`) |
| `admin` | Administrator of one customer (an accounting firm, or a company that keeps its own books) | `/admin/clients` | Clients (Companies for a company tenant), Staff (hidden for a company tenant), Roles, Activity (audit log), EInvoices, Billing, Settings |
| `firm_staff` (partner, reviewer, staff_accountant) | Staff of an accounting firm | `/` (My clients) | Opens a client at `/c/<companyId>/Home`. Sees only the clients assigned to them |
| `client` (client_accountant, client_viewer, plus named client roles) | A business's own people | `/c/<companyId>/Home` | The company's modules, cut down by the role's none / view / edit per module |
| Counter-only role (`pos_mode`) | Cashier or store keeper | The counter screen (`Counter.tsx`) | Tabs: Stock in and out, Orders (restaurant food sale) |

Public pages with no sign-in: `/i/<token>` (a customer's view of an emailed invoice, with Print and Pay online when the
company takes online payments), `/pay/sandbox/<ref>` (the sandbox checkout), `/invite/<token>`.

## 2. Company workspace address and menu

Address: `/c/<companyId>/<Module>/<sub-page>/<item>/<extra>`. Menu groups, in order:

- **Today**: Home, Portal (only for clients of an accounting firm), Calendar, Approvals
- **Money**: Sales, Purchases, Expenses, Bank
- **Operations** (optional modules, on per company): Inventory, Restaurant, Rooms, Assets, Rentals, Projects
- **People** (optional): HRM, CRM
- **Books**: Journal, Ledger, Reports, Review

Sub-pages (from `web/src/books/nav.ts`):

| Module | Sub-pages |
|---|---|
| Portal | overview, requests, documents, monthly-reports |
| Calendar | upcoming, calendar-settings |
| Approvals | waiting, approval-history, approval-rules |
| Sales | overview, customers, quotations, invoices, recurring-invoices, credit-notes, debit-notes, payments-received, online-payments, statements, reminders, e-invoicing, zatca, emails |
| Purchases | overview, suppliers, purchase-orders, bills, supplier-credits, payments-made |
| Expenses | overview, expenses, recurring, categories, claims, approvals |
| Bank | accounts, import, reconcile, rules |
| Inventory | items, warehouse-desk, grn, gdn, stock-value |
| Restaurant | food-sales, menu, materials, stock-desk, materials-in, wastage, material-value |
| Assets | register, depreciation |
| Rooms | front-desk, room-calendar, bookings, room-setup |
| Rentals | rental-board, rental-contracts, equipment |
| Projects | projects, project-report |
| HRM | overview, employees, attendance, leave, payroll, loans, end-of-service, hr-documents |
| CRM | pipeline, leads, activities, campaigns |
| Journal | entries, new, periods, year-end |
| Ledger | chart-of-accounts, cost-centres-setup, general-ledger, cost-centre-ledger, customer-ledger, supplier-ledger, employee-ledger, currencies, fx-revaluation, import-data |
| Reports | owner-summary, profit-and-loss, balance-sheet, cash-flow, cash-forecast, budgets, trial-balance, cost-centres, expenses-by-category, expenses-by-payee, aged-receivables, aged-payables, vat-summary, vat-return |
| Review | overview, checks, queries, checklist, sign-off |

Core modules are always on: Home, Portal*, Calendar, Approvals, Sales, Purchases, Expenses, Bank, Journal, Ledger,
Reports, Review. (*Portal is hidden for a company that keeps its own books.) A client role can set none / view / edit
per module for: Sales, Purchases, Expenses, Bank, Inventory, Restaurant, Assets, Rentals, Rooms, Projects, HRM, CRM,
Journal, Ledger, Reports.

## 3. Industry presets and the modules each switches on (`src/books/modules.ts`)

| Preset (in code) | Brochure name | Optional modules on |
|---|---|---|
| `hospitality` | Hotels and resorts | Rooms, Restaurant, Assets, HRM, CRM |
| `construction` | Construction | Inventory, Projects, Assets, Rentals, HRM |
| `trading` | Trading and wholesale | Inventory, Assets, Projects, HRM, CRM |
| `restaurant` | Restaurants and cafes | Restaurant, Assets, HRM, CRM (Inventory off: a restaurant tracks materials in Restaurant) |
| `retail` | Retail | Inventory, Assets, HRM, CRM |
| `services` | Services | Projects, Assets, HRM, CRM |
| `manufacturing` | Manufacturing | Inventory, Assets, Projects, HRM, CRM |
| `other` | not used | Inventory, Assets, Projects, HRM, CRM |

"Accounting firm" is not an industry preset: it is a tenant of kind `firm` (the other kinds are `company` and the
platform). The modules can be changed per company with chips on the registration form.

## 4. How companies and clients are created

1. The platform owner creates a customer in the owner console: `POST /api/owner/tenants` (name, kind firm or company,
   Administrator name and email). The Administrator gets an invitation link.
2. The Administrator adds a company at `/admin/clients/new` (`POST /api/admin/companies`): name in English and Arabic,
   country, legal form, industry, module chips, commercial registration, VAT status and number, address. Creating it
   copies the chart of accounts (`setup_company_books`).
3. Staff are created at `/admin/staff` and assigned to clients; client users are invited per company with a role.
4. Demo data today: `src/db/seed.ts` builds "Demo Accounting Firm" (4 companies) and the self-managed "Desert Rose
   Trading", with the fixed password in `src/db/demoData.ts`. The brochure seed does not reuse those names or that
   password; it makes its own firm and generated passwords.

## 5. How a company is switched

A firm user opens `/` (My clients), which lists the clients assigned to them, and picks one (`/c/<id>/Home`). A client
user has one company and lands in it. The owner acts inside a customer through an "acting customer" setting and then the
`/admin/*` pages. The capture script does not click through any of this: it signs in as the right user and goes
straight to the address.

## 6. Where the brief and the real app differ (the substitutions)

| Brief says | What the app really has | What I will capture |
|---|---|---|
| Restaurant: "open orders at 5 tables", "till with an open order at a table" | Restaurant has a food-sales till (`Restaurant/food-sales`): each sale is issued and paid at once. There are no tables and no open orders | The till screen with a sale being built, and the list of recent sales |
| Retail: "stock count in progress" | Stock counts and adjustments are not built (docs/PENDING.md lists them as next) | Inventory stock value (`Inventory/stock-value`) |
| Sales: "invoices list with one invoice open" in one image | The list and the invoice are separate pages | The list (status badges) for the main image; the open invoice is a second page |
| Purchases: "supplier bills list plus an expense claim with receipt" | Bills (`Purchases/bills`) and claims (`Expenses/claims`) are different pages | The bills list |
| ZATCA state on invoices | The list shows a badge only for e-invoices that are pending or rejected. The seed's old demo marks some as cleared by direct update, which would imply a live clearance | E-invoicing left unconnected for the brochure; no "cleared" is shown |
| "Customer view of an invoice with pay button" | `/i/<token>` with Pay online, sandbox checkout behind it | That page (company with online payments on, sandbox provider) |
| "Users, roles and audit" | `/admin/roles` and `/admin/activity` (the Administrator console, not the company workspace) | Roles page for the image; Activity as an alternative |
| "Home dashboard as the owner sees it" | There is no business-owner kind. The platform owner is Nusuh Books itself | A demo user of kind `client` with full access, named as the business owner |
| Firm "6 client companies (reuse the companies above)" | A company belongs to exactly one tenant | All seven companies are clients of Al Amal Accounting; Portal then shows in their menu |
| ZATCA "simulation" mode | Your standing rule allows sandbox only, never simulation | Unconnected |
