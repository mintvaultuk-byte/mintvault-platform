# Trusted Intake Connector — G3F FINAL Plan

Starting point: origin/main `d5caf4f1` (G1+G2+G3+G3E merged). No G3F-final
branch existed anywhere before this pass; baseline 160 disposable-DB
connector tests all green before implementation, tsc clean.

## Why this pass exists

The prior G3F pass (merged in `d5caf4f1`) proved exactly-once and recovery
correctness at **small scale** (20 connectors, per-row contention storms of
5–8 callers). It explicitly disclosed — in the test's own header and in the
G3E-G3F final report — two open gaps this pass closes:

1. **No full-scale workload.** The brief's literal "100 validated
   connectors, 10 workers, realistic connection-pool contention, mixed
   valid/stale/interrupted workload, worker death and lost-response at
   scale" was never run.
2. **A documented provenance-accuracy limitation.** When a stale `reserved`
   mapping is safely resumed after revalidation, the immutable reservation
   row keeps the _earlier_ fingerprint audit fields — an audit-accuracy
   ambiguity (not an exactly-once failure) that RECONCILIATION-RUNBOOK.md
   flagged as "document or resolve in a later pass."

This pass resolves both, then declares the connector technically complete
(G1–G3F) so G4 (operations API/Admin UI) can begin on a proven base.

## Milestones (execution order)

- **G3F-1** — instrumentation + deterministic fault-injection hook module
  (`connector-instrumentation.ts`), a no-op in production.
- **G3F-2** — provenance evidence correction: append-only
  `partner_connector_import_attempts` table (migration 0012), wired into
  the importer + reconciliation. Resolves the fingerprint ambiguity by
  recording every committed attempt's own authorising validation-run +
  fingerprint as immutable history (approach C — see
  PROVENANCE-EVIDENCE-MODEL.md).
- **G3F-3** — bounded connector worker pool (`connector-worker.ts`): an
  N-worker runner over `claimNextConnectorRecord` + `importValidatedConnector`
  with fail-closed flag/emergency-stop checks, clean shutdown, bounded
  retry, guaranteed connection release (the existing `withConnectorTx`
  already does this in `finally`).
- **G3F-4** — full 100-record / 10-worker deterministic workload
  (`tests/partner-connector-scale.test.ts`).
- **G3F-5** — 20-point failure-injection + crash-recovery test
  (`tests/partner-connector-fault-injection.test.ts`).
- **G3F-6** — EXPLAIN query-plan / index verification against realistically
  seeded data; add hot-path index(es) only with planner evidence.
- **G3F-7** — seven independent read-only review panels.
- **G3F-8** — controlled merge review + merge + final report.

## Scope exclusions (hard)

No G4 HTTP API, no Admin UI, no Portal mount, no flag activation, no
deployment, no live migration, no grading/certificate/counter/label/
print/payment/Stripe/invoice/email/notification/webhook/Vault-Quest code,
no broad submission-system redesign, no unrelated refactoring.

## Workload composition (see LOAD-MODEL.md for exact numbers)

100 connectors: 70 valid, 10 stale-after-validation, 5 cancelled, 5
invalid/rejected, 5 expired-claim, 5 interrupted/reserved; plus duplicate
storms, post-commit retries, reclaim races, and lost-response simulations
layered on subsets. Multiple organisations/locations; repeated customer
identities across organisations (cross-tenant no-link proof); varied item
counts.

## Database topology

Fresh disposable local PostgreSQL 16 cluster per proof, realistic
non-superuser role model (`pn_migrator` applies; `partner_connector_runtime`
NOSUPERUSER/NOBYPASSRLS executes), representative MintVault
`users`/`submissions`/`submission_items` tables created as fixtures (the
real ones are db:push-managed, absent from `migrations/`).

## Worker + connection-pool model (see WORKER-POOL-DESIGN.md)

Reuses the existing `pg.Pool` in `connector-db.ts`. Pool `max` is set
explicitly per run (default 4, raised for the 10-worker proof). No
unbounded `Promise.all` over DB work in the worker runner; every worker
holds at most one in-flight transaction at a time; connections released in
`finally`. Bounded retry with deterministic backoff; lease renewal
available for long ops. Fail-closed on flag/emergency-stop.

## Instrumentation

`connector-instrumentation.ts`: a single module-level, test-only hook
registry (production default = null hook = one truthy check per labelled
point, zero behavioural change). Used for (a) deterministic fault injection
at labelled transaction points and (b) latency/observation capture. The
load harness additionally measures per-import wall time and pool-wait time
around each `importValidatedConnector` call, and reads the rest from the
DB (`partner_connector_events.created_at`, the new attempts table's
`started_at`/`completed_at`).

## Pass/fail gates (see FINAL-CONNECTOR-SAFETY-GATE.md)

Merge is authorised only if the literal 100/10 workload runs, the expected
destination and mapping counts match exactly, every reference is unique,
zero duplicate destination/mapping/completed-provenance, stale/cancelled/
invalid create no destination, duplicate+lost-response converge on the
original destination, expired claims recover, no permanently stuck lease,
no leaked client, no deadlock, pool saturation bounded, provenance
unambiguous, all material review findings fixed, zero new repo regression,
secret scan clean, all flags OFF, nothing deployed.

## Checkpoint commits

Forward-only, explicit staging, no `git add -A`, no amends, no force-push:

1. docs(partner-network): define final connector scale gate
2. feat(partner-network): add versioned import-attempt evidence
3. test(partner-network): prove provenance accuracy and append-only history
4. feat(partner-network): add bounded connector worker pool
5. test(partner-network): add 100-record concurrent workload
6. test(partner-network): add crash and timeout injection
7. perf(partner-network): verify and tune connector hot-path indexes
8. test(partner-network): complete final G3F hardening proof
9. fix(partner-network): resolve independent-review findings

## Independent review

Seven read-only panels: load-model correctness, worker-pool/connection
safety, exactly-once/concurrency, provenance/audit accuracy, crash/failure
injection, database performance/indexes, scope/regression.

## Merge conditions

Conflict-free trial merge against latest origin/main, fresh-cluster full
regression (G1–G3F green), full-suite comparison to pristine main (zero new
regressions), secret scan clean, all flags OFF, nothing deployed.
