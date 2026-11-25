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

## 0008_claim_type.sql and 0009_employees_claims_projects.sql
| Change | Why |
|---|---|
| New document type `claim` (in its own migration) | PostgreSQL can only use a new enum value after the transaction that adds it has committed. |
| `contacts.is_employee`, `employee_no` (unique per client), `job_title`, `default_cost_centre_id`; an employee is never also a customer or supplier | Employees are paid back for what they spend. Keeping them apart from customers and suppliers keeps their ledger separate. |
| Template account `2200 Employee claims payable` (added to existing clients too) | An approved claim is owed to the employee until it is paid back: Dr expense, Dr input VAT, Cr 2200. Reimbursing is Dr 2200, Cr bank or cash. |
| Claim statuses `draft` → `submitted` → `issued` (approved and posted) or `rejected` → back to `draft`. The number is given on submit and kept. `submitted_by`, `submitted_at`, `decided_by`, `decided_at`, `rejection_reason` | Approval before posting. A submitted claim can't be changed, so the approver sees exactly what was asked for. |
| The person who submitted a claim cannot approve or reject it; rejecting needs a reason | Separation of duties, enforced in the database rather than only on screen. |
| Payments made can go to a supplier (settling bills) or an employee (settling approved claims); `document_amount_due()` covers claims | One payment screen for both; a claim can never be over-paid. |
| `cost_centres.status`, `budget`, `contact_id`, `start_date`, `end_date`, `description`; a project's customer must be a customer of the same client | Projects are cost centres of kind `project`, so every invoice, bill, expense and claim line can be tagged with one. Project income, costs, profit and budget used come straight from the ledger. |

## 0010_bank.sql
| Change | Why |
|---|---|
| `bank_accounts`: one row per bank or cash ledger account (kind, bank name, account number, IBAN, remembered statement layout, open or closed). Created automatically for every `is_bank` account; adding a bank account in the app creates its ledger account (1020-1099) | Clients add their own bank accounts. The IBAN or account number lets an imported statement find its account. |
| `iban_valid()` (ISO 13616 mod 97; Saudi 24 characters, UAE 23) as a check on `bank_accounts.iban`; IBAN and account number unique per client | A wrong IBAN is refused before it is saved. |
| `bank_imports` and `bank_statement_lines` (amount signed: money in positive). A line's date, text and amount never change; only its match does. `UNIQUE (bank_account_id, fingerprint)` | The bank's record is kept as it came. Importing an overlapping statement skips lines already there. |
| A statement line is matched to exactly one journal line on that bank's ledger account, for the same amount in the same direction (`journal_line_id UNIQUE`) | This is the reconciliation: every bank line is in the books once, and no book line is used twice. |
| `bank_rules` (text to look for, direction, account, VAT, cost centre) | "Rules that learn" (PRODUCT_SPEC). They are suggestions; a person confirms each line or books all suggestions with one click. |
| Audit triggers and row-level security on all four tables | Rules 5 and 6. |

## 0011_inventory.sql
| Change | Why |
|---|---|
| Accounts `1300 Inventory` and `2050 Goods received not yet billed` (added to existing clients); purchase lines may use 2050 | A GRN puts stock in the books before the supplier's bill arrives; the bill then clears 2050. |
| `items` with `qty_on_hand` and `value_on_hand` (never negative). Quantity and value change only inside the posting of a goods note (`pg_trigger_depth()`), never directly | Stock and its value always come from GRNs and GDNs, so the stock report and the books agree. |
| `stock_notes` (GRN / GDN, gap-free numbers GRN-0001 / GDN-0001) and `stock_note_lines` | Inbound and outbound goods, as asked. |
| Posting a GRN adds quantity x cost; posting a GDN removes stock at weighted average cost (`round(value x qty / on hand, 2)`, all of the value when all the stock goes), checked by the database line by line | PRODUCT_SPEC: average cost. The database recomputes the cost, so a wrong amount cannot be posted. |
| A posted note needs its own journal entry moving its value on 1300 (GRN: Dr 1300 / Cr 2050 or equity; GDN: Dr 5000 or another expense / Cr 1300); posted notes never change | Rule 2. Locked periods refuse the entry (rule 3). |

## 0012_fixed_assets.sql
| Change | Why |
|---|---|
| Accounts 1510 Vehicles, 1520 Furniture and fixtures, 1530 Computers and IT equipment, 1590 Accumulated depreciation, 4900 Gain or loss on sale of assets, 5050 Depreciation (added to existing clients) | The accounts the register posts to. |
| `fixed_assets` (cost, residual value, useful life in months, depreciation start month, depreciation before Nusuh Books, cost centre, status) | The register. Cost, life and accounts cannot change once depreciation is booked. |
| `depreciation_due()`: by the end of month n an asset has `round((cost - residual) x n / life, 2)`, all of it from the last month; a month books that target less what is already booked | Monthly straight-line depreciation (PRODUCT_SPEC). Missed months are caught up and the total never passes cost less residual. |
| `depreciation_runs` (one per company per month, in order, never for a future month) and `depreciation_lines` (amount recomputed by the database) with one journal entry per run: Dr depreciation (with cost centre) / Cr 1590 | Rules 1-3: balanced, never changed, refused in locked periods. |
| Disposal: depreciation must be up to date to the month before; one entry removes cost and accumulated depreciation, proceeds to bank, gain or loss to 4900; a disposed asset never changes | Selling or scrapping an asset leaves the books correct. |

## 0013_restaurant.sql
| Change | Why |
|---|---|
| `companies.industry` (trading, retail, restaurant, services, construction, manufacturing, other) and `companies.modules` (the optional modules turned on: Inventory, Restaurant, Assets, Projects, HRM, CRM) | Registration asks the industry, which sets the modules: a restaurant gets Restaurant instead of Inventory. The Administrator can change the modules. Existing clients keep every module they had. |
| `recipes` (menu items: selling price before VAT, VAT treatment, income account, category, on or off the menu) and `recipe_lines` (materials and quantity per portion) | The menu and its recipes, so each portion's food cost comes from the materials' average cost. |
| `restaurant_sales` linking the tax invoice, the goods delivery note for the materials used, and the payment; refused unless the client has the Restaurant module; never changed | Selling food issues the invoice, takes the materials out of stock (Dr 5000 / Cr 1300) and records the payment in one transaction: all three or none. |
| Audit triggers and row-level security on the three tables | Rules 5 and 6. |

## 0014_attachments_chart.sql
| Change | Why |
|---|---|
| `attachments` (file name, type, size, who and when; belongs to one document or one goods note) and `attachment_files` (the file itself, kept apart) | The supplier's invoice, receipts and delivery notes are kept with the bill, expense, claim or goods note and printed with its PDF. The audit log records each attachment but never copies the file. |
| PDF, PNG, JPG and WEBP only, up to 10 MB; the API checks the file really is one (first bytes) | Nothing else is stored under a PDF or picture name. |
| Attachments of an issued or posted document stay (can be added to, not removed); drafts can remove them | Rule 2 applied to supporting documents. |
| Ledger account codes: 4 digits starting with 1 (assets), 2 (liabilities), 3 (equity), 4 (income) or 5-9 (expenses); code and type fixed once the account has postings | Ledger > Chart of accounts lets clients add accounts; the reports stay consistent. |

## 0015_person_name.sql
| Change | Why |
|---|---|
| `person_name(user)`: a person's name, given only to themselves or to someone who shares a client company with them | Lists and PDFs show who submitted, decided or uploaded something (for example a client user's attachment seen by firm staff) without opening the whole users table to everyone. |

## 0016_pnl_roles.sql
| Change | Why |
|---|---|
| `accounts.pnl_group`: the line of the profit and loss an income or expense account sits on (Sales, Indirect income, Cost of sales, Indirect expenses). A trigger fills in the usual line (5000 is cost of sales; income codes from 4800 are indirect income) and resets a line that does not fit the type | The P&L is laid out the way accountants read it: Sales - Cost of sales = Gross profit - Indirect expenses + Indirect income = Net profit. Clients can move an account to another line in the chart of accounts. |
| `client_roles` (per firm: title in English and Arabic, description, access per module as none, view or edit, can approve claims, active or archived); audited, never deleted; only the Administrator adds or changes them | The Administrator defines job titles for client users (Cashier, Store keeper, ...) with their own access. |
| `memberships.client_role_id`; a trigger sets the membership's base role from the role (any "edit" = client accountant, otherwise client management) and keeps it in step when the role changes | The database still refuses every write from someone whose role only views. The API checks each module against the role. |
| `app_client_role(company)`; Administrator-only update of a client user's role; the activity page includes role changes | The books know the person's access; changes are audited and visible to the Administrator. |

