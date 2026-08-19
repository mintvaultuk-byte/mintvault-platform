# MintVault Command Centre V1 — hostile finding reconciliation

This document closes the six findings in the independent hostile implementation review (`COMMAND_CENTRE_V1_HOSTILE_IMPLEMENTATION_REVIEW_5_5.md`) against staging artifact `60b9e2683c6866a385496d14de1a780615858468`.

| ID | Severity | Verified defect | Corrective implementation | Verification | Final disposition |
|---|---|---|---|---|---|
| CC-HIR-001 | HIGH | The prior candidate included unrelated Scanner, credit/payment, webhook, Partner route and migration history. | Rebuilt from current mainline; selectively retained only Command Centre, persisted Pilot Flag integration, bounded reads, tests and governance. | `git diff --name-only facfd36...60b9e268` contains no migration, package, Scanner implementation, credit purchase, webhook, Partner write route, auth-core or grading implementation path. | **Resolved** — source boundary is clean. |
| CC-HIR-002 | MEDIUM | Exact-candidate evidence and task state were absent/stale. | Created exact artifact evidence, control audit and this reconciliation record; refreshed controlled-code-lead state. | SHA, parent, local gates, runtime mutations, staging identity, Pilot Flag proof, rollback and owner gate are traceable in the evidence package. | **Resolved** — no stale candidate is represented as deployed. |
| CC-HIR-003 | MEDIUM | Previous “52 controls” statement had no audit ledger. | Replaced the assertion with an independently countable live inventory. | Live DOM count is 68 controls: 40 page-level, 27 inherited navigation and 1 session control; row-level outcomes are in `COMMAND_CENTRE_V1_CONTROL_AUDIT.md`. | **Resolved** — the unsupported count is not repeated. |
| CC-HIR-004 | MEDIUM | Harness used an obsolete environment feature toggle. | The harness now seeds and verifies the persisted global Partner Pilot Flag `super_admin_command_centre_enabled`. | Local enabled mode completed synthetic two-step Super Admin authentication and dashboard `200`; disabled mode observed dashboard `404`; each disposable DB cleaned to zero. Live staging completed ON → OFF → ON using the same Pilot Controls. | **Resolved** — persisted flag is the actual authority. |
| CC-HIR-005 | MEDIUM | `new` and `ready_to_return` were omitted from the non-terminal canonical vocabulary. | Added schema-aligned status normalisation, terminal classification and deleted/unknown handling. | Unit and composed-adapter integration tests prove `new + ready_to_return = 5`; temporary terminal misclassification made the focused test fail, then was restored. | **Resolved** — values are not silently omitted. |
| CC-HIR-006 | MEDIUM | `String(Date)` could make attention timestamps locale-dependent before sorting. | Added ISO timestamp normalisation and invalid-value rejection before deterministic attention composition. | Unit and actual composed-adapter integration tests prove ISO output and oldest-first ordering; deliberate `Date#toString()` mutation failed then was restored. | **Resolved** — timestamp ordering is deterministic across runtime representations. |

## Cross-cutting assurance

- The dashboard remains read-only. No newly introduced write, migration, payment, grading, authentication-core, Scanner implementation or webhook path is in the release.
- Source unavailability is visible in the UI as `UNKNOWN`/`UNAVAILABLE` with source labels; no false zero is emitted.
- Partner/station information is aggregate and visibility-scoped. The stage page did not expose raw station identifiers or secrets.
- Feature-disabled and unauthorised paths fail closed. The staging OFF pass removed navigation and rendered the unavailable state; the local disabled harness observed generic API `404`.
- The staging release was deployment version `532`; both machines were started with passing health checks, `/health` returned `ok`, and `/api/version` returned `60b9e268`.

No finding is deferred. Production remains unmodified and requires a separate explicit owner gate.
