# G4 Failure Model

## Principles
- The G3F service call is the authoritative mutation (its own txn, exactly-once, in-txn event). G4 never writes connector/import/attempt state directly.
- Admin-action audit is a separate append (attempt row before, terminal row after). If the service call dies mid-flight, the durable `attempted` row + the service's atomic rollback = recoverable, no partial destination.
- Errors surfaced to the admin are mapped from `ConnectorError.code` → stable G4 code + safe message; raw SQL/PII never leaves the service (`toConnectorError`).

## Failure points & expected behaviour (fault-injection targets)
| Injected failure | Expected outcome |
|---|---|
| Before service call (after `attempted` audit row) | `attempted` row durable; no state change; terminal row records `failed`/retry; clean re-run converges |
| Service throws retryable (`transient_database_error`) | service txn rolled back atomically; no partial destination; G4 returns TRANSIENT_DATABASE_ERROR; audit terminal `failed`; retry allowed |
| Service throws permanent (`import_reconciliation_required`, `unauthorised`, `invalid_state_transition`) | no state change; G4 returns the mapped code; audit `failed`; NOT auto-retried |
| Connection termination mid service txn | service `withConnectorTx` finally releases; record recoverable; no partial destination |
| Idempotency-key reuse after success | no second effect; returns recorded success (REQUEST_ALREADY_COMPLETED / recorded result) |
| Two admins act concurrently on same record | optimistic `expectedVersion` + connector-row FOR UPDATE serialize; one wins, other gets OPERATION_CONFLICT/version error; no duplicate destination |
| Completed record retried | `already_completed`, same destination, zero new submissions |
| Release-claim on a LIVE (non-expired) claim | refused (`already_claimed`); no force-release |
| Batch-retry with one bad record | per-record result; bad record fails in isolation; others proceed; no unbounded txn |

## Rollback-consistency
Because admin-audit and service mutation are in different pools, a failed service call cannot leave a false `succeeded` audit row (terminal row is written from the actual outcome). A crash between attempt and terminal leaves an `attempted` row with no terminal — reconcilable and safe (no state changed by G4; the service either committed atomically or rolled back). Tested via fault injection at each point.
