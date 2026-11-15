# Deep Check (run at the end of every phase, before reporting)
Tools in a cloud session: Playwright with the pre-installed Chromium for the browser walkthrough
(desktop 1280px wide, phone 390px wide); a fresh database named nusuh_deepcheck for the clean start, dropped at the end.

1. Automated: run the full test suite and the type check. Add tests for what this phase added, including failure
   cases. Report the counts.
2. Clean start: create a new empty test database, run every migration and the seed from zero, start the app. It must
   start with no errors.
3. Throwaway walkthrough in a real browser: create NEW throwaway accounts through the app's own screens (a new firm, a
   new company, one user in each role). The demo owner login may be used only to create the throwaway firm, company
   and their first Administrators; everything after that uses the new throwaway accounts. Use this phase's features
   end to end like a first-time customer, in English and Arabic (right to left), at desktop and phone width. Look for
   broken layouts, wrong labels, wrong numbers.
4. Control checks: a user in company A cannot see or change company B's data (try it directly and by changing IDs in
   requests); each role can do only what it should; the audit log records every change; locked periods reject
   postings; posted entries cannot be edited.
5. Try to break it: empty and wrong input, double clicks, two actions at once, restarting the server in the middle of
   a task, a very long list.
6. Money check: wherever amounts or VAT are touched, recompute by hand or script and compare. Debits equal credits.
   The trial balance balances.
7. Report in chat: a table (check, result, evidence), then problems by severity (high, medium, low), then what you
   did not test.
8. If anything failed: fix it, re-run the affected checks and the full suite, and report again. If it still fails
   after two attempts, stop and explain. Do not work around it or hide it.
9. Clean up: delete throwaway data, stop test servers, add a few lines to docs/ADVISOR_BRIEF.md, commit and push.
