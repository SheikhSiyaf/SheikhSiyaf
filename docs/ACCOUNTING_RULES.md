# Accounting rules as tests (write these first)

Each line is one automated test. All must pass before any ledger change merges.

## Ledger
- Balanced 2-line entry posts successfully.
- Entry with debit total different from credit total is rejected.
- Entry with fewer than 2 lines is rejected.
- Line with both debit and credit, or a negative amount, is rejected.
- UPDATE or DELETE on a posted entry or line is rejected.
- Reversal creates a new entry with debits and credits swapped; reversing twice is rejected.
- Trial balance at any date: total debits equal total credits.

## Periods
- Posting into a locked period is rejected; unlocked period accepts.
- Reversal of an entry in a locked period must be dated in an open period.
- Signing off a month locks it; nobody can unlock it while the sign-off stands; withdrawing the sign-off reopens it unless year-end closing keeps it locked (test/signoffLock.test.ts).

## Cost centres
- Account marked cost-centre-required rejects a line with no cost centre.
- One entry can split lines across several cost centres.
- P&L by cost centre sums to company P&L.

## Separation and audit
- User of company A cannot read or write company B rows.
- Every insert, reversal and lock change creates an audit_log row; audit_log cannot be edited.
- Roles: client_viewer cannot post; reviewer cannot edit client entries; only partner can lock/unlock periods.

## VAT (before invoices are built)
- Invoice VAT = line amount x company vat_rate, rounded per rule agreed with ZATCA/FTA.
- Credit note reverses the original invoice's VAT exactly.
