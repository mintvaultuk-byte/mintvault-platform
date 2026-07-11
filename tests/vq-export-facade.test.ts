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
}));

// Stub the DB so importing the facade (→ storage → server/db) needs no connection;
// the store is mocked, so no query is ever issued in this suite.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));
vi.mock("../server/vault-quest/lib/export-job-store", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getExportJobByPublicId: store.getExportJobByPublicId };
});
vi.mock("../server/r2", () => ({ uploadToR2: vi.fn(), getR2ObjectStream: vi.fn() }));

import { getExportStatusView, resolveExportDownload } from "../server/vault-quest/export-jobs";

function row(over: Record<string, unknown>) {
  return {
    ok: true,
    value: {
      jobId: "job-1", kind: "pack", state: "completed", requestedCount: 3, completedCount: 3,
      skippedCount: 0, failedCount: 0, outputKey: "vq/exports/job-1/pack.zip", outputHash: "h",
      outputSize: 100, contentType: "application/zip", fileName: "pack.zip", errorMessage: null,
      createdAt: new Date(0), completedAt: new Date(1000), ...over,
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("getExportStatusView — 3-state client contract", () => {
  it("processing → running", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "processing", completedCount: 1 }));
    const v = await getExportStatusView("job-1");
    expect(v?.state).toBe("running");
    expect(v?.durable).toBe(true);
  });
  it("completed → done", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "completed" }));
    expect((await getExportStatusView("job-1"))?.state).toBe("done");
  });
  it("partial → done (downloadable), skipped counted", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "partial", completedCount: 2, skippedCount: 1, requestedCount: 3 }));
    const v = await getExportStatusView("job-1");
    expect(v?.state).toBe("done");
    expect(v?.rendered).toBe(2);
    expect(v?.skipped).toBe(1);
  });
  it("failed → error with message", async () => {
    store.getExportJobByPublicId.mockResolvedValue(row({ state: "failed", errorMessage: "render blew up" }));
    const v = await getExportStatusView("job-1");
    expect(v?.state).toBe("error");
    expect(v?.error).toBe("render blew up");
  });
});

describe("resolveExportDownload — plan routing", () => {
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
  it("unavailable + no legacy job → not_found", async () => {
    store.getExportJobByPublicId.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect((await resolveExportDownload("nope")).kind).toBe("not_found");
  });
});
