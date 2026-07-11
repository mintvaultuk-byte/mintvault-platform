/**
 * Phase 10A-1 — durable export STORE integration test (INFRA-01 / OPEN-27).
 *
 * Runs ONLY against an explicit, isolated local Postgres (TEST_DATABASE_URL). It
 * hard-fails if that URL is not the throwaway local DB, so it can never touch
 * staging/production. Skipped entirely when TEST_DATABASE_URL is unset, so the
 * normal `npm test` suite is unaffected.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mintvault_vq_phase10_local \
 *     npx vitest run tests/vq-export-store.integration.test.ts
 *
 * This proves the CORE of the 2-machine fix at the store layer: idempotent create,
 * atomic single-winner claim, cross-"machine" visibility, and counts-derived
 * terminal states (partial can never be mislabelled completed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

// Mock server/db so the store's `import { db } from "../../db"` uses a plaintext
// local pool (no SSL) pinned to the test DB — never the app's Neon connection.
// Everything is inlined because vi.mock's factory is hoisted above module vars.
vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve() } };
  // Pin to the throwaway local DB — refuse anything else BEFORE opening a pool.
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "55432" && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB (127.0.0.1:55432/mintvault_vq_phase10_local), got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 4 });
  return { db: drizzle(pool), pool };
});

const run = TEST_URL ? describe : describe.skip;

// Imported AFTER the mock is registered (vi.mock is hoisted).
import {
  createOrGetExportJob,
  claimExportJob,
  cancelExportJob,
  getExportJobByPublicId,
  updateExportProgress,
  finishExportJob,
} from "../server/vault-quest/lib/export-job-store";
import { pool } from "../server/db";

const OWNER = "itest-export-store";

async function cleanup() {
  await (pool as unknown as { query: (s: string, a: unknown[]) => Promise<unknown> }).query(
    "DELETE FROM vq_export_jobs WHERE owner_admin_id = $1",
    [OWNER],
  );
}

run("durable export store — local Postgres", () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("create is idempotent per (kind, owner, id-set) while active", async () => {
    const ids = ["GNV-1", "GNV-2", "GNV-3"];
    const a = await createOrGetExportJob("pack", OWNER, ids, Date.now());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.deduped).toBe(false);
    // Same selection in a different order → same active job, deduped.
    const b = await createOrGetExportJob("pack", OWNER, ["GNV-3", "GNV-1", "GNV-2"], Date.now());
    expect(b.ok && b.value.deduped).toBe(true);
    if (b.ok) expect(b.value.job.jobId).toBe(a.value.job.jobId);
  });

  it("claim is a single atomic winner; a second claim conflicts", async () => {
    const ids = ["CLA-1", "CLA-2"];
    const created = await createOrGetExportJob("proxy", OWNER, ids, Date.now());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.value.job.jobId;

    const first = await claimExportJob(jobId, "machine-A", 60_000, Date.now());
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.state).toBe("processing");
      expect(first.value.workerMachine).toBe("machine-A");
      expect(first.value.attemptCount).toBe(1);
      expect(first.value.leaseExpiresAt).not.toBeNull();
    }
    // A different machine tries to claim the SAME job → loses (already processing).
    const second = await claimExportJob(jobId, "machine-B", 60_000, Date.now());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("conflict");
  });

  it("a poll from another 'machine' sees the job (durable, cross-machine)", async () => {
    const created = await createOrGetExportJob("pack", OWNER, ["VIS-1"], Date.now());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seen = await getExportJobByPublicId(created.value.job.jobId);
    expect(seen.ok).toBe(true); // machine B would find it even though machine A created it
    if (seen.ok) expect(seen.value.ownerAdminId).toBe(OWNER);
  });

  it("progress writes update counts while processing", async () => {
    const created = await createOrGetExportJob("pack", OWNER, ["PRG-1", "PRG-2"], Date.now());
    if (!created.ok) return;
    const jobId = created.value.job.jobId;
    await claimExportJob(jobId, "m", 60_000, Date.now());
    await updateExportProgress(jobId, { completed: 1, skipped: 0, failed: 0 });
    const after = await getExportJobByPublicId(jobId);
    expect(after.ok && after.value.completedCount).toBe(1);
    expect(after.ok && after.value.state).toBe("processing");
  });

  it("partial outcome is derived from counts and keeps its output", async () => {
    const created = await createOrGetExportJob("pack", OWNER, ["PT-1", "PT-2", "PT-3"], Date.now());
    if (!created.ok) return;
    const jobId = created.value.job.jobId;
    await claimExportJob(jobId, "m", 60_000, Date.now());
    const res = await finishExportJob(
      jobId,
      { requested: 3, completed: 2, skipped: 1, failed: 0, hasOutput: true },
      { outputKey: `vq/exports/${jobId}/pack.zip`, outputHash: "abc", outputSize: 123, contentType: "application/zip", fileName: "pack.zip" },
      Date.now(),
    );
    expect(res.ok && res.value).toBe("partial");
    const row = await getExportJobByPublicId(jobId);
    expect(row.ok && row.value.state).toBe("partial");
    expect(row.ok && row.value.outputKey).toContain("vq/exports/"); // partial IS downloadable
  });

  it("an all-skipped job is failed, not completed, and stores no output", async () => {
    const created = await createOrGetExportJob("pack", OWNER, ["FL-1"], Date.now());
    if (!created.ok) return;
    const jobId = created.value.job.jobId;
    await claimExportJob(jobId, "m", 60_000, Date.now());
    const res = await finishExportJob(
      jobId,
      { requested: 1, completed: 0, skipped: 1, failed: 0, hasOutput: true },
      { outputKey: `vq/exports/${jobId}/pack.zip`, outputHash: "x", outputSize: 1, contentType: "application/zip", fileName: "pack.zip" },
      Date.now(),
    );
    expect(res.ok && res.value).toBe("failed");
    const row = await getExportJobByPublicId(jobId);
    expect(row.ok && row.value.state).toBe("failed");
    expect(row.ok && row.value.outputKey).toBeNull(); // never offer an empty pack
  });

  it("after a job goes terminal, the same selection can start a NEW job", async () => {
    const ids = ["RE-1", "RE-2"];
    const first = await createOrGetExportJob("proxy", OWNER, ids, Date.now());
    if (!first.ok) return;
    await claimExportJob(first.value.job.jobId, "m", 60_000, Date.now());
    await finishExportJob(first.value.job.jobId, { requested: 2, completed: 2, skipped: 0, failed: 0, hasOutput: true },
      { outputKey: `vq/exports/${first.value.job.jobId}/p.pdf`, outputHash: "h", outputSize: 9, contentType: "application/pdf", fileName: "p.pdf" }, Date.now());
    // partial-unique only covers queued/processing → a fresh request is NOT deduped.
    const second = await createOrGetExportJob("proxy", OWNER, ids, Date.now());
    expect(second.ok && second.value.deduped).toBe(false);
    if (second.ok && first.ok) expect(second.value.job.jobId).not.toBe(first.value.job.jobId);
  });

  it("cancel retires a still-queued job", async () => {
    const created = await createOrGetExportJob("pack", OWNER, ["CX-1"], Date.now());
    if (!created.ok) return;
    const res = await cancelExportJob(created.value.job.jobId, "busy", Date.now());
    expect(res.ok).toBe(true);
    const row = await getExportJobByPublicId(created.value.job.jobId);
    expect(row.ok && row.value.state).toBe("cancelled");
  });
});
