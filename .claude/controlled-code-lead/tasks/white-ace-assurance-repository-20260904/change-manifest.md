# Change manifest — White Ace repository assurance 2026-09-04

**Baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`

## Approved UTC repair packet — 2026-09-05

Pre-wave checkpoint15101b2844187aa184198d5116e2898463dfae61, pushed non-force;
unrelated docs/planning/vault-worlds preserved. Owner-CREDIT is explicitly approved
in owner-approval-record.md, superseding only the historical credit exclusion below.
Root sole writer; CRITICAL/HOSTILE preflight; independent Terra reproduced22/24 on
owned PostgreSQL17 with Node20.20.2. This bounded nested node requires the reproduced
WAA-CREDIT-001 finding and OWNER-CREDIT, not completion of unrelated H1 browser or
restricted security work. Aggregate parent recovery/integration gates remain open.

Exact runtime write: server/estimate-credit-consumption.ts. Preserve existing timestamp
schema, reservation identity, UTC input-day contract, paid-credit ownership, daily limit,
CTE atomicity and compare-and-set. Admission stores input.today as the same UTC date
marker used by comparison and reservation, with a monotonic newer-or-same-window
predicate. Both refunds write explicitly UTC timestamps. Return refund status from claimed RETURNING before the
snapshot-visible base-table fallback, matching commit's existing idempotent pattern.
No other production files, dependencies, migrations, credentials or provider calls.

Exact test write: tests/estimate-credit-consumption-owner-binding.test.ts. Retain existing
two non-UTC regressions unchanged; add stale non-UTC recovery, first/replayed refund
result and UTC day-boundary coverage as needed. Run this real PostgreSQL suite plus
estimate-credit-idempotency and estimate-credit-recovery-lifecycle; independent verifier
and held-out/isolated mutation evidence required before candidate proof closure.
Regenerate only affected architecture snapshot records if the existing check requires it;
never raise diagnostic/no-check/legacy allowances. Existing graph/issue/proof/rollback
records track the packet; no new planning directory. Budget: one service, one test,
existing records, targeted checks; stop broadening after the affected invariants pass.

Changed-surface amendment: independent Sol reproduced admission/refund disagreement when
the trusted request day precedes SQL's day at midnight; root reproduced a delayed old
request rewinding today's occupied window. The original UTC-NOW patch was not accepted
as complete. Same-file correction uses the trusted day marker and monotonic predicate;
two added regression cases preserve this boundary. No separate finding or product scope.

## Authorised local repairs

| Finding | File | Change | Classification |
|---|---|---|---|
| `WAA-PROOF-001` | `tests/manual-certificate-image-object-write.integration.test.ts` | Follow the current HTTP-route wrapper and assert that it delegates to the already-tested durable persistence authority. | A — test-only proof repair |
| `WAA-PROOF-002` | `tests/estimate-credit-consumption-owner-binding.test.ts` | Replace the expired hard-coded day with the current UTC day, make the default fixture UTC-stable, and add controlled non-UTC-session regressions. These expose `WAA-CREDIT-001`; no production credit change is authorised here. | A — test-only clock fixture repair |
| `WAA-PROOF-003` | `tests/customer-facing-route-boundaries.test.ts`, `tests/scanner-front-before-back.test.ts` | Assert the current fail-closed `410` retirement boundaries instead of removed handler internals. | A — test-only source proof repair |
| `WAA-PROOF-004` | `tests/certificate-update-route.test.ts` | Bring the reduced certificate table fixture up to the production image-column shape required by the 0122 finalizer. | A — test-only schema fixture repair |
| `WAA-SCAN-001` | `.gitleaksignore` | Cover 147 reviewed historical findings with 137 unique exact fingerprints (some findings shared a fingerprint), plus one working-tree PostgreSQL `EXCLUDED.object_key` false positive. No broad path/rule suppression. | A — exact scanner false-positive repair |
| governance | task records and canonical issue/proof ledgers | Record evidence, status, boundaries and reproducible commands. | A — documentation |

## Explicitly excluded from this local repair

- `REL-IMAGE-001`: live phone/correction and any other missing durable object-write integration; protected storage/certificate behavior requires an exact owner-approved implementation manifest.
- `WAA-IMAGE-001`: a metadata request carrying both front and back images can fail after the first side's derivative publication changes the second side's expected pointer. Protected certificate/storage behavior requires owner approval.
- `WAA-IMAGE-002`: the outer replacement audit pairs a derived display key with the SHA-256 of different, re-encoded original bytes. Protected evidence/audit behavior requires owner approval.
- `REL-TOKEN-001`: six plaintext bearer-token families and migration 0123; protected authentication and migration work requires explicit owner approval.
- `WAA-CREDIT-001`: the anonymous estimate gate and refund paths use the database session's local date while their input contract is UTC. Payment/entitlement code requires explicit owner approval before repair.
- `REM-SUPPLY-001`: checksum-managed Engineering OS workflow and native CI proof; local edits would violate managed authority.
- `REM-GH-001` and `REL-ENV-001`: GitHub, provider, staging, production, backup/restore and credential evidence.
- Dependency changes, migration authoring/application, environment or secret changes, deployment, push and release.
- `WAA-LOCAL-SECRET-001`: chmod, deletion, or rotation of ignored local credential files; environment/secret mutation requires explicit owner approval.

## Required proof

1. Re-run the seven focused PostgreSQL 17 object-write suites and every repaired proof cluster: zero failures.
2. Re-run gitleaks over the complete reachable Git history: zero unsuppressed findings.
3. Run `npm run check`, changed-file lint, `git diff --check`, `npm run build`, Engineering OS postflight and the final risk-proportional test gate.

No production, staging, provider or external object-store mutation is authorised by this manifest.
