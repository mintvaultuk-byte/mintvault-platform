/**
 * Phase 10A-1 — export facade mapping (no DB, no R2). Verifies the durable row →
 * client contract: states collapse to running/done/error (partial IS a download),
 * and the download plan routes completed/partial to R2 while surfacing
 * running/failed/gone honestly. The store + R2 are mocked; the render pipeline is
 * never exercised here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  getExportJobByPublicId: vi.fn(),
  createOrGetExportJob: vi.fn(),
  claimExportJob: vi.fn(),
  cancelExportJob: vi.fn(),
  finishExportJob: vi.fn(),
  failExportJob: vi.fn(),
  updateExportProgress: vi.fn(),
}));
const render = vi.hoisted(() => ({ getStudioCardsBatch: vi.fn(), renderSavedFromStudio: vi.fn() }));
vi.mock("../server/vault-quest/storage", () => ({ vqStorage: render }));
vi.mock("../server/vault-quest/render-saved", () => ({ renderSavedFromStudio: render.renderSavedFromStudio }));

// Stub the DB so importing the facade (→ storage → server/db) needs no connection;
// the store is mocked, so no query is ever issued in this suite.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));
vi.mock("../server/vault-quest/lib/export-job-store", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...store };
});
vi.mock("../server/r2", () => ({ uploadToR2: vi.fn(), getR2ObjectStream: vi.fn() }));

import { getExportStatusView, resolveExportDownload, startExport } from "../server/vault-quest/export-jobs";
import { uploadToR2 } from "../server/r2";
import fs from "fs";

function row(over: Record<string, unknown>) {
  return {
    ok: true,
    value: {
      jobId: "job-1",
      kind: "pack",
      state: "completed",
      requestedCount: 3,
      completedCount: 3,
      skippedCount: 0,
      failedCount: 0,
      outputKey: "vq/exports/job-1/pack.zip",
      outputHash: "h",
      outputSize: 100,
      contentType: "application/zip",
      fileName: "pack.zip",
      errorMessage: null,
      createdAt: new Date(0),
      completedAt: new Date(1000),
      ...over,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  render.getStudioCardsBatch.mockRejectedValue(new Error("synthetic render refusal"));
  store.failExportJob.mockResolvedValue({ ok: true, value: undefined });
});

describe("durable-only admission", () => {
  it("refuses unavailable persistence before any rendering or upload", async () => {
    const file = vi.spyOn(fs, "createWriteStream");
    store.createOrGetExportJob.mockResolvedValue({ ok: false, reason: "unavailable" });
    await expect(startExport("pack", "synthetic-admin", ["c1"])).rejects.toMatchObject({ status: 503 });
    expect(store.claimExportJob).not.toHaveBeenCalled();
    expect(render.getStudioCardsBatch).not.toHaveBeenCalled();
    expect(render.renderSavedFromStudio).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
    file.mockRestore();
  });
  it("does not disguise an unavailable claim as a successful duplicate", async () => {
    store.createOrGetExportJob.mockResolvedValue({ ok: true, value: { job: row({}).value, deduped: false } });
    store.claimExportJob.mockResolvedValue({ ok: false, reason: "unavailable" });
    await expect(startExport("pack", "synthetic-admin", ["c1"])).rejects.toMatchObject({ status: 503 });
    expect(render.getStudioCardsBatch).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
  });
  it("returns an actual existing job or claim conflict without a second render", async () => {
    const job = row({}).value;
    store.createOrGetExportJob.mockResolvedValue({ ok: true, value: { job, deduped: true } });
    await expect(startExport("pack", "synthetic-admin", ["c1"])).resolves.toEqual({
      jobId: "job-1",
      durable: true,
      deduped: true,
      count: 3,
    });
    expect(store.claimExportJob).not.toHaveBeenCalled();
    store.createOrGetExportJob.mockResolvedValue({ ok: true, value: { job, deduped: false } });
    store.claimExportJob.mockResolvedValue({ ok: false, reason: "conflict" });
    await expect(startExport("pack", "synthetic-admin", ["c1"])).resolves.toEqual({
      jobId: "job-1",
      durable: true,
      deduped: true,
      count: 3,
    });
    expect(render.getStudioCardsBatch).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
  });
  it("requires successful cancellation before reporting concurrency back-pressure", async () => {
    const release: Array<() => void> = [];
    render.getStudioCardsBatch.mockImplementation(
      () => new Promise((_resolve, reject) => release.push(() => reject(new Error("synthetic stopped render"))))
    );
    store.createOrGetExportJob.mockResolvedValue({ ok: true, value: { job: row({}).value, deduped: false } });
    store.claimExportJob.mockResolvedValue(row({ state: "processing" }));
    try {
      for (let i = 0; i < 3; i++)
        await expect(startExport("pack", "synthetic-admin", ["c1"])).resolves.toMatchObject({
          durable: true,
          deduped: false,
        });
      expect(render.getStudioCardsBatch).toHaveBeenCalledTimes(3);
      store.cancelExportJob.mockResolvedValue({ ok: false, reason: "unavailable" });
      await expect(startExport("pack", "synthetic-admin", ["c1"])).rejects.toMatchObject({ status: 503 });
      store.cancelExportJob.mockResolvedValue({ ok: true, value: undefined });
      await expect(startExport("pack", "synthetic-admin", ["c1"])).rejects.toMatchObject({ status: 429 });
      expect(store.claimExportJob).toHaveBeenCalledTimes(3);
      expect(uploadToR2).not.toHaveBeenCalled();
    } finally {
      release.forEach((stop) => stop());
      await vi.waitFor(() => expect(store.failExportJob).toHaveBeenCalledTimes(3));
    }
  });
});

async function readView(id: string) {
  const result = await getExportStatusView(id);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected durable status");
  return result.value;
}

describe("getExportStatusView — 3-state client contract", () => {
  it.each(["unavailable", "not_found"])("preserves typed %s status without memory fallback", async (reason) => {
    store.getExportJobByPublicId.mockResolvedValue({ ok: false, reason });
    expect(await getExportStatusView("job-1")).toEqual({
      ok: false,
      reason,
      status: reason === "unavailable" ? 503 : 404,
    });
  });
  it("processing → running", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "processing", completedCount: 1 }));
    const v = await readView("job-1");
    expect(v?.state).toBe("running");
    expect(v?.durable).toBe(true);
  });
  it("completed → done", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "completed" }));
    expect((await readView("job-1"))?.state).toBe("done");
  });
  it("partial → done (downloadable), skipped counted", async () => {
    store.getExportJobByPublicId.mockResolvedValue(
      row({ state: "partial", completedCount: 2, skippedCount: 1, requestedCount: 3 })
    );
    const v = await readView("job-1");
    expect(v?.state).toBe("done");
    expect(v?.rendered).toBe(2);
    expect(v?.skipped).toBe(1);
  });
  it("failed → error with message", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "failed", errorMessage: "render blew up" }));
    const v = await readView("job-1");
    expect(v?.state).toBe("error");
    expect(v?.error).toBe("render blew up");
  });
});

describe("resolveExportDownload — plan routing", () => {
  it.each([
    ["queued", 409],
    ["processing", 409],
    ["failed", 422],
    ["cancelled", 422],
    ["expired", 410],
  ])("preserves %s status %s", async (state, status) => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state }));
    expect(await resolveExportDownload("job-1")).toMatchObject({ status });
  });
  it("reports a genuinely absent durable job as404", async () => {
    store.getExportJobByPublicId.mockResolvedValue({ ok: false, reason: "not_found" });
    expect(await resolveExportDownload("job-1")).toEqual({ kind: "not_found", status: 404 });
  });
  it("completed → stream from R2", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "completed" }));
    const p = await resolveExportDownload("job-1");
    expect(p.kind).toBe("r2");
    if (p.kind === "r2") expect(p.outputKey).toBe("vq/exports/job-1/pack.zip");
  });
  it("partial → still downloadable from R2", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "partial", completedCount: 2, skippedCount: 1 }));
    expect((await resolveExportDownload("job-1")).kind).toBe("r2");
  });
  it("processing → running (409)", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "processing" }));
    expect((await resolveExportDownload("job-1")).kind).toBe("running");
  });
  it("failed → failed", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "failed", errorMessage: "x" }));
    expect((await resolveExportDownload("job-1")).kind).toBe("failed");
  });
  it("completed but output swept → gone", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "completed", outputKey: null }));
    expect((await resolveExportDownload("job-1")).kind).toBe("gone");
  });
  it("unavailable persistence → 503, never a false missing job", async () => {
    store.getExportJobByPublicId.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect(await resolveExportDownload("nope")).toEqual({ kind: "unavailable", status: 503 });
  });
});
