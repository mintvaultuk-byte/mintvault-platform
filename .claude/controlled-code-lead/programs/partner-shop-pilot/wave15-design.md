# Wave 1.5 — Hardening before main merge (owner-authorised 2026-07-30)

Baseline for ALL packages: integration/partner-shop-pilot-r1 @ da08d06d (verified; origin/main unmoved at 6b30136f; package heads unmoved). No package-specific baselines needed.

## Packages & exact ownership

| Pkg | Branch | Owns | Explicitly prohibited |
|---|---|---|---|
| P1 seam regressions | psp/wp15-seam-regressions | NEW tests/partner-integration-seams.test.ts; NEW server/lib/request-logger.ts (behaviour-preserving extraction of the body-logging middleware + BODY_LOG_SUPPRESSED_PREFIXES from server/index.ts); server/index.ts (ONLY the extraction hunk) | ci.yml (reuses existing PARTNER_MOUNT_RT_* CI env; creates own extra DB at setup via admin conn), connector test files, delivery/email, client, flags.ts, mount.ts |
| P2 reset email | psp/wp15-reset-email | server/partner/delivery.ts (default reset adapter); server/email.ts (ADDITIVE partner reset email fn following existing Resend pattern); NEW tests | server/index.ts, ci.yml (reuse existing wired env pairs for DB tests), connector files, client, auth/session files, rate limiters |
| P3 connector CI | psp/wp15-connector-ci | .github/workflows/ci.yml (EXCLUSIVE); the 14 connector test files + connector test helpers (role-name isolation, env gating); hard executed-suite assertion | ALL server/** production files, client, delivery/email, index.ts, P1's new files |

## Collision assessment
- ci.yml: P3 exclusive (P1 avoids by reusing WP-1's already-wired env pair + self-created DB; P2 reuses existing pairs).
- server/index.ts: P1 exclusive (extraction hunk only).
- server/email.ts + delivery.ts: P2 exclusive.
- Connector test files: P3 exclusive (P1 writes only NEW files).
Zero shared files ⇒ full parallel dispatch, no sequencing required.

## Review plan
Per package: Director verifies branch/commits/diff-vs-boundary/protected files/tests-genuinely-ran, then diff-scoped hostile review (P1: backend lens; P2: security lens — token handling; P3: infrastructure lens — CI honesty), narrow remediation as needed.

## Integration plan
After all three accepted: separate integration agent merges into integration/partner-shop-pilot-r1 (expected conflicts: none by ownership; ci.yml only if P3 restructures blocks the Wave-1 suites use — resolution rule: union, nothing dropped). Then the owner's post-hardening gate: full typecheck/lint/build, all partner auth/public/runtime/capability suites, all connector suites, all seam tests, migration topology check (no migrations expected — assert none added), security hostile review of the FINAL integrated diff vs 6b30136f. PR prepared only if zero Crit/High; merge only on explicit owner authorisation.

## Holds
No main merge, no push of anything, no deploy, no flags, no Gate 4 (0033/0034/wallet HTTP/ledger/Stripe/submissions-flow), no production anything.
