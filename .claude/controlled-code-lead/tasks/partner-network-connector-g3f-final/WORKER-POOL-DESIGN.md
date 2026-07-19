# Trusted Intake Connector — G3F Worker-Pool Design

Implemented in `server/partner/connector-worker.ts`. A bounded runner that
drives the EXISTING importer/reconciliation services — it introduces no new
database access path and no new exactly-once mechanism; the database UNIQUE
constraints remain the final control.

## Connection model

- **Uses the existing `pg.Pool`** from `server/partner/connector-db.ts`
  (created via `PARTNER_CONNECTOR_DATABASE_URL`, `max` from
  `PARTNER_CONNECTOR_DB_POOL_MAX ?? 4`). The worker runner does NOT open its
  own pool or clients — every DB touch goes through `importValidatedConnector`
  / `claimNextConnectorRecord`, which use `withConnectorTx`/`connectorQuery`,
  which acquire-and-release a pooled client inside a `try/finally`.
- **Worker-to-connection relationship**: each worker performs at most one
  connector operation at a time (claim, then import), and each operation
  holds at most one pooled client for its duration. So N concurrent workers
  hold at most N clients concurrently. With `max` ≥ N, no worker starves;
  with `max` < N, excess workers block in node-postgres's internal pool
  queue (bounded, observable via the harness's pool-wait measurement) — no
  client leak, no unbounded growth.
- **No unbounded `Promise.all` over DB work**: the runner spawns exactly N
  long-lived worker loops (`Promise.all` over N thunks, N fixed and small),
  each of which `await`s its operations sequentially. It never fans out one
  `Promise.all` over M>pool DB calls.
- **No single `pg.Client` used concurrently**: the runner never touches a
  raw client; the pool hands each `withConnectorTx` call its own client.

## Worker loop

Each of the N workers runs:

```
while (running):
  rec = claimNextConnectorRecord(workerId, leaseSeconds)   // FOR UPDATE SKIP LOCKED
  if rec == null: break                                    // no more claimable work
  try:
    if rec.state == 'ready_for_import':
      importValidatedConnector({connectorId, claimant: workerId, expectedVersion, ...})
    else:
      # a reclaimed 'claimed' record (was mid-validation): release it back for the
      # normal validate→ready path — the worker does not itself validate in this proof
      releaseConnectorClaim(...)   # or record a skip
  catch e:
    classify(e): retryable -> bounded re-enqueue; non-retryable -> record + move on
  # loop continues; the whole run ends when every worker sees claim==null
```

`claimNextConnectorRecord` already: claims `queued` or expired-lease
`claimed`/`validating`/`ready_for_import` rows via `FOR UPDATE SKIP LOCKED`
(two workers never claim the same row); preserves `ready_for_import` state
on reclaim (the G3E fix) so the reclaiming worker can import directly.

## Bounds and timeouts

| Concern                | Mechanism                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Max active connections | pool `max` (explicit per run)                                                                                        |
| Acquisition timeout    | node-postgres `connectionTimeoutMillis` (set on the pool; bounded, throws on exhaustion rather than hanging)         |
| Statement timeout      | `statement_timeout` set per-session in `withConnectorTx` (bounded)                                                   |
| Lock timeout           | `lock_timeout` set per-session in `withConnectorTx` (bounded; a blocked `FOR UPDATE` fails fast rather than hanging) |
| Retry count            | bounded per record (default 3) in the worker loop                                                                    |
| Backoff                | deterministic fixed delay in test (correctness does not need jitter; production could add it)                        |
| Deadlock retry         | a Postgres deadlock (SQLSTATE 40P01) is classified retryable and re-enqueued within the bound                        |
| Connection release     | guaranteed by `withConnectorTx`'s `finally { client.release() }` (pre-existing, unchanged)                           |

The `statement_timeout`/`lock_timeout`/`connectionTimeoutMillis` settings
are **additive, opt-in via env** (`PARTNER_CONNECTOR_STATEMENT_TIMEOUT_MS`,
`PARTNER_CONNECTOR_LOCK_TIMEOUT_MS`, `PARTNER_CONNECTOR_ACQUIRE_TIMEOUT_MS`)
so production behaviour is unchanged unless explicitly configured, while the
tests can set them to prove bounded-failure behaviour.

## Fail-closed / shutdown

- Before claiming, each worker (and `claimNextConnectorRecord` itself, via
  `assertConnectorActive`) checks the connector feature flag + emergency
  stop. Flag OFF or emergency stop ON → no new claim (the claim call throws
  `feature_disabled`/`emergency_stop`, which the runner treats as "stop
  claiming").
- The runner exposes `stop()` / an `AbortSignal`: on stop it sets
  `running = false`; workers finish their current in-flight operation
  (which either commits or rolls back atomically — never a partial
  destination) and then exit. No new claims are taken after stop.
- No in-flight transaction is force-killed by the runner; it lets
  `withConnectorTx` complete or roll back naturally.

## Stuck-worker detection / observability

The runner returns an aggregate result: per-worker processed count,
per-outcome counts, retry count, and (via the harness) timing percentiles.
A "stuck" record is detectable post-run by the G3E inspectors
(`inspectConnectorConsistency` flags an expired claim; the load test asserts
zero such rows after the run) — the runner itself does not poll for stuck
workers (that would be a scheduler, out of scope), it simply guarantees it
never leaves one stuck by design (bounded retry, guaranteed release, lease
that another worker can reclaim).
