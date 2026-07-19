# G4 Operational Action Matrix

Every mutation: Super-Admin only; server-derived actor (`session.authUserId`+`adminEmail`); reason required; request_id; idempotency where repeatable; delegates to the named G3F service (no reimplementation); writes a `partner_connector_admin_actions` row (attempt→result); preserves exactly-once; forbidden side effects = none (no grade/cert/label/payment/Stripe/email/notification/webhook/VQ).

| Action | Required role | Required fields | Permitted source states | Resulting state | G3F service called | Idempotency | Audit action_type | Failure codes | Forbidden |
|---|---|---|---|---|---|---|---|---|---|
| **Retry ready record** | admin | reason, request_id | `ready_for_import` (live/expired claim) | `imported` (or `already_completed`) | `importValidatedConnector` | exactly-once: repeat → `already_completed`, same destination | `retry_import` | import_not_ready, import_claim_*, import_version_conflict, import_reconciliation_required, feature_disabled | second destination |
| **Retry interrupted import** | admin | reason, request_id | interrupted (`importing`/reserved w/ expired claim) | `imported`/`already_completed` | `recoverInterruptedImport` | idempotent (importer early-return) | `retry_interrupted` | as above | — |
| **Resume reserved import** | admin | reason, request_id | mapping `reserved`, claim held | `imported` | `recoverReservedImport` | idempotent | `resume_reserved` | import_mapping_conflict, import_claim_* | second destination |
| **Request reconciliation** | admin | reason, request_id | any (inspects) | none / `reconciliation_required` / `manual_review` (per finding) | `reconcileConnector` | re-run safe (no-op when consistent) | `request_reconciliation` | manual_review_required (missing actor/reason) | arbitrary dest reassignment; rewrite completed mapping |
| **Resolve reconciliation: retain destination** | admin | reason, request_id | completed mapping missing `imported` event | writes missing event only | `completeFromExistingDestination` | idempotent (only missing event) | `reconcile_retain` | import_destination_missing | mutate submissions/mapping |
| **Resolve reconciliation: retry** | admin | reason, request_id | mapping `reserved`, claim held | `imported` | `recoverReservedImport` | idempotent | `reconcile_retry` | import_* | — |
| **Resolve reconciliation: mark manual review** | admin | reason, request_id | ready_for_import/reconciliation_required/failed/importing | `manual_review` | `markManualReview` | re-run → stays manual_review | `reconcile_mark_manual` | invalid_state_transition | — |
| **Manual-review: approve retry** | admin | reason, request_id, expectedVersion | `manual_review` | `queued` | `resolveManualReview({resolution:'retry'})` | version-guarded | `manual_review_retry` | invalid_state_transition, stale | second destination |
| **Manual-review: reject/cancel** | admin | reason, request_id, expectedVersion | `manual_review` | `cancelled` | `resolveManualReview({resolution:'cancel'})` | version-guarded | `manual_review_cancel` | invalid_state_transition | — |
| **Acknowledge permanent failure** | admin | reason, request_id, expectedVersion | `failed` | `cancelled` | `acknowledgePermanentFailure` | version-guarded | `ack_permanent_failure` | invalid_state_transition | retry a permanent failure |
| **Release expired/orphaned claim** | admin | reason, request_id | expired/orphaned lease | re-claimable (`claimed` by recovery actor or queued) | `recoverExpiredImportClaim` | idempotent (re-run safe) | `release_expired_claim` | already_claimed (live lease → refused) | force-release a LIVE claim |
| **Batch retry (bounded)** | admin | reason, request_id, recordIds[] (≤ MAX=25) | per-record eligible only | per-record result | loop of the above | per-record idempotent; rerun converges | `batch_retry` (+per-record rows) | per-record codes | "all matching"; unbounded txn |

## Deferred (read-only visibility only; write requires owner approval)
| Pause connector | — | — | n/a — no per-record state | DEFERRED | — | — | — | — | mutate state machine |
| Resume connector | — | — | n/a | DEFERRED | — | — | — | — | — |
| Disable connector (global) | — | — | n/a — no global-flag write path | DEFERRED | — | — | — | — | net-new flag write |
| Emergency stop (write) | — | — | n/a — G4-DISC-01 | DEFERRED (state shown read-only) | — | — | — | — | net-new flag write |

## Read operations (no mutation, no audit row)
Partner org list/detail; connector-record list (filters: status/validation/import/reconciliation_required/manual_review/stale/failed/interrupted/updated); record detail (validation history, owner resolution, import state, attempt timeline, mapping, destination, reconciliation findings, manual-review state, admin-action history); attempt-history (paginated append-only); mapping; worker/queue status (flag state read-only, eligible/claimed/expired/reconciliation/manual counts, retry counters, configured worker limit); operational metrics (aggregates only).
