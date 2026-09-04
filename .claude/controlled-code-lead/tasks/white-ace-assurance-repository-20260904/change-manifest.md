# Change manifest — White Ace repository assurance 2026-09-04

**Baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`

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
