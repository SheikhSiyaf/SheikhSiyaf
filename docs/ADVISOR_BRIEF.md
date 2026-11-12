# Nusuh Books: brief for the advisor (Claude chat)

Upload this file to a Claude Project as project knowledge. It brings the advisor up to date. The developer
(Claude Code, working in the repository) keeps it current: the "Where things stand" section changes after each feature.

Last updated: 2026-11-12.

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
- **Reports**: trial balance, P&L, balance sheet, VAT return, aged reports, budgets, forecast, multi-currency
  ledger accounts with month-end revaluation, export of everything.
- **Review layer**: reviewer checks and sign-off; signing off a month locks it. Year-end close.
- **E-invoicing**: ZATCA (Saudi) client built, not yet tested against ZATCA's real servers. UAE Peppol: not built
  (needs an accredited service provider).
- **Portal, calendar of deadlines, approvals, forecast.**
- **HRM** (payroll, GOSI and GPSSA, end of service, leave, WPS and Mudad files), **CRM**, **Restaurant**.
- **Owner console**: customers, billing and subscriptions, support inbox.
- **Support chat**: a Help button for every customer user to raise an issue with Nusuh Books; owner answers;
  the customer gets an email when answered.
- **Email**: outbox with Resend, SendGrid or Postmark; invitations, password reset, documents, approvals.
- **Quality**: 500+ automated tests (accounting rules, data separation, API); every change is tested first.
- **Demo**: a browser-only demo with sample data exists as a claude.ai artifact. The real app is not hosted yet.

Technology (for vendor conversations): PostgreSQL database, Node.js (TypeScript) server, React web front end. One
codebase for all customers; per-customer settings, never copies. Code is in GitHub.

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

## 7. Where things stand and what is next

**Going live needs** (none of these are code-heavy; they are accounts and decisions):
- A PostgreSQL host (Supabase as a plain database, Neon, AWS RDS, or a Saudi/UAE region for data-residency law).
- A server that keeps running (Render, Railway, Fly.io, DigitalOcean, AWS). Not Cloudflare Pages.
- A domain with Cloudflare (DNS, HTTPS, firewall).
- An email provider (Resend recommended) with the sending domain verified (SPF, DKIM).
- Backups with a tested restore; monitoring (e.g. Sentry and an uptime check).
- Later, per feature: Moyasar account (online payment), ZATCA onboarding per company (one-time code from the
  Fatoora portal), Lean or Tarabut agreement (bank feeds), an accredited UAE Peppol provider.

**Go-live blockers** (from PENDING.md): run ZATCA against real servers; hosting and a security review; legal
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
