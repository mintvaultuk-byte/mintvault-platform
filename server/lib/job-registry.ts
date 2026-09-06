import { isShuttingDown, runTrackedJob, trackInterval, trackTimeout } from "./lifecycle";

export interface JobDefinition {
  readonly name: string;
  readonly startup: "immediate" | "none" | { readonly delayMs: number };
  readonly everyMs?: number;
  readonly run: () => Promise<void>;
  readonly onError: (error: unknown) => void | Promise<void>;
}

// Node clamps overflowing/fractional/invalid timer delays. Reject instead of
// accidentally turning a maintenance interval into a hot loop.
function validDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

/** Process-local composition only: no persistence, distributed lock or new drain
 * authority. Callbacks retain their own business/locking/overlap policies.
 * Currently unused by application bootstrap pending callsite characterisation. */
export function createJobRegistry() {
  const installed = new Set<string>();

  return {
    install(definitions: readonly JobDefinition[]): void {
      const names = new Set(installed);
      // Snapshot and validate ALL definitions before launching work or timers.
      // Later mutation of the caller's objects cannot rewrite active schedules.
      const jobs = definitions.map((definition) => {
        const { name, startup, everyMs, run, onError } = definition;
        const delayMs = typeof startup === "object" && startup !== null ? startup.delayMs : undefined;
        if (
          typeof name !== "string" ||
          !/^[a-z][a-z0-9-]*$/.test(name) ||
          names.has(name) ||
          typeof run !== "function" ||
          typeof onError !== "function" ||
          (startup !== "immediate" && startup !== "none" && !validDelay(delayMs)) ||
          (everyMs !== undefined && !validDelay(everyMs)) ||
          (startup === "none" && everyMs === undefined)
        ) {
          throw new Error("Invalid or duplicate background job definition");
        }
        names.add(name);
        return Object.freeze({ name, immediate: startup === "immediate", delayMs, everyMs, run, onError });
      });

      if (isShuttingDown()) return;
      for (const job of jobs) installed.add(job.name);
      for (const job of jobs) {
        if (isShuttingDown()) break;
        const tick = () => {
          void runTrackedJob(async () => {
            try {
              await job.run();
            } catch (error) {
              await job.onError(error);
            }
          }).catch(() => {
            // A broken error reporter must not create an unhandled rejection.
            // Do not log arbitrary database/provider error content here.
            console.error(`[jobs] error reporter failed for ${job.name}`);
          });
        };
        if (job.immediate) tick();
        else if (job.delayMs !== undefined) trackTimeout(tick, job.delayMs);
        if (!isShuttingDown() && job.everyMs !== undefined) trackInterval(tick, job.everyMs);
      }
    },
  };
}
