Paste this into Claude Code after opening it in the repo folder:

Read CLAUDE.md and everything in docs/ first. Do not build any UI yet.
1. Set up the project: TypeScript on Node, PostgreSQL through docker compose, Vitest. Explain the folder structure you choose before creating it.
2. Turn db/schema.sql into a first migration. Extend row-level security to every table that has company_id (journal_lines through its entry), and add users, memberships and assigned-company access matching CLAUDE.md.
3. Write automated tests for every line in docs/ACCOUNTING_RULES.md plus data separation between companies, then make them pass.
4. Show me the test results and list anything in the schema you changed and why.
Ask me before deciding anything listed under Open in docs/DECISIONS.md.
