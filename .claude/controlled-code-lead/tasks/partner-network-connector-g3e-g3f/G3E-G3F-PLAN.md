# Trusted Intake Connector — G3E–G3F Plan

Starting point: origin/main `990fed3c` (G1+G2+G3 merged). No G3E branch
existed anywhere before this pass.

## What G3's own single-transaction design already collapsed

G3D's `importValidatedConnector` deliberately performs reservation,
owner resolution, reference allocation, submission/item creation, mapping
completion, and the connector's `ready_for_import → importing → imported`
transition inside **one** database transaction. That design choice
(documented and independently reviewed in the G3 pass) already makes most
of the crash scenarios this brief lists **structurally unreachable**:

- A mapping stuck at `state = 'reserved'` with no destination, observable
  by another session, cannot happen — the reservation only ever becomes
  durable in the same COMMIT as its completion.
- A connector durably observable at `state = 'importing'` cannot happen —
  the same reasoning.
- "Completed mapping, destination missing" and "imported connector,
  mapping missing" can only occur via out-of-band corruption (a manual
  `DELETE`/`UPDATE`, a future bug, or a schema change that weakens a
  constraint) — never via an ordinary crash of the importer itself.

This is not a gap in G3E's job — it is exactly what the G3 design was
_for_. G3E's job here is threefold, and the plan below is organised around
that split rather than pretending every scenario the brief lists is
equally likely:

1. **Prove** the structurally-unreachable scenarios really are
   unreachable in normal operation (tested via deliberate corruption, the
   same technique G3's own tests already used for
   `needs_review_imported_without_mapping`), and build read-only
   detection + defensive recovery for them anyway, since "structurally
   unreachable given the current code" is not the same guarantee as
   "can never occur" — a future bug, a manual `psql` session, or a schema
   change could still produce one of these states, and an operator needs
   a safe way to detect and recover from it if it ever does.
2. **Fix a real, previously-undetected gap**: `claimConnectorRecord`/
   `claimNextConnectorRecord` (G1) only ever treat an expired lease on
   `claimed`/`validating` as reclaimable — a `ready_for_import` record
   whose claimant died before calling the importer is **permanently
   stuck**, with no existing recovery path. This is a genuine,
   reproducible bug (not a hypothetical), found during this pass's
   baseline audit, and is fixed as part of G3E-C.
3. **Build the genuinely reachable recovery scenarios**: duplicate
   retries (already handled by G3D's own early return — G3E adds a
   dedicated `recoverInterruptedImport` wrapper with reconciliation
   audit trail on top of it), expired claims (the real fix above), and
   manual-review escalation for anything a human needs to look at.

## Scope delivered this pass

- **G3E-A** — consistency inspector: `inspectConnectorConsistency`,
  `inspectImportMapping`, `inspectDestinationSubmission`,
  `inspectValidationChain`, `inspectConnectorEvidence`, plus
  `sweepConnectorLineageIntegrity` (a global, all-records invariant sweep
  — the only way to genuinely test "duplicate mapping"/"duplicate
  destination" detection, since the UNIQUE constraints prevent creating
  a real duplicate through the application; the sweep exists to catch a
  hypothetical future weakening of those constraints, and is proven by
  temporarily disabling a constraint in a test, not by finding a real
  duplicate in normal operation).
- **G3E-B / G3E-C** — reconciliation engine and recovery actions:
  `reconcileConnector` (orchestrator), `completeFromExistingDestination`,
  `recoverReservedImport`, `recoverExpiredImportClaim` (the real fix),
  `recoverInterruptedImport`, `markManualReview`, `resolveManualReview`,
  `acknowledgePermanentFailure`. Every action requires `actorId` +
  `reason`, writes an immutable `partner_connector_events` row, and never
  deletes or duplicate-creates anything.
- **Migration 0011** — widens `partner_connector_records.state` to permit
  `reconciliation_required` and `manual_review`.
- **G3F** — a real-Postgres, separate-connection concurrency/load test
  proving zero duplicate destinations under contention, including
  simulated expired-claim races and duplicate-retry storms. Explicitly
  **scaled down** from the brief's literal "100 connectors / 10 workers"
  — see the Load Test section below for the actual workload and the
  honest reason for the smaller scale (matching the same scoping honesty
  the G2 and G3 passes already established as this programme's norm).

## Scope explicitly NOT expanded into

- No G4 operations API or Admin UI — `reconcileConnector` and friends are
  plain exported TypeScript functions with no HTTP route, exactly like
  every G1–G3 service function. A future G4 pass would expose them.
- No Partner Portal mount, no flag flips, no deploy.
- No grading/certificate/label/payment/Stripe/email/Vault-Quest code.

## Implementation boundaries

- `shared/schema.ts`, `server/storage.ts`, `server/routes.ts`,
  `server/routes/submissions.ts` — not touched.
- `server/partner/connector-import-service.ts` — the existing
  `importValidatedConnector`, `getConnectorImport`,
  `getImportedDestination` are unchanged. The existing
  `inspectConnectorImportConsistency`/`ConsistencyStatus` (G3's own
  partial inspector) is superseded by the fuller G3E inspector in the new
  `connector-reconciliation-service.ts` — kept in place, unchanged, since
  it is still correct and still used by G3D's own tests; the new file
  does not duplicate its logic, it calls into the same underlying reads.
- `server/partner/connector-service.ts` — extended: two new states, two
  new hard-blocked generic-transition targets (mirroring `imported`/
  `importing`), and the real `claimConnectorRecord`/
  `claimNextConnectorRecord` fix.
- `server/partner/connector-errors.ts` — extended with the G3E error
  vocabulary.

## Migration

`migrations/0011_partner_connector_reconciliation.sql` — additive only,
widens one CHECK constraint. No new table: `partner_connector_imports`
already has `reconciled_at`/`last_safe_error_code` (granted UPDATE by
migration 0010, unused until now) — G3E is the first pass to actually
write them. Reconciliation action audit trail reuses the existing,
already-immutable `partner_connector_events` table (actor_id + metadata
JSON) rather than introducing a new event table.

## Test strategy

Real PostgreSQL, disposable clusters, no mocks-only coverage — same
posture as G1/G2/G3:

- `tests/partner-connector-reconciliation-migration.test.ts`
- `tests/partner-connector-reconciliation-service.test.ts`
- `tests/partner-connector-reconciliation-concurrency.test.ts`

## Checkpoint commits

Forward-only, explicit file staging, no `git add -A`, no amends, no
force-push:

1. `docs(partner-network): define connector G3E-G3F reconciliation architecture`
2. `feat(partner-network): add reconciliation state and consistency inspector`
3. `fix(partner-network): reclaim expired ready_for_import claims`
4. `feat(partner-network): add reconciliation engine and recovery actions`
5. `test(partner-network): cover G3E reconciliation and recovery`
6. `test(partner-network): cover G3F crash and concurrency proof`
7. review-fix commit(s) as needed

## Stop/go gates

Same posture as G1–G3: implement → focused real-DB tests green → `tsc`
clean → diff inspected → commit → independent review → fix material
findings → only then proceed. If any scenario in the brief turns out to
require an architecture decision with no safe repository-evidenced
answer, stop with `PARTNER CONNECTOR G3E–G3F BLOCKED — ARCHITECTURE
DECISION REQUIRED` rather than guessing.

## Merge criteria

Conflict-free trial merge, fresh-cluster full regression (G1–G3E all
green), zero new repository regressions (full-suite comparison against
pristine origin/main), secret scan clean, all flags OFF, nothing
deployed, no duplicate destination possible under any tested crash or
concurrency scenario, evidence never destroyed by any recovery action.
