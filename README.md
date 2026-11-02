# Nusuh Books

Accounting platform for accounting firms and their clients in Saudi Arabia and the UAE, and later Oman.
Read `CLAUDE.md` first. It holds the non-negotiable accounting rules.

## Status
Step 1 (Foundation) has started. The database schema, row-level security, ledger, period locks, cost centres,
audit log and VAT calculation are written, with automated tests for every rule in `docs/ACCOUNTING_RULES.md`.
There is no API server or UI yet.

## Folder structure
```
db/migrations/      SQL migrations, applied in name order. This is the source of truth for the schema.
db/schema.sql       Original starter-kit draft (superseded; kept for reference).
src/db/             migrate.ts (migration runner), session.ts (withUser: one transaction per request, sets app.user_id)
src/ledger/         Posting, reversal, trial balance and period lock. Thin wrappers: the database enforces the rules.
src/vat/            VAT per line and credit notes, in exact integer minor units.
src/money.ts        Decimal strings <-> bigint minor units. Never floats.
test/               Vitest suites, one per section of docs/ACCOUNTING_RULES.md, plus registration and separation.
docs/               Product spec, decisions, accounting rules and schema changes.
prototype/          Clickable UI prototype (visual and flow reference only).
```
Later steps will add `src/api/` (HTTP API), `src/einvoicing/<country>/` (one adapter per country) and `web/` (React).

## Getting started
Requirements: Node 20+ and Docker (or any PostgreSQL 14+).

```bash
npm install
cp .env.example .env            # then edit the passwords
npm run db:up                   # PostgreSQL 16 in Docker
export $(grep -v '^#' .env | xargs)
npm run db:migrate              # applies migrations and sets the nusuh_app password
npm test                        # creates a throwaway nusuh_test database and runs every rule test
```

If you run tests against a PostgreSQL that is not at `postgres://postgres:postgres@localhost:5432/postgres`, set `TEST_PG_ADMIN_URL`.

## How data separation works
- The app connects as `nusuh_app`. That role is not a superuser, owns no tables and cannot bypass row-level security.
- Each request is one transaction that runs `set_config('app.user_id', <id>, true)`.
  The database works out which companies the user can see, and their role in each, from `memberships`.
- Every table has row-level security. The ledger and the audit log are protected by triggers that stop even the owner role from changing them.
