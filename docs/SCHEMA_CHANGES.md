# Schema changes from the starter-kit draft

`db/schema.sql` was the untested draft. The live schema is `db/migrations/0001_foundation.sql`.
Every change below is covered by a test in `test/`.

## Users, roles and access
| Change | Why |
|---|---|
| `user_role` gains `staff_accountant` | CLAUDE.md names three firm roles (partner, reviewer, staff accountant). The draft had only two. |
| New `user_kind` (`admin`, `firm_staff`, `client`) on `users` | The Administrator is a separate kind of user, not a role on a company. Admins have no memberships, so they never see books. |
| `users.full_name` added; `password_hash` nullable | Registration needs the first client user's name and email. The password is set when they accept the invite. |
| Email uniqueness is case-insensitive (`lower(email)`) | `Ali@x.com` and `ali@x.com` are the same login. |
| `memberships.company_id` is now NOT NULL, primary key `(user_id, company_id)` | The draft used `company_id NULL = all firm companies`. CLAUDE.md says firm staff see **only assigned** clients, so every assignment is an explicit row. |
| Trigger `check_membership` | Role must match the kind of user. A client user belongs to exactly one company. User and company must be in the same firm. |
| RLS identity: the app sets only `app.user_id` | The draft had the app pass `app.company_ids`, so the app decided what each user could see. Now the database works out companies and roles from `memberships`, which enforces separation in the database as CLAUDE.md requires. |
| `auth_user_by_email()` | Login lookup that runs before the user is known, without opening up the `users` table. |

## Row-level security
- RLS is on for **every** table: `firms`, `companies`, `users`, `memberships`, `accounts`, `cost_centres`, `periods`, `journal_entries`, `journal_lines` (through its entry), `audit_log`.
- Separate read and write policies. Posting is limited to partner, staff accountant and client accountant. Only the partner can update `periods`, which is how periods are locked and unlocked. Only the Administrator can insert companies, users and memberships.
- The app connects as `nusuh_app`. That role is not a superuser, owns no tables and cannot bypass RLS (tested). It has no UPDATE or DELETE on the ledger and no write access at all to the audit log.

## Ledger
| Change | Why |
|---|---|
| Balance check also fires on the entry itself | The draft checked only when a line was inserted, so an entry with **zero** lines could be committed. |
| `CHECK (debit > 0 OR credit > 0)` | Lines with no amount are rejected. |
| `journal_entries.created_xact` and the `before_line_insert` trigger | Lines can be added only in the transaction that posted the entry. Without this, someone could add a balanced pair of lines to an old entry, which is an edit and breaks rule 2. |
| Lines must use accounts and cost centres from the entry's own company | Stops data from two companies being mixed in one entry. |
| `created_by` and `created_at` are set by the database | The app cannot post an entry in someone else's name. |
| Triggers block TRUNCATE on entries, lines and the audit log | The draft blocked only UPDATE and DELETE. |
| `reverse_entry()` | Rule-checked reversal: it swaps debits and credits, rejects a second reversal and rejects reversing a reversal. The period lock still applies to the reversal's date. |
| `trial_balance()`, `profit_and_loss()`, `profit_and_loss_by_cost_centre()` | These are needed to test the trial balance and cost centre rules. They run with the caller's rights, so RLS still applies. |
| Triggers yield to RLS for callers who have no access | Otherwise a trigger error message could show that another company's entry or period lock exists. |

## Periods
- Periods cannot overlap within a company (exclusion constraint, which needs `btree_gist`).
- Period dates cannot change after creation, and periods cannot be deleted. Only `locked_at` changes.
- Only the partner can create a period that is already locked.

## Audit log
- One generic `audit_row()` trigger on every business table. It records the user, the company, the action and the before/after rows.
- Actions are `insert`, `update`, `delete`, `reverse`, `lock` and `unlock`.
- Password hashes and two-factor secrets are stripped before logging.

## Companies (client registration, as decided in CLAUDE.md)
- Adds the required, optional and entry-settings fields from CLAUDE.md.
- Database checks: SA CR is 10 digits. SA VAT is 15 digits starting and ending with 3. UAE TRN is 15 digits. CR and VAT numbers are unique across clients. A VAT number is required only if the company is VAT registered. "Unregistered" forces a 0% rate. Currency must match the country.
- A deferred trigger means a company cannot be committed without its first client user.

## Not changed, but needs a decision
- **Oman currency (OMR) has 3 decimals (baisa).** Rule 7 fixes money at `NUMERIC(18,2)`, which cannot hold OMR amounts exactly. This must be decided before Oman: either NUMERIC(18,3) everywhere, or a per-currency scale.
- **VAT rounding** is per line, rounded half away from zero to 2 decimals (`src/vat/vat.ts`). This is a placeholder until the rule is agreed with ZATCA/FTA.
- CR uniqueness is global across all countries, as CLAUDE.md states. If a Saudi CR and a UAE trade licence number could ever be the same, change it to unique per country.

