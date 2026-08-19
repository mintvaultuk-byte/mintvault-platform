# Issue register — MintVault Command Centre V1 final reconciliation

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CC-HIR-001 | Previous candidate contains foreign Scanner, payment/credit, webhook and migration history. | Hostile review; `git diff c506175...3ad2a900` | high | confirmed | candidate diff inventory | C | yes | Runtime + source | `60b9e268` | version 532 | untouched | not activated | RESOLVED | Clean `facfd36...60b9e268` diff excludes every protected foreign path. |
| CC-HIR-002 | Exact-SHA consolidated evidence package and current task state are absent/stale. | Hostile review | medium | confirmed | release package | C | yes | Staging | `60b9e268` | version 532 | untouched | not activated | RESOLVED | Exact SHA evidence package created. |
| CC-HIR-003 | Prior staging 52-control claim has no row-by-row ledger. | Hostile review | medium | confirmed | staging evidence | C | yes | Staging | `60b9e268` | version 532 | untouched | not activated | RESOLVED | Actual live DOM inventory is 68 controls; full ledger replaces unsupported 52 claim. |
| CC-HIR-004 | Runtime harness uses obsolete environment flag, not persisted global Pilot Flag. | Hostile review; `scripts/command-centre-runtime-harness.ts` | medium | confirmed | runtime harness | B | yes | Runtime + staging | `60b9e268` | version 532 | untouched | staging ON | RESOLVED | Enabled `200`, disabled `404`, and staged ON → OFF → ON use persisted `partner_feature_flags`. |
| CC-HIR-005 | Non-terminal KPI does not recognise canonical `new` and `ready_to_return` states. | Hostile review; `server/command-centre/core-read-adapter.ts` | medium | confirmed | core read adapter | B | yes | Test | `60b9e268` | version 532 | untouched | not activated | RESOLVED | Canonical vocabulary and red/restore proof cover both missing states. |
| CC-HIR-006 | Core attention timestamps may be stringified non-ISO `Date` values before oldest-first sorting. | Hostile review; `server/command-centre/core-read-adapter.ts` | medium | confirmed | core read adapter | B | yes | Test | `60b9e268` | version 532 | untouched | not activated | RESOLVED | ISO normalisation and red/restore ordering proof complete. |

## Rejected findings (with reason)

- None. All six hostile-review findings have direct source/evidence reproduction.

## Deferred findings (with unblock condition)

- None. The corrections are finite and within the locked release scope.

## Fixed findings (with evidence)

- All six findings resolved; see `docs/command-centre/implementation/COMMAND_CENTRE_V1_HOSTILE_FINDING_RECONCILIATION.md`.
