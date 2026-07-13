/**
 * Vault Quest — background export/proxy jobs (Phase 10/11 prod-hardening, OPEN-27).
 *
 * Why this exists: the old export/proxy routes rendered the whole selection inline,
 * built the ZIP synchronously in memory, and streamed it back on the SAME request.
 * On the full 150-card set that meant ~1GB of buffers, a multi-second synchronous
 * deflate that blocks the event loop, and an HTTP request held open long enough to
 * hit a proxy timeout. This module fixes all three:
 *
 *   • The heavy work runs OFF the request in a background job (POST returns a jobId
 *     immediately → no request timeout).
 *   • Cards are loaded with ONE batched query pair (getStudioCardsBatch → no N+1)
 *     and rendered one at a time, so peak memory is a single card, not the set.
 *   • Output streams to a temp file via ZipStream / a piped PDF (async deflate on
 *     the threadpool → the event loop is never blocked).
 *
 * Progress is polled via the job status; the finished file is downloaded from a
 * separate endpoint that streams the temp file. Temp files are unlinked on a TTL.
 *
 * NOTE (single-instance): jobs + temp files live in this process. Start, poll and
 * download must hit the same machine. That holds for the current single-machine
 * deploy; a multi-machine prod rollout would need a shared store (tracked in
 * OPEN-27) — deliberately NOT adding Redis/a jobs table here (no new dep/schema).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { vqStorage } from "./storage";
import { renderSavedFromStudio } from "./render-saved";
import { ZipStream } from "./zip";
import { buildProxyPdf, type ProxyProvider } from "./proxy";
import { cardMetadata } from "./qa-set";
import { VQ_ELEMENTS_NEEDS_APPROVAL } from "./lib/vq-constants";
import { uploadToR2 } from "../r2";
import {
  createOrGetExportJob,
  claimExportJob,
  cancelExportJob,
  getExportJobByPublicId,
  updateExportProgress,
  finishExportJob,
  failExportJob,
  exportOutputKey,
  type ExportOutput,
} from "./lib/export-job-store";
import type { ExportCounts } from "./lib/export-job-state";
import type { VqExportJob } from "@shared/vq-export-schema";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { vqExportJobs } from "@shared/vq-export-schema";
import { isUndefinedTableOrColumn } from "./production-storage";

export type JobKind = "pack" | "proxy";
export type JobState = "running" | "done" | "error";

export interface ExportJob {
  id: string;
  kind: JobKind;
  state: JobState;
  total: number; // cards to process
  done: number; // cards processed so far (progress numerator)
  rendered: number; // cards that produced output
  skipped: string[]; // card ids that did not render
  fileName?: string;
  filePath?: string;
  contentType?: string;
  bytes?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const JOBS = new Map<string, ExportJob>();
const MAX_ACTIVE = 3; // bound concurrent heavy jobs (renders are CPU/memory heavy)
const TTL_MS = 20 * 60 * 1000; // keep a finished temp file downloadable for 20 min
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // hard cap so a hung job can't hold a slot forever

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const tmpPath = (kind: string, ext: string) => path.join(os.tmpdir(), `vq-${kind}-${randomUUID()}.${ext}`);

/** Public, poll-safe view of a job (no filesystem paths leaked). */
export function jobStatus(job: ExportJob) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    total: job.total,
    done: job.done,
    rendered: job.rendered,
    skipped: job.skipped.length,
    fileName: job.fileName,
    bytes: job.bytes,
    error: job.error,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
  };
}

export function getExportJob(id: string): ExportJob | undefined {
  return JOBS.get(id);
}

function scheduleCleanup(job: ExportJob): void {
  const t = setTimeout(() => {
    if (job.filePath) fs.unlink(job.filePath, () => {});
    JOBS.delete(job.id);
  }, TTL_MS);
  // don't keep the process alive just for cleanup
  (t as { unref?: () => void }).unref?.();
}

