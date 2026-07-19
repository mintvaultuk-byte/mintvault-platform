# Trusted Intake Connector — G3 Plan

Starting point: origin/main `045732e7` (G1+G2 merged). No G3 branch/worktree
existed anywhere before this pass (confirmed via `git branch -a` and
`git worktree list`).

## Scope delivered this pass

- **G3A** — safe destination prerequisites (owner resolution without the
  unsafe fallback; concurrency-safe reference allocation).
- **G3B** — import provenance schema (`partner_connector_imports`,
  `partner_connector_customer_links`).
- **G3C** — connector state model extension (`importing` state; reuses the
  existing claim/lease/version machinery unchanged).
- **G3D** — exactly-once importer (`importValidatedConnector` and its
  supporting functions).
- A real-Postgres test suite covering migration, ownership, reference
  concurrency, happy-path, exactly-once/duplicate-retry, stale-source, and
  forbidden-side-effect proofs.

## Scope explicitly deferred (documented, not built, this pass)

- **G3E full reconciliation service** — the state model and schema support it
  (`partner_connector_imports.state = 'reconciliation_required'`), and
  `RECONCILIATION-RUNBOOK.md` documents every scenario the brief lists, but
  only a narrow read-only inspection function is implemented
  (`inspectConnectorImportConsistency`) — enough to prove the crash-recovery
  test scenarios. The broader operator-facing reconcile/complete/mark actions
  are designed, not built.
- **G3F large-scale load test** — a real-Postgres concurrency test using
  separate connections proves exactly-once under contention (duplicate
  import attack, concurrent claimants, reference-allocation contention), but
  not at the brief's literal "100 connectors / 10 workers" scale. Scaled down
  and reported honestly, same posture G2 took for its own concurrency proof.
- **G4 operations API / Admin UI**, **G5 full adversarial programme, browser
  verification** — out of scope per the instruction itself; not started.

Rationale for this split: the brief's own execution order (G3A→G3F) already
separates "prove exactly-once creation works" from "build the operator
recovery tooling and prove it at scale" — the first is a hard architectural
correctness question that must be nailed down before anything else is safe
to build on top of it; the second is operational tooling that can follow in
a dedicated pass without weakening this one's guarantees. Building G3E/G3F to
the brief's full literal scope in the same pass as G3A-D would repeat the
"uncontrolled implementation dump" failure mode the instruction explicitly
warns against.

## Implementation boundaries (unchanged from G1/G2 posture, extended)

- `shared/schema.ts` — **not touched**. The importer writes to `submissions`/
  `submission_items`/`users` via direct parameterised SQL inside
  `connector-import-service.ts`, not through Drizzle's schema objects or
  `storage.ts`'s existing methods — see `DESTINATION-BOUNDARY.md` for why.
- `server/storage.ts` — **not touched**. Existing `createSubmission`/
  `addSubmissionItems`/`getNextSubmissionId` (including the known `userId`
  COALESCE-fallback bug and the COUNT-based tracking-number race) are left
  exactly as they are for their existing (checkout) caller. G3 does not fix
  the general bug — it never calls into that code path at all, so it cannot
  be affected by it and cannot regress it either.
- `server/routes/submissions.ts`, grading, certificate, label, print-batch,
  payment, Stripe, email, Vault Quest code — **not touched**.
- `partner_portal_enabled` / `partner_connector_enabled` — remain OFF
  (verified by grep, same proof pattern as G1/G2).

## Migrations

One new forward migration, `migrations/0010_partner_connector_import.sql`
(next number after 0009). Additive only: two new tables, new grants on
`partner_connector_runtime` (read on Partner source tables it doesn't
already have, INSERT-only on the new mapping tables, and new — carefully
scoped — INSERT/SELECT on `users`/`submissions`/`submission_items`, the
MintVault-internal tables it must now write to). A paired
`rollback-partner-connector-g3.sql`, plus updates to the comprehensive
`rollback-partner-network-phase1.sql`.

## Services

- `server/partner/connector-owner-resolution.ts` — deterministic Partner
  customer → MintVault user resolution (G3A risk 2 fix).
- `server/partner/connector-reference.ts` — concurrency-safe destination
  reference allocation (G3A risk 3 fix).
- `server/partner/connector-import-service.ts` — the exactly-once importer
  (G3D) plus the narrow reconciliation inspector (G3E, partial).
- `server/partner/connector-service.ts` — extended (not rewritten): new
  `importing` state, `LEGAL_TRANSITIONS` entries, hard hard-block on
  `toState === "imported"` is **relaxed only inside the new importer's own
  dedicated transition call**, which lives in `connector-import-service.ts`
  and is the one and only place in the codebase allowed to write `imported`.
- `server/partner/connector-errors.ts` — extended with the import-specific
  error codes.

## Tests (real PostgreSQL, disposable cluster — no mocks-only coverage)

- `tests/partner-connector-import-migration.test.ts`
- `tests/partner-connector-owner-resolution.test.ts`
- `tests/partner-connector-reference.test.ts`
- `tests/partner-connector-import-service.test.ts`
- `tests/partner-connector-import-concurrency.test.ts`

## Independent reviews

Five read-only reviewer panels (matching the brief's six, minus a standalone
"reconciliation" panel since G3E is only partially built this pass — folded
into the exactly-once/database-security reviews instead):
destination-boundary, customer/ownership, exactly-once architecture,
database security, scope/regression.

## Checkpoint commits

Forward-only, explicit file staging, no `git add -A`, no amends, no
force-push:

1. `docs(partner-network): define connector G3 intake architecture`
2. `fix(partner-network): add safe internal owner and reference prerequisites`
3. `feat(partner-network): add connector import provenance schema`
4. `feat(partner-network): add exactly-once intake importer`
5. `test(partner-network): cover G3 import idempotency and side effects`
6. `test(partner-network): cover G3 crash recovery and concurrency`
7. review-fix commit(s) as needed, forward-only

## Stop/go gates

Same posture as G2: implement → focused real-DB tests green → `tsc` clean →
diff inspected → commit → independent review → fix material findings →
only then proceed to the next milestone. If any architecture decision gate
cannot be resolved from repository evidence, stop with
`PARTNER CONNECTOR G3 BLOCKED — ARCHITECTURE DECISION REQUIRED` rather than
guessing.

## Merge criteria

Same as the brief's Controlled Merge Review section — conflict-free trial
merge, fresh-cluster full regression, zero new repository regressions,
secret scan clean, all flags OFF, nothing deployed, one connector maps to at
most one destination, one handoff maps to at most one destination, stale
source cannot import, retries/timeouts return the existing destination,
partial-transaction failures create no partial destination.
