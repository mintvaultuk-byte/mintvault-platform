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

/** Start a background export/proxy job over the (already capped) card ids. */
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
  const run = kind === "pack" ? runPack : runProxy;
  // Hard timeout so a hung render can never permanently hold a MAX_ACTIVE slot.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("export timed out")), JOB_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const runner = run(job, ids);
  // A late rejection from the runner AFTER the timeout already won the race would
  // otherwise be an unhandled rejection (fatal in Node) — swallow it here.
  runner.catch(() => {});
  Promise.race([runner, timeout])
    .then(() => {
      if (timer) clearTimeout(timer);
      job.state = "done";
      job.finishedAt = Date.now();
      scheduleCleanup(job);
    })
    .catch((err) => {
      if (timer) clearTimeout(timer);
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

// ---- runners ----

async function runPack(job: ExportJob, ids: string[]): Promise<void> {
  const studios = await vqStorage.getStudioCardsBatch(ids); // 2 queries, no per-card N+1
  job.total = studios.length;

  const tmp = tmpPath("pack", "zip");
  job.filePath = tmp; // set early so the error path / TTL can unlink a partial file
  const ws = fs.createWriteStream(tmp);
  const zip = new ZipStream(ws);
  try {
    await buildPack(job, studios, zip);
    job.bytes = fs.statSync(tmp).size;
  } catch (err) {
    ws.destroy(); // free the fd; the caller's .catch unlinks job.filePath
    throw err;
  }
}

async function buildPack(job: ExportJob, studios: Awaited<ReturnType<typeof vqStorage.getStudioCardsBatch>>, zip: ZipStream): Promise<void> {
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

async function runProxy(job: ExportJob, ids: string[]): Promise<void> {
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
