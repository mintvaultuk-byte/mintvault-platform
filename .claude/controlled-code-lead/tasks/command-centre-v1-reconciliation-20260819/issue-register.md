# Issue register — MintVault Command Centre V1 final reconciliation

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CC-HIR-001 | Previous candidate contains foreign Scanner, payment/credit, webhook and migration history. | Hostile review; `git diff c506175...3ad2a900` | high | confirmed | candidate diff inventory | C | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | Rebuild from `c506175`; proof is a clean Command Centre-only diff. |
| CC-HIR-002 | Exact-SHA consolidated evidence package and current task state are absent/stale. | Hostile review | medium | confirmed | release package | C | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | Create exact-candidate evidence package after testing/staging. |
| CC-HIR-003 | Prior staging 52-control claim has no row-by-row ledger. | Hostile review | medium | confirmed | staging evidence | C | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | Record the final candidate’s 52 controls with actual runtime outcome. |
| CC-HIR-004 | Runtime harness uses obsolete environment flag, not persisted global Pilot Flag. | Hostile review; `scripts/command-centre-runtime-harness.ts` | medium | confirmed | runtime harness | B | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | Seed `partner_feature_flags`; prove enabled authenticated dashboard and disabled 404. |
| CC-HIR-005 | Non-terminal KPI does not recognise canonical `new` and `ready_to_return` states. | Hostile review; `server/command-centre/core-read-adapter.ts` | medium | confirmed | core read adapter | B | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | Derive/align vocabulary from canonical schema and add status/deleted fixtures. |
| CC-HIR-006 | Core attention timestamps may be stringified non-ISO `Date` values before oldest-first sorting. | Hostile review; `server/command-centre/core-read-adapter.ts` | medium | confirmed | core read adapter | B | yes | Designed | — | pending | untouched | not activated | IN_PROGRESS | ISO-normalise/reject invalid timestamps and test cross-rule ordering. |

## Rejected findings (with reason)

- None. All six hostile-review findings have direct source/evidence reproduction.

## Deferred findings (with unblock condition)

- None. The corrections are finite and within the locked release scope.

## Fixed findings (with evidence)

- Pending implementation and verification in this pass.
