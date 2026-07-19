# Trusted Intake Connector — G3F Performance Results

> Populated with ACTUAL observed numbers from the final fresh-cluster run
> (not estimates). All figures are from a single local disposable
> PostgreSQL 16 cluster on the test machine; no claim is made about
> production-scale or managed-Postgres behaviour beyond what was measured.

_(This file is filled in during G3F-4 / G3F-6 after the load test and
EXPLAIN runs complete. Until then it is intentionally a template — the
merge gate requires this file to contain real numbers before merge.)_

## Test environment

- To be recorded: PostgreSQL version, machine, pool `max`, worker count,
  lease seconds, statement/lock/acquire timeouts, deterministic seed.

## Workload actually run

- Total seeded connectors, per-category counts (vs LOAD-MODEL.md expectations).

## Exactly-once outcome counts

- Destinations, completed mappings, completed attempt rows, unique
  references, duplicate destinations/mappings/references (expect 0 each).

## Timings (actual)

- Total elapsed.
- Import duration: min / median / p95 / max.
- Pool-wait: min / median / p95 / max.
- Retries, lease renewals, reconciliations, claim conflicts, reference
  conflicts, deadlocks (expect 0), pool-acquisition timeouts.

## EXPLAIN / index findings

- Per hot-path query: plan node used (Index Scan vs Seq Scan), index name,
  row estimate, and whether an index change was justified + added.
