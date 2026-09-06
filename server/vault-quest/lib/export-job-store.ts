/**
 * Durable Vault Quest export-job STORE (INFRA-01 / OPEN-27), Phase 10A-1.
 *
 * The in-process JOBS Map in export-jobs.ts fails ~50% of the time on the
 * 2-machine Fly prod: the browser POSTs to machine A (which renders + holds the
 * temp file), then polls/downloads and the load balancer routes to machine B,
 * which has never heard of the job → 404. This store moves job STATE into the
 * shared Postgres `vq_export_jobs` table and the output BYTES into shared R2
 * (`vq/exports/{jobId}/…`), so poll + download succeed from ANY machine — the
 * same fix already shipped for magic-links.
 *
 * Missing schema returns a typed `unavailable` signal. The facade refuses with
 * 503; it never substitutes process-local state. No runtime schema mutation.
 *
 * The pure state/idempotency/key decisions live in ./export-job-state.ts and are
 * unit-tested there; this module is the thin DB+R2 adapter around them.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { vqExportJobs, type VqExportJob } from "@shared/vq-export-schema";
import { isUndefinedTableOrColumn } from "../production-storage";
import {
  computeExportIdempotencyKey,
  decideExportOutcome,
  exportOutputKey,
  type ExportCounts,
} from "./export-job-state";

/** How long a finished export stays downloadable before the cleanup sweep may
 *  expire it. */
export const EXPORT_TTL_MS = 20 * 60 * 1000;

/** Bound on requeue attempts (defence-in-depth alongside the CHECK on the column). */
export const MAX_EXPORT_ATTEMPTS = 3;

/** Distinguish unavailable durable authority (503) from a genuinely absent job (404). */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: "unavailable" | "not_found" | "conflict" };

const UNAVAILABLE = { ok: false, reason: "unavailable" } as const;

/** Run a query that may hit the not-yet-migrated table; signal `unavailable` on
 *  42P01 rather than pretending a durable operation succeeded. */
async function guard<T>(fn: () => Promise<T>): Promise<StoreResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    // 42P01 (table absent) OR 42703 (partial migration — table present, 0012 columns
    // absent) → typed refusal; no assumption about any deployed schema state.
    if (isUndefinedTableOrColumn(err)) return UNAVAILABLE;
    throw err;
  }
}

const isUniqueViolation = (err: unknown): boolean => {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
};

/**
 * Create a queued job, or return the already-active job for the same
 * (kind, owner, id-set). The partial-unique index makes exactly one active job
 * the winner; a concurrent duplicate POST loses the 23505 race and re-reads the
 * winner. `deduped` tells the caller no new work was started.
 */
export async function createOrGetExportJob(
  kind: "pack" | "proxy",
  ownerAdminId: string,
  ids: string[],
  nowMs: number
): Promise<StoreResult<{ job: VqExportJob; deduped: boolean }>> {
  const idempotencyKey = computeExportIdempotencyKey(kind, ownerAdminId, ids);
  const expiresAt = new Date(nowMs + EXPORT_TTL_MS);

  const findActive = async (): Promise<VqExportJob | undefined> => {
    const rows = await db
      .select()
      .from(vqExportJobs)
      .where(
        and(eq(vqExportJobs.idempotencyKey, idempotencyKey), sql`${vqExportJobs.state} IN ('queued','processing')`)
      )
      .limit(1);
    return rows[0];
  };

  return guard(async () => {
    const existing = await findActive();
    if (existing) return { job: existing, deduped: true };
    try {
      const [job] = await db
        .insert(vqExportJobs)
        .values({
          kind,
          ownerAdminId,
          idempotencyKey,
          state: "queued",
          ids,
          requestedCount: ids.length,
          expiresAt,
        })
        .returning();
      return { job, deduped: false };
    } catch (err) {
      // Lost the partial-unique race with a concurrent POST — re-read the winner.
      if (isUniqueViolation(err)) {
        const winner = await findActive();
        if (winner) return { job: winner, deduped: true };
      }
      throw err;
    }
  });
}

/**
 * Atomically claim a queued job for this machine (queued→processing), taking a
 * lease and bumping attempt_count. Returns the claimed row, or `conflict` if
 * some other worker already claimed it (the UPDATE matched zero rows).
 */