## 0018_editable_client_roles.sql
| Change | Why |
|---|---|
| Each firm gets "Client accountant" (all modules: view and enter; approves claims) and "Client management" (all modules: view only) as ordinary rows in `client_roles`, also for new firms (trigger on `firms`) | The Administrator can change every role; there are no fixed roles any more. |
| Every client user's membership gets a role: existing ones and new ones added without a role get the firm's first active role with the same base | Access always comes from a role the Administrator can see and change. |

## 0017_hrm.sql
| Change | Why |
|---|---|
| Accounts 1150 Employee loans and advances, 2210 Salaries payable, 2220 Social insurance payable, 2230 End of service provision, 5210 Social insurance, 5220 End of service benefits (added to existing clients and the template) | Payroll, loans and end of service post to their own accounts. |
| `employee_profiles` (nationality, IDs, join date, contract, basic and allowances, IBAN, WPS IDs, GOSI/GPSSA, annual leave days, opening leave and end of service balances, leaving date and reason) and `company_hr_settings` (employer IDs for salary files) | HR details for payroll, leave and end of service. The join date is fixed once paid; pay and leaving date are fixed after the final settlement. |
| `hr_attendance` (days absent, overtime hours per person per month) and `leave_requests` (annual, sick, unpaid, other paid; requested, approved, rejected, cancelled; no overlaps) | What payroll deducts and pays. Months with posted payroll are fixed: their attendance and leave no longer change. |
| `employee_loans` with their own journal entry (Dr 1150, Cr bank); `loan_balance()` | Advances repaid from salary. A loan never changes. |
| `payroll_runs` and `payroll_lines` (each line must add up: gross = pay parts; net = gross less deductions); posting needs its own entry crediting 2210 with the net; paying needs its own entry clearing 2210 | Payroll as one journal entry per month; posted payroll is never changed or deleted (rule 2). |
| `eos_settlements` (end of service by reason, unused leave, loan recovered, total due) with its own entry crediting 2210 | The final settlement, once per person, never changed. |
| `employee_documents` with expiry dates; attachments can belong to one | Iqama, passports, contracts and insurance with scans. |
| Audit triggers and row-level security on every HRM table | Rules 5 and 6. |

## 0019_default_client_roles.sql
| Change | Why |
|---|---|
| `client_roles.default_for` marks each firm's starting Client accountant and Client management roles; a client user added without a role gets the marked role for their base | 0018 chose by creation time, which tied for roles made in the same transaction, so a new user could get a role such as "Cashier" by name order. The marked roles stay ordinary and editable. |

## 0020_crm.sql
| Change | Why |
|---|---|
| `crm_campaigns`, `crm_leads`, `crm_deals`, `crm_activities`, each with company_id, audit triggers and row-level security; only people who can post change them | Light CRM inside each client's books (PRODUCT_SPEC: "light CRM"), with the same separation and audit as everything else (rules 5 and 6). |
| Links (customer, lead, deal, campaign, quotation) must belong to the same company; owners must be members of it; `crm_people()` lists them for members only | No CRM record can point into another client's data. |
| Leads, deals and campaigns are never deleted (closed as lost, converted or done); activities can be removed | History of the pipeline is kept. |
| Trigger on `documents`: a deal follows its quotation (sent = proposal, accepted = negotiation, invoiced = won, declined = lost) | The pipeline stays in step with Sales without double entry. |

## 0021_review.sql
| Change | Why |
|---|---|
| `review_queries` and `review_messages` (thread per query; a client reply marks it answered, a firm reply reopens it; only the firm closes; messages never change) | Queries between reviewer and client accountant (PRODUCT_SPEC). |
| `review_checklist` (ticks per month and item, fixed once the month is signed off) and `review_explained` (a note that a check finding is fine) | Monthly checklist and the record of what the reviewer accepted. |
| `review_signoffs` (one standing sign-off per month; only partners and reviewers; the month must have ended and its queries be closed; never changed or deleted, only withdrawn with a reason); `reviewed_up_to()` | Period sign-off and the client's "reviewed by your accountant" status. |
| `review_roles()`, `signoff_roles()`, `review_from_firm()`; audit triggers and row-level security on every review table | Who may do what is enforced in the database; rules 5 and 6. |

## 0022_owner_kind.sql
| Change | Why |
|---|---|
| `user_kind` gets `owner` | The platform owner (seller of Nusuh Books). On its own so 0023 can use it. |

## 0023_tenants.sql
| Change | Why |
|---|---|
| `firms.kind` (platform, firm, company), `firms.status`, `firms.created_at`; one platform row holds the owner | Customers are accounting firms or companies that run their own books. |
| `app_is_owner()`, `app_acting_firm()`; `app_firm_id()` and `app_is_admin()` honour the owner's chosen customer (`app.acting_firm`), only for the owner | The owner works inside one customer's Administrator console at a time; everyone else stays in their own customer. |
| Companies are inserted by the owner only; a company customer's details are changed by the owner only | "Company creation will be in my hand only." |
| Trigger: owners only on the platform; no firm staff in a company customer | A company's people are company users with roles. |
| `owner_tenants()`, `owner_create_tenant()`, `owner_update_tenant()`; `auth_user_by_email` returns the customer's status | The owner console; suspended customers cannot sign in. |
| `client_roles.can_review`, `can_sign_off`; `app_can_review()`, `app_can_sign()` replace the firm-role checks in the review rules and policies; `app_client_role()` returns them | A company reviews and signs off its own months without an accounting firm. |

