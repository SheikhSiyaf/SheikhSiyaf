# Nusuh Books

Accounting platform for accounting firms and their clients in Saudi Arabia and the UAE (Oman later).
Stack: PostgreSQL 16, TypeScript (Node, Fastify) API, React (Vite) web, Vitest. One codebase; per-client settings.

## STANDING RULES (the owner's; they override everything else)
1. Demo data and throwaway accounts only. Never real company, customer, bank or employee data.
2. ZATCA: sandbox only, never simulation or production, unless the owner writes 'Stage 2 approved'. Name the exact
   URL paths before any ZATCA call. No real emails are sent.
3. Report in chat. Create no new report or document files except required logs (docs/SCHEMA_CHANGES.md), a few
   lines in docs/ADVISOR_BRIEF.md, and files the owner asks for. New code, tests and migrations a phase needs are fine.
4. Work on branch claude/nusuh-books-starter-kit-3vsat0. Commit and push. Never merge to main or open a pull
   request unless asked.
5. Posted entries are never edited. Money is exact. Row-level security is never weakened. Every database change
   has a migration and a SCHEMA_CHANGES entry.
6. If the brief conflicts with these rules or with accounting rules, or needs something not in the brief, stop and ask.
7. Say plainly what could not be tested and what was surprising. Never say something passes unless it was run.
8. One phase per session: finish, run the Deep Check, report, stop.
9. Secrets live only in the host's settings: never in code, the repository or chat. Never ask for them in chat.

At the end of every phase, run docs/DEEP_CHECK.md before reporting.

## Accounting rules (non-negotiable)
1. Every journal entry balances (debit = credit) and has at least 2 lines.
2. Posted entries and lines are never edited or deleted; corrections by reversal or credit note.
3. Locked periods reject any posting.
4. Every journal line can carry a cost centre; accounts can require one.
5. Every change is written to the audit log.
6. Strict separation between companies: every row carries company_id, enforced by row-level security and tested.
7. Money is NUMERIC(18,2) in the database and bigint minor units in code (src/money.ts). Never floats.
8. Any change to ledger, VAT or report logic comes with automated tests, and all tests pass.

## How to work
- Write the test first. Read docs/ACCOUNTING_RULES.md before touching ledger code.
- `npm test` and `npm run typecheck` pass before every commit.
- Every UI string in web/src/i18n.tsx, English and Arabic (right to left). Plain accountant language; prevent errors
  rather than show them.
- Schema changes: a new file in db/migrations/ (never edit an applied one), logged in docs/SCHEMA_CHANGES.md.
- Invoice data is the same for all countries; each e-invoicing system (ZATCA, UAE Peppol, Oman) is a separate adapter.
  Confirm e-invoicing specs with the authority before building.
- After each feature or fix, update docs/ADVISOR_BRIEF.md ("What is built", "Where things stand", date) in a few
  lines and say so.
- Use the headroom skill for every file read: measure first, then read only the parts needed.
- After each phase is pushed, save a source snapshot to the owner's Google Drive, folder "Nusuh Books / 3 Backups /
  Per version" (id 1sVNc4C9KxAGQkBU_3wy_UcEDqNkC-LuU): `git archive` of the tracked files without marketing-screens,
  named with the commit, never including .env. The connector takes about 3 MB of files per call; if the zip is larger,
  say so in the report and do not split it. New documents go in "4 Documents" (id 1bQiIeR8zt-AYQ4rOSdEZCm8aukP8ICpq).

## Read only when needed
- docs/DECISIONS.md: decided product rules, users and access, client registration, open questions.
- docs/PRODUCT_SPEC.md: full feature list. docs/PENDING.md: what is left.
- docs/ACCOUNTING_RULES.md: tests to write first. docs/DEEP_CHECK.md: the end-of-phase check.
- prototype/nusuhbooks.html: visual and flow reference only.

## Commands
- First run: `npm install`, `cp .env.example .env`, `npm run db:up`, `npm run setup`, `npm start` -> http://localhost:3000.
- Dev: `npm run dev` -> http://localhost:5173. Tests: `npm test`. Types: `npm run typecheck`.
- Browser checks: `npm run test:browser` (real screens, test-browser/). Everything CI runs: `npm run test:all`.
- If Postgres is down in a cloud session: `service postgresql start`.
- Background jobs and outside calls have off switches (`*_JOBS=off`, `OUTSIDE_CALLS=off`); see src/api/main.ts.
