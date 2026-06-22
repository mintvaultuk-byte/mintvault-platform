/**
 * In-process concurrency limiter for the heavy backgrounded scan pipeline
 * (sharp deskew/variants + AI grading). Fix A makes the ingest RESPONSE
 * immediate, but the heavy work still runs per scan — and on the single shared
 * vCPU a burst of pair-scans firing several pipelines AT ONCE saturates CPU +
 * the DB connection pool (slow reads, intermittent 500s, a 300s no-reply). This
 * queue makes a burst QUEUE instead of pile on: at most SCAN_PIPELINE_CONCURRENCY
 * jobs run at a time (default 1). It's a plain in-process queue — NOT a new
 * service. The foreground ingest response is unaffected; only the already-async
 * background work serializes.
 */

const MAX = (() => {
  const n = parseInt(process.env.SCAN_PIPELINE_CONCURRENCY || "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
})();

let running = 0;
const waiting: Array<() => void> = [];

function pump(): void {
  while (running < MAX && waiting.length > 0) {
    const start = waiting.shift()!;
    running++;
    start();
  }
}

/**
 * Queue a background job and resolve when it completes. FIFO; at most MAX run
 * concurrently. Use this when the caller needs to await completion (e.g. the
 * reconciler's sequential re-drive). Rejects if the job throws.
 */
export function runScanJob<T>(job: () => Promise<T>, label = ""): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    };
    waiting.push(start);
    if (running >= MAX) {
      console.log(`[scan-queue] queued ${label} (running=${running}/${MAX}, waiting=${waiting.length})`);
    }
    pump();
  });
}

/**
 * Fire-and-forget variant — queue a background job, never throw into the caller
 * (failures are logged). Used by the scan-ingest handler so the response path is
 * never blocked or rejected by background work.
 */
export function enqueueScanJob(job: () => Promise<void>, label = ""): void {
  runScanJob(job, label).catch((e: any) => console.error(`[scan-queue] job ${label} failed: ${e?.message ?? e}`));
}

/** Current queue state — for diagnostics. */
export function scanQueueStats(): { running: number; waiting: number; max: number } {
  return { running, waiting: waiting.length, max: MAX };
}
