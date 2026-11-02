# Nusuh Books: product spec (summary of the requirements document)

Accounting platform for accounting firms and their clients in Saudi Arabia, UAE (Dubai), later Oman.

## Core platform
Multiple client companies with strict data separation; each has its own country, currency, VAT rate, compliance notes. Roles as in CLAUDE.md. Two-factor login, audit log of every change, encrypted storage, daily backups, attachments on every transaction. Arabic and English with RTL and bilingual reports and invoices.

## Accounting engine
Chart of accounts template copied to each client. Double-entry ledger; entries balance, never deleted, only reversed. Period locking, opening balances, trial balance at any date, manual journals.

## Sales and purchases
Tax invoices (multi-line), credit notes, receipts. Bills and expenses with categories and input VAT; expense approval workflow. Customers and suppliers with remembered VAT codes and payment terms. Issued invoices are never edited.

## Bank
CSV and Excel statement import, match suggestions (exact amount and name), rules that learn ("always do this"), reconciliation. Footer shows books balance, unmatched lines, statement balance.

## Inventory, assets, cost centres
Stock items with quantity, average cost, selling price; sales post cost of sales. Restaurants: ingredient stock and recipe costing. Fixed asset register with monthly straight-line depreciation. Cost centre tag on every journal line (company > branch > department/project), optionally mandatory per account; P&L by cost centre, comparison, budget vs actual.

## VAT and e-invoicing
Same invoice data layout for every country; each country's e-invoicing is a separate adapter.
- Saudi Arabia: 15%, ZATCA Fatoora (QR code, XML, clearance and reporting; test in ZATCA sandbox).
- UAE: 5%, Peppol PINT AE through a Ministry of Finance accredited provider; phased from 1 Jan 2027 (AED 50m+ revenue) and 1 Jul 2027 (others). Verify.
- Oman (later): 5%, Fawtara on a Peppol model, phased from August 2026. Verify.

## Reports and review (main advantage)
Monthly P&L, balance sheet, cash flow with comparisons, commentary, ratios, PDF and Excel export. One-page owner summary. Automated review checks (missing VAT, duplicates, round amounts, unreconciled items, abnormal balances). Queries between reviewer and client accountant, monthly checklist, period sign-off, "reviewed by your accountant" status. Every number drills down to the transaction.

## Additional modules
HRM (payroll only if GOSI/WPS/PASI compliance is fully supported), light CRM, compliance calendar, cash flow forecast, client portal, restaurant POS import (integrate, do not build a POS).

## Technical notes
One codebase for all clients. Accounting rules and tests first; ledger and report changes must pass automated tests. Hire a developer for hosting, accounting-logic review and security check. Budget for maintenance, e-invoicing updates, provider fees, insurance, and a client agreement on source data responsibility.
