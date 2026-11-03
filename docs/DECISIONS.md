# Decisions and open questions

## Decided
- One all-in-one package. Setup fee SAR 14,999 (40% at signing, 30% at configuration, 30% after go-live). Subscription SAR 1,200/year (software only). Managed service SAR 2,500/month.
- Plans: Pilot (discounted setup for first 3-5 clients, in return for feedback) and Standard (full price). Managed service is a separate option on either.
- Teal and white palette, left sidebar, top bar with search and EN | AR, light and dark mode.
- Admin is a separate console. Clients page = total, search, add client. Add client = separate page with full registration details.
- Build order: foundation, sales/purchases/bank, reports and review, ZATCA then UAE, portal/calendar, HRM/CRM/restaurant, pilot.

- Stock is valued at weighted average cost (PRODUCT_SPEC). Goods move in with a goods received note (GRN) and out with a goods delivery note (GDN); a GRN credits 2050 Goods received not yet billed, which the supplier's bill clears.
- Depreciation is monthly straight line, counting the month the asset starts as a full month. Missed months are caught up in the next run.
- Bank statements are imported as CSV or Excel files. A file is matched to the client's bank account by the IBAN or account number in it; the column layout is detected or set once per account.

- Each client has an industry, chosen at registration. It sets the optional modules (Inventory, Restaurant, Assets, Projects, HRM, CRM); a restaurant gets Restaurant instead of Inventory. The Administrator can change them.
- Restaurant: materials (stock items), materials in (goods received), menu items with recipes (materials per portion), waste, and food sales. Each food sale issues a tax invoice, takes the recipe materials out of stock at average cost and records the payment, all at once. A sale that would take a material below zero is stopped; materials are received first.

- PDFs are A4 pages drawn by the browser and saved with its print window ("Save as PDF"), so Arabic is always shaped correctly. Sales documents are bilingual (English and Arabic). In Saudi Arabia an invoice is a "Tax invoice" when the buyer has a VAT number and a "Simplified tax invoice" otherwise, with the ZATCA phase 1 QR code (seller, VAT number, time, total, VAT). Phase 2 (XML, cryptographic stamp, clearance through Fatoora) comes with the ZATCA adapter.
- Reports export to PDF and to Excel (.xlsx), numbers as numbers.
- HRM is full payroll for Saudi Arabia and the UAE: monthly payroll with GOSI (Saudi Arabia) and GPSSA (UAE nationals), overtime, unpaid leave, absence and sick pay tiers by the labour laws, annual leave balances, loans and advances, a monthly end of service provision and final settlements, payslips, salary files (UAE WPS SIF; Saudi payroll file for Mudad or the bank) and HR documents with expiry dates. A month's pay is worked on a 30-day month. Oman (PASI) comes with Oman.
- To confirm before the first real payroll: GOSI and GPSSA rates and caps (src/books/payroll.ts), the WPS SIF layout with the client's bank or exchange house, and the Mudad payroll file layout.
- CRM is light and never posts to the books: leads, a deal pipeline by stage (chance 10/25/50/75%), activities and campaigns. A deal can create a Sales quotation; won and lost follow that quotation (invoiced = won, declined = lost). Sending messages from campaigns (email, SMS, WhatsApp) is not built; it needs a provider.
- Review layer: firm staff on a client (partner, reviewer, staff accountant) run the checks, raise queries, tick the checklist and explain findings; only partners and reviewers sign off. Everyone on the client sees Review and can answer queries (Review is not part of client roles). Sign-off needs the month ended, the checklist done and no open queries; it does not lock the period (locking stays a partner's separate step).
- In reports, projects are kept apart from cost centres: P&L by cost centre shows branches and departments, with projects as one line pointing to the Projects report.

- Reports show account names, not account codes. The profit and loss reads: Sales, less Cost of sales = Gross profit, less Indirect expenses, add Indirect income = Net profit. Each income and expense account has its line (set automatically, changeable in Ledger > Chart of accounts).
- Client roles: the Administrator defines job titles for client users in Roles and permissions, each with None, View or View and enter per module, and whether it may approve expense claims. Every role is editable: Client accountant (everything) and Client management (view everything) are created for each firm as ordinary roles, and every client user has a role. Firm staff keep their fixed roles. A role in use cannot be archived.

## Open
- Restaurant POS integration (importing sales from the restaurant's own POS instead of entering them in Nusuh Books): which POS systems.
- Direct bank feeds (transactions sent by the bank, no files): needs an open banking provider licensed by SAMA (Saudi) or under the UAE Central Bank open finance framework. Which provider, and the cost.
- Selling a fixed asset with VAT: today the disposal records proceeds before VAT; how the VAT on the sale is invoiced is to be agreed with the reviewer.
- Which country signs first (Saudi or UAE): sets the e-invoicing order.
- What the SAR 2,500 managed fee includes; pilot discount amount.
- How clients use cost centres (branch, department, project).
- Which POS systems restaurant clients use.
- Developer to hire; hosting region (check Saudi and UAE data protection rules, take legal advice).
- Confirm e-invoicing dates and specs with ZATCA, UAE FTA and Oman Tax Authority before building.