/**
 * Render into `job` (temp file + counts) under the hard timeout, so a hung render
 * can never permanently hold a slot. Shared by the legacy in-memory path and the
 * durable path. Throws on error/timeout; on success `job` carries filePath/bytes/
 * fileName/contentType/counts.
 */
async function renderInto(job: ExportJob, ids: string[], onProgress?: () => void): Promise<void> {
  const run = job.kind === "pack" ? runPack : runProxy;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("export timed out")), JOB_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const runner = run(job, ids, onProgress);
  // A late rejection from the runner AFTER the timeout already won the race would
  // otherwise be an unhandled rejection (fatal in Node) — swallow it here.
  runner.catch(() => {});
  try {
    await Promise.race([runner, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * LEGACY in-memory path — kept as the fallback for a DB where the durable
 * `vq_export_jobs` table isn't migrated yet (the durable facade below routes to
 * this when the store signals `unavailable`). Single-machine only.
 */
export function startExportJob(kind: JobKind, ids: string[]): { id: string } {
  const active = [...JOBS.values()].filter((j) => j.state === "running").length;
  if (active >= MAX_ACTIVE) throw new Error("too many exports already running — wait for one to finish");
  const id = randomUUID();
  const job: ExportJob = {
    id,
    kind,
    state: "running",
    total: ids.length,
    done: 0,
    rendered: 0,
    skipped: [],
    startedAt: Date.now(),
  };
  JOBS.set(id, job);
  renderInto(job, ids)
    .then(() => {
      job.state = "done";
      job.finishedAt = Date.now();
      scheduleCleanup(job);
    })
    .catch((err) => {
      job.state = "error";
      job.error = err instanceof Error ? err.message : "export failed";
      job.finishedAt = Date.now();
      if (job.filePath) {
        fs.unlink(job.filePath, () => {});
        job.filePath = undefined;
      }
      scheduleCleanup(job);
    });
  return { id };
}

// ---------------------------------------------------------------------------
// DURABLE path (INFRA-01 / OPEN-27) — state in Postgres, bytes in R2, so poll +
// download work from ANY Fly machine. Falls back to the legacy path above when
// the vq_export_jobs table isn't migrated on the target DB.
// ---------------------------------------------------------------------------

const LEASE_MS = JOB_TIMEOUT_MS + 60 * 1000; // outlive the render timeout by a minute
const PROGRESS_THROTTLE_MS = 1500; // cap durable progress writes (avoid a write storm)
const machineId = (): string => process.env.FLY_MACHINE_ID || "local";

// Per-machine cap on concurrent heavy renders (mirrors the legacy MAX_ACTIVE).
let activeDurableRenders = 0;

/** Public, poll-safe view — identical shape whether the job is durable or legacy,
 *  collapsed to the 3 states the client understands (running/done/error). */
export interface ExportStatusView {
  id: string;
  kind: string;
  state: "running" | "done" | "error";
  total: number;
  done: number;
  rendered: number;
  skipped: number;
  fileName?: string;
  bytes?: number;
  error?: string;
  elapsedMs: number;
  durable: boolean;
}

function durableToView(j: VqExportJob): ExportStatusView {
  const state: ExportStatusView["state"] =
    j.state === "queued" || j.state === "processing"
      ? "running"
      : j.state === "completed" || j.state === "partial"
        ? "done"
        : "error";
  const rendered = j.completedCount;
  const skipped = j.skippedCount + j.failedCount;
  return {
    id: j.jobId,
    kind: j.kind,
    state,
    total: j.requestedCount,
    done: rendered + skipped,
    rendered,
    skipped,
    fileName: j.fileName ?? undefined,
    bytes: j.outputSize ?? undefined,
    error: state === "error" ? j.errorMessage ?? "export failed" : undefined,
    elapsedMs: (j.completedAt ?? new Date()).getTime() - j.createdAt.getTime(),
    durable: true,
  };
}

function legacyToView(job: ExportJob): ExportStatusView {
  const s = jobStatus(job);
  return { ...s, state: job.state === "running" ? "running" : job.state === "done" ? "done" : "error", skipped: job.skipped.length, durable: false };
}

/** Start an export — durable when the table exists, else legacy in-memory. */
export async function startExport(
  kind: JobKind,
  ownerAdminId: string,
  ids: string[],
): Promise<{ jobId: string; deduped: boolean; durable: boolean; count: number }> {
  const created = await createOrGetExportJob(kind, ownerAdminId, ids, Date.now());
  if (!created.ok) {
    // Table not migrated on this DB → keep working via the legacy single-machine path.
    const { id } = startExportJob(kind, ids);
    return { jobId: id, deduped: false, durable: false, count: ids.length };
  }
  const { job, deduped } = created.value;
  if (deduped) {
    return { jobId: job.jobId, deduped: true, durable: true, count: job.requestedCount };
  }
  // Fresh job. Guard per-machine concurrency; with no cross-machine scheduler yet,
  // a job we can't run now is retired cleanly rather than stranded as `queued`.
  if (activeDurableRenders >= MAX_ACTIVE) {
    await cancelExportJob(job.jobId, "too many exports already running", Date.now());
    const e = new Error("too many exports already running — wait for one to finish") as Error & { status?: number };
    e.status = 429;
    throw e;
  }
  const claimed = await claimExportJob(job.jobId, machineId(), LEASE_MS, Date.now());
  if (!claimed.ok) {
    // Another machine won the claim for this same new job — treat as deduped.
    return { jobId: job.jobId, deduped: true, durable: true, count: job.requestedCount };
  }
  void runDurableRender(job.jobId, kind, ids);
  return { jobId: job.jobId, deduped: false, durable: true, count: ids.length };
}

/** Run a claimed durable job: render → upload artifact to R2 → persist outcome.
 *  Never throws to the caller (fire-and-forget); failures land on the DB row. */
async function runDurableRender(jobId: string, kind: JobKind, ids: string[]): Promise<void> {
  activeDurableRenders++;
  const job: ExportJob = { id: jobId, kind, state: "running", total: ids.length, done: 0, rendered: 0, skipped: [], startedAt: Date.now() };
  let lastProgressAt = 0;
  const onProgress = () => {
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    void updateExportProgress(jobId, { completed: job.rendered, skipped: job.skipped.length, failed: 0 });
  };
  try {
    await renderInto(job, ids, onProgress);
    const counts: ExportCounts = {
      requested: ids.length,
      completed: job.rendered,
      skipped: job.skipped.length,
      failed: 0,
      hasOutput: !!job.filePath && !!job.bytes,
    };
    // Only upload when the outcome will actually be downloadable — never leave an
    // orphan R2 object behind a job that decideExportOutcome will call `failed`.
    let output: ExportOutput | null = null;
    if (job.filePath && job.bytes && job.fileName && job.contentType && counts.completed > 0) {
      const buf = await fs.promises.readFile(job.filePath);
      const key = exportOutputKey(jobId, job.fileName);
      const hash = createHash("sha256").update(buf).digest("hex");
      await uploadToR2(key, buf, job.contentType);
      output = { outputKey: key, outputHash: hash, outputSize: buf.length, contentType: job.contentType, fileName: job.fileName };
    }
    await finishExportJob(jobId, counts, output, Date.now());
  } catch (err) {
    await failExportJob(jobId, "render_failed", err instanceof Error ? err.message : "export failed", Date.now()).catch(() => {});
  } finally {
    if (job.filePath) fs.unlink(job.filePath, () => {});
    activeDurableRenders--;
  }
}

/** Poll view for a job — durable first, legacy fallback. Null = genuinely unknown. */
export async function getExportStatusView(jobId: string): Promise<ExportStatusView | null> {
  const res = await getExportJobByPublicId(jobId);
  if (res.ok) return durableToView(res.value);
  const legacy = getExportJob(jobId);
  return legacy ? legacyToView(legacy) : null;
}

/** What the download route should do for a job. */
export type DownloadPlan =
  | { kind: "r2"; outputKey: string; contentType: string; fileName: string; bytes?: number }
  | { kind: "file"; filePath: string; contentType: string; fileName: string; bytes?: number }
  | { kind: "not_found" }
  | { kind: "running" }
  | { kind: "failed"; message: string }
  | { kind: "gone" };

export async function resolveExportDownload(jobId: string): Promise<DownloadPlan> {
  const res = await getExportJobByPublicId(jobId);
  if (res.ok) {
    const j = res.value;
    if (j.state === "queued" || j.state === "processing") return { kind: "running" };
    if (j.state === "failed" || j.state === "cancelled") return { kind: "failed", message: j.errorMessage ?? "export failed" };
    if (j.state === "expired") return { kind: "gone" };
    if (!j.outputKey) return { kind: "gone" }; // completed/partial but output already swept
    return { kind: "r2", outputKey: j.outputKey, contentType: j.contentType ?? "application/octet-stream", fileName: j.fileName ?? "export.bin", bytes: j.outputSize ?? undefined };
  }
  // unavailable / not_found in the durable store → legacy in-memory
  const job = getExportJob(jobId);
  if (!job) return { kind: "not_found" };
  if (job.state === "running") return { kind: "running" };
  if (job.state === "error") return { kind: "failed", message: job.error ?? "export failed" };
  if (!job.filePath) return { kind: "gone" };
  return { kind: "file", filePath: job.filePath, contentType: job.contentType ?? "application/octet-stream", fileName: job.fileName ?? "export.bin", bytes: job.bytes };
}

// ---- runners ----

async function runPack(job: ExportJob, ids: string[], onProgress?: () => void): Promise<void> {
  const studios = await vqStorage.getStudioCardsBatch(ids); // 2 queries, no per-card N+1
  job.total = studios.length;

  const tmp = tmpPath("pack", "zip");
  job.filePath = tmp; // set early so the error path / TTL can unlink a partial file
  const ws = fs.createWriteStream(tmp);
  const zip = new ZipStream(ws);
  try {
    await buildPack(job, studios, zip, onProgress);
    job.bytes = fs.statSync(tmp).size;
  } catch (err) {
    ws.destroy(); // free the fd; the caller's .catch unlinks job.filePath
    throw err;
  }
}

async function buildPack(job: ExportJob, studios: Awaited<ReturnType<typeof vqStorage.getStudioCardsBatch>>, zip: ZipStream, onProgress?: () => void): Promise<void> {
  const manifest: Record<string, unknown>[] = [];
  const checksums: string[] = [];
  let rendered = 0;

  for (const studio of studios) {
    const c = studio.card;
    try {
      const { result } = await renderSavedFromStudio(studio, "all");
      const meta = cardMetadata(c, studio.previousStage);
      // include cardId → unique filenames (no silent overwrite in the pack)
      const nameBase = safeName(
        `${c.collectorNumber?.split("/")[0] ?? c.cardId}_${c.cardId}_${c.name || c.cardId}_${c.variantTier || "STANDARD"}_${c.setCode}_${c.year}`,
      );
      if (result.qa.status === "reject") {
        job.skipped.push(c.cardId);
      } else {
        rendered++;
        const files: [string, Buffer][] = [
          [`${nameBase}.svg`, Buffer.from(result.svg ?? "", "utf8")],
          [`${nameBase}.png`, result.masterPng ?? Buffer.alloc(0)],
          [`${nameBase}.pdf`, result.pdf ?? Buffer.alloc(0)],
        ];
        for (const [fn, buf] of files) {
          await zip.add(`cards/${fn}`, buf);
          // checksums cover the deterministic card artefacts (not the timestamped manifest)
          checksums.push(`${createHash("sha256").update(buf).digest("hex")}  cards/${fn}`);
        }
      }
      const placeholderEl = VQ_ELEMENTS_NEEDS_APPROVAL.has(c.element);
      const warns = result.qa.issues.filter((i) => i.level === "warn").length;
      const flags = { qa: result.qa.status, warns, has_artwork: !!c.artR2Key, placeholder_element: placeholderEl };
      await zip.add(
        `metadata/${safeName(c.cardId)}.json`,
        Buffer.from(JSON.stringify({ ...meta, ...flags, qa_issues: result.qa.issues }, null, 2), "utf8"),
      );
      manifest.push({ ...meta, ...flags });
    } catch {
      job.skipped.push(c.cardId);
    } finally {
      job.done++;
      onProgress?.();
    }
  }

  await zip.add(
    "manifest.json",
    Buffer.from(
      JSON.stringify(
        { set: "GNV", exported: new Date().toISOString(), count: manifest.length, rendered, skipped: job.skipped, cards: manifest },
        null,
        2,
      ),
      "utf8",
    ),
  );
  await zip.add("checksums.txt", Buffer.from(checksums.join("\n") + "\n", "utf8"));
  await zip.finalize();

  job.rendered = rendered;
  job.fileName = `VQ_export_${manifest.length}cards.zip`;
  job.contentType = "application/zip";
}

async function runProxy(job: ExportJob, ids: string[], onProgress?: () => void): Promise<void> {
  const studios = await vqStorage.getStudioCardsBatch(ids); // 2 queries, no per-card N+1
  job.total = studios.length;
  const cfg = await vqStorage.getConfig().catch(() => ({}) as Record<string, string>);

  const tmp = tmpPath("proxy", "pdf");
  job.filePath = tmp; // set early so the error path / TTL can unlink a partial file
  const provider: ProxyProvider = {
    count: studios.length,
    async get(i) {
      const studio = studios[i];
      try {
        const { result } = await renderSavedFromStudio(studio, "all");
        if (result.qa.status === "reject" || !result.masterPng) {
          job.skipped.push(studio.card.cardId);
          return null;
        }
        return { cardId: studio.card.cardId, masterPng: result.masterPng };
      } catch {
        job.skipped.push(studio.card.cardId);
        return null;
      } finally {
        job.done++;
        onProgress?.();
      }
    },
  };

  const ws = fs.createWriteStream(tmp);
  let placed: number;
  try {
    placed = await buildProxyPdf(
      provider,
      { rulesVersion: cfg.rules_version, date: new Date().toISOString().slice(0, 10) },
      ws,
    );
  } catch (err) {
    ws.destroy(); // free the fd; the caller's .catch unlinks job.filePath
    throw err;
  }
  // buildProxyPdf ends the stream itself; on a no-render result the caller's
  // .catch unlinks the (empty) temp file.
  if (placed === 0) throw new Error("none of the selected cards render yet — author gameplay + artwork first");
  job.rendered = placed;
  job.fileName = `VQ_proxy_${placed}cards.pdf`;
  job.contentType = "application/pdf";
  job.bytes = fs.statSync(tmp).size;
}

// ── ops observability (Phase 10A-5) ─────────────────────────────────────────

export interface ExportJobCounts {
  /** Grouped counts from the shared, cross-machine durable table — visible from
   *  ANY Fly machine. `null` when the table is unavailable (degrade-safe). */
  durable: Record<string, number> | null;
  /** The size of the LEGACY in-memory Map — THIS MACHINE ONLY. Never meaningful
   *  as a fleet-wide total; surfaced only so an operator doesn't mistake a
   *  per-machine number for the real total. */
  legacyInMemoryThisMachineOnly: number;
}

/** Bounded aggregate (GROUP BY state, not a row dump) for the ops status endpoint. */
export async function getExportJobCounts(): Promise<ExportJobCounts> {
  let durable: Record<string, number> | null = null;
  try {
    const rows = await db.select({ state: vqExportJobs.state, n: sql<number>`count(*)` }).from(vqExportJobs).groupBy(vqExportJobs.state);
    durable = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  } catch (err) {
    if (!isUndefinedTableOrColumn(err)) throw err;
  }
  return { durable, legacyInMemoryThisMachineOnly: JOBS.size };
}
