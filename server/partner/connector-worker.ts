/**
 * Trusted Intake Connector — Phase G3F: bounded worker pool.
 *
 * A narrow runner that drives the EXISTING importer/claim services — it introduces no new database
 * access path and no new exactly-once mechanism; the database UNIQUE constraints on
 * partner_connector_imports remain the final control (see WORKER-POOL-DESIGN.md). Every DB touch goes
 * through claimNextConnectorRecord / importValidatedConnector, which use withConnectorTx (acquire +
 * release a pooled client in a finally). The runner never opens its own pool or raw client, never
 * shares one client across concurrent work, and never fans an unbounded Promise.all over DB calls:
 * it spawns exactly `workerCount` long-lived loops, each awaiting its operations sequentially.
 *
 * Fail-closed: claimNextConnectorRecord itself calls assertConnectorActive, so a flag-OFF /
 * emergency-stop surfaces as feature_disabled / emergency_stop on the next claim, which the runner
 * treats as "stop claiming" and exits cleanly (no new work taken). In-flight transactions are never
 * force-killed — they commit or roll back atomically.
 */
import { claimNextConnectorRecord } from "./connector-service";
import { importValidatedConnector } from "./connector-import-service";
import { ConnectorError } from "./connector-errors";

export interface WorkerPoolOptions {
  workerCount: number;
  leaseSeconds?: number;
  /** Bounded per-record retry for retryable failures. Default 3. */
  maxRetriesPerRecord?: number;
  /** Deterministic fixed backoff between retries (ms). Default 0 (no sleep). */
  backoffMs?: number;
  /** Optional cooperative stop — checked before each claim. */
  shouldStop?: () => boolean | Promise<boolean>;
}

export interface WorkerPoolResult {
  workers: number;
  claimed: number;
  imported: number;
  alreadyCompleted: number;
  stale: number;
  skippedNotReady: number;
  retries: number;
  stoppedEarly: boolean;
  failures: Array<{ connectorId: string; code: string }>;
  /**
   * Per-import wall-clock durations (ms), measured with a single monotonic clock (performance.now())
   * around each importValidatedConnector call — same clock source both ends, so accurate at sub-ms
   * scale (unlike subtracting a DB now() from a JS Date). One entry per import call attempt that
   * returned an outcome (imported / already_completed / stale).
   */
  importDurationsMs: number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `workerCount` concurrent workers until no claimable work remains (every worker's
 * claimNextConnectorRecord returns null) or a stop is requested. Returns aggregate counters.
 * Never throws for ordinary per-record failures — those are classified and recorded; it only
 * rejects on a genuinely unexpected non-ConnectorError bug.
 */
export async function runConnectorWorkerPool(opts: WorkerPoolOptions): Promise<WorkerPoolResult> {
  const { workerCount, leaseSeconds = 300, maxRetriesPerRecord = 3, backoffMs = 0, shouldStop } = opts;

  const result: WorkerPoolResult = {
    workers: workerCount,
    claimed: 0,
    imported: 0,
    alreadyCompleted: 0,
    stale: 0,
    skippedNotReady: 0,
    retries: 0,
    stoppedEarly: false,
    failures: [],
    importDurationsMs: [],
  };

  async function worker(workerIndex: number): Promise<void> {
    const workerId = `g3f-worker-${workerIndex}`;
    // Bounded retry budget shared across this worker's records: re-enqueue by simply looping and
    // re-claiming (the record's own lease/version guards make a re-claim safe); the per-record cap
    // below prevents an individual record from being retried unboundedly.
    for (;;) {
      if (shouldStop && (await shouldStop())) {
        result.stoppedEarly = true;
        return;
      }

      let rec;
      try {
        rec = await claimNextConnectorRecord(workerId, leaseSeconds);
      } catch (err) {
        // Fail-closed: a disabled flag / emergency stop stops this worker cleanly.
        if (err instanceof ConnectorError && (err.code === "feature_disabled" || err.code === "emergency_stop")) {
          result.stoppedEarly = true;
          return;
        }
        // A transient DB error on claim: record and stop this worker (do not spin).
        result.failures.push({ connectorId: "(claim)", code: err instanceof ConnectorError ? err.code : "unknown" });
        return;
      }
      if (rec == null) return; // no more claimable work
      result.claimed += 1;

      if (rec.state !== "ready_for_import") {
        // A record claimed but not validated (e.g. a fresh `queued` record). This proof seeds only
        // post-validation records, so this is not expected here; leave it claimed (its lease will
        // expire, making it reclaimable) rather than releasing it into a re-claim livelock.
        result.skippedNotReady += 1;
        continue;
      }

      let attempt = 0;
      for (;;) {
        try {
          const t0 = performance.now();
          const outcome = await importValidatedConnector({
            connectorId: rec.id,
            claimant: workerId,
            expectedVersion: rec.version,
            tenantId: rec.tenantId,
          });
          result.importDurationsMs.push(performance.now() - t0);
          if (outcome.outcome === "imported") result.imported += 1;
          else if (outcome.outcome === "already_completed") result.alreadyCompleted += 1;
          else if (outcome.outcome === "stale") result.stale += 1;
          break; // done with this record
        } catch (err) {
          const code = err instanceof ConnectorError ? err.code : "unknown";
          const retryable = err instanceof ConnectorError ? err.retryable : false;
          if (retryable && attempt < maxRetriesPerRecord) {
            attempt += 1;
            result.retries += 1;
            if (backoffMs > 0) await sleep(backoffMs);
            continue;
          }
          result.failures.push({ connectorId: rec.id, code });
          break; // non-retryable or budget exhausted — move on
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return result;
}
