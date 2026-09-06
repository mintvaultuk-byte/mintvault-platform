/**
 * Process lifecycle registry for graceful shutdown (Phase 3).
 *
 * Tracks every recurring/pending timer and the count of in-flight guarded jobs
 * so SIGTERM/SIGINT can, in order: mark shutting-down, stop accepting traffic,
 * cancel pending timers (so no NEW tick starts), drain active jobs/requests,
 * then close the DB pools — never closing a pool while a guarded job is still
 * using it. A hard deadline always forces exit. All operations are idempotent.
 */

type Cleanup = () => void;

let shuttingDown = false;
const cleanups = new Set<Cleanup>();
let activeJobs = 0;
let cancelled = false;
let shutdownStarted = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Register a cleanup (e.g. a timer clear). Returns an unregister fn. */
export function registerCleanup(fn: Cleanup): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

/** setInterval whose handle is auto-registered for shutdown cancellation. */
export function trackInterval(fn: () => void, ms: number, opts?: { unref?: boolean }): NodeJS.Timeout {
  const h = setInterval(fn, ms);
  if (opts?.unref) (h as { unref?: () => void }).unref?.();
  registerCleanup(() => clearInterval(h));
  return h;
}

/** setTimeout whose handle is auto-registered for shutdown cancellation. */
export function trackTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  const h = setTimeout(fn, ms);
  registerCleanup(() => clearTimeout(h));
  return h;
}

/** Idempotent: cancel all registered timers exactly once. */
export function cancelAllTimers(): void {
  if (cancelled) return;
  cancelled = true;
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* best effort — keep cancelling the rest */
    }
  }
  cleanups.clear();
}

export function beginJob(): void {
  activeJobs++;
}
export function endJob(): void {
  activeJobs = Math.max(0, activeJobs - 1);
}
export function activeJobCount(): number {
  return activeJobs;
}

/**
 * Refuse new background work after shutdown begins and keep an admitted job in
 * the drain count until its promise settles. The `finally` is the important
 * fault boundary: a rejected database/provider operation cannot leak the count.
 */
export async function runTrackedJob<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (isShuttingDown()) return undefined;
  beginJob();
  try {
    return await fn();
  } finally {
    endJob();
  }
}

export interface ShutdownDeps {
  /** stop accepting new connections and let in-flight requests finish */
  closeServer: () => Promise<void> | void;
  /** close the DB pools — only called once active jobs have drained */
  closePools: () => Promise<void> | void;
  exit: (code: number) => void;
  deadlineMs: number;
  /** poll interval (ms) while draining jobs; default 50 */
  drainPollMs?: number;
  /** injectable for tests */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

/**
 * Orchestrate graceful shutdown, idempotently:
 *   1. mark shutting-down  2. cancel pending timers (no new ticks)
 *   3. stop traffic + drain requests  4. wait for active guarded jobs to finish
 *   5. close pools  6. exit — with a hard deadline that always exits in time.
 */
export async function runGracefulShutdown(deps: ShutdownDeps): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const st = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const ct = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const drainPollMs = deps.drainPollMs ?? 50;

  beginShutdown();
  cancelAllTimers();

  let exited = false;
  const doExit = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  const deadline = st(() => doExit(0), deps.deadlineMs);
  (deadline as { unref?: () => void } | undefined)?.unref?.();

  try {
    await deps.closeServer();
    // Drain active guarded jobs BEFORE closing the pools they use.
    while (activeJobCount() > 0 && !exited) {
      await new Promise<void>((resolve) => {
        const t = st(() => resolve(), drainPollMs);
        (t as { unref?: () => void } | undefined)?.unref?.();
      });
    }
    if (!exited) {
      await deps.closePools();
    }
  } finally {
    ct(deadline);
    doExit(0);
  }
}

/** Test-only: reset module singletons between cases. */
export function __resetLifecycleForTests(): void {
  shuttingDown = false;
  cancelled = false;
  shutdownStarted = false;
  activeJobs = 0;
  cleanups.clear();
}
