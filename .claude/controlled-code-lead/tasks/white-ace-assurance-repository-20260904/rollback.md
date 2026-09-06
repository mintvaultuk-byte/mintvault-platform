# Rollback — White Ace local proof repairs

## Approved image-core recovery — 2026-09-05

Pre-wave cecbd8288d591d101bf60c124e5779ea65a54458. Code rollback is an exact packet
revert, not checkout reset or removal of other work. No schema/backfill required. Preserve
all immutable objects and durable0122 intents/audits; never undo a committed first-side
publication by deleting its object or rewriting history. A failed second side must leave
the committed first side visible in durable audit, with no aggregate two-side success
claim. Retry uses current guarded state/new operation or a valid existing intent replay;
conflicts remain failures, not silent expected-state refresh. Existing reconciliation
continues to finalize or quarantine its own intents. A future rollout/rollback must drain
in-flight image operations and respect current pointers; none is authorized/executed here.
Only synthetic objects/owned test clusters are modified by proof. No live data rollback.

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
