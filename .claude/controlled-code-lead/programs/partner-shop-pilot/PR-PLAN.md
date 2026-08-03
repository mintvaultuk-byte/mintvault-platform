# PR PLAN — Partner Shop Pilot Wave 1 + Wave 1.5 → main

**Status:** PREPARED, NOT OPENED. Awaiting explicit owner merge authorisation.
**Source:** `integration/partner-shop-pilot-r1` @ `b6b4019e` (canonical ref fast-forwarded 2026-07-30; round-1 branch deleted, `-wave15-v2` retained as an alias of the same commit)
**Target:** `main` @ `6b30136f` (unmoved since programme start)
**Contains:** 41 files, +6194/−229 · 6 package branches, 12 package commits, 6 merge commits, all history preserved

## Two owner checks required before merge (from the final security review)

| # | Check | Why it matters | How to answer |
|---|---|---|---|
| C1 | Does `PARTNER_DATABASE_URL` resolve to the **same Neon compute** as `MINTVAULT_DATABASE_URL`? | If YES, finding F1 (unauthenticated DB amplification on `/api/partner`) escalates from Medium to **High** and the PR gate should NOT pass until a prefix rate limiter or flag-read cache lands. If NO (separate compute), F1 stays Medium — partner-pool-only, core product insulated. | Compare the endpoint hosts in Fly secrets. Requires secret access = owner action. |
| C2 | Is `APP_URL` explicitly set on every environment where the partner reset flow can run? | If unset, `APP_BASE_URL` silently defaults to `https://mintvaultuk.com`, so a staging reset would email a real partner a link pointing at PRODUCTION (token inert there → LINK_FAILED). Finding F3. | Check Fly secrets on staging. Owner action. Mitigation is in the staging plan regardless. |

## Security gate result
**No Critical. No High.** (Explicit answer required by the owner's gate.)
7 findings: 3 Medium (F1 amplification; F2 partner-login limiter keyed on attacker-controlled email — pre-existing, but the diff added a comment falsely claiming it is IP-keyed; F3 reset URL/`RESEND_API_KEY` config coupling), 4 Low (F4 stale allowlist comment, F5 unrate-limited admin read, F6 reset token retained in browser history, F7 spoofable XFF bucket — pre-existing).

Recommended disposition of findings: **F2 fixed before flags go ON** (it is the live-partner password-spray control); F1/F3 resolved by C1/C2 above plus the staging plan; F4–F7 as a tracked follow-up package.

## Verified evidence (all independently re-checked by the Director)
- `npm run check` exit 0 · `npm run lint` **0 errors** (2494 warnings vs 2496 baseline — DOWN 2) · `npm run build` exit 0
- Full suite: 3573 passed, **0 test failures**; module-load failures = the 5 known env-dependent files, identical to baseline
- 10 partner suites all at expected counts, each exit 0 (mount 27, onboarding 20, reset 6, reset-integration 6, seams 10, runtime 38, public-routes 2, capability 5, user-mgmt-migration 1, final-owner 2)
- **All 16 connector suites: 268/268, 0 skipped, exit 0** + execution-assertion script exit 0
- Exit-code regression (round-1 blocker) CONFIRMED FIXED: fault-injection alone exit 0; full connector run exit 0
- **Migration topology: ZERO migrations added or modified** (verified by the Director: `git diff --name-only 6b30136f b6b4019e -- migrations/` is empty)
- **`shared/` untouched: ZERO files** (verified by the Director) — no schema, no MVGS, no pristine/centering
- No grading, certificate, label, admin-auth, or Stripe-webhook production file touched; webhook raw-body ordering unchanged
- Both cross-package seams have permanent regression tests that FAIL when the protection is removed (mutations performed and reverted)

## The owner's 7 named verifications — all evidenced by named tests
1. MFA secrets/recovery codes cannot enter logs — seam suite + mount suite (behavioural, drives the real logger)
2. Reset tokens cannot enter logs — reset-delivery suites (provider-throw and transport-throw paths)
3. Flags control the same DB read path as the live gates — mount suite "reports the EFFECTIVE value, read back through the runtime path"
4. Connector observes flag changes without restart — seam suite "off → on → off … no restart" + emergency stop
5. Exactly-once under concurrency and restart — runtime, fault-injection, import-service, reconciliation-concurrency
6. All connector CI suites execute rather than skip — assertion script, 16 suites / 268 tests / 0 skipped
7. Grading/certificate/admin unaffected — changed-file set + positive assertion that admin/staff/grader/scanner/cert paths travel past the mount

## PR body (draft — to be used verbatim when authorised)
Title: `feat(partner): Partner Shop Pilot Wave 1 + 1.5 — portal mount, flag control, connector activation, onboarding`

Summary: mounts the partner portal API into the main server behind four fail-closed gates; adds an audited super-admin global feature-flag API (replacing raw SQL as the only way to switch the platform on); activates the Trusted Intake Connector with a production driver; completes partner onboarding (MFA enrolment, password reset, honest unavailable/expired states); wires production reset-email delivery; and makes all 16 connector PostgreSQL suites genuinely execute in CI (previously ~250 tests reported green while silently skipped).

Risk posture: every partner surface is fail-closed and all partner feature flags remain OFF; zero migrations; no change to grading, certificates, admin auth, Stripe, or the SPA outside `/partner/*`.

## Merge mechanics (when authorised)
1. Re-verify `origin/main` still `6b30136f`; if moved, STOP and re-integrate.
2. Push `integration/partner-shop-pilot-r1` (protected action — owner approval).
3. Open PR → main; CI must go green (the exit-code fix is what makes this possible).
4. Merge only on explicit owner instruction. No squash — preserve the 12 package commits and 6 merges for audit.

## Rollback
Revert the merge commit. No migration to unwind, no data change, no flag was ever enabled. Runtime rollback without any code change: unset `RESEND_API_KEY` (reset delivery returns to fail-closed) and leave partner flags OFF (entire surface 503s).

## Explicitly NOT in this PR
Gate 4 in full (migrations 0033/0034, credit reservation integration, ledger consumption, wallet HTTP writes, submission settlement, Stripe partner top-up) — remains blocked per owner order.