## 0024_calendar_portal.sql
| Change | Why |
|---|---|
| `calendar_roles()` (partner, reviewer, staff accountant, client accountant) | Who keeps the compliance calendar; view-only people read it. |
| `compliance_settings` (VAT monthly or quarterly and when quarters end; zakat, corporate tax, payroll and social insurance deadlines on or off) | The deadlines are worked out from the company and these settings (`src/books/compliance.ts`), so a change moves the dates at once. |
| `compliance_custom` (the client's own deadlines, once or repeating; archived, never deleted) | Licences, audits and anything the law tables do not cover. |
| `compliance_done` (key of a deadline, filing reference, who and when; removing it undoes "done") | Only what was done is stored; keys are checked against the company's own deadlines. |
| `portal_requests` (firm asks; answered when the client sends; only the firm closes; never deleted) | The firm asks the client for documents. |
| `portal_uploads` (client sends, with or without a request; the firm marks it dealt with; what the firm shares is marked as from the firm) and `attachments.portal_upload_id` | Documents go both ways without email. Files are attachments, added and removed only by the person who sent them, kept once the firm has dealt with them. |
| `portal_letters` (month, the firm's commentary and the figures as published; read once by the client; never changed or deleted) | The monthly report the client reads. |
| `before_attachment_change()` replaced: portal uploads; an HR document's attachment check no longer stops the later checks | Portal files follow the same rules as other attachments. |
| `portal_is_firm()`, `portal_my_clients()` | The firm's side of the portal, and what is waiting across its clients. |

## 0025_einvoicing.sql
| Change | Why |
|---|---|
| `einvoice_settings` (on or off; the seller's Saudi national address: street, 4-digit building number, district, 5-digit postal code; the exemption reason codes and texts for zero-rated, exempt and out-of-scope lines) | ZATCA needs the full national address and a reason (VATEX-SA-...) for every line without VAT. Turning it on for a Saudi company needs a connected device. |
| `contacts.building_number`, `district`, `postal_code` | The buyer's national address on standard (B2B) tax invoices. |
| `einvoice_devices` (ZATCA EGS units: environment, key encrypted by the application, CSR, compliance and production CSIDs, compliance check results, the chain counter ICV and last hash PIH; one active per company; never deleted, retired instead) | Onboarding with ZATCA, and the invoice hash chain each device keeps. |
| `einvoices` (per issued invoice or credit note: scheme `zatca` or `pint_ae`, standard or simplified, UUID, ICV, PIH, hash, XML, QR, status and ZATCA's answer; never deleted; only the answer changes; one per document unless rejected) | The record of what was sent to ZATCA (or prepared for the UAE service provider). A trigger takes the device's next counter and previous hash, so the chain cannot skip or repeat. |

## 0026_approvals_forecast.sql
| Change | Why |
|---|---|
| `app_can_approve()` (firm partner or reviewer, or a client role with "approve") | Who approves bills, supplier payments and credit notes, and sets the rules. |
| `approval_rules` (per company: bill, payment, credit note; amount from which approval is needed; on or off) | Spending controls beyond employee claims. |
| `approval_requests` (draft bill or credit note, or a supplier payment kept as data; pending, approved, rejected with a reason, withdrawn, done; never deleted while open; who sent, who decided) | The approval itself, with separation of duties (the sender never decides). |
| Triggers: a draft waiting for approval (or approved, not yet issued) is locked; issuing a bill or credit note at or above the rule's amount needs an approved request; issuing marks the request done | Approval cannot be skipped or changed after the fact, even outside the screens. |
| `payments.approval_request_id`; supplier payments at or above the rule's amount need an approved request for the same supplier and amount; recording it marks the request done | The same for money going out. |
| `forecast_items` (money in or out the books cannot know, once or repeating; archived, never deleted) and `forecast_settings` (minimum cash to keep) | The cash flow forecast. |

## 0027_warehouse_pos.sql
| Change | Why |
|---|---|
| `items.barcode` (unique per company; printable characters, no spaces; when empty a trigger makes one: 2 + 11 digits from `item_barcode_seq` + EAN-13 check digit; existing items were given one) and `ean13_check()` | Goods are scanned at the warehouse counter. Supplier codes (EAN-13, UPC or any code) are kept; goods without a code get one the client can print on labels. A mistyped retail code (wrong check digit) is refused by the service. |
| `client_roles.pos_mode`, returned by `app_client_role()` | Counter roles (store keeper, cashier): people with this role see only the counter screens. What they can do is still the role's modules, checked in the API and the database as before. |

## 0028_attendance_days.sql
| Change | Why |
|---|---|
| `hr_attendance_imports` (who imported which time-clock file for which month, how many people and days, how many kept) | A record of every file. |
| `hr_attendance_days` (one status per person per day: present, absent, leave, off; times in and out in minutes, minutes worked and overtime, the leave or correction behind it; never deleted) | Attendance comes from the time clock instead of being typed as monthly totals. |
| The monthly sheet `hr_attendance` follows the days (`attendance_month_totals`, `sync_attendance_month`); for a month with days, its absent days and overtime cannot be typed over | Payroll keeps reading the monthly sheet; the numbers come from the clock. |
| Days: an absence or a leave day changes only at trigger depth 2 or more (inside an approved correction or leave); a leave day needs approved leave covering it; months with posted payroll do not change | Overturning cannot be done by hand or by re-importing a file. |
| `hr_attendance_corrections` (absence into leave, absence excused, leave given back; days, reason; requested, approved, rejected with a reason, withdrawn; never deleted). Deciding needs `app_can_approve()` and someone other than the asker; only the asker withdraws. Approving applies it: leave is created approved, days become present, or the leave is cancelled and what is left of it is approved again | Any overturn of an absence or of approved leave goes through approval by someone else. |
| `leave_requests`: approved leave is no longer cancelled or rejected directly (only through a correction); approving leave over days the clock recorded absent needs someone else with the approve right; approved leave marks its recorded days as leave and gives them back when it ends | The same rule, whichever screen is used. |

## 0029_multi_currency.sql
| Change | Why |
|---|---|
| `accounts.currency` (empty = the company's) and `accounts.revalue`; only asset and liability accounts not used by the sales, purchases, inventory or payroll screens, never bank accounts yet; fixed once the account has postings | Deposits, loans and balances kept in another currency (IAS 21). |
| `journal_lines.fx_amount`, `fx_rate`; on a foreign account every line gives both and debit or credit = foreign amount x rate (rounded to 2 decimals); only revaluation entries post company-currency differences; `reverse_entry` copies them | The foreign balance and the company-currency balance always agree with the rates used. |
| `exchange_rates` (shared rates from the daily sync, written only with nobody signed in; a company's own rates, which win on the same day), `fx_rate_for()`, `store_shared_rates()`, `fx_sync_needs()` | Daily rates from a configurable provider, with the GCC central bank pegs always available. |
| `fx_revaluations` (one posted per company and month end, with the balances and rates used; reversible, latest first) and `fx_settings` (automatic month-end run, by the person who turned it on), `fx_auto_due()`, `fx_auto_note()` | The month-end restatement at the closing rate (IAS 21.23), to 4950 unrealised and 4951 realised exchange gains and losses. |

## 0030_year_end.sql
| Change | Why |
|---|---|
| `fiscal_years` (closed or reopened; the closing entry, the result, who and when, the reason for reopening; never deleted) | Year-end closing: income and expenses of the year to 3100 Retained earnings (per cost centre), every month locked. Partner only; years close in order and reopen latest first. |
| `year_is_closed()`; no posting into a closed year; no unlocking a month of a closed year | A closed year stays closed until it is reopened. |
| `profit_and_loss()` and `profit_and_loss_by_cost_centre()` leave out closing entries (`source_type = 'year_end_close'`) | The year's P&L still shows its result after the year is closed. |

## 0031_email.sql
| Change | Why |
|---|---|
| `email_outbox` (every email: who, to whom, subject, two-language body, attachments, status queued / sending / sent / failed, tries, provider id; never deleted; not mirrored into the audit log because bodies can hold one-time links, which are scrubbed once sent) | Sending email: invitations, password resets, documents to customers, approvals waiting. |
| `queue_email()` (company emails by people in the company; firm emails by its Administrator or the owner; the server for resets), `email_take()` / `email_done()` (the sender job, nobody signed in; retries at 1, 5, 30 minutes, then 2 hours, 6 tries), `email_retry()` | People queue; only the server sends. |
| `start_password_reset()` | Forgot password: a one-hour link by email for an active person with a password; the same answer either way. |
| `company_approvers()` | Telling approvers something waits, without opening the users table. |
| `document_links` (hash of a random token per link, expiry 180 days, revocable, last opened), `document_link_open()`, `document_public()` | A customer opens an emailed invoice, credit note or quotation without signing in (and, next, pays it). |

## 0032_accountant_tools.sql
| Change | Why |
|---|---|
| `recurring_invoices` (customer, lines, how often, next and end date, payment terms, draft / issue / issue and email; runs as the person who saved it) and `documents.recurring_invoice_id`; `recurring_invoices_due()`, `recurring_invoice_note()` for the hourly job | Rent, retainers and subscriptions invoiced on their dates. |
| `reminder_settings` (automatic or not, days after the due date, message, who turned it on) and `reminder_log` (each level once per invoice); `reminders_auto()` | Polite payment reminders by email. |
| `budgets` and `budget_lines` (per income or expense account, optional cost centre, month 1 to 12) | Budget against actual. |
| `notification_reads` (per person, own rows only) | The bell remembers what each person has seen; the notifications themselves are worked out live. |

## 0033_doc_types.sql
| Change | Why |
|---|---|
| `doc_type` gains `debit_note` and `purchase_order` (own file: a new enum value cannot be used in the same transaction) | The two new document kinds below. |

## 0034_debit_notes_purchase_orders.sql
| Change | Why |
|---|---|
| Debit notes: a sales document that must point to an issued invoice of the same customer, posts like an invoice, is allocated and paid like one, and goes to e-invoicing as a debit note (ZATCA type debit note, PINT AE 383) | Extra charges on an invoice already issued, as the tax authorities expect. |
| Purchase orders: a purchases document that never posts; states draft → sent → received → billed or cancelled; a bill may point to its purchase order | Orders to suppliers before the bill arrives, and the bill made from the order. |
| `doc_side()`, `contact_fits()`, `before_document_insert()`, `before_document_update()`, `document_amount_due()`, the e-invoice trigger and the `document_links` policy updated for the two kinds | Same rules for the new kinds. |

## 0035_billing.sql
| Change | Why |
|---|---|
| `billing_settings` (one row: seller name, VAT number and address, currency, VAT rate, days to pay) | What Nusuh Books prints on its own invoices. |
| `plans` (monthly and yearly price, companies and users included, price of each extra one a month, trial days, on sale or not; never deleted), seeded with Starter, Business, Firm and Firm Plus | What customers can buy. |
| `subscriptions` (one per customer: plan, monthly or yearly, trial, active, past due or cancelled, next bill date, discount, cancel at period end) | What each customer is on. |
| `billing_invoices` (number NB-year-0001, the customer's name, period, lines, subtotal, discount, VAT, total; only open → paid or void, never changed or deleted; one per customer and period unless voided) | Each customer's bills. |
| `billing_usage()`, `billing_quote()`, `billing_run()` (bills what is due, catches up missed periods, ends trials, applies cancellations, marks overdue customers past due), `billing_mark_paid()`, `billing_void()`, `billing_recipients()` | Owner or the server only; the customer's Administrator reads its own usage and quote. |
| Row-level security: the owner writes; an Administrator reads only its own subscription and invoices; plans and seller details readable when signed in. `email_outbox.kind` gains `billing`. | Customers never see each other's billing. |

## 0036_counter_links.sql
| Change | Why |
|---|---|
| `counter_links` (goods note, the invoice or bill made with it, the payment taken at the counter; written once, never changed or deleted; goods out only with the same customer's invoice, goods in only with the same supplier's bill) | The warehouse counter joined to sales and purchases, while posted notes and issued documents stay unchanged. |

## 0037_online_payments.sql
| Change | Why |
|---|---|
| `payment_settings` (per company: on or off, provider sandbox or Moyasar, publishable key, secret key encrypted by the server, the bank or cash account the money lands in, who turned it on) | Customers pay invoices online. |
| `online_payments` (each checkout from an invoice link: amount due then, provider reference, created, paid or failed, the payment recorded; never deleted) | One record per attempt, so a payment is recorded once and failures are visible. |
| `online_pay_start()` (public, from a link), `online_pay_checkout()`, `online_pay_get()`, `online_pay_failed()` (server only), `online_pay_done()` (in the transaction that records the payment) | The customer is never signed in; the server checks with the provider before recording. |
| `document_public()` also says whether the invoice can be paid online | The Pay online button on the invoice link. |

## 0038_bank_feeds.sql
| Change | Why |
|---|---|
| `bank_feeds` (bank account, provider sandbox / Lean / Tarabut, active, expired, disconnected or error, the bank's account id, consent end date, last sync and the day synced to, who connected it; one live feed per account; never deleted; a disconnected feed stays disconnected) and `bank_imports.feed_id` | Bank transactions come in without statement files, through the same import. |
| `bank_feeds_due()`, `bank_feed_note()` (the sync job, nobody signed in; each sync runs as the person who connected the feed) | Syncing every six hours. |

## 0039_signoff_locks_month.sql
| Change | Why |
|---|---|
| Signing off a month (insert into `review_signoffs`) locks every period overlapping the month, or creates the month's period locked; done by `lock_signed_off_month()` from an AFTER trigger, so a reviewer who cannot lock periods can still sign off | A signed-off month must not change. Before, it stayed open unless the partner also locked it. |
| `periods_signed_off` trigger: a period overlapping a month with a standing sign-off cannot be unlocked, by anyone (partner and owner role included) | The only way to reopen a reviewed month is to withdraw the sign-off with a reason, which is recorded. |
| Withdrawing a sign-off unlocks the month's periods, except those in a year closed by year-end closing and those another standing sign-off still covers | Withdrawing is how a reviewed month is corrected; year-end closing keeps its own lock. |
| `entries_signed_off` trigger: an entry (posting, reversal, imported entry) dated in a month with a standing sign-off is refused with "This period is locked. Choose a date in an open period." | Also covers days no period row covers. Same message, so the API maps it to `err.periodLocked`. |
| `signed_off_on()`, `period_signed_off()` | Used by the triggers and the period list (why a month cannot be unlocked). |
| Every month that already has a standing sign-off is locked by the migration | Old sign-offs follow the new rule. Entries posted after an old sign-off keep their "changed after sign-off" flag. |

## 0040_auth_throttle.sql
| Change | Why |
|---|---|
| `auth_attempts` (kind, key, time) and `auth_locks` (kind, key, until); the app role has no rights on them and row-level security is on with no policies, so only SECURITY DEFINER functions touch them | Sign-in throttling was in each server's memory: a restart forgot it and several servers each counted their own. |
| Kinds: `account` (normalised email: 5 failures in 15 minutes lock it for 15 minutes, even for the right password), `ip` (30 failures in 15 minutes from one address, across any accounts), `mfa` (user id: 5 wrong two-factor codes), `reset` (password reset requests per email), `pay` (Pay online per invoice link, keyed by the link's hash) | Unknown emails are counted exactly like known ones, so the answer does not reveal which emails have accounts. |
| `auth_throttle_blocked()`, `auth_throttle_fail()`, `auth_throttle_clear()` (a successful sign-in clears the account's count, never the address's), `auth_throttle_purge()` (hourly job: attempts older than 24 hours) | Shared counts that survive restarts. |
| An `audit_log` row (`table_name` auth_locks, `action` lockout, the key and the count; no password data) when an account or a two-factor step is locked | Lockouts are visible in the audit trail. |

## 0041_rentals.sql
| Change | Why |
|---|---|
| New optional module `Rentals` (allowed in `companies.modules`, on by default for construction); job titles may set access to it, existing roles get the same level they have for Sales; account 4100 Rental income for every company | Contracting and other companies rent out what they own (cranes, vehicles, scaffolding, generators, rooms) as income. |
| `rental_items` (code, name, category, plate or serial, units, rates by the hour, day, week and month, income account, optional fixed asset; never deleted, retired instead) | The equipment list. Units are 1 for a crane, the number owned for pooled items such as scaffolding frames. |
| `rental_contracts` (RNT-0001, customer, project or branch, site, customer's order number; open, closed or cancelled; never deleted) and `rental_lines` (item, units, basis, rate, out and return dates) | A trigger refuses a line that would put more units of an item out on any day than exist (no double booking). |
| `rental_usage` (hours per day, items rented by the hour only, on days the item was out; billed hours never change) | Crane timesheets. |
| `rental_bills` and `rental_bill_lines` (each line's billed period with the invoice it made; an exclusion constraint bills a period once; `ON DELETE CASCADE` from the draft invoice frees the period again) | Billing makes a draft invoice on the items' income accounts; issued invoices are never deleted, so billed periods stay billed. A billed line keeps its item, units, rate and start date; its return date cannot go before what is billed. A contract closes only when everything is back and billed; a billed contract is not cancelled. |

## 0042_support_chat.sql
| Change | Why |
|---|---|
| `support_threads` (customer, the company the person was in, who raised it, subject, category, open / answered / closed, last message, each side's last-seen time) and `support_messages` (author, from Nusuh Books or not, text up to 5,000 characters; never changed or deleted) | A customer's people raise issues with Nusuh Books and the owner answers, in one place, with unread counts on both sides. |
| Row-level security through `support_can_see()`: the person who raised it, their own customer's Administrators and the owner; no other customer and no other staff | Conversations stay between the customer and Nusuh Books. They carry only what people write: the owner still never sees books. |
| No INSERT or UPDATE rights for the app: `support_open()` (customers only, a company of their own), `support_post()` (sets "from Nusuh Books" only for the owner; the owner's message marks it answered, the customer's opens it again), `support_close()`, `support_seen()` | Nobody can write as Nusuh Books or change a status by hand. |
| `support_list()`, `support_messages_of()` (the owner's people are shown to customers as "Nusuh Books"), `support_opener()` (owner only, for the reply email) | Reading across customers for the owner without opening the users or firms tables. |

## 0043_einvoice_sender.sql
| Change | Why |
|---|---|
| `einvoices.next_attempt_at` and `last_attempt_at`; `before_einvoice_change()` lets only these and the authority's answer change (a new pending e-invoice is due at once) | The server sends simplified e-invoices by itself and retries after 2, 5, 10, 15, then every 30 minutes while ZATCA cannot be reached. The e-invoice itself still never changes. |
| `einvoice_send_leases` (one row per device, ends by itself after 5 minutes) with `einvoice_lease()` and `einvoice_release()`; RLS on, no policies | Only one sender works on a device at a time, so two servers or overlapping runs never send the same invoice twice. |
| `einvoices_to_send()` (devices with simplified e-invoices waiting, and who connected the device, for the server only) | The sender works as the person who connected the device, like the other jobs. |
| `einvoice_warnings` (e-invoice, stage: 12, 20, 24 hours, rejected, login refused) with `einvoice_warnings_due()`, `einvoice_warned()` and `einvoice_warning_recipients()` (the customer's Administrators and the company's people who can enter sales); RLS on, no policies | ZATCA allows 24 hours to report a simplified invoice; each warning goes once. Warning emails carry counts and invoice numbers only. |
| `admin_einvoices_unsent()` (Administrators only: invoice number, issue time, hours waiting, status, ZATCA's technical error, attempts, next attempt) | The Administrator sees what is not yet reported without seeing amounts, customers or invoice contents. |
| `job_runs` with `job_started()`, `job_finished()` and `job_status()`; RLS on, no policies | When each background job last ran and whether it succeeded, so monitoring can alert if one stops. |

## 0044_rooms.sql
| Change | Why |
|---|---|
| New optional module `Rooms` and industry `hospitality` (Rooms, Restaurant, Assets, HRM, CRM by default); job titles may set access to Rooms, existing roles get the level they have for Sales; account 4200 Room revenue for every company | Hotels and serviced apartments sell nights. Kept separate from core accounting: a booking makes no journal entry, only its invoice does. |
| `room_types` (code, name, capacity, nightly rate **with VAT**, income account; never deleted, retired instead), `rooms` (number, type, floor; in service, out of service or retired) and `room_rates` (seasons per room type that never overlap) | Hotels quote prices with VAT. The invoice works the price before VAT back from them per night (src/books/rooms.ts), so a bill can differ from the quoted price by a halala; the screen shows the difference. |
| `bookings` (BKG-0001; guest = a customer; room; arrival and departure, nights = departure - arrival; guests within the room's capacity; optional agreed rate; reserved → in house → departed, or cancelled / no-show; never deleted) with an exclusion constraint so a room is never booked twice on the same night (cancelled and no-show bookings free it) | Double bookings are refused by the database, not only by the screen. |
| `booking_bills` (the nights each bill covers, never overlapping for a booking, and its invoice; `ON DELETE CASCADE` from the draft invoice) and `booking_extras` (laundry, minibar ...: price with VAT, income account; carry the bill they went on, `ON DELETE SET NULL` frees them with the draft) | Each night and extra is billed once; a billed extra and a booking's billed nights, guest, arrival and agreed rate no longer change; a booking is checked out only when every night and extra is billed. |

## 0045_guest_deposits.sql
| Change | Why |
|---|---|
| Account 2150 Guest deposits held (liability) for every company | A refundable security deposit is money held for the guest, not payment for the stay: no VAT, no invoice. |
| `booking_deposits` (taken, returned or applied; amount; bank or cash account; method; for applied, the invoice and the receipt; its journal entry; never changed or deleted) and `booking_deposit_held()` | Taken: Dr bank / Cr 2150. Returned: Dr 2150 / Cr bank. Applied to the guest's invoice: Dr 2150 / Cr bank together with an ordinary receipt Dr bank / Cr Receivables allocated to the invoice, so the invoice shows as paid. A booking never returns or applies more than it holds; a deposit pays only an issued invoice of the same guest; deposits are taken before or during the stay. Keeping part for damage is an extra on the guest bill (income, with VAT) paid from the deposit. |

## 0046_advance_invoices.sql
| Change | Why |
|---|---|
| Account 2160 Customer advances (liability) for every company; `documents.is_advance` (invoices only); invoice lines may use 2160, and only an advance invoice is issued with it (one VAT rate) | An advance payment is a supply paid before it happens: its own tax invoice with VAT (ZATCA type 386), posted Dr Receivables / Cr 2160 (net) / Cr Output VAT. |
| `advance_deductions` (final invoice, advance invoice, net and VAT taken off; VAT = net x the advance's rate, BR-KSA-79; only on drafts, never changed after issue) and `advance_left()` | The final invoice shows the whole supply and its VAT, less the advance (ZATCA XML 1.2 section 9.5, BR-KSA-73 to 80). Only a fully paid advance of the same customer, without a credit note, is deducted, never beyond what is left of it. |
| Issuing a final invoice: its entry must clear the advances from 2160; the prepaid amount cannot exceed the invoice; an advance already deducted is not credited | The final invoice's entry also posts Dr 2160 (net) / Dr Output VAT (advance VAT) / Cr Receivables, so VAT is counted once. |
| `document_amount_due()` subtracts the advances deducted | The amount due is the gross less payments, credit notes and advances. |
| `booking_advances` (Rooms: advances taken for a booking) | Advances come off the guest bill automatically. |
| The VAT treatment of advances on the Saudi VAT return is to be confirmed by a qualified accountant before real use | The VAT return worksheet takes the advance's net and VAT off the final invoice's sales so it agrees with the books. |

## 0047_credit_unused_advance.sql
| Change | Why |
|---|---|
| `before_document_line_change()` and `before_document_advance()`: a credit note whose original is an advance invoice may use and be issued with 2160 Customer advances (other sales lines still need an income account; other documents still cannot post to 2160) | Found in the Rooms Deep Check: a cancelled booking's paid advance could not be refunded, because the credit note's 2160 lines were refused. Crediting the unused advance reverses 2160 and its VAT; an advance already deducted on a final invoice still cannot be credited (0046). |

## 0048_signoff_year_end_locks.sql
| Change | Why |
|---|---|
| `is_year_end_posting()`; `before_entry_insert()` and `before_entry_signed_off()` allow, in a locked or signed-off month, only the partner's closing entry of the year being closed and the reversal that reopens it; constraint trigger `entries_year_end_owned` refuses at commit any 'year_end_close' entry no closed year names | Year-end closing unlocked the year-end month to post the closing entry, which a standing sign-off refuses, so a year whose last month was signed off could not be closed or reopened. The month is no longer unlocked at all. |
| `periods.signoff_lock` (set only by the sign-off trigger; people may write only `locked_at`, by column grants); withdrawing a sign-off unlocks only periods with `signoff_lock`; a partner's lock or unlock clears it; closing a year clears it for the year's months | Withdrawing a sign-off unlocked every overlapping month, also months the partner had locked separately. Months locked before this migration count as the partner's. |

## 0049_support_owner_email.sql
| Change | Why |
|---|---|
| `support_open()` also queues a 'notice' email to every active owner account: the issue's subject and category and the number of conversations waiting, nothing else | The platform owner learns of new support issues without watching the console. No message text, names or accounting data leave in the email. |

## 0050_system_user_kind.sql
| Change | Why |
|---|---|
| `user_kind` gains 'system' | For the built-in automatic sender (0051); a new enum value needs its own transaction. |

## 0051_automatic_sender.sql
| Change | Why |
|---|---|
| One user "Nusuh Books automatic sender" (kind 'system', platform firm, never a password or two-factor secret, never a member of a company); `system_user_id()`, `app_system_company()`; `app_company_ids()` and `app_has_role()` let it act for the one company named for the transaction (`app.system_company`) and one job (`app.system_job`): 'einvoice' while the company is active with a connected or retired device, 'online_payment' while online payments are on | The ZATCA sender and the online-payment confirmation worked as the person who connected the device or switched payments on, and stopped when that person was suspended or left. |
| `before_system_write()` on the ledger, documents, contacts, accounts, periods, payments, e-invoicing, memberships, users, sign-offs and fiscal years: the automatic sender writes only ZATCA's answers ('einvoice') and customer receipts ('online_payment') | It can do nothing else, whatever code runs as it. Every write is audited under it; devices keep `created_by` and payment settings `enabled_by`. |
| `einvoices_to_send()` includes standard invoices and no longer depends on who connected the device; `online_pay_get()` runs as the automatic sender while payments are on | Standard invoices ZATCA could not clear at once are retried automatically (ZATCA Detailed Guidelines for E-Invoicing v2, May 2023, p.46). |
| `einvoice_warnings` stages c1, c4, c24; `einvoice_warnings_due()` returns `kind` and includes standard invoices pending for an hour | Administrators are warned when a standard invoice is not cleared after 1, 4 and 24 hours. |
| `document_public()`: `notCleared`, and the QR from ZATCA's cleared invoice when there is one | The customer's page says when an invoice is not cleared by ZATCA yet, and shows ZATCA's QR once it is cleared (it showed our own stamp's QR before). |

## 0052_automatic_jobs.sql
| Change | Why |
|---|---|
| `app_system_company()` and `before_system_write()` add the jobs 'recurring' (make and issue the due invoice, its entry and e-invoice), 'reminders' (email reminders), 'fx' (post the month-end revaluation, add the exchange gains and losses accounts if missing) and 'bank_feed' (import lines, book those a bank rule matches), each only while it is switched on for the company | Found in the batch 1 sweep: recurring invoices, automatic reminders and bank feed syncs stopped without a word when the person who set them up was suspended or left, and the automatic revaluation failed. |
| `recurring_invoices_due()`, `reminders_auto()`, `bank_feeds_due()` no longer require that person to be active, and return the automatic sender | Who set them up stays recorded (`created_by`, `enabled_by`). |

## 0053_session_versions_totp_steps.sql
| Change | Why |
|---|---|
| `users.session_version` (only goes up); `session_version_of()`, `session_ok()`, `end_own_sessions()`; trigger `users_session_guard` raises it when the password, the two-factor secret or the status changes | Every sign-in cookie carries the version: signing out, a new password (also by reset or invitation), a new or reset two-factor secret and a suspension end every older sign-in (security review) |
| `users.totp_last_step` (only goes up; cleared with a new secret); `totp_use()` | A two-factor code is accepted once, so a code seen by someone else cannot be used again |
| `entry_amount()` and `add_default_client_roles()` no longer executable by `nusuh_app` | Internal helpers used only by owner-rights triggers; the app never needs them with a person's input |

## 0054_einvoice_cert_renewal.sql
| Change | Why |
|---|---|
| `einvoice_devices.renewed_at`, `cert_warned_for` (people cannot set either); `before_einvoice_device_change()` lets the key and CSR change only together with a new certificate on an active device with no e-invoice waiting; company, environment and serial never change | Renewing ZATCA's certificate keeps the same device, invoice counter and last-invoice hash, so the chain is unbroken |
| `einvoice_cert_warnings_due()`, `einvoice_cert_warned()` (background job only) | Administrators are emailed once per certificate, 30 days before it ends |


## 0055_refunds.sql
| Change | Why |
|---|---|
| `payments.is_refund` (default false) | Money going back the other way: paid out to a customer, or received back from a supplier. Until now money could only move one way per side, so a credit note on an invoice the customer had already paid left the amount owed to them with no way out of the system |
| `document_amount_due()` counts allocations with a sign: an ordinary allocation reduces what is due, a refund allocation adds it back | Lets a refund settle the negative balance a credit note leaves. Every payment that existed before this migration has `is_refund = false`, so no existing figure changes; `test/refunds.test.ts` keeps that as a regression test |
| `before_payment_insert()` reverses which side of the contact is required when `is_refund` | A refund paid out needs a customer, a refund received needs a supplier |
| `before_allocation_insert()` matches the document to the refund's own side and caps the amount at what is owed back (a negative amount due) | A refund can only pay back money we are actually holding; refunding an invoice that is still unpaid, or refunding twice, is refused by the database |

## 0056_opening_documents.sql
| Change | Why |
|---|---|
| `documents.is_opening` (default false) | A client arriving from another system is owed money on PARTICULAR invoices and owes it on PARTICULAR bills. The import could only bring the whole receivable in as one total, so aged debtors, statements and payment matching were wrong from their first day |
| `before_document_line_change()` sends an opening document's line to 3000 Opening balances, and refuses any VAT on it | An opening invoice is not a new sale: the revenue and the VAT belong to the previous system and were declared there, so nothing may land in income, expense or VAT |
| `before_document_opening()`: only an invoice or a bill, exactly one line, no VAT, a number kept from the old system, and `is_opening` never changes | An ordinary document can never become an opening one, or the other way round, after the fact |
| `before_einvoice_opening()` on `einvoices`, named to run before the other checks | An opening invoice is never sent to ZATCA or PINT AE: it was invoiced and reported in the old system, and sending it again would report the same sale twice |

## 0057_cert_expiry_resign.sql
| Change | Why |
|---|---|
| `einvoices.resigned_at` | Signed again with a renewed certificate. The invoice itself is unchanged: same hash, same counter, same previous-invoice hash |
| `einvoice_device_locked_out(device)` | True when the waiting invoices cannot be sent with the device's current key: the certificate has run out, or ZATCA refuses the login (401/403) on every one of them |
| `before_einvoice_device_change()` allows renewal with invoices waiting when the device is locked out | 0054 refused renewal while invoices waited, which is right while the certificate works and a trap once it has expired: ZATCA then refuses the login, so those invoices can never be sent, and the certificate can never be renewed. A company could neither send nor renew and nothing could be invoiced again |
| `before_einvoice_change()` allows `xml` and `qr` to be redone on a still-waiting e-invoice, recording `resigned_at`, and nothing else to move | Re-signing with the new certificate. The invoice hash is taken over the invoice WITHOUT its signature and QR, so the hash, the counter and the previous-invoice hash all stay as they were and the chain is untouched; because the hash may not change, the invoice itself provably cannot be altered under cover of a re-sign. An invoice the authority has answered for is never re-signed |

## 0058_foreign_currency_documents.sql
| Change | Why |
|---|---|
| `documents.currency`, `fx_rate`, `fx_net_total`, `fx_vat_total`, `fx_gross_total` | An invoice or bill written in another currency. `net_total`, `vat_total` and `gross_total` stay in the COMPANY's currency, so the ledger, every report, the aged list, statements, the credit-note limit, approval thresholds and `document_amount_due()` all keep reading exactly what they read before. Empty columns mean a company-currency document, which is what every existing row is |
| `document_lines.fx_unit_price`, `fx_net_amount`, `fx_vat_amount` | The price and amounts as written. The rate is applied to the UNIT PRICE and the converted line then follows the ordinary arithmetic (net = quantity x price, VAT = net x rate), so a converted line satisfies the very same constraints as any other line and gross = net + VAT holds by construction. That is what stops a trial balance drifting |
| `payments.currency`, `fx_rate`, `fx_amount`; `payment_allocations.fx_amount` | What was written on the payment, against what actually reached the bank. `payments.amount` is always the company's currency |
| `document_fx_due(document)` | What is still owed in the currency the document is written in: the mirror of `document_amount_due` figure for figure, so the two close together. A document with no currency gives the same number as `document_amount_due` |
| `before_document_currency()`, named to run before the opening-balance guard | Folds the company's own currency away to empty, so there is only one way to say the same thing (as 0029 does for accounts). A credit note must be written in the same currency AT THE SAME RATE as the invoice it corrects, or the amount it credits in the books would not match the invoice, and the credit limit check would be comparing two different things |
| `before_document_line_change()` requires the written price on every line exactly when the document has a currency | There is no half-converted document |
| `before_payment_insert()` requires `amount = round(fx_amount x fx_rate, 2)` | What reached the bank must be what was written, at the rate given |
| `before_allocation_insert()` counts in the PAYMENT's currency and refuses a document in another one | A payment never spans two currencies: mixing them would convert one party's money twice and neither side would close cleanly |
| `before_advance_deduction()` refuses a deduction when either invoice has a currency; `doc_fx_not_advance`, `doc_fx_not_opening`, `doc_fx_type` | Deliberately out of scope rather than half-built: opening balances, expenses, employee claims and advance invoices stay in the company's own currency |

## 0059_vat_rounding_by_category.sql
| Change | Why |
|---|---|
| `line_vat_is_net_times_rate` replaced by `line_vat_near_its_own_share` (within one halala) | ZATCA's XML Implementation Standard v1.2 section 10: "VAT category tax amount shall be rounded on document level and NOT as a summation of rounded Invoice line VAT amounts." 0005 had written the forbidden rule into the table. A line now carries its SHARE of the category's VAT, so it can sit a halala from its own amount times the rate; more than that is still refused, so a line can never hold an arbitrary figure |
| `line_fx_vat_is_net_times_rate` replaced by `line_fx_vat_near_its_own_share` | The same, for the amounts as written on a document in another currency (0058) |
| `check_document_complete()` now requires each VAT category's tax amount to equal its taxable amount times its rate, rounded once, for the written amounts as well | This is ZATCA's BR-CO-17 enforced where it cannot be bypassed. An invoice that fails it is arithmetically wrong and ZATCA can refuse it: a two-line invoice of 3.10 each showed 6.20 taxable with 0.94 VAT, where 6.20 at 15% is 0.93 |
| No data is touched | The migration changes constraints and one function; it contains no INSERT, UPDATE or DELETE. Issued documents, their lines and their journal entries were already immutable, and an e-invoice keeps its own XML and hash. Seeding the demo books with the old code and the new gives byte-identical figures for all 78 issued documents, because the change only bites where line amounts round differently |

## 0060_close_public_api_grants.sql
| Change | Why |
|---|---|
| Where the roles `anon`, `authenticated` or `service_role` exist (Supabase), revokes all their privileges on every table, sequence and function in `public`, and removes them from the default privileges for objects made later | Supabase's own security guide says new objects in `public` go to those roles automatically. They are what anyone with the project's public key becomes, so every table without row-level security, and every helper function, would be reachable from outside the program. Measured on a simulated host before this: 1,638 objects exposed |
| On those hosts only: revokes `EXECUTE` on functions from `PUBLIC` (including as the default for new functions, which needs the global form of the command, not the per-schema one), grants it to `nusuh_app`, and makes that the default for new functions in `public` | Those roles are members of `PUBLIC`, so revoking from them alone would leave functions callable |
| Nothing at all on a server without those roles | An ordinary installation is left exactly as it was |
| No data and no table is touched | Only privileges change; row-level security is not touched or weakened |

## 0061_ownership.sql
| Change | Why |
|---|---|
| New tables `owners` (name, Arabic name, ID number, contact, active flag, and the owner's own capital account and current account, both equity), `ownership_holdings` (shares and percent per owner per effective date) and `owner_transactions` (contribution, drawing, profit_allocation, dividend_declared, dividend_paid; amount above 0; bank account; the journal entry it posted; a `reverses_id` for corrections) | Owners, partners and shareholders with shares and percentages that can change by date, and the money between them and the company. Capital in is Dr bank / Cr the owner's capital account. A drawing is Dr the owner's current account / Cr bank. A partners' profit split is Dr 3100 / Cr each partner's current account. A dividend declared is Dr 3100 / Cr 2170 Dividends payable, and paid is Dr 2170 / Cr bank. Everything posts through the ordinary ledger |
| `owner_transactions` can only be inserted: a trigger refuses any change or delete, and a reversal row must match the movement it reverses (same company, owner, kind and amount) and a movement can be reversed once (unique index on `reverses_id`) | Posted money is never edited; a correction is a reversal, as for journal entries |
| `owners` can be updated but never deleted (an owner who leaves is marked not active); an owner's accounts must be equity accounts of the same company and cannot be swapped | Keeps history and the books consistent |
| `ownership_holdings` rows can be replaced for a date; the holding's owner must belong to the same company | A change of ownership applies from its date; earlier dates keep their earlier percentages |
| Row-level security on all three tables (read for members of the company, write for the posting roles) and the audit trigger on all three | Strict separation between companies and a full audit trail, as everywhere else |
| `before_client_role_change()` and `add_default_client_roles()` now know the module key `Ownership`; existing job titles get it at the level they have for `Ledger` | Shares, capital, drawings and dividends are sensitive, so the Administrator can give or withhold them per job title |
| No chart rows are inserted | The owner accounts (32xx capital, 33xx current) and 2170 Dividends payable are created by the service when first needed, in the same way as 3100 at year end |

## 0062_department_roles.sql
| Change | Why |
|---|---|
| `before_client_role_change()` accepts the new role module key `OwnerReports` | Owner summary, profit and loss, balance sheet and cash flow are a module of their own, so a job title can be given or refused them separately from the other reports |
| Existing job titles get `OwnerReports` at the level they have for `Reports` | Nobody who could see these reports yesterday loses them without the Administrator choosing it |
| `add_default_client_roles()` now creates six titles: Client accountant (no longer includes ownership or the owner reports, for new customers), Client management, and the new Owner, Finance, Sales and Commercial; a title whose name the customer already has is not added again | Department users: Sales handles sales work only; Finance handles the money side of every department and may look at payroll, stock and projects; Commercial handles purchasing and stock; Owner sees everything including the owner reports and records ownership money. The Administrator can change or retire any of them |
| The four new titles are added to every existing customer | So they exist everywhere, not only for new customers |
| No table changes and no data is changed apart from the added job titles and the `OwnerReports` key | Job titles are data in `client_roles`; row-level security is not touched |

## 0063_owner_manages_users.sql
| Change | Why |
|---|---|
| New column `client_roles.can_manage_users` (default false); the `Owner` job title starts with it set | A company that runs its own books has no accounting firm and no separate Administrator: its Owner is one person who sees the books and manages the company's users and job titles, with one login |
| `app_is_admin()` is also true for an active client user of an active customer of kind `company` whose active job title has `can_manage_users` | Gives the Owner the same powers an Administrator has inside their own customer (users, job titles, memberships, the customer's billing view). It is bounded by `firm_id = app_firm_id()` everywhere it is used, and it is ignored for accounting firms, where the Administrator stays a separate person who can never be a books user (`check_membership` is unchanged) |
| `add_default_client_roles()` sets the right on the Owner title for new customers | So a new customer's Owner title works without setup |
| Adding a company is unchanged: only Nusuh Books adds companies, so the Owner cannot add one | Customers do not create their own companies; Nusuh Books creates and gives them |
| No data other than the flag on existing Owner titles is changed | The flag has no effect outside customers of kind `company` |

## 0064_demo_site.sql
| Change | Why |
|---|---|
| New tables `demo_marker` (which firm holds the demo companies) and `demo_entries` (the client types a visitor can enter, each with one demo user); row-level security on, no policies, no grants to `nusuh_app` | The demo site is a separate deployment with its own database of fictional companies. The app's own database role cannot read these tables at all |
| `demo_database_ok()`: true only when the marker exists AND no customer other than the platform and the demo firm exists | The demo site refuses to start, and every demo request is refused, against a database that holds a real customer. The objects exist in every database but do nothing outside a demo one |
| `demo_entries_list()` and `demo_entry_user(key)` (security definer, answer only when `demo_database_ok()`), executable by `nusuh_app` | The only way the demo site reads the list and finds the demo user for a client type |
| No existing table or policy is changed; nothing is inserted | Row-level security is not touched or weakened |

## 0065_company_admin_separate.sql
| Change | Why |
|---|---|
| `client_roles.can_manage_users` is set to false on every default Owner title, and its description no longer says it manages users | The Owner is not the Administrator: a company that runs its own books has a separate Administrator login (users, roles and permissions, raising issues) who never sees the books |
| `add_default_client_roles()` replaced: the Owner title is created without the right, with the new description; every other title is unchanged | New customers start the same way |
| The right itself (`can_manage_users`, `app_is_admin()`) is kept as an optional setting a job title can be given | Nothing built on it breaks; no table, column or policy is added, removed or loosened, so row-level security is untouched |

## 0066_remove_customer.sql
| Change | Why |
|---|---|
| `firms.removed_at` (nullable date-time) | A removed customer keeps all its books and audit history (posted entries and the audit log can never be deleted); this records when the platform owner removed it |
| `owner_tenants()` replaced: one more column, `removed_at`; same rows, same owner-only check, same grant | The owner's list can hide removed customers and offer Restore |
| `owner_update_tenant()` replaced: setting a customer active also clears `removed_at` | Suspend, reactivate and remove never disagree |
| New `owner_remove_tenant(id, removed)` (security definer, owner only, executable by `nusuh_app`, not by PUBLIC): removing sets the customer to suspended (nobody in it can sign in), stamps `removed_at` and cancels its subscription; restoring reactivates it | "Remove customer" without deleting any book, entry or log row. No table, policy or grant is loosened; row-level security is untouched |

## 0067_remove_user.sql
| Change | Why |
|---|---|
| `users.removed_at` (nullable date-time) | A removed person's row, name and history stay (posted entries and the audit log are never deleted); this records when they were removed so lists can hide them |
| New `admin_remove_user(user, removed)` (security definer; the Administrator of that customer, or the platform owner acting for it; executable by `nusuh_app`, not by PUBLIC): removing locks the person out (the same lock as suspending), clears any unused sign-in link and stamps `removed_at`; restoring lets them in again. It refuses removing yourself, the platform owner, another customer's people, and the last active Administrator; only Nusuh Books can remove an Administrator | "Delete user" without deleting a row anything refers to. No table, policy or grant is loosened; row-level security is untouched |

## 0068_pricing.sql
| Change | Why |
|---|---|
| `plans`: new `setup_price`, `implementation_price`, `extra_module_price` (all >= 0, default 0) and `annual` | The new pricing: a one-time software price, an optional one-time implementation price, a yearly membership, and a yearly price per additional module |
| `subscriptions`: new `implementation` (the customer chose the implementation service) and `setup_billed` (the one-time charges are on an invoice) | The one-time charges are billed once, on the first invoice, and the implementation is optional per customer |
| `billing_usage()` replaced with one more column, `modules` (optional modules switched on across the customer's active companies, each counted once); `billing_quote()` and `billing_run()` replaced: an annual plan bills software (first invoice), implementation (first invoice, if chosen), membership and additional modules; other plans bill exactly as before; `billing_run` marks the one-time charges billed | The invoice engine carries the new pricing. Same owner-only checks and grants; row-level security untouched |
| New plan "Nusuh Books" (software 9,000, implementation 5,000, membership 1,500 a year, 500 per additional module); the four older plans are set off sale, not deleted | The new pricing replaces the monthly plans for every kind of customer, and existing subscriptions and invoices stay readable |

## 0069_owner_email_settings.sql
| Change | Why |
|---|---|
| `users.backup_email` and `users.backup_email_verified_at` (nullable; only a user of kind `owner` may have a backup email) | The platform owner's optional backup email. It counts (gets security alerts, receives test emails) only after its own confirmation link was used. |
| New table `email_change_requests` (user, purpose `main` or `backup`, new address, link hash, expiry one hour, used at; row-level security on, no policy and no grant; rows are never deleted) | A change of sign-in email happens only through a link sent to the NEW address. Only the hash of the link is kept. |
| New table `email_tests` (batch, user, queued email, address; row-level security on, no policy and no grant; never deleted) | Which test emails the owner pressed and which queued email each became, to limit presses and to show what became of them. |
| New functions `own_email_settings()`, `own_pending_email_changes()`, `email_change_request()`, `email_change_info()`, `email_change_confirm()`, `owner_queue_test_emails()`, `owner_email_tests()` (security definer; executable by `nusuh_app`, not by PUBLIC) | The only way to read or write the two tables. Asking needs a signed-in person; an address another account uses is refused with the same words as any other refusal; at most 6 requests a day. Confirming needs no sign-in (the link is the proof), changes `users.email` (or sets the backup email), raises `session_version` so every older sign-in ends, and is written to the audit log as that person. The owner's test goes only to the owner's own sign-in email and confirmed backup, once per 20 seconds and at most 5 presses a day. |
| `email_done()` replaced: links of the form `/confirm-email/<token>` are scrubbed from the stored email once it is sent, like invitation links | A used or expired link in an old email is harmless, but there is no reason to keep it. |

## 0070_trial_lifecycle.sql
| Change | Why |
|---|---|
| `subscriptions.status` also allows `trial_ended` (locked, waiting to buy). `cancelled` now also means closed after an unpaid trial | The trial lifecycle: trial, trial_ended, cancelled, and active when the customer buys. |
| New columns on `subscriptions`: `trial_started_at`, `trial_ends_at` (23:59:59.999 Riyadh time on the last day), `grace_ends_at`, `converted_at`, `cancelled_at` (all nullable). Existing trials are filled in from their old dates in Riyadh time. A check requires the two trial dates while the status is `trial` or `trial_ended` | The dates the lock, the daily job, the e-mails and the deletion schedule work from. |
| New table `subscription_events` (customer, kind, from and to status, reason, who, when it took effect, details). Row-level security: only the platform owner can read it; the app can only read; rows are written by the functions below; rows can never be changed or deleted | Who changed what in a customer's trial, why and when (required for every change the owner makes by hand). |
| New functions `my_access_state()` and `access_state_for_user(uuid)` (security definer; read the signed-in person's own customer's trial dates; nothing for the platform owner) | The API decides from these and the clock whether a request is let in; sign-in uses the second one. |
| New functions `trial_begin()`, `trial_extend()`, `trial_convert()`, `trial_cancel()` (owner, or the server for `trial_begin`), and `lifecycle_advance()` (the hourly job; the owner or the server) | Starting, extending, converting and closing a trial, and moving unpaid trials on. The schedule numbers (15, 30, 60, 90 days) are not in the database: they live once in `src/books/trialRules.ts` and arrive as parameters. |
| `billing_run()` replaced: it skips `trial` and `trial_ended` subscriptions and no longer turns a trial into `active` by itself; a cancellation at the end of a period records `cancelled_at` | An unpaid trial must lock, not become a paying customer. Before this, a trial that ended was billed and set to active automatically. |
| Nothing about row-level security on existing tables changed | Locking is decided in the API (from the clock) before a request reaches the data, so every existing rule still applies unchanged. |

## 0071_website_connection.sql
| Change | Why |
|---|---|
| New table `website_settings` (one row): which plan the website sells, the English and Arabic names of its four price lines, the testimonial limit (5 to 10, default 8). A database check refuses a lower limit than the number of testimonials saved | Payment settings and the testimonial limit in the owner console. |
| The website's prices are the plan's own prices in `plans`: implementation = `setup_price`, accounts clean-up = `implementation_price`, annual fee = `yearly_price`, extra module = `extra_module_price` | One source: the website and the billing run cannot disagree. |
| `plans` gets a check that no price is above 1,000,000 | The owner types prices by hand. |
| New table `website_testimonials` (name, job title, company, quote up to 300 letters, optional Arabic versions, the customer's permission (required), a note on where it is kept, shown or hidden, order). A database trigger refuses one more than the limit (the settings row is locked first, so two adds at once cannot both slip in) | Testimonials the owner writes; real quotes only, each with permission. |
| New table `plan_price_changes` (plan, who, why, what changed before and after, how many paying customers were affected, when). Never changed or deleted | Every price or name change needs a reason and is kept. |
| Row-level security on the three tables: only the platform owner reads or writes; audit triggers on `website_settings` and `website_testimonials` | Same rules as the rest of the owner console. |
| New function `public_site_data()` (security definer, read-only, executable by `nusuh_app`, not by PUBLIC): prices, names, and the visible testimonials in order | The one public answer the website asks for. It contains nothing private. |

## 0072_trial_emails.sql
| Change | Why |
|---|---|
| `email_outbox.kind` also allows `trial` | The trial reminder e-mails go through the ordinary outbox and sender. |
| New table `trial_email_log` (customer, reminder, the address, the queued e-mail and its copy to hello@; one row per customer and reminder, enforced unique). Only the platform owner can read it; a row can never be changed (except filling in the queued e-mail ids once) or deleted | A reminder goes out once only, however often the job runs or if two jobs overlap, and the owner can see what became of each. |
| New functions `trial_mail_targets()`, `trial_email_claim()`, `trial_email_attach()` (server only; the first also the owner) and `owner_trial_emails()` (owner only), executable by `nusuh_app`, not by PUBLIC | The daily job claims a reminder and queues it in one step: if queuing fails the claim is undone and tried again next run. |
| Nothing about existing tables' row-level security changed | |

## 0073_trial_screens.sql
| Change | Why |
|---|---|
| New function `my_trial_modules()` (security definer, read-only, executable by `nusuh_app`, not by PUBLIC): the optional modules switched on in the signed-in person's own customer; nothing for the platform owner or when nobody is signed in | The "your trial has ended" screen says plainly which optional modules stay on only if bought. It reveals module names only, nothing about anyone's books. |

## 0074_trial_orders.sql
| Change | Why |
|---|---|
| `billing_settings` gets `bank_account_name`, `bank_name`, `bank_iban`, `bank_swift` (IBAN and SWIFT checked by pattern; all four or none, enforced by the service) | The owner's bank account, shown to a customer that buys inside the software (Owner > Settings > Payment settings). |
| New table `user_last_login` and function `record_login(uuid)` (only the server, nobody signed in, can call it) | The owner's Trials view shows when somebody last signed in; kept apart from the user row so sign-ins do not fill the audit log. |
| `subscription_events.kind` also allows `reminder_resent` | The owner can send a reminder again, with a reason, and it is recorded. |
| New table `trial_orders` (customer, optional modules chosen, clean-up yes/no, the lines and totals worked out in the database from the prices in Payment settings, payment details the customer entered, who marked it paid and when). One waiting order per customer (unique index). Row-level security: only the platform owner reads rows; nobody writes except through the functions below. Audited | A customer in or after its trial orders what it wants and tells us about its bank transfer; the owner sees it and marks it paid. |
| New table `trial_order_proofs` (the proof of payment: PDF, PNG, JPG or WebP up to 5 MB). Row-level security: only the platform owner reads; kept apart from the order so the file never goes into the audit log | The customer may attach the transfer receipt. |
| New functions `trial_order_quote`, `trial_order_place`, `my_trial_order`, `trial_order_confirm` (the customer's side), `owner_trial_orders`, `owner_order_proof`, `owner_order_paid`, `owner_reminder_resent`, `owner_trials_overview`, `firm_name_of` (the owner's side). All security definer with a fixed search path, executable by `nusuh_app`, not by PUBLIC. `owner_order_paid` converts the SAME customer through the existing `trial_convert`, switches off the optional modules not bought, and marks the order paid; the first invoice is then made and settled in the same transaction by the existing billing functions | The amounts are never taken from the browser. Nothing about posted entries or any existing table's row-level security changed. |

## 0075_trial_setup.sql
| Change | Why |
|---|---|
| New table `trial_setup` (one row per customer: step reached, business type, goals, import-or-fresh choice, skipped, page guides opened, how many times the PDF/picture reader was used, started/completed). Row-level security: only the platform owner can read it; nobody writes except through the functions below. Audited | The guided first-run setup, and the owner's record of how far each trial customer got. |
| New functions `my_setup()`, `setup_save()`, `setup_apply_modules()`, `setup_tour_seen()`, `setup_extract_used()` (the customer's side) and `owner_setup_overview()` (owner only; counts of companies, contacts, documents and people, never the books' contents). All security definer with a fixed search path, executable by `nusuh_app`, not by PUBLIC. `setup_apply_modules` only switches optional modules ON, only in the caller's own company, and only while the customer is in an unpaid trial | The goals the customer picks switch on what it needs; after buying, modules are billed and stay the owner's to change. Nothing about any existing table's row-level security changed. |

## 0076_order_place_lock.sql
| Change | Why |
|---|---|
| `trial_order_place()` takes a short per-customer lock before replacing the waiting order | Two simultaneous clicks made the second one fail with a confusing error (found by the load test). No table changed. |

## 0077_signup.sql
| Change | Why |
|---|---|
| `email_outbox.kind` also allows `signup` | The confirmation e-mail goes through the ordinary outbox. |
| New table `signup_requests` (a request waiting for its e-mail link: name, company, country, city, registration number, the password already hashed, the link's hash, keyed hashes of the e-mail and number and address, 24-hour expiry). Row-level security with no policy and no grant: only the functions below can touch it | Nothing is created until the link is opened, so nobody can start a trial with somebody else's address. |
| New table `trial_fingerprints` (keyed hash of the e-mail in its "same mailbox" form, keyed hash of the registration number, the customer it became; no foreign key on purpose). No policy, no grant | One trial per person and per company, remembered even if the customer is later deleted. |
| New table `signup_events` (every sign-up try, allowed or refused, with the e-mail domain only; immutable; only the platform owner can read it) | The owner's record of who tried and what stopped them. |
| New functions `signup_platform_owner`, `signup_begin`, `signup_take`, `signup_done`, `signup_log_event`, `signup_cleanup` (the server only: they refuse when anybody is signed in, `signup_take` and `signup_done` also allow the owner) and `owner_signup_activity` (owner only). Security definer, fixed search path, executable by `nusuh_app`, not by PUBLIC. Locks are taken per address and per company number so simultaneous requests take turns | Creating the customer, its company, its only user and its 15-day trial happens in one transaction with the same functions the owner uses. Nothing about any existing table's row-level security changed. |

