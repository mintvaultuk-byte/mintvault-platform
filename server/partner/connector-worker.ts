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

/** Test-only injection seam for the claim function (defaults to the real claimNextConnectorRecord). */
type ClaimFn = (
  claimant: string,
  leaseSeconds?: number
) => Promise<Awaited<ReturnType<typeof claimNextConnectorRecord>>>;

export interface WorkerPoolOptions {
  workerCount: number;
  leaseSeconds?: number;
  /** Bounded per-record retry for retryable import failures. Default 3. */
  maxRetriesPerRecord?: number;
  /** Deterministic fixed backoff between import retries (ms). Default 0 (no sleep). */
  backoffMs?: number;
  /** Bounded retry for TRANSIENT claim errors (transient DB error, claim contention). Default 3. */
  maxClaimRetries?: number;
  /** Deterministic fixed backoff between claim retries (ms). Default 0. */
  claimBackoffMs?: number;
  /** Optional cooperative stop — checked before each claim attempt. */
  shouldStop?: () => boolean | Promise<boolean>;
  /** TEST-ONLY. Overrides the claim function to inject deterministic transient/permanent errors. */
  _claimFn?: ClaimFn;
}

export interface WorkerPoolResult {
  workers: number;
  claimed: number;
  imported: number;
  alreadyCompleted: number;
  stale: number;
  skippedNotReady: number;
  retries: number;
  /** Number of TRANSIENT claim errors that were retried (not permanent worker exits). */
  claimRetries: number;
  /** Number of workers that exhausted their bounded claim-retry budget on transient errors. */
  claimRetryExhaustions: number;
  stoppedEarly: boolean;
  failures: Array<{ connectorId: string; code: string; kind: "transient" | "permanent" }>;
  /**
   * Per-import wall-clock durations (ms), measured with a single monotonic clock (performance.now())
   * around each importValidatedConnector call — same clock source both ends, so accurate at sub-ms
   * scale (unlike subtracting a DB now() from a JS Date). One entry per import call attempt that
   * returned an outcome (imported / already_completed / stale).
   */
  importDurationsMs: number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Coerce to a finite non-negative integer; any non-finite / negative / malformed value falls back. */
function finiteNonNegInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Runs `workerCount` concurrent workers until no claimable work remains (every worker's
 * claim returns null) or a stop is requested. Returns aggregate counters.
 *
 * Claim errors are CLASSIFIED, not blindly fatal:
 *  - feature_disabled / emergency_stop → the worker stops cleanly (fail-closed, no new claim).
 *  - shutdown (shouldStop) → the worker stops within one claim cycle.
 *  - transient (retryable ConnectorError — transient_database_error, stale_claim/contention) →
 *    bounded retry with bounded backoff; a recovered transient error does NOT permanently shrink
 *    the pool. On exhaustion the worker exits with a recorded transient exhaustion.
 *  - permanent (non-retryable, non-flag error) → the worker exits safely with a recorded permanent
 *    failure; it is NOT retried forever.
 * Import transaction semantics are unchanged; this only governs the claim loop.
 */
export async function runConnectorWorkerPool(opts: WorkerPoolOptions): Promise<WorkerPoolResult> {
  const { workerCount, shouldStop } = opts;
  const leaseSeconds = finiteNonNegInt(opts.leaseSeconds, 300);
  const maxRetriesPerRecord = finiteNonNegInt(opts.maxRetriesPerRecord, 3);
  const backoffMs = finiteNonNegInt(opts.backoffMs, 0);
  const maxClaimRetries = finiteNonNegInt(opts.maxClaimRetries, 3);
  const claimBackoffMs = finiteNonNegInt(opts.claimBackoffMs, 0);
  const claimFn: ClaimFn = opts._claimFn ?? claimNextConnectorRecord;

  const result: WorkerPoolResult = {
    workers: workerCount,
    claimed: 0,
    imported: 0,
    alreadyCompleted: 0,
    stale: 0,
    skippedNotReady: 0,
    retries: 0,
    claimRetries: 0,
    claimRetryExhaustions: 0,
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
      // ---- Claim with bounded transient retry (Blocker 4 fix) ----
      let rec: Awaited<ReturnType<ClaimFn>>;
      let claimAttempt = 0;
      for (;;) {
        // Shutdown / emergency stop take precedence over any retry.
        if (shouldStop && (await shouldStop())) {
          result.stoppedEarly = true;
          return;
        }
        try {
          rec = await claimFn(workerId, leaseSeconds);
          break; // successful claim (rec may be null = no work)
        } catch (err) {
          const code = err instanceof ConnectorError ? err.code : "unknown";
          // Fail-closed: a disabled flag / emergency stop stops this worker cleanly.
          if (code === "feature_disabled" || code === "emergency_stop") {
            result.stoppedEarly = true;
            return;
          }
          // Classify: retryable ConnectorError (transient DB error / claim contention) → bounded
          // retry so a recoverable blip does NOT permanently shrink the pool. An unknown
          // (non-ConnectorError) error is treated as transient (conservative). Non-retryable
          // ConnectorError → permanent, exit safely without spinning.
          const transient = err instanceof ConnectorError ? err.retryable : true;
          if (transient && claimAttempt < maxClaimRetries) {
            claimAttempt += 1;
            result.claimRetries += 1;
            // The failed claim already released its pooled client (withConnectorTx finally); back off.
            if (claimBackoffMs > 0) await sleep(claimBackoffMs);
            continue; // re-check shouldStop, then re-claim
          }
          if (transient) {
            result.claimRetryExhaustions += 1;
            result.failures.push({ connectorId: "(claim)", code, kind: "transient" });
          } else {
            result.failures.push({ connectorId: "(claim)", code, kind: "permanent" });
          }
          return; // exit this worker safely (bounded — never an infinite claim loop)
        }
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
          result.failures.push({ connectorId: rec.id, code, kind: retryable ? "transient" : "permanent" });
          break; // non-retryable or budget exhausted — move on
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return result;
}
