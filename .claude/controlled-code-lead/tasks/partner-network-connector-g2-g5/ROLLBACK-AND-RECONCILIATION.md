# Trusted Intake Connector — Rollback and Reconciliation

## Migration rollback (G2 — implemented this pass)

`rollback-partner-connector-g2.sql` (tested): drops
`partner_connector_validation_findings`, `partner_connector_validation_runs`,
and reverts the `partner_connector_records.state` CHECK constraint to its
G1 shape (removing `ready_for_import` from the allowed set). Touches no
G1 object, no Phase 1/2 object, no MintVault-internal table. Idempotent.

## Feature disablement

Unchanged from G1: `partner_connector_enabled = false` (the default) stops
every state-changing G2 function before it opens a transaction. No G2 code
changes this default; it is never flipped outside a disposable-DB test
(verified by grep, same as G1's proof).

## Partial-import recovery (G3 design — not built this pass)

This section documents the _design_ for the follow-up G3 pass; nothing
here is implemented yet.

The outer import sequence (claim → revalidate → transact → transition
connector) spans two logical systems (connector tables, MintVault tables)
that happen to share one physical database today but are not treated as
one transaction (see `INTAKE-MAPPING.md` §6 for why the _inner_ MintVault
write IS one transaction, while the _outer_ sequence around it is not).
`reconcileConnectorImport()` (designed, not built) must handle every case
the brief lists:

| Observed state                                                          | Resolution                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready_for_import` but a `partner_connector_imports` row already exists | Resume from the reservation — do not create a second one.                                                                                                                                                                      |
| `importing` but a `submissions` row matching the reservation exists     | The import actually succeeded; the crash was between destination-creation and connector-state-transition. Complete the transition, do not re-create the destination.                                                           |
| Mapping row exists, connector not `imported`                            | As above — trust the mapping's `destination_submission_id` if non-null.                                                                                                                                                        |
| Destination exists, final connector event missing                       | Append the missing `imported` event from the mapping's `completed_at`, do not touch the destination.                                                                                                                           |
| Process failed before destination creation                              | Reservation exists, `destination_submission_id` is null — safe to retry the whole import from scratch (nothing was created).                                                                                                   |
| Process timed out after commit (caller never saw the response)          | The mapping row (committed in the same transaction as the destination) is authoritative — a retry finds it and returns the same destination, never creates a second one.                                                       |
| Concurrent import calls                                                 | `UNIQUE(connector_record_id)` on the reservation table serialises them at the database level — the second caller's insert conflicts, and it re-reads the first caller's (possibly still-in-progress) reservation instead.      |
| Stale claimant                                                          | Rejected before any reservation is attempted — the existing G1 claimant/version check already covers this.                                                                                                                     |
| Source changed after validation                                         | The G3B precondition list (re-check fingerprint immediately before the transactional write) catches this; if somehow missed, reconciliation flags `needs_review` rather than silently accepting a possibly-stale import.       |
| Mapping exists, destination missing                                     | Corruption — `reconciliation_status = 'needs_review'`, never auto-repaired.                                                                                                                                                    |
| `imported` without a valid mapping row                                  | Corruption — same as above.                                                                                                                                                                                                    |
| Destination manually changed or deleted (by an unrelated admin action)  | Detected by reconciliation (the mapping's `destination_submission_id` no longer resolves) and flagged `needs_review` — **never** auto-recreated, per the "never create a second destination to repair uncertainty" rule below. |
| Cancellation before import                                              | Normal `transitionConnectorState` to `cancelled` — no reservation exists yet, nothing to reconcile.                                                                                                                            |
| Cancellation after import                                               | **Rejected outright** — `imported` is terminal; `LEGAL_TRANSITIONS["imported"] = []` already enforces this at the connector-state level (inherited unchanged from G1).                                                         |

## Forbidden destructive recovery actions

- Never automatically `DELETE` a valid destination `submissions` row.
- Never create a second destination "just in case" — every reconciliation
  path above either resumes/confirms an existing reservation or flags for
  human review; none of them create a new `submissions` row when there is
  any doubt about whether one already exists.
- Never silently repair a `needs_review` mapping — it requires an
  authorised, reasoned, audited manual action (G4A's "reconcile" operation
  — designed, not built).

## Preservation of valid destination submissions

A completed `partner_connector_imports` row (non-null
`destination_submission_id`, non-null `completed_at`) is never mutated by
any connector code after creation — read-only from that point on. The
migration rollback for a future G3 migration must never `CASCADE` onto
`submissions`/`submission_items` — the mapping table's foreign key toward
`submissions` (if any) must be `ON DELETE RESTRICT` or simply not a
DB-level FK at all (MintVault-internal tables carry no cross-schema FK
today, by the same Phase 0/1 decision documented in migration 0007) so
that rolling back the _connector_ schema can never cascade-delete a real
customer's submission.

## Reconciliation rules

Documented in the table above. Reconciliation is read-mostly: it observes
mismatches and either (a) safely completes a provably-successful-but-
unacknowledged import, or (b) flags genuine uncertainty for a human, never
(c) guesses.