export async function claimExportJob(
  jobId: string,
  workerMachine: string,
  leaseMs: number,
  nowMs: number
): Promise<StoreResult<VqExportJob>> {
  const leaseExpiresAt = new Date(nowMs + leaseMs);
  const res = await guard(async () => {
    const [row] = await db
      .update(vqExportJobs)
      .set({
        state: "processing",
        workerMachine,
        leaseExpiresAt,
        startedAt: new Date(nowMs),
        attemptCount: sql`${vqExportJobs.attemptCount} + 1`,
      })
      .where(and(eq(vqExportJobs.jobId, jobId), eq(vqExportJobs.state, "queued")))
      .returning();
    return row;
  });
  if (!res.ok) return res;
  return res.value ? { ok: true, value: res.value } : { ok: false, reason: "conflict" };
}

/** Read a job by its public jobId (uuid). `not_found` distinguishes a migrated-but-absent
 *  job from an unmigrated table (`unavailable`). */
export async function getExportJobByPublicId(jobId: string): Promise<StoreResult<VqExportJob>> {
  const res = await guard(async () => {
    const [row] = await db.select().from(vqExportJobs).where(eq(vqExportJobs.jobId, jobId)).limit(1);
    return row;
  });
  if (!res.ok) return res;
  return res.value ? { ok: true, value: res.value } : { ok: false, reason: "not_found" };
}

/** Throttled progress write during a long render (state stays `processing`). Best-effort:
 *  a failed progress write must never abort the render, so unavailability is swallowed. */
export async function updateExportProgress(
  jobId: string,
  counts: { completed: number; skipped: number; failed: number }
): Promise<void> {
  await guard(async () => {
    await db
      .update(vqExportJobs)
      .set({ completedCount: counts.completed, skippedCount: counts.skipped, failedCount: counts.failed })
      .where(and(eq(vqExportJobs.jobId, jobId), eq(vqExportJobs.state, "processing")));
  }).catch(() => undefined);
}

export interface ExportOutput {
  outputKey: string;
  outputHash: string;
  outputSize: number;
  contentType: string;
  fileName: string;
}

/**
 * Finish a processing job. The terminal state is DERIVED from counts by the pure
 * decideExportOutcome — a partial export can never be mislabelled `completed`.
 * `completed`/`partial` require an output; `failed` clears any output pointer.
 */
export async function finishExportJob(
  jobId: string,
  counts: ExportCounts,
  output: ExportOutput | null,
  nowMs: number
): Promise<StoreResult<VqExportState>> {
  const outcome = decideExportOutcome(counts);
  const persistOutput = outcome !== "failed" && output;
  return guard(async () => {
    await db
      .update(vqExportJobs)
      .set({
        state: outcome,
        completedCount: counts.completed,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        outputKey: persistOutput ? output.outputKey : null,
        outputHash: persistOutput ? output.outputHash : null,
        outputSize: persistOutput ? output.outputSize : null,
        contentType: persistOutput ? output.contentType : null,
        fileName: persistOutput ? output.fileName : null,
        completedAt: new Date(nowMs),
        leaseExpiresAt: null,
      })
      .where(and(eq(vqExportJobs.jobId, jobId), eq(vqExportJobs.state, "processing")));
    return outcome;
  });
}

/** Cancel a still-queued job (queued→cancelled) — used when a freshly-created job
 *  can't be run right now (per-machine concurrency limit) and there is no scheduler
 *  to pick it up later, so we retire it cleanly instead of leaving it stuck. */
export async function cancelExportJob(jobId: string, errorMessage: string, nowMs: number): Promise<StoreResult<void>> {
  return guard(async () => {
    await db
      .update(vqExportJobs)
      .set({
        state: "cancelled",
        errorCode: "cancelled",
        errorMessage: errorMessage.slice(0, 500),
        completedAt: new Date(nowMs),
      })
      .where(and(eq(vqExportJobs.jobId, jobId), eq(vqExportJobs.state, "queued")));
  });
}

/** Mark a processing job failed with a machine-stable code and a safe message
 *  (never a path or secret). */
export async function failExportJob(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  nowMs: number
): Promise<StoreResult<void>> {
  return guard(async () => {
    await db
      .update(vqExportJobs)
      .set({
        state: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        completedAt: new Date(nowMs),
        leaseExpiresAt: null,
      })
      .where(and(eq(vqExportJobs.jobId, jobId), eq(vqExportJobs.state, "processing")));
  });
}

/** Re-export so callers derive the immutable R2 key from one place. */
export { exportOutputKey };

// Local type alias to avoid importing the state enum name twice.
type VqExportState = "queued" | "processing" | "partial" | "completed" | "failed" | "cancelled" | "expired";
