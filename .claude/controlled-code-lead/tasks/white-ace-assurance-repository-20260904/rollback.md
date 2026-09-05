# Rollback — White Ace local proof repairs

## Approved UTC packet recovery — 2026-09-05

Immutable pre-wave code target15101b2844187aa184198d5116e2898463dfae61. Exact packet
revert restores only estimate-credit-consumption.ts and its added regressions; no reset
of the shared checkout. This is a local implementation checkpoint, not deployment.
No schema changes/backfill/shared data mutation: old/new code use the same tables and
reservation states. Do not rewrite prior reservation rows or infer a timezone for old
timestamp-without-zone values. A future authorized rollout must keep sessions UTC during
any rollback and account for active reservations; the prior non-UTC defects return if
the code is reverted. Existing stale recovery remains exactly-once and bounded; test
old-day reservations cannot decrement today's distinct usage. Only owned test clusters
may be stopped/removed by their existing fixture lifecycle. No external rollback executed.

## Historical test-only packet

No runtime or data rollback is required because the bounded implementation changes only test fixtures/assertions, exact scanner false-positive fingerprints, and governance/evidence records.

- Revert the five changed test files to restore their prior proof fixtures.
- Remove `.gitleaksignore` to restore the prior full-history/current-branch scanner findings.
- Re-run the focused suite and gitleaks command after either rollback.

Do not roll back or mutate any database, object store, provider, environment or deployed service for these repairs.
