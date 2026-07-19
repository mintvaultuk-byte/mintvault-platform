# Trusted Intake Connector — G3 Reconciliation Runbook

Per `G3-PLAN.md`'s scope split: the state model, schema, and every scenario
below are fully designed; `inspectConnectorImportConsistency()` (read-only)
is implemented and tested this pass. The broader operator-facing "fix it"
actions (`reconcileConnectorImport`, `completeReconciliationFromExisting
Destination`) are designed here but **not implemented** this pass — see
`G3-PLAN.md` scope-deferral rationale. Because the transaction design in
`IDEMPOTENCY-AND-TRANSACTION.md` makes most of the brief's listed crash
scenarios structurally unreachable (single-transaction atomicity collapses
many of them into the same two outcomes), the inspector's job is mostly to
*prove* a given scenario is unreachable or to flag the small number that
genuinely require human judgement.

| # | Scenario | Structurally reachable? | Resolution |
| --- | --- | --- | --- |
| 1 | `ready_for_import`, completed mapping exists | No — step 8 of the import sequence always returns the existing destination before a second reservation is attempted; the connector would already be `imported`, not `ready_for_import`, once a mapping completes (both happen in the same transaction) | N/A — proves the pairing (`ready_for_import` + completed mapping) cannot coexist; inspector asserts this invariant |
| 2 | `importing`, destination + completed mapping exist | Not reachable in this design — there is no separate `importing` *intermediate* commit; the connector never observably sits in `importing` mid-transaction from another session's point of view (Postgres doesn't expose uncommitted state) | N/A |
| 3 | `importing`, destination exists, mapping incomplete | Same as above — not reachable; `submissions` INSERT and mapping completion are the same transaction | N/A |
| 4 | Mapping `reserved`, no destination | **Reachable** — a crash between step 9 and step 14 leaves exactly this | Retry: importer reuses the `reserved` row (see idempotency doc); inspector flags any `reserved` row older than a lease-equivalent timeout (e.g. 10 minutes) as `needs_review` if no retry has occurred, since an abandoned reservation with no destination and no active claimant is the one genuinely ambiguous case ("did the process die, or is it just slow?") |
| 5 | Mapping `completed`, destination missing | **Reachable only via manual DB tampering or corruption** — a `completed` mapping's `destination_submission_id` is set in the very same statement | `needs_review` — corruption, per the forbidden-destructive-recovery rule below |
| 6 | Connector `imported`, mapping missing | Same as #5 — same transaction sets both | `needs_review` — corruption |
| 7 | Connector `imported`, destination missing | Same as #5 | `needs_review` — corruption |
| 8 | Destination exists, final connector event missing | Not reachable — event write (step 16) is inside the same transaction as steps 14-15 | N/A |
| 9 | Timeout after commit | **Reachable** (network/process failure after `COMMIT` succeeds) | Not an error at all — see idempotency doc's crash-point table; a retry returns the existing destination |
| 10 | Lost API response after success | Same as #9 | Same as #9 |
| 11 | Concurrent duplicate import request | **Reachable, by design** — this is the case the `UNIQUE(connector_record_id)` constraint exists for | The losing transaction's INSERT conflicts; it re-reads and returns the winner's (possibly still in-flight, if truly concurrent) reservation, or the completed result if it already finished |
| 12 | Stale claimant attempts completion | **Reachable** | Rejected before any reservation is attempted — the existing `claimed_by`/version check (step 3) already covers this, unchanged from G1 |
| 13 | Claim expires during import | **Reachable** in theory (a very slow import) | The transaction holds a row lock on the connector record for its whole duration (step 2's `FOR UPDATE`), so a second claimant's `claimConnectorRecord` call blocks (or, if `SKIP LOCKED` is used by the global claim-next query, simply skips this row) until the first transaction commits or rolls back — an expiring lease cannot actually be "stolen" mid-transaction. If the import itself is slow enough to need a longer lease, `renewConnectorClaimLease` (G2C, already built) is available to the caller *before* starting the import — but the import transaction itself is not interrupted by a wall-clock lease expiry, only by an explicit competing transaction |
| 14 | Source changes after validation | **Reachable, common case** | Caught deliberately by step 5-7 of the import sequence — the entire reason the fingerprint recheck exists |
| 15 | Cancellation requested before import | **Reachable** | Normal `transitionConnectorState` to `cancelled` from `ready_for_import` (already legal in the matrix) — no reservation exists yet, nothing to reconcile |
| 16 | Cancellation requested after import | **Reachable as a request, rejected as an action** | `imported` is terminal (`LEGAL_TRANSITIONS["imported"] = []`, unchanged) — any cancellation attempt on an `imported` record fails with `invalid_state_transition`, same as G1's existing behaviour for any terminal state |
| 17 | Destination manually altered | **Reachable** (an unrelated admin edits the submission later) | Out of scope for reconciliation — the mapping's job is only to prove *a* destination exists and was created once; it makes no claim about the destination's current field values, which are free to change through normal MintVault admin workflows exactly like any other submission |
| 18 | Destination manually deleted | **Reachable** (hard delete, if ever performed — MintVault submissions use soft-delete via `deletedAt` in normal flows, but nothing at the DB level prevents a hard delete) | Detected by the inspector (`destination_submission_id` no longer resolves) → `needs_review`. Never auto-recreated. |
| 19 | Unknown/corrupt state | Catch-all | `needs_review`, evidence preserved, no guess made |

## Forbidden destructive recovery actions

- Never automatically `DELETE` a valid destination `submissions` row.
- Never create a second destination "just in case" — every path above
  either resumes/confirms an existing reservation or flags for human
  review; none create a new `submissions` row when there is doubt about
  whether one already exists.
- Never silently repair a `needs_review` mapping.

## Manual reconciliation (designed, not built)

`reconcileConnectorImport({ mappingId, actorId, reason })` — requires a
non-empty `actorId` and `reason` string (mirrors the brief's "manual
reconciliation requires actor and reason"), writes an immutable event, and
is the only place a `needs_review` mapping can transition out of that
state. Not implemented this pass — deferred to a follow-up alongside the
G4 admin surface that would actually expose it to an operator (a raw
internal function with no caller is not meaningfully "built").
