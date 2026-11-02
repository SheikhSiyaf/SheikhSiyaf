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
