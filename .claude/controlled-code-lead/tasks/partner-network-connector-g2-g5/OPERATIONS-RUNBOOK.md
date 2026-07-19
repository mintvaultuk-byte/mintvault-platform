# Trusted Intake Connector — Operations Runbook

**Status: G2 states/validation section is implemented this pass. The
import/reconciliation/Admin-UI sections describe the G3/G4 design (not yet
built) — see `PROGRAMME-PLAN.md`.**

## States and meanings (full lifecycle, G1 + G2 implemented; G3 states designed only)

| State              | Meaning                                                                   | Implemented                                                |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `queued`           | Connector record created, not yet claimed.                                | G1                                                         |
| `claimed`          | A worker holds an active lease.                                           | G1                                                         |
| `validating`       | Validation in progress under an active claim.                             | G1 (state existed); G2 adds real validation work inside it |
| `ready_for_import` | Latest validation run outcome is `valid`, source fingerprint current.     | **G2 (this pass)**                                         |
| `importing`        | Reserved for import in progress.                                          | G3 (designed, not built)                                   |
| `imported`         | Terminal — a real MintVault submission exists.                            | G3 (designed, not built)                                   |
| `rejected`         | Terminal — latest validation found a blocking rule violation.             | G1 (state existed); G2 makes it reachable                  |
| `failed`           | Retryable — transient error, or stale source, or (G3) import uncertainty. | G1                                                         |
| `cancelled`        | Terminal — underlying Partner submission was cancelled.                   | G1                                                         |

## Validation failures (G2)

Every blocking finding code is listed in `VALIDATION-CONTRACT.md`. An
`invalid` outcome moves the connector to `rejected` (terminal) — a genuine
rule violation is not auto-retried; a human or a corrected Partner
submission (which would itself produce a _new_ handoff and hence a new
connector record, since `partner_submission_handoffs` is append-only per
submission) is required.

## Retryable vs. permanent failures

- Retryable (`failed`, `next_retry_at` set): `unknown_validation_error`
  (transient — a real DB blip), `source_version_mismatch`/`stale`
  (revalidate against fresh source).
- Permanent (no `next_retry_at`; requires explicit human action):
  `invalid` outcomes are `rejected`, not `failed` — they don't appear in
  `listRetryableConnectorRecords()` at all, correctly, since rejection is a
  business decision, not a transient glitch.

## Expired claims (G1, reused unchanged by G2)

A validating claim uses the same `claim_expires_at` lease as a `claimed`
record. **G2C's contribution**: `renewConnectorClaimLease()` lets an
in-progress validator extend its own lease before it expires, closing the
G1-documented gap where `validating` was never treated as reclaimable at
all. If a lease genuinely expires without renewal (crash), the record
becomes claimable again exactly like an expired `claimed` lease — a new
claimant re-validates from scratch (a fresh validation run, not a resumed
one — validation is cheap and idempotent by design, so restarting it is
always safe and simpler than resuming).

## Revalidation

See `VALIDATION-CONTRACT.md` — always a new run, never mutates history.

## Reconciliation (G3 design — not built)

Deferred to the G3 follow-up pass. `ROLLBACK-AND-RECONCILIATION.md`
documents the design.

## Manual cancellation

`transitionConnectorState(..., toState: "cancelled")` — already available
from G1 for every non-terminal state. No G2-specific change; validation
findings for a cancelled record remain in history (immutable), the run
itself gets outcome `cancelled` if cancellation happens mid-run.

## Emergency stop

Unchanged from G1: `partner_emergency_stop` overrides
`partner_connector_enabled`; every state-changing G2 function (creating a
validation run, completing one, renewing a lease) calls the same
`assertConnectorActive()` gate G1 established. Read-only status
(`getLatestValidationRun`, `listValidationFindings`) remains available even
when stopped, matching G1's `getConnectorStatus` precedent.

## Incident evidence

Every validation run and every finding is immutable (no `UPDATE`/`DELETE`
grant to `partner_connector_runtime` on either new table — enforced and
tested, mirroring G1's `partner_connector_events` pattern). A revalidation
never destroys the prior run's evidence of what was wrong.

## Operator permissions (G4 design — not built)

Deferred. `partner_connector_runtime` (the only role with DML on any
connector table) is not a human-facing role — G4A's internal operations
APIs will need to define the actual Super Admin permission model (reusing
the existing `requireAdmin` pattern per the brief), which doesn't exist yet
for connector-specific actions.
