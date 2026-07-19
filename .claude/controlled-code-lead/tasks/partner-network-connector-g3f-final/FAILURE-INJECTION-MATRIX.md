# Trusted Intake Connector — G3F Failure-Injection Matrix

Failures are injected via `connector-instrumentation.ts`'s test-only hook
(`__setConnectorHook` / `__clearConnectorHook`) at the labelled points inside
the importer's single transaction, plus out-of-band techniques (connection
termination via `pg_terminate_backend`, real `statement_timeout` /
`lock_timeout`, and direct DB mutation between operations — the same techniques
G3E's tests already used). Production registers no hook: each labelled point is
a single `if (hook)` check with zero behavioural change, and the hook is `null`
in production.

**The importer emits exactly twelve hook points** (see the `hook(...)` calls in
`connector-import-service.ts` and the `ConnectorHookPoint` union in
`connector-instrumentation.ts`): `before_validation_recheck`,
`after_validation_recheck`, `before_reservation`, `after_reservation`,
`after_owner_resolution`, `after_submission_insert`, `during_item_insert`,
`after_items`, `before_mapping_completion`, `after_mapping_completion`,
`before_connector_imported`, `before_commit`. **All twelve** are driven by the
`ROLLBACK_POINTS` loop in `tests/partner-connector-fault-injection.test.ts` and
each is asserted (post-fault DB state + clean retry). There is **no** hook at the
claim, lease-renewal, or reference-allocation boundaries; rows describing those
are labelled accordingly and are NOT claimed as executed hook tests.

**Core invariant across every in-transaction row:** because the importer's
validation recheck → reservation → owner resolution → submission insert (which
allocates the destination reference) → item inserts → mapping completion →
connector `imported` transition → event write → attempt row are all **one**
`withConnectorTx` transaction, any fault _before commit_ rolls back every write
it made (connector stays `ready_for_import`, no mapping completed, no
destination, no attempt row). So most "fail after step X but before commit" rows
collapse to the same safe outcome.

## Status legend

- **EXECUTED AND PROVEN** — a test actively injects the failure at this exact
  point and asserts the DB outcome (and, for rollbacks, a clean retry).
- **STRUCTURALLY PROVEN** — guaranteed by the single-transaction / atomic-claim
  architecture and proven by an adjacent executed row that shares the same
  commit boundary; not separately fault-injected because no distinct hook point
  exists there and the outcome is identical to the executed neighbour.
- **DOCUMENTED LIMITATION** — deliberately not fabricated (e.g. a genuine
  deadlock the lock-order design makes structurally impossible), or a boundary
  that has no instrumentation hook; disclosed honestly rather than mis-claimed.
- **DEFERRED** — out of G3F scope.

