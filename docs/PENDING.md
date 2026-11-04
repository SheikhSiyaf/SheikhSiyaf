# What is left: features and work still to do

Status at the end of the build steps 1 to 5 (foundation, sales and purchases, reports and review, e-invoicing,
portal, calendar, approvals and forecast) plus HRM, CRM and restaurant. Grouped by priority. Each item says why it matters.

## A. Before the first real client (go-live blockers)

1. **Run ZATCA from a real server.** Onboard a device in the ZATCA sandbox, then the simulation portal, with real
   company data, and pass ZATCA's checks. The build environment could not reach ZATCA. Confirm with ZATCA: VAT per
   category as the sum of line VAT (the books' rounding); one exemption reason per company (they may want it per line).
2. **Hosting and security.** Production server in a Saudi or UAE region, HTTPS, daily backups with a tested restore,
   monitoring and alerts, the encryption key kept outside the database, an independent security review (penetration
   test), and legal advice on the Saudi and UAE personal data laws (PDPL).
3. **Sending email.** Done: the outbox, providers, invitations, password reset, documents, approvals. Still to choose: the provider account and a sending domain (SPF, DKIM). Old text: Today sign-in links are copied by hand. Needed: invitations and password reset, invoices and
   credit notes to customers (PDF and XML attached), portal requests, approvals waiting, deadline reminders, monthly
   reports. Needs an email provider (and SMS or WhatsApp later).
4. **Confirm with the authorities.** GOSI and GPSSA rates and caps; the UAE WPS SIF and Saudi Mudad file layouts with a
   bank; the VAT return box layout (ZATCA, FTA); the calendar's dates.
5. **Opening customer and supplier balances as open invoices.** Imported opening balances put receivables and
   payables in one total; the aged reports, statements and payments need each unpaid invoice and bill. Extend bulk
   import to open invoices and open bills.
6. ~~**Year-end closing.**~~ Done (Journal > Year-end).
7. **UAE service provider.** Choose the accredited service provider, validate our PINT AE XML with it, connect its API.
   Companies with AED 50 million or more go live on 1 January 2027.
8. **Browser tests in the repository.** The page-by-page browser checks used during the build should move into the
   repository and run on every change (CI), next to the 333 automated tests.

## B. Features accountants will ask for soon

- **Recurring sales invoices** (rent, retainers, subscriptions), like recurring expenses.
- **Customer statements and payment reminders**: a statement of account to send, and polite reminders when invoices
  are overdue.
- **Multi-currency documents**: ledger accounts in other currencies, daily rates and the month-end revaluation are done; invoices, bills, payments and bank accounts in other currencies are next.
- **Debit notes** for customers (ZATCA supports them; the books do not yet).
- **Purchase orders** before bills, and delivery notes for sales.
- **Budgets**: budget against actual by account and cost centre (projects already have budgets).
- **Receipt capture**: photograph a receipt on the phone and get a draft expense filled in.
- **Notifications in the app**: one place for approvals waiting, answers from the client, deadlines and failed sends.
- **Bulk actions**: send many invoices, mark many documents dealt with, approve several at once.
- **Export everything for a client**: all data in Excel or CSV, for audits and for leaving.

## C. Larger additions

- **Oman**: VAT, Fawtara e-invoicing (Peppol model) and PASI payroll, once the Oman Tax Authority confirms details.
- **Restaurant POS import**: bring sales from the restaurant's own POS (which systems clients use is still open).
- **Direct bank feeds** through a provider licensed by SAMA or the UAE Central Bank.
- **Online payment of invoices** through the client portal (mada, Apple Pay, cards) via a payment provider.
- **Inventory depth**: stock counts and adjustments, several warehouses, price lists (barcodes and the warehouse counter are done).
- **Approvals depth**: two levels above a higher amount; approvals for expenses and journal entries.
- **CRM depth**: drag-and-drop pipeline; sending campaigns by email, SMS or WhatsApp.
- **Fixed assets**: VAT on the sale of an asset; revaluation and impairment.
- **Payroll depth**: monthly leave accrual provision; other pay frequencies.
- **Owner console**: plans, billing and subscriptions, usage per customer.

## D. Quality and support

- A native Arabic-speaking accountant to review every Arabic text and the Arabic PDFs.
- Accessibility review (screen readers, keyboard use) and large-volume tests (many years, many thousands of entries).
- A short user guide and help inside the app, and a plain-language client agreement on who is responsible for source data.
- A developer to own production, the accounting logic review and maintenance (e-invoicing rules change).

## Decisions still open (docs/DECISIONS.md)

Which country signs first; what the SAR 2,500 managed fee includes and the pilot discount; how clients use cost
centres; which POS systems restaurants use; the hosting region; the UAE service provider.
