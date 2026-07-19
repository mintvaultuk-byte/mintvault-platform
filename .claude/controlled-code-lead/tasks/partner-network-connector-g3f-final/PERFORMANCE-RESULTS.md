# Trusted Intake Connector — G3F Performance Results

Actual observed numbers from the final fresh-cluster runs on the test
machine (local disposable PostgreSQL 16, Homebrew, Apple Silicon). No claim
is made about production-scale or managed-Postgres (Neon) behaviour beyond
what was measured locally.

## Test environment

- PostgreSQL 16.13 (Homebrew), local disposable cluster, unix socket + TCP loopback.
- Connector pool `max` = 12; workers = 10; claim lease = 120s (scale run).
- Deterministic seed (fixed integer sequence; no `Math.random`, no wall-clock in ids).
- statement/lock/acquire timeouts unset in the correctness run; set only in the fault run.

## 100-record / 10-worker workload (tests/partner-connector-scale.test.ts)

Seeded population (exactly matching LOAD-MODEL.md): 100 connectors = 70 valid

- 5 expired-claim + 5 interrupted + 10 stale + 5 cancelled + 5 rejected, across
  5 organisations / 2–3 locations each.

| Metric                                                              | Observed                    |
| ------------------------------------------------------------------- | --------------------------- |
| Destination submissions                                             | 80 (== importable count)    |
| Completed import mappings                                           | 80                          |
| Completed provenance attempt rows                                   | 80                          |
| Unique tracking references                                          | 80 distinct / 80 total      |
| Duplicate destinations / mappings / references / completed-evidence | 0 / 0 / 0 / 0               |
| Connectors reaching `imported`                                      | 80                          |
| Stale connectors → `validating`, 0 destinations                     | 10                          |
| Cancelled / rejected creating destinations                          | 0                           |
| Permanently stuck (abandoned expired) leases after run              | 0                           |
| Unexpected `manual_review` rows                                     | 0                           |
| Orphan submission_items                                             | 0                           |
| Worker-reported failures                                            | 0                           |
| Worker retries                                                      | 0                           |
| Deadlocks                                                           | 0                           |
| Total wall-clock (worker pool run)                                  | ~78 ms                      |
| Per-import duration min / median / p95 / max                        | ~2.7 / 6.0 / 14.2 / 14.9 ms |

Durations measured with a single monotonic clock (`performance.now()`) around
each `importValidatedConnector` call in the worker (`WorkerPoolResult.importDurationsMs`)
— same clock source both ends, accurate at sub-ms scale.

### Pool-wait

In the correctness run the pool is sized (12) ≥ workers (10), so pool-wait is
effectively zero (no client contention) — confirmed by total elapsed (~78 ms
for 90 processed records across 10 workers). Bounded pool-wait under genuine
saturation is proven separately by the pool-saturation fault test (pool max 1 +
a 200 ms acquisition timeout): excess concurrent callers reject with a bounded
acquisition error rather than hanging, and the pool works normally afterward.

## Failure-injection run (tests/partner-connector-fault-injection.test.ts)

18 assertions, all green. Nine transaction-rollback points, genuine
mid-transaction backend termination (`pg_terminate_backend` on the importer's
own connection), `statement_timeout` (150 ms) aborting a slow in-transaction
statement, `lock_timeout` (200 ms) on a blocked `FOR UPDATE`, pool saturation,
lost-response idempotency, worker-death reclaim, stale-source routing, and
emergency-stop / flag-OFF fail-closed. Every fault left zero partial
destination and a working pool.

## EXPLAIN / index findings (tests/partner-connector-query-plan.test.ts)

Dataset: 2000 connector records, 95% terminal `imported`, ~5% claimable (a
realistic steady-state queue), plus 2000 validation runs / imports / attempts /
customer links.

**Claim-next query — the one hot-path gap found and fixed.** The G3E fix
broadened the claim query's claimable set to include `validating` /
`ready_for_import` expired-lease rows, but the 0008 partial index only covered
`queued` / `claimed`.

- **Before (0008 index):** `Seq Scan on partner_connector_records` — reads ALL
  2000 rows (incl. every terminal `imported` row) + a Sort. Catastrophic at
  millions of terminal rows.
- **After (migration 0013:** `idx_partner_connector_records_claimable ON
(created_at) WHERE state IN ('queued','claimed','validating','ready_for_import')`)**:**
  `Bitmap Heap Scan` via the index, reading only the ~150-row claimable subset —
  the terminal rows are never touched. No `Seq Scan on partner_connector_records`.

Migration 0013 REPLACES the old index (drop+recreate under the canonical name)
so exactly one claimable index exists with the correct, complete predicate — no
redundant index. The predicate uses only immutable state values (not
`claim_expires_at < now()`, which is STABLE and illegal in a partial-index
predicate).

**All other hot-path queries already used their intended indexes (no change,
no redundant index added):**

| Query                         | Index used                                         | Seq Scan on large table? |
| ----------------------------- | -------------------------------------------------- | ------------------------ |
| import mapping by connector   | `uq_partner_connector_imports_connector`           | No                       |
| import mapping by handoff     | `uq_partner_connector_imports_handoff`             | No                       |
| import mapping by destination | `uq_partner_connector_imports_destination`         | No                       |
| latest validation run         | `idx_partner_connector_validation_runs_record`     | No                       |
| customer-link resolution      | `uq_partner_connector_customer_links_org_customer` | No                       |
| provenance attempt history    | `idx_partner_connector_import_attempts_connector`  | No                       |
| completed-attempt lookup      | `uq_partner_connector_import_attempts_completed`   | No                       |

Index changes were made ONLY where EXPLAIN evidence justified them; no index was
added speculatively, and the dataset (2000 rows) is large enough to make the
planner's index-vs-seq-scan choice meaningful (a tiny table would always prefer
seq scan and hide the gap).