## 0002_staff_role.sql
| Change | Why |
|---|---|
| `users.staff_role` (required for firm staff, empty for everyone else) | A staff member is a Firm partner, Reviewer or Staff accountant for every client they handle. The Administrator then only ticks which clients each person handles, as in the prototype. |
| `check_membership` also requires a staff member's role on a client to equal their `staff_role` | Stops one person being a partner on one client and a staff accountant on another by mistake. |

## 0003_company_setup.sql
| Change | Why |
|---|---|
| `setup_company_books(company, accounts, year)` | When a client is registered, it copies the chart of accounts template to the client, creates the "Head office" cost centre and creates 12 monthly periods. It runs with elevated rights because the Administrator has no posting role. It checks that the caller is the firm's Administrator and that the books are still empty. |

## 0004_admin_console.sql
| Change | Why |
|---|---|
| `users.status` and `companies.status` (`active` or `suspended`) | Suspend instead of delete, so the audit trail stays whole. |
| `app_company_ids()`, `app_has_role()` and `app_is_admin()` ignore suspended users and suspended clients | Suspension takes effect in the database itself: a suspended person sees nothing, and staff of a suspended client lose access straight away. The Administrator still lists suspended clients. |
| `auth_user_by_email()` also returns the status | Sign-in refuses suspended accounts with a clear message. |
| `users.invite_token_hash`, `invite_expires_at` and `password_set_at`, plus `invite_info()` and `accept_invite()` | One-time sign-in links that expire after 7 days. Only a SHA-256 hash of the token is stored; the link holds the token. The same link is used to reset a forgotten password. |
| `users.totp_enabled_at` and `set_own_totp()` | Each person turns on two-factor sign-in for themselves. The secret is encrypted by the app (AES-256-GCM) before it is stored. Only the Administrator can reset two-factor (for a lost phone). |
| `audit_row()` also strips `invite_token_hash`; new audit trigger on `firms` | Tokens never reach the log, and firm renames are recorded. |
| `firms_admin_update` policy and `UPDATE (name)` grant | The Administrator can rename the firm. |
| `admin_activity()` | Lets the Administrator read client, user, access and firm changes for their own firm. It never returns ledger rows. |

## 0005_sales_purchases.sql
| Change | Why |
|---|---|
| `accounts.is_bank`, plus template accounts `1010 Cash on hand` and `5400 Office and general expenses` (added to existing clients too) | Payments go in and out of bank or cash accounts only. Bills need a general expense account. |
| `contacts` (customers and suppliers, one table, either or both) | One record per business partner, with VAT and CR numbers and payment terms. Saudi and UAE VAT numbers are checked like company ones. |
| `documents` and `document_lines`, one layout for quotations, invoices, credit notes, bills and supplier credits | CLAUDE.md: the invoice layout is identical for every country; e-invoicing adapters read from it later. |
| Line checks: `net = round(qty x price, 2)` and `VAT = round(net x rate / 100, 2)`; standard-rated lines must use the company rate; totals must match the lines when a document leaves draft | The database guarantees the VAT maths, not just the screen. `round()` rounds half away from zero, the same as `src/vat/vat.ts`. |
| VAT treatment per line: standard, zero-rated, exempt, out of scope | VAT returns need zero-rated and exempt supplies kept apart. |
| Triggers: issued documents never change and can't be deleted; drafts can; an issued document must have a number and its own journal entry; quotation statuses only move forward | Rule 2 applied to documents. A quotation never posts. |
| `document_sequences` | Gap-free numbers per client and type. The counter rolls back with a failed issue, so no number is skipped. |
| Credit notes must point to an issued invoice (or bill) of the same contact, and can't exceed what is left on it | A credit note always corrects a specific invoice, and the VAT reverses exactly. |
| `payments` and `payment_allocations`; payments can't be edited or deleted, only voided with a reversal entry; allocations only at creation, only to issued invoices or bills of the same contact, never more than is due or than the payment | Rule 2 applied to payments, and payments can never over-settle. |
| `document_amount_due()` (caller's rights) | One definition of "amount due": total minus payments (not voided) minus issued credits. |
| Audit triggers and row-level security on all new tables; `audit_row()` records `issue`, `status` and `void` actions | Rules 5 and 6. |

## 0006_expense_type.sql and 0007_expenses.sql
| Change | Why |
|---|---|
| New document type `expense` (in its own migration) | PostgreSQL can only use a new enum value after the transaction that adds it has committed. |
| `documents.paid_from_account_id`, `payee`, `recurring_id`; `contact_id` optional for expenses only | An expense is paid at once from a bank or cash account: Dr expense lines, Dr input VAT, Cr bank/cash. The supplier is optional; a payee name can be used instead (taxi, petrol station). |
| Recording an expense needs a bank/cash account of the same company and either a supplier or a payee | The database refuses an expense that does not say where the money went or where it came from. |
| `documents.voided_at`, `void_entry_id`, status `voided` (expenses only) | A recorded expense never changes. A mistake is voided: the reversing entry is posted, and only the void fields change. |
| `recurring_expenses` (templates with frequency, next date, anchor day, end date and lines), with row-level security and audit | Rent, internet and subscriptions create **draft** expenses on their dates. Nothing posts automatically; a person checks and records each one. `anchor_day` keeps a 31st-of-the-month expense at month end every month. |