| #   | Injected failure                              | Mechanism                                                                                                    | Status                | Expected DB outcome                                                                                                                                                                                                             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Before claim                                  | worker throws before `claimNextConnectorRecord` (no hook — pure control-flow)                                 | STRUCTURALLY PROVEN   | nothing claimed, no mapping, no destination — the worker never touched the DB                                                                                                                                                    |
| 2   | Immediately after claim                       | **no hook exists at the claim boundary.** The claim is its own atomic `withConnectorTx` txn in `claimNextConnectorRecord` | STRUCTURALLY PROVEN | a fault after the claim commits cannot un-claim it, but the lease expiry + reclaim path (row 19/23, executed) recovers it; a fault before the claim commits rolls the claim back (atomic). No executed hook is claimed here.       |
| 3   | After lease renewal                           | **no hook exists at lease renewal.** Renewal is an independent committed statement                            | STRUCTURALLY PROVEN   | a committed renewal is durable and harmless; a throw after it only aborts the caller with no import side effect. No executed hook is claimed here.                                                                                |
| 4   | Before validation recheck                     | hook at `before_validation_recheck` (import txn)                                                              | EXECUTED AND PROVEN   | import txn rolls back; connector stays `ready_for_import`; no destination; clean retry succeeds                                                                                                                                   |
| 5   | After validation recheck                      | hook at `after_validation_recheck`                                                                            | EXECUTED AND PROVEN   | rollback, no destination; clean retry succeeds                                                                                                                                                                                   |
| 6   | Before reservation                            | hook at `before_reservation`                                                                                  | EXECUTED AND PROVEN   | rollback, no mapping row, no destination; clean retry succeeds                                                                                                                                                                   |
| 7   | After reservation                             | hook at `after_reservation`                                                                                   | EXECUTED AND PROVEN   | rollback → the `reserved` INSERT is undone (same txn); no orphan reservation; retry re-reserves cleanly                                                                                                                          |
| 8   | After owner resolution                        | hook at `after_owner_resolution`                                                                              | EXECUTED AND PROVEN   | rollback → owner `users` row + link INSERT undone (same txn); **no orphan owner link**                                                                                                                                           |
| 9   | After reference allocation                    | **no hook exists at reference allocation** — the reference is allocated *inside* the `after_submission_insert` step; row 10 injects there | STRUCTURALLY PROVEN   | rollback undoes the submission, so the allocated `nextval` is burned (a documented, honest sequence gap) but no submission is created and no reference is reused. Proven by the executed row 10, not by a separate hook.           |
| 10  | After submission insert                       | hook at `after_submission_insert`                                                                             | EXECUTED AND PROVEN   | rollback → submission row undone; mapping not completed; no destination persists; clean retry succeeds                                                                                                                            |
| 11  | During item insert                            | hook at `during_item_insert` (after Kth item)                                                                 | EXECUTED AND PROVEN   | rollback → submission + all partial items undone atomically; clean retry succeeds                                                                                                                                                |
| 12  | After items                                   | hook at `after_items`                                                                                         | EXECUTED AND PROVEN   | rollback → submission + all items undone; clean retry succeeds                                                                                                                                                                   |
| 13  | Before mapping completion                     | hook at `before_mapping_completion`                                                                           | EXECUTED AND PROVEN   | rollback → nothing persists; clean retry succeeds                                                                                                                                                                                |
| 14  | After mapping completion                      | hook at `after_mapping_completion` (before connector→imported)                                                | EXECUTED AND PROVEN   | rollback → mapping completion undone in same txn → connector NOT imported, no destination; retry redoes cleanly. (Single-transaction architecture, so this does NOT leave a completed mapping without an imported connector.)     |
| 15  | Before connector imported transition          | hook at `before_connector_imported`                                                                           | EXECUTED AND PROVEN   | rollback → nothing persists; clean retry succeeds                                                                                                                                                                                |
| 16  | Before commit                                 | hook at `before_commit`                                                                                       | EXECUTED AND PROVEN   | no completed destination; connector unchanged; clean retry succeeds                                                                                                                                                              |
| 17  | Immediately after commit                      | fault raised by caller AFTER `withConnectorTx` returns                                                        | EXECUTED AND PROVEN   | destination + mapping + attempt already durable; a retry hits `already_completed` and returns the same destination                                                                                                               |
| 18  | After commit, before response (lost response) | harness discards the returned value, then retries                                                            | EXECUTED AND PROVEN   | retry returns the same destination (`already_completed`); zero new submissions                                                                                                                                                   |
| 19  | Worker process termination                    | worker promise abandoned after claim (lease left live)                                                       | EXECUTED AND PROVEN   | lease expires; another worker reclaims (state preserved for `ready_for_import`); the terminated worker's identity can no longer commit (`import_claimant_mismatch`)                                                              |
| 20  | Connection termination                        | `pg_terminate_backend` on the importer's backend mid-transaction                                             | EXECUTED AND PROVEN   | the transaction aborts server-side; `withConnectorTx`'s `finally` releases (pool discards the dead client, creates a fresh one); record left `ready_for_import`, recoverable; no partial destination                            |
| 21  | Transaction timeout                           | `statement_timeout` set low + a deliberately slow step (via hook `sleep`)                                     | EXECUTED AND PROVEN   | statement aborts; txn rolls back; no partial destination; error classified retryable                                                                                                                                            |
| 22  | Lock timeout                                  | `lock_timeout` low + a concurrently-held `FOR UPDATE` on the same connector                                   | EXECUTED AND PROVEN   | second caller's `FOR UPDATE` fails fast (lock_timeout), classified retryable, no duplicate                                                                                                                                       |
| 23  | Expired lease                                 | seed `claim_expires_at` in the past                                                                          | EXECUTED AND PROVEN   | reclaimable by another worker; stale worker cannot commit                                                                                                                                                                        |
| 24  | Stale source mutation                         | mutate customer/card after validation, before import                                                        | EXECUTED AND PROVEN   | import blocked; `stale` attempt row appended; connector → `validating`; no destination                                                                                                                                           |
| 25  | Duplicate request                             | N concurrent imports, same connector                                                                        | EXECUTED AND PROVEN   | exactly one destination; N−1 return `already_completed`                                                                                                                                                                          |
| 26  | Duplicate worker                              | two workers both try the same connector id directly                                                         | EXECUTED AND PROVEN   | connector row `FOR UPDATE` serialises; one imports, the other gets `already_completed` / `import_claimant_mismatch`                                                                                                              |
| 27  | Pool saturation                               | pool `max` < concurrent callers + `connectionTimeoutMillis`                                                  | EXECUTED AND PROVEN   | excess callers queue then time out with a bounded acquisition error; no client leak; no corruption                                                                                                                               |
| 28  | Transient claim error (Blocker 4)             | worker `_claimFn` injects a retryable `ConnectorError`, then a real claim                                     | EXECUTED AND PROVEN   | claim is retried a bounded number of times with bounded backoff; a recovered blip does NOT shrink the pool; on exhaustion the worker exits with a recorded transient failure (never an infinite loop)                            |
| 29  | Deadlock (where safely practical)             | not force-induced — the single-lock-order design (connector row always locked first) makes a genuine deadlock between two connector operations structurally impossible | DOCUMENTED LIMITATION | no deadlock is fabricated; the lock-timeout path (row 22, executed) covers the bounded-failure behaviour a deadlock would otherwise need                                                                                          |
| 30  | Emergency stop mid-run                        | flip `partner_emergency_stop` true during the run                                                           | EXECUTED AND PROVEN   | no NEW claims (`assertConnectorActive` throws before claim); in-flight txns finish / roll back atomically; no corruption                                                                                                          |
| 31  | Feature flag disabled mid-run                 | flip `partner_connector_enabled` false during the run                                                       | EXECUTED AND PROVEN   | no new work; in-flight finishes / rolls back; fail-closed on restart                                                                                                                                                             |

## How each status is discharged

- **EXECUTED AND PROVEN rollback rows (4–16, 20, 21):** proven by the
  `ROLLBACK_POINTS` loop and the connection/timeout tests — each asserts the
  post-fault DB state (connector `ready_for_import`, zero completed
  `partner_connector_imports` rows for it, zero `submissions` rows for it, zero
  attempt rows for it) and then a clean retry to a single destination.
- **EXECUTED AND PROVEN recovery/idempotency rows (17–19, 22–28, 30, 31):**
  assert the recovery/idempotency/bounded-failure outcome directly.
- **STRUCTURALLY PROVEN rows (1–3, 9):** no distinct hook point exists at those
  boundaries; the outcome follows from the atomic claim txn (rows 1–3) or is
  identical to the executed neighbour that shares the commit boundary (row 9 →
  row 10). Row 9's sequence-gap is asserted via row 10 as "reference still
  unique, just non-contiguous" — disclosed honestly, not hidden.
- **DOCUMENTED LIMITATION (29):** a genuine deadlock is not fabricated because
  the lock ordering makes it structurally impossible; the bounded-failure
  behaviour it would exercise is covered by the executed lock-timeout row.
