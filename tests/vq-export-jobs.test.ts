/**
 * Phase 7A — pure state/idempotency logic for durable multi-machine export jobs
 * (INFRA-01 / OPEN-27). No DB, no R2, no render engine — the table-backed code
 * and these tests share this brain. The live table wiring (export-jobs.ts rewrite)
 * is Category C (needs migration 0008 on staging) and is not covered here.
 */
import { describe, it, expect } from "vitest";
import {
  canTransitionExport,
  isTerminalExportState,
  decideExportOutcome,
  computeExportIdempotencyKey,
  exportOutputKey,
  isLeaseExpired,
  VQ_EXPORT_STATES,
} from "../server/vault-quest/lib/export-job-state";
import { assertVqWriteKey } from "../server/vault-quest/lib/vq-keys";

describe("export state transitions", () => {
  it("allows the legal lifecycle transitions", () => {
    expect(canTransitionExport("queued", "processing")).toBe(true);
    expect(canTransitionExport("processing", "completed")).toBe(true);
    expect(canTransitionExport("processing", "partial")).toBe(true);
    expect(canTransitionExport("processing", "failed")).toBe(true);
    expect(canTransitionExport("processing", "queued")).toBe(true); // lease reclaim requeue
    expect(canTransitionExport("completed", "expired")).toBe(true); // cleanup
  });
  it("rejects illegal transitions", () => {
    expect(canTransitionExport("completed", "processing")).toBe(false);
    expect(canTransitionExport("expired", "processing")).toBe(false);
    expect(canTransitionExport("queued", "completed")).toBe(false); // must go via processing
    expect(canTransitionExport("failed", "completed")).toBe(false);
  });
  it("classifies terminal states", () => {
    for (const s of ["completed", "partial", "failed", "cancelled", "expired"] as const) {
      expect(isTerminalExportState(s)).toBe(true);
    }
    expect(isTerminalExportState("queued")).toBe(false);
    expect(isTerminalExportState("processing")).toBe(false);
  });
  it("covers every declared state", () => {
    expect(VQ_EXPORT_STATES.length).toBe(7);
  });
});

describe("decideExportOutcome — partial is never labelled complete", () => {
  it("completed only when every requested card rendered with output", () => {
    expect(decideExportOutcome({ requested: 5, completed: 5, skipped: 0, failed: 0, hasOutput: true })).toBe("completed");
  });
  it("partial when some cards were skipped or failed", () => {
    expect(decideExportOutcome({ requested: 5, completed: 3, skipped: 2, failed: 0, hasOutput: true })).toBe("partial");
    expect(decideExportOutcome({ requested: 5, completed: 4, skipped: 0, failed: 1, hasOutput: true })).toBe("partial");
  });
  it("failed when no output or nothing rendered or nothing requested", () => {
    expect(decideExportOutcome({ requested: 5, completed: 0, skipped: 5, failed: 0, hasOutput: false })).toBe("failed");
    expect(decideExportOutcome({ requested: 5, completed: 3, skipped: 2, failed: 0, hasOutput: false })).toBe("failed");
    expect(decideExportOutcome({ requested: 0, completed: 0, skipped: 0, failed: 0, hasOutput: true })).toBe("failed");
  });
});

describe("computeExportIdempotencyKey", () => {
  it("is independent of id order and duplicates", () => {
    const a = computeExportIdempotencyKey("pack", "admin@x", ["GNV-002", "GNV-001", "GNV-002"]);
    const b = computeExportIdempotencyKey("pack", "admin@x", ["GNV-001", "GNV-002"]);
    expect(a).toBe(b);
  });
  it("differs by kind and by owner", () => {
    const base = computeExportIdempotencyKey("pack", "admin@x", ["GNV-001"]);
    expect(computeExportIdempotencyKey("proxy", "admin@x", ["GNV-001"])).not.toBe(base);
    expect(computeExportIdempotencyKey("pack", "other@x", ["GNV-001"])).not.toBe(base);
  });
  it("differs by id set", () => {
    expect(computeExportIdempotencyKey("pack", "admin@x", ["GNV-001"]))
      .not.toBe(computeExportIdempotencyKey("pack", "admin@x", ["GNV-002"]));
  });
});

describe("exportOutputKey — stays inside vq/exports and blocks traversal", () => {
  it("builds a vq/exports/ key for a valid jobId", () => {
    const k = exportOutputKey("11111111-2222-3333-4444-555555555555", "VQ_export_60cards.zip");
    expect(k).toBe("vq/exports/11111111-2222-3333-4444-555555555555/VQ_export_60cards.zip");
  });
  it("sanitises a hostile filename (collapses dot-runs, no throw)", () => {
    expect(exportOutputKey("abc", "../../etc/passwd")).toBe("vq/exports/abc/____etc_passwd");
  });
  it("throws if a traversal-bearing jobId would escape the keyspace", () => {
    expect(() => exportOutputKey("../..", "x.zip")).toThrow(/blocked R2 write/);
  });
});

describe("vq/exports/ is now a permitted VQ write prefix (and traversal still blocked)", () => {
  it("allows vq/exports/ writes", () => {
    expect(assertVqWriteKey("vq/exports/job-1/out.zip")).toBe("vq/exports/job-1/out.zip");
  });
  it("still blocks grading prefixes and traversal", () => {
    expect(() => assertVqWriteKey("images/MV1/front.jpg")).toThrow();
    expect(() => assertVqWriteKey("vq/exports/../images/MV1.png")).toThrow();
  });
});

describe("isLeaseExpired", () => {
  it("true only when now is past the lease", () => {
    expect(isLeaseExpired(1000, 500)).toBe(true);
    expect(isLeaseExpired(1000, 1500)).toBe(false);
    expect(isLeaseExpired(1000, null)).toBe(false);
  });
});
