# Trusted Intake Connector — G3 Idempotency & Transaction Design

## Unique constraints (database-enforced, not just app-checked)

On `partner_connector_imports` (migration 0010):

- `UNIQUE(connector_record_id)` — one connector record can have at most one
  import-mapping row, ever.
- `UNIQUE(partner_handoff_id)` — mirrors G1's own handoff uniqueness.
- `UNIQUE(destination_submission_id)` — a MintVault submission can be the
  target of at most one Partner import.
- `UNIQUE(partner_submission_id)` — one Partner submission produces at most
  one destination, enforced at the database, not just by the connector
  record's own 1:1 relationship to the submission (defence in depth: even
  if a future bug created a second connector record for the same
  submission, this constraint would still stop a second import).

These are the actual exactly-once guarantee — not the application-level
state checks, which exist for good error messages and early exits, not as
the source of truth for uniqueness.

## Reservation → completion, not insert-then-update-only

Unlike G2's validation-run table (final-values-only INSERT, chosen because
that table has no INSERT-then-UPDATE grant), `partner_connector_imports`
**does** get UPDATE granted to `partner_connector_runtime`, but only for a
narrow, explicit set of columns (state, destination_submission_id,
completed_at, reconciled_at, last_safe_error_code — enforced by a
column-level `REVOKE`+`GRANT` pair in the migration, not just documentation)
so that a "reserved" row can be completed in a second statement within the
*same* transaction as the reservation, without ever allowing a caller to
rewrite `partner_submission_id`/`partner_organisation_id`/`source_fingerprint`
after the fact.

## Transaction sequence (single transaction, one `withConnectorTx` call)

1. `BEGIN` (via `withConnectorTx`, `tenantId` set so RLS-protected Partner
   reads are tenant-scoped, same mechanism G2 already uses).
2. `SELECT ... FOR UPDATE` the connector record — locks it against any
   concurrent claimant.
3. Verify: tenant matches, state is `ready_for_import`, `claimed_by`
   matches the caller, `version` matches `expectedVersion`, lease not
   expired.
4. Look up the latest completed validation run for this connector
   (`partner_connector_validation_runs`). Verify `outcome = 'valid'` and
   `blocking_error_count = 0`.
5. Re-read the trusted Partner source rows fresh (same shape as G2's
   `loadValidationRows`) and recompute the source fingerprint.
6. Compare against the validation run's stored fingerprint (and
   `source_fingerprint_version`, refusing if the version differs — an
   algorithm change makes the two hashes not comparable at all, handled as
   staleness rather than a false match).
7. **If mismatched**: write a `partner_connector_validation_runs` row with
   `outcome = 'stale'` (reusing G2's existing outcome vocabulary — no new
   outcome invented), transition the connector back to `validating`... no —
   per `LEGAL_TRANSITIONS`, `ready_for_import → validating` is already
   legal (G2C's revalidation transition), so a stale-at-import-time source
   sends the connector back through the existing revalidation path rather
   than inventing a new exit state. Commit only this outcome; no
   destination is touched.
8. Check for an existing `partner_connector_imports` row for this
   connector. If one exists with `state = 'completed'` and a non-null
   `destination_submission_id`: **return that existing destination** — do
   not create another. This is what makes a retried call (duplicate HTTP
   request, retried background job) safe.
9. If no row exists: `INSERT INTO partner_connector_imports (..., state)
   VALUES (..., 'reserved')` — this is the point the `UNIQUE` constraints
   above become load-bearing: if a concurrent transaction reserved first,
   this INSERT raises a unique-violation, caught and treated as "someone
   else is completing this" (re-read and either wait-free-return the
   now-completed row, or surface a retryable "in progress" error if it's
   still `reserved` — see the concurrency test for the exact behaviour
   chosen).
10. Resolve the destination owner (`connector-owner-resolution.ts`) —
    look up or create the `users` row + `partner_connector_customer_links`
    row, in this same transaction.
11. Allocate the destination reference (`connector-reference.ts`) — a
    `nextval()` call against a dedicated Postgres sequence, formatted, in
    this same transaction.
12. `INSERT INTO submissions (...)` with the resolved owner, allocated
    reference, and mapped service/price fields.
13. `INSERT INTO submission_items (...)` for every card (expanded by
    quantity, see `DESTINATION-BOUNDARY.md`).
