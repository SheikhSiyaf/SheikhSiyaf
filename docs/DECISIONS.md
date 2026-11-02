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

## Open
- Direct bank feeds (transactions sent by the bank, no files): needs an open banking provider licensed by SAMA (Saudi) or under the UAE Central Bank open finance framework. Which provider, and the cost.
- Selling a fixed asset with VAT: today the disposal records proceeds before VAT; how the VAT on the sale is invoiced is to be agreed with the reviewer.
- Which country signs first (Saudi or UAE): sets the e-invoicing order.
- What the SAR 2,500 managed fee includes; pilot discount amount.
- How clients use cost centres (branch, department, project).
- Which POS systems restaurant clients use.
- Short-form HRM or full payroll.
- Developer to hire; hosting region (check Saudi and UAE data protection rules, take legal advice).
- Confirm e-invoicing dates and specs with ZATCA, UAE FTA and Oman Tax Authority before building.
