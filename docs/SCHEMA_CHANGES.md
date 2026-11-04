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