14. `UPDATE partner_connector_imports SET state = 'completed',
    destination_submission_id = $1, completed_at = now() WHERE id = $2`.
15. Transition the connector record to `imported` — via a dedicated
    UPDATE inside `connector-import-service.ts` itself (not
    `transitionConnectorState`, which hard-blocks `toState = 'imported'`
    by design — see `G1`'s own doc comment). This function is the **one and
    only** place in the codebase permitted to write `imported`, and it only
    does so in the same statement/transaction as step 14, never separately.
16. Append the immutable `partner_connector_events` row (`imported`).
17. `COMMIT`.
18. Return the destination submission reference to the caller.

## Lock order

Connector record (`FOR UPDATE`) is always locked **first**, before any
Partner source table read, before any `users`/`submissions` write. This
matches G1/G2's existing lock order (every state-changing function there
also locks the connector record first) — no new lock-ordering rule is
introduced, so there is no new deadlock risk between G3 and G1/G2 code
paths (they can never hold conflicting lock orders on the same table set).
The `partner_connector_imports` UNIQUE-constraint-as-serialisation-point
(step 9) is a second, independent safety net that does not depend on lock
ordering at all — it's enforced by Postgres's own constraint check
regardless of statement order between two concurrent transactions.

## Crash points and recovery

| Crash point | State left behind | Recovery |
| --- | --- | --- |
| Before step 9 (before reservation) | Connector still `ready_for_import`, no mapping row | Safe to retry the whole import from scratch — nothing was created |
| Between step 9 and step 14 (reserved, not completed) | Mapping row `state='reserved'`, `destination_submission_id` null | A retry re-enters the same transaction logic; since steps 10-13 haven't committed anything yet (same transaction, so a mid-transaction crash rolls all of it back), a retry is equivalent to starting fresh — the `reserved` row conflicts with a fresh INSERT attempt (step 9's `ON CONFLICT`), so the importer instead reuses the existing `reserved` row's id and proceeds from step 10 again |
| Between step 14 and step 17 (all writes staged, not yet committed) | Nothing durable — Postgres only makes step-14-through-16's writes visible at COMMIT; a crash here is identical to a crash before step 9 from any *other* transaction's point of view | Same as above |
| After step 17 (COMMIT succeeded) but caller never received the response (network/process failure) | Fully durable: mapping `completed`, `destination_submission_id` set, connector `imported`, event written | A retry (duplicate call) hits step 8 and returns the existing destination — no new work performed, no error |

Every crash scenario above resolves to one of exactly two outcomes: "nothing
was created, safe to retry" or "everything was created and committed, retry
returns the same thing" — there is no reachable state that has created a
`submissions` row without also having completed the mapping and connector
transition, because all of it is one transaction.

## Retry behaviour

A caller retrying `importValidatedConnector` with the same `connectorId`
after ANY of the above crash points either performs the full import (if
nothing durable happened) or receives the already-created destination (if
it did) — same outward behaviour either way, satisfying "duplicate retries
return the same destination" without the caller needing to know which case
it hit.

## Destination lookup behaviour

`getImportedDestination(connectorId)` is a plain read
(`SELECT destination_submission_id FROM partner_connector_imports WHERE
connector_record_id = $1 AND state = 'completed'`) — available even when
the connector flag is off (matching G1/G2's existing "status reads work
even when disabled" posture), used both by the importer's own step 8 and by
any future caller wanting to look up an already-imported destination
without re-running the whole import flow.

## Exactly-once proof

Enforced at three independent layers, any one of which alone would be
sufficient, deliberately redundant:

1. **Database uniqueness** (the four `UNIQUE` constraints above) — the
   actual, unconditional guarantee; holds even under application bugs.
2. **Transactional atomicity** — steps 9-16 either all commit together or
   none do; no crash point can produce a `submissions` row whose mapping
   was never completed.
3. **Application-level early return** (step 8) — the fast, common-case path
   that avoids even attempting a second reservation for an already-completed
   import, so a legitimate retry doesn't even reach the constraint-violation
   path in the normal case.

Proved by the concurrency test (`tests/partner-connector-import-concurrency.test.ts`):
N concurrent calls with the same `connectorId`, separate database
connections, asserts exactly one `submissions` row, exactly one `completed`
mapping row, and that every caller's returned destination reference is
identical.
