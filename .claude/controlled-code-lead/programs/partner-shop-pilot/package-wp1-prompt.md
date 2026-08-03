# OPUS PACKAGE WP-1 — Runtime Mount & Flag Control

ROLE: You are an implementation agent for the MintVault Partner Shop Pilot programme. You own exactly ONE bounded package. You report to the Programme Director. You decide nothing about scope.

BASELINE: branch from origin/main @ 6b30136f9ac4507bfacf13ff8743417278d73e61.
BRANCH: psp/wp1-runtime-mount — work in an isolated worktree. Commit only to this branch.

CONTEXT (verified facts — do not re-litigate):
- The full partner portal API (session, submissions, customers, team, MFA) exists inside `createPartnerApp()` in server/partner/app.ts but has ZERO production callers. The deployed server (server/routes.ts:2795–2802) mounts only 4 public partner routes + 4 super-admin surfaces.
- Feature flags live in DB table `partner_feature_flags`. Public routes gate on `resolveGlobalFlag` (rows with tenant_id IS NULL). The ONLY write endpoint (`POST /api/super-admin/grading-partners/:partnerId/flags`, server/partner/admin-routes.ts:239) writes tenant-scoped rows ONLY. Result: no API can enable the platform; `resolveFlag` (tenant-scoped) has zero callers.
- The deployed public slice checks `partner_login_enabled`/`partner_onboarding_enabled` + emergency stop but NOT `partner_portal_enabled` (the master switch is dead on the only live routes).
- Portal React pages are bundled in the MAIN SPA; `createPartnerApp`'s `/partner` HTML shell is a dataless placeholder.

OBJECTIVE (all four, nothing more):
1. Mount the authenticated partner surface into the MAIN app: extract the partner-portal wiring (session middleware + partnerApiRouter + partnerSubmissionRouter + partnerCustomerRouter + the gates) from createPartnerApp into a `mountPartnerPortal(app)` (new file server/partner/mount.ts is acceptable), preserving ALL fail-closed gates as router-level middleware in this order: partnerDbConfigured → definer-health → partner_emergency_stop → partner_portal_enabled. Call it from server/routes.ts directly after registerPartnerPublicRoutes. createPartnerApp must keep working for the existing test suites (it should now compose the same mount function). Remove or neutralise the placeholder `/partner` HTML route from the mounted path (the SPA serves /partner/*).
2. Add the `partner_portal_enabled` global check to the deployed public router (fail-closed 503, same pattern as the emergency stop check in server/partner/public-routes.ts:33–39).
3. Add a super-admin GLOBAL flag administration surface: GET current global flag states + PUT per-flag enable/disable writing rows with tenant_id IS NULL AND location_id IS NULL. Gate with requireSuperAdmin (see server/partner/dashboard-routes.ts for the pattern), require a reason string, audit every change (partner_management_audit or the established audit path in admin-routes.ts), rate-limit like sibling admin routes, and make writes idempotent (upsert per flag). Only flags from the canonical list in server/partner/flags.ts:13–23 are accepted; unknown names 400.
4. Validate PARTNER_* env presence coherently: extend server/config.ts startup validation so that IF partner portal mounting is possible (PARTNER_DATABASE_URL set) THEN PARTNER_MFA_ENC_KEY must also be set; absence of PARTNER_DATABASE_URL must remain a clean "portal not configured" state (existing fail-closed behaviour), NOT a crash of the main server.

PROHIBITED (stop and report if you believe you need any of these):
- Any file under client/src/**, server/partner/connector-*, partner-wallet*, partner-credit*, submission-service.ts business logic
- Any migration file; any change to shared/schema.ts, server/storage.ts, server/index.ts
- Any auth code outside server/partner/**; any Stripe/payment file; MVGS/grading files
- npm install; touching .claude/**; git push; deploy; any live database

REQUIRED BEHAVIOURAL INVARIANTS (test these):
- With zero partner_feature_flags rows: every /api/partner/* authenticated route 503s (portal gate) — never 500, never 200; the 4 public routes behave exactly as on main today plus the new portal_enabled gate.
- With global rows enabled on a disposable PG17 database: full lifecycle through the MAIN app — invitation accept → login → MFA → session → customers → submission draft → submit — passes (mirror the assertions of tests/partner-runtime-integration.test.ts through the new mount).
- Flag admin: non-super-admin 401/403; unknown flag 400; write is audited with actor + reason; global write visibly flips resolveGlobalFlag within the same test.
- Existing suites unmodified and green: partner-runtime-integration, partner-public-routes-integration, partner-admin-capability, partner-user-management-migration, partner-final-owner-invariant (run with LC_ALL=C LANG=C and the suite env vars per tests/README or CI config).

TESTS TO ADD: a new PG17 integration suite for the main-app mount parity + the global-flag admin surface, wired so it actually RUNS in CI (edit .github/workflows/ci.yml following the existing five-suite pattern; a suite that silently skips = package failure).

WORKFLOW: inspect before editing; reuse existing patterns (fail-closed idioms, error taxonomies, audit writers); smallest diff that meets the objective; no drive-by refactors, no renames outside scope, no formatting churn (use git commit --no-verify if lint-staged would reformat untouched regions, and say so).

STOP CONDITIONS (halt and report instead of proceeding): any prohibited file needs touching; existing tests fail on the unmodified baseline; the mount cannot preserve a fail-closed gate; you discover a security defect in the code you're wiring (report, do not fix out-of-scope); actual scope exceeds ~800 changed lines excluding tests.

REPORT BACK (mandatory format): commits (SHAs + messages); files changed (diff --stat); tests added/modified and full results (check/test/lint tails); evidence for each behavioural invariant (test names + assertions); blockers; remaining risks; recommendation. Do NOT merge, push, deploy, or write outside the worktree.

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
