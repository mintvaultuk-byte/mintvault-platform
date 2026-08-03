# OPUS PACKAGE WP-2 — Partner Onboarding Completion (client-only)

ROLE: Implementation agent, one bounded package, reporting to the Programme Director. No scope decisions.

BASELINE: branch from origin/main @ 6b30136f9ac4507bfacf13ff8743417278d73e61.
BRANCH: psp/wp2-onboarding-ux — isolated worktree. CLIENT CODE ONLY.

CONTEXT (verified):
- Server endpoints exist and are contract-stable: POST /api/partner/mfa/enrol, /mfa/confirm, /mfa/recovery-codes/regenerate, /mfa/disable (server/partner/routes.ts:424–505) and POST /api/partner/auth/password-reset/request, /password-reset/consume (public). NO client UI exists for any of them.
- Login page (client/src/pages/partner/login.tsx) demands a TOTP code but a newly invited user has no way to enrol a device — first login is impossible through the UI.
- components/partner/partner-shell.tsx defines PartnerUnavailableState (503) and PartnerSessionExpiredState (401) but nothing renders them; hooks/use-partner-session.tsx:29–33 swallows ALL session errors into null (a 503 "portal disabled" looks identical to signed-out).
- Known small defects: submission-wizard.tsx:110 `catch (err: any)` (project bans `any`; use `err instanceof PartnerApiError`); wizard handleCreateCustomer swallows server validation messages; pages/partner/coming-soon.tsx exports a dead `default function PartnerUsersPage` that name-shadows the real users page.

OBJECTIVE:
1. MFA enrolment flow: after invitation acceptance (and on any login response indicating MFA required but not enrolled), route the user through an enrolment screen — call enrol, render the TOTP secret/otpauth URI (QR if an existing dependency can render one; NO new packages — text + copy button is acceptable), confirm with a code, then display recovery codes ONCE with an explicit "I have saved these" acknowledgement. Follow the exact request/response shapes in server/partner/routes.ts — inspect them first; do not guess fields.
2. Password reset UI: "Forgot password" link on login → request page (always-success messaging, no account enumeration) → consume page at a /partner/reset route reading the token from the query string → new password → back to login.
3. Honest error states: distinguish 503 vs 401 in the session layer (lib/partner-api.ts already carries status on PartnerApiError); render PartnerUnavailableState on 503 (portal disabled/emergency stop) and PartnerSessionExpiredState on mid-session 401, instead of silently bouncing to login.
4. Fix the small defects listed above (typed catches, surfaced customer-create errors, remove the dead default export).
5. Register any new routes in the partner block of client/src/App.tsx only, following the existing lazy-import pattern.

PROHIBITED: any file outside client/src/** ; any admin/* page; any change to design tokens, index.css, shared components outside components/partner/**; any server file; any migration; npm install; new dependencies; touching the submission wizard beyond the two named defects; .claude/**; git push.

DESIGN: use the existing partner-page idiom (Shadcn primitives + theme tokens, same as login.tsx/users.tsx). No new visual language. Match Manrope/system tokens already in place.

TESTING/GATES: npm run check, npm run lint, npm test (full, LC_ALL=C LANG=C), npm run build must all pass. Add component/integration tests following the existing partner UI test patterns (see tests/ partner UI suites) covering: enrolment happy path, confirm-code failure, recovery-codes acknowledgement gating, reset request+consume, 503→Unavailable rendering, 401→SessionExpired rendering. If no client test harness pattern exists for a flow, document precise manual verification steps per flow instead — do not invent a new harness.

STOP CONDITIONS: any needed change outside client/src; server contract doesn't match what a screen needs (report the exact mismatch — do NOT change the server); scope exceeding ~900 changed lines excluding tests.

REPORT BACK: commits, diff --stat, gate outputs (check/lint/test/build tails), per-flow evidence (test names or manual verification transcript), blockers, remaining risks, recommendation. No merge, no push, no deploy.

---
# DISPATCH ADDENDUM (owner-mandated control rules, 2026-07-30)

CONTROL RULES — binding:
- You may not choose your own work, widen scope, perform unrelated audits, redesign architecture, start another package, modify another package's files, merge, deploy, alter production, enable any Partner flag, or continue past an unexpected finding without explicit Programme Director instruction.
- On discovering drift, a dependency conflict, missing architecture, a security concern, or work outside your package: (1) STOP, (2) preserve the worktree exactly as-is, (3) record exact reproducible evidence, (4) report back, (5) wait. Do NOT fix out-of-scope findings yourself.
- Inspect only enough code to implement and test your package. No broad reviews, repo-wide refactors, historical reconstruction, or backlog work.
- No model/effort switching mid-package. No rebases after work begins. No force-push. No push at all — local commits only.

MANDATORY REPORT-BACK FORMAT — your final report must use exactly these headings:
## Package
## Starting SHA
## Final branch head
## Drift
## Scope completed
## Files changed
## Architecture used
## Tests run
## Exact pass/fail/skip counts
## PostgreSQL evidence, where applicable
## Security and tenant-isolation evidence
## CI execution evidence
## Commits
## Out-of-scope findings
## Remaining risks
## Recommended disposition

Finish with exactly one line: `READY FOR FABLE REVIEW` or `BLOCKED — FABLE DECISION REQUIRED`.
You may not declare yourself ready for merge, integration, staging, or deployment — disposition is the Programme Director's alone.
